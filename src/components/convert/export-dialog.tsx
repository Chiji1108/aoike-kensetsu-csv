import { useMemo } from "react"
import { ChevronRight, CircleAlert, CircleCheck, Download, FileSpreadsheet, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { GyoshuSummaryTable } from "@/components/convert/summary-panel"
import { remainingSteps, type NextStepsData, type StepId } from "@/components/cases/next-steps"
import { exportCheck, issueLabel } from "@/lib/cases/export-check"
import type { RowResult } from "@/lib/convert/convert"
import { RULE7_TAX_LABELS, type Basis, type GyoshuSummary, type Rule7Tax } from "@/lib/convert/koji-selection"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import { cn } from "@/lib/utils"

const fmt = (n: number) => Math.round(n).toLocaleString("ja-JP")
const SIDE = { total: "完成工事高", motouke: "うち元請" } as const

/**
 * 書き出す前の確認（1枚）。載せる件数・7割に届いたか・業種ごとの完成工事高と元請の額・エラーと要確認の残り・Shift_JIS で書けない文字を出し、
 * 決算書の業種ごとの完成工事高（7割の基準額と同じ値）を入れると表の合計と照らす。合わなくても止めない。
 * 出すのは最後の Excel（職員がこれまで作っていた形。Excel で確かめて「CSV で保存」する。直して上げ直すと表に戻る）。CSV は控え
 */
export function ExportDialog({
  open,
  onOpenChange,
  output,
  summary,
  basis,
  rule7Tax,
  onBasisChange,
  onExcel,
  onCsv,
  steps,
  onGo,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  output: readonly RowResult<KojiFieldId>[]
  summary: GyoshuSummary[]
  basis: Basis
  rule7Tax: Rule7Tax
  onBasisChange: (code: string, side: "total" | "motouke", value: number | undefined) => void
  onExcel: () => void
  onCsv: () => void
  /** 次にやること（書き出す前に残っていることを、作業の画面の上・書き出すのツールチップと同じ言葉で出す。押すとそこへ移る） */
  steps: NextStepsData | null
  onGo: (id: StepId) => void
}) {
  const check = useMemo(() => (open ? exportCheck(output, summary, basis) : null), [open, output, summary, basis])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl" data-testid="export-dialog">
        <DialogHeader>
          <DialogTitle>
            書き出す（<span className="num" data-testid="export-rows">{output.length}</span> 件）
          </DialogTitle>
          <DialogDescription>決算書の業種ごとの完成工事高（{RULE7_TAX_LABELS[rule7Tax]}・千円）を入れると、表の合計と照らします。</DialogDescription>
        </DialogHeader>
        {check && (
          <div className="grid gap-3 text-sm">
            <Remaining steps={steps} onGo={onGo} />
            <ul className="grid gap-1.5" data-testid="export-checks">
              <CheckLine ok={check.short.length === 0} testId="export-rule7">
                {check.short.length === 0
                  ? "7割を超えています"
                  : `7割に届いていない: ${check.short.map((s) => `${s.label}（${SIDE[s.side]}）`).join("・")}`}
              </CheckLine>
              <CheckLine ok={check.mismatches.length === 0} testId="export-basis">
                {check.mismatches.length === 0
                  ? Object.keys(basis).length
                    ? "決算書の額と合っています"
                    : "決算書の額はまだ入れていません"
                  : check.mismatches.map((m) => `${m.label}の${SIDE[m.side]}: 決算書 ${fmt(m.entered)} 千円・表の合計 ${fmt(m.rows)} 千円（差 ${m.diff > 0 ? "+" : ""}${fmt(m.diff)} 千円）`).join(" / ")}
              </CheckLine>
              {check.mismatches.length > 0 && <li className="pl-6 text-xs text-muted-foreground">工事の漏れ・税込と税抜の取り違え・業種の分け方の違いが考えられます</li>}
              <CheckLine ok={check.errors === 0} testId="export-errors">
                {check.errors === 0 ? "エラーなし" : `エラー ${check.errors} 件（取り込めないか、誤って取り込まれます）`}
              </CheckLine>
              <CheckLine ok={check.warnings === 0} warn testId="export-warnings">
                {check.warnings === 0 ? "要確認なし" : `要確認 ${check.warnings} 件`}
              </CheckLine>
              <CheckLine ok={check.unencodable.length === 0} testId="export-unencodable">
                {check.unencodable.length === 0
                  ? "Shift_JIS で書けない文字なし"
                  : `Shift_JIS で書けない文字 ${check.unencodable.length} セル（${[...new Set(check.unencodable.flatMap((u) => u.chars))].join(" ")}）。Excel の「CSV で保存」で「?」になります`}
              </CheckLine>
            </ul>
            {check.issues.length > 0 && (
              <details className="rounded-lg border bg-muted/20 px-3 py-2 text-xs" data-testid="export-issues">
                <summary className="cursor-pointer font-medium">内訳</summary>
                <ul className="mt-1.5 grid gap-0.5">
                  {check.issues.slice(0, 30).map((i) => (
                    <li key={`${i.status}${i.field}${i.message}`} className={i.status === "error" ? "text-red-700" : "text-amber-800"}>
                      {issueLabel(i)}（{i.count}件）
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <GyoshuSummaryTable summary={summary} basis={basis} rule7Tax={rule7Tax} onBasisChange={onBasisChange} />
            <p className="text-xs text-muted-foreground" data-testid="export-note">
              Excel で直したら、その Excel をチャットの📎でアップロードすると表に戻ります。取込は1回だけ（追加になる）、「1行目が項目行」は外す。
            </p>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCsv} disabled={output.length === 0} data-testid="download-button">
            <Download /> CSV
          </Button>
          <Button onClick={onExcel} disabled={output.length === 0} data-testid="export-excel">
            <FileSpreadsheet /> Excel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 書き出す前に残っていること（次にやることと同じ言葉）。無ければ済みと出す */
function Remaining({ steps, onGo }: { steps: NextStepsData | null; onGo: (id: StepId) => void }) {
  const left = steps ? remainingSteps(steps) : []
  if (!left.length)
    return (
      <p className="flex items-center gap-2 text-emerald-800" data-testid="export-remaining" data-left="0">
        <CircleCheck className="size-4 text-emerald-600" /> 残りはありません
      </p>
    )
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900" data-testid="export-remaining" data-left={left.length}>
      <TriangleAlert className="mr-1 size-4 text-amber-600" />
      <span className="mr-1">残り:</span>
      {left.map((r, i) => (
        <span key={r.id} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 opacity-60" aria-hidden />}
          <Button size="xs" variant="outline" className="bg-background" onClick={() => onGo(r.id)} data-testid={`export-remaining-${r.id}`}>
            {r.text}
          </Button>
        </span>
      ))}
      <span className="basis-full pt-0.5 text-xs text-amber-800/80">残っていても書き出せます。</span>
    </div>
  )
}

function CheckLine({ ok, warn = false, testId, children }: { ok: boolean; warn?: boolean; testId: string; children: React.ReactNode }) {
  const Icon = ok ? CircleCheck : warn ? CircleAlert : TriangleAlert
  return (
    <li className={cn("flex items-start gap-2", !ok && (warn ? "text-amber-800" : "text-red-800"))} data-testid={testId} data-ok={ok ? "1" : "0"}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", ok ? "text-emerald-600" : warn ? "text-amber-600" : "text-red-600")} />
      <span>{children}</span>
    </li>
  )
}

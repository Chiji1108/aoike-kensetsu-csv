import { useMemo } from "react"
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { GyoshuSummaryTable } from "@/components/convert/summary-panel"
import { exportCheck, issueLabel } from "@/lib/cases/export-check"
import type { RowResult } from "@/lib/convert/convert"
import type { Basis, GyoshuSummary } from "@/lib/convert/koji-selection"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import { cn } from "@/lib/utils"

const fmt = (n: number) => Math.round(n).toLocaleString("ja-JP")
const SIDE = { total: "完成工事高", motouke: "うち元請" } as const

/**
 * 書き出す前の確認（1枚）。載せる件数・7割に届いたか・業種ごとの完成工事高と元請の額・エラーと要確認の残り・Shift_JIS で書けない文字を出し、
 * 決算書の業種ごとの完成工事高（7割の基準額と同じ値）を入れると表の合計と照らす。合わなくても止めない。
 * 出すのは取り込み用の Excel（職員がこれまで作っていた形。Excel で確かめて「CSV で保存」する）。CSV は控え
 */
export function ExportDialog({
  open,
  onOpenChange,
  output,
  summary,
  basis,
  onBasisChange,
  onExcel,
  onCsv,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  output: readonly RowResult<KojiFieldId>[]
  summary: GyoshuSummary[]
  basis: Basis
  onBasisChange: (code: string, side: "total" | "motouke", value: number | undefined) => void
  onExcel: () => void
  onCsv: () => void
}) {
  const check = useMemo(() => (open ? exportCheck(output, summary, basis) : null), [open, output, summary, basis])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl" data-testid="export-dialog">
        <DialogHeader>
          <DialogTitle>書き出す前の確認</DialogTitle>
          <DialogDescription>
            CSV に載せる <strong className="num text-foreground" data-testid="export-rows">{output.length}</strong> 件を書き出します。決算書の業種ごとの完成工事高（税抜・千円）を入れると、表の合計と照らします（7割の基準額にも使います）。
          </DialogDescription>
        </DialogHeader>
        {check && (
          <div className="grid gap-3 text-sm">
            <ul className="grid gap-1.5" data-testid="export-checks">
              <CheckLine ok={check.short.length === 0} testId="export-rule7">
                {check.short.length === 0
                  ? "7割: すべての業種で基準額の7割を超えています"
                  : `7割に届いていない業種: ${check.short.map((s) => `${s.label}（${SIDE[s.side]}）`).join("・")}`}
              </CheckLine>
              <CheckLine ok={check.mismatches.length === 0} testId="export-basis">
                {check.mismatches.length === 0
                  ? Object.keys(basis).length
                    ? "入れた決算書の額と表の合計は合っています"
                    : "決算書の額はまだ入れていません（入れると表の合計と照らします）"
                  : check.mismatches.map((m) => `${m.label}の${SIDE[m.side]}: 決算書 ${fmt(m.entered)} 千円・表の合計 ${fmt(m.rows)} 千円（差 ${m.diff > 0 ? "+" : ""}${fmt(m.diff)} 千円）`).join(" / ")}
              </CheckLine>
              {check.mismatches.length > 0 && (
                <li className="pl-6 text-xs text-muted-foreground">工事の漏れ・税込と税抜の取り違え・業種の分け方の違いが考えられます。直してから書き出すか、このまま書き出すかを決めてください。</li>
              )}
              <CheckLine ok={check.errors === 0} testId="export-errors">
                {check.errors === 0 ? "エラーはありません" : `エラーが ${check.errors} 件あります（建設業.NET の取込でエラーになるか、誤った内容で取り込まれます）`}
              </CheckLine>
              <CheckLine ok={check.warnings === 0} warn testId="export-warnings">
                {check.warnings === 0 ? "要確認のセルはありません" : `要確認のセルが ${check.warnings} 件あります`}
              </CheckLine>
              <CheckLine ok={check.unencodable.length === 0} testId="export-unencodable">
                {check.unencodable.length === 0
                  ? "Shift_JIS で書けない文字はありません"
                  : `Shift_JIS で書けない文字が ${check.unencodable.length} セルにあります（${[...new Set(check.unencodable.flatMap((u) => u.chars))].join(" ")}）。Excel の「CSV で保存」ではこの文字が黙って「?」になります`}
              </CheckLine>
            </ul>
            {check.issues.length > 0 && (
              <details className="rounded-lg border bg-muted/20 px-3 py-2 text-xs" data-testid="export-issues">
                <summary className="cursor-pointer font-medium">残っているエラー・要確認の内訳</summary>
                <ul className="mt-1.5 grid gap-0.5">
                  {check.issues.slice(0, 30).map((i) => (
                    <li key={`${i.status}${i.field}${i.message}`} className={i.status === "error" ? "text-red-700" : "text-amber-800"}>
                      {issueLabel(i)}（{i.count}件）
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <GyoshuSummaryTable summary={summary} basis={basis} onBasisChange={onBasisChange} />
            <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="export-note">
              取り込み用の Excel は、これまでの Excel と同じ形（見出しなし・14列）です。Excel で開いて確かめ、「CSV で保存」で建設業.NET に取り込んでください（取込は追加なので1回だけ。「1行目が項目行」のチェックは外す）。
              Excel で直したところはこの画面に戻らず、検査・顧客ルール・翌年に入りません。直しが多いときは「Excel で直す」の編集用の Excel で直して上げ直してください。
            </p>
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onCsv} disabled={output.length === 0} data-testid="download-button">
            <Download /> CSV（控え）
          </Button>
          <Button onClick={onExcel} disabled={output.length === 0} data-testid="export-excel">
            <FileSpreadsheet /> 取り込み用の Excel を落とす
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

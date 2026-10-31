import { Check, ChevronRight, FileSpreadsheet, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FIX_KINDS, FIX_LABELS, type FixCounts } from "@/components/convert/status"
import { cn } from "@/lib/utils"

/**
 * 次にやること: 答える（報告の聞き返し・承認待ちの変更案）→ 直す（職員が直すセルのある載せる行）→ 問い合わせ（顧客に聞くこと）→ 書き出す。
 * 数は表の絞り込み・問い合わせのタブ・書き出すの確認と同じもの（案件の画面が1回だけ数えて渡す）。済んだ段は済みと出し、押すとそこへ移る
 */

export type StepId = "answer" | "fix" | "inquiry" | "export"

export type NextStepsData = {
  /** チャットで答えを待つもの（報告の聞き返し・承認待ちの変更案） */
  answer: number
  fix: FixCounts
  /** 外していない問い合わせ（セル・案件全体） */
  inquiry: number
  /** CSV に載せる件数 */
  exportRows: number
}

type Remaining = { id: Exclude<StepId, "export">; text: string }

/** 書き出す前に残っていること（無ければ空）。次にやること・書き出すのツールチップ・書き出すの確認で同じ言葉にする */
export function remainingSteps(s: NextStepsData): Remaining[] {
  const out: Remaining[] = []
  if (s.answer > 0) out.push({ id: "answer", text: `答える ${s.answer}` })
  if (s.fix.rows > 0) out.push({ id: "fix", text: `直す ${s.fix.rows}行（${fixBreakdown(s.fix)}）` })
  if (s.inquiry > 0) out.push({ id: "inquiry", text: `問い合わせ ${s.inquiry}件` })
  return out
}

/** 直す行の理由ごとの数（例:「必須が空 3・AI の推定 2」） */
export const fixBreakdown = (f: FixCounts) =>
  FIX_KINDS.filter((k) => f.byKind[k] > 0)
    .map((k) => `${FIX_LABELS[k]} ${f.byKind[k]}`)
    .join("・")

/** 書き出すボタンのツールチップ（⚠ の意味） */
export const exportTitle = (s: NextStepsData) => {
  const left = remainingSteps(s)
  return left.length ? `残り: ${left.map((r) => r.text).join(" → ")}` : "残りはありません"
}

const STEP_LABEL = { answer: "答える", fix: "直す", inquiry: "問い合わせ" } as const

export function NextSteps({ steps, onGo, exportDisabled, className }: { steps: NextStepsData; onGo: (id: StepId) => void; exportDisabled?: boolean; className?: string }) {
  const counts = { answer: steps.answer, fix: steps.fix.rows, inquiry: steps.inquiry }
  const order = ["answer", "fix", "inquiry"] as const
  const current = order.find((id) => counts[id] > 0) ?? "export"
  const left = remainingSteps(steps).length > 0
  return (
    <nav aria-label="次にやること" className={cn("flex min-w-0 flex-wrap items-center gap-1 text-xs", className)} data-testid="next-steps" data-current={current}>
      {order.map((id) => {
        const n = counts[id]
        const done = n === 0
        return (
          <span key={id} className="flex items-center gap-1">
            <Button
              size="xs"
              variant={id === current ? "outline" : "ghost"}
              className={cn(done ? "text-muted-foreground" : id === current ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100" : "text-foreground")}
              aria-current={id === current ? "step" : undefined}
              title={done ? `${STEP_LABEL[id]}: 済み` : stepTitle(id, steps)}
              onClick={() => onGo(id)}
              data-testid={`next-step-${id}`}
              data-done={done ? "1" : "0"}
            >
              {done && <Check className="text-emerald-600" />}
              {STEP_LABEL[id]}
              {!done && (
                <span className="num font-medium">
                  {n}
                  {id === "fix" ? "行" : id === "inquiry" ? "件" : ""}
                </span>
              )}
              {done && <span className="sr-only">済み</span>}
            </Button>
            <ChevronRight className="size-3 text-muted-foreground/60" aria-hidden />
          </span>
        )
      })}
      <Button size="sm" onClick={() => onGo("export")} disabled={exportDisabled} title={exportTitle(steps)} aria-current={current === "export" ? "step" : undefined} data-testid="export-button" data-left={left ? "1" : "0"}>
        {left ? <TriangleAlert className="text-amber-200" /> : <FileSpreadsheet />}
        書き出す（{steps.exportRows}件）
      </Button>
    </nav>
  )
}

function stepTitle(id: Exclude<StepId, "export">, s: NextStepsData) {
  if (id === "answer") return "チャットの聞き返し・変更案に答える"
  if (id === "fix") return `表で直す行（${fixBreakdown(s.fix)}）`
  return "問い合わせのタブで、顧客に聞くことを確かめて送る"
}

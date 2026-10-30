import { CircleHelp, FileSpreadsheet, FileUp, Loader2, MapPin, MessageSquareText, RotateCcw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import type { RowFilter } from "@/components/convert/status"
import { cn } from "@/lib/utils"

/**
 * 変換の報告（チャットの最初の返事）。ファイルを読む → 列の対応を考える → 変換する の進み具合と、変換のあとの注意書き
 * （計画の AI のメモ・見出しから推定した理由・まとめた行・去年との違い）、確かめる行の件数（押すと表を絞る）、職員に聞くこと（Confirmation）、
 * 次にできること（書き出す・問い合わせ・工事場所）を出す。案件の作業から作るので保存しない（変われば書き直る）
 */

export type ReportPhase =
  | { kind: "empty" }
  | { kind: "noSheet" }
  | { kind: "reading"; name: string }
  | { kind: "planning"; name: string }
  | { kind: "converting"; name: string }
  | { kind: "failed"; message: string }
  | { kind: "done" }

export type ReportQuestion = {
  id: string
  text: string
  options: { value: string; label: string }[]
  /** 答えたなら、その選択肢の表示 */
  answered: string | null
}

export type ReportCounts = { rows: number; csv: number } & Partial<Record<RowFilter, number>>

export type ReportProps = {
  phase: ReportPhase
  /** 変換の元（ファイル名とシート）の1行 */
  source: string | null
  planByAi: boolean
  /** 注意書き（計画の AI のメモなど）。tone は目立たせるか */
  notes: { text: string; tone?: "warning"; testId?: string }[]
  counts: ReportCounts | null
  onFilter: (f: RowFilter) => void
  questions: ReportQuestion[]
  onAnswer: (id: string, value: string) => void
  /** 去年の案件との違い（無ければ null） */
  previous: { fiscalYear: number; lines: string[] | null; error: string | null; changed: boolean } | null
  /** 次にできること */
  next: { export: () => void; inquiry: (() => void) | null; location: (() => void) | null; locationSites: number }
  onRetry: (() => void) | null
}

const PHASE_TEXT = {
  reading: "ファイルを読んでいます…",
  planning: "AI が列の対応を考えています…",
  converting: "変換しています…",
} as const

/** 件数の印（押すと表をその行に絞る） */
const CHIPS: { filter: RowFilter; label: string; tone: string }[] = [
  { filter: "ask", label: "問い合わせが要る", tone: "border-amber-300 bg-amber-50 text-amber-900" },
  { filter: "guessed", label: "AI の推定", tone: "border-violet-300 bg-violet-50 text-violet-900" },
  { filter: "error", label: "エラー", tone: "border-red-300 bg-red-50 text-red-900" },
  { filter: "review", label: "要確認", tone: "border-amber-200 bg-amber-50/60 text-amber-900" },
]

export function CaseReport(p: ReportProps) {
  return (
    <Message data-testid="case-report" data-phase={p.phase.kind}>
      <MessageContent className="gap-2.5">
        <MessageHeader className="px-0 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 text-violet-500" /> 変換の報告
        </MessageHeader>
        <Body {...p} />
      </MessageContent>
    </Message>
  )
}

function Body(p: ReportProps) {
  const { phase } = p
  if (phase.kind === "empty")
    return (
      <p className="flex items-start gap-2 text-sm" data-testid="report-empty">
        <FileUp className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        顧客から届いた Excel をここか表の欄に落としてください。AI が列の対応を考えて変換し、気になる点をまとめてお知らせします。
      </p>
    )
  if (phase.kind === "noSheet")
    return <p className="text-sm">届いたファイルは PDF などで、表として読めません。「PDF から工事経歴の表を作って」のように頼むと、AI が読み取って行を足す案を出します（足した行はすべて要確認になります）。</p>
  if (phase.kind === "reading" || phase.kind === "planning" || phase.kind === "converting")
    return (
      <p className="flex items-center gap-2 text-sm" data-testid="report-progress">
        <Loader2 className="size-4 animate-spin text-violet-600" />
        {phase.name && <span className="text-muted-foreground">{phase.name}:</span>}
        {PHASE_TEXT[phase.kind]}
      </p>
    )
  if (phase.kind === "failed")
    return (
      <div className="grid gap-2 text-sm text-red-800" data-testid="report-failed">
        <p>変換できませんでした: {phase.message}</p>
        {p.onRetry && (
          <Button size="sm" variant="outline" className="w-fit" onClick={p.onRetry} data-testid="report-retry">
            <RotateCcw /> もう一度変換する
          </Button>
        )}
      </div>
    )
  const c = p.counts
  return (
    <div className="grid gap-2.5 text-sm" data-testid="report-done">
      {p.source && (
        <p>
          {p.source}を{p.planByAi ? "、AI が考えた列の対応で" : "、見出しから推定した列の対応で"}変換しました
          {c && (
            <>
              （<span className="num font-medium" data-testid="report-rows">{c.rows}</span> 行。CSV に載せるのは <span className="num font-medium">{c.csv}</span> 件）
            </>
          )}
          。どの列を使ったかは、チャットで聞けば答えます。
        </p>
      )}
      {c && (
        <div className="flex flex-wrap gap-1.5" data-testid="report-counts">
          {CHIPS.filter((x) => (c[x.filter] ?? 0) > 0).map((x) => (
            <button
              key={x.filter}
              type="button"
              className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium hover:brightness-95", x.tone)}
              onClick={() => p.onFilter(x.filter)}
              data-testid="report-count"
              data-filter={x.filter}
            >
              {x.label} <span className="num">{c[x.filter]}</span> 件
            </button>
          ))}
          {CHIPS.every((x) => !c[x.filter]) && <span className="text-xs text-emerald-700">確かめる行はありません。</span>}
        </div>
      )}
      {p.notes.length > 0 && (
        <ul className="grid gap-1 text-[13px]" data-testid="report-notes">
          {p.notes.map((n, i) => (
            <li key={i} className={cn("rounded-md px-2 py-1", n.tone === "warning" ? "bg-amber-50 text-amber-900" : "bg-muted/40 text-muted-foreground")} data-testid={n.testId}>
              {n.text}
            </li>
          ))}
        </ul>
      )}
      {p.previous && (
        <div className={cn("rounded-md border px-2.5 py-1.5 text-[13px]", p.previous.changed ? "border-amber-200 bg-amber-50 text-amber-900" : "bg-muted/30")} data-testid="format-diff">
          <div className="font-medium">去年（{p.previous.fiscalYear}年度）の元の Excel との違い</div>
          {p.previous.lines ? (
            <ul className="mt-0.5 list-disc pl-4">
              {p.previous.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5">{p.previous.error}</p>
          )}
        </div>
      )}
      {p.questions.map((q) => (
        <Item key={q.id} variant="outline" size="sm" className={cn("items-start", q.answered === null ? "border-amber-300 bg-amber-50" : "bg-muted/30")} data-testid="report-question" data-question={q.id} data-answered={q.answered ?? undefined}>
          <ItemMedia variant="icon">
            <CircleHelp className="text-amber-600" />
          </ItemMedia>
          <ItemContent className="gap-2">
            <ItemTitle className="whitespace-pre-wrap">{q.text}</ItemTitle>
            {q.answered !== null ? (
              <ItemDescription>「{q.answered}」と答えました。</ItemDescription>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((o) => (
                  <Button key={o.value} size="sm" variant="outline" className="bg-background" onClick={() => p.onAnswer(q.id, o.value)} data-testid="report-answer" data-value={o.value}>
                    {o.label}
                  </Button>
                ))}
              </div>
            )}
          </ItemContent>
        </Item>
      ))}
      <div className="flex flex-wrap gap-1.5" data-testid="report-next">
        {p.next.location && (
          <Button size="sm" variant="outline" onClick={p.next.location} data-testid="report-location">
            <MapPin /> 工事場所を調べる（{p.next.locationSites}現場）
          </Button>
        )}
        {p.next.inquiry && (
          <Button size="sm" variant="outline" onClick={p.next.inquiry} data-testid="report-inquiry">
            <MessageSquareText /> 顧客への問い合わせ
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={p.next.export} data-testid="report-export">
          <FileSpreadsheet /> 書き出す前の確認
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        列の対応を変えたいとき（「金額は税込の列で」「工事名は B 列と C 列をつなげて」）や、値をまとめて直したいときは、下の欄で頼んでください。変更は案として出し、承認したものだけが表に入ります。
      </p>
    </div>
  )
}

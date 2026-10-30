import { CircleHelp, FileUp, Loader2, MapPin, RotateCcw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import { cn } from "@/lib/utils"
import type { ReportPhase } from "@/lib/cases/phase"

/**
 * 変換の報告（チャットの最初の返事）。ファイルを読む → 列の対応を考える → 変換する の進み具合と、変換のあとの職員が判断・確認すること
 * （計画の AI のメモ・見出しから推定した理由・まとめた行・去年との違い）、職員に聞くこと（Confirmation）、費用のかかる工事場所の調査を出す。
 * 確かめる行の件数・書き出す・問い合わせは表と見出しにあるので出さない。案件の作業から作るので保存しない（変われば書き直る）
 */

export type { ReportPhase }

/** アップロードしたファイルをどう扱ったか */
export type UploadNote = { name: string; text: string; tone?: "error" }

export type ReportQuestion = {
  id: string
  text: string
  options: { value: string; label: string }[]
  /** 答えたなら、その選択肢の表示 */
  answered: string | null
}

export type ReportCounts = { rows: number; csv: number }

export type ReportProps = {
  phase: ReportPhase
  /** 変換の元（ファイル名とシート）の1行 */
  source: string | null
  planByAi: boolean
  /** 注意書き（計画の AI のメモなど）。tone は目立たせるか */
  notes: { text: string; tone?: "warning"; testId?: string }[]
  counts: ReportCounts | null
  questions: ReportQuestion[]
  onAnswer: (id: string, value: string) => void
  /** 去年の案件との違い（無ければ null） */
  previous: { fiscalYear: number; lines: string[] | null; error: string | null; changed: boolean } | null
  /** 工事場所の調査（調べられる現場があるときだけ。費用がかかるので職員が押して始める） */
  location: { open: () => void; sites: number } | null
  onRetry: (() => void) | null
  uploads: UploadNote[]
}

const PHASE_TEXT = {
  reading: "ファイルを読んでいます…",
  planning: "AI が列の対応を考えています…",
  converting: "変換しています…",
} as const

export function CaseReport(p: ReportProps) {
  return (
    <Message data-testid="case-report" data-phase={p.phase.kind}>
      <MessageContent className="gap-2.5">
        {/* ファイルの前は案内だけ（まだ報告は無い） */}
        {p.phase.kind !== "empty" && (
          <MessageHeader className="px-0 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-violet-500" /> 変換の報告
          </MessageHeader>
        )}
        <Body {...p} />
        {p.uploads.length > 0 && (
          <ul className="grid gap-0.5 text-xs" data-testid="report-uploads">
            {p.uploads.map((u, i) => (
              <li key={i} className={u.tone === "error" ? "text-red-700" : "text-muted-foreground"} data-testid="report-upload" data-tone={u.tone}>
                {u.name}: {u.text}
              </li>
            ))}
          </ul>
        )}
      </MessageContent>
    </Message>
  )
}

function Body(p: ReportProps) {
  const { phase } = p
  if (phase.kind === "empty")
    return (
      <div className="grid gap-1 text-sm" data-testid="report-empty">
        <p className="flex items-start gap-2">
          <FileUp className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          顧客の Excel をアップロードしてください。
        </p>
        <p className="pl-6 text-xs text-muted-foreground">画面にドラッグしても置けます。</p>
      </div>
    )
  if (phase.kind === "noAi")
    return (
      <p className="text-sm text-red-800" data-testid="report-no-ai">
        AI が使えないため変換できません（APIキーが未設定）。管理者に連絡してください。
      </p>
    )
  if (phase.kind === "noSheet")
    return (
      <p className="text-sm" data-testid="no-sheet-source">
        表として読めるファイルがありません。「PDF から表を作って」と頼んでください。
      </p>
    )
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
        <p>{phase.retry === "source" ? "ファイルを読めませんでした" : "変換できませんでした"}: {phase.message}</p>
        {p.onRetry && (
          <Button size="sm" variant="outline" className="w-fit" onClick={p.onRetry} data-testid="report-retry">
            <RotateCcw /> やり直す
          </Button>
        )}
      </div>
    )
  const c = p.counts
  return (
    <div className="grid gap-2.5 text-sm" data-testid="report-done">
      {p.source && (
        <p>
          {p.source}を変換しました{!p.planByAi && "（見出しから推定）"}
          {c && (
            <>
              : <span className="num font-medium" data-testid="report-rows">{c.rows}</span> 行、載せる <span className="num font-medium">{c.csv}</span> 件
            </>
          )}
        </p>
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
              <ItemDescription>{q.answered}</ItemDescription>
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
      {p.location && (
        <Button size="sm" variant="outline" className="w-fit" onClick={p.location.open} data-testid="report-location">
          <MapPin /> 工事場所を調べる（{p.location.sites}現場）
        </Button>
      )}
    </div>
  )
}

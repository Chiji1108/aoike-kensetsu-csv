import { useRef, useState } from "react"
import { Loader2, RotateCcw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProposalCard, type ProposalActions } from "@/components/chat/proposal-card"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import type { TableView } from "@/lib/cases/view"
import { newProposal, type ChatChange, type Proposal, type ProposalRecord } from "@/lib/chat/proposals"
import { MAX_ITEMS_PER_REQUEST, parseAiResponse, type AiBatchRequest } from "@/lib/convert/ai-tasks"
import type { RowResult } from "@/lib/convert/convert"
import { GYOSHU_BASES, GYOSHU_BASIS_LABELS, gyoshuTrend, suggestionEdits, suggestionInput, trendText, type GyoshuBasis, type GyoshuSuggestion } from "@/lib/convert/gyoshu-guess"
import { errorMessage } from "@/lib/errors"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import { runAiBatch } from "@/server/ai"
import { recordProposalFn } from "@/server/chat-fns"

type Row = RowResult<KojiFieldId>

/**
 * 「AI で案を出す」（業種）。チャットの指示（表を全部送るコード実行の1回）ではなく、対象の行だけを値ごとの判断（runAiBatch の suggestGyoshu）で頼む:
 * 送るのは対象の行の工事名・注文者（画面の値。個人名は記号のまま）・元の業種の記載と、決まった処理で数えたほかの工事の業種の傾向だけなので安く、
 * 答えは固定の形（業種コード・根拠の種類・根拠）で受け取り、コード表で確かめる。案は変更案（出どころ fix）にし、チャットの流れの最後に出して職員が承認する
 */

/** 最後に頼んだ結果（保存しない。変更案そのものは案件の作業と R2 に残る）。failed は呼び出しに失敗した行（もう一度頼める） */
export type FixRun = { asked: number; proposed: number; undecided: number; byBasis: Partial<Record<GyoshuBasis, number>>; failed: string[]; error?: string }

export function useGyoshuSuggestion({ caseId, onRecord, onCaseCost }: { caseId: string; onRecord: (r: ProposalRecord) => void; onCaseCost: (usd: number) => void }) {
  const [running, setRunning] = useState<number | null>(null)
  const [last, setLast] = useState<FixRun | null>(null)
  const busy = useRef(false)

  /**
   * keys の行（表の行）に業種の案を出す。rows は今の表（shown。傾向はこの表のほかの行から数える）。
   * 100行ずつの呼び出しは並べて呼び、成功した分は変更案にする（失敗した分の行は failed に残し、もう一度頼める。払った結果を捨てない）
   */
  async function run(rows: readonly Row[], keys: readonly string[]) {
    if (busy.current || !keys.length) return
    busy.current = true
    const targets = new Set(keys)
    const asked = rows.filter((r) => targets.has(r.key))
    setRunning(asked.length)
    setLast(null)
    try {
      const trend = gyoshuTrend(rows, targets)
      const instruction = trendText(trend)
      const byId = new Map(asked.map((r, i) => [i, r]))
      const chunks = Array.from({ length: Math.ceil(asked.length / MAX_ITEMS_PER_REQUEST) }, (_, c): AiBatchRequest => ({
        task: "suggestGyoshu",
        instruction,
        items: asked.slice(c * MAX_ITEMS_PER_REQUEST, (c + 1) * MAX_ITEMS_PER_REQUEST).map((r, i) => ({ id: c * MAX_ITEMS_PER_REQUEST + i, input: suggestionInput(r).slice(0, 500) })),
      }))
      const settled = await Promise.allSettled(
        chunks.map(async (req) => {
          const res = await runAiBatch({ data: { caseId, ...req } })
          onCaseCost(res.usd)
          if (!res.ok) throw new Error(res.message)
          const parsed = parseAiResponse("suggestGyoshu", req, res.json)
          if (!parsed.ok) throw new Error(parsed.message)
          return parsed.results
        }),
      )
      const results = new Map<number, GyoshuSuggestion>()
      const failed: string[] = []
      const errors = new Set<string>()
      settled.forEach((s, c) => {
        if (s.status === "fulfilled") for (const [id, r] of s.value) results.set(id, r)
        else {
          errors.add(errorMessage(s.reason, "AI の案を出せませんでした"))
          for (const it of chunks[c]!.items) failed.push(byId.get(it.id)!.key)
        }
      })
      const answered = new Map([...byId].filter(([, r]) => !failed.includes(r.key)))
      const { edits, undecided } = suggestionEdits(answered, results, trend)
      const byBasis: FixRun["byBasis"] = {}
      for (const e of edits) byBasis[e.basis] = (byBasis[e.basis] ?? 0) + 1
      if (edits.length) {
        const changes: ChatChange[] = edits.map((e) => ({ kind: "cell", rowKey: e.rowKey, field: "gyoshu", edit: e.edit }))
        const proposal = newProposal(crypto.randomUUID(), { kind: "fix", runId: crypto.randomUUID(), field: "gyoshu" }, changes, null)
        await recordProposalFn({ data: { caseId, record: { proposal, changes } } })
        onRecord({ proposal, changes })
      }
      setLast({ asked: asked.length, proposed: edits.length, undecided, byBasis, failed, ...(errors.size ? { error: [...errors].join(" / ") } : {}) })
    } catch (e) {
      setLast({ asked: asked.length, proposed: 0, undecided: 0, byBasis: {}, failed: asked.map((r) => r.key), error: errorMessage(e, "AI の案を出せませんでした") })
    } finally {
      busy.current = false
      setRunning(null)
    }
  }
  return { run, running, last }
}
export type GyoshuSuggestionState = ReturnType<typeof useGyoshuSuggestion>

/** チャットの流れの最後に出す「AI で案を出す」の進み具合・結果と、変更案（承認・却下・取り消しはチャットの変更案と同じ） */
export function FixSuggestionPanel({
  state,
  proposals,
  changes,
  view,
  actions,
  busy,
  onRetry,
}: {
  state: Pick<GyoshuSuggestionState, "running" | "last">
  /** 失敗した行にもう一度頼む（前の案を決め終えていなければ押せない） */
  onRetry: ((keys: readonly string[]) => void) | null
  /** 出どころが fix の、開いているか取り消せる変更案 */
  proposals: readonly Proposal[]
  changes: ReadonlyMap<string, readonly ChatChange[]>
  view: TableView | null
  actions: Omit<ProposalActions, "canSend">
  busy: boolean
}) {
  const { running, last } = state
  if (running === null && !last && !proposals.length) return null
  return (
    <Message data-testid="fix-suggestion" data-running={running !== null ? "1" : undefined}>
      <MessageContent className="gap-2.5">
        <MessageHeader className="px-0 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 text-violet-600" /> 業種の AI の案
        </MessageHeader>
        {running !== null && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {running} 行の業種の案を考えています…
          </p>
        )}
        {last && (
          <p className="text-xs" data-testid="fix-suggestion-summary">
            {summaryText(last)}
          </p>
        )}
        {last?.error && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-red-700" data-testid="fix-suggestion-error">
            {last.failed.length} 行は AI を呼べませんでした（{last.error}）。
            {!onRetry && running === null && <span className="text-muted-foreground">前の案を承認か却下すると、もう一度頼めます。</span>}
            {onRetry && running === null && (
              <Button size="xs" variant="outline" onClick={() => onRetry(last.failed)} data-testid="fix-suggestion-retry">
                <RotateCcw /> もう一度頼む
              </Button>
            )}
          </div>
        )}
        {view && proposals.map((p) => <ProposalCard key={p.id} proposal={p} changes={changes.get(p.id)} view={view} actions={{ ...actions, canSend: true }} busy={busy} />)}
      </MessageContent>
    </Message>
  )
}

/** 結果の言葉。list は業種の一覧に出すとき（一覧の欄で決める）、そうでなければチャットの流れ（変更案を承認する・業種のタブで選ぶ） */
export function summaryText(r: FixRun, list = false) {
  const by = GYOSHU_BASES.filter((b) => r.byBasis[b]).map((b) => `${GYOSHU_BASIS_LABELS[b]} ${r.byBasis[b]}`)
  const head = r.proposed ? `${r.asked} 行のうち ${r.proposed} 行に案を出しました（${by.join("・")}）。` : r.failed.length === r.asked ? "" : `${r.asked - r.failed.length} 行に案を出せませんでした。`
  const rest = r.undecided ? `決められなかった ${r.undecided} 行は、${list ? "右の欄" : "業種のタブ"}で業種を選んでください。` : ""
  const trend = r.byBasis.trend || r.byBasis.workName ? `推定の行は根拠を見て${list ? "決めて" : "承認して"}ください。` : ""
  return `${head}${trend}${rest}`
}

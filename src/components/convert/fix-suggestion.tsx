import { useRef, useState } from "react"
import { Loader2, Sparkles } from "lucide-react"
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

/** 最後に頼んだ結果（保存しない。変更案そのものは案件の作業と R2 に残る） */
export type FixRun = { asked: number; proposed: number; undecided: number; byBasis: Partial<Record<GyoshuBasis, number>>; error?: string }

export function useGyoshuSuggestion({ caseId, onRecord, onCaseCost }: { caseId: string; onRecord: (r: ProposalRecord) => void; onCaseCost: (usd: number) => void }) {
  const [running, setRunning] = useState<number | null>(null)
  const [last, setLast] = useState<FixRun | null>(null)
  const busy = useRef(false)

  /** keys の行（表の行）に業種の案を出す。rows は今の表（shown。傾向はこの表のほかの行から数える） */
  async function run(rows: readonly Row[], keys: readonly string[]) {
    if (busy.current || !keys.length) return
    busy.current = true
    const targets = new Set(keys)
    const asked = rows.filter((r) => targets.has(r.key))
    setRunning(asked.length)
    setLast(null)
    try {
      const instruction = trendText(gyoshuTrend(rows, targets))
      const byId = new Map(asked.map((r, i) => [i, r]))
      const results = new Map<number, GyoshuSuggestion>()
      for (let start = 0; start < asked.length; start += MAX_ITEMS_PER_REQUEST) {
        const req: AiBatchRequest = {
          task: "suggestGyoshu",
          instruction,
          items: asked.slice(start, start + MAX_ITEMS_PER_REQUEST).map((r, i) => ({ id: start + i, input: suggestionInput(r).slice(0, 500) })),
        }
        const res = await runAiBatch({ data: { caseId, ...req } })
        onCaseCost(res.usd)
        if (!res.ok) throw new Error(res.message)
        const parsed = parseAiResponse("suggestGyoshu", req, res.json)
        if (!parsed.ok) throw new Error(parsed.message)
        for (const [id, r] of parsed.results) results.set(id, r)
      }
      const { edits, undecided } = suggestionEdits(byId, results)
      const byBasis: FixRun["byBasis"] = {}
      for (const e of edits) byBasis[e.basis] = (byBasis[e.basis] ?? 0) + 1
      if (edits.length) {
        const changes: ChatChange[] = edits.map((e) => ({ kind: "cell", rowKey: e.rowKey, field: "gyoshu", edit: e.edit }))
        const proposal = newProposal(crypto.randomUUID(), { kind: "fix", runId: crypto.randomUUID(), field: "gyoshu" }, changes, null)
        await recordProposalFn({ data: { caseId, record: { proposal, changes } } })
        onRecord({ proposal, changes })
      }
      setLast({ asked: asked.length, proposed: edits.length, undecided, byBasis })
    } catch (e) {
      setLast({ asked: asked.length, proposed: 0, undecided: 0, byBasis: {}, error: errorMessage(e, "AI の案を出せませんでした") })
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
}: {
  state: Pick<GyoshuSuggestionState, "running" | "last">
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
        {last && <p className={last.error ? "text-xs text-red-700" : "text-xs"} data-testid="fix-suggestion-summary">{summaryText(last)}</p>}
        {view && proposals.map((p) => <ProposalCard key={p.id} proposal={p} changes={changes.get(p.id)} view={view} actions={{ ...actions, canSend: true }} busy={busy} />)}
      </MessageContent>
    </Message>
  )
}

function summaryText(r: FixRun) {
  if (r.error) return r.error
  const by = GYOSHU_BASES.filter((b) => r.byBasis[b]).map((b) => `${GYOSHU_BASIS_LABELS[b]} ${r.byBasis[b]}`)
  const head = r.proposed ? `${r.asked} 行のうち ${r.proposed} 行に案を出しました（${by.join("・")}）。` : `${r.asked} 行に案を出せませんでした。`
  const rest = r.undecided ? `決められなかった ${r.undecided} 行は、表で業種を選んでください。` : ""
  const trend = r.byBasis.trend ? "推定の行は根拠を見て承認してください。" : ""
  return `${head}${trend}${rest}`
}

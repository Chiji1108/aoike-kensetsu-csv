import { FileSpreadsheet } from "lucide-react"
import { ProposalCard, type ProposalActions } from "@/components/chat/proposal-card"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import type { TableView } from "@/lib/cases/view"
import type { ChatChange, Proposal } from "@/lib/chat/proposals"
import type { FinalReport } from "@/lib/excel/final-import"
import { fieldLabel } from "@/lib/spec/koji-keireki"

export type FinalImport = { name: string; report: FinalReport }

/**
 * 直した最後の Excel を上げ直した結果（チャット欄の報告の下）。変更案（承認の画面はチャットと同じ）と、取り込まなかったもの
 * （食い違い・読めない値・決めきれない行など）を黙って捨てずに一覧で出す。読めなかった Excel は報告のファイルの行に出す
 */
export function FinalImportPanel({
  result,
  view,
  proposals,
  changes,
  actions,
  busy,
}: {
  /** 最後に上げ直した結果（保存しない） */
  result: FinalImport | null
  view: TableView | null
  /** 出どころが Excel の、開いているか取り消せる変更案 */
  proposals: readonly Proposal[]
  changes: ReadonlyMap<string, readonly ChatChange[]>
  actions: Omit<ProposalActions, "canSend">
  busy: boolean
}) {
  if (!result && !proposals.length) return null
  return (
    <Message data-testid="final-import">
      <MessageContent className="gap-2.5">
        <MessageHeader className="px-0 text-xs text-muted-foreground">
          <FileSpreadsheet className="size-3.5 text-emerald-600" /> 直した Excel
        </MessageHeader>
        {result && <ImportReport result={result} />}
        {view && proposals.map((p) => <ProposalCard key={p.id} proposal={p} changes={changes.get(p.id)} view={view} actions={{ ...actions, canSend: true }} busy={busy} />)}
      </MessageContent>
    </Message>
  )
}

function ImportReport({ result }: { result: FinalImport }) {
  const r = result.report
  const proposed = r.cells + r.added + r.excluded
  const problems: { label: string; items: string[] }[] = [
    { label: "落としたあとに表が変わっていたので取り込まなかった値（今の値を残しています）", items: r.conflicts.map((c) => `${c.line}行目 ${fieldLabel(c.field)}: 落としたとき「${c.sent}」→ 今「${c.now}」、Excel「${c.uploaded}」`) },
    { label: "どの工事を直したか決めきれなかった行（表かチャットで直してください）", items: r.ambiguous.map((a) => `${a.line}行目（似た工事が ${a.candidates} 件）`) },
    { label: "読めない値", items: r.invalid.map((c) => `${c.line}行目 ${fieldLabel(c.field)}「${c.value}」: ${c.message}`) },
    { label: "個人名を確かめられなかった値（手で直してください）", items: r.refused.map((c) => `${c.line}行目 ${fieldLabel(c.field)}「${c.value}」: ${c.message}`) },
  ].filter((p) => p.items.length)
  return (
    <div className="grid gap-2 text-xs" data-testid="final-import-report">
      <p>
        {result.name}:{" "}
        {r.duplicate
          ? "同じ変更案がもうあります（下の変更案）。"
          : proposed
            ? `変更案にしました（セル ${r.cells} 件・足す ${r.added} 行・載せない ${r.excluded} 行）。`
            : problems.length
              ? "変更案にできる変更はありませんでした。"
              : "落としたときから変わったところはありませんでした。"}
        {r.alreadyAdded > 0 && ` 足した ${r.alreadyAdded} 行はもう表にあります。`}
        {r.keptRows > 0 && ` 決めきれない行の候補 ${r.keptRows} 行は「載せない」にしていません。`}
        {r.unknownRows > 0 && ` 今の表に無い行が ${r.unknownRows} 行あり、取り込んでいません。`}
      </p>
      {problems.map((p) => (
        <details key={p.label} open className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900" data-testid="final-import-problem">
          <summary className="cursor-pointer font-medium">
            {p.label}（{p.items.length}件）
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {p.items.slice(0, 50).map((x, i) => (
              <li key={i}>{x}</li>
            ))}
            {p.items.length > 50 && <li>ほか {p.items.length - 50} 件</li>}
          </ul>
        </details>
      ))}
    </div>
  )
}

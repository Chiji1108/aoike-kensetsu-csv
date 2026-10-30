import { useRef, useState } from "react"
import { FileDown, FileUp, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { ProposalCard, type ProposalActions } from "@/components/chat/proposal-card"
import { Button } from "@/components/ui/button"
import type { TableView } from "@/lib/cases/view"
import type { ChatChange, Proposal } from "@/lib/chat/proposals"
import { errorMessage } from "@/lib/errors"
import { INCLUDE_HEADER, type EditReport } from "@/lib/excel/edit-sheet"
import { fieldLabel } from "@/lib/inquiry/inquiry"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"

export type EditImport = { report: EditReport } | { error: string }

const labelOf = (f: KojiFieldId | "include") => (f === "include" ? INCLUDE_HEADER : fieldLabel(f))

/**
 * Excel で直す: 今の表を編集用の Excel で落とし、職員が直して上げ直すと差分を変更案にする（承認の画面はチャットと同じ）。
 * 取り込めなかったもの（食い違い・読めない値・壊れた行など）は黙って捨てずに一覧で出す
 */
export function EditExcelPanel({
  view,
  proposals,
  changes,
  actions,
  busy,
  download,
  upload,
  result,
  onResult,
}: {
  view: TableView
  /** 出どころが Excel の、開いている変更案 */
  proposals: readonly Proposal[]
  changes: ReadonlyMap<string, readonly ChatChange[]>
  actions: Omit<ProposalActions, "canSend">
  busy: boolean
  download: () => Promise<void>
  /** 上げた Excel を読み、変更案を置く。読めなければ error */
  upload: (f: File) => Promise<{ report: EditReport } | { error: string } | undefined>
  /** 最後に取り込んだ結果（案件の画面が持つ。チャット欄に落とした Excel の結果もここに出す） */
  result: EditImport | null
  onResult: (r: EditImport) => void
}) {
  const [working, setWorking] = useState<"download" | "upload" | null>(null)
  const setResult = onResult
  const input = useRef<HTMLInputElement>(null)

  async function run<T>(kind: "download" | "upload", f: () => Promise<T>) {
    setWorking(kind)
    try {
      return await f()
    } catch (e) {
      toast.error(errorMessage(e, kind === "download" ? "Excel を作れませんでした" : "Excel を取り込めませんでした"))
      return undefined
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border bg-muted/20 p-3" data-testid="edit-excel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto" />
        <Button size="sm" variant="outline" disabled={working !== null} onClick={() => void run("download", download)} data-testid="edit-excel-download">
          {working === "download" ? <Loader2 className="animate-spin" /> : <FileDown />} 編集用の Excel を落とす
        </Button>
        <Button size="sm" variant="outline" disabled={working !== null} onClick={() => input.current?.click()} data-testid="edit-excel-upload">
          {working === "upload" ? <Loader2 className="animate-spin" /> : <FileUp />} 直した Excel を上げる
        </Button>
        <input
          ref={input}
          type="file"
          accept=".xlsx"
          className="sr-only"
          data-testid="edit-excel-input"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ""
            if (f) void run("upload", () => upload(f)).then((r) => r && setResult(r))
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">全行を落とします。直して上げると、差分が変更案になります。</p>
      {result && <ImportReport result={result} />}
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} changes={changes.get(p.id)} view={view} actions={{ ...actions, canSend: true }} busy={busy} />
      ))}
    </div>
  )
}

function ImportReport({ result }: { result: { report: EditReport } | { error: string } }) {
  if ("error" in result)
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800" data-testid="edit-excel-error">
        {result.error}
      </p>
    )
  const r = result.report
  const proposed = r.cells + r.added + r.included + r.excluded
  const problems: { label: string; items: string[] }[] = [
    { label: "落としたあとに表が変わっていたので取り込まなかった値（今の値を残しています）", items: r.conflicts.map((c) => `${c.line}行目 ${labelOf(c.field)}: 落としたとき「${c.sent}」→ 今「${c.now}」、Excel「${c.uploaded}」`) },
    { label: "読めない値", items: r.invalid.map((c) => `${c.line}行目 ${labelOf(c.field)}「${c.value}」: ${c.message}`) },
    { label: "個人名を確かめられなかった値（手で直してください）", items: r.refused.map((c) => `${c.line}行目 ${labelOf(c.field)}「${c.value}」: ${c.message}`) },
    { label: "照合用の列が壊れていて取り込まなかった行", items: r.broken.map((b) => `${b.line}行目: ${b.reason}`) },
    { label: "同じ照合用が2つ以上の行にあり、取り込まなかった（工事を足すときは空いた行に書いてください）", items: r.duplicateKeys },
    { label: "今の表に無い行（変換の元を変えたなど）", items: r.unknownKeys },
    { label: "見つからなかった列（その列は変えていません）", items: r.missingColumns },
  ].filter((p) => p.items.length)
  return (
    <div className="grid gap-2 text-xs" data-testid="edit-excel-report">
      <p>
        {proposed
          ? `変更案にしました: セル ${r.cells} 件・足す ${r.added} 行・載せる ${r.included} 行・載せない ${r.excluded} 行。`
          : "落としたときから変わったところはありませんでした。"}
        {r.alreadyAdded > 0 && ` 前に上げて足した ${r.alreadyAdded} 行はもう表にあるので、足していません。`}
        {r.deletionsSkipped && " 壊れた行があるため、消した行を「載せない」にはしていません。"}
      </p>
      {problems.map((p) => (
        <details key={p.label} open className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900" data-testid="edit-excel-problem">
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

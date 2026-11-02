import { useMemo, useState } from "react"
import { Copy, FileDown, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { RowResult } from "@/lib/convert/convert"
import { withNames } from "@/lib/convert/persons"
import { fieldLabel } from "@/lib/spec/koji-keireki"
import { errorMessage } from "@/lib/errors"
import { countsByItem, DEFAULT_INTRO, inquiryEmail } from "@/lib/inquiry/email"
import { DraftText } from "./draft-text"
import { MAX_INTRO_LENGTH, MAX_SUBJECT_LENGTH, type InquiryText } from "@/lib/inquiry/text"
import { CASE_TOPICS, inquiryKey, REASONS, type AnswerReport, type CellInquiry, type Inquiry } from "@/lib/inquiry/inquiry"
import type { AttachmentChoice } from "@/lib/inquiry/marked"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"

type Row = RowResult<KojiFieldId>

/**
 * 顧客に問い合わせる: 件数・項目ごとの件数・外すチェック、メールの件名と本文、添付の Excel（印付き。書けなければ記入用Excel）、
 * 取り込んだ回答の結果（返ってきた Excel はチャットの📎でアップロードする）。
 * inquiries は CSV に載せる行から集めたもの。聞くことは添付の Excel の色付きのセルとメモで伝え、質問の文は書かない
 */
export function InquiryPanel({
  inquiries,
  allRows,
  dismissed,
  answers,
  text,
  onText,
  attachment,
  onDownload,
  onToggle,
}: {
  inquiries: Inquiry[]
  allRows: Row[]
  dismissed: ReadonlySet<string>
  /** 最後に取り込んだ回答の結果 */
  answers: AnswerReport | null
  /** 問い合わせのメールの件名と前置き（案件の作業） */
  text: InquiryText
  onText: (next: (prev: InquiryText) => InquiryText) => void
  /** 添付する Excel（印付きか記入用Excelか。lib/inquiry/marked.ts の chooseAttachment） */
  attachment: AttachmentChoice
  /** 添付の Excel を作ってダウンロードし、案件に残す（印付きを書けなければ記入用Excel） */
  onDownload: () => Promise<void>
  onToggle: (key: string, ask: boolean) => void
}) {
  const active = useMemo(() => inquiries.filter((q) => !dismissed.has(inquiryKey(q))), [inquiries, dismissed])
  const email = useMemo(() => inquiryEmail(active, attachment, text), [active, attachment, text])
  const byItem = useMemo(() => {
    const cases = active.flatMap((q) => (q.kind === "case" ? [{ label: CASE_TOPICS[q.topic].label, count: 1 }] : []))
    return [...cases, ...countsByItem(active)]
  }, [active])
  const rowLabel = useMemo(() => new Map(allRows.map((r) => [r.key, `${r.sheet}!${r.row + 1}`])), [allRows])
  const rowByKey = useMemo(() => new Map(allRows.map((r) => [r.key, r])), [allRows])
  const [downloading, setDownloading] = useState(false)

  async function download() {
    setDownloading(true)
    try {
      await onDownload()
    } catch (e) {
      toast.error(errorMessage(e, "Excel を作れませんでした"))
    } finally {
      setDownloading(false)
    }
  }

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${what}をコピーしました`)
    } catch (e) {
      toast.error(errorMessage(e, "コピーできませんでした。文面を選んでコピーしてください"))
    }
  }

  /** 件名・前置きは空にすると決まった文に戻す */
  const editMail = (key: "subject" | "intro", next: string) => onText((t) => ({ ...t, [key]: next.trim() || null }))

  return (
    <section className="mt-10 space-y-4" data-testid="inquiry-panel">
      <div>
        <p className="mt-0.5 text-xs text-muted-foreground">載せる行で、データに無い・推定に自信がない項目です。聞かなくてよいものはチェックを外します。</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="inquiry-counts">
        <span className="font-semibold">問い合わせ {active.length} 件</span>
        {inquiries.length !== active.length && <span className="text-muted-foreground">（外した {inquiries.length - active.length} 件）</span>}
        {byItem.map(({ label, count }) => (
          <span key={label} className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs">
            {label} {count}件
          </span>
        ))}
      </div>

      {inquiries.length > 0 && (
        <details className="rounded-xl border bg-card p-3">
          <summary className="cursor-pointer text-sm font-semibold">問い合わせの一覧（{inquiries.length}件）</summary>
          <div className="mt-2 max-h-80 overflow-auto">
            <table className="w-full text-xs" data-testid="inquiry-list">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2">聞く</th>
                  <th className="py-1 pr-2">元の行</th>
                  <th className="py-1 pr-2">項目</th>
                  <th className="py-1 pr-2">理由</th>
                  <th className="py-1">今の値</th>
                </tr>
              </thead>
              <tbody>
                {inquiries.map((q) => {
                  const key = inquiryKey(q)
                  return (
                    <tr key={key} className="border-t" data-inquiry={key}>
                      <td className="py-1 pr-2">
                        <input type="checkbox" aria-label="問い合わせる" checked={!dismissed.has(key)} onChange={(e) => onToggle(key, e.target.checked)} />
                      </td>
                      <td className="num py-1 pr-2 text-muted-foreground">{q.kind === "cell" ? rowLabel.get(q.rowKey) : "案件全体"}</td>
                      <td className="py-1 pr-2">{q.kind === "cell" ? fieldLabel(q.field) : CASE_TOPICS[q.topic].label}</td>
                      <td className="py-1 pr-2">{q.kind === "cell" ? REASONS[q.reason].label : "不明"}</td>
                      <td className="py-1">{q.kind === "cell" ? rowByKey.get(q.rowKey)?.cells[q.field].value || "—" : ""}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {active.length > 0 && (
        <div className="grid gap-3">
          <p className="text-sm font-semibold">メール</p>
          {/* 空にすると決まった件名・前置きに戻る */}
          <DraftText label="件名" maxLength={MAX_SUBJECT_LENGTH} value={email.subject} onCommit={(v) => editMail("subject", v)} testId="inquiry-subject" />
          <DraftText multiline label="前置き" maxLength={MAX_INTRO_LENGTH} value={text.intro ?? DEFAULT_INTRO} onCommit={(v) => editMail("intro", v)} testId="inquiry-intro" />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void copy(email.subject, "件名")} data-testid="copy-subject">
              <Copy />
              件名をコピー
            </Button>
            <Button variant="outline" onClick={() => void copy(email.body, "本文")} data-testid="copy-email">
              <Copy />
              本文をコピー
            </Button>
            {attachment.askCount > 0 && (
              <Button variant="outline" onClick={() => void download()} disabled={downloading} data-testid="download-inquiry-xlsx" data-kind={attachment.kind}>
                {downloading ? <Loader2 className="animate-spin" /> : <FileDown />}
                Excel をダウンロード（{attachment.kind === "marked" ? "印付き" : "記入用Excel"}・{attachment.askCount}件）
              </Button>
            )}
          </div>
          {attachment.askCount > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="inquiry-attachment">
              {attachment.kind === "marked" ? "顧客の元の Excel に、聞くセルの色と推定のメモを付けます。" : `${attachment.reason}、こちらの形の記入用Excelにします。`}
            </p>
          )}
          <Textarea readOnly className="h-64 font-mono text-xs" value={email.body} data-testid="inquiry-email" />
        </div>
      )}

      {allRows.length > 0 && (
        <div className="grid gap-2">
          {/* 返ってきた Excel のアップロードは、ほかのファイルと同じくチャットの📎（印で見分けて取り込む） */}
          <p className="text-xs text-muted-foreground" data-testid="answer-upload-note">
            顧客から返ってきた Excel は、チャットの📎でアップロードすると顧客の回答の変更案になります。
          </p>
          {answers && <AnswerReportView report={answers} rowLabel={rowLabel} />}
        </div>
      )}
    </section>
  )
}

function AnswerReportView({ report, rowLabel }: { report: AnswerReport; rowLabel: ReadonlyMap<string, string> }) {
  const where = (q: CellInquiry) => `${rowLabel.get(q.rowKey) ?? q.rowKey} ${fieldLabel(q.field)}`
  const problems = [
    ...report.alsoChanged.map(
      (c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 聞いていない欄が「${c.was}」から「${c.answer}」に書き換えられていたので変更案にしました`,
    ),
    ...report.changed.map(
      (c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 送ったあとに「${withNames(c.now)}」に変わっていたため反映していません（回答「${withNames(c.answer)}」）`,
    ),
    ...report.invalid.map((c) => `${where(c.inquiry)}: ${c.message}（記入「${c.answer}」）`),
    ...report.needsCheck.map((c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 「${c.answer}」を変更案にしましたが要確認です（${c.message}）`),
    ...report.heldBack.map(
      (c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 同じ欄のもう一方を反映できなかったため、「${c.answer}」も反映していません`,
    ),
    ...report.unknownKeys.map((k) => `管理番号「${k}」の行が今のデータにありません`),
    ...report.unreadable.map((u) => `${u.line}行目${u.rowKey ? `（${rowLabel.get(u.rowKey) ?? u.rowKey}）` : ""}は取り込めませんでした（${u.reason}）`),
    ...report.duplicateKeys.map((k) => `管理番号「${k}」の行が2つ以上あり、どれが回答か分からないため取り込みませんでした`),
  ]
  return (
    <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm" data-testid="answer-report">
      <p>
        変更案 <strong>{report.applied.length}</strong> 件
        {report.alsoChanged.length > 0 && <> ／ 聞いていない欄の書き換え {report.alsoChanged.length} 件</>} ／ 未記入 {report.unanswered.length} 件
        {report.confirmed.length > 0 && <> ／ 推定のまま確認 {report.confirmed.length} 件</>}
        {report.alreadyApplied.length > 0 && <> ／ 表にもうある {report.alreadyApplied.length} 件</>}
        {problems.length > 0 && <> ／ 要確認 {problems.length} 件</>}
      </p>
      {problems.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-amber-900">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {report.unanswered.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">未記入: {report.unanswered.map(where).join("、")}</p>
      )}
    </div>
  )
}

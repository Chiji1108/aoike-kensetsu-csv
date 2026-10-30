import { useMemo } from "react"
import { createClientOnlyFn } from "@tanstack/react-start"
import { Copy, FileDown, FileUp } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { RowResult } from "@/lib/convert/convert"
import { datedFileName } from "@/lib/convert/csv"
import { withNames } from "@/lib/convert/persons"
import { errorMessage } from "@/lib/errors"
import { saveFile } from "@/lib/save-file"
import { DEFAULT_INTRO, DEFAULT_SUBJECT, inquiryEmail } from "@/lib/inquiry/email"
import { editQuestion, groupCount, questionGroups, type InquiryText, type QuestionGroup } from "@/lib/inquiry/text"
import {
  CASE_TOPICS,
  fieldLabel,
  inquiryKey,
  inquirySheet,
  REASONS,
  type AnswerReport,
  type CellInquiry,
  type Inquiry,
} from "@/lib/inquiry/inquiry"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"

type Row = RowResult<KojiFieldId>

/** ExcelJS はブラウザでだけ読み込む（サーバーのバンドルに入れない） */
const loadXlsxWriter = createClientOnlyFn(() => import("@/lib/inquiry/inquiry-xlsx"))

/**
 * 顧客に問い合わせる: 件数・項目ごとの件数・外すチェック、質問の文（AI の案を承認したもの・職員が直したもの・決まった文）、メールの件名と本文、記入用Excel、回答の取り込み。
 * inquiries は CSV に載せる行から集めたもの。回答の照合は記入用Excelの各行の照合用の列で行うので、どの版の記入用Excelでも取り込める。
 */
export function InquiryPanel({
  inquiries,
  outputRows,
  allRows,
  customer,
  dismissed,
  answers,
  text,
  onText,
  keepFile,
  onToggle,
  importAnswers,
}: {
  inquiries: Inquiry[]
  outputRows: Row[]
  allRows: Row[]
  customer: string
  dismissed: ReadonlySet<string>
  /** 最後に取り込んだ回答の結果 */
  answers: AnswerReport | null
  /** 問い合わせの文面（案件の作業） */
  text: InquiryText
  onText: (next: (prev: InquiryText) => InquiryText) => void
  /** ダウンロードした記入用Excelを案件に残す */
  keepFile: (name: string, bytes: Uint8Array, type: string) => void
  onToggle: (key: string, ask: boolean) => void
  /** 記入された Excel を取り込む（案件の画面が照合して手直しに反映し、結果を answers に入れる。チャット欄に落としたときも同じ） */
  importAnswers: (file: File) => Promise<void>
}) {
  const active = useMemo(() => inquiries.filter((q) => !dismissed.has(inquiryKey(q))), [inquiries, dismissed])
  const activeCells = useMemo(() => active.filter((q): q is CellInquiry => q.kind === "cell"), [active])
  const { groups, groupOf } = useMemo(() => questionGroups(active, text), [active, text])
  const sheet = useMemo(() => inquirySheet(outputRows, activeCells, (q) => groupOf.get(inquiryKey(q))!.text), [outputRows, activeCells, groupOf])
  const email = useMemo(() => inquiryEmail(groups, sheet, text), [groups, sheet, text])
  const byItem = useMemo(() => {
    const counts = new Map<string, number>()
    for (const q of active) {
      const label = q.kind === "case" ? CASE_TOPICS[q.topic].label : fieldLabel(q.field)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts]
  }, [active])
  const rowLabel = useMemo(() => new Map(allRows.map((r) => [r.key, `${r.sheet}!${r.row + 1}`])), [allRows])
  const rowByKey = useMemo(() => new Map(allRows.map((r) => [r.key, r])), [allRows])

  async function downloadXlsx() {
    try {
      const { inquiryXlsx } = await loadXlsxWriter()
      const bytes = await inquiryXlsx(sheet, customer)
      const name = datedFileName("記入のお願い", customer, new Date(), "xlsx")
      const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      saveFile(bytes, name, type)
      keepFile(name, bytes, type)
    } catch (e) {
      toast.error(errorMessage(e, "記入用Excelを作れませんでした"))
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

  const editGroup = (g: QuestionGroup, next: string) => onText((t) => editQuestion(t, g, next, crypto.randomUUID()))
  /** 件名・前置きは空にすると決まった文に戻す */
  const editMail = (key: "subject" | "intro", next: string) => onText((t) => ({ ...t, [key]: next.trim() || null }))

  return (
    <section className="mt-10 space-y-4" data-testid="inquiry-panel">
      <div>
        <p className="mt-0.5 text-xs text-muted-foreground">載せる行で、データに無い・推定に自信がない項目です。聞かなくてよいものはチェックを外します。質問の文は直せます（空にすると決まった文）。</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="inquiry-counts">
        <span className="font-semibold">問い合わせ {active.length} 件</span>
        {inquiries.length !== active.length && <span className="text-muted-foreground">（外した {inquiries.length - active.length} 件）</span>}
        {byItem.map(([label, n]) => (
          <span key={label} className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs">
            {label} {n}件
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
        <div className="grid gap-2" data-testid="inquiry-questions">
          <p className="text-sm font-semibold">質問の文</p>
          {groups.map((g) => (
            <div key={`${g.id}\t${g.text}`} className="flex items-start gap-2" data-testid="inquiry-question" data-by={g.by} data-group={g.id}>
              <Textarea
                aria-label="質問の文"
                className="min-h-0 text-sm"
                rows={2}
                defaultValue={g.text}
                onBlur={(e) => {
                  if (e.target.value.trim() !== g.text) editGroup(g, e.target.value)
                }}
              />
              <div className="grid shrink-0 justify-items-end gap-1 pt-1 text-xs text-muted-foreground">
                <span>{groupCount(g)}件</span>
                <Badge variant="outline">{g.by === "ai" ? "AI" : g.by === "staff" ? "直した文" : "決まった文"}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="grid gap-3">
          <p className="text-sm font-semibold">メール</p>
          <Input
            key={`subject\t${text.subject}`}
            aria-label="件名"
            title="件名"
            defaultValue={email.subject}
            placeholder={DEFAULT_SUBJECT}
            onBlur={(e) => {
              if (e.target.value.trim() !== email.subject) editMail("subject", e.target.value)
            }}
            data-testid="inquiry-subject"
          />
          <Textarea
            key={`intro\t${text.intro}`}
            aria-label="前置き"
            title="前置き"
            className="min-h-0 text-sm"
            rows={2}
            defaultValue={text.intro ?? DEFAULT_INTRO}
            onBlur={(e) => {
              if (e.target.value.trim() !== (text.intro ?? DEFAULT_INTRO)) editMail("intro", e.target.value)
            }}
            data-testid="inquiry-intro"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void copy(email.subject, "件名")} data-testid="copy-subject">
              <Copy />
              件名をコピー
            </Button>
            <Button variant="outline" onClick={() => void copy(email.body, "本文")} data-testid="copy-email">
              <Copy />
              本文をコピー
            </Button>
            {sheet.askCount > 0 && (
              <Button variant="outline" onClick={downloadXlsx} data-testid="download-inquiry-xlsx">
                <FileDown />
                記入用Excelをダウンロード（{sheet.askCount}件）
              </Button>
            )}
          </div>
          <Textarea readOnly className="h-64 font-mono text-xs" value={email.body} data-testid="inquiry-email" />
        </div>
      )}

      {allRows.length > 0 && (
        <div className="grid gap-2">
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/60">
            <FileUp className="size-4" />
            記入された Excel を取り込む
            <input
              type="file"
              accept=".xlsx,.xls"
              className="sr-only"
              data-testid="answer-input"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importAnswers(f)
                e.target.value = ""
              }}
            />
          </label>
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
      (c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 聞いていない欄が「${c.was}」から「${c.answer}」に書き換えられていたので反映しました`,
    ),
    ...report.changed.map(
      (c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 送ったあとに「${withNames(c.now)}」に変わっていたため反映していません（回答「${withNames(c.answer)}」）`,
    ),
    ...report.invalid.map((c) => `${where(c.inquiry)}: ${c.message}（記入「${c.answer}」）`),
    ...report.needsCheck.map((c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 「${c.answer}」を反映しましたが要確認です（${c.message}）`),
    ...report.heldBack.map(
      (c) => `${rowLabel.get(c.rowKey) ?? c.rowKey} ${fieldLabel(c.field)}: 同じ欄のもう一方を反映できなかったため、「${c.answer}」も反映していません`,
    ),
    ...report.unknownKeys.map((k) => `管理番号「${k}」の行が今のデータにありません`),
    ...report.unreadable.map((u) => `記入用Excelの${u.line}行目${u.rowKey ? `（管理番号「${u.rowKey}」）` : ""}は取り込めませんでした（${u.reason}）`),
    ...report.duplicateKeys.map((k) => `管理番号「${k}」の行が2つ以上あり、どれが回答か分からないため取り込みませんでした`),
  ]
  return (
    <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm" data-testid="answer-report">
      <p>
        反映 <strong>{report.applied.length}</strong> 件
        {report.alsoChanged.length > 0 && <> ／ 聞いていない欄の書き換え {report.alsoChanged.length} 件</>} ／ 未記入 {report.unanswered.length} 件
        {report.confirmed.length > 0 && <> ／ 推定のまま確認 {report.confirmed.length} 件</>}
        {report.alreadyApplied.length > 0 && <> ／ 反映済み {report.alreadyApplied.length} 件</>}
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

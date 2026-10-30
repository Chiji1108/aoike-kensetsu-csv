import { z } from "zod"
import { fieldIdSchema } from "../schemas"
import type { KojiFieldId } from "../spec/koji-keireki"
import { nfkc, removeSpaces } from "../convert/text"
import { charCount } from "../chat/rules"
import { columnOf, fixedQuestion, inquiryKey, type CaseTopic, type Inquiry, type InquiryReason } from "./inquiry"

/**
 * 問い合わせの文面（顧客に送る質問の文とメールの件名・前置き）。AI が書いた案を職員が承認したもの・職員が直したものを案件の作業に残す。
 * 文の無い問い合わせは決まった文（fixedQuestion）のまま。似た問い合わせは1つの質問にまとめる（targets）。
 * targets は項目と理由で選び、keys があればその行だけ（行の key）。今の問い合わせに当てはめて文を決めるので、答えが入って問い合わせが減っても、
 * 同じ聞き方の問い合わせが増えても、そのまま使える
 */

export const MAX_QUESTION_LENGTH = 200
export const MAX_SUBJECT_LENGTH = 100
export const MAX_INTRO_LENGTH = 600
/** 残す質問の数（古いものから捨てる。案件の作業は D1 の1行に入れるので） */
export const MAX_QUESTIONS = 40
const MAX_TARGETS = 20
/** 1つの質問・残す文面全体で keys に書ける行の数（文面は案件の作業に入れるので、行を並べすぎない。多い行はふつう項目と理由で選べる） */
export const MAX_QUESTION_KEYS = 2000
export const MAX_TOTAL_KEYS = 5000

export type QuestionTarget = { field: KojiFieldId; reason?: InquiryReason; keys?: string[] } | { topic: CaseTopic }
export type InquiryQuestion = { id: string; text: string; targets: QuestionTarget[]; by: "ai" | "staff" }
/** subject・intro は null なら決まった文 */
export type InquiryText = { subject: string | null; intro: string | null; questions: InquiryQuestion[] }

export const EMPTY_INQUIRY_TEXT: InquiryText = { subject: null, intro: null, questions: [] }

/** チャットの「AI で文面を作る」で送る指示 */
export const INQUIRY_TEXT_PROMPT = "今の問い合わせを、顧客に伝わる質問の文とメールの下書きにして（似た質問はまとめて）"

const lengthAtMost = (n: number) => (s: string) => charCount(s) <= n
export const questionTextSchema = z.string().trim().min(1).refine(lengthAtMost(MAX_QUESTION_LENGTH), `質問は${MAX_QUESTION_LENGTH}字まで`)
export const subjectSchema = z.string().trim().min(1).refine(lengthAtMost(MAX_SUBJECT_LENGTH), `件名は${MAX_SUBJECT_LENGTH}字まで`)
export const introSchema = z.string().trim().min(1).refine(lengthAtMost(MAX_INTRO_LENGTH), `前置きは${MAX_INTRO_LENGTH}字まで`)
const reasonSchema = z.enum(["missing", "needsReview"])
export const questionTargetSchema: z.ZodType<QuestionTarget> = z.union([
  z.strictObject({ topic: z.literal("tax") }),
  z.strictObject({ field: fieldIdSchema, reason: reasonSchema.optional(), keys: z.array(z.string().max(200)).min(1).max(MAX_QUESTION_KEYS).optional() }),
])
const keyCount = (targets: readonly QuestionTarget[]) => targets.reduce((n, t) => n + ("keys" in t && t.keys ? t.keys.length : 0), 0)
export const questionTargetsSchema = z
  .array(questionTargetSchema)
  .min(1)
  .max(MAX_TARGETS)
  .refine((ts) => keyCount(ts) <= MAX_QUESTION_KEYS, `1つの質問の keys は合わせて${MAX_QUESTION_KEYS}行まで`)
export const inquiryQuestionSchema: z.ZodType<InquiryQuestion> = z.object({ id: z.string().max(64), text: questionTextSchema, targets: questionTargetsSchema, by: z.enum(["ai", "staff"]) })
export const inquiryTextSchema: z.ZodType<InquiryText> = z.object({
  subject: subjectSchema.nullable(),
  intro: introSchema.nullable(),
  questions: z
    .array(inquiryQuestionSchema)
    .max(MAX_QUESTIONS)
    .refine((qs) => qs.reduce((n, q) => n + keyCount(q.targets), 0) <= MAX_TOTAL_KEYS, `keys は合わせて${MAX_TOTAL_KEYS}行まで`),
})

/** keys の Set（問い合わせの数×行の数で探さない。同じ配列は作り直さない） */
const keySets = new WeakMap<readonly string[], ReadonlySet<string>>()
function keySet(keys: readonly string[]) {
  let set = keySets.get(keys)
  if (!set) keySets.set(keys, (set = new Set(keys)))
  return set
}

/** 問い合わせへの当てはまり方（大きいほど強い）。keys で選んだ行 > 項目と理由 > 項目だけ。当てはまらなければ 0 */
export function matchRank(t: QuestionTarget, q: Inquiry): number {
  if ("topic" in t) return q.kind === "case" && q.topic === t.topic ? 3 : 0
  if (q.kind !== "cell" || q.field !== t.field || (t.reason && t.reason !== q.reason)) return 0
  if (t.keys) return keySet(t.keys).has(q.rowKey) ? 3 : 0
  return t.reason ? 2 : 1
}

/** 質問の文のまとまり。fixed は決まった文（question は無い）。inquiries は今の問い合わせのうち、この文で聞くもの */
export type QuestionGroup = { id: string; text: string; by: "ai" | "staff" | "fixed"; inquiries: Inquiry[]; question?: InquiryQuestion }

const fixedId = (q: Inquiry) => (q.kind === "case" ? `fixed:case:${q.topic}` : `fixed:${columnOf(q.field)?.header ?? q.field}:${q.reason}`)

/**
 * 今の問い合わせ（外したものは除いて渡す）を質問の文でまとめる。問い合わせごとに、いちばん強く当てはまる質問（同じ強さなら後のもの）を使い、
 * 無ければ決まった文（同じ欄・同じ理由で1つ）。並びは問い合わせの順
 */
export function questionGroups(inquiries: readonly Inquiry[], text: InquiryText): { groups: QuestionGroup[]; groupOf: ReadonlyMap<string, QuestionGroup> } {
  const groups = new Map<string, QuestionGroup>()
  const groupOf = new Map<string, QuestionGroup>()
  for (const q of inquiries) {
    let best: { rank: number; question: InquiryQuestion } | null = null
    for (const question of text.questions) {
      const rank = Math.max(0, ...question.targets.map((t) => matchRank(t, q)))
      if (rank > 0 && (!best || rank >= best.rank)) best = { rank, question }
    }
    const id = best ? best.question.id : fixedId(q)
    let g = groups.get(id)
    if (!g) {
      g = best ? { id, text: best.question.text, by: best.question.by, inquiries: [], question: best.question } : { id, text: fixedQuestion(q), by: "fixed", inquiries: [] }
      groups.set(id, g)
    }
    g.inquiries.push(q)
    groupOf.set(inquiryKey(q), g)
  }
  return { groups: [...groups.values()], groupOf }
}

/** まとまりで聞く工事の数（工事場所の都道府県と場所名は1件。案件全体の質問は1件） */
export const groupCount = (g: QuestionGroup) => new Set(g.inquiries.map((q) => (q.kind === "cell" ? q.rowKey : inquiryKey(q)))).size

/** 質問を足す（承認した AI の案・職員が直した文）。数の上限を超えたら古いものから捨てる */
export function addQuestions(text: InquiryText, questions: readonly InquiryQuestion[]): InquiryText {
  const ids = new Set(questions.map((q) => q.id))
  const next = [...text.questions.filter((q) => !ids.has(q.id)), ...questions].slice(-MAX_QUESTIONS)
  // keys の行の数の上限を超えたら、古い質問から捨てる
  let keys = next.reduce((n, q) => n + keyCount(q.targets), 0)
  while (keys > MAX_TOTAL_KEYS) keys -= keyCount(next.shift()!.targets)
  return { ...text, questions: next }
}

/**
 * 職員が質問の文を直す。AI・職員の質問は文を変え（空にすると消して決まった文に戻す）、決まった文を直すと、
 * そのまとまりと同じ欄・同じ理由の問い合わせへの職員の質問にする
 */
export function editQuestion(text: InquiryText, group: QuestionGroup, next: string, newId: string): InquiryText {
  const value = next.trim()
  if (group.question) {
    const id = group.question.id
    if (!value) return { ...text, questions: text.questions.filter((q) => q.id !== id) }
    return { ...text, questions: text.questions.map((q) => (q.id === id ? { ...q, text: value, by: "staff" } : q)) }
  }
  if (!value || value === group.text) return text
  const first = group.inquiries[0]!
  const targets: QuestionTarget[] = first.kind === "case" ? [{ topic: first.topic }] : (columnOf(first.field)?.fields ?? [first.field]).map((field) => ({ field, reason: first.reason }))
  return addQuestions(text, [{ id: newId, text: value, targets, by: "staff" }])
}

/** 文の中に、ほかの顧客の名前があるかを確かめる関数（会社の種類の語・空白・全角半角の違いは除いて比べる。3文字に満たない名前は見ない） */
export function otherCustomerTest(names: Iterable<string>): (text: string) => boolean {
  const core = (s: string) => removeSpaces(nfkc(s)).replace(/株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|㈱|㈲/g, "")
  const list = [...new Set([...names].map(core))].filter((n) => [...n].length >= 3)
  return (text) => {
    const t = core(text)
    return list.some((n) => t.includes(n))
  }
}

/** 変更案の問い合わせの文（lib/chat/proposals.ts の ChatChange のうち問い合わせの文面のもの） */
export type InquiryTextChange = { kind: "inquiry"; text: string; targets: QuestionTarget[] } | { kind: "inquiryMail"; subject: string; intro: string }

/** 承認した変更案の文を文面に重ねる。質問の id は変更案と項目の番号（取り消してからもう一度承認しても重ならない） */
export function applyInquiryChanges(text: InquiryText, proposalId: string, approved: readonly { index: number; change: InquiryTextChange }[]): InquiryText {
  let next = text
  const questions: InquiryQuestion[] = []
  for (const { index, change } of approved) {
    if (change.kind === "inquiryMail") next = { ...next, subject: change.subject, intro: change.intro }
    else questions.push({ id: `${proposalId}:${index}`, text: change.text, targets: change.targets, by: "ai" })
  }
  return questions.length ? addQuestions(next, questions) : next
}

/**
 * AI が出した質問の確かめ（チャットの propose_inquiry）。対象が今の問い合わせに当てはまらない・keys に聞いていない行がある・
 * 1つの問い合わせに2つの質問が同じ強さで当てはまるなら problems。covered はこの案の文で聞く問い合わせ、fallback は決まった文のまま残る問い合わせの数
 */
export function checkQuestions(questions: readonly { targets: readonly QuestionTarget[] }[], inquiries: readonly Inquiry[]) {
  const problems: string[] = []
  questions.forEach((q, i) => {
    // 案件全体の質問はメールに1つずつ載せるので、セルの問い合わせとまとめない
    if (q.targets.some((t) => "topic" in t) && q.targets.some((t) => !("topic" in t))) problems.push(`questions[${i}]: 税込・税抜の質問は、ほかの問い合わせとまとめずに1つの質問にしてください`)
    q.targets.forEach((t, j) => {
      const where = `questions[${i}].targets[${j}]`
      if (!inquiries.some((x) => matchRank(t, x) > 0)) problems.push(`${where}: 今の問い合わせに当てはまりません`)
      else if (!("topic" in t) && t.keys) {
        const asked = new Set(inquiries.flatMap((x) => (x.kind === "cell" && matchRank({ field: t.field, ...(t.reason ? { reason: t.reason } : {}) }, x) > 0 ? [x.rowKey] : [])))
        const unknown = t.keys.filter((k) => !asked.has(k))
        if (unknown.length) problems.push(`${where}: 聞いていない行の key があります（${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? " ほか" : ""}）`)
      }
    })
  })
  let covered = 0
  const tied: string[] = []
  for (const x of inquiries) {
    const ranks = questions.map((q) => Math.max(0, ...q.targets.map((t) => matchRank(t, x))))
    const top = Math.max(0, ...ranks)
    if (top === 0) continue
    covered++
    if (ranks.filter((r) => r === top).length > 1) tied.push(inquiryKey(x))
  }
  if (tied.length) problems.push(`同じ問い合わせに2つの質問が当てはまります（${tied.slice(0, 5).join(", ")}${tied.length > 5 ? ` ほか${tied.length - 5}件` : ""}）。1つの問い合わせは1つの質問にしてください`)
  return { problems, covered, fallback: inquiries.length - covered }
}

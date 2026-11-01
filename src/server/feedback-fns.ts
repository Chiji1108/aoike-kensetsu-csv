import { createServerFn } from "@tanstack/react-start"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { getDb } from "@/db"
import { csvCases } from "@/db/cases-schema"
import { reviewGuard } from "@/lib/chat/review"
import { EMPTY_INQUIRY_TEXT } from "@/lib/inquiry/text"
import { tryParseJson } from "@/lib/json"
import { feedbackInputSchema, feedbackNameCheck, feedbackStatusSchema, feedbackTexts, type FeedbackItem } from "@/lib/feedback/feedback"
import * as store from "./case-store"
import { namesOfSaved, readSavedCase, UnreadableCaseError } from "./case-names"
import * as feedback from "./feedback-store"
import { authMiddleware } from "./middleware"

/** 要望の画面（一覧・職員が書き足す・状態を変える）。どの操作も今の一覧を返す */

const filterSchema = feedbackStatusSchema.nullable()

export type FeedbackResult = { ok: true; items: FeedbackItem[] } | { ok: false; message: string; items: FeedbackItem[] }

export const listFeedbackFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ status: filterSchema }))
  .handler(async ({ data }) => feedback.listFeedback(getDb(), data.status))

/** 匿名化の AI に送った注文者・工事名（AI の結果のキー〔lib/convert/convert.ts の aiKey: [task, 指示, 入力]〕の入力。保存した案件の注文者・工事名の元の値） */
const NAME_TASKS = { anonymizeClient: "client", anonymizeWorkName: "workName" } as const
const aiKeySchema = z.tuple([z.string(), z.string(), z.string()])

/**
 * 職員が書いた要望の確かめ（AI の要望と同じ: 個人名・表の記号・顧客名・注文者・工事名）。要望の画面は案件を持たないので、
 * 保存したすべての案件の作業と AI の結果から、分かっている個人名と注文者・工事名を集める（職員が書き足すときだけ。案件を1つずつ読む）
 */
async function staffCheck(db: store.Db) {
  const persons = new Set<string>()
  const clients: string[] = []
  const works: { client: string; workName: string }[] = []
  const cases = await db.select({ id: csvCases.id, customerId: csvCases.customerId }).from(csvCases).where(eq(csvCases.deleting, false))
  for (const c of cases) {
    let saved
    try {
      saved = await readSavedCase(db, c.id)
    } catch (e) {
      // 形の変わった古い作業は名前を集められない（その案件の名前は確かめられないまま。顧客名は確かめる）
      if (e instanceof UnreadableCaseError) continue
      throw e
    }
    for (const n of namesOfSaved(saved)) persons.add(n)
    for (const [key] of saved?.aiCache ?? []) {
      const k = aiKeySchema.safeParse(tryParseJson(key))
      if (!k.success || !Object.hasOwn(NAME_TASKS, k.data[0])) continue
      const field = NAME_TASKS[k.data[0] as keyof typeof NAME_TASKS]
      // AI の結果からは工事名の注文者が分からないので、一般の語かは「いくつの顧客の工事名に出るか」で数える（顧客の id を注文者の代わりにする。
      // 案件の id にすると、同じ顧客の毎年の案件に出る現場名などが一般の語と見なされて通ってしまう）
      if (field === "client") clients.push(k.data[2])
      else if (field === "workName") works.push({ client: c.customerId, workName: k.data[2] })
    }
  }
  const empty = { rows: [], added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded", basis: {}, rule7Tax: "excluded", selection: "all", rounding: "floor", dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT } as const
  const guard = reviewGuard(empty, persons)
  const [customers, rules] = await Promise.all([store.listCustomers(db), store.rulesForAi(db, null)])
  const names = feedbackNameCheck({ names: [...customers.map((c) => c.name), ...clients], works, known: [rules.global] })
  return (text: string) => [...(guard.has(text) ? ["個人名・表の記号"] : []), ...names(text)]
}

/** 職員が書き足す（由来の案件は付けない）。個人名・顧客名・注文者・工事名が入っていれば断り、入っていた語を知らせる */
export const addFeedbackFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ input: feedbackInputSchema, status: filterSchema }))
  .handler(async ({ data }): Promise<FeedbackResult> => {
    const db = getDb()
    const check = await staffCheck(db)
    const hits = [...new Set(feedbackTexts(data.input).flatMap(check))]
    if (hits.length) return { ok: false, message: `名前が入っています（${hits.join("・")}）。名前を挙げずに書き直してください。`, items: await feedback.listFeedback(db, data.status) }
    await feedback.addFeedback(db, { ...data.input, caseId: null, source: "staff" })
    return { ok: true, items: await feedback.listFeedback(db, data.status) }
  })

export const setFeedbackStatusFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1).max(64), to: feedbackStatusSchema, status: filterSchema }))
  .handler(async ({ data }): Promise<FeedbackResult> => {
    const db = getDb()
    const ok = await feedback.setFeedbackStatus(db, data.id, data.to)
    const items = await feedback.listFeedback(db, data.status)
    return ok ? { ok: true, items } : { ok: false, message: "要望が見つかりません", items }
  })

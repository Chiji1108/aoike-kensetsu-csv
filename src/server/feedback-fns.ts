import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { getDb } from "@/db"
import { feedbackInputSchema, feedbackStatusSchema, feedbackTexts, properNameHits, type FeedbackItem } from "@/lib/feedback/feedback"
import * as store from "./case-store"
import * as feedback from "./feedback-store"
import { authMiddleware } from "./middleware"

/** 要望の画面（一覧・職員が書き足す・状態を変える）。どの操作も今の一覧を返す */

const filterSchema = feedbackStatusSchema.nullable()

export type FeedbackResult = { ok: true; items: FeedbackItem[] } | { ok: false; message: string; items: FeedbackItem[] }

export const listFeedbackFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ status: filterSchema }))
  .handler(async ({ data }) => feedback.listFeedback(getDb(), data.status))

/** 職員が書き足す（由来の案件は付けない）。顧客の名前が入っていれば断る */
export const addFeedbackFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ input: feedbackInputSchema, status: filterSchema }))
  .handler(async ({ data }): Promise<FeedbackResult> => {
    const db = getDb()
    const names = (await store.listCustomers(db)).map((c) => c.name)
    const hits = feedbackTexts(data.input).flatMap((t) => properNameHits(t, names))
    if (hits.length) return { ok: false, message: "顧客の名前が入っています。名前を挙げずに書いてください。", items: await feedback.listFeedback(db, data.status) }
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

import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { getDb } from "@/db"
import { rule7TaxSchema, ruleTextSchema, type RuleItem, type RuleTarget } from "@/lib/chat/rules"
import { errorMessage } from "@/lib/errors"
import * as store from "./case-store"
import { authMiddleware } from "./middleware"

/**
 * 全体ルール・顧客ルールの項目の読み書き（画面の箇条書き）。操作は項目ごとなので、2つの画面で別の項目を直しても消し合わない。
 * 同じ項目を直した・消したときは版で断り、今の一覧と一緒に返す（画面は入力を残して知らせる）
 */

const id = z.string().min(1).max(64)
const target: z.ZodType<RuleTarget> = z.discriminatedUnion("scope", [z.object({ scope: z.literal("global") }), z.object({ scope: z.literal("customer"), customerId: id })])

export type RulesResult = { ok: true; items: RuleItem[] } | { ok: false; stale: boolean; message: string; items: RuleItem[] }

/** 操作をして、今の一覧を返す。断ったとき（ほかの画面と食い違った・上限）は理由と一緒に返す */
async function run(t: RuleTarget, op: () => Promise<unknown>): Promise<RulesResult> {
  const db = getDb()
  try {
    await op()
  } catch (e) {
    if (!(e instanceof store.StaleRuleError) && !(e instanceof store.RulesTooLongError)) throw e
    return { ok: false, stale: e instanceof store.StaleRuleError, message: errorMessage(e, "直せませんでした"), items: await store.listRuleItems(db, t) }
  }
  return { ok: true, items: await store.listRuleItems(db, t) }
}

export const getGlobalRulesFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const db = getDb()
    const [items, settings] = await Promise.all([store.listRuleItems(db, { scope: "global" }), store.getSettings(db)])
    return { items, settings }
  })

export const saveSettingsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ rule7Tax: rule7TaxSchema }))
  .handler(async ({ data }) => {
    await store.saveSettings(getDb(), data)
  })

export const addRuleItemFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ target, text: ruleTextSchema }))
  .handler(({ data }) => run(data.target, () => store.addRuleItem(getDb(), data.target, data.text)))

export const updateRuleItemFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ target, id, version: z.number().int().min(1), text: ruleTextSchema }))
  .handler(({ data }) => run(data.target, () => store.updateRuleItem(getDb(), data.target, data.id, data.version, data.text)))

export const deleteRuleItemFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ target, id, version: z.number().int().min(1) }))
  .handler(({ data }) => run(data.target, () => store.deleteRuleItem(getDb(), data.target, data.id, data.version)))

export const moveRuleItemFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ target, id, direction: z.enum(["up", "down"]) }))
  .handler(({ data }) => run(data.target, () => store.moveRuleItem(getDb(), data.target, data.id, data.direction)))

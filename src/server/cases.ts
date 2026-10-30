import { env } from "cloudflare:workers"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { getDb } from "@/db"
import { MAX_STATE_BYTES, savedAiCacheSchema, savedWorkSchema, type SavedAiCache, type SavedWork } from "@/lib/cases/state"
import { CASE_STATUSES, isSheetFile, type Case } from "@/lib/cases/types"
import { planColumns } from "@/lib/convert/plan"
import { tryParseJson } from "@/lib/json"
import * as store from "./case-store"
import { endChat, readOpenProposals } from "./chat"
import { ChatBusyError } from "./chat-store"
import { stopRunsBeforeDelete } from "./location-control"
import { authMiddleware } from "./middleware"

const id = z.string().min(1).max(64)
const name = z.string().trim().min(1).max(100)
/** 元データの形式のメモの長さの上限 */
const longText = z.string().max(20_000)

export const listCustomersFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => store.listCustomers(getDb()))

export const createCustomerFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ name }))
  .handler(({ data }) => store.createCustomer(getDb(), data.name))

export const updateCustomerFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id, name: name.optional(), formatNote: longText.optional() }))
  .handler(async ({ data: { id, ...patch } }) => {
    await store.updateCustomer(getDb(), id, patch)
  })

/** 顧客の画面。顧客が無ければ null */
export const getCustomerPageFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ id }))
  .handler(async ({ data }) => {
    const db = getDb()
    const customer = await store.getCustomer(db, data.id)
    if (!customer) return null
    const [cases, rules] = await Promise.all([store.listCases(db, customer.id), store.listRuleItems(db, { scope: "customer", customerId: customer.id })])
    return { customer, cases, rules }
  })

export const createCaseFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ customerId: id, fiscalYear: z.number().int().min(2000).max(2100) }))
  .handler(({ data }) => store.createCase(getDb(), data.customerId, data.fiscalYear))

export const updateCaseStatusFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id, status: z.enum(CASE_STATUSES) }))
  .handler(async ({ data }) => {
    await store.updateCaseStatus(getDb(), data.id, data.status)
  })

/** 案件の画面。案件が無ければ null。保存した状態は形を検証して返す（読めない形なら投げる。黙って空にしない） */
export const getCasePageFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ id }))
  .handler(async ({ data }) => {
    const db = getDb()
    const kase = await store.getCase(db, data.id)
    if (!kase) return null
    const [customer, files, row, settings] = await Promise.all([store.getCustomer(db, kase.customerId), store.listFiles(db, kase.id), store.getCaseState(db, kase.id), store.getSettings(db)])
    let state: { version: number; work: SavedWork; aiCache: SavedAiCache } | null = null
    if (row) {
      const work = savedWorkSchema.safeParse(JSON.parse(row.json))
      const aiCache = savedAiCacheSchema.safeParse(JSON.parse(row.aiCache))
      if (!work.success || !aiCache.success) throw new Error("保存した案件の状態を読めませんでした（形が変わっています）")
      state = { version: row.version, work: work.data, aiCache: aiCache.data }
    }
    // 変更案の記録（R2）のうち、案件の作業で決め終わっていないもの（作業にまだ無いもの＝画面が受け取り損ねたものも）
    const [proposals, previous] = await Promise.all([readOpenProposals(kase.id, new Set(state?.work.proposals.filter((p) => p.state === "closed").map((p) => p.id))), previousOf(db, kase)])
    return { kase, customer: customer!, files, state, chatEnabled: !!env.ANTHROPIC_API_KEY, proposals, previous, settings }
  })

/**
 * 同じ顧客の前の年度の案件（去年との比べ・「去年のやり方で直す」に使う）。source は去年の変換の元のファイル（無ければ届いた表のファイルの最初）、
 * sheet・headerRow は去年の計画の元のシートと見出しの行、engineerColumns は配置技術者の列（計画が無ければ null・空。画面が見出しから推定する）。
 * 去年の作業が読めなくても今年の案件は開ける（去年の分は参考なので、読めるところだけ返す）
 */
async function previousOf(db: store.Db, kase: Case) {
  const prev = await store.previousCase(db, kase)
  if (!prev) return null
  const [json, files] = await Promise.all([store.getCaseWorkJson(db, prev.id), store.listFiles(db, prev.id)])
  const work = savedWorkSchema.safeParse(json === undefined ? undefined : tryParseJson(json))
  const saved = work.success ? work.data : undefined
  const source = files.find((f) => f.id === saved?.sourceFileId) ?? files.find((f) => f.kind === "source" && isSheetFile(f.name)) ?? null
  const plan = source && saved?.sourceFileId === source.id ? saved.plan?.plan : undefined
  const engineer = plan?.fields.engineer
  return {
    caseId: prev.id,
    fiscalYear: prev.fiscalYear,
    source,
    sheet: plan?.sheets[0] ?? null,
    headerRow: plan?.headerRow ?? null,
    engineerColumns: engineer ? planColumns(engineer) : [],
    /** 去年の列の対応（列の計画の AI に参考として渡す） */
    plan: plan ?? null,
  }
}

const tooLarge = (json: string | undefined) => json !== undefined && new TextEncoder().encode(json).byteLength > MAX_STATE_BYTES

/** 作業を保存する。AI の結果は変わったときだけ送る（最初の保存では必ず） */
export const saveCaseStateFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId: id, version: z.number().int().min(0), work: savedWorkSchema, aiCache: savedAiCacheSchema.optional() }))
  .handler(async ({ data }) => {
    const json = JSON.stringify(data.work)
    const aiCache = data.aiCache && JSON.stringify(data.aiCache)
    if (tooLarge(json) || tooLarge(aiCache)) return { ok: false as const, reason: "tooLarge" as const }
    return store.saveCaseState(getDb(), data.caseId, data.version, { json, aiCache })
  })

const target = z.union([z.object({ customerId: id }), z.object({ caseId: id })])

export const deletionCountsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(target)
  .handler(({ data }) => store.deletionCounts(getDb(), data))

/**
 * 案件または顧客を消す。confirmName は画面で入力した顧客名（違えば消さない）。
 * 何度実行しても同じ結果になるので、途中で失敗したらもう一度実行すれば消し切れる（案件の行がもう無くても R2 は消す）
 */
export const deleteFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.intersection(target, z.object({ confirmName: z.string() })))
  .handler(async ({ data }) => {
    const db = getDb()
    const customerId = "caseId" in data ? (await store.getCase(db, data.caseId))?.customerId : data.customerId
    const customer = customerId === undefined ? undefined : await store.getCustomer(db, customerId)
    // 行がもう無ければ確かめる名前も無い。それでも消す（前の削除で残った R2 のファイルを消し切る）
    if (customer && customer.name !== data.confirmName.trim()) throw new Error("顧客名が一致しません")
    // 削除の印を先に立て（新しい指示を始めさせない）、AI に渡したファイル（Files API）を消してから案件を消す。
    // 消せなければ案件も消さない（もう一度押せば続きから消せる）
    const caseIds = "caseId" in data ? [data.caseId] : (await store.listCases(db, data.customerId)).map((c) => c.id)
    try {
      await store.endChatsBeforeDelete(db, caseIds, endChat)
    } catch (e) {
      if (e instanceof ChatBusyError) throw new Error("チャットの指示を処理している案件があります。返事が終わってから消してください（何も消していません）")
      throw e
    }
    // 走っている工事場所の調査を止める（削除中の印が立ったので、もう新しく AI を呼ばない）
    await stopRunsBeforeDelete(db, caseIds)
    if ("caseId" in data) await store.deleteCase(db, env.FILES, data.caseId)
    else await store.deleteCustomer(db, env.FILES, data.customerId)
    return { deleted: true }
  })

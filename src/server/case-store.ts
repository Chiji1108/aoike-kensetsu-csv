import { and, asc, count, desc, eq, exists, gt, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm"
import type { BatchItem, BatchResponse } from "drizzle-orm/batch"
import { alias, type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import { csvCaseAiCaches, csvCaseFiles, csvCases, csvCaseStates, csvCustomers, csvRuleAppends, csvRuleItems, csvSettings } from "@/db/cases-schema"
import type * as schema from "@/db/schema"
import { charCount, MAX_RULE_ITEMS, MAX_RULES_TOTAL, ruleSourceSchema, rulesText, type ProposedRuleSource, type Rule7Tax, type RuleItem, type RuleScope, type RuleSource, type RuleTarget } from "@/lib/chat/rules"
import { deleteMemoryOfCustomer, deleteRunsOfCase } from "./location-store"
import { casePrefix, r2KeyOf, type Case, type CaseFile, type CaseStatus, type Customer, type CustomerSummary, type DeletionCounts, type FileKind } from "@/lib/cases/types"

/**
 * 顧客・案件・ファイルの読み書き（D1 と R2）。サーバー関数とファイルのルートから呼ぶ。
 * D1 でも bun:sqlite でも動くよう、drizzle の sqlite の型で受ける（テストは bun:sqlite と手元の R2 の代わりで回す）
 */
export type Db = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema> & Batchable

/** いくつかの書き込みを1つの処理（トランザクション）で流す（D1 の batch。テストの bun:sqlite でも同じ形で持たせる） */
type Batchable = { batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>> }

/** R2Bucket のうち使うところ */
export type Bucket = {
  /** 置いたものの大きさを返す（R2 は条件付きの put でなければ null を返さない） */
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<{ size: number } | null>
  delete(keys: string[]): Promise<void>
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[] } & ({ truncated: true; cursor: string } | { truncated: false })>
}

const ms = (d: Date) => d.getTime()
const toCustomer = (r: typeof csvCustomers.$inferSelect): Customer => ({ ...r, createdAt: ms(r.createdAt), updatedAt: ms(r.updatedAt) })
const toCase = (r: typeof csvCases.$inferSelect): Case => ({ ...r, createdAt: ms(r.createdAt), updatedAt: ms(r.updatedAt) })
const toFile = ({ r2Key: _, status: __, ...r }: typeof csvCaseFiles.$inferSelect): CaseFile => ({ ...r, createdAt: ms(r.createdAt) })

/** 案件があり、削除中でない（行を足す・保存するときの条件。削除を始めた案件には何も足さない） */
const isLive = (caseId: string) => and(eq(csvCases.id, caseId), eq(csvCases.deleting, false))
const liveCase = (db: Db, caseId: string) => exists(db.select({ one: sql`1` }).from(csvCases).where(isLive(caseId)))

// ---- 顧客 ----

export async function listCustomers(db: Db): Promise<CustomerSummary[]> {
  const rows = await db
    .select({ customer: csvCustomers, caseCount: count(csvCases.id) })
    .from(csvCustomers)
    .leftJoin(csvCases, eq(csvCases.customerId, csvCustomers.id))
    .groupBy(csvCustomers.id)
    .orderBy(csvCustomers.name)
  return rows.map((r) => ({ ...toCustomer(r.customer), caseCount: r.caseCount }))
}

/** ほかの顧客の名前（問い合わせの文に入れない。lib/inquiry/text.ts の otherCustomerTest） */
export async function otherCustomerNames(db: Db, customerId: string): Promise<string[]> {
  const rows = await db.select({ name: csvCustomers.name }).from(csvCustomers).where(ne(csvCustomers.id, customerId))
  return rows.map((r) => r.name)
}

export async function getCustomer(db: Db, id: string): Promise<Customer | undefined> {
  const [row] = await db.select().from(csvCustomers).where(eq(csvCustomers.id, id))
  return row && toCustomer(row)
}

export async function createCustomer(db: Db, name: string): Promise<Customer> {
  const [row] = await db.insert(csvCustomers).values({ id: crypto.randomUUID(), name }).returning()
  return toCustomer(row!)
}

export async function updateCustomer(db: Db, id: string, patch: Partial<Pick<Customer, "name">>) {
  await db.update(csvCustomers).set({ ...patch, updatedAt: new Date() }).where(eq(csvCustomers.id, id))
}

// ---- ルール（全体ルール・顧客ルールの項目）と事務所の設定 ----

const SETTINGS_ID = "global"

/** 事務所の設定（行はマイグレーション 0004 が作る。読むだけで書かない） */
export async function getSettings(db: Db): Promise<{ rule7Tax: Rule7Tax }> {
  const [row] = await db.select({ rule7Tax: csvSettings.rule7Tax }).from(csvSettings).where(eq(csvSettings.id, SETTINGS_ID))
  return { rule7Tax: row?.rule7Tax ?? "excluded" }
}

export async function saveSettings(db: Db, patch: { rule7Tax: Rule7Tax }) {
  await db
    .insert(csvSettings)
    .values({ id: SETTINGS_ID, ...patch })
    .onConflictDoUpdate({ target: csvSettings.id, set: { ...patch, updatedAt: new Date() } })
}

export type { RuleTarget }


const inList = (target: RuleTarget) =>
  target.scope === "global" ? and(eq(csvRuleItems.scope, "global"), isNull(csvRuleItems.customerId)) : and(eq(csvRuleItems.scope, "customer"), eq(csvRuleItems.customerId, target.customerId))

/** 知らない由来の項目がある（新しいコードで足した由来を前のコードで読んだ・D1 を手で直した）。黙って別の由来にせず、どの項目かを知らせて止める */
export class UnknownRuleSourceError extends Error {
  constructor(id: string, source: string) {
    super(`ルールの項目（${id}）の由来「${source}」を読めません。新しい版に戻すか、項目の由来を直してください`)
  }
}

/** D1 の由来を確かめる（text の列なので型の値と限らない） */
function sourceOf(item: { id: string; source: string }): RuleSource {
  const parsed = ruleSourceSchema.safeParse(item.source)
  if (!parsed.success) throw new UnknownRuleSourceError(item.id, item.source)
  return parsed.data
}

/** 一覧の項目（並びの順。由来の案件の年度と顧客名つき。案件が消えていれば由来は無し） */
export async function listRuleItems(db: Db, target: RuleTarget): Promise<RuleItem[]> {
  const originCustomer = alias(csvCustomers, "origin_customer")
  const rows = await db
    .select({ item: csvRuleItems, fiscalYear: csvCases.fiscalYear, customerName: originCustomer.name })
    .from(csvRuleItems)
    .leftJoin(csvCases, eq(csvCases.id, csvRuleItems.caseId))
    .leftJoin(originCustomer, eq(originCustomer.id, csvCases.customerId))
    .where(inList(target))
    .orderBy(asc(csvRuleItems.position), asc(csvRuleItems.createdAt), asc(csvRuleItems.id))
  return rows.map(({ item, fiscalYear, customerName }) => ({
    id: item.id,
    text: item.text,
    source: sourceOf(item),
    version: item.version,
    origin: item.caseId && fiscalYear !== null && customerName !== null ? { caseId: item.caseId, fiscalYear, customerName } : null,
  }))
}

/** 一覧の上限（項目の数・合計の字数）を超えたので足せない・直せない */
export class RulesTooLongError extends Error {
  constructor() {
    super(`ルールが多すぎて足せません（${MAX_RULE_ITEMS}項目・合計${MAX_RULES_TOTAL.toLocaleString("ja-JP")}字まで）。ほかの項目を短くするか消してから足してください`)
  }
}

/** 同じ項目をほかの画面（・チャットの承認）が先に直した・消した */
export class StaleRuleError extends Error {
  constructor(readonly current: string | null) {
    super(current === null ? "この項目はほかの画面で消されました" : "この項目はほかの画面で直されました。今の文章を確かめてから直してください")
  }
}

const listCount = (target: RuleTarget) => sql<number>`(select count(*) from ${csvRuleItems} where ${inList(target)})`
const listLength = (target: RuleTarget, except?: string) =>
  sql<number>`(select coalesce(sum(length(${csvRuleItems.text})), 0) from ${csvRuleItems} where ${inList(target)}${except ? sql` and ${csvRuleItems.id} <> ${except}` : sql``})`
/** 足せるか（数と合計の字数）と、一覧の持ち主がいるか（顧客ルールは顧客の行がある） */
const canAdd = (target: RuleTarget, text: string) =>
  and(
    sql`${listCount(target)} < ${MAX_RULE_ITEMS}`,
    sql`${listLength(target)} + ${charCount(text)} <= ${MAX_RULES_TOTAL}`,
    target.scope === "customer" ? sql`exists (select 1 from ${csvCustomers} where ${csvCustomers.id} = ${target.customerId})` : undefined,
  )

/** 足す項目の行（一覧の末尾。位置は SQL の中で決めるので、同時に足しても並びが重ならない）。足せないときは行にならない */
function newItemRow(db: Db, target: RuleTarget, add: { id: string; text: string; source: RuleSource; caseId: string | null }, extra?: SQL) {
  return db
    .insert(csvRuleItems)
    .select(
      db
        .select({
          id: sql<string>`${add.id}`.as("id"),
          scope: sql<RuleScope>`${target.scope}`.as("scope"),
          customerId: sql<string | null>`${target.scope === "customer" ? target.customerId : null}`.as("customer_id"),
          text: sql<string>`${add.text}`.as("text"),
          position: sql<number>`(select coalesce(max(${csvRuleItems.position}), 0) + 1 from ${csvRuleItems} where ${inList(target)})`.as("position"),
          source: sql<RuleSource>`${add.source}`.as("source"),
          caseId: sql<string | null>`${add.caseId}`.as("case_id"),
          version: sql<number>`1`.as("version"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
          updatedAt: sql<Date>`${Date.now()}`.as("updated_at"),
        })
        .from(sql`(select 1)`)
        .where(and(canAdd(target, add.text), extra)),
    )
    .returning({ id: csvRuleItems.id })
}

const ownerMissing = async (db: Db, target: RuleTarget) => target.scope === "customer" && !(await getCustomer(db, target.customerId))

/** 職員が項目を末尾に足す。足した項目の id */
export async function addRuleItem(db: Db, target: RuleTarget, text: string): Promise<string> {
  const [added] = await newItemRow(db, target, { id: crypto.randomUUID(), text, source: "staff", caseId: null })
  if (added) return added.id
  throw (await ownerMissing(db, target)) ? new Error("顧客が見つかりません") : new RulesTooLongError()
}

/** 一覧の中の項目（ほかの一覧の id なら無いのと同じ） */
async function itemRow(db: Db, target: RuleTarget, id: string) {
  const [row] = await db.select().from(csvRuleItems).where(and(eq(csvRuleItems.id, id), inList(target)))
  return row
}

/** 項目の文章を直す。version は読んだときの版（ほかで直されていたら StaleRuleError。黙って上書きしない） */
export async function updateRuleItem(db: Db, target: RuleTarget, id: string, version: number, text: string) {
  if (!(await itemRow(db, target, id))) throw new StaleRuleError(null)
  const saved = await db
    .update(csvRuleItems)
    .set({ text, version: sql`${csvRuleItems.version} + 1`, updatedAt: new Date() })
    .where(and(eq(csvRuleItems.id, id), eq(csvRuleItems.version, version), sql`${listLength(target, id)} + ${charCount(text)} <= ${MAX_RULES_TOTAL}`))
    .returning({ id: csvRuleItems.id })
  if (saved.length) return
  const now = await itemRow(db, target, id)
  if (!now || now.version !== version) throw new StaleRuleError(now?.text ?? null)
  throw new RulesTooLongError()
}

/** 項目を消す。version は読んだときの版（ほかで直されていたら消さずに StaleRuleError。もう消えていれば何もしない） */
export async function deleteRuleItem(db: Db, target: RuleTarget, id: string, version: number) {
  const deleted = await db
    .delete(csvRuleItems)
    .where(and(eq(csvRuleItems.id, id), eq(csvRuleItems.version, version), inList(target)))
    .returning({ id: csvRuleItems.id })
  if (deleted.length) return
  const now = await itemRow(db, target, id)
  if (now) throw new StaleRuleError(now.text)
}

/**
 * 項目を1つ上・下の項目と入れ替える（今の並びで隣を決める。並べ替えは版を上げないので、隣の項目をほかの画面で直していても消し合わない）。
 * 端なら何もしない。入れ替える間にほかの画面が並びを変えたら、入れ替えずに StaleRuleError（並びを読み直してもう一度）
 */
export async function moveRuleItem(db: Db, target: RuleTarget, id: string, direction: "up" | "down") {
  const row = await itemRow(db, target, id)
  if (!row) throw new StaleRuleError(null)
  const [neighbor] = await db
    .select({ id: csvRuleItems.id, position: csvRuleItems.position })
    .from(csvRuleItems)
    .where(and(inList(target), direction === "up" ? lt(csvRuleItems.position, row.position) : gt(csvRuleItems.position, row.position)))
    .orderBy(direction === "up" ? desc(csvRuleItems.position) : asc(csvRuleItems.position))
    .limit(1)
  if (!neighbor) return
  // 2つの行の位置を1つの文で入れ替える（読んだときの位置のままの2行だけ）
  const unchanged = sql`(select count(*) from ${csvRuleItems} where (${csvRuleItems.id} = ${row.id} and ${csvRuleItems.position} = ${row.position}) or (${csvRuleItems.id} = ${neighbor.id} and ${csvRuleItems.position} = ${neighbor.position})) = 2`
  const swapped = await db
    .update(csvRuleItems)
    .set({ position: sql`case when ${csvRuleItems.id} = ${row.id} then ${neighbor.position} else ${row.position} end` })
    .where(and(inArray(csvRuleItems.id, [row.id, neighbor.id]), unchanged))
    .returning({ id: csvRuleItems.id })
  if (swapped.length !== 2) throw new StaleRuleError((await itemRow(db, target, id))?.text ?? null)
}

/**
 * 変更案の項目（proposalId・item）のルールの追記を、一度だけ項目として足す。足した印と項目を1つの処理（D1 の batch）で書くので、
 * 同じ項目を二度承認しても（保存前に開き直しても、同時に押しても）二度足さない。上限を超えるなら足さずに RulesTooLongError。
 * 足したら "added"、もう足してあれば "already"
 */
export async function appendRuleOnce(
  db: Db,
  target: RuleTarget,
  add: { caseId: string; proposalId: string; item: number; text: string; source: ProposedRuleSource },
): Promise<"added" | "already"> {
  const text = add.text
  const token = crypto.randomUUID()
  const mark = db
    .insert(csvRuleAppends)
    .select(
      db
        .select({
          proposalId: sql<string>`${add.proposalId}`.as("proposal_id"),
          item: sql<number>`${add.item}`.as("item"),
          caseId: sql<string>`${add.caseId}`.as("case_id"),
          token: sql<string>`${token}`.as("token"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
        })
        .from(sql`(select 1)`)
        .where(canAdd(target, text)),
    )
    .onConflictDoNothing()
  const marked = exists(
    db
      .select({ one: sql`1` })
      .from(csvRuleAppends)
      .where(and(eq(csvRuleAppends.proposalId, add.proposalId), eq(csvRuleAppends.item, add.item), eq(csvRuleAppends.token, token))),
  )
  const [, added] = await db.batch([mark, newItemRow(db, target, { id: crypto.randomUUID(), text, source: add.source, caseId: add.caseId }, marked)])
  if (added.length) return "added"
  const [already] = await db
    .select({ one: sql`1` })
    .from(csvRuleAppends)
    .where(and(eq(csvRuleAppends.proposalId, add.proposalId), eq(csvRuleAppends.item, add.item)))
  if (already) return "already"
  throw (await ownerMissing(db, target)) ? new Error("顧客が見つかりません") : new RulesTooLongError()
}

/** 一覧の項目の文章だけ（並びの順。AI に渡す） */
const itemTexts = (db: Db, target: RuleTarget) =>
  db.select({ text: csvRuleItems.text }).from(csvRuleItems).where(inList(target)).orderBy(asc(csvRuleItems.position), asc(csvRuleItems.createdAt), asc(csvRuleItems.id))

/** AI に渡すルールの文章（全体ルールと、顧客があればその顧客ルール）と事務所の設定 */
export async function rulesForAi(db: Db, customerId: string | null) {
  const [global, customer, settings] = await Promise.all([itemTexts(db, { scope: "global" }), customerId ? itemTexts(db, { scope: "customer", customerId }) : [], getSettings(db)])
  return { global: rulesText(global), customer: rulesText(customer), rule7Tax: settings.rule7Tax }
}

// ---- 案件 ----

export async function listCases(db: Db, customerId: string): Promise<(Case & { fileCount: number })[]> {
  const rows = await db
    .select({ kase: csvCases, fileCount: count(csvCaseFiles.id) })
    .from(csvCases)
    .leftJoin(csvCaseFiles, readyFileOf(csvCases.id))
    .where(eq(csvCases.customerId, customerId))
    .groupBy(csvCases.id)
    .orderBy(desc(csvCases.fiscalYear), desc(csvCases.createdAt))
  return rows.map((r) => ({ ...toCase(r.kase), fileCount: r.fileCount }))
}

export async function getCase(db: Db, id: string): Promise<Case | undefined> {
  const [row] = await db.select().from(csvCases).where(eq(csvCases.id, id))
  return row && toCase(row)
}

export async function createCase(db: Db, customerId: string, fiscalYear: number): Promise<Case> {
  const [row] = await db.insert(csvCases).values({ id: crypto.randomUUID(), customerId, fiscalYear }).returning()
  return toCase(row!)
}

/** 同じ顧客の前の年度の案件（いちばん近い年度。削除の途中のものは除く）。無ければ undefined */
export async function previousCase(db: Db, kase: Pick<Case, "customerId" | "fiscalYear">): Promise<Case | undefined> {
  const [row] = await db
    .select()
    .from(csvCases)
    .where(and(eq(csvCases.customerId, kase.customerId), lt(csvCases.fiscalYear, kase.fiscalYear), eq(csvCases.deleting, false)))
    .orderBy(desc(csvCases.fiscalYear), desc(csvCases.createdAt))
    .limit(1)
  return row && toCase(row)
}

/**
 * 消す前に、案件の会話を終える（AI に渡したファイルを消す）。先に削除の印を立てて新しい指示を始めさせず、全案件の会話を同時に終える。
 * どれかを終えられなければ（指示を処理している途中など）印を戻して投げる（案件は消さず、「削除の途中」のまま残さない）
 */
export async function endChatsBeforeDelete(db: Db, caseIds: readonly string[], endChat: (caseId: string) => Promise<unknown>) {
  if (!caseIds.length) return
  // 前の削除が途中で落ちた案件（もう R2 を消しかけている）は戻さない
  const fresh = (await db.select({ id: csvCases.id }).from(csvCases).where(and(inArray(csvCases.id, [...caseIds]), eq(csvCases.deleting, false)))).map((c) => c.id)
  if (fresh.length) await db.update(csvCases).set({ deleting: true }).where(inArray(csvCases.id, fresh))
  const ended = await Promise.allSettled(caseIds.map(endChat))
  const failed = ended.find((r) => r.status === "rejected")
  if (failed) {
    if (fresh.length) await db.update(csvCases).set({ deleting: false }).where(inArray(csvCases.id, fresh))
    throw failed.reason
  }
}

/** 使った費用を案件の合計に足す（同時に足しても失わないよう、SQL の中で足す） */
export async function addCaseCost(db: Db, id: string, usd: number) {
  await db.update(csvCases).set({ costUsd: sql`${csvCases.costUsd} + ${usd}` }).where(eq(csvCases.id, id))
}

export async function updateCaseStatus(db: Db, id: string, status: CaseStatus) {
  await db.update(csvCases).set({ status, updatedAt: new Date() }).where(eq(csvCases.id, id))
}

/** 置き終わったファイル（R2 に置いている途中の行は数えない・出さない） */
const readyFileOf = (caseId: typeof csvCases.id | string) => and(eq(csvCaseFiles.caseId, caseId), eq(csvCaseFiles.status, "ready"))

export async function listFiles(db: Db, caseId: string): Promise<CaseFile[]> {
  const rows = await db.select().from(csvCaseFiles).where(readyFileOf(caseId)).orderBy(csvCaseFiles.createdAt)
  return rows.map(toFile)
}

// ---- 案件の状態 ----

export async function getCaseState(db: Db, caseId: string): Promise<{ version: number; json: string; aiCache: string } | undefined> {
  const [row] = await db
    .select({ version: csvCaseStates.version, json: csvCaseStates.json, aiCache: csvCaseAiCaches.json })
    .from(csvCaseStates)
    .innerJoin(csvCaseAiCaches, eq(csvCaseAiCaches.id, csvCaseStates.aiCacheId))
    .where(eq(csvCaseStates.caseId, caseId))
  return row
}

/** 案件の作業の JSON だけ（AI の結果の大きい行は読まない） */
export async function getCaseWorkJson(db: Db, caseId: string): Promise<string | undefined> {
  const [row] = await db.select({ json: csvCaseStates.json }).from(csvCaseStates).where(eq(csvCaseStates.caseId, caseId))
  return row?.json
}

export type SaveResult = { ok: true; version: number } | { ok: false; reason: "conflict" | "gone" }

const refusal = async (db: Db, caseId: string): Promise<SaveResult> => ({ ok: false, reason: (await getCase(db, caseId))?.deleting === false ? "conflict" : "gone" })

/**
 * 状態を保存する。version は読んだときの版（まだ保存が無ければ 0）。別の画面が先に保存していたら conflict（上書きしない）。
 * 案件が無いか削除中なら gone（削除の後に行を残さない）。
 * aiCache は変わったときだけ渡す（最初の保存では必ず）。新しい行で足してから状態の行に指させ、保存できたら前の行を、できなければ足した行を消す
 */
export async function saveCaseState(db: Db, caseId: string, version: number, parts: { json: string; aiCache?: string }): Promise<SaveResult> {
  const next = version + 1
  const aiCacheId = parts.aiCache === undefined ? undefined : crypto.randomUUID()
  if (aiCacheId === undefined && version === 0) throw new Error("最初の保存には AI の結果も要ります")
  if (aiCacheId !== undefined) {
    const [added] = await db
      .insert(csvCaseAiCaches)
      .select(
        db
          .select({ id: sql<string>`${aiCacheId}`.as("id"), caseId: csvCases.id, json: sql<string>`${parts.aiCache}`.as("json"), createdAt: sql<Date>`${Date.now()}`.as("created_at") })
          .from(csvCases)
          .where(isLive(caseId)),
      )
      .returning({ id: csvCaseAiCaches.id })
    if (!added) return refusal(db, caseId)
  }
  const [previous] =
    version === 0 ? [] : await db.select({ aiCacheId: csvCaseStates.aiCacheId }).from(csvCaseStates).where(and(eq(csvCaseStates.caseId, caseId), eq(csvCaseStates.version, version)))
  const saved =
    version === 0
      ? await db
          .insert(csvCaseStates)
          .select(
            db
              .select({
                caseId: csvCases.id,
                version: sql<number>`${next}`.as("version"),
                json: sql<string>`${parts.json}`.as("json"),
                aiCacheId: sql<string>`${aiCacheId}`.as("ai_cache_id"),
                updatedAt: sql<Date>`${Date.now()}`.as("updated_at"),
              })
              .from(csvCases)
              .where(isLive(caseId)),
          )
          .onConflictDoNothing()
          .returning({ version: csvCaseStates.version })
      : await db
          .update(csvCaseStates)
          .set({ version: next, json: parts.json, aiCacheId, updatedAt: new Date() })
          .where(and(eq(csvCaseStates.caseId, caseId), eq(csvCaseStates.version, version), liveCase(db, caseId)))
          .returning({ version: csvCaseStates.version })
  if (!saved.length) {
    if (aiCacheId !== undefined) await db.delete(csvCaseAiCaches).where(eq(csvCaseAiCaches.id, aiCacheId))
    return refusal(db, caseId)
  }
  if (aiCacheId !== undefined && previous) await db.delete(csvCaseAiCaches).where(eq(csvCaseAiCaches.id, previous.aiCacheId))
  await db.update(csvCases).set({ updatedAt: new Date() }).where(eq(csvCases.id, caseId))
  return { ok: true, version: next }
}

// ---- ファイル ----

/**
 * ファイルを付ける。案件が無いか削除中なら undefined（R2 にも行にも何も残さない）。
 * 行を「置いている途中」で先に足し（削除中の案件には足せない）、R2 に置き、案件がまだ削除中でなければ「置き終わった」にする。
 * 置いている間に削除が始まったら、置いたものを自分で消す。削除の側は R2 を案件のキーの頭で消すので、どちらの順で進んでも R2 に残らない
 */
export async function addFile(
  db: Db,
  bucket: Bucket,
  caseId: string,
  file: { kind: FileKind; name: string; contentType: string; body: ReadableStream | ArrayBuffer | Uint8Array },
): Promise<CaseFile | undefined> {
  const id = crypto.randomUUID()
  const r2Key = r2KeyOf(caseId, id)
  const [pending] = await db
    .insert(csvCaseFiles)
    .select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          caseId: csvCases.id,
          kind: sql<FileKind>`${file.kind}`.as("kind"),
          name: sql<string>`${file.name}`.as("name"),
          contentType: sql<string>`${file.contentType}`.as("content_type"),
          size: sql<number>`0`.as("size"),
          status: sql<"pending">`'pending'`.as("status"),
          r2Key: sql<string>`${r2Key}`.as("r2_key"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
        })
        .from(csvCases)
        .where(isLive(caseId)),
    )
    .returning({ id: csvCaseFiles.id })
  if (!pending) return undefined
  const forget = async () => {
    await bucket.delete([r2Key])
    await db.delete(csvCaseFiles).where(eq(csvCaseFiles.id, id))
  }
  let size: number
  try {
    const object = await bucket.put(r2Key, file.body, { httpMetadata: { contentType: file.contentType } })
    size = object!.size
  } catch (e) {
    await forget()
    throw e
  }
  const [ready] = await db
    .update(csvCaseFiles)
    .set({ status: "ready", size })
    .where(and(eq(csvCaseFiles.id, id), liveCase(db, caseId)))
    .returning()
  if (ready) return toFile(ready)
  await forget()
  return undefined
}

/** 置き終わったファイルの行 */
export async function getFileRow(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(csvCaseFiles)
    .where(and(eq(csvCaseFiles.id, id), eq(csvCaseFiles.status, "ready")))
  return row
}

// ---- 削除（何度実行しても、途中で落ちた後でも、最後には何も残らない） ----

export async function deletionCounts(db: Db, target: { customerId: string } | { caseId: string }): Promise<DeletionCounts> {
  const where = "caseId" in target ? eq(csvCases.id, target.caseId) : eq(csvCases.customerId, target.customerId)
  const [row] = await db
    .select({ cases: sql<number>`count(distinct ${csvCases.id})`, files: count(csvCaseFiles.id) })
    .from(csvCases)
    .leftJoin(csvCaseFiles, readyFileOf(csvCases.id))
    .where(where)
  return { cases: row?.cases ?? 0, files: row?.files ?? 0 }
}

async function deleteObjects(bucket: Bucket, prefix: string) {
  for (;;) {
    const page = await bucket.list({ prefix })
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key))
    if (!page.truncated) return
  }
}

/**
 * 削除中の印 → R2 → ファイルの行 → 状態 → AI の結果 → 工事場所の調査の回 → 案件 の順。印を立てた後はファイルも状態も足せないので、R2 を消した後に増えない。
 * 工事場所の調査の裏の処理は、印を見てから AI を呼び、結果も費用も案件の行が無ければ書かない（変更案を置いたあとに印を見て消す）ので、走っていても残らない。
 * 顧客ごとに覚えた工事場所は顧客のものなので残す（顧客の削除で消す）。
 * 案件の行がもう無くても R2 はキーの頭で消す（前の削除が R2 の途中で落ちた・置いている途中のファイルが残った場合）
 */
export async function deleteCase(db: Db, bucket: Bucket, caseId: string) {
  await db.update(csvCases).set({ deleting: true }).where(eq(csvCases.id, caseId))
  await deleteObjects(bucket, casePrefix(caseId))
  await db.delete(csvCaseFiles).where(eq(csvCaseFiles.caseId, caseId))
  await db.delete(csvCaseStates).where(eq(csvCaseStates.caseId, caseId))
  await db.delete(csvCaseAiCaches).where(eq(csvCaseAiCaches.caseId, caseId))
  await db.delete(csvRuleAppends).where(eq(csvRuleAppends.caseId, caseId))
  // ルールの項目は残す（由来の案件だけ外す）
  await db.update(csvRuleItems).set({ caseId: null }).where(eq(csvRuleItems.caseId, caseId))
  await deleteRunsOfCase(db, caseId)
  await db.delete(csvCases).where(eq(csvCases.id, caseId))
}

export async function deleteCustomer(db: Db, bucket: Bucket, customerId: string) {
  const cases = await db.select({ id: csvCases.id }).from(csvCases).where(eq(csvCases.customerId, customerId))
  for (const c of cases) await deleteCase(db, bucket, c.id)
  await deleteMemoryOfCustomer(db, customerId)
  // 顧客ルールの項目と顧客の行を1つの処理で消す（消している間にチャットの承認で足した項目も残らない。足すのは顧客の行があるときだけ）
  await db.batch([
    db.delete(csvRuleItems).where(and(eq(csvRuleItems.scope, "customer"), eq(csvRuleItems.customerId, customerId))),
    db.delete(csvCustomers).where(eq(csvCustomers.id, customerId)),
  ])
}

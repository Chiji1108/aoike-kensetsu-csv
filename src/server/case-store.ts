import { and, count, desc, eq, exists, inArray, lt, sql } from "drizzle-orm"
import type { BatchItem, BatchResponse } from "drizzle-orm/batch"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import { csvCaseAiCaches, csvCaseFiles, csvCases, csvCaseStates, csvCustomers, csvRuleAppends, csvRules } from "@/db/cases-schema"
import type * as schema from "@/db/schema"
import { DEFAULT_GLOBAL_RULES } from "@/lib/chat/rules"
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

const GLOBAL_RULES_ID = "global"

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

export async function getCustomer(db: Db, id: string): Promise<Customer | undefined> {
  const [row] = await db.select().from(csvCustomers).where(eq(csvCustomers.id, id))
  return row && toCustomer(row)
}

export async function createCustomer(db: Db, name: string): Promise<Customer> {
  const [row] = await db.insert(csvCustomers).values({ id: crypto.randomUUID(), name }).returning()
  return toCustomer(row!)
}

export async function updateCustomer(db: Db, id: string, patch: Partial<Pick<Customer, "name" | "formatNote">>) {
  await db.update(csvCustomers).set({ ...patch, updatedAt: new Date() }).where(eq(csvCustomers.id, id))
}

// ---- 全体ルール ----

/** 全体ルール。まだ保存していなければ初期値（事務所のやり方の下書き） */
export async function getRules(db: Db): Promise<string> {
  const [row] = await db.select().from(csvRules).where(eq(csvRules.id, GLOBAL_RULES_ID))
  return row?.rules ?? DEFAULT_GLOBAL_RULES
}

/** ルールの文章を、読んだときの文章（previous）のままなら書き換える。ほかの画面・チャットの追記で変わっていたら StaleTextError */
export class StaleTextError extends Error {
  constructor() {
    super("ほかの画面でこの文章が変わりました。再読み込みしてから直してください（今の入力は消えます）")
  }
}

/** まだ行が無ければ初期値の行を作る（読み書きのどちらも、保存した文章を相手にする） */
const ensureRulesRow = (db: Db) => db.insert(csvRules).values({ id: GLOBAL_RULES_ID, rules: DEFAULT_GLOBAL_RULES }).onConflictDoNothing()

export async function saveRules(db: Db, rules: string, previous: string) {
  await ensureRulesRow(db)
  const saved = await db
    .update(csvRules)
    .set({ rules, updatedAt: new Date() })
    .where(and(eq(csvRules.id, GLOBAL_RULES_ID), eq(csvRules.rules, previous)))
    .returning({ id: csvRules.id })
  if (!saved.length) throw new StaleTextError()
}

/** 末尾に1行足した文章（SQL の中で作るので、同時に足してもほかの画面で保存しても消えない。空なら足すものだけ） */
const appended = (column: typeof csvRules.rules | typeof csvCustomers.rules, text: string) =>
  sql`case when trim(${column}, ' ' || char(10) || char(13)) = '' then ${text} else rtrim(${column}, ' ' || char(10) || char(13)) || char(10) || ${text} end`

/** 全体ルール・顧客ルールの長さの上限（画面から保存できる長さと同じ） */
export const MAX_RULES_LENGTH = 20_000

export class RulesTooLongError extends Error {
  constructor() {
    super(`ルールが長すぎて追記できません（${MAX_RULES_LENGTH.toLocaleString("ja-JP")}字まで）。ルールを短くしてから承認してください`)
  }
}

export type RuleTarget = { scope: "global" } | { scope: "customer"; customerId: string }

/**
 * 変更案の項目（proposalId・item）のルールの追記を、一度だけ足す。足した印と追記を1つの処理（D1 の batch）で書くので、
 * 同じ項目を二度承認しても（保存前に開き直しても、同時に押しても）二度足さない。長さの上限を超えるなら足さずに RulesTooLongError。
 * 足したら "added"、もう足してあれば "already"
 */
export async function appendRuleOnce(db: Db, target: RuleTarget, add: { caseId: string; proposalId: string; item: number; text: string }): Promise<"added" | "already"> {
  if (target.scope === "global") await ensureRulesRow(db)
  const text = add.text.trim()
  const token = crypto.randomUUID()
  const table = target.scope === "global" ? csvRules : csvCustomers
  const whereTarget = target.scope === "global" ? eq(csvRules.id, GLOBAL_RULES_ID) : eq(csvCustomers.id, target.customerId)
  const fits = sql`length(${appended(table.rules, text)}) <= ${MAX_RULES_LENGTH}`
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
        .from(table)
        .where(and(whereTarget, fits)),
    )
    .onConflictDoNothing()
  const marked = exists(
    db
      .select({ one: sql`1` })
      .from(csvRuleAppends)
      .where(and(eq(csvRuleAppends.proposalId, add.proposalId), eq(csvRuleAppends.item, add.item), eq(csvRuleAppends.token, token))),
  )
  const update = db
    .update(table)
    .set({ rules: appended(table.rules, text), updatedAt: new Date() })
    .where(and(whereTarget, marked))
    .returning({ id: table.id })
  const [, updated] = await db.batch([mark, update])
  if (updated.length) return "added"
  const [already] = await db
    .select({ one: sql`1` })
    .from(csvRuleAppends)
    .where(and(eq(csvRuleAppends.proposalId, add.proposalId), eq(csvRuleAppends.item, add.item)))
  if (already) return "already"
  const [found] = await db.select({ id: table.id }).from(table).where(whereTarget)
  throw found ? new RulesTooLongError() : new Error("顧客が見つかりません")
}

export async function saveCustomerRules(db: Db, id: string, rules: string, previous: string) {
  const saved = await db
    .update(csvCustomers)
    .set({ rules, updatedAt: new Date() })
    .where(and(eq(csvCustomers.id, id), eq(csvCustomers.rules, previous)))
    .returning({ id: csvCustomers.id })
  if (!saved.length) throw (await getCustomer(db, id)) ? new StaleTextError() : new Error("顧客が見つかりません")
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
  await deleteRunsOfCase(db, caseId)
  await db.delete(csvCases).where(eq(csvCases.id, caseId))
}

export async function deleteCustomer(db: Db, bucket: Bucket, customerId: string) {
  const cases = await db.select({ id: csvCases.id }).from(csvCases).where(eq(csvCases.customerId, customerId))
  for (const c of cases) await deleteCase(db, bucket, c.id)
  await deleteMemoryOfCustomer(db, customerId)
  await db.delete(csvCustomers).where(eq(csvCustomers.id, customerId))
}

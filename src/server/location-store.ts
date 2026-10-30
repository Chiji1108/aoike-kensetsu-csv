import { and, count, desc, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { csvCases, csvCustomers, csvLocationMemory, csvLocationRuns, csvLocationSites } from "@/db/cases-schema"
import { tryParseJson } from "@/lib/json"
import { MAX_SITES_PER_RUN, normalizeOutcome, outcomeSchema, siteKeyOf, siteRefSchema, type Found, type Outcome, type Site } from "@/lib/location/sites"
import { z } from "zod"
import type { Db } from "./case-store"

/**
 * 工事場所の調査の読み書き（D1）。回（csv_location_runs）・現場（csv_location_sites）・顧客ごとに覚えた結果（csv_location_memory）。
 * D1 でも bun:sqlite でも動く（テストは bun:sqlite）
 */

export const siteSchema: z.ZodType<Site> = siteRefSchema.extend({
  rowKeys: z.array(z.string().min(1).max(200)).min(1).max(20_000),
  knowledgeTried: z.boolean(),
  skip: z.enum(["personal", "empty"]).optional(),
})


/** 外に送ってよい現場か（個人名の印が無く、工事名か注文者がある）。送る前と覚える前に、受け取った値でもう一度確かめる */
export const searchable = (s: Pick<Site, "skip" | "workName" | "client">) => !s.skip && (s.workName !== "" || s.client !== "")

// ---- 覚えた結果 ----

/** 顧客の覚えた結果のうち keys の現場のもの */
export async function memorized(db: Db, customerId: string, keys: readonly string[]): Promise<Map<string, Found>> {
  const out = new Map<string, Found>()
  const unique = [...new Set(keys)]
  // D1 の1つの文に入れられる値の数（100）を超えないように分ける
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db
      .select()
      .from(csvLocationMemory)
      .where(and(eq(csvLocationMemory.customerId, customerId), inArray(csvLocationMemory.siteKey, unique.slice(i, i + 90))))
    for (const r of rows) {
      const urls = z.array(z.string()).safeParse(tryParseJson(r.urls))
      out.set(r.siteKey, { prefecture: r.prefecture, place: r.place, urls: urls.success ? urls.data : [], source: "memory", confident: r.confident, note: r.note })
    }
  }
  return out
}

export type Remember = { site: { workName: string; client: string }; found: Found }

/**
 * 承認した工事場所を顧客の覚えた結果に書く（同じ現場は上書き）。案件が削除中でなく、その顧客の案件のときだけ書く（削除のあとに行を残さない）。
 * 現場の key は受け取った工事名・注文者から作り直す。書けたら件数
 */
export async function remember(db: Db, caseId: string, items: readonly Remember[]): Promise<number> {
  const writes = items
    .filter(({ site }) => searchable({ ...site }))
    .map(({ site, found }) => {
      const siteKey = siteKeyOf(site.workName, site.client)
      const source = found.source === "memory" ? "search" : found.source
      return db
        .insert(csvLocationMemory)
        .select(
          db
            .select({
              customerId: csvCases.customerId,
              siteKey: sql<string>`${siteKey}`.as("site_key"),
              workName: sql<string>`${site.workName}`.as("work_name"),
              client: sql<string>`${site.client}`.as("client"),
              prefecture: sql<string>`${found.prefecture}`.as("prefecture"),
              place: sql<string>`${found.place}`.as("place"),
              urls: sql<string>`${JSON.stringify(found.urls)}`.as("urls"),
              source: sql<string>`${source}`.as("source"),
              confident: sql<boolean>`${found.confident ? 1 : 0}`.as("confident"),
              note: sql<string>`${found.note}`.as("note"),
              caseId: csvCases.id,
              updatedAt: sql<Date>`${Date.now()}`.as("updated_at"),
            })
            .from(csvCases)
            .innerJoin(csvCustomers, eq(csvCustomers.id, csvCases.customerId))
            .where(and(eq(csvCases.id, caseId), eq(csvCases.deleting, false))),
        )
        .onConflictDoUpdate({
          target: [csvLocationMemory.customerId, csvLocationMemory.siteKey],
          // 前の年度の結果をそのまま承認したときは、もとの調べ方を残す
          set: {
            prefecture: sql`excluded.prefecture`,
            place: sql`excluded.place`,
            urls: sql`excluded.urls`,
            source: found.source === "memory" ? sql`${csvLocationMemory.source}` : sql`excluded.source`,
            confident: sql`excluded.confident`,
            note: sql`excluded.note`,
            caseId: sql`excluded.case_id`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ key: csvLocationMemory.siteKey })
    })
  // 1つの処理（D1 の batch）で書く（途中で落ちて一部だけ覚えることが無いように）
  const [first, ...rest] = writes
  if (!first) return 0
  const results = await db.batch([first, ...rest])
  return results.reduce((n, rows) => n + rows.length, 0)
}

export async function deleteMemoryOfCustomer(db: Db, customerId: string) {
  await db.delete(csvLocationMemory).where(eq(csvLocationMemory.customerId, customerId))
}

// ---- 一括調査の回 ----

export type Run = typeof csvLocationRuns.$inferSelect
export type RunProgress = Pick<Run, "id" | "status" | "total" | "searches" | "usd" | "proposalId" | "error" | "stopRequested"> & { done: number; createdAt: number }

export type CreateRun = { ok: true; run: Run } | { ok: false; reason: "busy" | "gone" | "tooMany" }

/**
 * 回を作る。案件が削除中でなく、走っている回が無いときだけ（部分一意索引。2つのタブから同時に始めても1つだけ）。
 * 現場は回と同じ処理（D1 の batch）で足す（途中で落ちて現場の無い回が残らないように）
 */
export async function createRun(db: Db, caseId: string, sites: readonly Site[]): Promise<CreateRun> {
  if (!sites.length || sites.length > MAX_SITES_PER_RUN) return { ok: false, reason: "tooMany" }
  const id = crypto.randomUUID()
  const insertRun = db
    .insert(csvLocationRuns)
    .select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          caseId: csvCases.id,
          customerId: csvCases.customerId,
          status: sql<"running">`'running'`.as("status"),
          total: sql<number>`${sites.length}`.as("total"),
          searches: sql<number>`0`.as("searches"),
          usd: sql<number>`0`.as("usd"),
          stopRequested: sql<boolean>`0`.as("stop_requested"),
          proposalId: sql<null>`null`.as("proposal_id"),
          error: sql<null>`null`.as("error"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
          updatedAt: sql<Date>`${Date.now()}`.as("updated_at"),
        })
        .from(csvCases)
        .where(and(eq(csvCases.id, caseId), eq(csvCases.deleting, false))),
    )
    .onConflictDoNothing()
    .returning()
  // 現場の行は、回の行が入ったときだけ足す（同じ処理の中で回の行から選ぶので、回の行が無ければ何も足さない）
  const insertSites = sites.map((s, idx) =>
    db
      .insert(csvLocationSites)
      .select(
        db
          .select({ runId: sql<string>`${id}`.as("run_id"), idx: sql<number>`${idx}`.as("idx"), site: sql<string>`${JSON.stringify(s)}`.as("site"), outcome: sql<null>`null`.as("outcome") })
          .from(csvLocationRuns)
          .where(eq(csvLocationRuns.id, id)),
      ),
  )
  const [[run]] = await db.batch([insertRun, ...insertSites])
  if (run) return { ok: true, run }
  const kase = await db.select({ deleting: csvCases.deleting }).from(csvCases).where(eq(csvCases.id, caseId))
  return { ok: false, reason: kase[0] && !kase[0].deleting ? "busy" : "gone" }
}

export async function getRun(db: Db, runId: string): Promise<Run | undefined> {
  const [row] = await db.select().from(csvLocationRuns).where(eq(csvLocationRuns.id, runId))
  return row
}

/** 案件のいちばん新しい回と進み具合（調べ終えた現場の数） */
export async function latestRun(db: Db, caseId: string): Promise<RunProgress | undefined> {
  const [run] = await db.select().from(csvLocationRuns).where(eq(csvLocationRuns.caseId, caseId)).orderBy(desc(csvLocationRuns.createdAt)).limit(1)
  if (!run) return undefined
  const [done] = await db.select({ n: count() }).from(csvLocationSites).where(and(eq(csvLocationSites.runId, run.id), isNotNull(csvLocationSites.outcome)))
  return { id: run.id, status: run.status, total: run.total, searches: run.searches, usd: run.usd, proposalId: run.proposalId, error: run.error, stopRequested: run.stopRequested, done: done?.n ?? 0, createdAt: run.createdAt.getTime() }
}

export type RunSite = { idx: number; site: Site; outcome: Outcome | null }

/**
 * 現場の行を読む。結果が読めない行はその現場だけ「調べられなかった」として読む（1件の不正で回全体を読めなくしない）。
 * 現場そのもの（書くときに確かめた値）が読めない行は飛ばし、ログに残す
 */
function readSite(r: typeof csvLocationSites.$inferSelect): RunSite | undefined {
  const site = siteSchema.safeParse(tryParseJson(r.site))
  if (!site.success) {
    console.error("工事場所の調査の現場を読めませんでした", r.runId, r.idx)
    return undefined
  }
  if (r.outcome === null) return { idx: r.idx, site: site.data, outcome: null }
  const outcome = outcomeSchema.safeParse(tryParseJson(r.outcome))
  return { idx: r.idx, site: site.data, outcome: outcome.success ? outcome.data : { kind: "failed", note: "調べた結果を読めませんでした" } }
}

/** 回の現場（番号の順） */
export async function runSites(db: Db, runId: string): Promise<RunSite[]> {
  const rows = await db.select().from(csvLocationSites).where(eq(csvLocationSites.runId, runId)).orderBy(csvLocationSites.idx)
  return rows.flatMap((r) => readSite(r) ?? [])
}

/** 回の現場を1つ（検索の step が読む） */
export async function runSite(db: Db, runId: string, idx: number): Promise<RunSite | undefined> {
  const [row] = await db
    .select()
    .from(csvLocationSites)
    .where(and(eq(csvLocationSites.runId, runId), eq(csvLocationSites.idx, idx)))
  return row && readSite(row)
}

const outcomeUpdate = (db: Db, runId: string, idx: number, outcome: Outcome) =>
  db
    .update(csvLocationSites)
    // 書く前にそろえて確かめる（読むときと同じ形。長い答えはその現場だけ「調べられなかった」）
    .set({ outcome: JSON.stringify(outcomeSchema.parse(normalizeOutcome(outcome))) })
    .where(and(eq(csvLocationSites.runId, runId), eq(csvLocationSites.idx, idx), isNull(csvLocationSites.outcome)))
    .returning({ idx: csvLocationSites.idx })

/** 現場の結果を書く（まだ書いていないときだけ。やり直した処理が前の結果を上書きしない）。書けたら true */
export async function recordOutcome(db: Db, runId: string, idx: number, outcome: Outcome): Promise<boolean> {
  return (await outcomeUpdate(db, runId, idx, outcome)).length > 0
}

/** いくつもの現場の結果を1つの処理で書く（覚えた結果・知識の答え） */
export async function recordOutcomes(db: Db, runId: string, items: readonly { idx: number; outcome: Outcome }[]) {
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50)
    const [first, ...rest] = chunk.map((x) => outcomeUpdate(db, runId, x.idx, x.outcome))
    if (first) await db.batch([first, ...rest])
  }
}

/**
 * 使った費用と Web 検索の回数を、回と案件に足す（呼んだたびに。失敗してやり直した呼び出しも費用はかかっている）。
 * 案件の行がもう無ければ足さない（SQL の中で足すので同時に足しても失わない）
 */
export async function charge(db: Db, runId: string, caseId: string, usd: number, searches: number) {
  if (usd <= 0 && searches <= 0) return
  await db.batch([
    db
      .update(csvLocationRuns)
      .set({ usd: sql`${csvLocationRuns.usd} + ${usd}`, searches: sql`${csvLocationRuns.searches} + ${searches}`, updatedAt: new Date() })
      .where(eq(csvLocationRuns.id, runId)),
    db.update(csvCases).set({ costUsd: sql`${csvCases.costUsd} + ${usd}` }).where(eq(csvCases.id, caseId)),
  ])
}

/** 回を終える（走っている回だけ）。proposalId は置いた変更案（変更の無い回は null） */
export async function finishRun(db: Db, runId: string, proposalId: string | null) {
  await db
    .update(csvLocationRuns)
    .set({ status: sql`case when ${csvLocationRuns.stopRequested} then 'stopped' else 'done' end`, proposalId, updatedAt: new Date() })
    .where(and(eq(csvLocationRuns.id, runId), eq(csvLocationRuns.status, "running")))
}

export async function failRun(db: Db, runId: string, error: string) {
  await db
    .update(csvLocationRuns)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(csvLocationRuns.id, runId), eq(csvLocationRuns.status, "running")))
}

/** 止める印を立てる（走っている回で、案件が削除中でないときだけ）。裏の処理は次の現場に進む前に見て、調べ終えた分で変更案を出す */
export async function requestStop(db: Db, caseId: string, runId: string) {
  const live = exists(db.select({ one: sql`1` }).from(csvCases).where(and(eq(csvCases.id, caseId), eq(csvCases.deleting, false))))
  const rows = await db
    .update(csvLocationRuns)
    .set({ stopRequested: true, updatedAt: new Date() })
    .where(and(eq(csvLocationRuns.id, runId), eq(csvLocationRuns.caseId, caseId), eq(csvLocationRuns.status, "running"), live))
    .returning({ id: csvLocationRuns.id })
  return rows.length > 0
}

/** 裏の処理が続けてよいか: 回が走っていて止める印が無く、案件が削除中でない */
export async function shouldContinue(db: Db, runId: string): Promise<"go" | "stop" | "gone"> {
  const [row] = await db
    .select({ status: csvLocationRuns.status, stop: csvLocationRuns.stopRequested, deleting: csvCases.deleting })
    .from(csvLocationRuns)
    .leftJoin(csvCases, eq(csvCases.id, csvLocationRuns.caseId))
    .where(eq(csvLocationRuns.id, runId))
  if (!row || row.deleting !== false || row.status !== "running") return "gone"
  return row.stop ? "stop" : "go"
}

/** 案件の走っている回の id（削除の前に Workflow を止める） */
export async function runningRunIds(db: Db, caseIds: readonly string[]): Promise<string[]> {
  if (!caseIds.length) return []
  const rows = await db
    .select({ id: csvLocationRuns.id })
    .from(csvLocationRuns)
    .where(and(inArray(csvLocationRuns.caseId, [...caseIds]), eq(csvLocationRuns.status, "running")))
  return rows.map((r) => r.id)
}

/** 案件の回と現場の行を消す（案件の削除。覚えた結果は顧客のものなので残す） */
export async function deleteRunsOfCase(db: Db, caseId: string) {
  const runs = db.select({ id: csvLocationRuns.id }).from(csvLocationRuns).where(eq(csvLocationRuns.caseId, caseId))
  await db.delete(csvLocationSites).where(inArray(csvLocationSites.runId, runs))
  await db.delete(csvLocationRuns).where(eq(csvLocationRuns.caseId, caseId))
}

import { newProposal, type ProposalRecord } from "@/lib/chat/proposals"
import type { AnonymizeCaller } from "@/lib/chat/turn"
import { outcomeChanges } from "@/lib/location/changes"
import type { PlaceIndex } from "@/lib/location/check"
import { normalizeOutcome, type Found, type Outcome, type Site } from "@/lib/location/sites"
import type { Db } from "./case-store"
import { KNOWLEDGE_CHUNK, knowLocations, searchFailure, type Spent } from "./location"
import * as loc from "./location-store"

/**
 * 一括調査の手順（Cloudflare Workflows の run から呼ぶ。テストは決まった応答と、その場で実行する step で回す）。
 * 1. 覚えた結果と、調べない現場（個人名・空）を書く  2. AI の知識（変換で推定していない現場だけ）  3. 残りを Web 検索（現場ごとの step、失敗は自動でやり直す）
 * 4. 結果を変更案にして R2 に置き、回を終える。各 step は D1 の印（止める・削除中）を見てから AI を呼ぶ。結果は書いていない現場にだけ書く（やり直しで上書きしない）
 */

/** Workflows の step のうち使うところ */
export type StepLike = {
  do<T>(name: string, config: { retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" }; timeout?: string | number }, fn: () => Promise<T>): Promise<T>
}

export type RunDeps = {
  db: Db
  index: PlaceIndex
  knowledge: AnonymizeCaller
  search: (site: Site, spent: Spent) => Promise<Outcome>
  putProposal: (caseId: string, record: ProposalRecord) => Promise<void>
  deleteProposal: (caseId: string, proposalId: string) => Promise<void>
}

/** 同時に検索する現場の数（API の混み具合に合わせて少なめ） */
export const SEARCH_CONCURRENCY = 4
const SEARCH_STEP = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" as const }, timeout: "5 minutes" }
const DB_STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" as const } }

export async function runLocationSearch(deps: RunDeps, step: StepLike, { runId, caseId }: { runId: string; caseId: string }) {
  const { db } = deps

  await step.do("memory", DB_STEP, async () => {
    if ((await loc.shouldContinue(db, runId)) === "gone") return
    const run = await loc.getRun(db, runId)
    const pending = (await loc.runSites(db, runId)).filter((s) => s.outcome === null)
    const memory = run ? await loc.memorized(db, run.customerId, pending.filter((s) => loc.searchable(s.site)).map((s) => s.site.key)) : new Map<string, Found>()
    await loc.recordOutcomes(
      db,
      runId,
      pending.flatMap((s): { idx: number; outcome: Outcome }[] => {
        if (!loc.searchable(s.site)) return [{ idx: s.idx, outcome: { kind: "skipped", skip: s.site.skip ?? "empty" } }]
        const found = memory.get(s.site.key)
        return found ? [{ idx: s.idx, outcome: { kind: "found", ...found } }] : []
      }),
    )
  })

  // AI の知識: 変換で推定していない現場を KNOWLEDGE_CHUNK 件ずつ聞く。やり直しても答えが得られなければ、その分は飛ばして検索に回す（回全体は止めない）
  const unknown = await step.do("knowledge-list", DB_STEP, async () =>
    (await loc.shouldContinue(db, runId)) === "go" ? (await loc.runSites(db, runId)).filter((s) => s.outcome === null && !s.site.knowledgeTried).map((s) => s.idx) : [],
  )
  for (let i = 0; i < unknown.length; i += KNOWLEDGE_CHUNK) {
    const chunk = new Set(unknown.slice(i, i + KNOWLEDGE_CHUNK))
    try {
      await step.do(`knowledge-${i}`, SEARCH_STEP, async () => {
        if ((await loc.shouldContinue(db, runId)) !== "go") return
        const asked = (await loc.runSites(db, runId)).filter((s) => chunk.has(s.idx) && s.outcome === null)
        if (!asked.length) return
        const known = await knowLocations(
          async (req) => {
            const res = await deps.knowledge(req)
            await loc.charge(db, runId, caseId, res.usd, 0)
            return res
          },
          deps.index,
          asked.map((s) => s.site),
        )
        await loc.recordOutcomes(
          db,
          runId,
          asked.flatMap((s) => {
            const found = known.found.get(s.site.key)
            return found ? [{ idx: s.idx, outcome: { kind: "found" as const, ...found } }] : []
          }),
        )
        // 答えが得られなかったら投げてやり直す（費用は足してある）
        if (known.failure) throw new Error(known.failure)
      })
    } catch {
      // 知識の段は飛ばして検索へ
    }
  }

  const pending = await step.do("pending", DB_STEP, async () => ((await loc.shouldContinue(db, runId)) === "go" ? (await loc.runSites(db, runId)).filter((s) => s.outcome === null).map((s) => s.idx) : []))
  for (let i = 0; i < pending.length; i += SEARCH_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + SEARCH_CONCURRENCY).map((idx) => searchOne(deps, step, runId, caseId, idx)))
  }

  await step.do("finish", DB_STEP, async () => {
    if ((await loc.shouldContinue(db, runId)) === "gone") return
    const sites = await loc.runSites(db, runId)
    const outcomes = new Map(sites.flatMap((s) => (s.outcome ? [[s.site.key, s.outcome] as const] : [])))
    const changes = outcomeChanges(
      sites.map((s) => s.site),
      outcomes,
    )
    if (changes.length) {
      // 変更案の id は回の id（やり直しても同じ記録を置き直すだけ）
      await deps.putProposal(caseId, { proposal: newProposal(runId, { kind: "location", runId }, changes, null), changes })
      // 置いている間に削除が始まっていたら、置いたものを消す（削除の後に R2 に残さない）
      if ((await loc.shouldContinue(db, runId)) === "gone") {
        await deps.deleteProposal(caseId, runId)
        return
      }
    }
    await loc.finishRun(db, runId, changes.length ? runId : null)
  })
}

/** 1つの現場を Web 検索で調べる step。やり直しても調べ終えなければ、その現場を「調べられなかった」にする（ほかの現場は続ける） */
async function searchOne(deps: RunDeps, step: StepLike, runId: string, caseId: string, idx: number) {
  const { db } = deps
  try {
    await step.do(`search-${idx}`, SEARCH_STEP, async () => {
      if ((await loc.shouldContinue(db, runId)) !== "go") return
      const s = await loc.runSite(db, runId, idx)
      if (!s || s.outcome) return
      const spent: Spent = { usd: 0, searches: 0 }
      let outcome: Outcome
      try {
        outcome = await deps.search(s.site, spent)
      } catch (e) {
        // 費用は失敗した回の分も足す。誤りの説明は決まった文にする（Workflows を通ると誤りの種類が失われる）
        throw new Error(searchFailure(e))
      } finally {
        await loc.charge(db, runId, caseId, spent.usd, spent.searches)
      }
      await loc.recordOutcome(db, runId, idx, outcome)
    })
  } catch (e) {
    const note = e instanceof Error ? e.message : "AI の呼び出しに失敗しました"
    await step.do(`failed-${idx}`, DB_STEP, () => loc.recordOutcome(db, runId, idx, { kind: "failed", note }))
  }
}

/**
 * チャットの「この現場ってどこ？」の1件: 覚えた結果 → AI の知識（変換で推定していなければ）→ Web 検索。費用は spent に足す（呼び出し側が案件に足す）
 */
export async function locateOne(
  deps: Pick<RunDeps, "index" | "knowledge" | "search"> & { memorized: (keys: string[]) => Promise<ReadonlyMap<string, Found>> },
  site: Site,
  spent: Spent,
): Promise<Outcome> {
  // 変更案にする前に、D1 に書くときと同じ形にそろえる（長い答えで変更案の記録が読めなくならないように）
  return normalizeOutcome(await locate(deps, site, spent))
}

async function locate(deps: Parameters<typeof locateOne>[0], site: Site, spent: Spent): Promise<Outcome> {
  if (!loc.searchable(site)) return { kind: "skipped", skip: site.skip ?? "empty" }
  const memory = (await deps.memorized([site.key])).get(site.key)
  if (memory) return { kind: "found", ...memory }
  if (!site.knowledgeTried) {
    const known = await knowLocations(
      async (req) => {
        const res = await deps.knowledge(req)
        spent.usd += res.usd
        return res
      },
      deps.index,
      [site],
    )
    const found = known.found.get(site.key)
    if (found) return { kind: "found", ...found }
  }
  return deps.search(site, spent)
}

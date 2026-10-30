import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { AiBatchRequest } from "@/lib/convert/ai-tasks"
import type { ProposalRecord } from "@/lib/chat/proposals"
import { jaSchema, placeIndex } from "@/lib/location/check"
import type { Outcome, Site } from "@/lib/location/sites"
import { siteKeyOf } from "@/lib/location/sites"
import type { AnonymizeCaller } from "@/lib/chat/turn"
import { createCase, createCustomer, deleteCase, deleteCustomer, getCase, saveCaseState, type Bucket, type Db } from "../case-store"
import { personalChecker } from "../location-guard"
import { newWork, toSavedWork } from "@/lib/cases/state"
import { aiKey } from "@/lib/convert/convert"
import { guardPersonal } from "@/lib/location/sites"
import { locateOne, runLocationSearch, type RunDeps, type StepLike } from "../location-run"
import * as loc from "../location-store"
import { migratedDb } from "./sqlite"

const index = placeIndex(jaSchema.parse(JSON.parse(readFileSync(new URL("../../../public/japanese-addresses/api/ja.json", import.meta.url), "utf8"))))

let db: Db
let sqlite: Database
beforeEach(() => {
  ;({ db, sqlite } = migratedDb())
})

const site = (workName: string, client: string, rowKeys: string[], over: Partial<Site> = {}): Site => ({ key: siteKeyOf(workName, client), workName, client, rowKeys, knowledgeTried: false, ...over })

/** 知識の AI の決まった応答: known にある工事名だけ自信ありで答える */
function knowledge(known: Record<string, [string, string]>, asked: string[] = []): AnonymizeCaller {
  return async (req: AiBatchRequest) => {
    asked.push(...req.items.map((i) => i.input))
    return {
      ok: true,
      usd: 0.002,
      json: {
        results: req.items.map((i) => {
          const hit = Object.entries(known).find(([name]) => i.input.startsWith(name))
          return hit ? { id: i.id, prefecture: hit[1][0], place: hit[1][1], needsReview: false, note: "" } : { id: i.id, prefecture: "", place: "", needsReview: true, note: "分からない" }
        }),
      },
    }
  }
}

/** Web 検索の決まった応答。fail に入れた工事名は failTimes 回まで投げる */
function search(answers: Record<string, Outcome>, opts: { fail?: Record<string, number>; asked?: string[] } = {}): RunDeps["search"] {
  const tries = new Map<string, number>()
  return async (s, spent) => {
    opts.asked?.push(s.workName)
    spent.usd += 0.05
    spent.searches += 2
    const n = (tries.get(s.workName) ?? 0) + 1
    tries.set(s.workName, n)
    if (n <= (opts.fail?.[s.workName] ?? 0)) throw new Error("混み合っています")
    return answers[s.workName] ?? { kind: "notFound", note: "" }
  }
}

/** その場で実行する step。retries.limit 回までやり直す（Workflows と同じく、最後の誤りを投げる）。before は step の前に呼ぶ */
function inlineStep(names: string[] = [], before?: (name: string) => Promise<void>): StepLike {
  return {
    async do(name, config, fn) {
      names.push(name)
      await before?.(name)
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn()
        } catch (e) {
          if (attempt >= (config.retries?.limit ?? 0)) throw e
        }
      }
    },
  }
}

function proposals() {
  const put = new Map<string, ProposalRecord>()
  return {
    put,
    deps: {
      putProposal: async (caseId: string, r: ProposalRecord) => void put.set(`${caseId}/${r.proposal.id}`, r),
      deleteProposal: async (caseId: string, id: string) => void put.delete(`${caseId}/${id}`),
    },
  }
}

async function newCase() {
  const customer = await createCustomer(db, "合成建設")
  const kase = await createCase(db, customer.id, 2026)
  return { customer, kase }
}

const sites = () => [
  site("横浜駅前広場工事", "横浜市", ["s!1", "s!2"]),
  site("テストビル改修工事", "株式会社テスト", ["s!3"]),
  site("第二小学校体育館工事", "市役所", ["s!4"], { knowledgeTried: true }),
  site("", "", ["s!5"], { skip: "personal" }),
]

describe("一括調査の回", () => {
  test("案件ごとに走っている回は1つだけ。削除中の案件には作らない", async () => {
    const { kase } = await newCase()
    const first = await loc.createRun(db, kase.id, sites())
    expect(first.ok).toBe(true)
    expect(await loc.createRun(db, kase.id, sites())).toEqual({ ok: false, reason: "busy" })
    await loc.failRun(db, (first as { run: { id: string } }).run.id, "x")
    expect((await loc.createRun(db, kase.id, sites())).ok).toBe(true)
    const { kase: other } = await newCase()
    await deleteCase(db, { put: async () => null, delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } as Bucket, other.id)
    expect(await loc.createRun(db, other.id, sites())).toEqual({ ok: false, reason: "gone" })
  })

  test("覚えた結果 → 知識（変換で推定していない現場だけ）→ Web 検索の順に調べ、失敗した検索はやり直す。結果は変更案になり、費用は回と案件に足す", async () => {
    const { customer, kase } = await newCase()
    await loc.remember(db, kase.id, [{ site: { workName: "横浜駅前広場工事", client: "横浜市" }, found: { prefecture: "神奈川県", place: "横浜市西区", urls: ["https://example.com/y"], source: "search", confident: true, note: "" } }])
    const created = await loc.createRun(db, kase.id, sites())
    if (!created.ok) throw new Error("回を作れません")
    const asked: string[] = []
    const searched: string[] = []
    const names: string[] = []
    const { put, deps } = proposals()
    await runLocationSearch(
      {
        db,
        index,
        knowledge: knowledge({}, asked),
        search: search(
          { テストビル改修工事: { kind: "found", prefecture: "東京都", place: "港区", urls: ["https://example.com/t"], source: "search", confident: true, note: "" } },
          { fail: { テストビル改修工事: 1 }, asked: searched },
        ),
        ...deps,
      },
      inlineStep(names),
      { runId: created.run.id, caseId: kase.id },
    )
    // 覚えた現場は知識にも検索にも回さない。変換で推定した現場は知識に回さない。個人名の現場はどこにも送らない
    expect(asked).toEqual(["テストビル改修工事 株式会社テスト"])
    // 検索は同時に進むので順は決まらない
    expect(searched.sort()).toEqual(["テストビル改修工事", "テストビル改修工事", "第二小学校体育館工事"].sort())
    expect(names).toEqual(["memory", "knowledge-list", "knowledge-0", "pending", "search-1", "search-2", "finish"])
    const run = await loc.latestRun(db, kase.id)
    expect(run).toMatchObject({ status: "done", total: 4, done: 4, searches: 6, proposalId: created.run.id })
    expect(run!.usd).toBeCloseTo(0.002 + 0.15)
    expect((await getCase(db, kase.id))!.costUsd).toBeCloseTo(0.002 + 0.15)
    const record = put.get(`${kase.id}/${created.run.id}`)!
    expect(record.proposal).toMatchObject({ origin: { kind: "location", runId: created.run.id }, state: "open", count: 4 })
    expect(record.changes.map((c) => c.kind)).toEqual(["location", "location", "ask", "ask"])
    expect(record.changes[0]).toMatchObject({ source: "memory", rowKeys: ["s!1", "s!2"], place: "横浜市西区" })
    expect(record.changes[1]).toMatchObject({ source: "search", prefecture: "東京都", place: "港区" })
    expect(customer.id).toBeTruthy()
  })

  test("やり直しても調べられない現場は「調べられなかった」として問い合わせに回し、ほかの現場は続ける", async () => {
    const { kase } = await newCase()
    const created = await loc.createRun(db, kase.id, sites().slice(1, 3))
    if (!created.ok) throw new Error("回を作れません")
    const { put, deps } = proposals()
    await runLocationSearch(
      { db, index, knowledge: knowledge({}), search: search({}, { fail: { テストビル改修工事: 9 } }), ...deps },
      inlineStep(),
      { runId: created.run.id, caseId: kase.id },
    )
    const record = [...put.values()][0]!
    expect(record.changes).toMatchObject([
      { kind: "ask", rowKey: "s!3", reason: expect.stringContaining("調べられませんでした") },
      { kind: "ask", rowKey: "s!4", reason: expect.stringContaining("分かりませんでした") },
    ])
    // 失敗した3回の費用も数える
    expect((await loc.latestRun(db, kase.id))!.usd).toBeCloseTo(0.002 + 0.05 * 4)
  })

  test("知識で自信ありと答え、住所データで検算できた現場は検索しない", async () => {
    const { kase } = await newCase()
    const created = await loc.createRun(db, kase.id, [site("テストビル改修工事", "株式会社テスト", ["s!3"]), site("謎の工事", "株式会社X", ["s!6"])])
    if (!created.ok) throw new Error("回を作れません")
    const searched: string[] = []
    const { put, deps } = proposals()
    await runLocationSearch(
      { db, index, knowledge: knowledge({ テストビル: ["東京都", "港区"], 謎の: ["東京都", "横浜市"] }), search: search({}, { asked: searched }), ...deps },
      inlineStep(),
      { runId: created.run.id, caseId: kase.id },
    )
    // 東京都に横浜市は無いので、知識の答えは使わず検索に回す
    expect(searched).toEqual(["謎の工事"])
    expect([...put.values()][0]!.changes[0]).toMatchObject({ kind: "location", source: "knowledge", urls: [] })
  })

  test("止める印を見たら残りは調べず、調べ終えた分で変更案を出して「止めた」にする", async () => {
    const { kase } = await newCase()
    const many = Array.from({ length: 10 }, (_, i) => site(`工事${i}`, "株式会社テスト", [`s!${i}`], { knowledgeTried: true }))
    const created = await loc.createRun(db, kase.id, many)
    if (!created.ok) throw new Error("回を作れません")
    const searched: string[] = []
    const { put, deps } = proposals()
    await runLocationSearch(
      { db, index, knowledge: knowledge({}), search: search({}, { asked: searched }), ...deps },
      inlineStep([], async (name) => {
        if (name === "search-4") await loc.requestStop(db, kase.id, created.run.id)
      }),
      { runId: created.run.id, caseId: kase.id },
    )
    expect(searched).toEqual(["工事0", "工事1", "工事2", "工事3"])
    expect((await loc.latestRun(db, kase.id))!).toMatchObject({ status: "stopped", done: 4 })
    expect([...put.values()][0]!.changes).toHaveLength(4)
  })

  test("走っている間に案件を消すと、そこからは AI を呼ばず、結果・費用・変更案を残さない", async () => {
    const { kase } = await newCase()
    const many = Array.from({ length: 10 }, (_, i) => site(`工事${i}`, "株式会社テスト", [`s!${i}`], { knowledgeTried: true }))
    const created = await loc.createRun(db, kase.id, many)
    if (!created.ok) throw new Error("回を作れません")
    const bucket = { put: async () => null, delete: async () => {}, list: async () => ({ objects: [], truncated: false as const }) } satisfies Bucket
    const searched: string[] = []
    const answer = search({}, { asked: searched })
    const { put, deps } = proposals()
    await runLocationSearch(
      {
        db,
        index,
        knowledge: knowledge({}),
        // 最初の検索の途中で案件が消される（同時に始めた検索は答えが返っても書かない）
        search: async (s, spent) => {
          if (s.workName === "工事0") await deleteCase(db, bucket, kase.id)
          return answer(s, spent)
        },
        ...deps,
      },
      inlineStep(),
      { runId: created.run.id, caseId: kase.id },
    )
    expect(searched.length).toBeLessThanOrEqual(4)
    expect(put.size).toBe(0)
    for (const t of ["csv_location_runs", "csv_location_sites", "csv_cases"]) expect((sqlite.query(`select count(*) as n from ${t}`).get() as { n: number }).n).toBe(0)
  })

  test("変更案を置いている間に削除が始まったら、置いたものを消す", async () => {
    const { kase } = await newCase()
    const created = await loc.createRun(db, kase.id, sites().slice(1, 2))
    if (!created.ok) throw new Error("回を作れません")
    const { put, deps } = proposals()
    await runLocationSearch(
      {
        db,
        index,
        knowledge: knowledge({ テストビル: ["東京都", "港区"] }),
        search: search({}),
        putProposal: async (caseId, r) => {
          await deps.putProposal(caseId, r)
          await db.update((await import("@/db/schema")).csvCases).set({ deleting: true })
        },
        deleteProposal: deps.deleteProposal,
      },
      inlineStep(),
      { runId: created.run.id, caseId: kase.id },
    )
    expect(put.size).toBe(0)
    expect((await loc.latestRun(db, kase.id))!.status).toBe("running")
  })
})

describe("覚えた結果", () => {
  const found = { prefecture: "東京都", place: "港区", urls: ["https://example.com/t"], source: "search" as const, confident: true, note: "" }

  test("承認した結果を顧客ごとに覚え、同じ現場（空白の違いも）は上書きする。個人名の現場は覚えない", async () => {
    const { customer, kase } = await newCase()
    expect(await loc.remember(db, kase.id, [{ site: { workName: "テストビル改修工事", client: "株式会社テスト" }, found }, { site: { workName: "", client: "" }, found }])).toBe(1)
    await loc.remember(db, kase.id, [{ site: { workName: "テストビル 改修工事", client: "株式会社テスト" }, found: { ...found, place: "港区赤坂" } }])
    const m = await loc.memorized(db, customer.id, [siteKeyOf("テストビル改修工事", "株式会社テスト")])
    expect([...m.values()]).toEqual([{ ...found, place: "港区赤坂", source: "memory" }])
    // ほかの顧客には出ない
    const other = await createCustomer(db, "別の建設")
    expect((await loc.memorized(db, other.id, [siteKeyOf("テストビル改修工事", "株式会社テスト")])).size).toBe(0)
  })

  test("案件を消しても覚えた結果は残り、顧客を消すと消える。削除中の案件からは覚えない", async () => {
    const { customer, kase } = await newCase()
    await loc.remember(db, kase.id, [{ site: { workName: "テストビル改修工事", client: "株式会社テスト" }, found }])
    const bucket = { put: async () => null, delete: async () => {}, list: async () => ({ objects: [], truncated: false as const }) } satisfies Bucket
    const next = await createCase(db, customer.id, 2027)
    await deleteCase(db, bucket, kase.id)
    expect((await loc.memorized(db, customer.id, [siteKeyOf("テストビル改修工事", "株式会社テスト")])).size).toBe(1)
    await db.update((await import("@/db/schema")).csvCases).set({ deleting: true })
    expect(await loc.remember(db, next.id, [{ site: { workName: "別の工事", client: "株式会社テスト" }, found }])).toBe(0)
    await deleteCustomer(db, bucket, customer.id)
    expect((sqlite.query("select count(*) as n from csv_location_memory").get() as { n: number }).n).toBe(0)
  })

  test("1件だけ調べる: 覚えた結果があれば AI を呼ばず、無ければ知識 → 検索", async () => {
    const { customer, kase } = await newCase()
    await loc.remember(db, kase.id, [{ site: { workName: "テストビル改修工事", client: "株式会社テスト" }, found }])
    const searched: string[] = []
    const deps = { index, knowledge: knowledge({}), search: search({}, { asked: searched }), memorized: (keys: string[]) => loc.memorized(db, customer.id, keys) }
    const spent = { usd: 0, searches: 0 }
    expect(await locateOne(deps, site("テストビル改修工事", "株式会社テスト", ["s!1"]), spent)).toMatchObject({ kind: "found", source: "memory" })
    expect(spent.usd).toBe(0)
    expect(await locateOne(deps, site("謎の工事", "株式会社X", ["s!2"]), spent)).toEqual({ kind: "notFound", note: "" })
    expect(searched).toEqual(["謎の工事"])
    expect(await locateOne(deps, site("", "", ["s!3"], { skip: "personal" }), spent)).toEqual({ kind: "skipped", skip: "personal" })
  })
})

describe("レビューで見つかった穴（D1 の結果）", () => {
  const found = { prefecture: "東京都", place: "港区", urls: ["https://example.com/t"], source: "search" as const, confident: true, note: "" }

  test("長い AI の文は切って書き、長すぎる場所名はその現場だけ「調べられなかった」にする。回全体は読める", async () => {
    const { kase } = await newCase()
    const created = await loc.createRun(db, kase.id, sites().slice(1, 3))
    if (!created.ok) throw new Error("回を作れません")
    await loc.recordOutcome(db, created.run.id, 0, { kind: "found", ...found, note: "迷った".repeat(500), urls: ["javascript:alert(1)", "https://example.com/a"] })
    await loc.recordOutcome(db, created.run.id, 1, { kind: "found", ...found, place: "港区".repeat(200) })
    const read = await loc.runSites(db, created.run.id)
    expect(read[0]!.outcome).toMatchObject({ kind: "found", urls: ["https://example.com/a"] })
    expect((read[0]!.outcome as { note: string }).note.length).toBeLessThanOrEqual(300)
    expect(read[1]!.outcome).toMatchObject({ kind: "failed" })
    expect(await loc.runSite(db, created.run.id, 1)).toMatchObject({ idx: 1, site: { workName: "第二小学校体育館工事" } })
  })

  test("読めない結果の行は、その現場だけ「調べられなかった」として読み、ほかの現場の変更案は出す", async () => {
    const { kase } = await newCase()
    const created = await loc.createRun(db, kase.id, sites().slice(1, 3))
    if (!created.ok) throw new Error("回を作れません")
    sqlite.run(`update csv_location_sites set outcome = '{"kind":"found","prefecture":1}' where run_id = '${created.run.id}' and idx = 0`)
    const { put, deps } = proposals()
    await runLocationSearch(
      { db, index, knowledge: knowledge({}), search: search({ 第二小学校体育館工事: { kind: "found", ...found, prefecture: "静岡県", place: "静岡市葵区" } }), ...deps },
      inlineStep(),
      { runId: created.run.id, caseId: kase.id },
    )
    expect([...put.values()][0]!.changes).toMatchObject([
      { kind: "ask", rowKey: "s!3", reason: expect.stringContaining("読めませんでした") },
      { kind: "location", place: "静岡市葵区" },
    ])
    expect((await loc.latestRun(db, kase.id))!.status).toBe("done")
  })

  test("自信なしのまま承認した結果は、覚えた結果でも自信なしと迷った点を残す", async () => {
    const { customer, kase } = await newCase()
    await loc.remember(db, kase.id, [{ site: { workName: "テストビル改修工事", client: "株式会社テスト" }, found: { ...found, confident: false, note: "似たビルが2つ" } }])
    const m = await loc.memorized(db, customer.id, [siteKeyOf("テストビル改修工事", "株式会社テスト")])
    expect([...m.values()][0]).toMatchObject({ confident: false, note: "似たビルが2つ", source: "memory" })
  })
})

describe("サーバーでの個人名の確かめ", () => {
  test("保存した作業の匿名化の AI の結果（persons）にいる人を含む文字列は個人名ありとし、保存した作業が無ければ確かめられないので投げる", async () => {
    const { kase } = await newCase()
    await expect(personalChecker(db, kase.id, null)).rejects.toThrow()
    const work = toSavedWork(newWork())
    const aiCache = [[aiKey("anonymizeWorkName", undefined, "田中花子邸新築工事"), { id: 0, value: "〔1〕邸新築工事", persons: ["田中花子"], needsReview: false, note: "" }]]
    await saveCaseState(db, kase.id, 0, { json: JSON.stringify(work), aiCache: JSON.stringify(aiCache) })
    const has = await personalChecker(db, kase.id, null)
    expect(has("田中花子邸新築工事\\n株式会社テスト")).toBe(true)
    expect(has("テストビル改修工事\\n株式会社テスト")).toBe(false)
    const sites = guardPersonal([site("田中 花子邸新築工事", "株式会社テスト", ["s!1"]), site("テストビル改修工事", "株式会社テスト", ["s!2"])], has)
    expect(sites.map((s) => s.skip)).toEqual(["personal", undefined])
    expect(JSON.stringify(sites)).not.toContain("田中")
  })
})

test("知識の段がやり直しても失敗したら、その段を飛ばして検索に進み、回は終わる", async () => {
  const { kase } = await newCase()
  const created = await loc.createRun(db, kase.id, [site("テストビル改修工事", "株式会社テスト", ["s!3"])])
  if (!created.ok) throw new Error("回を作れません")
  const searched: string[] = []
  const { put, deps } = proposals()
  let calls = 0
  await runLocationSearch(
    {
      db,
      index,
      knowledge: async () => (calls++, { ok: false as const, message: "AI のエラー（500）", usd: 0.001 }),
      search: search({ テストビル改修工事: { kind: "found", prefecture: "東京都", place: "港区", urls: [], source: "search", confident: true, note: "" } }, { asked: searched }),
      ...deps,
    },
    inlineStep(),
    { runId: created.run.id, caseId: kase.id },
  )
  expect(calls).toBe(3)
  expect(searched).toEqual(["テストビル改修工事"])
  expect((await loc.latestRun(db, kase.id))!.status).toBe("done")
  expect([...put.values()][0]!.changes[0]).toMatchObject({ kind: "location", place: "港区" })
})

test("承認した工事場所は1つの処理（batch）で覚える", async () => {
  const { customer, kase } = await newCase()
  let batches = 0
  const counted = Object.assign(Object.create(db), { batch: (q: Parameters<Db["batch"]>[0]) => (batches++, db.batch(q)) }) as Db
  const f = { prefecture: "東京都", place: "港区", urls: [], source: "search" as const, confident: true, note: "" }
  expect(await loc.remember(counted, kase.id, [1, 2, 3].map((i) => ({ site: { workName: `工事${i}`, client: "株式会社テスト" }, found: f })))).toBe(3)
  expect(batches).toBe(1)
  expect((await loc.memorized(db, customer.id, [1, 2, 3].map((i) => siteKeyOf(`工事${i}`, "株式会社テスト")))).size).toBe(3)
})

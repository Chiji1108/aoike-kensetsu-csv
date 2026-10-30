import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import * as schema from "@/db/schema"
import {
  addCaseCost,
  addFile,
  createCase,
  createCustomer,
  deleteCase,
  deleteCustomer,
  deletionCounts,
  getCase,
  getCaseState,
  getCaseWorkJson,
  previousCase,
  getFileRow,
  listCases,
  listFiles,
  listCustomers,
  saveCaseState,
  endChatsBeforeDelete,
  type Bucket,
  type Db,
} from "../case-store"
import { migratedDb } from "./sqlite"

/**
 * R2 の代わり。list は2件ずつ返し、ページ送りを通す。failOnDelete 回目の delete で落ちる。
 * beforeStore・afterStore を入れると put の途中（置く前・置いた後で返す前）で止めて、ほかの処理を割り込ませられる
 */
function memoryBucket() {
  const objects = new Map<string, Uint8Array>()
  let deletes = 0
  const bucket: Bucket & {
    objects: typeof objects
    puts: number
    failOnDelete?: number
    failPut?: boolean
    beforeStore?: () => Promise<void>
    afterStore?: () => Promise<void>
  } = {
    objects,
    puts: 0,
    async put(key, value) {
      bucket.puts++
      await bucket.beforeStore?.()
      if (bucket.failPut) throw new Error("R2 に置けませんでした")
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer)
      objects.set(key, bytes)
      await bucket.afterStore?.()
      return { size: bytes.byteLength }
    },
    async delete(keys) {
      if (++deletes === bucket.failOnDelete) throw new Error("R2 に届きませんでした")
      for (const k of keys) objects.delete(k)
    },
    async list({ prefix }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const page = keys.slice(0, 2).map((key) => ({ key }))
      return keys.length > 2 ? { objects: page, truncated: true, cursor: "next" } : { objects: page, truncated: false }
    },
  }
  return bucket
}

const tableCounts = (sqlite: Database) =>
  Object.fromEntries(
    ["csv_customers", "csv_cases", "csv_case_states", "csv_case_ai_caches", "csv_case_files"].map((t) => [t, (sqlite.query(`select count(*) as n from ${t}`).get() as { n: number }).n]),
  )

let db: Db
let sqlite: Database
let bucket: ReturnType<typeof memoryBucket>
beforeEach(() => {
  ;({ db, sqlite } = migratedDb())
  bucket = memoryBucket()
})

async function customerWithCases() {
  const customer = await createCustomer(db, "合成建設")
  const cases = [await createCase(db, customer.id, 2025), await createCase(db, customer.id, 2026)]
  for (const c of cases) {
    for (const name of ["工事経歴.xlsx", "追加分.pdf", "技術者.xlsx"]) await addFile(db, bucket, c.id, { kind: "source", name, contentType: "application/octet-stream", body: new TextEncoder().encode("abc") })
    await saveCaseState(db, c.id, 0, { json: "{}", aiCache: "[]" })
  }
  return { customer, cases }
}

describe("顧客・案件の保存", () => {
  test("状態は版を合わせたときだけ上書きする", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    expect(await saveCaseState(db, c.id, 0, { json: '{"a":1}', aiCache: "[1]" })).toEqual({ ok: true, version: 1 })
    expect(await saveCaseState(db, c.id, 0, { json: '{"a":2}', aiCache: "[2]" })).toEqual({ ok: false, reason: "conflict" })
    expect(await saveCaseState(db, c.id, 1, { json: '{"a":3}' })).toEqual({ ok: true, version: 2 })
    expect(await saveCaseState(db, c.id, 1, { json: '{"a":4}', aiCache: "[4]" })).toEqual({ ok: false, reason: "conflict" })
    expect(await getCaseState(db, c.id)).toEqual({ version: 2, json: '{"a":3}', aiCache: "[1]" })
    expect(tableCounts(sqlite).csv_case_ai_caches).toBe(1)
  })

  test("AI の結果は渡したときだけ替わり、手直しだけの保存では前の結果のまま。行は今の結果の1つだけ残る", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    await saveCaseState(db, c.id, 0, { json: '{"edit":0}', aiCache: "[]" })
    await saveCaseState(db, c.id, 1, { json: '{"edit":0}', aiCache: '["変換した"]' })
    await saveCaseState(db, c.id, 2, { json: '{"edit":1}' })
    await saveCaseState(db, c.id, 3, { json: '{"edit":2}' })
    expect(await getCaseState(db, c.id)).toEqual({ version: 4, json: '{"edit":2}', aiCache: '["変換した"]' })
    expect(tableCounts(sqlite).csv_case_ai_caches).toBe(1)
  })

  test("一覧に案件数・ファイル数が出る", async () => {
    const { customer, cases } = await customerWithCases()
    expect((await listCustomers(db)).map((c) => [c.name, c.caseCount])).toEqual([["合成建設", 2]])
    expect((await listCases(db, customer.id)).map((c) => [c.fiscalYear, c.fileCount])).toEqual([
      [2026, 3],
      [2025, 3],
    ])
    expect(await deletionCounts(db, { customerId: customer.id })).toEqual({ cases: 2, files: 6 })
    expect(await deletionCounts(db, { caseId: cases[0]!.id })).toEqual({ cases: 1, files: 3 })
  })
})

describe("前の年度の案件", () => {
  test("同じ顧客のいちばん近い前の年度。ほかの顧客・同じ年度・後の年度・削除の途中の案件は選ばない", async () => {
    const c = await createCustomer(db, "合成建設")
    const other = await createCustomer(db, "別の会社")
    const y2023 = await createCase(db, c.id, 2023)
    const y2024 = await createCase(db, c.id, 2024)
    const y2025 = await createCase(db, c.id, 2025)
    await createCase(db, c.id, 2026)
    await createCase(db, other.id, 2024)
    expect((await previousCase(db, y2025))?.id).toBe(y2024.id)
    expect(await previousCase(db, y2023)).toBeUndefined()
    await db.update(schema.csvCases).set({ deleting: true }).where(eq(schema.csvCases.id, y2024.id))
    expect((await previousCase(db, y2025))?.id).toBe(y2023.id)
  })

  test("作業の JSON だけを読める（保存が無ければ undefined）", async () => {
    const c = await createCustomer(db, "合成建設")
    const k = await createCase(db, c.id, 2025)
    expect(await getCaseWorkJson(db, k.id)).toBeUndefined()
    await saveCaseState(db, k.id, 0, { json: '{"a":1}', aiCache: "[]" })
    expect(await getCaseWorkJson(db, k.id)).toBe('{"a":1}')
  })
})

describe("削除", () => {
  test("案件を消すと、その案件の D1 の行と R2 のファイルが残らず、ほかの案件は残る", async () => {
    const { customer, cases } = await customerWithCases()
    await deleteCase(db, bucket, cases[0]!.id)
    expect([...bucket.objects.keys()].every((k) => k.startsWith(`cases/${cases[1]!.id}/`))).toBe(true)
    expect(bucket.objects.size).toBe(3)
    expect(tableCounts(sqlite)).toEqual({ csv_customers: 1, csv_cases: 1, csv_case_states: 1, csv_case_ai_caches: 1, csv_case_files: 3 })
    expect(await deletionCounts(db, { customerId: customer.id })).toEqual({ cases: 1, files: 3 })
  })

  test("顧客を消すと、案件・状態・ファイルの行と R2 のファイルが何も残らない", async () => {
    const { customer } = await customerWithCases()
    await deleteCustomer(db, bucket, customer.id)
    expect(bucket.objects.size).toBe(0)
    expect(tableCounts(sqlite)).toEqual({ csv_customers: 0, csv_cases: 0, csv_case_states: 0, csv_case_ai_caches: 0, csv_case_files: 0 })
  })

  test("途中で落ちても、もう一度消せば消し切れる（行を足す前に落ちて R2 にだけ残ったファイルも消す）", async () => {
    const { customer, cases } = await customerWithCases()
    await bucket.put(`cases/${cases[1]!.id}/orphan`, "x")
    bucket.failOnDelete = 3
    await expect(deleteCustomer(db, bucket, customer.id)).rejects.toThrow("R2 に届きませんでした")
    expect(tableCounts(sqlite).csv_customers).toBe(1)
    await deleteCustomer(db, bucket, customer.id)
    await deleteCustomer(db, bucket, customer.id)
    expect(bucket.objects.size).toBe(0)
    expect(tableCounts(sqlite)).toEqual({ csv_customers: 0, csv_cases: 0, csv_case_states: 0, csv_case_ai_caches: 0, csv_case_files: 0 })
  })

  test("外部キーが、ファイルの行を残したまま案件を消すことを止める", async () => {
    const { cases } = await customerWithCases()
    expect(() => sqlite.run(`delete from csv_cases where id = '${cases[0]!.id}'`)).toThrow(/FOREIGN KEY/)
  })
})

const pdf = { kind: "source" as const, name: "後から届いた分.pdf", contentType: "application/pdf", body: new TextEncoder().encode("%PDF-1.4 合成") }

/** 呼ばれるまで待つ関数と、待ちを解く関数 */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((r) => (open = r))
  let reached!: () => void
  const wasReached = new Promise<void>((r) => (reached = r))
  return { wait: () => (reached(), opened), open, reached: wasReached }
}

describe("ファイルを付けるのと削除が重なったとき", () => {
  test("付けたファイルは R2 に置いた実際の大きさで一覧に出る", async () => {
    const { cases } = await customerWithCases()
    const file = await addFile(db, bucket, cases[0]!.id, pdf)
    expect(file?.size).toBe(pdf.body.byteLength)
    expect((await listFiles(db, cases[0]!.id)).map((f) => [f.name, f.size])).toContainEqual([pdf.name, pdf.body.byteLength])
  })

  test("R2 に置いている間はファイルを一覧にも件数にも出さない", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    const g = gate()
    bucket.beforeStore = g.wait
    const adding = addFile(db, bucket, c.id, pdf)
    await g.reached
    expect(await listFiles(db, c.id)).toEqual([])
    expect(await deletionCounts(db, { caseId: c.id })).toEqual({ cases: 1, files: 0 })
    g.open()
    const file = await adding
    expect(await getFileRow(db, file!.id)).toBeDefined()
  })

  for (const when of ["beforeStore", "afterStore"] as const) {
    test(`R2 に置いている途中（${when === "beforeStore" ? "置く前" : "置いた後"}）に案件の削除が最後まで進んでも、R2 にも D1 にも残らない`, async () => {
      const { customer, cases } = await customerWithCases()
      const g = gate()
      bucket[when] = g.wait
      const adding = addFile(db, bucket, cases[0]!.id, pdf)
      await g.reached
      bucket[when] = undefined
      await deleteCase(db, bucket, cases[0]!.id)
      g.open()
      expect(await adding).toBeUndefined()
      expect([...bucket.objects.keys()].filter((k) => k.startsWith(`cases/${cases[0]!.id}/`))).toEqual([])
      expect(await deletionCounts(db, { customerId: customer.id })).toEqual({ cases: 1, files: 3 })
      expect(tableCounts(sqlite)).toEqual({ csv_customers: 1, csv_cases: 1, csv_case_states: 1, csv_case_ai_caches: 1, csv_case_files: 3 })
    })
  }

  test("削除が R2 の途中で落ちた案件には、ファイルも状態も足せず、もう一度消せば消し切れる", async () => {
    const { cases } = await customerWithCases()
    const c = cases[0]!
    bucket.failOnDelete = 1
    await expect(deleteCase(db, bucket, c.id)).rejects.toThrow("R2 に届きませんでした")
    const puts = bucket.puts
    expect(await addFile(db, bucket, c.id, pdf)).toBeUndefined()
    expect(bucket.puts).toBe(puts)
    expect(await saveCaseState(db, c.id, 1, { json: '{"a":1}', aiCache: "[]" })).toEqual({ ok: false, reason: "gone" })
    await deleteCase(db, bucket, c.id)
    expect([...bucket.objects.keys()].some((k) => k.startsWith(`cases/${c.id}/`))).toBe(false)
    expect(tableCounts(sqlite)).toEqual({ csv_customers: 1, csv_cases: 1, csv_case_states: 1, csv_case_ai_caches: 1, csv_case_files: 3 })
  })

  test("R2 に置いている間に削除が始まって途中で落ちても、置いたファイルを自分で消し、一覧に出さない", async () => {
    const { cases } = await customerWithCases()
    const c = cases[0]!
    const g = gate()
    bucket.beforeStore = g.wait
    const adding = addFile(db, bucket, c.id, pdf)
    await g.reached
    bucket.beforeStore = undefined
    bucket.failOnDelete = 1
    await expect(deleteCase(db, bucket, c.id)).rejects.toThrow("R2 に届きませんでした")
    g.open()
    expect(await adding).toBeUndefined()
    expect(bucket.objects.size).toBe(6)
    expect((await listFiles(db, c.id)).map((f) => f.name)).not.toContain(pdf.name)
  })

  test("案件の行がもう無くても、もう一度消すと R2 に残ったファイルを消す", async () => {
    const { cases } = await customerWithCases()
    const c = cases[0]!
    await deleteCase(db, bucket, c.id)
    await bucket.put(`cases/${c.id}/残ったファイル`, "x")
    await deleteCase(db, bucket, c.id)
    expect([...bucket.objects.keys()].some((k) => k.startsWith(`cases/${c.id}/`))).toBe(false)
  })

  test("消された案件の状態は保存しない", async () => {
    const { cases } = await customerWithCases()
    await deleteCase(db, bucket, cases[0]!.id)
    expect(await saveCaseState(db, cases[0]!.id, 0, { json: "{}", aiCache: "[]" })).toEqual({ ok: false, reason: "gone" })
    expect(await saveCaseState(db, cases[0]!.id, 1, { json: "{}" })).toEqual({ ok: false, reason: "gone" })
  })

  test("R2 に置けなかったファイルは行も残さない", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    bucket.failPut = true
    await expect(addFile(db, bucket, c.id, pdf)).rejects.toThrow("R2 に置けませんでした")
    expect(tableCounts(sqlite).csv_case_files).toBe(0)
  })
})

describe("費用", () => {
  test("費用は案件の合計に足していく（同時に足しても失わない）", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    await Promise.all([addCaseCost(db, c.id, 0.25), addCaseCost(db, c.id, 0.5)])
    await addCaseCost(db, c.id, 1)
    expect((await getCase(db, c.id))!.costUsd).toBeCloseTo(1.75)
  })
})

describe("消す前に会話を終える", () => {
  test("全案件の会話を同時に終え、どれかを終えられなければ削除の印を戻して投げる（前から削除の途中の案件は戻さない）", async () => {
    const customer = await createCustomer(db, "合成建設")
    const [a, b, c] = [await createCase(db, customer.id, 2024), await createCase(db, customer.id, 2025), await createCase(db, customer.id, 2026)]
    await deleteCase(db, { put: async () => null, delete: async () => {}, list: async () => Promise.reject(new Error("R2 の失敗")) }, c.id).catch(() => undefined)
    let running = 0
    let most = 0
    const busy = async (id: string) => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      if (id === b.id) throw new Error("処理中")
    }
    await expect(endChatsBeforeDelete(db, [a.id, b.id, c.id], busy)).rejects.toThrow("処理中")
    expect(most).toBe(3)
    expect([(await getCase(db, a.id))!.deleting, (await getCase(db, b.id))!.deleting, (await getCase(db, c.id))!.deleting]).toEqual([false, false, true])
    await endChatsBeforeDelete(db, [a.id, b.id], async () => {})
    expect((await getCase(db, a.id))!.deleting).toBe(true)
  })
})

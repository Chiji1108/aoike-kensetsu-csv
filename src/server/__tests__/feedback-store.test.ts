import { beforeEach, describe, expect, test } from "bun:test"
import { createCase, createCustomer, deleteCase, type Bucket, type Db } from "../case-store"
import { addFeedback, bumpFeedback, listFeedback, openFeedbackSummaries, setFeedbackStatus } from "../feedback-store"
import { migratedDb } from "./sqlite"
import { csvCases } from "@/db/cases-schema"
import { eq } from "drizzle-orm"

const bucket: Bucket = { put: async () => ({ size: 0 }), delete: async () => {}, list: async () => ({ objects: [], truncated: false }) }
const input = (want: string) => ({ kind: "missing" as const, want, did: "今", idea: "案" })

let db: Db
beforeEach(() => {
  ;({ db } = migratedDb())
})

describe("要望の保存", () => {
  test("案件の要望は案件へのリンク付きで新しい順。件数は未対応のものだけ足す。状態で絞る", async () => {
    const customer = await createCustomer(db, "架空の顧客")
    const kase = await createCase(db, customer.id, 2026)
    const a = await addFeedback(db, { ...input("一つ目"), caseId: kase.id, source: "ai" })
    const b = await addFeedback(db, { ...input("二つ目"), caseId: null, source: "staff" })
    const all = await listFeedback(db, null)
    expect(all.map((f) => [f.want, f.caseLabel, f.source, f.status, f.count])).toEqual([
      ["二つ目", null, "staff", "open", 1],
      ["一つ目", "架空の顧客 2026年度", "ai", "open", 1],
    ])
    expect(await bumpFeedback(db, a)).toBe(true)
    expect((await openFeedbackSummaries(db)).map((f) => [f.id, f.count])).toEqual([[a, 2], [b, 1]])
    expect(await setFeedbackStatus(db, a, "done")).toBe(true)
    expect(await bumpFeedback(db, a)).toBe(false)
    expect((await listFeedback(db, "done")).map((f) => [f.id, f.count])).toEqual([[a, 2]])
    expect((await listFeedback(db, "open")).map((f) => f.id)).toEqual([b])
    expect(await setFeedbackStatus(db, "nope", "done")).toBe(false)
  })

  test("案件を消すと要望は残り、案件へのリンクが外れる。削除中の案件には由来を付けない", async () => {
    const customer = await createCustomer(db, "架空の顧客")
    const kase = await createCase(db, customer.id, 2026)
    await addFeedback(db, { ...input("消す前"), caseId: kase.id, source: "ai" })
    await deleteCase(db, bucket, kase.id)
    expect((await listFeedback(db, null)).map((f) => [f.want, f.caseId, f.caseLabel])).toEqual([["消す前", null, null]])

    const other = await createCase(db, customer.id, 2027)
    await db.update(csvCases).set({ deleting: true }).where(eq(csvCases.id, other.id))
    await addFeedback(db, { ...input("削除中"), caseId: other.id, source: "ai" })
    expect((await listFeedback(db, null)).find((f) => f.want === "削除中")?.caseId).toBeNull()
  })
})

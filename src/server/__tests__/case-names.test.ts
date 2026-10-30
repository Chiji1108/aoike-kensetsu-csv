import { describe, expect, test } from "bun:test"
import { newWork, toSavedWork } from "@/lib/cases/state"
import { createCase, createCustomer, saveCaseState } from "../case-store"
import { namesOfSaved, readSavedCase, UnreadableCaseError } from "../case-names"
import { personalChecker } from "../location-guard"
import { migratedDb } from "./sqlite"

describe("保存した作業から個人名を集める", () => {
  test("まだ保存が無ければ null（名前は空。振り返り・ルールの案は表の人だけで確かめる）。工事場所の調査は前のとおり送らない", async () => {
    const { db } = migratedDb()
    const c = await createCase(db, (await createCustomer(db, "合成建設")).id, 2026)
    expect(await readSavedCase(db, c.id)).toBeNull()
    expect(namesOfSaved(null)).toEqual(new Set())
    await expect(personalChecker(db, c.id, null)).rejects.toBeInstanceOf(UnreadableCaseError)
  })

  test("保存した手直しの人を集める。読めない形なら投げる（名前を確かめられないまま案を出さない）", async () => {
    const { db } = migratedDb()
    const c = await createCase(db, (await createCustomer(db, "合成建設")).id, 2026)
    const work = { ...newWork(), edits: new Map([["s!1:engineer", { value: "見本　花子", by: "staff" as const }]]) }
    await saveCaseState(db, c.id, 0, { json: JSON.stringify(toSavedWork(work)), aiCache: "[]" })
    expect(namesOfSaved(await readSavedCase(db, c.id)).has("見本　花子")).toBe(true)
    const d = await createCase(db, (await createCustomer(db, "合成工務店")).id, 2026)
    await saveCaseState(db, d.id, 0, { json: '{"broken":true}', aiCache: "[]" })
    await expect(readSavedCase(db, d.id)).rejects.toBeInstanceOf(UnreadableCaseError)
  })
})

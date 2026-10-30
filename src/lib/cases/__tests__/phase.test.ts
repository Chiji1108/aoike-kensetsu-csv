import { describe, expect, test } from "bun:test"
import { reportPhase, type PhaseInput } from "../phase"

const base: PhaseInput = { aiEnabled: true, loading: null, sourceError: null, planning: false, convertError: null, converting: false, hasTable: false, noSheetSource: false, sourceName: null }

describe("変換の報告の段階", () => {
  test("AI が使えないときは、推定の計画で進めずに止める（ファイルがあっても）。変換済みの表は見せる", () => {
    expect(reportPhase({ ...base, aiEnabled: false })).toEqual({ kind: "noAi" })
    expect(reportPhase({ ...base, aiEnabled: false, sourceName: "a.xlsx" })).toEqual({ kind: "noAi" })
    expect(reportPhase({ ...base, aiEnabled: false, hasTable: true })).toEqual({ kind: "done" })
  })
  test("変換の元を読めなかったら、スピナーでなく失敗とやり直しを出す", () => {
    expect(reportPhase({ ...base, sourceName: "a.xlsx", sourceError: "読めません" })).toEqual({ kind: "failed", message: "読めません", retry: "source" })
  })
  test("変換に失敗したら変換し直す。読む → 考える → 変換する → 済み", () => {
    expect(reportPhase({ ...base, sourceName: "a.xlsx", converting: true, convertError: "x" })).toEqual({ kind: "failed", message: "x", retry: "convert" })
    expect(reportPhase({ ...base, loading: "a.xlsx" }).kind).toBe("reading")
    expect(reportPhase({ ...base, sourceName: "a.xlsx", planning: true }).kind).toBe("planning")
    expect(reportPhase({ ...base, sourceName: "a.xlsx", converting: true }).kind).toBe("converting")
    expect(reportPhase({ ...base, sourceName: "a.xlsx", hasTable: true }).kind).toBe("done")
    expect(reportPhase({ ...base, noSheetSource: true }).kind).toBe("noSheet")
    expect(reportPhase(base).kind).toBe("empty")
  })
})

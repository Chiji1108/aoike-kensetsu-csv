import { describe, expect, test } from "bun:test"
import type { CellResult, RowResult } from "@/lib/convert/convert"
import { finalizeAll, kojiRow } from "@/lib/convert/__tests__/helpers"
import { changedCell, countRowFilters, inFilter, needsCheck, rowNeedsCheck } from "../status"

const ok: CellResult = { value: "x", status: "ok", source: "A列: x", original: "x" }
const row = (key: string, other: Partial<CellResult>): RowResult<"a" | "b"> => ({
  key,
  sheet: "S",
  row: 1,
  cells: { a: ok, b: { ...ok, ...other } },
})

const rows = [
  row("plain", {}),
  row("error", { status: "error", message: "不正" }),
  row("warning", { status: "warning", message: "推定" }),
  row("aiFilled", { status: "ai", value: "東京都", original: "", message: "都道府県を補った" }),
  row("ai", { status: "ai", value: "Ａ", original: "山田太郎" }),
  row("aiSame", { status: "ai" }),
  row("rule", { status: "changed", value: "202304", original: "R5.4" }),
  row("guessedFill", { status: "warning", value: "東京都", original: "", message: "注文者から推定", guessed: true }),
  row("ruleThenWarning", { status: "warning", value: "202304", original: "R5.4", message: "工期の終わりより後" }),
  row("staffError", { status: "error", by: "staff", source: "手入力" }),
  row("customerSame", { status: "changed", by: "customer", source: "顧客の回答" }),
  row("confirmed", { status: "ok", by: "confirmed" }),
]
const checked = rows.filter((r) => rowNeedsCheck(r)).map((r) => r.key)
const changed = rows.filter((r) => Object.values(r.cells).some(changedCell)).map((r) => r.key)

describe("表の絞り込み", () => {
  test("変更ありの印は元データと値が違うセルか、職員・顧客が入れたセル。状態（要確認など）には左右されない", () => {
    expect(changed).toEqual(["aiFilled", "ai", "rule", "guessedFill", "ruleThenWarning", "staffError", "customerSame"])
  })
  test("確かめるは CSV に載せる行だけ。載せない行はすべてでだけ出る（件数は1つ）", () => {
    const err = rows.find((r) => r.key === "error")!
    expect(inFilter("check", err, true)).toBe(true)
    expect(inFilter("check", err, false)).toBe(false)
    expect(inFilter("all", err, false)).toBe(true)
    const inclusion = new Map(rows.map((r, i) => [r.key, { included: i % 2 === 0 }]))
    expect(countRowFilters(rows, inclusion)).toEqual({ check: rows.filter((r, i) => i % 2 === 0 && checked.includes(r.key)).length, all: rows.length })
  })
})

test("変換の流れで、推定で補って要確認になったセルは変更あり、元のままのセルは変更なし", () => {
  const cells = finalizeAll([kojiRow({ chiefEngineer: "0", workName: "倉庫改修工事" }, 1)], { replacements: {}, edits: new Map() }).rows[0]!.cells
  expect(cells.supervisingEngineer.status).toBe("warning")
  expect(changedCell(cells.supervisingEngineer)).toBe(true)
  expect(changedCell(cells.chiefEngineer)).toBe(false)
  expect(changedCell(cells.workName)).toBe(false)
})

describe("確かめる行を先に", () => {
  const k = (cells: Record<string, string>, key: number) => kojiRow(cells, key)
  const view = finalizeAll([k({ workName: "倉庫改修工事", client: "株式会社テスト" }, 1), k({ workName: "倉庫改修工事", client: "株式会社テスト", prefecture: "", place: "" }, 2)], { replacements: {}, edits: new Map() }).rows

  test("問い合わせが要るセル（書類に要るのにデータに無い）がある行は確かめる行（問い合わせを集めるのと同じ決まり）", () => {
    expect(rowNeedsCheck(view[1]!)).toBe(true)
  })
  test("AI の推定は、AI が自信がないと答えた値と AI が補った値", () => {
    expect(needsCheck({ ...ok, guessed: true }, "a")).toBe(true)
    expect(needsCheck({ ...ok, status: "ai", message: "補った" }, "a")).toBe(true)
    expect(needsCheck({ ...ok, status: "ai" }, "a")).toBe(false)
  })
  test("確かめる行は、エラー・要確認・AI の推定・問い合わせのどれかがある行", () => {
    expect(checked).toEqual(["error", "warning", "aiFilled", "guessedFill", "ruleThenWarning", "staffError"])
  })
})

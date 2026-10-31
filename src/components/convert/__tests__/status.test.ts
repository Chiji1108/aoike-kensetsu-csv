import { describe, expect, test } from "bun:test"
import type { CellResult, RowResult } from "@/lib/convert/convert"
import { finalizeAll, kojiRow } from "@/lib/convert/__tests__/helpers"
import { askReasonOf } from "@/lib/inquiry/inquiry"
import { cellFix, changedCell, countFixes, inFilter, rowFix, type RowFix } from "../status"

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
const fixOf = (r: RowResult<"a" | "b">) => rowFix(r, () => true)
const checked = rows.filter((r) => fixOf(r).fixes.length > 0).map((r) => r.key)
const never = () => false
const changed = rows.filter((r) => Object.values(r.cells).some(changedCell)).map((r) => r.key)

describe("表の絞り込み", () => {
  test("変更ありの印は元データと値が違うセルか、職員・顧客が入れたセル。状態（要確認など）には左右されない", () => {
    expect(changed).toEqual(["aiFilled", "ai", "rule", "guessedFill", "ruleThenWarning", "staffError", "customerSame"])
  })
  test("直すは CSV に載せる行だけ。載せない行はすべてでだけ出る。理由で絞れ、数は表と次にやることで同じ", () => {
    const err = fixOf(rows.find((r) => r.key === "error")!)
    expect(inFilter({ kind: "fix" }, err, true, never, "error")).toBe(true)
    expect(inFilter({ kind: "fix" }, err, false, never, "error")).toBe(false)
    expect(inFilter({ kind: "all" }, err, false, never, "error")).toBe(true)
    expect(inFilter({ kind: "fix", reason: "error" }, err, true, never, "error")).toBe(true)
    expect(inFilter({ kind: "fix", reason: "guess" }, err, true, never, "error")).toBe(false)
    const inclusion = new Map(rows.map((r, i) => [r.key, { included: i % 2 === 0 }]))
    const fixes = new Map(rows.map((r) => [r.key, fixOf(r)]))
    const counts = countFixes(rows, inclusion, fixes)
    expect(counts.rows).toBe(rows.filter((r, i) => i % 2 === 0 && checked.includes(r.key)).length)
    expect(counts.all).toBe(rows.length)
  })
  test("聞き返しの「表で見る」は対象の行だけ（載せない行も）", () => {
    const none: RowFix = { fixes: [], ask: 0 }
    expect(inFilter({ kind: "all", ask: "q" }, none, false, (k) => k === "r1", "r1")).toBe(true)
    expect(inFilter({ kind: "all", ask: "q" }, none, true, (k) => k === "r1", "r2")).toBe(false)
  })
})

test("変換の流れで、推定で補って要確認になったセルは変更あり、元のままのセルは変更なし", () => {
  const cells = finalizeAll([kojiRow({ chiefEngineer: "0", workName: "倉庫改修工事" }, 1)], { replacements: {}, edits: new Map() }).rows[0]!.cells
  expect(cells.supervisingEngineer.status).toBe("warning")
  expect(changedCell(cells.supervisingEngineer)).toBe(true)
  expect(changedCell(cells.chiefEngineer)).toBe(false)
  expect(changedCell(cells.workName)).toBe(false)
})

describe("直す行と顧客に聞く行", () => {
  const k = (cells: Record<string, string>, key: number) => kojiRow(cells, key)
  const view = finalizeAll([k({ workName: "倉庫改修工事", client: "株式会社テスト" }, 1), k({ workName: "倉庫改修工事", client: "株式会社テスト", prefecture: "", place: "" }, 2)], { replacements: {}, edits: new Map() }).rows

  test("問い合わせに回るセル（書類に要るのにデータに無い）は顧客に聞く（直さなくてよい）。問い合わせを外すと、空のままで片付く", () => {
    const asked = rowFix(view[1]!, () => true)
    expect(asked.ask).toBeGreaterThan(0)
    expect(asked.fixes.filter((f) => f.field === "prefecture" || f.field === "place")).toEqual([])
    const dismissed = rowFix(view[1]!, () => false)
    expect(dismissed.ask).toBe(0)
  })
  test("値のあるエラーは顧客に聞いても CSV に載らないので職員が直す。空の必須は問い合わせを外すと「必須が空」", () => {
    expect(cellFix({ ...ok, status: "error", value: "abc" }, "workName", true)).toBe("error")
    expect(cellFix({ ...ok, status: "error", value: "" }, "workName", true)).toBe("ask")
    expect(cellFix({ ...ok, status: "error", value: "" }, "workName", false)).toBe("empty")
    expect(cellFix({ ...ok, status: "error", value: "" }, "gyoshu", true)).toBe("empty")
    expect(cellFix({ ...ok, guessed: true }, "gyoshu", true)).toBe("guess")
    expect(cellFix({ ...ok, status: "warning", message: "x" }, "gyoshu", true)).toBe("review")
    expect(cellFix(ok, "gyoshu", true)).toBeUndefined()
  })
  test("AI の推定は、AI が自信がないと答えた値と AI が補った値", () => {
    expect(cellFix({ ...ok, guessed: true }, "a", true)).toBe("guess")
    expect(cellFix({ ...ok, status: "ai", message: "補った" }, "a", true)).toBe("guess")
    expect(cellFix({ ...ok, status: "ai" }, "a", true)).toBeUndefined()
  })
  test("値のある推定のエラーは、直すにだけ数え、問い合わせには入れない（1つのセルは片方だけ）", () => {
    const c = { ...ok, status: "error" as const, value: "東京", guessed: true as const }
    expect(cellFix(c, "prefecture", true)).toBe("error")
    expect(askReasonOf("prefecture", c)).toBeUndefined()
  })
  test("直す行は、エラー・要確認・AI の推定のどれかがある行（項目 a・b は問い合わせに回らない）", () => {
    expect(checked).toEqual(["error", "warning", "aiFilled", "guessedFill", "ruleThenWarning", "staffError"])
  })
})

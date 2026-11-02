import { describe, expect, test } from "bun:test"
import type { GyoshuSummary } from "../../convert/koji-selection"
import { exportCheck } from "../export-check"

const g = (over: Partial<GyoshuSummary>): GyoshuSummary => ({
  code: "9",
  label: "管",
  count: 2,
  selected: 2,
  total: 1000,
  motoukeTotal: 0,
  basis: { total: 1000, motouke: 0 },
  fromBook: { total: false, motouke: false },
  hasMotouke: false,
  selectedTotal: 1000,
  selectedMotoukeTotal: 0,
  totalRatio: 1,
  short: { motouke: false, total: false },
  fromExcluded: { count: 0, total: 0 },
  ...over,
})

describe("書き出す前の確認の7割と決算書の額", () => {
  test("基準額が 0 の業種は確かめられないとして分ける", () => {
    const c = exportCheck([], [g({}), g({ code: "", label: "（業種未確定）", total: 0, basis: { total: 0, motouke: 0 }, selectedTotal: 0, totalRatio: undefined })])
    expect(c.short).toEqual([])
    expect(c.unchecked).toEqual([{ code: "", label: "（業種未確定）" }])
  })

  test("決算書の額を使った側だけ表の合計と照らし、側ごとに数える", () => {
    const c = exportCheck([], [g({ hasMotouke: true, motoukeTotal: 400, basis: { total: 1000, motouke: 900 }, fromBook: { total: false, motouke: true } })])
    expect(c.fromBook).toEqual({ total: 0, motouke: 1 })
    expect(c.mismatches).toEqual([{ code: "9", label: "管", side: "motouke", entered: 900, rows: 400, diff: 500 }])
  })
})

import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { heuristicPlan } from "../heuristic-plan"
import { applyPlanPatch, columnIndex, describePlanPatch, patchFromInput, planPatchInputSchema, sheetShapeOf } from "../plan-patch"
import { readWorkbook } from "../workbook"
import { fixture } from "./helpers"

const [grid] = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid!)
const shape = sheetShapeOf(grid!)
const patch = (input: unknown) => patchFromInput(planPatchInputSchema.parse(input))

describe("チャットの計画の差分（set_plan）", () => {
  test("列記号と Excel の行番号を、計画の 0 始まりの番号にする", () => {
    expect(columnIndex("A")).toBe(0)
    expect(columnIndex("z")).toBe(25)
    expect(columnIndex("AA")).toBe(26)
    const p = patch({ fields: { amount: { kind: "column", column: "G", transform: "rule.yenToThousand" } }, headerRow: 3, dataStart: 4, skipRows: [12, 11, 11], reason: "金額は税込の列" })
    expect(p).toEqual({ fields: { amount: { kind: "column", column: 6, transform: "rule.yenToThousand" } }, headerRow: 2, dataStart: 3, skipRows: [10, 11], reason: "金額は税込の列" })
  })

  test("変えた項目だけを今の計画に重ね、ほかの項目・データの終わりはそのまま", () => {
    const r = applyPlanPatch(KOJI_KEIREKI, plan, patch({ fields: { workName: { kind: "columns", columns: ["C", "B"], transform: "rule.joinWorkName" } }, reason: "工事名は C 列と B 列をつなぐ" }), shape)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.fields.workName).toEqual({ kind: "columns", columns: [2, 1], transform: "rule.joinWorkName" })
    expect(r.plan.fields.amount).toEqual(plan.fields.amount)
    expect(r.plan.dataRows).toEqual(plan.dataRows)
    expect(r.plan.sheets).toEqual(plan.sheets)
  })

  test("AI の計画の取り込みと同じ決まりで断る: 個人名の項目に匿名化しない変換・型に合わない変換・シートの外の列。1つでも合わなければ何も重ねない", () => {
    const bad = applyPlanPatch(
      KOJI_KEIREKI,
      plan,
      patch({
        fields: {
          client: { kind: "column", column: "D", transform: "rule.text" },
          amount: { kind: "column", column: "G", transform: "rule.yearMonth" },
          place: { kind: "column", column: "ZZ", transform: "rule.addressCity" },
          jv: { kind: "constant", value: "0", reason: "JV なし" },
        },
        reason: "テスト",
      }),
      shape,
    )
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.problems.join("\n")).toContain("注文者")
    expect(bad.problems.join("\n")).toContain("請負代金")
    expect(bad.problems.join("\n")).toContain("範囲外")
  })

  test("見出しの行・データの開始・飛ばす行・除外の列はシートと見出しの行に合うものだけ", () => {
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ headerRow: 9999, reason: "x" }), shape).ok).toBe(false)
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ dataStart: plan.headerRow + 1, reason: "x" }), shape).ok).toBe(false)
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ skipRows: [1], reason: "x" }), shape).ok).toBe(false)
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ excludeColumns: ["ZZ"], reason: "x" }), shape).ok).toBe(false)
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ reason: "理由だけ" }), shape).ok).toBe(false)
    const ok = applyPlanPatch(KOJI_KEIREKI, plan, patch({ excludeColumns: ["A"], amountUnit: "thousandYen", reason: "x" }), shape)
    expect(ok.ok && ok.plan.rowFilter.excludeColumns).toEqual([0])
    expect(ok.ok && ok.plan.amountUnit).toBe("thousandYen")
  })

  test("知らない引数は断る（strict）", () => {
    expect(planPatchInputSchema.safeParse({ sheets: ["x"], reason: "x" }).success).toBe(false)
    expect(planPatchInputSchema.safeParse({ fields: { amount: { kind: "column", column: 3, transform: "rule.yenToThousand" } }, reason: "x" }).success).toBe(false)
  })

  test("職員向けの説明は「今 → 案」で出す", () => {
    const lines = describePlanPatch(patch({ fields: { amount: { kind: "column", column: "H", transform: "rule.yenToThousand" } }, reason: "x" }), plan)
    expect(lines[0]).toMatch(/^請負代金（千円）: .+ → H列（/)
  })
})

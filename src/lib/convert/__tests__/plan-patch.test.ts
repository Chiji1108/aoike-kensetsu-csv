import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { heuristicPlan } from "../heuristic-plan"
import { applyPlanPatch, beforeOf, columnIndex, describePlanPatch, patchFromInput, planPatchInputSchema, sheetShapeOf } from "../plan-patch"
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

  test("個人名を含みうる項目（注文者・工事名）に定数は書けない（匿名化を通らずに CSV に出るため）。ほかの項目の定数はよい", () => {
    const r = applyPlanPatch(KOJI_KEIREKI, plan, patch({ fields: { client: { kind: "constant", value: "山田太郎", reason: "全部同じ" } }, reason: "x" }), shape)
    expect(r.ok).toBe(false)
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ fields: { gyoshu: { kind: "constant", value: "19", reason: "全部内装" } }, reason: "x" }), shape).ok).toBe(true)
  })

  test("データの最後の行と、隠れた行を出すかも変えられる（シートの中だけ）", () => {
    const r = applyPlanPatch(KOJI_KEIREKI, plan, patch({ dataEnd: plan.dataRows.end, excludeHidden: false, reason: "x" }), shape)
    expect(r.ok && r.plan.rowFilter.excludeHidden).toBe(false)
    const shorter = applyPlanPatch(KOJI_KEIREKI, plan, patch({ dataEnd: plan.dataRows.start + 2, reason: "x" }), shape)
    expect(shorter.ok && shorter.plan.dataRows.end).toBe(plan.dataRows.start + 1)
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ dataEnd: 9999, reason: "x" }), shape).ok).toBe(false)
    expect(applyPlanPatch(KOJI_KEIREKI, plan, patch({ dataEnd: plan.dataRows.start, reason: "x" }), shape).ok).toBe(false)
  })

  test("ブックを渡すと、見出しの行を変えたあとも2枚目以降のシートの見出しが同じか確かめ直す（AI の計画の取り込みと同じ決まり）", () => {
    const g = grid!
    const copy = { ...g, name: "別の年", rows: g.rows.map((r, i) => (i > plan.headerRow ? r.map((c, j) => (j === 0 ? `X${c}` : c)) : r)) }
    const book = [g, copy]
    const two = { ...plan, sheets: [g.name, copy.name] }
    expect(applyPlanPatch(KOJI_KEIREKI, two, patch({ fields: { jv: { kind: "missing" } }, reason: "x" }), shape, book).ok).toBe(true)
    const moved = applyPlanPatch(KOJI_KEIREKI, two, patch({ headerRow: plan.headerRow + 2, dataStart: plan.headerRow + 3, reason: "x" }), shape, book)
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.problems.join()).toContain("別の年")
  })

  test("知らない引数は断る（strict）", () => {
    expect(planPatchInputSchema.safeParse({ sheets: ["x"], reason: "x" }).success).toBe(false)
    expect(planPatchInputSchema.safeParse({ fields: { amount: { kind: "column", column: 3, transform: "rule.yenToThousand" } }, reason: "x" }).success).toBe(false)
  })

  test("職員向けの説明は「今 → 案」で出す", () => {
    const p = patch({ fields: { amount: { kind: "column", column: "H", transform: "rule.yenToThousand" } }, reason: "x" })
    const before = beforeOf(plan, p)
    expect(describePlanPatch(p, before)[0]).toMatch(/^請負代金（千円）: G列.+ → H列（/)
    // 承認して計画が変わっても、変更案に残した「前」で出す（「H列 → H列」にしない）
    const approved = applyPlanPatch(KOJI_KEIREKI, plan, p, shape)
    expect(approved.ok && describePlanPatch(p, beforeOf(approved.plan, p))[0]).toMatch(/H列.+ → H列/)
    expect(describePlanPatch(p, before)[0]).not.toMatch(/H列.+ → H列/)
  })
})

describe("値で行を出さない（計画の聞き返しの答え）", () => {
  test("値の除外は今のものと入れ替え、ほかの差分を重ねても消えない。範囲外の列は受け取らない", () => {
    const r = applyPlanPatch(KOJI_KEIREKI, plan, { excludeValues: [{ column: 10, values: ["追加工事あり"] }], reason: "迷う行" }, shape)
    if (!r.ok) throw new Error(r.problems.join())
    expect(r.plan.rowFilter.excludeValues).toEqual([{ column: 10, values: ["追加工事あり"] }])
    const again = applyPlanPatch(KOJI_KEIREKI, r.plan, { skipRows: [11], reason: "合計の行" }, shape)
    if (!again.ok) throw new Error(again.problems.join())
    expect(again.plan.rowFilter.excludeValues).toEqual([{ column: 10, values: ["追加工事あり"] }])
    expect(applyPlanPatch(KOJI_KEIREKI, plan, { excludeValues: [{ column: 99, values: ["x"] }], reason: "x" }, shape).ok).toBe(false)
    expect(describePlanPatch({ excludeValues: [{ column: 10, values: ["追加工事あり"] }], reason: "" })).toEqual(["この値なら出さない列: K列「追加工事あり」"])
  })
})

test("値の除外の対象の行は、理由を付けて出さない（全角・半角と前後の空白の違いは見ない）", async () => {
  const { excludedReason } = await import("../sources")
  const filter = { excludeHidden: false, excludeColumns: [], excludeValues: [{ column: 1, values: ["未成"] }] }
  expect(excludedReason({ sheet: "s", row: 1, cells: ["1", " 未成 "], hidden: false }, filter)).toBe("B列が「未成」")
  expect(excludedReason({ sheet: "s", row: 2, cells: ["1", "完成"], hidden: false }, filter)).toBeUndefined()
  expect(excludedReason({ sheet: "s", row: 3, cells: ["1", "完成"], hidden: false }, { excludeHidden: false, excludeColumns: [] })).toBeUndefined()
})

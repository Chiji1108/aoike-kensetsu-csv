import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { heuristicPlan } from "../heuristic-plan"
import { acceptAiPlan, reviewPlanTransforms, type SheetGrid } from "../plan"
import { MAX_PREVIOUS_CONTEXT, planExcerpt, planUserMessage, previousPlanContext, systemPrompt } from "../prompt"
import { readWorkbook } from "../workbook"
import { fixture } from "./helpers"

const book = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
const [grid] = book
const fallbackFor = (g: SheetGrid) => heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
const fallback = fallbackFor(grid!)

const col = (column: number, transform: string, instruction: string | null = null) => ({ kind: "column", column, transform, instruction })

function aiPlan(overrides: Record<string, unknown> = {}) {
  return {
    sheets: [grid!.name],
    sheetReason: "工事の一覧",
    headerRow: 2,
    dataStart: 3,
    skipRows: [10, 11],
    excludeColumns: [],
    amountUnit: "yen",
    fields: {
      gyoshu: col(1, "rule.gyoshu"),
      client: col(3, "ai.anonymizeClient"),
      motoukeShitauke: { kind: "columns", columns: [4, 3], transform: "rule.motoukeShitauke", instruction: null },
      jv: { kind: "constant", value: "0", reason: "JV列なし" },
      workName: col(2, "ai.anonymizeWorkName"),
      prefecture: col(5, "rule.addressPrefecture"),
      place: col(5, "rule.addressCity"),
      engineer: col(9, "rule.personNameSpace"),
      amount: col(6, "rule.yenToThousand"),
      specialAmount: { kind: "constant", value: "0", reason: "該当なし" },
      startYm: col(7, "rule.periodStart"),
      endYm: col(8, "rule.yearMonth"),
      chiefEngineer: { kind: "missing" },
      supervisingEngineer: { kind: "missing" },
      ...overrides,
    },
    unusedColumns: [{ column: 0, header: "No.", reason: "連番" }],
    notes: ["金額は税込の可能性があります"],
  }
}

describe("AI の計画の取り込み（決まった応答で確認）", () => {
  test("正しい計画はそのまま使う（instruction: null は付けない）", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, book, aiPlan(), fallbackFor)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.fields.gyoshu).toEqual({ kind: "column", column: 1, transform: "rule.gyoshu" })
    expect(r.plan.dataRows).toEqual({ start: 3, end: fallback.dataRows.end })
    expect(r.plan.sheets).toEqual(["工事経歴"])
    // シートが2枚以上あるときは、AI がシートを選んだ理由を職員に見せる
    expect(r.plan.notes).toEqual(["使うシート「工事経歴」: 工事の一覧", "金額は税込の可能性があります"])
  })

  test("範囲外の列・項目に合わない変換・指示文の無い AI 変換は、ルールの推定に戻して notes に残す", () => {
    const r = acceptAiPlan(
      KOJI_KEIREKI,
      book,
      aiPlan({
        gyoshu: col(42, "rule.gyoshu"),
        amount: col(6, "rule.gyoshu"),
        workName: col(2, "ai.freeform"),
        engineer: col(9, "ai.freeform", "姓と名の間に全角スペース"),
      }),
      fallbackFor,
    )
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.fields.gyoshu).toEqual(fallback.fields.gyoshu)
    expect(r.plan.fields.amount).toEqual(fallback.fields.amount)
    expect(r.plan.fields.workName).toEqual(fallback.fields.workName)
    expect(r.plan.fields.engineer).toEqual({ kind: "column", column: 9, transform: "ai.freeform", instruction: "姓と名の間に全角スペース" })
    expect(r.plan.notes).toHaveLength(5)
  })

  test("データの終わりは AI に決めさせず、シートの最後の空でない行まで含める。表の後ろの行は AI が skipRows に挙げれば飛ばす", () => {
    // 9行目（0始まり）は通常のデータ行でルールは飛ばさない。AI が挙げたときだけ飛ばされることで、AI の skipRows が効いていると分かる
    expect(fallback.skipRows).not.toContain(9)
    const r = acceptAiPlan(KOJI_KEIREKI, book, { ...aiPlan(), skipRows: [9] }, fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.dataRows.end).toBe(fallback.dataRows.end)
    expect(r.plan.skipRows).toContain(9)
  })

  test("見出し行・開始行がシートと合わなければ、行はルールの推定を使う", () => {
    for (const bad of [{ headerRow: 99 }, { dataStart: 2 }, { dataStart: 500 }]) {
      const r = acceptAiPlan(KOJI_KEIREKI, book, { ...aiPlan(), ...bad }, fallbackFor)
      if (!r.ok) throw new Error(r.message)
      expect(r.plan.dataRows).toEqual(fallback.dataRows)
    }
  })

  test("AI が見落とした合計・小計の行も、ルールで見つけたものは飛ばす", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, book, { ...aiPlan(), skipRows: [] }, fallbackFor)
    if (!r.ok) throw new Error(r.message)
    // 0始まりの12（Excel の13行目）は表の後ろの注記「※金額は税込です」
    expect(r.plan.skipRows).toEqual([10, 11, 12])
  })

  test("行の範囲がシートと合わなければ行はルールの推定を使う", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, book, { ...aiPlan(), dataStart: 500 }, fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.dataRows).toEqual(fallback.dataRows)
    expect(r.plan.skipRows).toEqual(fallback.skipRows)
  })

  test("項目が欠けた応答・未知の変換は形式エラー", () => {
    const { gyoshu: _, ...missing } = aiPlan().fields
    expect(acceptAiPlan(KOJI_KEIREKI, book, { ...aiPlan(), fields: missing }, fallbackFor).ok).toBe(false)
    expect(acceptAiPlan(KOJI_KEIREKI, book, aiPlan({ gyoshu: col(1, "rule.unknown") }), fallbackFor).ok).toBe(false)
  })
})

describe("プロンプト", () => {
  test("システムプロンプトは定義表から作られ、毎回同じ（キャッシュが効く）", () => {
    const a = systemPrompt(KOJI_KEIREKI)
    expect(a).toBe(systemPrompt(KOJI_KEIREKI))
    for (const f of KOJI_KEIREKI.fields) expect(a).toContain(`${f.id}（${f.letter}列`)
  })

  test("必須でも空欄を自動で埋める項目（主任技術者・監理技術者・JV）は、元データに無くてよいと伝える", () => {
    const line = (id: string) => systemPrompt(KOJI_KEIREKI).split("\n").find((l) => l.startsWith(`- ${id}（`))!
    for (const id of ["chiefEngineer", "supervisingEngineer", "jv"]) expect(line(id)).toContain("元データに無ければ自動で埋める")
    expect(line("gyoshu")).not.toContain("元データに無ければ")
  })

  test("去年の列の対応は去年の見出しの名前で書き、去年との違いと一緒に参考として計画の指示に添える", () => {
    const text = previousPlanContext(KOJI_KEIREKI, { fiscalYear: 2025, grid: grid!, plan: fallback, diff: ["足された列: L列「担当部署」"] })
    const header = grid!.rows[fallback.headerRow]!
    const client = fallback.fields.client
    expect(client.kind).toBe("column")
    if (client.kind === "column") expect(text).toContain(`- client: 「${header[client.column]}」 → ${client.transform}`)
    expect(text).toContain("去年（2025年度）の列の対応")
    expect(text).toContain("- 足された列: L列「担当部署」")
    expect(text).toContain("今年の見出しと値で確かめて決める")
    expect(planUserMessage({ ...planExcerpt(book, () => 0), previous: text })).toContain(text)
    expect(planUserMessage(planExcerpt(book, () => 0))).not.toContain("去年")
    // 長くても上限で切る
    expect(previousPlanContext(KOJI_KEIREKI, { fiscalYear: 2025, grid: grid!, plan: fallback, diff: Array.from({ length: 2000 }, (_, i) => `違い${i}`) }).length).toBeLessThan(MAX_PREVIOUS_CONTEXT + 50)
  })

  test("計画用に送るのは先頭30行と末尾10行だけ", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`r${i}`])
    const [ex] = planExcerpt([{ name: "s", rows, hidden: rows.map(() => false) }], () => 0).sheets
    expect(ex!.rows.map((r) => r.index)).toEqual([...Array.from({ length: 30 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 90 + i)])
  })
})

describe("全角にする変換はどの項目にも使わない（元データの表記を残す）", () => {
  test("計画の指示に全角にする変換を出さない。注文者・工事名は表記（半角カナなど）をそのまま残すと伝える", () => {
    const prompt = systemPrompt(KOJI_KEIREKI)
    expect(prompt).not.toContain("rule.fullWidthText")
    const line = (id: string) => prompt.split("\n").find((l) => l.startsWith(`- ${id}（`))!
    expect(line("workName")).toContain("表記（半角カナ・全角・㈱などの記号）はそのまま残す")
    expect(line("client")).toContain("表記（半角カナ・半角スペース・㈱などの記号）はそのまま残す")
  })

  test("AI が全角にする変換を選んだら、ルールの推定に戻す", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, book, aiPlan({ workName: col(2, "rule.fullWidthText") }), fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.fields.workName).toEqual(fallback.fields.workName)
    expect(r.plan.notes.some((n) => n.startsWith("工事名: 変換「全角にする（使わない）」はこの項目に使えない"))).toBe(true)
  })
})

describe("個人名を含みうる項目（注文者・工事名）には匿名化する変換しか使わない", () => {
  const line = (id: string) => systemPrompt(KOJI_KEIREKI).split("\n").find((l) => l.startsWith(`- ${id}（`))!
  test("計画の指示の「使える変換」には匿名化する変換だけを出す", () => {
    expect(line("workName")).toContain("使える変換: ai.anonymizeWorkName, rule.joinWorkName")
    expect(line("workName")).not.toContain("rule.text")
    expect(line("client")).toContain("使える変換: ai.anonymizeClient")
    expect(line("client")).not.toMatch(/rule\.text|rule\.fullWidthText|ai\.freeform|ai\.anonymizeWorkName/)
  })

  test("AI が匿名化しない変換を選んだら、ルールの推定に戻す", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, book, aiPlan({ workName: col(2, "rule.text"), client: col(3, "ai.freeform", "そのまま") }), fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.fields.workName).toEqual(fallback.fields.workName)
    expect(r.plan.fields.client).toEqual(fallback.fields.client)
  })

  test("保存済みの計画を読むときも同じ決まりで確かめ、使えない変換を匿名化する変換に替える（ほかの項目はそのまま）", () => {
    const saved = { ...fallback, fields: { ...fallback.fields, workName: { kind: "column" as const, column: 2, transform: "rule.fullWidthText" as const }, client: { kind: "column" as const, column: 3, transform: "rule.text" as const } } }
    const r = reviewPlanTransforms(KOJI_KEIREKI, saved)
    expect(r.plan.fields.workName).toEqual({ kind: "column", column: 2, transform: "ai.anonymizeWorkName" })
    expect(r.plan.fields.client).toEqual({ kind: "column", column: 3, transform: "ai.anonymizeClient" })
    expect(r.plan.fields.amount).toBe(saved.fields.amount)
    expect(r.changed).toEqual(["注文者", "工事名"])
    expect(reviewPlanTransforms(KOJI_KEIREKI, fallback).changed).toEqual([])
  })
})

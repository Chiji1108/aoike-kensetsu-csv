import { describe, expect, test } from "bun:test"
import { newWork, savedWorkSchema, toSavedWork } from "../../cases/state"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { headerMatch, heuristicPlan, primarySheet } from "../heuristic-plan"
import { acceptAiPlan, type FieldPlan, type MappingPlan, type SheetGrid } from "../plan"
import { MAX_EXCERPT_CELLS, planExcerpt, planUserMessage, systemPrompt } from "../prompt"
import { collectSourceRows } from "../sources"

const grid = (name: string, rows: string[][]): SheetGrid => ({ name, rows, hidden: rows.map(() => false) })
const fallbackFor = (g: SheetGrid) => heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
const headerRowOf = (g: SheetGrid) => headerMatch(KOJI_KEIREKI, KOJI_PLAN_HINTS, g).headerRow

const HEADER = ["工種", "工事件名", "発注者", "施工場所", "契約金額（円）", "完成日"]
const works = grid("工事", [
  ["会計期間：2025年1月1日～2025年12月31日"],
  [],
  HEADER,
  ["電気工事", "テストビル電気設備工事", "株式会社テスト商事", "東京都千代田区丸の内1-1", "1200000", "2025-06-30"],
  ["管工事", "テスト病院給排水改修工事", "医療法人テスト会", "千葉県船橋市本町1-1", "800000", "2025-09-30"],
])
const works2 = grid("工事2", [["会計期間：2024年1月1日～2024年12月31日"], [], HEADER, ["内装仕上", "テスト店舗内装工事", "株式会社テスト物流", "埼玉県さいたま市大宮区桜木町1", "500000", "2024-10-31"]])
const otherHeader = grid("集計", [[], [], ["業種", "件数", "金額"], ["電気工事", "1", "1200000"]])
// 工事より行の多い、2列だけの顧客一覧（行の数で選ぶとこちらになる）
const customers = grid("顧客一覧", [["顧客コード", "顧客名"], ...Array.from({ length: 200 }, (_, i) => [`C${i}`, `株式会社サンプル${i}`])])
const empty = grid("空", [])
const book = [customers, works, works2, otherHeader, empty]

/** 計画（見出しからの推定）を AI の応答の形にする */
function wireOf(plan: MappingPlan<string>, sheets: string[]) {
  const fields = Object.fromEntries(
    Object.entries<FieldPlan>(plan.fields).map(([id, p]) => [id, p.kind === "column" || p.kind === "columns" ? { ...p, instruction: null } : p]),
  )
  return {
    sheets,
    sheetReason: "工事ごとに1行の表",
    headerRow: plan.headerRow,
    dataStart: plan.dataRows.start,
    skipRows: [],
    excludeColumns: [],
    amountUnit: plan.amountUnit,
    fields,
    unusedColumns: [],
    notes: [],
  }
}
const worksWire = (sheets: string[]) => wireOf(fallbackFor(works), sheets)

describe("計画の AI が選んだシートの取り込み（決まった応答で確認）", () => {
  test("行の多い無関係なシートがあっても、AI が選んだ工事の一覧のシートで計画を作り、行はそのシートのもの。選んだ理由を notes の先頭に残す", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, book, worksWire(["工事"]), fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.sheets).toEqual(["工事"])
    expect(r.plan.headerRow).toBe(2)
    expect(r.plan.dataRows).toEqual({ start: 3, end: 4 })
    expect(r.plan.notes[0]).toBe("使うシート「工事」: 工事ごとに1行の表")
    expect(collectSourceRows(book, r.plan).rows.map((s) => `${s.sheet}!${s.row}`)).toEqual(["工事!3", "工事!4"])
  })

  test("見出しが同じシートは2枚目以降に足せる。見出しが違う・無い・空・重複したシートは外して notes に残す", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, book, worksWire(["工事", "工事2", "集計", "無いシート", "空", "工事"]), fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.sheets).toEqual(["工事", "工事2"])
    expect(r.plan.notes).toEqual([
      "使うシート「工事」「工事2」: 工事ごとに1行の表",
      "AI が足したシート「集計」は見出しが「工事」と違うため外しました",
      "AI が足したシート「無いシート」はファイルに無いため外しました",
      "AI が足したシート「空」は空のため外しました",
    ])
    expect(collectSourceRows(book, r.plan).rows.map((s) => `${s.sheet}!${s.row}`)).toEqual(["工事!3", "工事!4", "工事2!3"])
  })

  test("AI が足した2枚目以降でも、データの行のほとんどが使うシートにある写し（一部を直したもの）は、同じ工事が二重に出るので外す", () => {
    const many = (name: string, edit: boolean) =>
      grid(name, [["表題"], [], HEADER, ...Array.from({ length: 20 }, (_, i) => ["電気工事", edit && i === 3 ? "手直しした工事" : `テスト工事${i}`, "株式会社テスト", "東京都千代田区", "1000000", "2025-06-30"])])
    const full = many("全件", false)
    const copy = many("電気工事", true)
    const r = acceptAiPlan(KOJI_KEIREKI, [full, copy], wireOf(fallbackFor(full), ["全件", "電気工事"]), fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.sheets).toEqual(["全件"])
    expect(r.plan.notes).toContain("AI が足したシート「電気工事」はデータの行の95%が「全件」にもある写しのため外しました")
  })

  test("計画の元のシートが無い・空・選ばれていない・職員の指定と違うなら、計画全体を使わない（呼び出し側が見出しからの推定に戻す）", () => {
    for (const [sheets, message] of [
      [["無いシート"], "AI が選んだシート「無いシート」がファイルにありません"],
      [["空"], "AI が選んだシート「空」は空です"],
      [[], "AI の計画に使うシートがありません"],
    ] as const) {
      expect(acceptAiPlan(KOJI_KEIREKI, book, worksWire([...sheets]), fallbackFor)).toEqual({ ok: false, message })
    }
    expect(acceptAiPlan(KOJI_KEIREKI, book, worksWire(["工事"]), fallbackFor, "工事2")).toEqual({ ok: false, message: "AI が指定のシート「工事2」でなく「工事」を選びました" })
    expect(acceptAiPlan(KOJI_KEIREKI, book, wireOf(fallbackFor(works2), ["工事2"]), fallbackFor, "工事2").ok).toBe(true)
  })

  test("項目ごとの予備は、AI が選んだシートについて見出しから推定したもの（列の番号の意味がシートで変わるため）", () => {
    const bad = { ...worksWire(["工事"]), fields: { ...worksWire(["工事"]).fields, amount: { kind: "column", column: 42, transform: "rule.yenToThousand", instruction: null } } }
    const r = acceptAiPlan(KOJI_KEIREKI, book, bad, fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.fields.amount).toEqual(fallbackFor(works).fields.amount)
  })

  test("シートが1枚だけなら、シートの理由は notes に出さない", () => {
    const r = acceptAiPlan(KOJI_KEIREKI, [works], worksWire(["工事"]), fallbackFor)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.notes).toEqual([])
  })

  test("AI が使えないときの予備: 見出しが工事の項目にあてはまるシートを選び、使うシートはその1枚だけ", () => {
    const primary = primarySheet(KOJI_KEIREKI, KOJI_PLAN_HINTS, book)!
    expect(primary.name).toBe("工事")
    expect(fallbackFor(primary).sheets).toEqual(["工事"])
  })

  test("前の版で保存した計画（見出しからの推定で複数のシートを選んだもの）も、そのまま読める", () => {
    const old = { ...fallbackFor(works), sheets: ["工事", "工事2"] }
    const saved = JSON.parse(JSON.stringify(toSavedWork({ ...newWork("file"), plan: { plan: old, source: "rule" } })))
    const parsed = savedWorkSchema.parse(saved)
    expect(parsed.plan!.plan.sheets).toEqual(["工事", "工事2"])
    expect(collectSourceRows(book, parsed.plan!.plan).rows).toHaveLength(3)
  })
})

describe("計画の AI に渡すブックの抜粋", () => {
  test("全部のシートの名前・行数・列数・先頭の行と、行の内容が重なるシートを渡す", () => {
    const copy = grid("電気工事", works.rows.slice(0, 4))
    const ex = planExcerpt([...book, copy], headerRowOf)
    expect(ex.sheets.map((s) => [s.name, s.rowCount, s.columnCount])).toEqual([
      ["顧客一覧", 201, 2],
      ["工事", 5, 6],
      ["工事2", 4, 6],
      ["集計", 4, 3],
      ["空", 0, 0],
      ["電気工事", 4, 6],
    ])
    expect(ex.sheets.find((s) => s.name === "電気工事")!.overlap).toEqual({ sheet: "工事", percent: 100 })
    expect(ex.sheets.find((s) => s.name === "空")!.rows).toEqual([])
    const message = planUserMessage(ex)
    expect(message).toContain("ブックの全6枚のシート")
    expect(message).toContain("### シート「顧客一覧」（全201行・2列")
    expect(message).toContain("行の内容の100%はシート「工事」にもある。")
    expect(message).toContain("（空のシート）")
    expect(message).toContain("工事の一覧のシートを選び")
  })

  test("職員が指定したシートを伝える", () => {
    const ex = planExcerpt(book, headerRowOf, "工事2")
    expect(ex.requiredSheet).toBe("工事2")
    expect(planUserMessage(ex)).toContain("職員がシート「工事2」を計画の元に指定しました")
  })

  test("シートが多くて大きいときは、どのシートも同じように行を減らして上限に収める", () => {
    const big = (name: string) => grid(name, Array.from({ length: 500 }, (_, r) => Array.from({ length: 60 }, (_, c) => `${name}${r}-${c}`)))
    const ex = planExcerpt(Array.from({ length: 8 }, (_, i) => big(`s${i}`)), headerRowOf)
    const cells = ex.sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.cells.length, 0), 0)
    expect(cells).toBeLessThanOrEqual(MAX_EXCERPT_CELLS)
    expect(new Set(ex.sheets.map((s) => s.rows.length)).size).toBe(1)
    expect(ex.sheets[0]!.rows.length).toBeGreaterThanOrEqual(11)
  })

  test("システムプロンプトでシートの選び方を伝える（毎回同じ）", () => {
    expect(systemPrompt(KOJI_KEIREKI)).toContain("行が多くても選ばない")
    expect(systemPrompt(KOJI_KEIREKI)).toContain("写し")
  })
})

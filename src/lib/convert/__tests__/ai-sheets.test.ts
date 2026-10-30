import { describe, expect, test } from "bun:test"
import { newWork, savedWorkSchema, toSavedWork } from "../../cases/state"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { heuristicPlan, planSheets, primarySheet } from "../heuristic-plan"
import { acceptAiPlan, type FieldPlan, type MappingPlan, type SheetGrid } from "../plan"
import { z } from "zod"
import { MAX_EXCERPT_COLUMNS, MAX_EXCERPT_SHEETS, planExcerpt, planExcerptShape, planUserMessage, systemPrompt } from "../prompt"
import { collectSourceRows } from "../sources"

const grid = (name: string, rows: string[][]): SheetGrid => ({ name, rows, hidden: rows.map(() => false) })
const fallbackFor = (g: SheetGrid) => heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
/** 画面と同じ抜粋（planSheets → planExcerpt） */
const excerptOf = (sheets: readonly SheetGrid[], required?: string) => {
  const t = planSheets(KOJI_KEIREKI, KOJI_PLAN_HINTS, sheets, required)
  return planExcerpt(sheets.length, t.sheets, t.required)
}
const excerptSchema = z.object(planExcerptShape)

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
function wireOf(plan: MappingPlan<string>, sheets: number[]) {
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
    amountTax: "unknown",
    fields,
    unusedColumns: [],
    notes: [],
  }
}
const worksWire = (sheets: number[]) => wireOf(fallbackFor(works), sheets)
// book の番号: 0 顧客一覧, 1 工事, 2 工事2, 3 集計, 4 空
const accept = (wire: unknown, sheets: readonly SheetGrid[] = book, required?: string) => acceptAiPlan(KOJI_KEIREKI, sheets, excerptOf(sheets, required), wire, fallbackFor)

describe("計画の AI が選んだシートの取り込み（決まった応答で確認）", () => {
  test("行の多い無関係なシートがあっても、AI が選んだ工事の一覧のシートで計画を作り、行はそのシートのもの。選んだ理由を notes の先頭に残す", () => {
    const r = accept(worksWire([1]))
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.sheets).toEqual(["工事"])
    expect(r.plan.headerRow).toBe(2)
    expect(r.plan.dataRows).toEqual({ start: 3, end: 4 })
    expect(r.plan.notes[0]).toBe("使うシート「工事」: 工事ごとに1行の表")
    expect(collectSourceRows(book, r.plan).rows.map((s) => `${s.sheet}!${s.row}`)).toEqual(["工事!3", "工事!4"])
  })

  test("シートは名前でなく番号で受け取るので、名前に空白や括弧があっても・シートが1枚でも、そのまま使える", () => {
    const odd = grid("工事（2025） ", works.rows)
    const r = accept(wireOf(fallbackFor(odd), [0]), [odd])
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.sheets).toEqual(["工事（2025） "])
  })

  test("見出しが同じシートは2枚目以降に足せる。見出しが違う・送っていない・空・重複したシートは外して notes に残す", () => {
    const r = accept(worksWire([1, 2, 3, 99, 4, 1]))
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.sheets).toEqual(["工事", "工事2"])
    expect(r.plan.notes).toEqual([
      "使うシート「工事」「工事2」: 工事ごとに1行の表",
      "AI が足したシート「集計」は見出しが「工事」と違うため外しました",
      "AI が足したシート「番号 99」は送ったシートに無いため外しました",
      "AI が足したシート「空」は空のため外しました",
    ])
    expect(collectSourceRows(book, r.plan).rows.map((s) => `${s.sheet}!${s.row}`)).toEqual(["工事!3", "工事!4", "工事2!3"])
  })

  test("AI が足した2枚目以降でも、データの行のほとんどが使うシートにある写し（一部を直したもの）は、同じ工事が二重に出るので外す", () => {
    const many = (name: string, edit: boolean) =>
      grid(name, [["表題"], [], HEADER, ...Array.from({ length: 20 }, (_, i) => ["電気工事", edit && i === 3 ? "手直しした工事" : `テスト工事${i}`, "株式会社テスト", "東京都千代田区", "1000000", "2025-06-30"])])
    const full = many("全件", false)
    const copy = many("電気工事", true)
    const r = accept(wireOf(fallbackFor(full), [0, 1]), [full, copy])
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.sheets).toEqual(["全件"])
    expect(r.plan.notes).toContain("AI が足したシート「電気工事」はデータの行の95%が「全件」にもある写しのため外しました")
  })

  test("計画の元のシートが送っていない・空・選ばれていない・職員の指定と違うなら、計画全体を使わない（呼び出し側が見出しからの推定に戻す）", () => {
    for (const [sheets, message] of [
      [[99], "AI が選んだシート（番号 99）は送ったシートにありません"],
      [[4], "AI が選んだシート「空」は空です"],
      [[], "AI の計画に使うシートがありません"],
    ] as const) {
      expect(accept(worksWire([...sheets]))).toEqual({ ok: false, message })
    }
    // 指定があれば、そのシートと見出しが同じシートだけを送るので、ほかのシートは選べない
    expect(accept(worksWire([1]), book, "工事2")).toEqual({ ok: false, message: "AI が指定のシート「工事2」でなく「工事」を選びました" })
    expect(accept(worksWire([0]), book, "工事2")).toEqual({ ok: false, message: "AI が選んだシート（番号 0）は送ったシートにありません" })
    expect(accept(wireOf(fallbackFor(works2), [2]), book, "工事2").ok).toBe(true)
  })

  test("項目ごとの予備は、AI が選んだシートについて見出しから推定したもの（列の番号の意味がシートで変わるため）", () => {
    const bad = { ...worksWire([1]), fields: { ...worksWire([1]).fields, amount: { kind: "column", column: 42, transform: "rule.yenToThousand", instruction: null } } }
    const r = accept(bad)
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.fields.amount).toEqual(fallbackFor(works).fields.amount)
  })

  test("シートが1枚だけなら、シートの理由は notes に出さない", () => {
    const r = accept(worksWire([0]), [works])
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
  test("全部のシートの番号・名前・行数・列数と、データの行が重なるシートを渡す。見出しが工事の項目にあてはまる3枚は詳しく、行の多い顧客一覧などほかは要約だけ", () => {
    const copy = grid("電気工事", works.rows.slice(0, 4))
    const ex = excerptOf([...book, copy])
    expect(ex.sheets.map((s) => [s.index, s.name, s.rowCount, s.columnCount, s.summary])).toEqual([
      [0, "顧客一覧", 201, 2, true],
      [1, "工事", 5, 6, false],
      [2, "工事2", 4, 6, false],
      [3, "集計", 4, 3, true],
      [4, "空", 0, 0, true],
      [5, "電気工事", 4, 6, false],
    ])
    expect(ex.sheets.find((s) => s.name === "電気工事")!.overlap).toEqual({ sheet: "工事", percent: 100 })
    expect(ex.sheets.find((s) => s.name === "空")!.rows).toEqual([])
    const message = planUserMessage(ex)
    expect(message).toContain("ブックの全6枚のシートです")
    expect(message).toContain("### シート 0「顧客一覧」（全201行・2列")
    expect(message).toContain("### シート 3「集計」（全4行・3列、うち非表示0行）要約: 先頭と見出しらしい行のまわりだけ。")
    expect(message).toContain("データの行の100%はシート「工事」にもある。")
    expect(message).toContain("（空のシート）")
    expect(excerptSchema.safeParse(ex).success).toBe(true)
  })

  test("関係ないシートが多くても、工事の一覧の見出しとデータは詳しく残し、抜粋はサーバーの検証の上限に収まる", () => {
    const noise = Array.from({ length: 40 }, (_, i) => grid(`メモ${i}`, Array.from({ length: 300 }, (_, r) => Array.from({ length: 80 }, (_, c) => `m${i}-${r}-${c}`))))
    const sheets = [...noise, works]
    const ex = excerptOf(sheets)
    expect(ex.sheets.length).toBeLessThanOrEqual(MAX_EXCERPT_SHEETS)
    const w = ex.sheets.find((s) => s.name === "工事")!
    expect(w.index).toBe(40)
    expect(w.summary).toBe(false)
    expect(w.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4])
    expect(excerptSchema.safeParse(ex).success).toBe(true)
  })

  test("列の多いシートがあっても、抜粋は左から上限の列までにして、サーバーの検証で落ちない", () => {
    const wide = grid("台帳", [Array.from({ length: 150 }, (_, c) => `列${c}`), Array.from({ length: 150 }, (_, c) => `${c}`)])
    const ex = excerptOf([works, wide])
    const w = ex.sheets.find((s) => s.name === "台帳")!
    expect(w.columnCount).toBe(150)
    expect(Math.max(...w.rows.map((r) => r.cells.length))).toBeLessThanOrEqual(MAX_EXCERPT_COLUMNS)
    expect(w.columns.length).toBeLessThanOrEqual(MAX_EXCERPT_COLUMNS)
    expect(planUserMessage(ex)).toContain("101列目から右は省いた。")
    expect(excerptSchema.safeParse(ex).success).toBe(true)
  })

  test("職員の指定があれば、31枚目以降でもそのシートと見出しが同じシートだけを送り、指定を伝える", () => {
    const noise = Array.from({ length: 35 }, (_, i) => grid(`メモ${i}`, [["メモ"], [`${i}`]]))
    const sheets = [...noise, works, otherHeader, works2]
    const ex = excerptOf(sheets, "工事")
    expect(ex.sheets.map((s) => [s.index, s.name, s.summary])).toEqual([
      [35, "工事", false],
      [37, "工事2", false],
    ])
    expect(ex.requiredSheet).toBe(35)
    expect(planUserMessage(ex)).toContain("職員がシート 35「工事」を計画の元に指定しました")
    expect(acceptAiPlan(KOJI_KEIREKI, sheets, ex, worksWire([35, 37]), fallbackFor)).toMatchObject({ ok: true, plan: { sheets: ["工事", "工事2"] } })
  })

  test("詳しいシートが大きいときは、詳しいシートの行を同じように減らして上限に収める", () => {
    const big = (name: string) => grid(name, [HEADER, ...Array.from({ length: 500 }, (_, r) => Array.from({ length: 100 }, (_, c) => `${name}${r}-${c}`))])
    const ex = excerptOf(Array.from({ length: 8 }, (_, i) => big(`s${i}`)))
    const detailed = ex.sheets.filter((s) => !s.summary)
    expect(detailed).toHaveLength(3)
    expect(new Set(detailed.map((s) => s.rows.length)).size).toBe(1)
    expect(detailed[0]!.rows.length).toBeGreaterThanOrEqual(11)
    expect(excerptSchema.safeParse(ex).success).toBe(true)
  })

  test("システムプロンプトでシートの選び方と、シートを番号で返すことを伝える（毎回同じ）", () => {
    expect(systemPrompt(KOJI_KEIREKI)).toContain("行が多くても選ばない")
    expect(systemPrompt(KOJI_KEIREKI)).toContain("写し")
    expect(systemPrompt(KOJI_KEIREKI)).toContain("シートは名前でなく番号で返す")
  })
})

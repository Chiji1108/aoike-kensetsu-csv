import { describe, expect, test } from "bun:test"
import { compareFormats, describeFormatDiff, similarity, type FormatSide } from "../format-diff"
import type { SheetGrid } from "../plan"

/** 見出しと、列ごとの値の例（2行）から表を作る */
function grid(name: string, columns: [header: string, value: string][], extra: string[][] = []): SheetGrid {
  const rows = [columns.map(([h]) => h), columns.map(([, v]) => v), columns.map(([, v]) => v), ...extra]
  return { name, rows, hidden: rows.map(() => false) }
}

const BASE: [string, string][] = [
  ["工事名", "本社ビル改修工事"],
  ["注文者", "株式会社青池"],
  ["請負金額", "1,200,000"],
  ["着工日", "2025/04/01"],
  ["完成日", "2025/06/30"],
  ["担当", "青池　一郎"],
]

const side = (sheets: SheetGrid[], sheet = sheets[0]!.name, headerRow = 0): FormatSide => ({ sheets, sheet, headerRow })

describe("去年の Excel との形の比べ方", () => {
  test("名前の近さは文字（コードポイント）の2つ組で比べる（サロゲートペアの文字を割らない）", () => {
    expect(similarity("𠮷田商店", "𠮷田工務")).toBeCloseTo(1 / 3)
  })

  test("同じ形なら違いなし", () => {
    const d = compareFormats(side([grid("工事", BASE)]), side([grid("工事", BASE)]))
    expect(d.same).toBe(true)
    expect(describeFormatDiff(d)).toEqual(["比べたシート: 去年「工事」（見出し 1行目）→ 今年「工事」（見出し 1行目）", "シートの構成と見出し・列の並びは去年と同じです。"])
  })

  test("足された列・無くなった列。足しただけでずれた列は並べ替えに入れない", () => {
    const cur: [string, string][] = [["No.", "1"], ["備考", "雨天延期"], ...BASE.filter(([h]) => h !== "担当")]
    const d = compareFormats(side([grid("工事", BASE)]), side([grid("工事", cur)]))
    expect(d.columns.added).toEqual([
      { column: 0, header: "No." },
      { column: 1, header: "備考" },
    ])
    expect(d.columns.removed).toEqual([{ column: 5, header: "担当" }])
    expect(d.columns.moved).toEqual([])
    expect(d.columns.renamed).toEqual([])
  })

  test("名前が変わった列: 名前が近いもの（請負金額→請負金額（税込））と、同じ位置に残った値の種類が同じもの（注文者→発注元）", () => {
    // 注文者は値の傾向も違う（今年は別の会社）ので、位置で対応させる
    const cur = BASE.map(([h, v]): [string, string] => (h === "請負金額" ? ["請負金額（税込）", v] : h === "注文者" ? ["発注元", "青池商店"] : [h, v]))
    const d = compareFormats(side([grid("工事", BASE)]), side([grid("工事", cur)]))
    expect(d.columns.renamed).toEqual([
      { from: { column: 1, header: "注文者" }, to: { column: 1, header: "発注元" }, by: "position" },
      { from: { column: 2, header: "請負金額" }, to: { column: 2, header: "請負金額（税込）" }, by: "name" },
    ])
    expect(d.columns.added).toEqual([])
    expect(d.columns.removed).toEqual([])
    expect(describeFormatDiff(d)[1]).toBe("名前が変わった列: 去年 B列「注文者」 → 今年 B列「発注元」（同じ位置にあるので同じ列とみなした）、去年 C列「請負金額」 → 今年 C列「請負金額（税込）」")
  })

  test("値の種類が違えば、同じ位置でも名前が変わった列とはみなさない", () => {
    const cur = BASE.map(([h, v]): [string, string] => (h === "注文者" ? ["数量", "12"] : [h, v]))
    const d = compareFormats(side([grid("工事", BASE)]), side([grid("工事", cur)]))
    expect(d.columns.renamed).toEqual([])
    expect(d.columns.added).toEqual([{ column: 1, header: "数量" }])
    expect(d.columns.removed).toEqual([{ column: 1, header: "注文者" }])
  })

  test("千円の小数（1234.5）は数の列で、日付の列とは対応させない", () => {
    const prev = [...BASE.slice(0, 2), ["請負（千円）", "1234.5"] as [string, string], ...BASE.slice(3)]
    const cur = [...BASE.slice(0, 2), ["受付日", "2025/04/01"] as [string, string], ...BASE.slice(3)]
    const d = compareFormats(side([grid("工事", prev)]), side([grid("工事", cur)]))
    expect(d.columns.renamed).toEqual([])
    expect(d.columns.removed).toEqual([{ column: 2, header: "請負（千円）" }])
  })

  test("並べ替え: 前後が入れ替わった列だけを出す（見出しの空白・全角半角の違いは同じ名前）", () => {
    const [name, client, amount, start, end, staff] = BASE
    const cur: [string, string][] = [client!, name!, amount!, [" 着工日 ", start![1]], end!, staff!]
    const d = compareFormats(side([grid("工事", BASE)]), side([grid("工事", cur)]))
    expect(d.columns.moved).toHaveLength(1)
    expect(["工事名", "注文者"]).toContain(d.columns.moved[0]!.header)
    expect(d.columns.renamed).toEqual([])
    const lines = describeFormatDiff(d)
    expect(lines.some((l) => l.startsWith("並びが変わった列:"))).toBe(true)
  })

  test("シートの増減と、見出しの行が違うシートどうし", () => {
    const prev = [grid("R6工事", BASE), grid("集計", [["合計", "100"]])]
    const moved = grid("R7工事", [], [])
    moved.rows = [["令和7年度 工事経歴"], ...grid("x", BASE).rows]
    moved.hidden = moved.rows.map(() => false)
    const d = compareFormats(side(prev, "R6工事"), side([moved, grid("集計", [["合計", "100"]]), grid("技術者", [["氏名", "青池　一郎"]])], "R7工事", 1))
    expect(d.sheets).toEqual({ added: ["R7工事", "技術者"], removed: ["R6工事"] })
    expect(d.columns.added).toEqual([])
    expect(d.columns.removed).toEqual([])
    expect(describeFormatDiff(d)).toEqual([
      "比べたシート: 去年「R6工事」（見出し 1行目）→ 今年「R7工事」（見出し 2行目）",
      "増えたシート: 「R7工事」、「技術者」",
      "無くなったシート: 「R6工事」",
    ])
  })

  test("名前を変えて並べ替えた列は、値の傾向がはっきり近ければ対応する（どちらとも取れる日付の列は対応させない）", () => {
    const rows = (pairs: [string, string[]][]) => {
      const g: SheetGrid = { name: "工事", rows: [pairs.map(([h]) => h), ...[0, 1, 2].map((i) => pairs.map(([, vs]) => vs[i]!))], hidden: [false, false, false, false] }
      return side([g])
    }
    const works = ["本社ビル改修工事", "倉庫新築工事", "店舗内装工事"]
    const clients = ["株式会社青池", "株式会社中村建設", "有限会社北商事"]
    const prev = rows([["工事日", ["2025/04/01", "2025/05/10", "2025/06/20"]], ["工事名", works], ["工事先", clients], ["売上金額", ["1,000", "2,000", "3,000"]]])
    const cur = rows([["No.", ["1", "2", "3"]], ["売上金額", ["5,000", "6,000", "7,000"]], ["発注元", ["株式会社南商会", "株式会社青池", "有限会社西工業"]], ["施工日", ["2026/04/02", "2026/05/11", "2026/06/21"]], ["件名", ["事務所改修工事", "工場新築工事", "倉庫内装工事"]]])
    const d = compareFormats(prev, cur)
    expect(d.columns.renamed.map((r) => [r.from.header, r.to.header, r.by])).toEqual([
      ["工事日", "施工日", "values"],
      ["工事名", "件名", "values"],
      ["工事先", "発注元", "values"],
    ])
    expect(d.columns.added).toEqual([{ column: 0, header: "No." }])
    expect(d.columns.removed).toEqual([])
    expect(d.columns.moved.length).toBeGreaterThan(0)
    // 日付の列が2つ残ると、どちらに当たるか決められないので対応させない
    const two = rows([["着工", ["2025/04/01", "2025/05/01", "2025/06/01"]], ["完成", ["2025/04/30", "2025/05/31", "2025/06/30"]]])
    const swapped = rows([["名前1", ["2026/04/01", "2026/05/01", "2026/06/01"]], ["名前2", ["2026/04/30", "2026/05/31", "2026/06/30"]], ["名前3", ["x", "y", "z"]]])
    expect(compareFormats(two, swapped).columns.renamed.some((r) => r.by === "values")).toBe(false)
  })

  test("名前を変えて並べ替えた列も、名前が近ければ対応する", () => {
    const [name, client, amount, start, end, staff] = BASE
    const cur: [string, string][] = [["工事名称", name![1]], ["請負代金額", amount![1]], client!, start!, end!, staff!]
    const d = compareFormats(side([grid("工事", BASE)]), side([grid("工事", cur)]))
    expect(d.columns.renamed.map((r) => [r.from.header, r.to.header])).toEqual([
      ["工事名", "工事名称"],
      ["請負金額", "請負代金額"],
    ])
    expect(d.columns.moved).toHaveLength(1)
    expect(d.columns.added).toEqual([])
    expect(d.columns.removed).toEqual([])
  })
})

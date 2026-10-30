import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { primarySheet, sheetByNames } from "../heuristic-plan"
import type { SheetGrid } from "../plan"

const grid = (name: string, rows: string[][]): SheetGrid => ({ name, rows, hidden: rows.map(() => false) })
const pick = (sheets: SheetGrid[]) => primarySheet(KOJI_KEIREKI, KOJI_PLAN_HINTS, sheets)?.name

const works = grid("工事", [
  ["会計期間：2025年1月1日～2025年12月31日"],
  [],
  ["工種", "工事件名", "発注者", "施工場所", "契約金額（円）", "完成日"],
  ["電気工事", "テストビル電気設備工事", "株式会社テスト商事", "東京都千代田区丸の内1-1", "1200000", "2025-06-30"],
  ["管工事", "テスト病院給排水改修工事", "医療法人テスト会", "千葉県船橋市本町1-1", "800000", "2025-09-30"],
])
// 工事より行の多い、2列だけの顧客一覧（行の数だけで選ぶとこちらになる）
const customers = grid("顧客一覧", [["顧客コード", "顧客名"], ...Array.from({ length: 50 }, (_, i) => [`C${i}`, `株式会社サンプル${i}`])])

describe("変換の元にするシート", () => {
  test("行が多くても、見出しが工事の項目にあてはまらないシートは選ばない", () => {
    expect(pick([customers, works])).toBe("工事")
    expect(pick([works, customers])).toBe("工事")
  })

  test("見出しのあてはまり方が同じなら、空でない行の多いシート", () => {
    const more = grid("工事2", [...works.rows, ["内装仕上", "テスト店舗内装工事", "株式会社テスト物流", "埼玉県さいたま市大宮区桜木町1", "500000", "2025-10-31"]])
    expect(pick([works, more])).toBe("工事2")
  })

  test("空のシートは選ばず、全部空なら無い", () => {
    expect(pick([grid("空", []), works])).toBe("工事")
    expect(pick([grid("空", [[""]])])).toBeUndefined()
  })
})

describe("名前で選ぶシート（画面と照合で、予備の計画の元・去年と比べるシートを同じに選ぶ）", () => {
  const by = (...names: (string | null | undefined)[]) => sheetByNames(KOJI_KEIREKI, KOJI_PLAN_HINTS, [customers, works], ...names)?.name
  test("名前の順に最初にあるシート。どれも無ければ見出しから選んだシート", () => {
    expect(by("顧客一覧")).toBe("顧客一覧")
    expect(by(undefined, "無い", "顧客一覧")).toBe("顧客一覧")
    expect(by(null, "無い")).toBe("工事")
    expect(by()).toBe("工事")
  })
})

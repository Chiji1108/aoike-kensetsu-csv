import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI } from "../../spec/koji-keireki"
import { csvCell, csvFileName, toCsvBytes } from "../csv"
import { decodeCp932, encodeCp932, nonCp932Chars } from "../text"
import { finalizeAll, kojiRow } from "./helpers"

const row = kojiRow({
  gyoshu: "1",
  client: "試験建設株式会社",
  motoukeShitauke: "1",
  jv: "0",
  workName: "試験ビル新築工事",
  prefecture: "東京都",
  place: "千代田区",
  engineer: "試験　太郎",
  amount: "12345",
  specialAmount: "0",
  startYm: "202404",
  endYm: "202409",
  chiefEngineer: "1",
  supervisingEngineer: "0",
})

describe("CSV 出力", () => {
  test("取り込めた実績のある形: 見出し行なし・囲みなし・14列・CRLF（末尾も）・BOM なし", () => {
    const out = toCsvBytes(KOJI_KEIREKI, [row, kojiRow({ gyoshu: "8", chiefEngineer: "0", supervisingEngineer: "1" })])
    expect([...out.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])
    expect(decodeCp932(out)).toBe(
      "1,試験建設株式会社,1,0,試験ビル新築工事,東京都,千代田区,試験　太郎,12345,0,202404,202409,1,0\r\n" + "8,,,,,,,,,,,,0,1\r\n",
    )
  })

  test("行が無ければ空のファイル（見出しも出さない）", () => {
    expect(toCsvBytes(KOJI_KEIREKI, [])).toHaveLength(0)
  })

  test("カンマ・ダブルクォートを含む値は囲んだうえで、検証で警告する", () => {
    const [out] = finalizeAll([{ ...row, cells: { ...row.cells, workName: { ...row.cells.workName, value: "試験,工事" } } }], { replacements: {}, edits: new Map() }).rows
    expect(out!.cells.workName.status).toBe("warning")
    expect(decodeCp932(toCsvBytes(KOJI_KEIREKI, [out!]))).toContain(',"試験,工事",')
  })

  test("カンマ・改行・ダブルクォートを含む値だけを囲む", () => {
    expect(csvCell("普通の値")).toBe("普通の値")
    expect(csvCell("A,B")).toBe('"A,B"')
    expect(csvCell('「"引用"」')).toBe('"「""引用""」"')
    expect(csvCell("1行目\n2行目")).toBe('"1行目\n2行目"')
  })

  test("CP932 特有の文字（～ － ① 髙）が往復で変わらない", () => {
    const s = "～－①髙㈱"
    expect(decodeCp932(encodeCp932(s))).toBe(s)
    expect(nonCp932Chars(s)).toEqual([])
    expect(nonCp932Chars("𠮷野家😀")).toEqual(["𠮷", "😀"])
  })

  test("ファイル名は 工事経歴書_<顧客名>_<YYYYMMDD>.csv", () => {
    expect(csvFileName(KOJI_KEIREKI, "株式会社 青池/建設", new Date(2026, 9, 5))).toBe("工事経歴書_株式会社青池建設_20261005.csv")
  })
})

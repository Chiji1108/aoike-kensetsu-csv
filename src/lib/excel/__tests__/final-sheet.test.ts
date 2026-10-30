import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import { describe, expect, test } from "bun:test"
import * as XLSX from "xlsx"
import { deriveTable, type CaseTable } from "../../cases/view"
import { kojiRow } from "../../convert/__tests__/helpers"
import { toCsvText } from "../../convert/csv"
import { personToken } from "../../convert/persons"
import { KOJI_KEIREKI } from "../../spec/koji-keireki"
import { CHECK_MARK, CHECK_SHEET_NAME, FINAL_SHEET_NAME, finalSheet } from "../final-sheet"
import { finalXlsx } from "../final-xlsx"

const yamada = personToken("山田太郎")
const base = { gyoshu: "8", motoukeShitauke: "1", jv: "0", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", specialAmount: "0", startYm: "202404", endYm: "202409", chiefEngineer: "1", supervisingEngineer: "0" }
const rows = [
  kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事`, amount: "5000" }, 1),
  kojiRow({ ...base, gyoshu: "19", client: "株式会社テスト", workName: "テストﾋﾞﾙ内装工事", amount: "123456789", specialAmount: "" }, 2),
  // 着工年月が無い・場所名が数字だけ（文字列のまま）
  kojiRow({ ...base, client: "㈱サンプル", workName: "サンプル倉庫改修", place: "1234", amount: "1000", startYm: "" }, 3),
]
const table: CaseTable = { rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded", basis: {}, rule7Tax: "excluded" as const, selection: "all", dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT }
const view = deriveTable(table)
const output = view.output

/** 最後の Excel を書き、SheetJS で読む（職員が Excel で開いたとき） */
async function written() {
  const book = XLSX.read(await finalXlsx(await finalSheet(view, { caseId: "case-1", sourceFileId: "file-1", excelKey: "1".repeat(64) })), { type: "array" })
  return { book, ws: book.Sheets[book.SheetNames[0]!]! }
}

/** 開いているシート（SheetJS は読むが、型に無い） */
const activeTab = (book: XLSX.WorkBook) => (book.Workbook as { WBView?: { activeTab?: number }[] } | undefined)?.WBView?.[0]?.activeTab

/** CSV の文字列を、セルの値の並びにする（文字コードと改行は Excel 側の話なので、値で比べる） */
const csvValues = (text: string) => XLSX.utils.sheet_to_json<string[]>(XLSX.read(text, { type: "string", raw: true }).Sheets.Sheet1!, { header: 1, raw: false, defval: "", blankrows: false })

describe("最後の Excel", () => {
  test("データのシートが最初で開いているシート・見出しの行なし・14列で、1行目からデータ。照合用のシートは隠す", async () => {
    const { book, ws } = await written()
    expect(book.SheetNames).toEqual([FINAL_SHEET_NAME, CHECK_SHEET_NAME])
    expect(book.Workbook?.Sheets?.map((s) => s.Hidden)).toEqual([0, 2])
    expect(activeTab(book)).toBe(0)
    expect(ws["!ref"]).toBe(`A1:N${output.length}`)
    expect(ws.A1?.v).toBe(Number(output[0]!.cells.gyoshu.value))
  })

  test("A・C・D・I・J・M・N は数値、B・E・F・G・H・K・L は文字列。空の値は空のセル", async () => {
    const { ws } = await written()
    output.forEach((r, i) => {
      for (const [n, f] of KOJI_KEIREKI.fields.entries()) {
        const cell = ws[XLSX.utils.encode_cell({ r: i, c: n })]
        const v = r.cells[f.id].value
        if (v === "") {
          expect(cell).toBeUndefined()
          continue
        }
        const numeric = "ACDIJMN".includes(f.letter)
        expect({ field: f.id, t: cell?.t }).toEqual({ field: f.id, t: numeric ? "n" : "s" })
        expect(String(cell!.v)).toBe(v)
      }
    })
  })

  test("Excel の「CSV で保存」（開いているシートだけ）の代わりに SheetJS で CSV にすると、今の CSV と同じ値で、照合用のシートの中身は入らない", async () => {
    const { book, ws } = await written()
    const active = book.SheetNames[activeTab(book) ?? -1]
    expect(active).toBe(FINAL_SHEET_NAME)
    const text = XLSX.utils.sheet_to_csv(ws, { blankrows: false })
    const fromExcel = csvValues(text)
    const ours = csvValues(toCsvText(KOJI_KEIREKI, output))
    expect(fromExcel).toEqual(ours)
    expect(ours).toHaveLength(output.length)
    // 匿名化のあとの値（個人名は記号）。照合用の印・行の key は入らない
    expect(JSON.stringify(fromExcel)).not.toContain("山田")
    expect(text).not.toContain(CHECK_MARK)
    expect(text).not.toContain("s!1")
  })

  test("照合用のシートは行の key と落としたときの値（記号の人は「〔Ａ〕」）を持ち、個人名は書かない", async () => {
    const { book } = await written()
    const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets[CHECK_SHEET_NAME]!, { header: 1, raw: false, defval: "" })
    expect(rows[0]!.slice(0, 2)).toEqual([CHECK_MARK, "1"])
    expect(rows.filter((r) => r[0] === "row").map((r) => r[1])).toEqual(output.map((r) => r.key))
    expect(rows.find((r) => r[1] === "s!1")).toContain("〔Ａ〕邸新築工事")
    expect(rows.filter((r) => r[0] === "person").map((r) => r[1])).toEqual(["Ａ"])
    expect(JSON.stringify(rows)).not.toContain("山田")
    // 記号の人のハッシュの鍵は Excel に書かない
    expect(JSON.stringify(rows)).not.toContain("1".repeat(64))
  })
})

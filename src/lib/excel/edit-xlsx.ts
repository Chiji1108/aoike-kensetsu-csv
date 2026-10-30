import ExcelJS from "exceljs"
import { OFFICE_NAME } from "../constants"
import { KEYS_SHEET_NAME, type EditSheet } from "./edit-sheet"

/**
 * 編集用の Excel（中身は edit-sheet.ts）。全セル・全列を文字列の書式（@）にし、Excel が先頭の 0 を消したり日付に変えたりしないようにする
 * （列の書式も文字列にするので、職員が下に足した行も文字列になる）。参考の列は灰色。照合用の列と、落とした行の一覧のシートは隠す。
 * ExcelJS はブラウザだけで読み込む（記入用Excelと同じ）
 */

const TEXT = "@"
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } }
const REFERENCE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } }
const GRAY = { argb: "FF808080" }

export async function editXlsx(sheet: EditSheet): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = OFFICE_NAME
  const ws = wb.addWorksheet(sheet.name)
  sheet.columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1)
    column.width = c.width
    column.numFmt = TEXT
    if (c.hidden) column.hidden = true
    const cell = ws.getCell(1, i + 1)
    cell.value = c.header
    cell.font = { bold: true }
    cell.fill = HEADER_FILL
    cell.alignment = { vertical: "middle", wrapText: true }
  })
  sheet.rows.forEach((r, ri) => {
    r.forEach((value, ci) => {
      const cell = ws.getCell(ri + 2, ci + 1)
      cell.value = value
      cell.numFmt = TEXT
      cell.alignment = { vertical: "top", wrapText: ci < sheet.columns.length - 1 }
      if (sheet.columns[ci]!.reference) {
        cell.fill = REFERENCE_FILL
        cell.font = { color: GRAY }
      }
    })
  })
  ws.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }]
  // 照合用の列（最後の隠し列）も範囲に入れる。フィルタで並べ替えると、値と照合用が同じ行のまま動く
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } }

  const help = wb.addWorksheet("使い方")
  ;[
    "この Excel で表を直して、案件の画面の「Excel で直す」から上げ直してください。直したところが変更案になり、承認したものだけが表に入ります。",
    "・値を直す: セルを書き換えます（個人名は実名のままで構いません。取り込むときに記号にします）。",
    "・CSV に載せる・外す: 「CSVに載せる」の列を「○」か空欄にします。行を消すと「載せない」になります。",
    "・工事を足す: いちばん下の空いた行に書きます（照合用の列は空のまま）。",
    "・並べ替え・絞り込みはしても構いません。行を写して足すと、同じ照合用の行が2つになり、どちらも取り込みません（足すときは空いた行に書いてください）。",
    "・灰色の「参考」の列は取り込みません。隠してある照合用の列とシートは消したり書き換えたりしないでください。",
  ].forEach((t, i) => {
    help.getCell(i + 1, 1).value = t
  })
  help.getColumn(1).width = 120

  const keys = wb.addWorksheet(KEYS_SHEET_NAME, { state: "hidden" })
  keys.getCell(1, 1).value = "落とした行"
  keys.getCell(1, 2).value = "載せていた"
  sheet.keys.forEach((k, i) => {
    keys.getCell(i + 2, 1).value = k.key
    keys.getCell(i + 2, 2).value = k.included ? "○" : ""
    keys.getRow(i + 2).eachCell((c) => (c.numFmt = TEXT))
  })

  return new Uint8Array(await wb.xlsx.writeBuffer())
}

import ExcelJS from "exceljs"
import { OFFICE_NAME } from "../constants"
import { KOJI_KEIREKI } from "../spec/koji-keireki"
import { CHECK_SHEET_NAME, checkSheetRows, FINAL_SHEET_NAME, NUMERIC_FIELDS, type FinalSheet } from "./final-sheet"

/**
 * 最後の Excel（中身は final-sheet.ts）。文字列の列は書式も文字列（@）にし、職員が直したり足したりした値を Excel が数値・日付に変えないようにする
 * （着工年月の 202404 など）。データのシートを最初の・開いているシートにし（「CSV で保存」はこのシートだけを書く）、照合用のシートは
 * 隠す（Excel の画面から再表示もできない veryHidden）。ExcelJS はブラウザだけで読み込む
 */
const WIDTHS = [6, 28, 6, 4, 40, 10, 20, 14, 12, 12, 9, 9, 4, 4]

export async function finalXlsx(sheet: FinalSheet): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = OFFICE_NAME
  const ws = wb.addWorksheet(FINAL_SHEET_NAME)
  KOJI_KEIREKI.fields.forEach((f, i) => {
    const column = ws.getColumn(i + 1)
    column.width = WIDTHS[i] ?? 10
    if (!NUMERIC_FIELDS.has(f.id)) column.numFmt = "@"
  })
  sheet.rows.forEach((r, ri) => {
    r.forEach((v, ci) => {
      if (v === null) return
      const cell = ws.getCell(ri + 1, ci + 1)
      cell.value = v
      if (typeof v === "string") cell.numFmt = "@"
    })
  })
  const check = wb.addWorksheet(CHECK_SHEET_NAME, { state: "veryHidden" })
  checkSheetRows(sheet.check).forEach((r, ri) => {
    r.forEach((v, ci) => {
      const cell = check.getCell(ri + 1, ci + 1)
      cell.value = v
      cell.numFmt = "@"
    })
  })
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: "visible" }]
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

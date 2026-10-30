import ExcelJS from "exceljs"
import { OFFICE_NAME } from "../constants"
import { KOJI_KEIREKI } from "../spec/koji-keireki"
import { FINAL_SHEET_NAME, NUMERIC_FIELDS, type FinalCell } from "./final-sheet"

/**
 * 取り込み用の Excel（中身は final-sheet.ts）。文字列の列は書式も文字列（@）にし、職員が直したり足したりした値を Excel が数値・日付に変えないようにする
 * （着工年月の 202404 など）。ExcelJS はブラウザだけで読み込む（編集用の Excel と同じ）
 */
const WIDTHS = [6, 28, 6, 4, 40, 10, 20, 14, 12, 12, 9, 9, 4, 4]

export async function finalXlsx(rows: readonly FinalCell[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = OFFICE_NAME
  const ws = wb.addWorksheet(FINAL_SHEET_NAME)
  KOJI_KEIREKI.fields.forEach((f, i) => {
    const column = ws.getColumn(i + 1)
    column.width = WIDTHS[i] ?? 10
    if (!NUMERIC_FIELDS.has(f.id)) column.numFmt = "@"
  })
  rows.forEach((r, ri) => {
    r.forEach((v, ci) => {
      if (v === null) return
      const cell = ws.getCell(ri + 1, ci + 1)
      cell.value = v
      if (typeof v === "string") cell.numFmt = "@"
    })
  })
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

import ExcelJS from "exceljs"
import { OFFICE_NAME } from "../constants"
import type { InquirySheet } from "./inquiry"

/**
 * 記入用Excel。記入してほしいセルだけ塗り、他は灰色の文字にする。
 * SheetJS の無料版はセルの書式を書けないので ExcelJS を使う（ブラウザだけで読み込む。ワーカーには入れない）。
 */

const ASK_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } }
const GRAY = { argb: "FF808080" }
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFBFBFBF" } },
  left: { style: "thin", color: { argb: "FFBFBFBF" } },
  bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
  right: { style: "thin", color: { argb: "FFBFBFBF" } },
}

export async function inquiryXlsx(sheet: InquirySheet, customer: string): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = OFFICE_NAME
  const ws = wb.addWorksheet("ご記入のお願い")

  const notes = [
    `${customer ? `${customer} 様　` : ""}工事経歴書の確認のお願い（${OFFICE_NAME}）`,
    `色付きの欄（${sheet.askCount}件）にご記入ください。灰色の文字の欄は確認のためのもので、記入は不要です。`,
    ...sheet.hints,
    "「管理番号」の列は照合に使いますので、消したり書き換えたりしないでください。分からない欄は空欄のままで構いません。",
  ]
  notes.forEach((n, i) => {
    const cell = ws.getCell(i + 1, 1)
    cell.value = n
    cell.font = i === 0 ? { bold: true, size: 13 } : { size: 10 }
  })

  const headerRow = notes.length + 2
  sheet.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width
    if (c.hidden) ws.getColumn(i + 1).hidden = true
    const cell = ws.getCell(headerRow, i + 1)
    cell.value = c.header
    cell.font = { bold: true }
    cell.fill = HEADER_FILL
    cell.border = THIN
    cell.alignment = { vertical: "middle", wrapText: true }
  })

  sheet.rows.forEach((r, ri) => {
    r.cells.forEach((c, ci) => {
      const cell = ws.getCell(headerRow + 1 + ri, ci + 1)
      cell.value = c.value
      cell.border = THIN
      cell.numFmt = "@"
      cell.alignment = { vertical: "top", wrapText: true }
      if (c.note) cell.note = c.note
      if (c.ask) cell.fill = ASK_FILL
      else cell.font = { color: GRAY }
    })
  })
  ws.views = [{ state: "frozen", ySplit: headerRow, xSplit: 1 }]

  return new Uint8Array(await wb.xlsx.writeBuffer())
}

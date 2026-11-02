import ExcelJS from "exceljs"
import type { SheetGrid } from "../convert/plan"
import { readWorkbook } from "../convert/workbook"
import { addInquiryWorksheet, ASK_FILL, HEADER_FILL, inquiryLead } from "./inquiry-xlsx"
import type { Markability } from "./markable"
import { ADDED_SHEET_NAME, MARKED_SHEET_NAME, markedCheckOf, markedSheetRows, type MarkPlan } from "./marked"

/**
 * 印付きの Excel を書く（何を付けるかは marked.ts の planMarks）。元のファイルを ExcelJS で開き、印のセルの塗りだけを変え（値・罫線・文字の書式・
 * 数式・結合・ほかのシートはそのまま）、推定の確かめのメモ・足した列・追加の確認のシート・照合用の隠しシート（veryHidden）を足す。
 * 書いたあと読み直し、元のセルの値がすべて同じかを確かめる（違えば書かない。記入用Excelにする）。ExcelJS はブラウザだけで読み込む
 */
export type MarkedXlsx = { ok: true; bytes: Uint8Array } | { ok: false; reason: string }

function noteText(note: ExcelJS.Cell["note"] | undefined): string {
  if (!note) return ""
  if (typeof note === "string") return note
  return (note.texts ?? []).map((t) => t.text).join("")
}

/** source は変換の元（読んだときのバイト列・シート・印付きにできるか＝markable.ts の markability。取り直さない） */
export async function markedXlsx(source: { name: string; bytes: Uint8Array; sheets: readonly SheetGrid[]; markable: Markability }, plan: MarkPlan, excelKey: string, customer: string): Promise<MarkedXlsx> {
  if (!source.markable.ok) return source.markable
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(source.bytes.slice().buffer as ArrayBuffer)
  } catch {
    return { ok: false, reason: "元のファイルを開き直せないので" }
  }
  if (wb.getWorksheet(MARKED_SHEET_NAME) || wb.getWorksheet(ADDED_SHEET_NAME)) return { ok: false, reason: `元のファイルに「${ADDED_SHEET_NAME}」などのシートがあるので` }

  // 足す列の見出し・推定の値を書くセルに、もとから値や数式（空の文字を返すものも）があれば書かない
  const filled = (ws: ExcelJS.Worksheet, row: number, col: number) => {
    const v = ws.getCell(row + 1, col + 1).value
    return v !== null && v !== undefined && v !== ""
  }
  for (const c of plan.columns) {
    const ws = wb.getWorksheet(c.sheet)
    if (!ws) return { ok: false, reason: "元のファイルのシートが見つからないので" }
    const written = [...(c.headerRow >= 0 ? [c.headerRow] : []), ...plan.cells.flatMap((m) => (m.sheet === c.sheet && m.col === c.col && m.value !== undefined ? [m.row] : []))]
    if (written.some((r) => filled(ws, r, c.col))) return { ok: false, reason: "表の右端の列に値や数式があり、列を足せないので" }
    ws.getColumn(c.col + 1).width = 22
    if (c.headerRow < 0) continue
    const cell = ws.getCell(c.headerRow + 1, c.col + 1)
    const left = c.col > 0 ? ws.getCell(c.headerRow + 1, c.col).style : {}
    // 見出しは左の見出しの書式に合わせ、足した列だと分かるよう灰色に塗る
    cell.style = { ...left, font: { ...left.font, bold: true }, fill: HEADER_FILL }
    cell.value = c.header
  }
  for (const m of plan.cells) {
    const ws = wb.getWorksheet(m.sheet)
    if (!ws) return { ok: false, reason: "元のファイルのシートが見つからないので" }
    const cell = ws.getCell(m.row + 1, m.col + 1)
    // 書式は同じ形のセルで共有されていることがあるので、塗りだけ変えた新しい書式にする（ほかのセルを塗らない）
    cell.style = { ...cell.style, fill: ASK_FILL }
    if (m.value !== undefined) {
      cell.numFmt = "@"
      cell.value = m.value
    }
    if (m.note) {
      const before = noteText(cell.note)
      cell.note = before ? `${m.note}\n――\n${before}` : m.note
    }
  }
  if (plan.added) addInquiryWorksheet(wb, ADDED_SHEET_NAME, plan.added, `${inquiryLead(customer)}（お預かりした表に無い工事）`)
  const check = wb.addWorksheet(MARKED_SHEET_NAME, { state: "veryHidden" })
  ;(await markedSheetRows(plan.check, excelKey)).forEach((r, ri) => {
    r.forEach((v, ci) => {
      const cell = check.getCell(ri + 1, ci + 1)
      cell.numFmt = "@"
      cell.value = v
    })
  })

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await wb.xlsx.writeBuffer())
  } catch {
    return { ok: false, reason: "元のファイルを壊さずに書けないので" }
  }
  return sameValues(source, bytes, plan) ? { ok: true, bytes } : { ok: false, reason: "元のファイルの値を変えずに書けないので" }
}

/** 書いた Excel を読み直し、元のシートの並びと、元のセルの値（足した列の見出しと足した値のセルを除く）がすべて同じで、照合用のシートが読めるか */
function sameValues(source: { name: string; sheets: readonly SheetGrid[] }, bytes: Uint8Array, plan: MarkPlan) {
  const before = source.sheets
  const after = readWorkbook(source.name, bytes)
  if (before.some((s, i) => after[i]?.name !== s.name)) return false
  const ours = new Set([...plan.columns.map((c) => `${c.sheet}\t${c.headerRow}\t${c.col}`), ...plan.cells.flatMap((c) => (c.value !== undefined ? [`${c.sheet}\t${c.row}\t${c.col}`] : []))])
  const mine = (sheet: string, row: number, col: number) => ours.has(`${sheet}\t${row}\t${col}`)
  for (const [i, s] of before.entries()) {
    const t = after[i]!
    const rows = Math.max(s.rows.length, t.rows.length)
    for (let r = 0; r < rows; r++) {
      const width = Math.max(s.rows[r]?.length ?? 0, t.rows[r]?.length ?? 0)
      for (let c = 0; c < width; c++) if (!mine(s.name, r, c) && (s.rows[r]?.[c] ?? "") !== (t.rows[r]?.[c] ?? "")) return false
    }
  }
  const read = markedCheckOf(after)
  return !!read && !("error" in read)
}

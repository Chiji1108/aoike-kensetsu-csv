import * as XLSX from "xlsx"
import type { SheetGrid } from "./plan"
import { decodeCp932 } from "./text"

const pad = (n: number) => String(n).padStart(2, "0")

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return ""
  if (cell.t === "n" && cell.z && XLSX.SSF.is_date(cell.z)) {
    const d = XLSX.SSF.parse_date_code(cell.v as number)
    if (d) return `${d.y}-${pad(d.m)}-${pad(d.d)}`
  }
  if (cell.t === "d" && cell.v instanceof Date) {
    const d = cell.v
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return String(cell.w ?? cell.v).trim()
}

function sheetToGrid(name: string, ws: XLSX.WorkSheet): SheetGrid {
  if (!ws["!ref"]) return { name, rows: [], hidden: [] }
  const range = XLSX.utils.decode_range(ws["!ref"])
  const rows: string[][] = []
  for (let r = 0; r <= range.e.r; r++) {
    const row: string[] = []
    for (let c = 0; c <= range.e.c; c++) row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })]))
    rows.push(row)
  }
  for (const m of ws["!merges"] ?? []) {
    const v = rows[m.s.r]?.[m.s.c] ?? ""
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (rows[r]) rows[r]![c] = v
  }
  while (rows.length && rows[rows.length - 1]!.every((c) => !c)) rows.pop()
  const info = ws["!rows"] ?? []
  const notes = Object.keys(ws).flatMap((ref) => {
    const comments = ref.startsWith("!") ? undefined : (ws[ref] as XLSX.CellObject).c
    if (!comments?.length) return []
    const { r, c } = XLSX.utils.decode_cell(ref)
    const text = comments.map((x) => x.t ?? "").join("\n").trim()
    return text ? [{ row: r, column: c, text }] : []
  })
  return { name, rows, hidden: rows.map((_, r) => !!info[r]?.hidden), ...(notes.length ? { notes } : {}) }
}

/** .xlsx / .xls / .csv を読み、シートごとの表にする。CSV は UTF-8 で読めなければ CP932 として読む */
export function readWorkbook(fileName: string, data: Uint8Array): SheetGrid[] {
  let wb: XLSX.WorkBook
  if (/\.csv$/i.test(fileName)) {
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data)
    } catch {
      text = decodeCp932(data)
    }
    wb = XLSX.read(text.replace(/^﻿/, ""), { type: "string", cellNF: true, raw: true })
  } else {
    wb = XLSX.read(data, { type: "array", cellNF: true, cellStyles: true })
  }
  return wb.SheetNames.map((name) => sheetToGrid(name, wb.Sheets[name]!))
}

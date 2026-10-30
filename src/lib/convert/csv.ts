import type { CsvSpec } from "../spec/types"
import type { RowResult } from "./convert"
import { encodeCp932 } from "./text"

/** カンマ・改行・ダブルクォートを含むときだけ囲む（取込が囲みに対応しているかは分からないので、該当する値は検証で警告する） */
export function csvCell(v: string) {
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
}

/**
 * 建設業.NET 用の CSV 文字列。取り込めた実績のあるファイルと同じ形にする:
 * 見出し行なし（雛形の見出しはセル内改行を含み、「1行目が項目行」では読み飛ばしきれない）、改行は CRLF、末尾も CRLF。
 */
export function toCsvText<F extends string>(spec: CsvSpec<F>, rows: RowResult<F>[]) {
  return rows.map((row) => `${spec.fields.map((f) => csvCell(row.cells[f.id].value)).join(",")}\r\n`).join("")
}

/** CP932（Shift_JIS）、BOM なし */
export function toCsvBytes<F extends string>(spec: CsvSpec<F>, rows: RowResult<F>[]) {
  return encodeCp932(toCsvText(spec, rows))
}

/** 工事経歴書_<顧客名>_<YYYYMMDD>.csv（顧客名のファイル名に使えない文字は除く） */
export function csvFileName<F extends string>(spec: CsvSpec<F>, customer: string, date: Date) {
  return datedFileName(spec.fileNamePrefix, customer, date, "csv")
}

/** `<prefix>_<顧客名>_<YYYYMMDD>.<ext>`（ファイル名に使えない文字と空白は除く） */
export function datedFileName(prefix: string, customer: string, date: Date, ext: string) {
  const name = customer.replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 40) || "顧客"
  const ymd = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("")
  return `${prefix}_${name}_${ymd}.${ext}`
}

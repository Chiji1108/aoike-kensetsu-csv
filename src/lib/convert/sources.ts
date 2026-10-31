import { columnCount as columnCountOf, columnLetter, isDataRow, matchesValues, planColumns, type FieldPlan, type MappingPlan, type RowFilter, type SheetGrid, type SourceRow } from "./plan"
import { matchKey } from "./text"

const TOTAL_ROW_RE = /^(合計|小計|総計|累計|計|総合計)$|^(合計|小計|総計)|(合計|小計|総計)$/

export function rowIsBlank(row: string[] | undefined) {
  return !row || row.every((c) => !c.trim())
}

/**
 * データ行として扱わない行: 空行、使う列がすべて空の行、合計・小計の行、
 * 横に結合した見出し（使う列がすべて同じ値。結合セルは左上の値で埋めるため）。
 */
export function isSkippableRow(row: string[] | undefined, usedColumns: readonly number[]) {
  if (rowIsBlank(row)) return true
  const used = usedColumns.map((c) => row![c]?.trim() ?? "")
  const filled = used.filter(Boolean)
  if (filled.length === 0) return true
  if (filled.length > 1 && filled.length === used.length && new Set(filled).size === 1) return true
  return row!.some((c) => TOTAL_ROW_RE.test(matchKey(c)))
}

export function lastNonBlankRow(grid: SheetGrid) {
  let end = grid.rows.length - 1
  while (end > 0 && rowIsBlank(grid.rows[end])) end--
  return end
}

/** 見出し行の照合用の形（右端の空セルは列数の違いなので無視する） */
function headerSignature(grid: SheetGrid, headerRow: number) {
  const keys = (grid.rows[headerRow] ?? []).map(matchKey)
  while (keys.length && !keys[keys.length - 1]) keys.pop()
  return JSON.stringify(keys)
}

export function sameHeader(a: SheetGrid, b: SheetGrid, headerRow: number) {
  return headerSignature(a, headerRow) === headerSignature(b, headerRow)
}

/** 2枚目以降のシートのデータ行（見出し行の次から最後まで、飛ばす行を除く） */
function extraSheetRows(grid: SheetGrid, headerRow: number, usedColumns: readonly number[]) {
  const rows: number[] = []
  for (let r = headerRow + 1; r <= lastNonBlankRow(grid); r++) if (!isSkippableRow(grid.rows[r], usedColumns)) rows.push(r)
  return rows
}

export const sourceKey = (r: { sheet: string; row: number }) => `${r.sheet}!${r.row}`

/**
 * 計画で選んだシートのデータ行を順に集める。シートをまたいで全く同じ内容の行は、最初の1行だけ残す
 * （業種ごとのシートが「全件」シートにフィルタをかけたものなど）。
 */
export function collectSourceRows<F extends string>(
  sheets: readonly SheetGrid[],
  plan: MappingPlan<F>,
): { rows: SourceRow[]; duplicates: number } {
  const usedColumns = [...new Set(Object.values<FieldPlan>(plan.fields).flatMap(planColumns))]
  const seen = new Map<string, string>()
  const rows: SourceRow[] = []
  let duplicates = 0
  plan.sheets.forEach((name, i) => {
    const grid = sheets.find((s) => s.name === name)
    if (!grid) return
    const indexes =
      i === 0
        ? Array.from({ length: Math.max(0, plan.dataRows.end - plan.dataRows.start + 1) }, (_, k) => plan.dataRows.start + k).filter((r) => isDataRow(plan, r))
        : extraSheetRows(grid, plan.headerRow, usedColumns)
    for (const r of indexes) {
      const cells = grid.rows[r] ?? []
      const content = JSON.stringify(cells.map((c) => c.trim()))
      const first = seen.get(content)
      if (first !== undefined && first !== name) {
        duplicates++
        continue
      }
      if (first === undefined) seen.set(content, name)
      rows.push({ sheet: name, row: r, cells, hidden: grid.hidden[r] ?? false })
    }
  })
  return { rows, duplicates }
}

/** データの行（見出し行より後の、空行・合計行でない行）の内容。右端の空セルは列の範囲の違いなので比べない */
function dataRowKeys(grid: SheetGrid, headerRow: number) {
  const all = Array.from({ length: columnCountOf(grid) }, (_, c) => c)
  const key = (r: string[]) => {
    const cells = r.map((c) => c.trim())
    while (cells.length && !cells[cells.length - 1]) cells.pop()
    return JSON.stringify(cells)
  }
  return new Set(grid.rows.slice(headerRow + 1).filter((r) => !isSkippableRow(r, all)).map(key))
}

/** a のデータの行のうち、b にもある行の割合（0〜1。a にデータの行が無ければ 0） */
function sharedRatio(mine: Set<string>, theirs: Set<string>) {
  if (!mine.size) return 0
  let shared = 0
  for (const row of mine) if (theirs.has(row)) shared++
  return shared / mine.size
}

/** データの行がこの割合以上ほかのシートにあれば、そのシートの写し（フィルタをかけて一部を手直ししたものを含む）とみなす */
export const COPY_RATIO = 0.9

/**
 * シートごとに、データの行（それぞれの見出し行より後）がいちばん多く重なる別のシートと、その割合（0〜1）。重なる行が無ければ入れない。
 * 業種ごとにフィルタをかけた写しのシートを、計画の AI が見分けるための手がかり（抜粋だけでは分からない）。
 * 空行・合計行は比べない（合計行はシートごとに値が変わる。SUBTOTAL など）
 */
export function sheetOverlaps(sheets: readonly { grid: SheetGrid; headerRow: number }[]): Map<string, { sheet: string; ratio: number }> {
  const contents = sheets.map((s) => dataRowKeys(s.grid, s.headerRow))
  const result = new Map<string, { sheet: string; ratio: number }>()
  sheets.forEach((s, i) => {
    let best: { sheet: string; ratio: number } | undefined
    sheets.forEach((o, j) => {
      const ratio = i === j ? 0 : sharedRatio(contents[i]!, contents[j]!)
      if (ratio > 0 && (!best || ratio > best.ratio)) best = { sheet: o.grid.name, ratio }
    })
    if (best) result.set(s.grid.name, best)
  })
  return result
}

/** grid がほかのシート（others）のどれかの写しなら、そのシートと割合（見出し行はどれも headerRow。計画で足す2枚目以降のシートを確かめる） */
export function copiedFrom(grid: SheetGrid, others: readonly SheetGrid[], headerRow: number): { sheet: string; ratio: number } | undefined {
  const mine = dataRowKeys(grid, headerRow)
  for (const o of others) {
    const ratio = sharedRatio(mine, dataRowKeys(o, headerRow))
    if (ratio >= COPY_RATIO) return { sheet: o.name, ratio }
  }
  return undefined
}

/** 行を出力しない理由（除外しないなら undefined） */
export function excludedReason(row: SourceRow, filter: RowFilter): string | undefined {
  if (filter.excludeHidden && row.hidden) return "非表示の行"
  const marked = filter.excludeColumns.find((c) => row.cells[c]?.trim())
  if (marked !== undefined) return `${columnLetter(marked)}列（除外の印）に値がある`
  const value = filter.excludeValues?.find((f) => matchesValues(f, row.cells))
  return value ? `${columnLetter(value.column)}列が「${row.cells[value.column]!.trim()}」` : undefined
}

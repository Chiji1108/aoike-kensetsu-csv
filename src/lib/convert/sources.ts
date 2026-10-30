import { columnCount as columnCountOf, columnLetter, isDataRow, planColumns, type FieldPlan, type MappingPlan, type RowFilter, type SheetGrid, type SourceRow } from "./plan"
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

/** 中身の9割以上が他のシートにあれば、そのシートの写し（フィルタをかけて一部を手直ししたものを含む）とみなす */
const COPY_RATIO = 0.9

/**
 * 最初に選ぶシート: 計画の元のシートと見出しが同じシートのうち、
 * 中身がほぼ他の選んだシートに含まれているもの（フィルタをかけた写しや空のシート）は外す。
 * 合計行はシートごとに値が変わる（SUBTOTAL など）ので比べない。
 */
export function defaultSheetSelection(sheets: readonly SheetGrid[], primary: SheetGrid, headerRow: number): string[] {
  const candidates = sheets.filter((s) => s === primary || sameHeader(s, primary, headerRow))
  const contents = new Map(
    candidates.map((s) => {
      const all = Array.from({ length: columnCountOf(s) }, (_, c) => c)
      const rows = s.rows.slice(headerRow + 1).filter((r) => !isSkippableRow(r, all))
      return [s.name, new Set(rows.map((r) => JSON.stringify(r.map((c) => c.trim()))))]
    }),
  )
  const kept: SheetGrid[] = [primary]
  for (const s of candidates) {
    if (s === primary) continue
    const mine = [...contents.get(s.name)!]
    const covered = kept.some((k) => {
      const theirs = contents.get(k.name)!
      return mine.filter((row) => theirs.has(row)).length >= mine.length * COPY_RATIO
    })
    if (!covered) kept.push(s)
  }
  return kept.map((s) => s.name)
}

/** データが一番多いシート（計画の元にする） */
export function primarySheet(sheets: readonly SheetGrid[]): SheetGrid | undefined {
  let best: SheetGrid | undefined
  let bestCount = 0
  for (const s of sheets) {
    const n = s.rows.filter((r) => !rowIsBlank(r)).length
    if (n > bestCount) [best, bestCount] = [s, n]
  }
  return best
}

/** 行を出力しない理由（除外しないなら undefined） */
export function excludedReason(row: SourceRow, filter: RowFilter): string | undefined {
  if (filter.excludeHidden && row.hidden) return "非表示の行"
  const marked = filter.excludeColumns.find((c) => row.cells[c]?.trim())
  return marked === undefined ? undefined : `${columnLetter(marked)}列（除外の印）に値がある`
}

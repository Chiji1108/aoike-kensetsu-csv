import type { CellResult, CellStatus, RowResult } from "@/lib/convert/convert"
import { askReasonOf } from "@/lib/inquiry/inquiry"

export const STATUS: Record<CellStatus, { label: string; cell: string; dot: string }> = {
  ok: { label: "そのまま", cell: "", dot: "bg-muted-foreground/40" },
  changed: { label: "ルールで変換", cell: "bg-sky-50", dot: "bg-sky-500" },
  ai: { label: "AIで変換", cell: "bg-violet-50", dot: "bg-violet-500" },
  warning: { label: "要確認", cell: "bg-amber-50", dot: "bg-amber-500" },
  error: { label: "エラー", cell: "bg-red-50 text-red-900", dot: "bg-red-500" },
}

/** AI が値を補った（例: 都道府県の補完）セルは、AI の変換でも要確認として黄色で目立たせる */
const needsReview = (c: CellResult) => c.status === "warning" || (c.status === "ai" && !!c.message)

export function cellClass(c: CellResult) {
  return needsReview(c) ? STATUS.warning.cell : STATUS[c.status].cell
}

/** 表の絞り込み。確かめる（CSV に載せる行のうち、確かめるセルがある行）か、すべて（載せない行も） */
export type RowFilter = "check" | "all"

/** AI が推定した値（AI 自身も自信がない値・AI が補った値） */
const aiGuess = (c: CellResult) => c.guessed === true || (c.status === "ai" && !!c.message)

/** 確かめるセル: エラー・要確認・AI の推定・顧客への問い合わせが要る（field はそのセルの項目） */
export const needsCheck = (c: CellResult, field: string) => c.status === "error" || needsReview(c) || aiGuess(c) || askReasonOf(field, c) !== undefined

/** 元データと値が違うセル（ルール・AIで変換、補った値、手直し、顧客の回答）。表のセルの印（data-changed）に使う */
export const changedCell = (c: CellResult) => c.value !== c.original || c.by === "staff" || c.by === "customer" || c.by === "excel" || c.by === "location"

export const ROW_FILTERS: Record<RowFilter, { label: string; empty: string }> = {
  check: { label: "確かめる", empty: "確かめる行" },
  all: { label: "すべて", empty: "行" },
}

/** 行に確かめるセルがあるか */
export function rowNeedsCheck<F extends string>(row: RowResult<F>) {
  return Object.entries<CellResult>(row.cells).some(([field, c]) => needsCheck(c, field))
}

/** 行がその絞り込みに出るか。確かめるは CSV に載せる行だけ（載せない行は「すべて」でだけ見える） */
export function inFilter<F extends string>(filter: RowFilter, row: RowResult<F>, included: boolean, check = rowNeedsCheck(row)) {
  return filter === "all" || (included && check)
}

/** 絞り込みごとの行数（表に出る行の数と同じ） */
export function countRowFilters<F extends string>(
  rows: readonly RowResult<F>[],
  inclusion: ReadonlyMap<string, { included: boolean }>,
  checks?: ReadonlyMap<string, boolean>,
): Record<RowFilter, number> {
  let check = 0
  for (const r of rows) if (inFilter("check", r, inclusion.get(r.key)?.included ?? false, checks?.get(r.key) ?? rowNeedsCheck(r))) check++
  return { check, all: rows.length }
}

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

export type RowFilter = "check" | "ask" | "guessed" | "error" | "review" | "changed" | "all"

/** AI が推定した値（AI 自身も自信がない値・AI が補った値） */
const aiGuess = (c: CellResult) => c.guessed === true || (c.status === "ai" && !!c.message)

/** 表の絞り込み。行のどれかのセルが matches なら表に出す（field はそのセルの項目） */
export const ROW_FILTERS: Record<RowFilter, { label: string; title: string; matches: (c: CellResult, field: string) => boolean }> = {
  check: {
    label: "確かめる行",
    title: "確かめる行（エラー・要確認・AI の推定・顧客への問い合わせが要るセルがある行）",
    matches: (c, field) => c.status === "error" || needsReview(c) || aiGuess(c) || askReasonOf(field, c) !== undefined,
  },
  ask: { label: "問い合わせが要る", title: "顧客への問い合わせが要るセル（データに無い・推定に自信がない）がある行", matches: (c, field) => askReasonOf(field, c) !== undefined },
  guessed: { label: "AI の推定", title: "AI が推定した・補った値のセルがある行", matches: aiGuess },
  error: { label: "エラー", title: "エラーのセルがある行", matches: (c) => c.status === "error" },
  review: { label: "要確認", title: "黄色（要確認）のセルがある行", matches: needsReview },
  changed: {
    label: "変更あり",
    title: "元データと値が違うセル（ルール・AIで変換、補った値、手直し、顧客の回答）がある行",
    matches: (c) => c.value !== c.original || c.by === "staff" || c.by === "customer" || c.by === "excel" || c.by === "location",
  },
  all: { label: "すべて", title: "すべての行", matches: () => true },
}

export const FILTER_ORDER = Object.keys(ROW_FILTERS) as RowFilter[]

/** 行がどの絞り込みに合うか（セルを1回ずつ見る） */
export function rowFilters<F extends string>(row: RowResult<F>): Record<RowFilter, boolean> {
  const cells = Object.entries<CellResult>(row.cells)
  return Object.fromEntries(FILTER_ORDER.map((f) => [f, cells.some(([field, c]) => ROW_FILTERS[f].matches(c, field))])) as Record<RowFilter, boolean>
}

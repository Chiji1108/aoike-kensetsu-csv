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

/** 表の絞り込み。直す（CSV に載せる行のうち、職員が直すセルがある行）か、すべて（載せない行も） */
export type RowFilter = "fix" | "all"

/** AI が推定した値（AI 自身も自信がない値・AI が補った値） */
const aiGuess = (c: CellResult) => c.guessed === true || (c.status === "ai" && !!c.message)

/** 確かめるセル: エラー・要確認・AI の推定・顧客への問い合わせが要る（field はそのセルの項目） */
export const needsCheck = (c: CellResult, field: string) => c.status === "error" || needsReview(c) || aiGuess(c) || askReasonOf(field, c) !== undefined

/** 元データと値が違うセル（ルール・AIで変換、補った値、手直し、顧客の回答）。表のセルの印（data-changed）に使う */
export const changedCell = (c: CellResult) => c.value !== c.original || c.by === "staff" || c.by === "customer" || c.by === "excel" || c.by === "location"

/**
 * 職員が直すセルの理由。empty: 必須が空、error: 値がエラー、review: 要確認、guess: AI の推定。
 * 顧客への問い合わせに回るセル（問い合わせのタブにあり、外していないもの）は ask（直さなくてよい。顧客の答えで埋まる）
 */
export type FixKind = "empty" | "error" | "review" | "guess"
export type CellFixKind = FixKind | "ask"

export const FIX_LABELS: Record<FixKind, string> = { empty: "必須が空", error: "エラー", review: "要確認", guess: "AI の推定" }
export const FIX_KINDS = Object.keys(FIX_LABELS) as FixKind[]

/**
 * セルを誰がどう片付けるか（片付けることが無ければ undefined）。値のあるエラーは職員が直す（顧客に聞いても CSV に載らない）。
 * それ以外で問い合わせに回るものは顧客に聞く。asked は問い合わせを外していないか（外した問い合わせは、空なら片付いた・推定なら職員が確かめる）
 */
export function cellFix(c: CellResult, field: string, asked: boolean): CellFixKind | undefined {
  const ask = askReasonOf(field, c)
  if (c.status === "error") return c.value !== "" ? "error" : ask && asked ? "ask" : "empty"
  if (ask && asked) return "ask"
  if (aiGuess(c)) return "guess"
  if (needsReview(c)) return "review"
  return undefined
}

/** 行の片付けること: 職員が直すセル（fixes）と、顧客に聞くセルの数（ask） */
export type RowFix<F extends string = string> = { fixes: { field: F; kind: FixKind }[]; ask: number }

/** 行の片付けること。isAsked(field) はそのセルの問い合わせを外していないか */
export function rowFix<F extends string>(row: RowResult<F>, isAsked: (field: F) => boolean): RowFix<F> {
  const fixes: RowFix<F>["fixes"] = []
  let ask = 0
  for (const [field, c] of Object.entries<CellResult>(row.cells) as [F, CellResult][]) {
    const kind = cellFix(c, field, isAsked(field))
    if (kind === "ask") ask++
    else if (kind) fixes.push({ field, kind })
  }
  return { fixes, ask }
}

export const NO_FIX: RowFix<never> = { fixes: [], ask: 0 }

/** 表の絞り込みの状態。reason は直すの中の理由、ask は計画の聞き返しの対象の行だけ（載せない行も） */
export type TableFilter = { kind: RowFilter; reason?: FixKind; ask?: string }

export const ROW_FILTERS: Record<RowFilter, { label: string; empty: string }> = {
  fix: { label: "直す", empty: "直す行" },
  all: { label: "すべて", empty: "行" },
}

/** 行がその絞り込みに出るか。直すは CSV に載せる行だけ（載せない行は「すべて」でだけ見える）。asked は聞き返しの対象の行か */
export function inFilter<F extends string>(filter: TableFilter, fix: RowFix<F>, included: boolean, asked: (key: string) => boolean, key: string) {
  if (filter.ask) return asked(key)
  if (filter.kind === "all") return true
  return included && (filter.reason ? fix.fixes.some((f) => f.kind === filter.reason) : fix.fixes.length > 0)
}

/** 直す行の数と、理由ごとの行の数（1行に理由が複数あれば、それぞれに数える）。表・次にやること・書き出すの確認で同じ数を使う */
export type FixCounts = { rows: number; byKind: Record<FixKind, number>; all: number }

export function countFixes<F extends string>(rows: readonly RowResult<F>[], inclusion: ReadonlyMap<string, { included: boolean }>, fixes: ReadonlyMap<string, RowFix<F>>): FixCounts {
  const byKind = Object.fromEntries(FIX_KINDS.map((k) => [k, 0])) as Record<FixKind, number>
  let n = 0
  for (const r of rows) {
    const f = fixes.get(r.key)
    if (!inclusion.get(r.key)?.included || !f?.fixes.length) continue
    n++
    for (const k of new Set(f.fixes.map((x) => x.kind))) byKind[k]++
  }
  return { rows: n, byKind, all: rows.length }
}

import { z } from "zod"
import { CODE_SETS } from "../spec/code-sets"
import type { CsvSpec } from "../spec/types"
import type { ValueType } from "../spec/types"
import type { PlanExcerpt } from "./prompt"
import { copiedFrom, rowIsBlank, sameHeader } from "./sources"
import { TRANSFORM_IDS, getTransform, preferredTransform, transformFits, type TransformId } from "./transforms"

/**
 * ブラウザで読んだシート。セルは表示値（日付は YYYY-MM-DD）、結合セルは左上の値で埋めてある。
 * hidden[i] はその行が非表示（オートフィルタで隠れた行など）か。
 */
export type SheetGrid = { name: string; rows: string[][]; hidden: boolean[] }

/** 計画で選んだシートから取り出した1行（見出し行・合計行などは含まない） */
export type SourceRow = { sheet: string; row: number; cells: string[]; hidden: boolean }

export type FlagColumn = { column: number; code: string }

export type FieldPlan =
  | { kind: "column"; column: number; transform: TransformId; instruction?: string }
  | { kind: "columns"; columns: number[]; transform: TransformId; instruction?: string }
  /** 列ごとに記号（○など）があればそのコード。1行に記号が複数あれば行を複数に分ける（例: 電気工事列・管工事列 → 業種） */
  | { kind: "flagColumns"; columns: FlagColumn[] }
  | { kind: "constant"; value: string; reason: string }
  | { kind: "missing" }

/** 出力しない行。excludeColumns の列に値がある行を除く（例:「工事実績から除外」列） */
export type RowFilter = { excludeHidden: boolean; excludeColumns: number[] }

/** 行・列の番号はすべて 0 始まり（画面では Excel の行番号・列記号で表示する） */
export type MappingPlan<F extends string> = {
  /** 使うシート。先頭が計画の元のシートで、行番号はそのシートのもの。2枚目以降は見出し行が同じシート */
  sheets: string[]
  headerRow: number
  dataRows: { start: number; end: number }
  /** 合計行・小計行・空行など */
  skipRows: number[]
  rowFilter: RowFilter
  amountUnit: "yen" | "thousandYen"
  fields: Record<F, FieldPlan>
  unusedColumns: { column: number; header: string; reason: string }[]
  notes: string[]
}

export function columnCount(grid: SheetGrid) {
  return grid.rows.reduce((n, r) => Math.max(n, r.length), 0)
}

/** 0 → A, 26 → AA */
export function columnLetter(index: number): string {
  let s = ""
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export function planColumns(p: FieldPlan): number[] {
  if (p.kind === "column") return [p.column]
  if (p.kind === "columns") return p.columns
  if (p.kind === "flagColumns") return p.columns.map((c) => c.column)
  return []
}

export function isDataRow<F extends string>(plan: MappingPlan<F>, row: number) {
  return row >= plan.dataRows.start && row <= plan.dataRows.end && !plan.skipRows.includes(row)
}

// ---- AI が返す計画（構造化出力のスキーマ）----

const transformId = z.enum(TRANSFORM_IDS)
const fieldPlanWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), column: z.number().int(), transform: transformId, instruction: z.string().nullable() }),
  z.object({ kind: z.literal("columns"), columns: z.array(z.number().int()), transform: transformId, instruction: z.string().nullable() }),
  z.object({ kind: z.literal("flagColumns"), columns: z.array(z.object({ column: z.number().int(), code: z.string() })) }),
  z.object({ kind: z.literal("constant"), value: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("missing") }),
])

export function mappingPlanWireSchema<F extends string>(spec: CsvSpec<F>) {
  const fields: Record<string, typeof fieldPlanWire> = Object.fromEntries(spec.fields.map((f) => [f.id, fieldPlanWire]))
  // シートを先に決めさせる（見出し行・列番号はそのシートのもの）。シートは抜粋で振った番号で返させる（名前の書き間違いで計画が壊れないように）。
  // 番号は enum にしない（スキーマを毎回同じにしてキャッシュを効かせる。番号は acceptAiPlan で確かめる）
  return z.object({
    sheets: z.array(z.number().int()),
    sheetReason: z.string(),
    headerRow: z.number().int(),
    dataStart: z.number().int(),
    skipRows: z.array(z.number().int()),
    excludeColumns: z.array(z.number().int()),
    amountUnit: z.enum(["yen", "thousandYen"]),
    fields: z.object(fields),
    unusedColumns: z.array(z.object({ column: z.number().int(), header: z.string(), reason: z.string() })),
    notes: z.array(z.string()),
  })
}

/**
 * AI の計画を検証して取り込む。
 * - シートは抜粋で振った番号で受け取る。計画の元のシート（sheets の先頭）が送ったシートに無い・空・職員の指定と違うときは、列の番号の意味が分からないので計画全体を使わない（ok: false）。
 * - 2枚目以降のシートは、無い・空・重複・見出しが計画の元と違うものを外す。
 * - 行・列の範囲外、項目の型に合わない変換は、選んだシートについて見出しから推定した計画（fallbackFor）の値に戻す。
 * 直したことは notes に残す。
 */
export function acceptAiPlan<F extends string>(
  spec: CsvSpec<F>,
  workbook: readonly SheetGrid[],
  excerpt: Pick<PlanExcerpt, "sheets" | "requiredSheet">,
  json: unknown,
  fallbackFor: (grid: SheetGrid) => MappingPlan<F>,
): { ok: true; plan: MappingPlan<F> } | { ok: false; message: string } {
  const parsed = mappingPlanWireSchema(spec).safeParse(json)
  if (!parsed.success) return { ok: false, message: "AI の計画の形式が正しくありません" }
  const wire = parsed.data
  // AI が見たシート（抜粋に入れたシート）だけを使える
  const sent = (i: number) => (excerpt.sheets.some((s) => s.index === i) ? workbook[i] : undefined)
  const [primaryIndex, ...extraIndexes] = wire.sheets
  if (primaryIndex === undefined) return { ok: false, message: "AI の計画に使うシートがありません" }
  const grid = sent(primaryIndex)
  if (!grid) return { ok: false, message: `AI が選んだシート（番号 ${primaryIndex}）は送ったシートにありません` }
  if (grid.rows.every(rowIsBlank)) return { ok: false, message: `AI が選んだシート「${grid.name}」は空です` }
  const required = excerpt.requiredSheet === undefined ? undefined : workbook[excerpt.requiredSheet]
  if (required && grid !== required) return { ok: false, message: `AI が指定のシート「${required.name}」でなく「${grid.name}」を選びました` }
  const fallback = fallbackFor(grid)
  const nRows = grid.rows.length
  const nCols = columnCount(grid)
  const problems: string[] = []

  // データの終わりは AI に決めさせない（AI は抜粋しか見ないので手前で切ることがある）。シートの最後の空でない行までとし、
  // 表の後ろの注記などデータでない行は AI が見える範囲で skipRows に挙げる
  const end = fallback.dataRows.end
  const rowsOk = wire.headerRow >= 0 && wire.headerRow < nRows && wire.dataStart > wire.headerRow && wire.dataStart <= end
  if (!rowsOk) problems.push("AI の見出し行・データの開始行がシートと合わないため、ルールの推定を使いました")
  const headerRow = rowsOk ? wire.headerRow : fallback.headerRow
  const dataRows = rowsOk ? { start: wire.dataStart, end } : fallback.dataRows

  const sheets = [grid.name]
  // 写しのシートを足すと同じ工事が二重に出る（CSV の誤り）ので、AI が足しても決まった処理で外す
  const copyReason = (s: SheetGrid) => {
    const copy = copiedFrom(s, sheets.map((n) => workbook.find((x) => x.name === n)!), headerRow)
    return copy ? `データの行の${Math.floor(copy.ratio * 100)}%が「${copy.sheet}」にもある写しの` : undefined
  }
  for (const i of extraIndexes) {
    const s = sent(i)
    const name = s?.name ?? `番号 ${i}`
    const reason = !s
      ? "送ったシートに無い"
      : sheets.includes(name)
        ? undefined
        : s.rows.every(rowIsBlank)
          ? "空の"
          : !sameHeader(s, grid, headerRow)
            ? `見出しが「${grid.name}」と違う`
            : copyReason(s)
    if (reason) problems.push(`AI が足したシート「${name}」は${reason}ため外しました`)
    else if (!sheets.includes(name)) sheets.push(name)
  }

  const wireFields: Record<string, z.infer<typeof fieldPlanWire>> = wire.fields
  const fields = {} as Record<F, FieldPlan>
  for (const f of spec.fields) {
    const p = wireFields[f.id]!
    const reason = fieldPlanProblem(p, f.valueType, nCols)
    if (reason) {
      problems.push(`${f.label}: ${reason}ため、ルールの推定を使いました`)
      fields[f.id] = fallback.fields[f.id]
      continue
    }
    if (p.kind === "column" || p.kind === "columns") {
      const { instruction, ...rest } = p
      fields[f.id] = instruction ? { ...rest, instruction } : rest
    } else {
      fields[f.id] = p
    }
  }

  const sheetNote = workbook.length > 1 ? [`使うシート「${sheets.join("」「")}」: ${wire.sheetReason.trim() || "（AI の理由なし）"}`] : []
  return {
    ok: true,
    plan: {
      sheets,
      headerRow,
      dataRows,
      // 合計・小計の行はルールでも見つける（AI は抜粋しか見ないので、途中の小計を見落とす）
      skipRows: rowsOk
        ? [...new Set([...wire.skipRows, ...fallback.skipRows])].filter((r) => r >= dataRows.start && r <= dataRows.end).sort((a, b) => a - b)
        : fallback.skipRows,
      rowFilter: { ...fallback.rowFilter, excludeColumns: [...new Set(wire.excludeColumns)].filter((c) => c >= 0 && c < nCols) },
      amountUnit: wire.amountUnit,
      fields,
      unusedColumns: wire.unusedColumns.filter((c) => c.column >= 0 && c.column < nCols),
      notes: [...sheetNote, ...wire.notes, ...problems],
    },
  }
}

/** 項目の計画1つが項目の型とシートの幅に合わない理由（合えば undefined）。AI の計画の取り込みとチャットの計画の変更で同じ決まり */
export function fieldPlanProblem(
  p: z.infer<typeof fieldPlanWire> | FieldPlan,
  vt: ValueType,
  nCols: number,
): string | undefined {
  // 個人名を含みうる項目（注文者・工事名）に定数を書くと、匿名化を通らずに CSV に出る（個人名の項目は匿名化する変換だけ）
  if (p.kind === "constant") return vt.type === "text" && vt.person && p.value.trim() ? "個人名を含みうる項目に定数は使えない" : undefined
  if (p.kind === "missing") return undefined
  if (p.kind === "flagColumns") {
    if (vt.type !== "code") return "記号の列はコードの項目にしか使えない"
    if (p.columns.length === 0 || p.columns.some((c) => c.column < 0 || c.column >= nCols)) return "列番号がシートの範囲外の"
    const bad = p.columns.find((c) => !CODE_SETS[vt.set].some((x) => x.code === c.code))
    return bad ? `コード「${bad.code}」が表に無い` : undefined
  }
  const cols = p.kind === "column" ? [p.column] : p.columns
  if (cols.length === 0 || cols.some((c) => c < 0 || c >= nCols)) return "列番号がシートの範囲外の"
  const t = getTransform(p.transform)
  if (!transformFits(t, vt)) return `変換「${t.label}」はこの項目に使えない`
  if (p.kind === "columns" && !t.multiColumn) return `変換「${t.label}」は複数列を受け取れない`
  if (t.id === "ai.freeform" && !p.instruction) return "AI 変換の指示文が無い"
  return undefined
}

/**
 * 保存済みの計画を、今の変換の決まり（transformFits）で確かめる。使えなくなった変換（工事名の全角にする・注文者の匿名化しない変換など）は
 * その項目で最初に選ぶ変換（preferredTransform）に替え、使えない定数（注文者・工事名の定数）は外して、直した項目の名前を changed に返す。AI の計画の取り込み（acceptAiPlan）と同じ決まり
 */
export function reviewPlanTransforms<F extends string>(spec: CsvSpec<F>, plan: MappingPlan<F>): { plan: MappingPlan<F>; changed: string[] } {
  const changed: string[] = []
  const fields = { ...plan.fields }
  for (const f of spec.fields) {
    const p: FieldPlan = fields[f.id]
    // 定数は新しい計画と同じ決まり（fieldPlanProblem）で確かめ、使えなければ外す（元データに無い扱いにして、顧客に聞く）
    if (p.kind === "constant") {
      if (fieldPlanProblem(p, f.valueType, Number.MAX_SAFE_INTEGER)) {
        fields[f.id] = { kind: "missing" }
        changed.push(f.label)
      }
      continue
    }
    if ((p.kind !== "column" && p.kind !== "columns") || transformFits(getTransform(p.transform), f.valueType)) continue
    const transform = preferredTransform(f.valueType, p.kind === "columns")
    fields[f.id] = p.kind === "column" ? { kind: "column", column: p.column, transform } : { kind: "columns", columns: p.columns, transform }
    changed.push(f.label)
  }
  return { plan: changed.length ? { ...plan, fields } : plan, changed }
}

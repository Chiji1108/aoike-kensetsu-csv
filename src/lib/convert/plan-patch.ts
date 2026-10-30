import { z } from "zod"
import { fieldIdSchema } from "../schemas"
import type { CsvSpec } from "../spec/types"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import { columnCount, columnLetter, fieldPlanProblem, type FieldPlan, type MappingPlan, type SheetGrid } from "./plan"
import { fieldPlanSchema } from "./plan-schema"
import { getTransform, TRANSFORM_IDS } from "./transforms"

/**
 * チャットで列の対応（計画）を直す（チャットの set_plan）。AI は列を Excel の列記号、行を Excel の行番号で書き、ここで計画の 0 始まりの番号にする。
 * 変える項目だけを送り（差分）、承認したときの今の計画に重ねる。確かめ方は AI の計画の取り込み（acceptAiPlan）と同じ決まり
 * （fieldPlanProblem: 項目の型に合う変換か・個人名の項目は匿名化する変換だけか・列がシートの中か）で、合わない差分は全体を受け取らない。
 * 使うシート（計画の元・足すシート）はここでは変えない（変えると列の意味が変わる。画面のファイルの欄で選び直す）
 */

const columnRef = z.string().regex(/^[A-Za-z]{1,3}$/, "列は A・B・AA のような列記号で書いてください")
const transformId = z.enum(TRANSFORM_IDS)
const instruction = z.string().min(1).max(500).optional()

const fieldPlanInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("column"), column: columnRef, transform: transformId, instruction }),
  z.strictObject({ kind: z.literal("columns"), columns: z.array(columnRef).min(1).max(10), transform: transformId, instruction }),
  z.strictObject({ kind: z.literal("flagColumns"), columns: z.array(z.strictObject({ column: columnRef, code: z.string().min(1).max(4) })).min(1).max(40) }),
  z.strictObject({ kind: z.literal("constant"), value: z.string().max(200), reason: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("missing") }),
])

/** チャットの set_plan の引数（列は列記号、行は Excel の行番号） */
export const planPatchInputSchema = z.strictObject({
  fields: z.partialRecord(fieldIdSchema, fieldPlanInputSchema).optional(),
  headerRow: z.number().int().min(1).optional(),
  dataStart: z.number().int().min(1).optional(),
  /** データでない行（合計・小計・注記）。送ると今のものと入れ替える */
  skipRows: z.array(z.number().int().min(1)).max(2000).optional(),
  /** 値があればその行を出さない列。送ると今のものと入れ替える */
  excludeColumns: z.array(columnRef).max(100).optional(),
  amountUnit: z.enum(["yen", "thousandYen"]).optional(),
  /** 職員に見せる、変える理由（1〜2文） */
  reason: z.string().min(1).max(500),
})
export type PlanPatchInput = z.infer<typeof planPatchInputSchema>

/** 計画の差分（計画と同じ 0 始まりの番号。変更案に保存する形） */
export type PlanPatch = {
  fields?: Partial<Record<KojiFieldId, FieldPlan>>
  headerRow?: number
  dataStart?: number
  skipRows?: number[]
  excludeColumns?: number[]
  amountUnit?: "yen" | "thousandYen"
  reason: string
}

export const planPatchSchema: z.ZodType<PlanPatch> = z.object({
  fields: z.partialRecord(fieldIdSchema, fieldPlanSchema).optional(),
  headerRow: z.number().int().min(0).optional(),
  dataStart: z.number().int().min(0).optional(),
  skipRows: z.array(z.number().int().min(0)).max(2000).optional(),
  excludeColumns: z.array(z.number().int().min(0)).max(100).optional(),
  amountUnit: z.enum(["yen", "thousandYen"]).optional(),
  reason: z.string().max(500),
})

/** 列記号 → 0 始まりの列番号（A → 0, AA → 26） */
export function columnIndex(ref: string) {
  return ref
    .toUpperCase()
    .split("")
    .reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1
}

function fieldFromInput(p: z.infer<typeof fieldPlanInputSchema>): FieldPlan {
  switch (p.kind) {
    case "column":
      return { kind: "column", column: columnIndex(p.column), transform: p.transform, ...(p.instruction ? { instruction: p.instruction } : {}) }
    case "columns":
      return { kind: "columns", columns: p.columns.map(columnIndex), transform: p.transform, ...(p.instruction ? { instruction: p.instruction } : {}) }
    case "flagColumns":
      return { kind: "flagColumns", columns: p.columns.map((c) => ({ column: columnIndex(c.column), code: c.code })) }
    case "constant":
    case "missing":
      return p
  }
}

/** set_plan の引数を計画の番号にする（形は zod で確かめたもの） */
export function patchFromInput(input: PlanPatchInput): PlanPatch {
  const fields = input.fields ? (Object.fromEntries(Object.entries(input.fields).flatMap(([f, p]) => (p ? [[f, fieldFromInput(p)]] : []))) as PlanPatch["fields"]) : undefined
  return {
    ...(fields && Object.keys(fields).length ? { fields } : {}),
    ...(input.headerRow !== undefined ? { headerRow: input.headerRow - 1 } : {}),
    ...(input.dataStart !== undefined ? { dataStart: input.dataStart - 1 } : {}),
    ...(input.skipRows ? { skipRows: [...new Set(input.skipRows.map((r) => r - 1))].sort((a, b) => a - b) } : {}),
    ...(input.excludeColumns ? { excludeColumns: [...new Set(input.excludeColumns.map(columnIndex))].sort((a, b) => a - b) } : {}),
    ...(input.amountUnit ? { amountUnit: input.amountUnit } : {}),
    reason: input.reason.trim(),
  }
}

/** 計画の元のシートの大きさ（チャットの差分を確かめる。画面はシートから、サーバーは画面が送った値で） */
export type SheetShape = { rows: number; columns: number }
export const sheetShapeOf = (grid: SheetGrid): SheetShape => ({ rows: grid.rows.length, columns: columnCount(grid) })
export const sheetShapeSchema: z.ZodType<SheetShape> = z.object({ rows: z.number().int().min(0).max(1_000_000), columns: z.number().int().min(0).max(20_000) })

/** 差分に何も入っていない（理由だけ） */
export const isEmptyPatch = (p: PlanPatch) =>
  !p.fields && p.headerRow === undefined && p.dataStart === undefined && !p.skipRows && !p.excludeColumns && p.amountUnit === undefined

/**
 * 差分を計画に重ねる。合わない項目が1つでもあれば、どれも重ねずに理由を返す（AI が直して出し直す。黙って一部だけ入れない）。
 * データの終わりは今の計画のまま（AI の計画の取り込みと同じく、シートの最後の空でない行まで）
 */
export function applyPlanPatch<F extends string>(
  spec: CsvSpec<F>,
  plan: MappingPlan<F>,
  patch: PlanPatch,
  shape: SheetShape,
): { ok: true; plan: MappingPlan<F> } | { ok: false; problems: string[] } {
  const problems: string[] = []
  if (isEmptyPatch(patch)) problems.push("変える項目がありません")
  const fields = { ...plan.fields }
  for (const [id, p] of Object.entries(patch.fields ?? {}) as [F, FieldPlan | undefined][]) {
    const f = spec.fields.find((x) => x.id === id)
    if (!f || !p) continue
    const reason = fieldPlanProblem(p, f.valueType, shape.columns)
    if (reason) problems.push(`${f.label}: ${reason}ため使えません`)
    else fields[id] = p
  }
  const headerRow = patch.headerRow ?? plan.headerRow
  const start = patch.dataStart ?? plan.dataRows.start
  const end = plan.dataRows.end
  if (headerRow < 0 || headerRow >= shape.rows) problems.push(`見出しの行（${headerRow + 1}行目）がシートにありません`)
  if (start <= headerRow || start > end) problems.push(`データの最初の行（${start + 1}行目）は見出しの行より後で、データの最後（${end + 1}行目）までにしてください`)
  const skipRows = patch.skipRows ?? plan.skipRows.filter((r) => r >= start && r <= end)
  const outside = skipRows.filter((r) => r < start || r > end)
  if (outside.length) problems.push(`飛ばす行 ${outside.map((r) => r + 1).join("・")}行目 はデータの範囲の外です`)
  const excludeColumns = patch.excludeColumns ?? plan.rowFilter.excludeColumns
  const wide = excludeColumns.filter((c) => c >= shape.columns)
  if (wide.length) problems.push(`除外の列 ${wide.map(columnLetter).join("・")} はシートの範囲の外です`)
  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    plan: {
      ...plan,
      headerRow,
      dataRows: { start, end },
      skipRows,
      rowFilter: { ...plan.rowFilter, excludeColumns },
      amountUnit: patch.amountUnit ?? plan.amountUnit,
      fields,
    },
  }
}

/** 項目の計画を職員向けに（例:「J列（千円にする）」） */
export function describeFieldPlan(p: FieldPlan) {
  switch (p.kind) {
    case "column":
      return `${columnLetter(p.column)}列（${getTransform(p.transform).label}${p.instruction ? `: ${p.instruction}` : ""}）`
    case "columns":
      return `${p.columns.map(columnLetter).join("＋")}列（${getTransform(p.transform).label}${p.instruction ? `: ${p.instruction}` : ""}）`
    case "flagColumns":
      return `記号の列 ${p.columns.map((c) => `${columnLetter(c.column)}=${c.code}`).join("・")}`
    case "constant":
      return `すべて「${p.value}」`
    case "missing":
      return "元データに無い（空にする）"
  }
}

/** 差分を職員向けの文にする（変更案の一覧に出す）。now は今の計画（あれば「今 → 案」の形にする） */
export function describePlanPatch(patch: PlanPatch, now?: MappingPlan<KojiFieldId>, spec: CsvSpec<KojiFieldId> = KOJI_KEIREKI): string[] {
  const lines: string[] = []
  for (const f of spec.fields) {
    const p = patch.fields?.[f.id]
    if (!p) continue
    lines.push(`${f.label}: ${now ? `${describeFieldPlan(now.fields[f.id])} → ` : ""}${describeFieldPlan(p)}`)
  }
  if (patch.headerRow !== undefined) lines.push(`見出しの行: ${patch.headerRow + 1}行目`)
  if (patch.dataStart !== undefined) lines.push(`データの最初の行: ${patch.dataStart + 1}行目`)
  if (patch.skipRows) lines.push(`飛ばす行: ${patch.skipRows.length ? patch.skipRows.map((r) => r + 1).join("・") + "行目" : "なし"}`)
  if (patch.excludeColumns) lines.push(`値があれば出さない列: ${patch.excludeColumns.length ? patch.excludeColumns.map(columnLetter).join("・") : "なし"}`)
  if (patch.amountUnit) lines.push(`金額の単位: ${patch.amountUnit === "yen" ? "円" : "千円"}`)
  return lines
}

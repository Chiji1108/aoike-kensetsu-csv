import { z } from "zod"
import { fieldIdSchema } from "../schemas"
import type { KojiFieldId } from "../spec/koji-keireki"
import { PLAN_ASK_KINDS, type FieldPlan, type MappingPlan, type ValueFilter } from "./plan"
import { TRANSFORM_IDS } from "./transforms"

/** 保存する計画の形（案件の作業・チャットの計画の変更案・取り消しの記録で共通） */

const transformId = z.enum(TRANSFORM_IDS)

export const fieldPlanSchema: z.ZodType<FieldPlan> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), column: z.number().int(), transform: transformId, instruction: z.string().optional() }),
  z.object({ kind: z.literal("columns"), columns: z.array(z.number().int()), transform: transformId, instruction: z.string().optional() }),
  z.object({ kind: z.literal("flagColumns"), columns: z.array(z.object({ column: z.number().int(), code: z.string() })) }),
  z.object({ kind: z.literal("constant"), value: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("missing") }),
])

export const valueFilterSchema: z.ZodType<ValueFilter> = z.object({ column: z.number().int().min(0), values: z.array(z.string().max(200)).max(20) })

export const mappingPlanSchema: z.ZodType<MappingPlan<KojiFieldId>> = z.object({
  sheets: z.array(z.string()),
  headerRow: z.number().int(),
  dataRows: z.object({ start: z.number().int(), end: z.number().int() }),
  skipRows: z.array(z.number().int()),
  // excludeValues は前の版の保存済みの計画には無い
  rowFilter: z.object({ excludeHidden: z.boolean(), excludeColumns: z.array(z.number().int()), excludeValues: z.array(valueFilterSchema).optional() }),
  amountUnit: z.enum(["yen", "thousandYen"]),
  // 前の版の保存済みの計画には無い
  amountTax: z.enum(["included", "excluded"]).optional(),
  fields: z.record(fieldIdSchema, fieldPlanSchema),
  unusedColumns: z.array(z.object({ column: z.number().int(), header: z.string(), reason: z.string() })),
  notes: z.array(z.string()),
  // 前の版の保存済みの計画には無い（文の notes だけ。知らせとして出す）
  asks: z.array(z.object({ kind: z.enum(PLAN_ASK_KINDS), text: z.string().max(1000), column: z.number().int().min(0), values: z.array(z.string().max(200)).max(20) })).max(5).optional(),
})

export const savedPlanSchema = z.object({ plan: mappingPlanSchema, source: z.enum(["ai", "rule"]), notice: z.string().optional() })

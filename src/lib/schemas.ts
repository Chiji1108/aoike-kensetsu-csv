import { z } from "zod"
import type { CellEdit, Replacements } from "./convert/convert"
import { SELECTION_MODES, type Basis, type SelectionMode, type TaxMode } from "./convert/koji-selection"
import { KOJI_KEIREKI, type KojiFieldId } from "./spec/koji-keireki"

/**
 * 保存・送受信する値の形のうち、いくつもの形で使うもの（案件の作業・変更案・チャットの表）。
 * ほかのモジュールに依らない（型と定義表だけ）ので、どこからでも読める
 */

export const fieldIdSchema = z.enum(KOJI_KEIREKI.fields.map((f) => f.id) as [KojiFieldId, ...KojiFieldId[]])

export const taxSchema: z.ZodType<TaxMode> = z.enum(["unknown", "included", "excluded"])

export const selectionSchema: z.ZodType<SelectionMode> = z.enum(SELECTION_MODES)

/**
 * 載せる工事の選び方の、前の保存の形（alreadyApplied: 7割適用済み＝全行を載せる）を今の形（selection）にそろえる。
 * 前の形の作業・変更案を読むときだけ使う（P4 で「全件を載せる」の切り替えに一つにした）
 */
export function legacySelection(selection: SelectionMode | undefined, alreadyApplied: boolean | undefined): SelectionMode | undefined {
  return selection ?? (alreadyApplied === undefined ? undefined : alreadyApplied ? "all" : "rule7")
}

export const basisSchema: z.ZodType<Basis> = z.record(z.string(), z.object({ total: z.number().optional(), motouke: z.number().optional() }))

export const cellEditSchema: z.ZodType<CellEdit> = z.object({
  value: z.string(),
  by: z.enum(["staff", "customer", "confirmed", "chat", "excel", "location"]),
  status: z.enum(["ai", "warning", "error"]).optional(),
  message: z.string().optional(),
  guessed: z.literal(true).optional(),
  byAi: z.literal(true).optional(),
  ask: z.literal(true).optional(),
})

export const replacementsSchema: z.ZodType<Replacements<KojiFieldId>> = z.partialRecord(fieldIdSchema, z.record(z.string(), cellEditSchema))

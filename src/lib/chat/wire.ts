import { z } from "zod"
import type { CellResult, RowResult } from "../convert/convert"
import { basisSchema, cellEditSchema, fieldIdSchema, replacementsSchema, selectionSchema, taxSchema } from "../schemas"
import type { CaseTable } from "../cases/view"
import { addedRowSchema, MAX_ADDED_ROWS } from "../cases/added"
import type { KojiFieldId } from "../spec/koji-keireki"

/** 画面からチャットのサーバーへ送る案件の表（CaseTable の Map を組の配列にしたもの） */
export type CaseTableWire = Omit<CaseTable, "rows" | "edits" | "manual"> & {
  rows: RowResult<KojiFieldId>[]
  edits: [string, z.infer<typeof cellEditSchema>][]
  manual: [string, boolean][]
}

export const toWire = (t: CaseTable): CaseTableWire => ({ ...t, rows: [...t.rows], edits: [...t.edits], manual: [...t.manual] })
export const fromWire = (w: CaseTableWire): CaseTable => ({ ...w, edits: new Map(w.edits), manual: new Map(w.manual) })

const cellResult: z.ZodType<CellResult> = z.object({
  value: z.string(),
  status: z.enum(["ok", "changed", "ai", "warning", "error"]),
  source: z.string(),
  original: z.string(),
  message: z.string().optional(),
  guessed: z.literal(true).optional(),
  byAi: z.literal(true).optional(),
  stored: z.string().optional(),
  withheld: z.literal(true).optional(),
  by: z.enum(["staff", "customer", "confirmed", "chat", "excel", "location"]).optional(),
  ask: z.literal(true).optional(),
})

const row: z.ZodType<RowResult<KojiFieldId>> = z.object({
  key: z.string(),
  sheet: z.string(),
  row: z.number().int(),
  excluded: z.string().optional(),
  cells: z.record(fieldIdSchema, cellResult),
})

export const caseTableWireSchema: z.ZodType<CaseTableWire> = z.object({
  rows: z.array(row).max(20_000),
  added: z.array(addedRowSchema).max(MAX_ADDED_ROWS),
  edits: z.array(z.tuple([z.string(), cellEditSchema])),
  replacements: replacementsSchema,
  manual: z.array(z.tuple([z.string(), z.boolean()])),
  tax: taxSchema,
  basis: basisSchema,
  selection: selectionSchema,
  includeAtLeastYen: z.number().optional(),
  sorted: z.boolean(),
})

import { z } from "zod"
import type { CellResult, RowResult } from "../convert/convert"
import { basisSchema, cellEditSchema, fieldIdSchema, replacementsSchema, roundingSchema, rule7TaxSchema, selectionSchema, taxSchema } from "../schemas"
import type { CaseTable } from "../cases/view"
import { addedRowSchema, MAX_ADDED_ROWS } from "../cases/added"
import { EMPTY_INQUIRY_TEXT, inquiryTextSchema } from "../inquiry/text"
import type { KojiFieldId } from "../spec/koji-keireki"

/** 画面からチャットのサーバーへ送る案件の表（CaseTable の Map を組の配列にしたもの） */
export type CaseTableWire = Omit<CaseTable, "rows" | "edits" | "manual" | "dismissed"> & {
  rows: RowResult<KojiFieldId>[]
  edits: [string, z.infer<typeof cellEditSchema>][]
  manual: [string, boolean][]
  dismissed: string[]
}

export const toWire = (t: CaseTable): CaseTableWire => ({ ...t, rows: [...t.rows], edits: [...t.edits], manual: [...t.manual], dismissed: [...t.dismissed] })
export const fromWire = (w: CaseTableWire): CaseTable => ({ ...w, edits: new Map(w.edits), manual: new Map(w.manual), dismissed: new Set(w.dismissed) })

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
  /** 7割の計算。無い形（この項目より前の画面が送る表）は税抜（前はいつも税抜） */
  rule7Tax: rule7TaxSchema.default("excluded"),
  selection: selectionSchema,
  /** 金額の千円未満の扱い。無い形（この項目より前の画面が送る表）は切り捨て（新しい案件の初期値） */
  rounding: roundingSchema.default("floor"),
  /** 外した問い合わせと問い合わせのメールの件名・前置き。無い形（この項目より前の画面が送る表）は空 */
  dismissed: z.array(z.string().max(300)).max(50_000).default([]),
  inquiryText: inquiryTextSchema.default(EMPTY_INQUIRY_TEXT),
})

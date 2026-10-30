import { z } from "zod"
import { AI_TASKS, type AiItemResult } from "../convert/ai-tasks"
import type { CellEdits, Replacements } from "../convert/convert"
import type { Basis, SelectionMode, TaxMode } from "../convert/koji-selection"
import type { AiCache } from "../convert/pipeline"
import type { Rounding } from "../convert/transforms"
import type { MappingPlan } from "../convert/plan"
import { savedPlanSchema } from "../convert/plan-schema"
import type { AnswerReport, CellInquiry } from "../inquiry/inquiry"
import { proposalSchema, type Proposal } from "../chat/proposals"
import { addedRowSchema, MAX_ADDED_ROWS, type AddedRow } from "./added"
import { basisSchema, cellEditSchema, fieldIdSchema, legacySelection, replacementsSchema, selectionSchema, taxSchema } from "../schemas"
import type { KojiFieldId } from "../spec/koji-keireki"

/**
 * 案件の画面の作業（メモリの形）。変換の結果（行）は持たない。行は元のファイル・計画・端数・AI の結果（aiCache）から
 * runConversion で作り直せる（AI は呼ばない）ので、converted で「変換したか」だけを持つ。
 */
export type CaseWork = {
  /** 変換の元にするファイル（csv_case_files の id） */
  sourceFileId: string | null
  /** AI か見出しの推定で決まった列の対応。考えている途中は null（開き直すと考え直す） */
  plan: SavedPlan | null
  converted: boolean
  /** 変換で AI を使えなかった理由 */
  aiNotice: string | null
  aiCache: AiCache
  edits: CellEdits
  replacements: Replacements<KojiFieldId>
  manual: ReadonlyMap<string, boolean>
  dismissed: ReadonlySet<string>
  answers: AnswerReport | null
  tax: TaxMode
  basis: Basis
  /** 載せる工事の選び方（koji-selection.ts の SelectionMode） */
  selection: SelectionMode
  rounding: Rounding
  sorted: boolean
  threshold: { on: boolean; yen: string }
  /** チャットの変更案の状態（中身は R2。lib/chat/proposals.ts）。この項目より前に保存した作業には無いので、読むときは空 */
  proposals: Proposal[]
  /** 元のファイルに無い、足した工事（cases/added.ts。値は edits）。この項目より前に保存した作業には無いので、読むときは空 */
  added: AddedRow[]
}

export type SavedPlan = { plan: MappingPlan<KojiFieldId>; source: "ai" | "rule"; notice?: string }

export const newWork = (sourceFileId: string | null = null): CaseWork => ({
  sourceFileId,
  plan: null,
  converted: false,
  aiNotice: null,
  aiCache: new Map(),
  edits: new Map(),
  replacements: {},
  manual: new Map(),
  dismissed: new Set(),
  answers: null,
  tax: "unknown",
  basis: {},
  selection: "rule7",
  rounding: "floor",
  sorted: true,
  threshold: { on: false, yen: "" },
  proposals: [],
  added: [],
})

// ---- 保存する形（D1 の csv_case_states.json）。Map・Set は組の配列にする ----

/** AI の結果は種類ごとに項目が違う。strict にして、項目の多い結果（persons 付きなど）が少ない形に削られないようにする */
const aiResult: z.ZodType<AiItemResult | { error: string }> = z.union([
  ...[...new Set(Object.values(AI_TASKS).map((t) => t.item))].map((item) => z.strictObject(item.shape)),
  z.strictObject({ error: z.string() }),
])

const cellInquiry: z.ZodType<CellInquiry> = z.object({
  kind: z.literal("cell"),
  rowKey: z.string(),
  field: fieldIdSchema,
  reason: z.enum(["missing", "needsReview"]),
  current: z.string(),
})
const at = { rowKey: z.string(), field: fieldIdSchema }

const answerReport: z.ZodType<AnswerReport> = z.object({
  edits: z.array(z.tuple([z.string(), cellEditSchema])),
  applied: z.array(cellInquiry),
  unknownKeys: z.array(z.string()),
  unreadable: z.array(z.object({ line: z.number().int(), rowKey: z.string(), reason: z.string() })),
  duplicateKeys: z.array(z.string()),
  unanswered: z.array(cellInquiry),
  confirmed: z.array(cellInquiry),
  alreadyApplied: z.array(cellInquiry),
  changed: z.array(z.object({ ...at, now: z.string(), answer: z.string() })),
  alsoChanged: z.array(z.object({ ...at, was: z.string(), answer: z.string() })),
  heldBack: z.array(z.object({ ...at, answer: z.string() })),
  needsCheck: z.array(z.object({ ...at, answer: z.string(), message: z.string() })),
  invalid: z.array(z.object({ inquiry: cellInquiry, answer: z.string(), message: z.string() })),
})

/** 手直しのたびに保存する作業（AI の結果を除く。小さい） */
export const savedWorkSchema = z
  .object({
  sourceFileId: z.string().nullable(),
  plan: savedPlanSchema.nullable(),
  converted: z.boolean(),
  aiNotice: z.string().nullable(),
  edits: z.array(z.tuple([z.string(), cellEditSchema])),
  replacements: replacementsSchema,
  manual: z.array(z.tuple([z.string(), z.boolean()])),
  dismissed: z.array(z.string()),
  answers: answerReport.nullable(),
  tax: taxSchema,
  basis: basisSchema,
  selection: selectionSchema.optional(),
  /** 前の形（7割適用済み＝全行を載せる）。読むときに selection にそろえる */
  alreadyApplied: z.boolean().optional(),
  rounding: z.enum(["floor", "round"]),
  sorted: z.boolean(),
  threshold: z.object({ on: z.boolean(), yen: z.string() }),
  proposals: z.array(proposalSchema).default([]),
  added: z.array(addedRowSchema).max(MAX_ADDED_ROWS).default([]),
  })
  .transform(({ alreadyApplied, selection, ...w }) => ({ ...w, selection: legacySelection(selection, alreadyApplied) ?? "rule7" }))
export type SavedWork = z.infer<typeof savedWorkSchema>

/** AI の結果（大きい。変換したときだけ変わるので、変わったときだけ保存する） */
export const savedAiCacheSchema = z.array(z.tuple([z.string(), aiResult]))
export type SavedAiCache = z.infer<typeof savedAiCacheSchema>

export function toSavedWork({ aiCache: _, ...w }: CaseWork): SavedWork {
  return { ...w, edits: [...w.edits], manual: [...w.manual], dismissed: [...w.dismissed] }
}

export const toSavedAiCache = (cache: AiCache): SavedAiCache => [...cache]

export function fromSaved(w: SavedWork, aiCache: SavedAiCache): CaseWork {
  return { ...w, aiCache: new Map(aiCache), edits: new Map(w.edits), manual: new Map(w.manual), dismissed: new Set(w.dismissed) }
}

/** D1 の1行に入る大きさ（D1 の上限は 2,000,000 バイト。少し余裕を持たせる）。作業と AI の結果はそれぞれ別の行 */
export const MAX_STATE_BYTES = 1_900_000

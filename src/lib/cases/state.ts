import { z } from "zod"
import { AI_TASKS, type AiItemResult } from "../convert/ai-tasks"
import type { CellEdits, Replacements } from "../convert/convert"
import type { Basis, Rule7Tax, SelectionMode, TaxMode } from "../convert/koji-selection"
import type { AiCache } from "../convert/pipeline"
import type { Rounding } from "../convert/transforms"
import type { MappingPlan } from "../convert/plan"
import { savedPlanSchema } from "../convert/plan-schema"
import type { AnswerReport, CellInquiry } from "../inquiry/inquiry"
import { proposalSchema, type Proposal } from "../chat/proposals"
import { EMPTY_INQUIRY_TEXT, inquiryTextSchema, type InquiryText } from "../inquiry/text"
import { addedRowSchema, MAX_ADDED_ROWS, type AddedRow } from "./added"
import { undoEntrySchema, type UndoEntry } from "./undo"
import { basisSchema, cellEditSchema, fieldIdSchema, legacySelection, replacementsSchema, roundingSchema, rule7TaxSchema, selectionSchema, taxSchema } from "../schemas"
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
  /**
   * 計画の AI が見出し・注記から決めた税込・税抜（tax に入れた値）。tax がこの値のままなら計画が決めたもので、計画をやり直すと計画に合わせ直す。
   * 職員が決めたら null。前の作業には無いので、読むときは null
   */
  planTax: "included" | "excluded" | null
  basis: Basis
  /** 7割の計算（基準額が税抜か税込か）。新しい案件は事務所の設定、この項目より前に保存した作業は税抜（前はいつも税抜） */
  rule7Tax: Rule7Tax
  /** 載せる工事の選び方（koji-selection.ts の SelectionMode） */
  selection: SelectionMode
  rounding: Rounding
  /** チャットの変更案の状態（中身は R2。lib/chat/proposals.ts）。この項目より前に保存した作業には無いので、読むときは空 */
  proposals: Proposal[]
  /** 元のファイルに無い、足した工事（cases/added.ts。値は edits）。この項目より前に保存した作業には無いので、読むときは空 */
  added: AddedRow[]
  /** 承認の取り消しの記録（cases/undo.ts）。この項目より前に保存した作業には無いので、読むときは空 */
  undo: UndoEntry[]
  /** 変換の報告の聞き返しへの答え（聞き返しの id → 答え。例: 金額の税込・税抜を「顧客に聞く」）。前の作業には無いので、読むときは空 */
  reportAnswers: Record<string, string>
  /** 問い合わせの文面（承認した AI の質問の文・職員が直した文、メールの件名・前置き。lib/inquiry/text.ts）。前の作業には無いので、読むときは空 */
  inquiryText: InquiryText
}

/**
 * 計画の税込・税抜（plan.amountTax）を案件の税の設定に入れる。入れるのは、まだ決まっていない（分からない・聞き返しに答えていない）か、
 * 前の計画が決めた値のままのときだけ（職員が決めた値は上書きしない）。計画が分からなければ、前の計画が決めた値を外して分からないに戻す
 */
export function withPlanTax(w: CaseWork, plan: MappingPlan<KojiFieldId>): CaseWork {
  const byPlan = w.planTax !== null && w.tax === w.planTax
  const open = byPlan || (w.tax === "unknown" && !w.reportAnswers.tax)
  if (!open) return w.planTax === null ? w : { ...w, planTax: null }
  if (plan.amountTax) return { ...w, tax: plan.amountTax, planTax: plan.amountTax }
  return byPlan ? { ...w, tax: "unknown", planTax: null } : w
}

export type SavedPlan = { plan: MappingPlan<KojiFieldId>; source: "ai" | "rule"; notice?: string }

export const newWork = (sourceFileId: string | null = null, rule7Tax: Rule7Tax = "excluded"): CaseWork => ({
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
  planTax: null,
  basis: {},
  rule7Tax,
  selection: "rule7",
  rounding: "floor",
  proposals: [],
  added: [],
  undo: [],
  reportAnswers: {},
  inquiryText: EMPTY_INQUIRY_TEXT,
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
  planTax: z.enum(["included", "excluded"]).nullable().default(null),
  basis: basisSchema,
  rule7Tax: rule7TaxSchema.default("excluded"),
  selection: selectionSchema.optional(),
  /** 前の形（7割適用済み＝全行を載せる）。読むときに selection にそろえる */
  alreadyApplied: z.boolean().optional(),
  rounding: roundingSchema,
  proposals: z.array(proposalSchema).default([]),
  added: z.array(addedRowSchema).max(MAX_ADDED_ROWS).default([]),
  undo: z.array(undoEntrySchema).default([]),
  reportAnswers: z.record(z.string(), z.string().max(100)).default({}),
  inquiryText: inquiryTextSchema.default(EMPTY_INQUIRY_TEXT),
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

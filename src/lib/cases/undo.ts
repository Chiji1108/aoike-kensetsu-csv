import { z } from "zod"
import type { CellEdit, CellEdits } from "../convert/convert"
import type { Basis, SelectionMode } from "../convert/koji-selection"
import { savedPlanSchema } from "../convert/plan-schema"
import { basisSchema, cellEditSchema, selectionSchema } from "../schemas"
import { setTax, taxSettingSchema, type TaxBy, type TaxSetting } from "./tax"
import type { AddedRow } from "./added"
import { addedRowSchema } from "./added"
import type { SavedPlan } from "./state"
import { diffInquiryText, inquiryTextDiffSchema, revertInquiryText, type InquiryText, type InquiryTextDiff } from "../inquiry/text"

/**
 * 承認の取り消し。変更案を承認するたびに、承認で変わった値の前と後を1件の記録にして案件の作業に残す（保存・2つのタブの食い違いは作業と同じ仕組み）。
 * 取り消すと、記録の「後」のままの値だけを「前」に戻す。承認のあとに職員や別の承認が同じ値を変えていたら、その値は戻さずに数えて知らせる
 * （新しい手直しを黙って消さない）。そのため、どの記録も（直前のものでなくても）取り消せる。
 * 外に書いたもの（全体ルール・顧客ルールへの追記、顧客の覚えた工事場所）は戻さない。記録の external に残し、画面でそう伝える
 */

/** 記録に戻せる作業の部分 */
export type Undoable = {
  edits: CellEdits
  manual: ReadonlyMap<string, boolean>
  added: readonly AddedRow[]
  tax: TaxSetting["tax"]
  taxBy: TaxBy | null
  selection: SelectionMode
  basis: Basis
  plan: SavedPlan | null
  inquiryText: InquiryText
  /** 変換の報告の聞き返しへの答え（答えを取り消すと聞き返しを開き直す） */
  reportAnswers: Record<string, string>
}

type Pair<T> = [before: T, after: T]

export type UndoEntry = {
  id: string
  /** どの変更案の承認か（変更案の一覧から取り消せる） */
  proposalId: string
  /** 承認した変更案の項目の番号（振り返りで、取り消した項目を数える。この項目より前の記録には無い） */
  items?: number[]
  label: string
  at: number
  /** [手直しの鍵, 前, 後]（null は無かった） */
  edits: [string, CellEdit | null, CellEdit | null][]
  manual: [string, boolean | null, boolean | null][]
  /** 承認で足した行（取り消すと外す） */
  added: AddedRow[]
  /** 税の設定と出どころ（一緒に戻す） */
  tax?: Pair<TaxSetting>
  selection?: Pair<SelectionMode>
  basis?: Pair<Basis>
  plan?: Pair<SavedPlan | null>
  /** 問い合わせの文面（この項目より前の記録には無い） */
  inquiryText?: InquiryTextDiff
  /** 変換の報告の聞き返しへの答え（この項目より前の記録には無い） */
  reportAnswers?: [string, string | null, string | null][]
  /** 戻さない外への書き込み */
  external: ("rule" | "location")[]
  /** 記録が大きすぎて中身を残さなかった（取り消せない） */
  tooLarge?: true
  undone?: true
}

/** 残す記録の数と大きさ（案件の作業は D1 の1行に入れるので、取り消しの記録で埋めない） */
export const MAX_UNDO_ENTRIES = 30
export const MAX_UNDO_BYTES = 200_000

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** 承認の前後の作業から、取り消しの記録を作る。何も変わっていなければ（外への書き込みも無ければ）null */
export function undoEntry(
  before: Undoable,
  after: Undoable,
  meta: { id: string; proposalId: string; items?: number[]; label: string; at: number; external?: UndoEntry["external"] },
): UndoEntry | null {
  const edits: UndoEntry["edits"] = []
  for (const [k, v] of after.edits) if (before.edits.get(k) !== v) edits.push([k, before.edits.get(k) ?? null, v])
  for (const [k, v] of before.edits) if (!after.edits.has(k)) edits.push([k, v, null])
  const manual: UndoEntry["manual"] = []
  for (const [k, v] of after.manual) if (before.manual.get(k) !== v) manual.push([k, before.manual.get(k) ?? null, v])
  const had = new Set(before.added.map((a) => a.key))
  const added = after.added.filter((a) => !had.has(a.key))
  // 聞き返しの答えは聞き返しごと（ほかの聞き返しにあとで答えても、この答えだけを戻せる）
  const answers: [string, string | null, string | null][] = [...new Set([...Object.keys(before.reportAnswers), ...Object.keys(after.reportAnswers)])].flatMap((k) =>
    before.reportAnswers[k] === after.reportAnswers[k] ? [] : [[k, before.reportAnswers[k] ?? null, after.reportAnswers[k] ?? null] as [string, string | null, string | null]],
  )
  const text = before.inquiryText === after.inquiryText ? null : diffInquiryText(before.inquiryText, after.inquiryText)
  const entry: UndoEntry = {
    ...meta,
    external: meta.external ?? [],
    edits,
    manual,
    added,
    ...(before.tax !== after.tax || before.taxBy !== after.taxBy
      ? { tax: [{ tax: before.tax, taxBy: before.taxBy }, { tax: after.tax, taxBy: after.taxBy }] as Pair<TaxSetting> }
      : {}),
    ...(before.selection !== after.selection ? { selection: [before.selection, after.selection] as Pair<SelectionMode> } : {}),
    ...(!same(before.basis, after.basis) ? { basis: [before.basis, after.basis] as Pair<Basis> } : {}),
    ...(before.plan !== after.plan && !same(before.plan, after.plan) ? { plan: [before.plan, after.plan] as Pair<SavedPlan | null> } : {}),
    ...(text ? { inquiryText: text } : {}),
    ...(answers.length ? { reportAnswers: answers } : {}),
  }
  const changed = edits.length || manual.length || added.length || entry.tax || entry.selection || entry.basis || entry.plan || entry.inquiryText || entry.reportAnswers
  if (!changed && !entry.external.length) return null
  return entry
}

/** 記録の大きさ（UTF-8 のバイト数。案件の作業の上限 MAX_STATE_BYTES と同じ測り方） */
const sizeOf = (e: UndoEntry) => new TextEncoder().encode(JSON.stringify(e)).byteLength

/**
 * 記録を足す。数と大きさの上限を超えたら古いものから捨てる。1件だけで上限を超える記録は中身を捨て、取り消せない印だけを残す
 */
export function pushUndo(list: readonly UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const kept: UndoEntry =
    sizeOf(entry) > MAX_UNDO_BYTES ? { id: entry.id, proposalId: entry.proposalId, ...(entry.items ? { items: entry.items } : {}), label: entry.label, at: entry.at, edits: [], manual: [], added: [], external: entry.external, tooLarge: true } : entry
  const next = [...list, kept]
  let bytes = next.reduce((n, e) => n + sizeOf(e), 0)
  while (next.length > MAX_UNDO_ENTRIES || (bytes > MAX_UNDO_BYTES && next.length > 1)) bytes -= sizeOf(next.shift()!)
  return next
}

/** 取り消せる記録か（取り消した・中身が無い・戻す値が無いものは取り消せない） */
export const canUndo = (e: UndoEntry) =>
  !e.undone && !e.tooLarge && (e.edits.length > 0 || e.manual.length > 0 || e.added.length > 0 || !!e.tax || !!e.selection || !!e.basis || !!e.plan || !!e.inquiryText || !!e.reportAnswers?.length)

export type UndoResult<W> = { work: W; reverted: number; kept: number; planChanged: boolean }

/**
 * 記録を取り消す。「後」のままの値だけを「前」に戻し、承認のあとに変わった値は残して kept に数える。
 * 足した行は、その行の値を後から変えていなければ外す。計画を戻したら planChanged（変換し直す）
 */
export function undo<W extends Undoable & { undo: readonly UndoEntry[] }>(work: W, entryId: string): UndoResult<W> | null {
  const entry = work.undo.find((e) => e.id === entryId)
  if (!entry || !canUndo(entry)) return null
  let reverted = 0
  let kept = 0
  const edits = new Map(work.edits)
  const keptKeys = new Set<string>()
  for (const [k, before, after] of entry.edits) {
    if (!same(edits.get(k) ?? null, after)) {
      kept++
      keptKeys.add(k)
      continue
    }
    if (before) edits.set(k, before)
    else edits.delete(k)
    reverted++
  }
  const manual = new Map(work.manual)
  for (const [k, before, after] of entry.manual) {
    if ((manual.get(k) ?? null) !== after) {
      kept++
      continue
    }
    if (before === null) manual.delete(k)
    else manual.set(k, before)
    reverted++
  }
  // 足した行は、その行のセルを承認のあとに変えていなければ外す。記録の「後」と違うセルか、記録に無い項目の手直しがあれば行を残して数える
  const recorded = new Set(entry.edits.map(([k]) => k))
  const ofRow = (key: string, k: string) => k.startsWith(`${key}:`) && !k.slice(key.length + 1).includes(":")
  const removed = new Set<string>()
  for (const a of entry.added) {
    const laterEdits = [...work.edits.keys()].filter((k) => ofRow(a.key, k) && !recorded.has(k))
    if ([...keptKeys].some((k) => ofRow(a.key, k)) || laterEdits.length) kept += laterEdits.length
    else removed.add(a.key)
  }
  reverted += removed.size
  const revert = <T>(pair: Pair<T> | undefined, now: T): T => {
    if (!pair) return now
    if (!same(now, pair[1])) {
      kept++
      return now
    }
    reverted++
    return pair[0]
  }
  const answersAfter = { ...work.reportAnswers }
  for (const [k, before, after] of entry.reportAnswers ?? []) {
    if ((answersAfter[k] ?? null) !== after) {
      kept++
      continue
    }
    if (before === null) delete answersAfter[k]
    else answersAfter[k] = before
    reverted++
  }
  const plan = revert(entry.plan, work.plan)
  const tax = revert(entry.tax, { tax: work.tax, taxBy: work.taxBy })
  // 問い合わせの文面は質問ごと・件名・前置きごとに戻す（あとで直した文は残す）
  const text = entry.inquiryText ? revertInquiryText(work.inquiryText, entry.inquiryText) : { text: work.inquiryText, reverted: 0, kept: 0 }
  reverted += text.reverted
  kept += text.kept
  const next: W = {
    ...work,
    edits,
    manual,
    added: work.added.filter((a) => !removed.has(a.key)),
    selection: revert(entry.selection, work.selection),
    basis: revert(entry.basis, work.basis),
    plan,
    inquiryText: text.text,
    reportAnswers: answersAfter,
    undo: work.undo.map((e) => (e.id === entryId ? { ...e, undone: true as const } : e)),
  }
  return { work: setTax(next, tax.tax, tax.taxBy), reverted, kept, planChanged: plan !== work.plan }
}

const pair = <T extends z.ZodType>(s: T) => z.tuple([s, s])

export const undoEntrySchema: z.ZodType<UndoEntry> = z.object({
  id: z.string(),
  proposalId: z.string(),
  items: z.array(z.number().int().min(0)).optional(),
  label: z.string(),
  at: z.number(),
  edits: z.array(z.tuple([z.string(), cellEditSchema.nullable(), cellEditSchema.nullable()])),
  manual: z.array(z.tuple([z.string(), z.boolean().nullable(), z.boolean().nullable()])),
  added: z.array(addedRowSchema),
  tax: pair(taxSettingSchema).optional(),
  selection: pair(selectionSchema).optional(),
  basis: pair(basisSchema).optional(),
  plan: pair(savedPlanSchema.nullable()).optional(),
  inquiryText: inquiryTextDiffSchema.optional(),
  reportAnswers: z.array(z.tuple([z.string(), z.string().max(100).nullable(), z.string().max(100).nullable()])).optional(),
  external: z.array(z.enum(["rule", "location"])),
  tooLarge: z.literal(true).optional(),
  undone: z.literal(true).optional(),
})

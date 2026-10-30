import { z } from "zod"
import { editKey, type CellEdit, type CellEdits, type RowResult } from "../convert/convert"
import { addedRowSchema, type AddedRow } from "../cases/added"
import type { Basis, SelectionMode, TaxMode } from "../convert/koji-selection"
import { basisSchema, cellEditSchema, fieldIdSchema, legacySelection, selectionSchema, taxSchema } from "../schemas"
import type { KojiFieldId } from "../spec/koji-keireki"
import { foundSchema, siteRefSchema, SOURCE_LABELS, type Found } from "../location/sites"
import { planPatchSchema, type PlanPatch } from "../convert/plan-patch"
import { proposedRuleSourceSchema, ruleScopeSchema, type ProposedRuleSource, type RuleScope } from "./rules"
import { introSchema, questionTargetsSchema, questionTextSchema, subjectSchema, type QuestionTarget } from "../inquiry/text"

/**
 * 変更案。AI（チャット）や返ってきた Excel が出した変更は、すぐには表に入れず、職員が項目ごとかまとめて承認したものだけを
 * 手直し（edits）・手動の入れ外し（manual）・7割の設定に重ねる。検証・7割・問い合わせ・CSV は今の仕組みのまま。
 */

export type { RuleScope }

/** 変更の1項目。cell の edit は個人名を印にした値（記号の表に依らないので、承認するまでに記号が付け直されても同じ人） */
export type ChatChange =
  | { kind: "cell"; rowKey: string; field: KojiFieldId; edit: CellEdit }
  /** 顧客に問い合わせる（値は残し、推定の印と理由を付ける） */
  | { kind: "ask"; rowKey: string; field: KojiFieldId; reason: string }
  | { kind: "include"; rowKey: string; include: boolean }
  /**
   * 元のファイルに無い工事を足す（返ってきた Excel の管理番号の無い行、PDF から AI が作った行）。cells の値は個人名を印にしたもの。
   * rowKey は足す行の key（変更案を作るときに決める。承認すると cases/added.ts の AddedRow になり、値は手直しとして重ねる）
   */
  | { kind: "add"; rowKey: string; by: AddedRow["by"]; cells: Partial<Record<KojiFieldId, CellEdit>> }
  | { kind: "settings"; tax?: TaxMode; selection?: SelectionMode; basis?: Basis }
  /** 全体ルール・顧客ルールへの追記（承認すると保存する）。source は足した項目の由来（chat: 職員が頼んだ追記、review: 案件を終えるときの振り返り） */
  | { kind: "rule"; scope: RuleScope; text: string; source: ProposedRuleSource }
  /**
   * 列の対応（計画）の差分（convert/plan-patch.ts）。承認すると、そのときの計画に重ねて変換し直す（表の値は変換し直した値になり、手直しはその上に重なる）。
   * 表の変更ではないので、ここ（applyChanges）では何もしない。before は変更案を作ったときの同じ項目の値（「前 → 後」で見せる。前の変更案には無い）
   */
  | { kind: "plan"; patch: PlanPatch; before?: PlanPatch }
  /**
   * 調べた工事場所（lib/location）。同じ現場（工事名・注文者）の行の都道府県・場所名をまとめて変える。承認すると要確認の値として入り、
   * 顧客の覚えた結果に足す（server/location.ts の rememberLocations。site は外に送ってよい値だけ）
   */
  | ({ kind: "location"; site: { key: string; workName: string; client: string }; rowKeys: string[] } & Found)
  /**
   * 顧客への問い合わせの質問の文（lib/inquiry/text.ts）。targets の問い合わせをこの文で聞く。承認すると案件の作業の問い合わせの文面に足す
   * （表の変更ではないので、ここ〔applyChanges〕では何もしない）
   */
  | { kind: "inquiry"; text: string; targets: QuestionTarget[] }
  /** 問い合わせのメールの件名と前置き（承認すると案件の作業の問い合わせの文面にする） */
  | { kind: "inquiryMail"; subject: string; intro: string }

export type Decision = "pending" | "applied" | "rejected"

/** 出どころ。P3b の Excel の取り込みも同じ形で変更案を出す */
export type ProposalOrigin = { kind: "chat"; messageId: string } | { kind: "excel"; fileId: string } | { kind: "location"; runId: string }

/**
 * AI の聞き返し（「これでよいですか」）。答えるまで承認できない。no と答えたら全部を却下する
 */
export type ProposalQuestion = { text: string; answer: "yes" | "no" | null }

/**
 * 変更案の状態（案件の作業に保存する）。変更の中身（ChatChange の並び）は作ったあと変えないので、作業とは別に R2 の
 * cases/<caseId>/proposals/<id>.json に置く（proposalKey）。開いている変更案は中身の件数と、決めた項目の番号だけを持つ
 * （まとめて承認・却下すると閉じるので、作業の大きさは変更の件数に比例しない）。決め終わった変更案は件数だけを残す
 */
export type Proposal = { id: string; origin: ProposalOrigin; question: ProposalQuestion | null } & (
  | { state: "open"; count: number; applied: number[]; rejected: number[] }
  | { state: "closed"; applied: number; rejected: number }
)
export type OpenProposal = Extract<Proposal, { state: "open" }>

export const proposalPrefix = (caseId: string) => `cases/${caseId}/proposals/`
export const proposalKey = (caseId: string, proposalId: string) => `${proposalPrefix(caseId)}${proposalId}.json`

/**
 * R2 に置く変更案の記録（作ったときの状態と中身）。サーバーが置くので、画面が返事を受け取り損ねても、
 * 開き直すと案件の作業に入る（withRecorded）
 */
export type ProposalRecord = { proposal: Proposal; changes: ChatChange[] }

/** 案件の作業にまだ無い変更案を足す（作業にあるものは作業の状態が正しい） */
export function withRecorded(proposals: readonly Proposal[], records: readonly ProposalRecord[]): Proposal[] {
  const known = new Set(proposals.map((p) => p.id))
  return [...proposals, ...records.filter((r) => !known.has(r.proposal.id)).map((r) => r.proposal)]
}

/** changes を重ねたあとの足した行の数（もう足してある key は数えない） */
export function addedCountAfter(added: readonly AddedRow[], changes: readonly ChatChange[]) {
  const keys = new Set(added.map((a) => a.key))
  for (const c of changes) if (c.kind === "add") keys.add(c.rowKey)
  return keys.size
}

/** 決める前に要らなくなった変更案（変換の元を変えたなど）を閉じる。未決は却下にする */
export const discard = (p: Proposal): Proposal =>
  p.state === "open" ? { id: p.id, origin: p.origin, question: p.question, state: "closed", applied: p.applied.length, rejected: p.count - p.applied.length } : p

export function newProposal(id: string, origin: ProposalOrigin, changes: readonly ChatChange[], question: string | null): Proposal {
  return { id, origin, question: question ? { text: question, answer: null } : null, state: "open", count: changes.length, applied: [], rejected: [] }
}

export function decisionOf(p: OpenProposal, index: number): Decision {
  return p.applied.includes(index) ? "applied" : p.rejected.includes(index) ? "rejected" : "pending"
}

export const pendingOf = (p: OpenProposal) => Array.from({ length: p.count }, (_, i) => i).filter((i) => decisionOf(p, i) === "pending")

export const isAnswered = (p: Proposal) => p.question === null || p.question.answer === "yes"

/** 項目（index）を承認・却下する。未決が無くなったら閉じる。聞き返しに答える前は承認できない */
export function decide(p: Proposal, indices: readonly number[], decision: "applied" | "rejected"): Proposal {
  if (p.state !== "open" || (decision === "applied" && !isAnswered(p))) return p
  const chosen = [...new Set(indices)].filter((i) => i >= 0 && i < p.count && decisionOf(p, i) === "pending")
  const next = { ...p, [decision]: [...p[decision], ...chosen].sort((a, b) => a - b) }
  if (next.applied.length + next.rejected.length < next.count) return next
  return { id: p.id, origin: p.origin, question: p.question, state: "closed", applied: next.applied.length, rejected: next.rejected.length }
}

/** 聞き返しに答える。no なら残りを全部却下する。未決が無くなれば閉じる */
export function answer(p: Proposal, a: "yes" | "no"): Proposal {
  if (!p.question || p.question.answer !== null) return p
  const answered = { ...p, question: { ...p.question, answer: a } }
  if (answered.state !== "open") return answered
  // 未決が無ければ（変更案の無い聞き返しも）ここで閉じる
  return a === "no" ? decide(answered, pendingOf(answered), "rejected") : decide(answered, [], "applied")
}

/** 基準額は業種ごと・項目ごとに重ねる（送られなかった項目は今の値を残す） */
function mergeBasis(now: Basis, patch: Basis): Basis {
  const next = { ...now }
  for (const [code, b] of Object.entries(patch)) next[code] = { ...now[code], ...Object.fromEntries(Object.entries(b ?? {}).filter(([, v]) => v !== undefined)) }
  return next
}

/** 承認した変更を重ねる先（案件の作業とチャットの表に共通の部分） */
export type Overlay = { edits: CellEdits; manual: ReadonlyMap<string, boolean>; tax: TaxMode; basis: Basis; selection: SelectionMode; added: readonly AddedRow[] }

/**
 * 変更を重ねる。edited は今の手直しまで当てた行（ask の今の値を読む）。rule は保存する側が受け持つので、ここでは何もしない
 */
export function applyChanges<T extends Overlay>(target: T, edited: readonly RowResult<KojiFieldId>[], changes: readonly ChatChange[]): T {
  if (!changes.length) return target
  const edits = new Map(target.edits)
  const manual = new Map(target.manual)
  let { tax, basis, selection } = target
  const added = [...target.added]
  const rowOf = new Map(edited.map((r) => [r.key, r]))
  for (const c of changes) {
    switch (c.kind) {
      case "cell":
        edits.set(editKey(c.rowKey, c.field), c.edit)
        break
      case "ask": {
        const key = editKey(c.rowKey, c.field)
        const value = edits.get(key)?.value ?? rowOf.get(c.rowKey)?.cells[c.field].value ?? ""
        // 値があれば推定として確かめてもらい、空ならデータに無いものとして聞く
        edits.set(key, { value, by: "chat", status: "warning", ask: true, ...(value ? { guessed: true as const } : {}), message: `顧客に確認: ${c.reason}` })
        break
      }
      case "include":
        manual.set(c.rowKey, c.include)
        break
      case "add":
        if (!added.some((a) => a.key === c.rowKey)) added.push({ key: c.rowKey, by: c.by })
        for (const [field, edit] of Object.entries(c.cells)) if (edit) edits.set(editKey(c.rowKey, field), edit)
        break
      case "settings":
        tax = c.tax ?? tax
        selection = c.selection ?? selection
        basis = c.basis ? mergeBasis(basis, c.basis) : basis
        break
      case "location": {
        const message = locationMessage(c)
        const note = { by: "location" as const, status: "warning" as const, message, ...(c.confident ? {} : { guessed: true as const }) }
        for (const rowKey of c.rowKeys) {
          edits.set(editKey(rowKey, "prefecture"), { ...note, value: c.prefecture })
          // 場所名が分からなかった（都道府県だけ）ときは、今の場所名を残す
          if (c.place) edits.set(editKey(rowKey, "place"), { ...note, value: c.place })
        }
        break
      }
      case "rule":
      case "plan":
      case "inquiry":
      case "inquiryMail":
        break
      default:
        c satisfies never
    }
  }
  return { ...target, edits, manual, tax, basis, selection, added }
}

/** 調べた工事場所のセルに添える文（出どころ・根拠の URL・AI の迷った点） */
export function locationMessage(f: Pick<Found, "source" | "urls" | "note">) {
  return [SOURCE_LABELS[f.source], f.urls.length ? `根拠: ${f.urls.join(" ")}` : "根拠の URL なし", f.note].filter(Boolean).join(" / ")
}

// ---- 保存する形（状態は案件の作業の JSON、中身は R2） ----

export const chatChangeSchema: z.ZodType<ChatChange> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cell"), rowKey: z.string(), field: fieldIdSchema, edit: cellEditSchema }),
  z.object({ kind: z.literal("ask"), rowKey: z.string(), field: fieldIdSchema, reason: z.string() }),
  z.object({ kind: z.literal("include"), rowKey: z.string(), include: z.boolean() }),
  z.object({ kind: z.literal("add"), rowKey: addedRowSchema.shape.key, by: addedRowSchema.shape.by, cells: z.partialRecord(fieldIdSchema, cellEditSchema) }),
  // 前の形の変更案（alreadyApplied）も読む
  z
    .object({ kind: z.literal("settings"), tax: taxSchema.optional(), selection: selectionSchema.optional(), alreadyApplied: z.boolean().optional(), basis: basisSchema.optional() })
    .transform(({ alreadyApplied, selection, ...c }) => {
      const s = legacySelection(selection, alreadyApplied)
      return { ...c, ...(s ? { selection: s } : {}) }
    }),
  // 前の変更案には由来が無い（チャットの追記だけだった）
  z.object({ kind: z.literal("rule"), scope: ruleScopeSchema, text: z.string(), source: proposedRuleSourceSchema.default("chat") }),
  z.object({ kind: z.literal("plan"), patch: planPatchSchema, before: planPatchSchema.optional() }),
  foundSchema.extend({
    kind: z.literal("location"),
    site: siteRefSchema,
    rowKeys: z.array(z.string()).min(1).max(20_000),
  }),
  z.object({ kind: z.literal("inquiry"), text: questionTextSchema, targets: questionTargetsSchema }),
  z.object({ kind: z.literal("inquiryMail"), subject: subjectSchema, intro: introSchema }),
])

export const proposalSchema: z.ZodType<Proposal> = (() => {
  const base = {
    id: z.string(),
    origin: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("chat"), messageId: z.string() }),
      z.object({ kind: z.literal("excel"), fileId: z.string() }),
      z.object({ kind: z.literal("location"), runId: z.string() }),
    ]),
    question: z.object({ text: z.string(), answer: z.enum(["yes", "no"]).nullable() }).nullable(),
  }
  return z.discriminatedUnion("state", [
    z.object({ ...base, state: z.literal("open"), count: z.number().int().min(0), applied: z.array(z.number().int()), rejected: z.array(z.number().int()) }),
    z.object({ ...base, state: z.literal("closed"), applied: z.number().int(), rejected: z.number().int() }),
  ])
})()

export const proposalRecordSchema: z.ZodType<ProposalRecord> = z.object({ proposal: proposalSchema, changes: z.array(chatChangeSchema) })

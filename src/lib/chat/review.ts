import { z } from "zod"
import type { UndoEntry } from "../cases/undo"
import { baseRows, type CaseTable, type TableView } from "../cases/view"
import type { CellEdit } from "../convert/convert"
import { RULE7_TAX_LABELS, SELECTION_LABELS, TAX_LABELS } from "../convert/koji-selection"
import { withNames } from "../convert/persons"
import type { Rounding } from "../convert/transforms"
import { tryParseJson } from "../json"
import { basisSchema, selectionSchema, taxSchema } from "../schemas"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import { appliedCount, nameScrubber, namesForCarryover, namesOfCase, NAME_MARK, personalNameTest, undoneProposals } from "./carryover"
import type { ChatMessage } from "./messages"
import type { Proposal, ProposalQuestion } from "./proposals"

/**
 * 案件を終えるときの振り返り。その年の会話（職員の指示・付いた変更案の承認・AI の聞き返しと答え・列の対応の変更・7割の設定）と、
 * 表の手直し・置換・入れ外しをまとめて AI に渡し（チャットの get_review）、来年のための顧客ルールの追記案と今年だけの事情を分けて出させる
 * （propose_review）。追記案は変更案にして、職員が項目ごとに承認したものだけを顧客ルールに足す（由来は review）。
 * 個人名は渡す材料からも伏せ（表の印の人は〔個人名〕、集めた名前は去年のコードと同じ nameScrubber）、追記案に入っていれば受け取らない
 */

/** 案件を「完了」にしたときにチャットの案内から送る指示 */
export const REVIEW_PROMPT = "この案件を終えます。今年の指示・手直し・列の対応の変更・聞き返しの答えを振り返って、来年のための顧客ルールの案を出して（今年だけの事情は分けて）"

/** 1回の propose_review で出せる毎年の決まり・今年だけの事情の数 */
export const MAX_REVIEW_RULES = 15
export const MAX_REVIEW_NOTES = 20

/** 振り返る1回の指示 */
export type ReviewTurn = {
  instruction: string
  /** 返事に付いた変更案（無ければ null）。applied は承認した項目の数、undone は承認をすべて取り消した、open はまだ決めていない項目がある */
  proposal: { applied: number; count: number; open: boolean; undone: boolean } | null
  /** AI の聞き返しと職員の答え */
  question: ProposalQuestion | null
  /** 列の対応の変更（set_plan の説明） */
  plan: string[]
  /** 7割の設定の変更（set_selection） */
  selection: string[]
  /** 表を変える・調べる道具（読むだけの道具とコード実行は除く） */
  tools: string[]
}

/** 振り返りに名前を出さない道具（読むだけ・コード実行・振り返りそのもの。照合も同じものを使う） */
export const QUIET_TOOLS: ReadonlySet<string> = new Set(["code_execution", "get_table", "check_table", "get_inquiries", "get_review"])

const planOutput = z.object({ ok: z.literal(true), changes: z.array(z.string()) })
const selectionInput = z.object({ tax: taxSchema.optional(), selection: selectionSchema.optional(), basis: basisSchema.optional() })

/** 7割の設定の変更（set_selection の入力・変更案の settings）を言葉にする */
export function describeSelection(input: unknown): string[] {
  const s = selectionInput.safeParse(input)
  if (!s.success) return []
  return [
    s.data.tax && `Excel の金額: ${TAX_LABELS[s.data.tax]}`,
    s.data.selection && `載せる工事: ${SELECTION_LABELS[s.data.selection]}`,
    s.data.basis && `基準額: 業種${Object.keys(s.data.basis).join("・")}`,
  ].filter((x): x is string => !!x)
}

/**
 * 画面の会話（会話を終えても残る）と変更案の状態から、振り返る指示を会話の順に。返事が無い指示（止めた・失敗した）も、変更案の無い指示も残す
 */
export function reviewTurnsFromUi(ui: readonly ChatMessage[], proposals: readonly Proposal[], undo: readonly Pick<UndoEntry, "proposalId" | "undone">[]): ReviewTurn[] {
  const byId = new Map(proposals.map((p) => [p.id, p]))
  const undone = undoneProposals(undo)
  const turns: ReviewTurn[] = []
  let turn: ReviewTurn | null = null
  for (const m of ui) {
    if (m.role === "user") {
      const instruction = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim()
      turn = { instruction, proposal: null, question: null, plan: [], selection: [], tools: [] }
      turns.push(turn)
      continue
    }
    if (m.role !== "assistant" || !turn) continue
    for (const p of m.parts) {
      if (p.type === "data-proposal") {
        const proposal = byId.get(p.data.id)
        if (!proposal) continue
        turn.proposal = { applied: appliedCount(proposal), count: proposal.state === "open" ? proposal.count : proposal.applied + proposal.rejected, open: proposal.state === "open", undone: undone.has(proposal.id) }
        turn.question = proposal.question
        continue
      }
      if (!p.type.startsWith("tool-")) continue
      const name = p.type.slice("tool-".length)
      const part = p as { input?: unknown; output?: unknown }
      if (!QUIET_TOOLS.has(name) && !turn.tools.includes(name)) turn.tools.push(name)
      if (name === "set_plan") {
        const out = planOutput.safeParse(typeof part.output === "string" ? tryParseJson(part.output) : part.output)
        if (out.success) turn.plan.push(...out.data.changes)
      }
      if (name === "set_selection") turn.selection.push(...describeSelection(part.input))
    }
  }
  return turns
}

/** 変更案の結果の言葉 */
function proposalResult(p: ReviewTurn["proposal"]) {
  if (!p) return "変更案なし"
  // 変更の無い聞き返しだけの変更案（答えは question・answer に出す）
  if (p.count === 0) return "変更案なし（聞き返しだけ）"
  if (p.undone) return "承認を取り消した"
  if (p.applied === 0) return p.open ? "まだ決めていない" : "却下した"
  return `承認 ${p.applied}/${p.count}${p.open ? "（残りは未決）" : ""}`
}

const QUESTION_ANSWERS = { yes: "はい", no: "いいえ" } as const

const FIELD_LABEL = new Map(KOJI_KEIREKI.fields.map((f) => [f.id, f.label]))
/** 手直しの出どころの言葉 */
const BY_LABELS: Record<CellEdit["by"], string> = { staff: "職員", excel: "職員（編集用の Excel）", chat: "チャット（承認）", customer: "顧客の回答", confirmed: "顧客が確認", location: "工事場所の調査" }
/** 例に先に出す出どころ（決まりになりやすい職員・チャットの直しを先に、顧客の回答・調査は後に） */
const BY_ORDER: CellEdit["by"][] = ["staff", "excel", "chat", "customer", "confirmed", "location"]

/** 項目ごとに出す手直し・置換の例の数と、値・指示の長さの上限（AI に渡す材料を大きくしない） */
const MAX_EXAMPLES = 10
const MAX_VALUE_CHARS = 120
const MAX_INSTRUCTION_CHARS = 600
const MAX_TURNS = 60

const cut = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s)

/**
 * 振り返りで伏せる・ルールの案に入れない個人名: 表の印の人・配置技術者・置換と手直しの人（保存の前のものも）と、names（サーバーが保存した作業から集めたもの）。
 * hide は材料の文字列の名前を〔個人名〕にし、has はルールの案に名前があるか（工事場所の調査と同じ確かめ。空白で区切った氏名も見る）
 */
export function reviewGuard(table: CaseTable, names: Iterable<string> = []) {
  const edits = [...table.edits]
  const all = namesForCarryover({ current: { rows: table.rows, edits } })
  for (const n of namesOfCase({ edits, replacements: table.replacements }, [])) all.add(n)
  for (const n of names) all.add(n)
  const scrub = nameScrubber(all)
  const test = personalNameTest(all)
  return { hide: (s: string) => scrub(withNames(s, () => NAME_MARK)), has: (text: string) => MARK_RE.test(text) || test(text) }
}
export type ReviewGuard = ReturnType<typeof reviewGuard>

/** 表の記号（〔Ａ〕〔未掲載１〕）と伏せた印（〔個人名〕）。ほかの〔…〕（〔仮称〕など）は個人名としない */
const MARK_RE = new RegExp(`〔(?:[Ａ-Ｚ]+|未掲載[０-９0-9]+)〕|${NAME_MARK}`)

/**
 * get_review が AI に返す材料（JSON にする）。turns は reviewTurnsFromUi（照合は指示の記録から作る）。view は table の表（作り直さない）。hide は reviewGuard の hide
 */
export function reviewMaterial(input: { turns: readonly ReviewTurn[]; table: CaseTable; view: Pick<TableView, "shown" | "output">; rounding: Rounding; hide: (s: string) => string }) {
  const { table } = input
  const hide = (s: string, n = MAX_VALUE_CHARS) => cut(input.hide(s), n)
  const turns = input.turns.slice(-MAX_TURNS)
  const instructions = turns.map((t, i) => ({
    n: input.turns.length - turns.length + i + 1,
    text: hide(t.instruction, MAX_INSTRUCTION_CHARS),
    result: proposalResult(t.proposal),
    ...(t.question ? { question: hide(t.question.text, 500), answer: t.question.answer ? QUESTION_ANSWERS[t.question.answer] : "まだ答えていない" } : {}),
    ...(t.plan.length ? { plan: t.plan.map((c) => hide(c, 300)) } : {}),
    ...(t.selection.length ? { selection: t.selection } : {}),
    ...(t.tools.length ? { tools: t.tools } : {}),
  }))

  // 手直し（承認したチャットの変更・職員の手直し・顧客の回答）を項目ごとに: 出どころごとの数と、変換の値 → 今の値 の例。
  // 例は出どころの順に、同じ直しを除いて MAX_EXAMPLES まで作る（手直しの多い案件で、全部の値の名前を伏せない）
  const base = new Map(baseRows(table).map((r) => [r.key, r]))
  const byField = new Map<KojiFieldId, { counts: Partial<Record<CellEdit["by"], number>>; keys: Map<CellEdit["by"], string[]> }>()
  for (const [key, edit] of table.edits) {
    const field = key.slice(key.lastIndexOf(":") + 1) as KojiFieldId
    if (!FIELD_LABEL.has(field)) continue
    const entry = byField.get(field) ?? { counts: {}, keys: new Map<CellEdit["by"], string[]>() }
    byField.set(field, entry)
    entry.counts[edit.by] = (entry.counts[edit.by] ?? 0) + 1
    entry.keys.set(edit.by, [...(entry.keys.get(edit.by) ?? []), key])
  }
  const edits = KOJI_KEIREKI.fields.flatMap((f) => {
    const e = byField.get(f.id)
    if (!e) return []
    const seen = new Set<string>()
    const examples: { by: string; before: string; after: string }[] = []
    for (const by of BY_ORDER) {
      for (const key of e.keys.get(by) ?? []) {
        if (examples.length >= MAX_EXAMPLES) break
        const cell = base.get(key.slice(0, key.lastIndexOf(":")))?.cells[f.id]
        const x = { by: BY_LABELS[by], before: hide(cell ? (cell.stored ?? cell.value) : ""), after: hide(table.edits.get(key)!.value) }
        const k = `${x.before}\u0000${x.after}`
        if (seen.has(k)) continue
        seen.add(k)
        examples.push(x)
      }
    }
    return [{ field: f.id, label: f.label, counts: Object.fromEntries(Object.entries(e.counts).map(([by, n]) => [BY_LABELS[by as CellEdit["by"]], n])), examples }]
  })

  const replacements = Object.entries(table.replacements).flatMap(([field, map]) => {
    const pairs = Object.entries(map ?? {})
    if (!pairs.length) return []
    return [{ field, label: FIELD_LABEL.get(field as KojiFieldId) ?? field, count: pairs.length, examples: pairs.slice(0, MAX_EXAMPLES).map(([from, to]) => ({ from: hide(from), to: hide(to.value) })) }]
  })

  const manual = { include: 0, exclude: 0 }
  for (const v of table.manual.values()) manual[v ? "include" : "exclude"]++

  return {
    instructions,
    edits,
    replacements,
    manual,
    addedRows: table.added.length,
    settings: {
      tax: TAX_LABELS[table.tax],
      selection: SELECTION_LABELS[table.selection],
      rule7Tax: RULE7_TAX_LABELS[table.rule7Tax],
      rounding: input.rounding === "round" ? "四捨五入" : "切り捨て",
      basis: Object.keys(table.basis),
      ...(table.includeAtLeastYen !== undefined ? { includeAtLeastYen: table.includeAtLeastYen } : {}),
    },
    rows: { all: input.view.shown.length, output: input.view.output.length },
  }
}
export type ReviewMaterial = ReturnType<typeof reviewMaterial>

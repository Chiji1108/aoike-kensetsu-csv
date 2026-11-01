import { CODE_SETS, ENGINEER_ROLES, GYOSHU, type CodeSetId } from "./code-sets"
import type { FieldSpec } from "./types"

/**
 * 決まった値（コード表）の項目を、画面で選ぶ欄にするための選択肢。数字を打たせず名前で選ばせる。
 * codes は1列の値を選ぶ（多いもの〔業種〕は名前・コードで絞り込める欄、少ないもの〔2〜4択〕はボタン）。
 * engineerRole は主任技術者・監理技術者の2列を1つの欄で決める（どちらか一方だけが 1 の決まりを、選ぶだけで守る）
 */
export type Choice = { code: string; label: string; aliases: readonly string[] }
export type FieldChoices = { kind: "codes"; set: CodeSetId; options: readonly Choice[]; search: boolean } | { kind: "engineerRole"; options: typeof ENGINEER_ROLES }

/** ボタンで出す選択肢の数の上限（これより多ければ絞り込める欄） */
const MAX_BUTTONS = 4

const choicesOfSet = (set: CodeSetId): readonly Choice[] =>
  set === "gyoshu" ? GYOSHU.map((g) => ({ code: g.code, label: g.label, aliases: g.aliases })) : CODE_SETS[set].map((c) => ({ code: c.code, label: c.label, aliases: [] }))

const ENGINEER_FIELDS: ReadonlySet<string> = new Set(["chiefEngineer", "supervisingEngineer"])

/** 項目の選ぶ欄（自由な文字・数の項目は undefined で、今のまま打つ） */
export function choicesOf(field: Pick<FieldSpec, "id" | "valueType">): FieldChoices | undefined {
  if (ENGINEER_FIELDS.has(field.id)) return { kind: "engineerRole", options: ENGINEER_ROLES }
  const vt = field.valueType
  const set: CodeSetId | undefined = vt.type === "code" ? vt.set : vt.type === "flag" ? "flag" : undefined
  if (!set) return undefined
  const options = choicesOfSet(set)
  return { kind: "codes", set, options, search: options.length > MAX_BUTTONS }
}

/** 表に出す名前（例: 業種「8」→「電気」、JV「0」→「なし」）。コード表に無い値・自由な項目は undefined（値をそのまま出す） */
export function choiceLabel(field: Pick<FieldSpec, "id" | "valueType">, value: string): string | undefined {
  const vt = field.valueType
  const set: CodeSetId | undefined = vt.type === "code" ? vt.set : vt.type === "flag" ? "flag" : undefined
  return set ? CODE_SETS[set].find((c) => c.code === value)?.label : undefined
}

/** 絞り込み（名前・別名・コードのどれかに含まれる。全角半角は見ない） */
export function matchesChoice(choice: Choice, query: string) {
  const q = query.normalize("NFKC").trim().toLowerCase()
  if (!q) return true
  return [choice.code, choice.label, `${choice.code} ${choice.label}`, ...choice.aliases].some((t) => t.normalize("NFKC").toLowerCase().includes(q))
}

import { z } from "zod"
import { RULE7_TAX_LABELS, type Rule7Tax } from "../convert/koji-selection"
import { rule7TaxSchema } from "../schemas"

export { RULE7_TAX_LABELS, rule7TaxSchema, type Rule7Tax }

/**
 * 全体ルール・顧客ルールの項目（D1 の csv_rule_items。1項目1行）。AI には position の順に箇条書きの文章にして渡す（rulesText）。
 * 決まった処理が守ること（字数の検査・7割で載せる件数・半角カナ・氏名の空白）と AI への固定の指示（分からないことは問い合わせに回す）は
 * ここに書かない（lib/chat/turn.ts の systemPrompt）。7割の計算の税抜・税込は文章でなく事務所の設定（csv_settings）
 */

/** 一覧の種類（全体ルール・顧客ルール）と、誰が足したか（staff: 職員が画面で・前の文章から移した、chat: チャットの変更案の承認） */
export const RULE_SCOPES = ["global", "customer"] as const
export const RULE_SOURCES = ["staff", "chat"] as const
export type RuleScope = (typeof RULE_SCOPES)[number]
export type RuleSource = (typeof RULE_SOURCES)[number]
export const ruleScopeSchema = z.enum(RULE_SCOPES)
/** どの一覧か（顧客ルールは顧客ごと） */
export type RuleTarget = { scope: "global" } | { scope: "customer"; customerId: string }

/** 1つの一覧（全体ルール・顧客ごとの顧客ルール）の項目の数・1項目の字数・合計の字数の上限（合計は前の1つの文章の上限と同じ） */
export const MAX_RULE_ITEMS = 100
export const MAX_RULE_ITEM_LENGTH = 1_000
export const MAX_RULES_TOTAL = 20_000

/** 字数（文字の数。D1 の length() と同じ数え方で、サロゲートペアの「𠮷」も1字） */
export const charCount = (s: string) => [...s].length

/** 項目の文章（前後の空白を取り、改行は空白にする。1項目は1行） */
export const ruleTextSchema = z
  .string()
  .transform((s) => s.replace(/\s*[\r\n]+\s*/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "空の項目は足せません")
      .refine((s) => charCount(s) <= MAX_RULE_ITEM_LENGTH, `1項目は${MAX_RULE_ITEM_LENGTH.toLocaleString("ja-JP")}字までです`),
  )

/** 由来の案件（年度と顧客名。案件が消えていれば null） */
export type RuleOrigin = { caseId: string; fiscalYear: number; customerName: string }

export type RuleItem = {
  id: string
  text: string
  source: RuleSource
  origin: RuleOrigin | null
  /** 文章を直すたびに上がる（同じ項目を2つの画面で直したときに後の保存を断る） */
  version: number
}

/** AI に渡す文章（並びのまま「- 」の箇条書き。項目が無ければ空） */
export const rulesText = (items: readonly Pick<RuleItem, "text">[]) => items.map((i) => `- ${i.text}`).join("\n")

/** 全体ルールの初期値（事務所のやり方）。全体ルールを保存したことが無い D1 にはマイグレーション 0004 が同じ項目を入れる（テストで同じか確かめる） */
export const DEFAULT_GLOBAL_RULE_ITEMS: readonly string[] = [
  "字数を超えたときの縮め方の順: 空白を取る → 株式会社を㈱・有限会社を㈲ → 法人格を省く → それでも長ければ職員に聞く。",
  "完成年月は顧客の指定に従う（引渡日が多い）。",
  "工事名は場所と内容が分かるようにする。工事名で業種が分からず、その行の業種コードが決まっているときは、その業種の言葉を補う（例「〜に伴う内装工事」）。会社の主な業種から推し量らない。業種コードが決まっていなければ補わない。",
  "工事名の「(仮称)」と、丁寧の「ご」（「ご自宅改修」の「ご」。「ごみ処理施設」のように語の一部なら取らない）を取る。途中や末尾にある【支店名】のような補足は先頭に移す（括弧を外すかは顧客の指定に従う）。",
  "配置技術者は氏名だけにする（社員番号などの接頭辞「83：」は取る）。",
]

/** 項目の由来の短い説明（例「2026年度の案件でチャットから」）。withCustomer は全体ルールの一覧で顧客名も出すとき */
export function originLabel(item: Pick<RuleItem, "source" | "origin">, withCustomer: boolean): string {
  const how = item.source === "chat" ? "チャットから" : "職員"
  if (!item.origin) return item.source === "staff" ? how : `${how}（案件は削除済み）`
  return `${withCustomer ? `${item.origin.customerName} ` : ""}${item.origin.fiscalYear}年度の案件で${how}`
}

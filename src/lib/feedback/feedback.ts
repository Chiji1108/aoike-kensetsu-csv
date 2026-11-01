import { z } from "zod"
import { withNames } from "../convert/persons"
import { CORPORATE_FORMS, ORGANIZATION_WORDS } from "../convert/transforms"
import { knownWords, norm, PROPER_RE } from "../chat/carryover"
import { charCount } from "../chat/rules"

/**
 * 要望（D1 の csv_feedback）。チャットの AI が仕事をしながら「こういう機能があれば良かった」と思ったことと、職員が書き足したもの。
 * 開発者が読んで機能を足す（README の「要望を読む」）。変更案ではない（承認を通らない）
 */

/** 種類: missing は今の道具ではできなかった、detour はコード実行で遠回りした、repeat は同じ手直しを何度も頼まれた */
export const FEEDBACK_KINDS = ["missing", "detour", "repeat", "other"] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = { missing: "できない", detour: "遠回り", repeat: "繰り返し", other: "その他" }
export const feedbackKindSchema = z.enum(FEEDBACK_KINDS)

/** 状態: open は未対応、done は対応した、wontfix はしない */
export const FEEDBACK_STATUSES = ["open", "done", "wontfix"] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = { open: "未対応", done: "対応済み", wontfix: "しない" }
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES)

/** 誰が残したか（ai: チャットの AI、staff: 職員が要望の画面で） */
export const FEEDBACK_SOURCES = ["ai", "staff"] as const
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number]
export const feedbackSourceSchema = z.enum(FEEDBACK_SOURCES)

/** 1つの欄の字数の上限（短く書かせる） */
export const MAX_FEEDBACK_TEXT = 200
/** 1回の指示で AI が残せる要望の数（新しい要望と、既存の要望に件数を足すもの） */
export const MAX_FEEDBACK_PER_TURN = 2
/**
 * AI に見せる未対応の要望の数（件数の多い順）。同じ要望かを見るには全部が要るので、ふつうは全部を見せる。
 * 1件は短い要約（MAX_SUMMARY_TEXT 字まで）で 40〜80 トークンほど、500件で約3万トークン（Opus 5.5 で約 $0.12）。読むのは要望を残すときだけ。
 * これを超えると件数の少ない古い要望は見せないので、同じ要望が新しい行になることがある（対応した・しない要望を閉じれば減る。README）
 */
export const MAX_FEEDBACK_LISTED = 500
/** AI に見せる要約の1つの欄の字数 */
export const MAX_SUMMARY_TEXT = 80

/** 欄の文（前後の空白を取り、改行は空白にする） */
const textOf = (label: string) =>
  z
    .string()
    .transform((s) => s.replace(/\s*[\r\n]+\s*/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1, `${label}が空です`)
        .refine((s) => charCount(s) <= MAX_FEEDBACK_TEXT, `${label}は${MAX_FEEDBACK_TEXT}字までです`),
    )

/** 要望の中身。want: 何をしたかったか、did: 今どうしたか、idea: あると良い機能 */
export const feedbackInputSchema = z.strictObject({
  kind: feedbackKindSchema,
  want: textOf("したかったこと"),
  did: textOf("今どうしたか"),
  idea: textOf("あると良い機能"),
})
export type FeedbackInput = z.infer<typeof feedbackInputSchema>

/** 画面に出す要望。caseLabel は案件の顧客名と年度（案件を消していれば null） */
export type FeedbackItem = FeedbackInput & {
  id: string
  count: number
  status: FeedbackStatus
  source: FeedbackSource
  caseId: string | null
  caseLabel: string | null
  createdAt: number
  updatedAt: number
}

/** AI に見せる既存の要望（短く） */
export type FeedbackSummary = { id: string; kind: FeedbackKind; want: string; idea: string; count: number }

/** 要望に入れない名前の材料。names は顧客名・注文者、works は工事名とその注文者、known は知っている語にする文（全体ルール・顧客ルールなど） */
export type FeedbackNames = { names: Iterable<string>; works: Iterable<{ client: string; workName: string }>; known?: readonly string[] }

/** 工事名の語を一般の語とみなす、その語を工事名に含む注文者の数（違う注文者の工事名に何度も出る語は、建物や現場の名でない） */
const COMMON_ACROSS_CLIENTS = 3
/** 法人格・敬称（名の本体を取り出すときに外す） */
const NAME_AFFIXES = [...CORPORATE_FORMS, "様", "御中", "殿"].map(norm)
/** 名の特徴的な部分を取り出すときに外す一般の語 */
const ORG_WORDS = ORGANIZATION_WORDS.map(norm).sort((a, b) => b.length - a.length)
/** 英字・数字の続き（工事名の固有名らしい語に足す） */
const LATIN_RE = /[a-z0-9]{3,}/g

const lower = (s: string) => norm(s).toLowerCase()
const removeAll = (s: string, words: readonly string[]) => words.reduce((t, w) => t.replaceAll(w, ""), s)
/** 照らす語として短すぎる（2字未満、英数字だけなら3字未満） */
const tooShort = (s: string) => [...s].length < 2 || (/^[a-z0-9]+$/.test(s) && s.length < 3)

/**
 * 要望に入れない固有名の確かめを作る（顧客名・注文者・工事名）。返す関数は文に入っていた語を返す（無ければ空）。
 * - 顧客名・注文者: 名そのもの・法人格と敬称を外した本体・一般の語（商事・建設など）も外した特徴的な部分で探す（英字・ひらがなも含めて、全角半角・大文字小文字・空白の違いは同じ）。
 *   ただし知っている語（書式の決まり・ルール・一般の語）にある部分は探さない（「東京電気工業」の「東京」など）
 * - 工事名: 固有名らしい語（漢字・カタカナの続き、英数字の続き）のうち、知っている語に無く、違う注文者の工事名に何度も出ない（一般の語でない）もの
 */
export function feedbackNameCheck({ names, works, known = [] }: FeedbackNames): (text: string) => string[] {
  // 知っている語（carryover.ts の knownWords。表の値は入れない）に、法人・建物の一般の語を足す
  const knownText = lower(knownWords({ rows: [], edits: [] }, [...known, ...ORGANIZATION_WORDS], []))
  const isKnown = (w: string) => knownText.includes(w)
  const features = new Set<string>()
  for (const raw of names) {
    const full = lower(withNames(raw, () => " "))
    const body = removeAll(full, NAME_AFFIXES)
    const core = removeAll(body, ORG_WORDS)
    // 英字の名は語ごとにも探す（「ACME Holdings」の「ACME」）
    const latin = raw.normalize("NFKC").toLowerCase().match(LATIN_RE) ?? []
    for (const f of [full, body, core, ...latin]) if (!tooShort(f) && !isKnown(f)) features.add(f)
  }
  /** 工事名（記号の人は除く）と、その語を含む注文者の数を数えるための注文者 */
  const workList = [...works].map((w) => ({ client: lower(withNames(w.client, () => " ")), work: lower(withNames(w.workName, () => " ")) })).filter((w) => w.work)
  const commonCache = new Map<string, boolean>()
  const common = (t: string) => {
    let c = commonCache.get(t)
    if (c === undefined) commonCache.set(t, (c = new Set(workList.filter((w) => w.work.includes(t)).map((w) => w.client)).size >= COMMON_ACROSS_CLIENTS))
    return c
  }
  return (text) => {
    const t = lower(text)
    const hits = new Set<string>()
    for (const f of features) if (t.includes(f)) hits.add(f)
    for (const w of [...(t.match(PROPER_RE) ?? []), ...(t.match(LATIN_RE) ?? [])]) {
      if (tooShort(w) || isKnown(w) || hits.has(w)) continue
      if (workList.some((x) => x.work.includes(w)) && !common(w)) hits.add(w)
    }
    return [...hits]
  }
}

/** list_feedback で AI に見せる要望の文が確かめに当たったときの印（中身は見せない） */
export const MASKED_FEEDBACK = "〔名前を含むので伏せた要望〕"

/**
 * 要望の読み書き（server/feedback-store.ts。案件の id は書く側で付ける）。add は新しい要望の id、bump は未対応の要望の件数を足せたか（無ければ・閉じていれば false）。
 * names は要望に入れない名前（この案件の顧客名・ほかの顧客の名前）、known は知っている語にする文（全体ルール・顧客ルール）
 */
export type FeedbackDeps = {
  list: () => Promise<readonly FeedbackSummary[]>
  add: (input: FeedbackInput) => Promise<string>
  bump: (id: string) => Promise<boolean>
  names: () => Promise<readonly string[]>
  known: readonly string[]
}

/** 要望の欄を要約の字数に縮める */
export const summaryText = (s: string) => ([...s].length > MAX_SUMMARY_TEXT ? `${[...s].slice(0, MAX_SUMMARY_TEXT).join("")}…` : s)

/** 要望のすべての欄の文 */
export const feedbackTexts = (f: Pick<FeedbackInput, "want" | "did" | "idea">) => [f.want, f.did, f.idea]

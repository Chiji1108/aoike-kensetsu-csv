import { z } from "zod"
import { removeSpaces } from "../convert/text"
import { PROPER_RE, SPEC_TEXT } from "../chat/carryover"
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
/** AI に見せる既存の要望の数（件数の多い順） */
export const MAX_FEEDBACK_LISTED = 60

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

const norm = (s: string) => removeSpaces(s.normalize("NFKC"))
/** 書式の決まりの語（業種・工事名・注文者などの一般の語）。固有名とみなさない */
const GENERIC = norm(SPEC_TEXT)

/**
 * 要望に入れない固有名の確かめ。values は顧客名・注文者・工事名など案件の名前の値。要望の文の固有名らしい語（漢字・カタカナの続き、2字以上）が
 * その値のどれかに含まれ、書式の決まりの一般の語に無ければ、その語を返す（無ければ空）。値そのもの（2字以上）が文にあっても返す
 */
export function properNameHits(text: string, values: Iterable<string>): string[] {
  const vals = [...new Set([...values].map(norm).filter((v) => [...v].length >= 2))]
  if (!vals.length) return []
  const t = norm(text)
  const hits = new Set<string>()
  for (const v of vals) if (t.includes(v)) hits.add(v)
  for (const w of t.match(PROPER_RE) ?? []) {
    if ([...w].length < 2 || GENERIC.includes(w)) continue
    if (vals.some((v) => v.includes(w))) hits.add(w)
  }
  return [...hits]
}

/** 要望のすべての欄の文 */
export const feedbackTexts = (f: Pick<FeedbackInput, "want" | "did" | "idea">) => [f.want, f.did, f.idea]

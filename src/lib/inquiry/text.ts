import { z } from "zod"
import { nfkc, removeSpaces } from "../convert/text"
import { charCount } from "../chat/rules"

/**
 * 問い合わせのメールの件名と前置き。AI が書いた案を職員が承認したもの・職員が直したものを案件の作業に残す（null は決まった文）。
 * 聞くこと自体は顧客の Excel の色付きのセル（印付き・記入用Excel）とメモで伝えるので、質問の文は持たない
 * （前の作業の questions は読むときに捨てる）
 */

export const MAX_SUBJECT_LENGTH = 100
export const MAX_INTRO_LENGTH = 600

export type InquiryText = { subject: string | null; intro: string | null }

export const EMPTY_INQUIRY_TEXT: InquiryText = { subject: null, intro: null }

/** チャットの「AI でメールの下書きを作る」で送る指示 */
export const INQUIRY_TEXT_PROMPT = "今の問い合わせを、顧客へのメールの件名と前置きの下書きにして"

const lengthAtMost = (n: number) => (s: string) => charCount(s) <= n
export const subjectSchema = z.string().trim().min(1).refine(lengthAtMost(MAX_SUBJECT_LENGTH), `件名は${MAX_SUBJECT_LENGTH}字まで`)
export const introSchema = z.string().trim().min(1).refine(lengthAtMost(MAX_INTRO_LENGTH), `前置きは${MAX_INTRO_LENGTH}字まで`)
/** 前の作業の質問の文（questions）は読み捨てる（z.object は知らない項目を落とす） */
export const inquiryTextSchema: z.ZodType<InquiryText> = z.object({ subject: subjectSchema.nullable(), intro: introSchema.nullable() })

/**
 * 文の中に、ほかの顧客の名前があるかを確かめる関数（会社の種類の語・空白・全角半角の違いは除いて比べる。3文字に満たない名前は見ない）。
 * own はこの案件の顧客の名前（書いてよい）。文の頭から、その位置で始まるいちばん長い名前を照らす（自分の名前を含むほかの顧客の名前は見つけ、
 * ほかの顧客の名前を含む自分の名前では断らない）
 */
export function otherCustomerTest(names: Iterable<string>, own = ""): (text: string) => boolean {
  const core = (s: string) => removeSpaces(nfkc(s)).replace(/株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|㈱|㈲/g, "")
  const self = core(own)
  const others = [...new Set([...names].map(core))].filter((n) => [...n].length >= 3 && n !== self)
  const all = [...others.map((name) => ({ name, other: true })), ...(self ? [{ name: self, other: false }] : [])].sort((a, b) => b.name.length - a.name.length)
  return (text) => {
    const t = core(text)
    for (let i = 0; i < t.length; ) {
      const hit = all.find((n) => t.startsWith(n.name, i))
      if (hit?.other) return true
      i += hit ? hit.name.length : 1
    }
    return false
  }
}

/** 変更案のメールの件名と前置き（lib/chat/proposals.ts の ChatChange のうち問い合わせのメールの下書き） */
export type InquiryTextChange = { kind: "inquiryMail"; subject: string; intro: string }

/** 承認した変更案の件名と前置きを文面にする（lib/chat/proposals.ts の applyChanges から） */
export const applyInquiryChange = (text: InquiryText, change: InquiryTextChange): InquiryText => ({ ...text, subject: change.subject, intro: change.intro })

/** 承認の取り消しの記録に残す文面の違い（変わったものだけ [前, 後]） */
export type InquiryTextDiff = { subject?: [string | null, string | null]; intro?: [string | null, string | null] }

export function diffInquiryText(before: InquiryText, after: InquiryText): InquiryTextDiff | null {
  const diff: InquiryTextDiff = {
    ...(before.subject !== after.subject ? { subject: [before.subject, after.subject] as [string | null, string | null] } : {}),
    ...(before.intro !== after.intro ? { intro: [before.intro, after.intro] as [string | null, string | null] } : {}),
  }
  return diff.subject || diff.intro ? diff : null
}

/** 記録の「後」のままのものだけを「前」に戻す（承認のあとに職員が直した文は残して kept に数える） */
export function revertInquiryText(now: InquiryText, diff: InquiryTextDiff): { text: InquiryText; reverted: number; kept: number } {
  let reverted = 0
  let kept = 0
  const back = (pair: [string | null, string | null] | undefined, value: string | null) => {
    if (!pair) return value
    if (value !== pair[1]) {
      kept++
      return value
    }
    reverted++
    return pair[0]
  }
  return { text: { subject: back(diff.subject, now.subject), intro: back(diff.intro, now.intro) }, reverted, kept }
}

const nullablePair = z.tuple([z.string().nullable(), z.string().nullable()])
/** 前の記録の質問の文の違い（questions）は読み捨てる。件名・前置きの違いが無ければ記録が無いのと同じ */
export const inquiryTextDiffSchema = z
  .object({ subject: nullablePair.optional(), intro: nullablePair.optional() })
  .transform((d): InquiryTextDiff | undefined => (d.subject || d.intro ? { ...(d.subject ? { subject: d.subject } : {}), ...(d.intro ? { intro: d.intro } : {}) } : undefined))

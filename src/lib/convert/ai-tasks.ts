import { z } from "zod"
import { GYOSHU } from "../spec/code-sets"

/**
 * AI に頼む判断の種類。値ごとの変換のうち、ルールで決まらなかったものだけがここに来る。
 * 返ってきた値の検算は transforms.ts の各変換（ai.apply）が行う。
 */

const valueItem = z.object({
  id: z.number().int(),
  value: z.string(),
  needsReview: z.boolean(),
  note: z.string(),
})

/** 個人名の匿名化。value は個人名を「〔1〕」「〔2〕」…にした値、persons はその個人名（記号「Ａ」等は persons.ts で案件全体の最後の行から決める） */
const anonymizeItem = valueItem.extend({ persons: z.array(z.string()) })

const addressItem = z.object({
  id: z.number().int(),
  prefecture: z.string(),
  city: z.string(),
  rest: z.string(),
  /** 元の住所に都道府県が書かれておらず、AI が補ったとき true */
  prefectureInferred: z.boolean(),
  needsReview: z.boolean(),
  note: z.string(),
})

const periodItem = z.object({
  id: z.number().int(),
  start: z.string(),
  end: z.string(),
  needsReview: z.boolean(),
  note: z.string(),
})

const locationItem = z.object({
  id: z.number().int(),
  prefecture: z.string(),
  place: z.string(),
  needsReview: z.boolean(),
  note: z.string(),
})

const gyoshuList = GYOSHU.map((g) => `${g.code}=${g.label}`).join(" ")

export const AI_TASKS = {
  gyoshu: {
    label: "業種の判定",
    item: valueItem,
    instruction: `業種名を建設業.NET の業種コード（1〜30の整数の文字列）に変換する。コード表: ${gyoshuList}。判断に迷うときは needsReview を true にする。`,
  },
  yearMonth: {
    label: "年月の読み取り",
    item: valueItem,
    instruction:
      "日付・年月の表記を西暦の YYYYMM（6桁）に変換する。和暦は西暦に直す。読み取れないときは value を空文字にして needsReview を true にする。",
  },
  period: {
    label: "工期の読み取り",
    item: periodItem,
    instruction:
      "工期の表記から着工年月 start と完成年月 end を西暦の YYYYMM（6桁）で返す。分からない側は空文字。",
  },
  splitAddress: {
    label: "住所の分割",
    item: addressItem,
    instruction:
      "住所を都道府県 prefecture（47都道府県名と完全一致）・市区町村 city（政令指定都市は区まで、郡部は郡＋町村）・残り rest に分ける。空白は除く。元の住所に都道府県が無いときは市区町村から都道府県を補い prefectureInferred を true にする。そのとき city + rest は元の住所と完全に一致させる。都道府県があるときは prefecture + city + rest を元の住所と完全に一致させる。",
  },
  inferLocation: {
    label: "所在地の推定",
    item: locationItem,
    instruction:
      "input は工事名（現場名）と注文者を空白でつないだもの。施設名・地名・注文者から工事場所を推定し、都道府県 prefecture（47都道府県名と完全一致）と場所名 place（市区町村。政令指定都市は区まで。都道府県名は含めない）を返す。複数の地域にまたがるときは place に「広島市南区、三原市」のように並べてよい。推定できない側は空文字にする。少しでも自信がなければ needsReview を true にし、note に根拠か迷った点を短く書く。",
  },
  personName: {
    label: "氏名の区切り",
    item: valueItem,
    instruction:
      "人名の姓と名の間に全角スペースを1つ入れる（例: 世界次郎 → 世界　次郎）。文字の追加・削除・変更はしない。区切りに自信がないときは needsReview を true にする。",
  },
  anonymizeClient: {
    label: "注文者の匿名化",
    item: anonymizeItem,
    instruction:
      "工事の注文者名を判定する。法人・官公庁・団体・店舗名は value にそのまま返し、persons は空にする。個人の場合は value を「〔1〕」にし、persons にその氏名（入力の表記どおり）を入れる。「Ａ」等の記号はこちらで付けるので書かない。判断に迷うときは needsReview を true にする。",
  },
  anonymizeWorkName: {
    label: "工事名の匿名化",
    item: anonymizeItem,
    instruction:
      "工事名に個人名が含まれる場合は、個人名を「〔1〕」「〔2〕」…（persons の何番目か）に置き換えて value に返し、persons に個人名を入力の表記どおり順に入れる（例: 山田太郎邸新築工事 → value「〔1〕邸新築工事」・persons [\"山田太郎\"]。「様」「邸」は個人名に含めない）。「Ａ」等の記号はこちらで付けるので書かない。法人名・店舗名・官公庁名はそのまま。個人名が無ければ入力をそのまま返し、persons は空にする。",
  },
  freeform: {
    label: "指示に従った変換",
    item: valueItem,
    instruction: "職員の指示に従って値を変換する。",
  },
} as const satisfies Record<string, { label: string; item: z.ZodObject; instruction: string }>

export type AiTaskId = keyof typeof AI_TASKS
export const AI_TASK_IDS = Object.keys(AI_TASKS) as [AiTaskId, ...AiTaskId[]]

export type AiItemResult<T extends AiTaskId = AiTaskId> = z.infer<(typeof AI_TASKS)[T]["item"]>

export const MAX_ITEMS_PER_REQUEST = 100

export type AiBatchRequest = {
  task: AiTaskId
  /** ai.freeform の指示文 */
  instruction?: string
  items: { id: number; input: string }[]
}

export function aiResponseSchema(task: AiTaskId) {
  return z.object({ results: z.array(AI_TASKS[task].item) })
}

/**
 * AI の応答を検証して id → 結果 の表にする。
 * 依頼していない id、重複した id は捨てる（返ってこなかった値は呼び出し側で「AI 変換できず」になる）。
 */
export function parseAiResponse<T extends AiTaskId>(
  task: T,
  request: AiBatchRequest,
  json: unknown,
): { ok: true; results: Map<number, AiItemResult<T>> } | { ok: false; message: string } {
  const parsed = aiResponseSchema(task).safeParse(json)
  if (!parsed.success) return { ok: false, message: "AI の応答の形式が正しくありません" }
  const asked = new Set(request.items.map((i) => i.id))
  const results = new Map<number, AiItemResult<T>>()
  for (const r of parsed.data.results as AiItemResult<T>[]) {
    if (asked.has(r.id) && !results.has(r.id)) results.set(r.id, r)
  }
  return { ok: true, results }
}

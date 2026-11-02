import { z } from "zod"
import { nfkc, removeSpaces } from "../convert/text"
import { leadingPrefecture, PREFECTURES, type Prefecture } from "./prefectures"

/**
 * 場所名（G列）の決まり。建設業.NET の取込は、場所名が「市」「区」「町」「村」で終わる値だけを読む（「〇〇郡」だけ・施設名・番地付きは読めない）。
 * 形は市区町村まで（政令指定都市は区まで。区まで分からなければ市まで）。郡部の町村に郡を付けるかは PLACE_WITH_GUN の1か所で決める。
 * 今は郡あり（「愛甲郡愛川町」）: 事務所のこれまでの CSV と同じ書き方で、建設業.NET に取り込めた実績がある。郡で終わる値（「愛甲郡」だけ）はエラー。
 * 郡は住所データ（ja.json の county）で「〇〇郡〇〇町」と読めるときだけ付け外しする（文字の形だけで外すと「蒲郡市」「大和郡山市」を壊す）。
 * 検証（validate.ts）・住所の分割（address.ts）・AI の整形（transforms.ts）・工事場所の調査（lib/location）はここを使う
 */

/** 郡部の町村に郡を付けるか（false: 「愛川町」、true: 「愛甲郡愛川町」）。住所の分割・工事場所の検算・AI への指示がこれに従う */
export const PLACE_WITH_GUN = true

/** 決まりを守っていない値のエラーの文（画面・チャット・書き出す前の確認で同じ言葉） */
export const PLACE_RULE = "場所名は市区町村で終わる名前にします（例: 〇〇市・〇〇町）"

/** AI に場所名の形を伝える文（変換・チャット・工事場所の調査の指示で同じ文。固定の文なのでプロンプトのキャッシュを崩さない） */
export const PLACE_FORMAT = `場所名は市区町村の名前1つだけ（政令指定都市は区まで、分からなければ市まで。${
  PLACE_WITH_GUN ? "郡部は郡から町村まで。例「横浜市中区」「厚木市」「愛甲郡愛川町」" : "郡部は郡を付けず町村の名前だけ。例「横浜市中区」「厚木市」「愛川町」"
}）。都道府県名・郡だけ・町名・番地・施設名・括弧書き・説明・複数の地域の列挙は入れない`

/** 市区町村の名前に無い文字（句読点・括弧・数字・記号・空白） */
const NOT_IN_NAME = /[\s、。，．,.・･()（）「」『』【】［］\[\]{}〈〉《》<>:：;；!！?？/／\\|｜~〜\-－‐−―0-9]/

/** 複数の地域を並べた値（「広島市南区、三原市」）の区切り */
export const PLACE_LIST = /[、,，・･/／]/

/** 値が決まりを守っているか。守っていなければ理由（エラーの文）。空欄は守っている（必須でない） */
export function placeIssue(v: string): string | undefined {
  if (!v) return undefined
  if (leadingPrefecture(v)) return `${PLACE_RULE}。都道府県名は都道府県名の欄に書き、場所名には入れません`
  if (PLACE_LIST.test(v)) return `${PLACE_RULE}。複数の地域は並べず、1つにします`
  if (NOT_IN_NAME.test(v)) return `${PLACE_RULE}。句読点・括弧・番地は入れません`
  if (/郡$/.test(v)) return `${PLACE_RULE}。郡だけでなく町村の名前まで書きます`
  if (!/[市区町村]$/.test(v)) return PLACE_RULE
  return undefined
}

/**
 * 決まった処理で直せる形を直す（住所データが無くてもできるところだけ）: 空白・全角英数をそろえ、先頭の都道府県名（prefecture と同じとき）と
 * 末尾の括弧書き（「千代田区（丸の内）」）を除く。郡・町名・番地・施設名は住所データで読む側（readPlace・address.ts）が扱う。
 * 直したあとも決まりを守らない値は issue に理由を返す（値は直したところまで）
 */
export function tidyPlace(raw: string, prefecture?: string): { value: string; issue?: string } {
  let v = removeSpaces(nfkc(raw))
  const pref = leadingPrefecture(v)
  if (pref && (!prefecture || pref === prefecture)) v = v.slice(pref.length)
  v = v.replace(/[（(][^（()）]*[）)]$/, "")
  const issue = placeIssue(v)
  return issue ? { value: v, issue } : { value: v }
}

// ---- 住所データの索引（市区町村の名前を決まりの形にそろえる） ----

/** 住所データ（ja.json）のうち、市区町村の名前に使うところ（county は郡部の郡） */
export const jaSchema = z.object({
  data: z.array(z.object({ pref: z.string(), cities: z.array(z.object({ county: z.string().optional(), city: z.string(), ward: z.string().optional() })) })),
})

/** 都道府県 → 市区町村の名前（揺れを畳んだもの。郡あり・郡なし、区まで書いていない政令市も）→ 決まりの形の名前 */
export type PlaceIndex = ReadonlyMap<Prefecture, ReadonlyMap<string, string>>

/** 表記の揺れを畳む（ヶ・ヵ → ケ、空白を除く）。比べるのにだけ使う */
export const foldPlace = (s: string) => s.normalize("NFKC").replace(/\s/g, "").replace(/[ヶヵ]/g, "ケ")

export function placeIndex(ja: z.infer<typeof jaSchema>): PlaceIndex {
  const index = new Map<Prefecture, Map<string, string>>()
  for (const p of ja.data) {
    const pref = PREFECTURES.find((x) => x === p.pref)
    if (!pref) continue
    const names = new Map<string, string>()
    const add = (key: string, name: string) => names.set(foldPlace(key), name)
    for (const c of p.cities) {
      const name = c.city + (c.ward ?? "")
      const shaped = PLACE_WITH_GUN && c.county ? c.county + name : name
      add(name, shaped)
      if (c.county) add(c.county + name, shaped)
      // 区まで書いていない政令市（「横浜市」）
      if (c.ward) add(c.city, c.city)
    }
    index.set(pref, names)
  }
  return index
}

/**
 * 都道府県 prefecture の市区町村として読めたら、決まりの形の名前。名前と完全に一致するか、後ろに町名・番地・説明が続くなら一番長い名前
 * （「三島郡出雲崎町大字乙茂」→ 出雲崎町、「蒲郡市三谷町」→ 蒲郡市）
 */
export function readPlace(index: PlaceIndex, prefecture: Prefecture, text: string): string | undefined {
  const names = index.get(prefecture)
  if (!names) return undefined
  const folded = foldPlace(text)
  const exact = names.get(folded)
  if (exact) return exact
  let best: string | undefined
  for (const key of names.keys()) if (folded.startsWith(key) && (best === undefined || key.length > best.length)) best = key
  return best === undefined ? undefined : names.get(best)
}

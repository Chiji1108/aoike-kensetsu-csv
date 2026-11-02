import { nfkc, removeSpaces } from "../convert/text"
import { leadingPrefecture } from "./prefectures"

/**
 * 場所名（G列）の決まり。建設業.NET の取込は、場所名が「市」「区」「町」「村」で終わる値だけを読む（「〇〇郡」だけ・施設名・番地付きは読めない）。
 * 形は市区町村まで（政令指定都市は区まで。区まで分からなければ市まで）、郡部は郡を付けない町村の名前（「愛甲郡愛川町」でなく「愛川町」）。
 * 郡を含めた形も町村で終わるので取り込めるはずだが、取込の仕様で確かめられないため、短く同じ形にそろう郡なしを決まりにする
 * （住所データ ja.json の町村の名前も郡なし。工事場所の検算もこの名前で読む）。
 * 検証（validate.ts）・住所の分割（address.ts）・AI の整形（transforms.ts）・工事場所の調査（lib/location）はここを使う
 */

/** 決まりを守っていない値のエラーの文（画面・チャット・書き出す前の確認で同じ言葉） */
export const PLACE_RULE = "場所名は市区町村で終わる名前にします（例: 〇〇市・〇〇町）"

/** AI に場所名の形を伝える文（変換・チャット・工事場所の調査の指示で同じ文。固定の文なのでプロンプトのキャッシュを崩さない） */
export const PLACE_FORMAT =
  "場所名は市区町村の名前1つだけ（政令指定都市は区まで、分からなければ市まで。郡部は郡を付けず町村の名前だけ。例「横浜市中区」「厚木市」「愛川町」）。都道府県名・郡だけ・町名・番地・施設名・括弧書き・説明・複数の地域の列挙は入れない"

/** 市区町村の名前に無い文字（句読点・括弧・数字・記号・空白） */
const NOT_IN_NAME = /[\s、。，．,.・･()（）「」『』【】［］\[\]{}〈〉《》<>:：;；!！?？/／\\|｜~〜\-－‐−―0-9]/

/** 複数の地域を並べた値（「広島市南区、三原市」）の区切り */
export const PLACE_LIST = /[、,，・･/／]/

/**
 * 「〇〇郡〇〇町」の郡（郡のあとに、2字以上の町・村の名前が続くとき）。郡の名前にも町村の名前にも市・町・村の字は入りうる（「余市郡余市町」）。
 * 「大和郡山市」「蒲郡市」は市で終わり、「上郡町」は郡のあとが1字なので郡として除かない
 */
const GUN = /^.+?郡(?=.+[町村]$)/

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

/** 郡を除く（「愛甲郡愛川町」→「愛川町」）。郡の形でなければそのまま */
export const withoutGun = (v: string) => v.replace(GUN, "")

/**
 * 決まった処理で直せる形を直す（住所データが無くてもできるところだけ）: 空白・全角英数をそろえ、先頭の都道府県名、
 * 末尾の括弧書き（「千代田区（丸の内）」）、郡を除く。町名・番地・施設名が続く値は住所データで読む側（address.ts・location/check.ts）が切る。
 * 直したあとも決まりを守らない値は issue に理由を返す（値は直したところまで）
 */
export function tidyPlace(raw: string, prefecture?: string): { value: string; issue?: string } {
  let v = removeSpaces(nfkc(raw))
  const pref = leadingPrefecture(v)
  if (pref && (!prefecture || pref === prefecture)) v = v.slice(pref.length)
  v = withoutGun(v.replace(/[（(][^（()）]*[）)]$/, ""))
  const issue = placeIssue(v)
  return issue ? { value: v, issue } : { value: v }
}

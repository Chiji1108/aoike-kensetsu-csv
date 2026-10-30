import ja from "../../public/japanese-addresses/api/ja.json"
import { jaSchema, placeIndex, type PlaceIndex } from "@/lib/location/check"
import { bundledAddressLookup } from "@/lib/convert/address"

/**
 * サーバーで工事場所を検算する住所データ（画面の住所の分け方と同じ public/ の ja.json をサーバーのコードに入れる。
 * サーバーから自分の静的ファイルは読めないので、ここで読み込む）。最初に使うときに1回だけ索引を作る
 */
let index: PlaceIndex | undefined
export const serverPlaceIndex = (): PlaceIndex => (index ??= placeIndex(jaSchema.parse(ja)))

/** サーバーで住所を都道府県・市区町村に分ける（画面と同じ分け方。チャットが読んだ顧客の回答の工事場所） */
export const serverAddressLookup = bundledAddressLookup(ja)

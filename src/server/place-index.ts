import ja from "../../public/japanese-addresses/api/ja.json"
import { jaSchema, placeIndex, type PlaceIndex } from "@/lib/location/check"

/**
 * サーバーで工事場所を検算する住所データ（画面の住所の分け方と同じ public/ の ja.json をサーバーのコードに入れる。
 * サーバーから自分の静的ファイルは読めないので、ここで読み込む）。最初に使うときに1回だけ索引を作る
 */
let index: PlaceIndex | undefined
export const serverPlaceIndex = (): PlaceIndex => (index ??= placeIndex(jaSchema.parse(ja)))

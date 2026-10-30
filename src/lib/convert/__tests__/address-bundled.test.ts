import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { bundledAddressLookup } from "../address"
import { fileAddressLookup } from "../address-file"

const ja: unknown = JSON.parse(readFileSync(new URL("../../../../public/japanese-addresses/api/ja.json", import.meta.url), "utf8"))

/** 都道府県あり・省略形・政令市の区（市を省いた区も）・郡（書いた・省いた）・都道府県の無い住所・廃止された区・決まらない名前 */
const ADDRESSES = [
  "神奈川県愛甲郡愛川町中津1",
  "愛川町",
  "神奈川県横浜市中区山下町",
  "神奈川県横浜市",
  "横浜市中区",
  "千葉県花見川区",
  "千葉市花見川区",
  "東京都千代田区丸の内1-1",
  "東京都 千代田区",
  "千代田区",
  "北区赤羽",
  "府中市",
  "東京都府中市",
  "神奈川横浜市西区",
  "大阪府大阪市北区梅田",
  "長野原町",
  "群馬県吾妻郡長野原町",
  "群馬県長野原町",
  "東京都",
  "京都府京都市中京区",
  "茨城県かすみがうら市",
  "福岡県糟屋郡篠栗町",
  "静岡県浜松市中区",
  "浜松市中央区",
  "北海道札幌市中央区",
  "札幌市中央区北1条",
  "鹿児島県大島郡瀬戸内町",
  "宮城県仙台市青葉区",
  "東京都千代田区（丸の内）",
  "ニセコ町",
  "埼玉県さいたま市",
  "兵庫県姫路市",
  "沖縄県島尻郡八重瀬町",
]

describe("手元の住所データで引く（サーバー）", () => {
  test("ライブラリで引いたときと同じに分ける", async () => {
    const [bundled, library] = await Promise.all([bundledAddressLookup(ja)(ADDRESSES), fileAddressLookup(ADDRESSES)])
    expect(Object.fromEntries(bundled)).toEqual(Object.fromEntries(library))
  })
})

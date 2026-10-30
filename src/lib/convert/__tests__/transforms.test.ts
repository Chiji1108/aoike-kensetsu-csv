import { describe, expect, test } from "bun:test"
import { NO_ADDRESSES } from "../address"
import { fileAddressLookup } from "../address-file"
import { parsePeriod, parseYearMonth, formatYearMonth } from "../dates"
import { parseInputNumber } from "../text"
import { TRANSFORMS, type TransformId } from "../transforms"

const floor = { rounding: "floor" as const, addresses: NO_ADDRESSES }
const run = (id: TransformId, ...inputs: string[]) => TRANSFORMS[id].run(inputs, floor)
const ym = (s: string) => {
  const v = parseYearMonth(s)
  return v && formatYearMonth(v)
}

describe("業種", () => {
  test.each([
    ["建築一式", "2"],
    ["電気工事", "8"],
    ["電気通信工事", "22"],
    ["とび土工", "5"],
    ["とび・土工・コンクリート工事", "5"],
    ["管工事", "9"],
    ["内装仕上工事業", "19"],
    ["解体工事", "29"],
    ["その他", "30"],
    ["１２", "12"],
  ])("%s → %s", (raw, code) => {
    expect(run("rule.gyoshu", raw)).toEqual({ kind: "value", value: code })
  })

  test("表に無い名前は推測せず AI に回す", () => {
    expect(run("rule.gyoshu", "外構").kind).toBe("ai")
    expect(run("rule.gyoshu", "電").kind).toBe("ai")
  })
})

describe("年月", () => {
  test.each([
    ["令和5年4月", "202304"],
    ["令和元年5月1日", "201905"],
    ["R5.4.1", "202304"],
    ["Ｈ３０．８", "201808"],
    ["平成13年8月", "200108"],
    ["2023-06-01", "202306"],
    ["2023/6", "202306"],
    ["202311", "202311"],
    ["45017", "202304"],
  ])("%s → %s", (raw, expected) => {
    expect(ym(raw)).toBe(expected)
  })

  test("読めない表記は undefined", () => {
    expect(ym("未定")).toBeUndefined()
    expect(ym("令和5年13月")).toBeUndefined()
  })

  test("工期の範囲から着工・完成を取り出す（後ろ側の元号・年の省略も補う）", () => {
    const p = (s: string) => {
      const r = parsePeriod(s)
      return [r?.start && formatYearMonth(r.start), r?.end && formatYearMonth(r.end)]
    }
    expect(p("R5.4.1～R6.3.31")).toEqual(["202304", "202403"])
    expect(p("令和5年6月～令和5年12月")).toEqual(["202306", "202312"])
    expect(p("令和5年4月〜9月")).toEqual(["202304", "202309"])
    expect(p("R5.4.1~6.3.31")).toEqual(["202304", "202403"])
    expect(p("2023/7/1～2023/10/31")).toEqual(["202307", "202310"])
  })

  test("工期の変換: 範囲でない単独の日付は着工だけに使い、完成は AI に回す", () => {
    expect(run("rule.periodStart", "令和5年4月")).toEqual({ kind: "value", value: "202304" })
    expect(run("rule.periodEnd", "令和5年4月").kind).toBe("ai")
  })
})

describe("金額", () => {
  test("円 → 千円（切り捨て・四捨五入）", () => {
    expect(TRANSFORMS["rule.yenToThousand"].run(["32,400,500"], floor)).toEqual({ kind: "value", value: "32400", message: "千円未満（500円）を切り捨て" })
    expect(TRANSFORMS["rule.yenToThousand"].run(["32,400,500"], { rounding: "round", addresses: NO_ADDRESSES })).toEqual({ kind: "value", value: "32401", message: "千円未満（500円）を四捨五入" })
    expect(TRANSFORMS["rule.yenToThousand"].run(["¥5,500,000"], floor)).toEqual({ kind: "value", value: "5500", message: undefined })
    expect(TRANSFORMS["rule.yenToThousand"].run(["1,234万円"], floor)).toEqual({ kind: "value", value: "12340", message: undefined })
  })

  test("千円の列に「千円」「円」の接尾辞があれば単位として読む", () => {
    expect(run("rule.thousandYen", "12,345")).toEqual({ kind: "value", value: "12345", message: undefined })
    expect(run("rule.thousandYen", "12,345,678円")).toMatchObject({ value: "12345" })
    expect(run("rule.yenToThousand", "12,345千円")).toMatchObject({ value: "12345" })
  })

  test("数字でなければエラー", () => {
    expect(run("rule.yenToThousand", "別途見積").kind).toBe("error")
    expect(run("rule.yenToThousand", "-100").kind).toBe("error")
  })
})

describe("元請下請", () => {
  test("区分の表記と注文者から判定する", () => {
    expect(run("rule.motoukeShitauke", "下請", "株式会社A")).toEqual({ kind: "value", value: "2" })
    expect(run("rule.motoukeShitauke", "元請", "横浜市")).toMatchObject({ value: "0" })
    expect(run("rule.motoukeShitauke", "元請", "国土交通省関東地方整備局")).toMatchObject({ value: "0" })
    expect(run("rule.motoukeShitauke", "元請", "株式会社サンプル商事")).toEqual({ kind: "value", value: "1", message: undefined })
    expect(run("rule.motoukeShitauke", "元請", "山田太郎")).toMatchObject({ value: "1", message: "注文者が官公庁ではないため民間元請" })
    expect(run("rule.motoukeShitauke", "1")).toEqual({ kind: "value", value: "1" })
    expect(run("rule.motoukeShitauke", "不明").kind).toBe("error")
  })
})

describe("住所（@geolonia/normalize-japanese-addresses と同梱の住所データ）", () => {
  const address = async (id: "rule.addressPrefecture" | "rule.addressCity", a: string) => TRANSFORMS[id].run([a], { ...floor, addresses: await fileAddressLookup([a]) })

  test.each([
    ["東京都世田谷区桜丘1-2-3", "東京都", "世田谷区"],
    ["神奈川県横浜市港北区新横浜2-5", "神奈川県", "横浜市港北区"],
    ["埼玉県さいたま市大宮区桜木町1", "埼玉県", "さいたま市大宮区"],
    ["三重県四日市市諏訪町1", "三重県", "四日市市"],
    ["北海道余市郡余市町黒川町", "北海道", "余市郡余市町"],
    ["東京都町田市森野2", "東京都", "町田市"],
    ["奈良県大和郡山市北郡山町", "奈良県", "大和郡山市"],
    ["東京都 港区 六本木6-10-1", "東京都", "港区"],
    ["群馬県吾妻郡長野原町大字長野原", "群馬県", "吾妻郡長野原町"],
    ["茨城県竜ヶ崎市馴馬町", "茨城県", "龍ケ崎市"],
  ])("%s → %s / %s", async (a, pref, city) => {
    expect(await address("rule.addressPrefecture", a)).toEqual({ kind: "value", value: pref })
    expect(await address("rule.addressCity", a)).toEqual({ kind: "value", value: city })
  })

  test("都道府県が省かれた住所: 都道府県は AI へ、市区町村は1つの都道府県にだけあるときにルールで決める（郡も補う）", async () => {
    expect((await address("rule.addressPrefecture", "横浜市中区山下町10")).kind).toBe("ai")
    expect(await address("rule.addressCity", "横浜市中区山下町10")).toEqual({ kind: "value", value: "横浜市中区" })
    expect(await address("rule.addressCity", "長野原町大字長野原")).toEqual({ kind: "value", value: "吾妻郡長野原町" })
    expect((await address("rule.addressPrefecture", "長野原町大字長野原")).kind).toBe("ai")
    // 府中市は東京都と広島県にある。決めずに AI へ
    expect((await address("rule.addressCity", "府中市宮町")).kind).toBe("ai")
  })

  test("区を書いていない政令市も市として読む（「横浜市」「神奈川県横浜市」「北海道札幌市」「さいたま市」）", async () => {
    expect(await address("rule.addressCity", "横浜市")).toEqual({ kind: "value", value: "横浜市" })
    expect(await address("rule.addressCity", "神奈川県横浜市")).toEqual({ kind: "value", value: "横浜市" })
    expect(await address("rule.addressPrefecture", "神奈川県横浜市")).toEqual({ kind: "value", value: "神奈川県" })
    expect(await address("rule.addressCity", "北海道札幌市")).toEqual({ kind: "value", value: "札幌市" })
    expect(await address("rule.addressCity", "さいたま市")).toEqual({ kind: "value", value: "さいたま市" })
    // 住所データに無い区（廃止された浜松市中区）が続けば、市だけにせず AI へ
    expect((await address("rule.addressCity", "静岡県浜松市中区元城町")).kind).toBe("ai")
    // 区まで書いてあれば区まで
    expect(await address("rule.addressCity", "神奈川県横浜市中区山下町1")).toEqual({ kind: "value", value: "横浜市中区" })
  })

  test("政令市の名前を省いた区は、県内にその区を持つ政令市が1つだけなら政令市の区にする", async () => {
    expect(await address("rule.addressCity", "千葉県花見川区三角町96番地")).toEqual({ kind: "value", value: "千葉市花見川区" })
    expect(await address("rule.addressCity", "大阪府住之江区南港東4丁目11-115")).toEqual({ kind: "value", value: "大阪市住之江区" })
    // 北区は大阪市と堺市にある
    expect((await address("rule.addressCity", "大阪府北区梅田1-1")).kind).toBe("ai")
    // 都道府県が無ければ政令市の区として読まない（「中央区」は東京都の区として1つに決まる）
    expect(await address("rule.addressCity", "中央区銀座1-1")).toEqual({ kind: "value", value: "中央区" })
  })

  test("都府県を省いた名前は、続く市区町村がその都道府県にあるときだけ都道府県として読む", async () => {
    expect(await address("rule.addressPrefecture", "神奈川横浜市中区")).toEqual({ kind: "value", value: "神奈川県" })
    expect(await address("rule.addressCity", "神奈川横浜市中区")).toEqual({ kind: "value", value: "横浜市中区" })
  })

  test("住所でない値・住所データに無い市区町村は AI へ", async () => {
    expect((await address("rule.addressCity", "ＪＲ東京駅")).kind).toBe("ai")
    expect((await address("rule.addressPrefecture", "ＪＲ東京駅")).kind).toBe("ai")
  })

  test("引いていない値は AI へ（変換の前に addressBookFor で引く）", () => {
    expect(run("rule.addressCity", "東京都千代田区").kind).toBe("ai")
  })

  test("都道府県名の省略形を正式名に", () => {
    expect(run("rule.prefecture", "東京")).toEqual({ kind: "value", value: "東京都" })
    expect(run("rule.prefecture", "大阪")).toEqual({ kind: "value", value: "大阪府" })
    expect(run("rule.prefecture", "北海道")).toEqual({ kind: "value", value: "北海道" })
    expect(run("rule.prefecture", "トウキョウ").kind).toBe("error")
  })
})

describe("氏名・注文者・工事名・有無", () => {
  test("空白があれば全角スペース1つに、無ければ AI へ", () => {
    expect(run("rule.personNameSpace", "佐藤 花子")).toEqual({ kind: "value", value: "佐藤　花子" })
    expect(run("rule.personNameSpace", "田中　　三郎")).toEqual({ kind: "value", value: "田中　三郎" })
    expect(run("rule.personNameSpace", "青池", "一郎")).toEqual({ kind: "value", value: "青池　一郎" })
    expect(run("rule.personNameSpace", "青池一郎").kind).toBe("ai")
  })

  test("法人・官公庁の注文者は元の表記のまま（半角英数・半角カナを全角にしない）、それ以外は AI の判定へ", () => {
    expect(run("ai.anonymizeClient", "ABC株式会社")).toEqual({ kind: "value", value: "ABC株式会社" })
    expect(run("ai.anonymizeClient", "ﾗｲﾄ工業㈱")).toEqual({ kind: "value", value: "ﾗｲﾄ工業㈱" })
    expect(run("ai.anonymizeClient", "横浜市")).toEqual({ kind: "value", value: "横浜市" })
    expect(run("ai.anonymizeClient", "山田太郎").kind).toBe("ai")
  })

  test("「邸」「様」を含む工事名だけ AI へ", () => {
    expect(run("ai.anonymizeWorkName", "山田太郎邸新築工事").kind).toBe("ai")
    expect(run("ai.anonymizeWorkName", "市道123号線擁壁工事")).toEqual({ kind: "value", value: "市道123号線擁壁工事" })
  })

  test("有無 → 0/1", () => {
    expect(run("rule.flag01", "○")).toEqual({ kind: "value", value: "1" })
    expect(run("rule.flag01", "無")).toEqual({ kind: "value", value: "0" })
    expect(run("rule.flag01", "たぶん").kind).toBe("error")
  })
})

test("画面の数の入力は全角数字・カンマ（全角も）・空白を許し、数でなければ読まない", () => {
  expect(["1,000,000", "１，０００，０００", "１０００ ０００", "1000000"].map(parseInputNumber)).toEqual([1000000, 1000000, 1000000, 1000000])
  expect(["", "百万", "1.5", "-1"].map(parseInputNumber)).toEqual([undefined, undefined, undefined, undefined])
})

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { z } from "zod"
import { exportCheck } from "../../cases/export-check"
import { NO_ADDRESSES } from "../../convert/address"
import { fileAddressLookup } from "../../convert/address-file"
import { kojiRow, finalizeAll } from "../../convert/__tests__/helpers"
import { TRANSFORMS } from "../../convert/transforms"
import { checkValue } from "../../convert/validate"
import { needsLookup, normalizeOutcome } from "../../location/sites"
import { KOJI_KEIREKI } from "../koji-keireki"
import { PLACE_RULE, placeIssue, tidyPlace, withoutGun } from "../place"

const placeField = KOJI_KEIREKI.fields.find((f) => f.id === "place")!
const ctx = { rounding: "floor" as const, addresses: NO_ADDRESSES }

describe("場所名の決まり（市・区・町・村で終わる）", () => {
  test("市区町村で終わる名前は守っている（政令市の区・郡を付けた町村も町で終わる）", () => {
    for (const v of ["", "厚木市", "横浜市中区", "千代田区", "愛川町", "愛甲郡愛川町", "檜原村", "郡山市", "大和郡山市", "上郡町", "ニセコ町", "龍ケ崎市"]) expect(placeIssue(v)).toBeUndefined()
  })

  test("郡だけ・施設名・番地・句読点・括弧・都道府県名・並べた地域は理由を返す", () => {
    expect(placeIssue("愛甲郡")).toContain("郡だけ")
    expect(placeIssue("米軍厚木")).toBe(PLACE_RULE)
    expect(placeIssue("厚木市中町1-2")).toContain("番地")
    expect(placeIssue("横浜市中区。")).toContain("句読点")
    expect(placeIssue("千代田区（丸の内）")).toContain("括弧")
    expect(placeIssue("広島市南区、三原市")).toContain("複数の地域")
    expect(placeIssue("神奈川県厚木市")).toContain("都道府県名")
  })

  test("住所データの市区町村の名前（政令市の区・郡なしの町村）はすべて決まりを守る", () => {
    const ja = z
      .object({ data: z.array(z.object({ cities: z.array(z.object({ city: z.string(), ward: z.string().optional() })) })) })
      .parse(JSON.parse(readFileSync(new URL("../../../../public/japanese-addresses/api/ja.json", import.meta.url), "utf8")))
    const bad = ja.data.flatMap((p) => p.cities.map((c) => c.city + (c.ward ?? ""))).filter((n) => placeIssue(n))
    expect(bad).toEqual([])
  })

  test("郡を除く（郡のあとが2字以上の町村のときだけ。「上郡町」「大和郡山市」はそのまま）", () => {
    expect(withoutGun("愛甲郡愛川町")).toBe("愛川町")
    expect(withoutGun("余市郡余市町")).toBe("余市町")
    expect(withoutGun("赤穂郡上郡町")).toBe("上郡町")
    expect(withoutGun("上郡町")).toBe("上郡町")
    expect(withoutGun("大和郡山市")).toBe("大和郡山市")
    expect(withoutGun("西多摩郡檜原村")).toBe("檜原村")
  })

  test("決まった処理で直せる形を直す: 空白・先頭の都道府県名・末尾の括弧書き・郡。直せないものは理由を残す", () => {
    expect(tidyPlace(" 神奈川県 愛甲郡愛川町 ")).toEqual({ value: "愛川町" })
    expect(tidyPlace("東京都千代田区（丸の内）")).toEqual({ value: "千代田区" })
    expect(tidyPlace("横浜市中区", "神奈川県")).toEqual({ value: "横浜市中区" })
    // 別の都道府県の名前は除かない（都道府県名の欄と食い違う）
    expect(tidyPlace("東京都港区", "神奈川県").issue).toContain("都道府県名")
    expect(tidyPlace("米軍厚木")).toEqual({ value: "米軍厚木", issue: PLACE_RULE })
    expect(tidyPlace("愛甲郡").issue).toContain("郡だけ")
  })
})

describe("検証と書き出す前の確認", () => {
  test("場所名の検証は決まりを守らない値をエラーにする", () => {
    expect(checkValue(placeField, "米軍厚木")).toEqual({ severity: "error", message: PLACE_RULE })
    expect(checkValue(placeField, "愛甲郡")?.severity).toBe("error")
    expect(checkValue(placeField, "愛川町")).toBeUndefined()
  })

  test("書き出す前の確認にも同じ理由で出る", () => {
    const { rows } = finalizeAll([kojiRow({ prefecture: "神奈川県", place: "米軍厚木" }, 1), kojiRow({ prefecture: "神奈川県", place: "厚木市" }, 2)])
    const c = exportCheck(rows, [])
    expect(c.issues.find((i) => i.field === "place")).toEqual({ status: "error", field: "place", message: PLACE_RULE, count: 1 })
  })

  test("決まりを守らない場所名の行は、工事場所の調査（AI で案を出す）の対象になる", () => {
    const [bad, ok] = finalizeAll([kojiRow({ prefecture: "神奈川県", place: "米軍厚木" }, 1), kojiRow({ prefecture: "神奈川県", place: "厚木市" }, 2)]).rows
    expect(needsLookup(bad!.cells.prefecture, bad!.cells.place)).toBe(true)
    expect(needsLookup(ok!.cells.prefecture, ok!.cells.place)).toBe(false)
  })
})

describe("場所名を作る変換", () => {
  test("rule.place: 住所データで市区町村まで読み（町名・番地を落とし、郡を除く）、読めなければ直せる形だけ直し、直せなければエラー", async () => {
    const run = async (v: string) => TRANSFORMS["rule.place"].run([v], { ...ctx, addresses: await fileAddressLookup([v]) })
    expect(await run("厚木市中町1-2-3")).toEqual({ kind: "value", value: "厚木市" })
    expect(await run("愛甲郡愛川町")).toEqual({ kind: "value", value: "愛川町" })
    expect(await run("府中市")).toEqual({ kind: "value", value: "府中市" })
    expect(await run("米軍厚木")).toEqual({ kind: "error", message: PLACE_RULE })
    expect((await run("愛甲郡")).kind).toBe("error")
  })

  const inferred = (prefecture: string, place: string) =>
    TRANSFORMS["ai.inferPlace"].ai!.apply("", { id: 0, prefecture, place, needsReview: false, note: "" })

  test("ai.inferPlace: AI の場所名を決まりの形にし、直せなければ使わない（空の推定として調査へ）", () => {
    expect(inferred("神奈川県", "神奈川県愛甲郡愛川町")).toMatchObject({ value: "愛川町", status: "warning" })
    expect(inferred("広島県", "広島市南区、三原市")).toMatchObject({ value: "", status: "warning" })
    expect(inferred("神奈川県", "米軍厚木").message).toContain("米軍厚木")
  })

  test("住所の分割の AI: 検算は郡を含めた形で、値は郡を除く", () => {
    const r = TRANSFORMS["rule.addressCity"].ai!.apply("神奈川県愛甲郡愛川町中津1", {
      id: 0,
      prefecture: "神奈川県",
      city: "愛甲郡愛川町",
      rest: "中津1",
      prefectureInferred: false,
      needsReview: false,
      note: "",
    })
    expect(r).toMatchObject({ value: "愛川町", status: "ai" })
  })
})

describe("調べた結果の形", () => {
  const found = { kind: "found" as const, prefecture: "広島県", urls: [], source: "memory" as const, confident: true, note: "" }
  test("決まりを守らない場所名（前の版で覚えた並べた地域など）は使わず、自信なしにする", () => {
    expect(normalizeOutcome({ ...found, place: "広島市南区、三原市" })).toMatchObject({ kind: "found", place: "", confident: false })
    expect(normalizeOutcome({ ...found, place: "三原市" })).toMatchObject({ kind: "found", place: "三原市", confident: true })
  })
})

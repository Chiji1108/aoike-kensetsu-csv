import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI } from "../../spec/koji-keireki"
import { checkValue, widthOf } from "../validate"

const field = (id: string) => KOJI_KEIREKI.fields.find((f) => f.id === id)!

describe("字数の上限（注文者 全角27字、工事名 全角51字。半角は0.5字）", () => {
  test("半角は0.5字として数える", () => {
    expect(widthOf("ＡＢ")).toBe(2)
    expect(widthOf("AB ｱｲ")).toBe(2.5)
  })

  test("注文者は27字まで、28字でエラー", () => {
    expect(checkValue(field("client"), "株".repeat(27))).toBeUndefined()
    expect(checkValue(field("client"), "株".repeat(28))).toMatchObject({ severity: "error" })
  })

  test("工事名は半角を0.5字として51字まで", () => {
    expect(checkValue(field("workName"), "工".repeat(50) + "AB")).toBeUndefined()
    expect(checkValue(field("workName"), "工".repeat(51) + "A")).toMatchObject({ severity: "error", message: expect.stringContaining("51.5字") })
  })
})

describe("個人名が残っていそうな値（警告）", () => {
  test("注文者が氏名だけなら警告、会社・役所・記号は警告しない", () => {
    expect(checkValue(field("client"), "山田　太郎")).toMatchObject({ severity: "warning", message: expect.stringContaining("個人名") })
    expect(checkValue(field("client"), "山田太郎様")).toMatchObject({ severity: "warning" })
    for (const v of ["鹿島建設", "㈱山田工務店", "千代田区", "横浜市", "長野原町", "山田書店", "北海道", "城南信用金庫", "大林組", "Ａ", "Ｂ２"]) expect(checkValue(field("client"), v)).toBeUndefined()
  })

  test("村・町・市・国などを含む姓（中村・町田・市川・国分）の氏名も警告する", () => {
    for (const v of ["中村　太郎", "町田　花子", "市川一郎", "国分　次郎", "野村様", "北村"]) expect(checkValue(field("client"), v), v).toMatchObject({ severity: "warning" })
  })

  test("工事名の「〇〇様邸」「〇〇邸」は警告、記号の邸・公邸・住宅は警告しない", () => {
    expect(checkValue(field("workName"), "山田様邸新築工事")).toMatchObject({ severity: "warning" })
    expect(checkValue(field("workName"), "山田 太郎邸改修工事")).toMatchObject({ severity: "warning" })
    for (const v of ["Ａ邸新築工事", "Ｂ様邸改修工事", "知事公邸改修工事", "市営住宅改修工事", "森林公園前 Ａ邸"]) expect(checkValue(field("workName"), v)).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { fileAddressLookup } from "../../convert/address-file"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import type { AiBatchRequest } from "../../convert/ai-tasks"
import type { KojiFieldId } from "../../spec/koji-keireki"
import { outsideCells, readAiAnswers } from "../inquiry"

const full = {
  gyoshu: "8", client: "株式会社テスト", motoukeShitauke: "1", jv: "0", workName: "テストビル電気工事", prefecture: "東京都",
  place: "千代田区", engineer: "試験　太郎", amount: "5000", specialAmount: "0", startYm: "202404", endYm: "202409",
} satisfies Partial<Record<KojiFieldId, string>>

const noEngineer = kojiRow({ ...full, engineer: "", endYm: "" }, 2)
const guessedPlace = (() => {
  const r = kojiRow({ ...full, workName: "テスト倉庫改修工事" }, 3)
  r.cells.place = { value: "港区", status: "warning", source: "E列", original: "", message: "現場名から推定", guessed: true }
  return r
})()
const noLocation = kojiRow({ ...full, prefecture: "", place: "" }, 4)
const rows = [noEngineer, guessedPlace, noLocation]

const noAi = () => ({ ctx: { rounding: "floor" as const }, lookup: fileAddressLookup, cache: new Map(), fields: {} })
/** 匿名化の決まった応答: 工事名は「邸」の前を個人名として印にする */
const cannedAnonymize = async (req: AiBatchRequest) => ({
  ok: true as const,
  json: {
    results: req.items.map((i) => {
      const m = /^(.+?)様?邸/.exec(i.input)
      return m ? { id: i.id, value: i.input.replace(m[1]!, "〔1〕"), persons: [m[1]!], needsReview: false, note: "" } : { id: i.id, value: i.input, persons: [], needsReview: false, note: "" }
    }),
  },
})

describe("AI が読んだ顧客の回答", () => {
  test("記入用Excelの記入と同じ決まりで値にする（年月・工事場所・配置技術者の区切り）。推定どおりという答えは確認にする", async () => {
    const r = await readAiAnswers(
      [
        { rowKey: noEngineer.key, field: "engineer", answer: "試験 次郎" },
        { rowKey: noEngineer.key, field: "endYm", answer: "2024年10月" },
        { rowKey: guessedPlace.key, field: "place", confirm: true },
        { rowKey: noLocation.key, field: "place", answer: "神奈川県横浜市中区山下町1" },
      ],
      rows,
      noAi(),
    )
    expect(Object.fromEntries(r.edits)).toEqual({
      [`${noEngineer.key}:engineer`]: { value: "試験　次郎", by: "customer" },
      [`${noEngineer.key}:endYm`]: { value: "202410", by: "customer" },
      [`${guessedPlace.key}:place`]: { value: "港区", by: "confirmed" },
      [`${noLocation.key}:prefecture`]: { value: "神奈川県", by: "customer" },
      [`${noLocation.key}:place`]: { value: "横浜市中区", by: "customer" },
    })
    expect(r.applied.map((q) => q.field)).toEqual(["engineer", "endYm", "prefecture", "place"])
    expect(r.confirmed.map((q) => q.field)).toEqual(["place"])
  })

  test("都道府県と場所名を別々に送っても1つの住所として読む。読めない答え・同じ欄の食い違う答えは反映しない", async () => {
    const r = await readAiAnswers(
      [
        { rowKey: noLocation.key, field: "prefecture", answer: "大阪府" },
        { rowKey: noLocation.key, field: "place", answer: "大阪市北区" },
        { rowKey: noEngineer.key, field: "endYm", answer: "去年の秋" },
        { rowKey: guessedPlace.key, field: "place", answer: "東京都港区" },
        { rowKey: guessedPlace.key, field: "place", answer: "東京都品川区" },
      ],
      rows,
      noAi(),
    )
    expect(Object.fromEntries(r.edits)).toEqual({
      [`${noLocation.key}:prefecture`]: { value: "大阪府", by: "customer" },
      [`${noLocation.key}:place`]: { value: "大阪市北区", by: "customer" },
    })
    expect(r.invalid.map((i) => [i.inquiry.field, i.message])).toEqual([
      ["place", "同じ欄に違う答えが2つあります"],
      ["endYm", "年月として読めません（例: 2024年4月）"],
    ])
  })

  test("聞いていない項目への答え（顧客からの訂正）も、今と違えば変更にする。同じなら変えない。知らない行は知らせる", async () => {
    const r = await readAiAnswers(
      [
        { rowKey: noEngineer.key, field: "startYm", answer: "2024年5月" },
        { rowKey: noEngineer.key, field: "client", answer: "株式会社テスト" },
        { rowKey: "s!99", field: "engineer", answer: "試験 三郎" },
      ],
      rows,
      noAi(),
    )
    expect(Object.fromEntries(r.edits)).toEqual({ [`${noEngineer.key}:startYm`]: { value: "202405", by: "customer" } })
    expect(r.alreadyApplied.map((q) => q.field)).toEqual(["client"])
    expect(r.unknownKeys).toEqual(["s!99"])
  })

  test("工事名の答えは元データと同じく匿名化に通す（個人名は印にする）。AI を使えなければ反映しない", async () => {
    const items = [{ rowKey: noEngineer.key, field: "workName" as const, answer: "山田太郎邸新築工事" }]
    const r = await readAiAnswers(items, rows, { ...noAi(), callAi: cannedAnonymize })
    expect(r.edits).toEqual([[`${noEngineer.key}:workName`, { value: `${personToken("山田太郎")}邸新築工事`, by: "customer", status: "ai", byAi: true }]])
    const without = await readAiAnswers(items, rows, noAi())
    expect(without.edits).toEqual([])
    expect(without.invalid).toHaveLength(1)
  })
})

describe("記入用Excelの決まった欄の外の記入", () => {
  test("見出しの無い列・知らない見出しの列・ほかのシートの記入を数える（記入の欄・表示の欄・照合用は数えない）", () => {
    const sheet = {
      name: "ご記入のお願い",
      rows: [
        ["お願い"],
        ["管理番号", "工事名", "配置技術者", "照合用", "", "備考"],
        ["s!2", "テストビル電気工事", "", "{}", "試験次郎です", ""],
        ["s!3", "テスト倉庫改修工事", "", "{}", "", "場所は合っています"],
      ],
      hidden: [],
    }
    expect(outsideCells([sheet])).toBe(2)
    expect(outsideCells([sheet, { name: "メモ", rows: [["完成は10月"], [""]], hidden: [] }])).toBe(3)
  })
})

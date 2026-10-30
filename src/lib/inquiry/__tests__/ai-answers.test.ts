import { describe, expect, test } from "bun:test"
import { fileAddressLookup } from "../../convert/address-file"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import type { AiBatchRequest } from "../../convert/ai-tasks"
import type { KojiFieldId } from "../../spec/koji-keireki"
import type { SheetGrid } from "../../convert/plan"
import { codeLabel } from "../../spec/code-sets"
import { CORRECTION_MESSAGE, outsideCells, readAiAnswers } from "../inquiry"

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

  test("都道府県と場所名を別々に送っても1つの住所として読む（場所名を都道府県から書いても）。読めない答え・同じ欄の食い違う答えは反映しない", async () => {
    const r = await readAiAnswers(
      [
        { rowKey: noLocation.key, field: "prefecture", answer: "大阪府" },
        { rowKey: noLocation.key, field: "place", answer: "大阪府大阪市北区" },
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
      ["place", "同じ項目に違う答えが2つあります"],
      ["endYm", "年月として読めません（例: 2024年4月）"],
    ])
  })

  test("聞いていない項目への答え（顧客からの訂正）は、問い合わせへの答えと分けて訂正として返す。今と同じなら変えない。知らない行は知らせる", async () => {
    const r = await readAiAnswers(
      [
        { rowKey: noEngineer.key, field: "startYm", answer: "2024年5月" },
        { rowKey: noEngineer.key, field: "client", answer: "株式会社テスト" },
        { rowKey: "s!99", field: "engineer", answer: "試験 三郎" },
      ],
      rows,
      noAi(),
    )
    expect(Object.fromEntries(r.edits)).toEqual({ [`${noEngineer.key}:startYm`]: { value: "202405", by: "customer", message: CORRECTION_MESSAGE } })
    expect(r.applied).toEqual([])
    expect(r.alreadyApplied).toEqual([])
    expect(r.alsoChanged).toEqual([{ rowKey: noEngineer.key, field: "startYm", was: "202404", answer: "202405" }])
    expect(r.unknownKeys).toEqual(["s!99"])
  })

  test("聞いていない工事場所の訂正は送った項目だけを変える（都道府県のある行で場所名だけを直す）", async () => {
    const r = await readAiAnswers([{ rowKey: noEngineer.key, field: "place", answer: "港区" }], rows, noAi())
    expect(Object.fromEntries(r.edits)).toEqual({ [`${noEngineer.key}:place`]: { value: "港区", by: "customer", message: CORRECTION_MESSAGE } })
    expect(r.heldBack).toEqual([])
    expect(r.invalid).toEqual([])
  })

  test("工事場所の片方を今のとおり（confirm）、片方を答えで送ると、1つの住所として読む", async () => {
    const r = await readAiAnswers(
      [
        { rowKey: guessedPlace.key, field: "prefecture", confirm: true },
        { rowKey: guessedPlace.key, field: "place", answer: "品川区" },
      ],
      rows,
      noAi(),
    )
    expect(Object.fromEntries(r.edits)).toEqual({ [`${guessedPlace.key}:place`]: { value: "品川区", by: "customer" } })
    expect(r.applied.map((q) => q.field)).toEqual(["place"])
    expect(r.invalid).toEqual([])
  })

  test("工事名の答えは元データと同じく匿名化に通す（個人名は印にする）。AI を使えなければ反映しない", async () => {
    const items = [{ rowKey: noEngineer.key, field: "workName" as const, answer: "山田太郎邸新築工事" }]
    const r = await readAiAnswers(items, rows, { ...noAi(), callAi: cannedAnonymize })
    expect(r.edits).toEqual([[`${noEngineer.key}:workName`, { value: `${personToken("山田太郎")}邸新築工事`, by: "customer", status: "ai", byAi: true, message: CORRECTION_MESSAGE }]])
    const without = await readAiAnswers(items, rows, noAi())
    expect(without.edits).toEqual([])
    expect(without.uncorrected.map((u) => u.field)).toEqual(["workName"])
  })
})

describe("記入用Excelの決まった欄の外の記入", () => {
  const meta = (fields: string[]) => JSON.stringify({ asked: fields.map((field) => ({ field, reason: "missing", current: "" })) })
  const header = ["管理番号", "業種", "工事名", "請負代金（千円）", "配置技術者", "照合用", "", "備考"]
  /** 出したときのまま（工事名・請負代金は表示だけ、配置技術者は聞いた欄で空のまま） */
  const sent = (r: typeof noEngineer, extra: string[] = []) => [r.key, codeLabel("gyoshu", r.cells.gyoshu.value) ?? r.cells.gyoshu.value, r.cells.workName.value, r.cells.amount.value, "", meta(["engineer"]), ...extra]
  const sheet = (rows: string[][], notes: SheetGrid["notes"] = []): SheetGrid => ({ name: "ご記入のお願い", rows: [["お願いの文"], [], header, ...rows], hidden: [], notes })

  test("出したときのままなら数えない", () => {
    expect(outsideCells([sheet([sent(noEngineer)])], rows)).toBe(0)
  })

  test("見出しの無い列・知らない見出しの列・ほかのシート・見出しより上（お願いの文の外）・顧客が付けたメモ・表示だけの欄の書き換えを数える", () => {
    const changed = [...sent(noEngineer)]
    changed[3] = "6000"
    const grid = sheet([sent(noEngineer, ["試験次郎です", "完成は10月"]), changed], [
      { row: 3, column: 4, text: "担当は試験 次郎" },
      { row: 3, column: 2, text: "推定です。正しいか確認し、違えば書き直してください" },
    ])
    grid.rows[0]!.push("工事場所は全部東京です")
    expect(outsideCells([grid, { name: "メモ", rows: [["完成は10月"], [""]], hidden: [] }], rows)).toBe(2 + 1 + 1 + 1 + 1)
  })
})

test("返ってきた Excel のセルのメモを読む（顧客がメモに書いた答え）", async () => {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("ご記入のお願い")
  ws.addRows([["管理番号", "配置技術者", "照合用"], ["s!2", "", "{}"]])
  ws.getCell(2, 2).note = "担当は試験 次郎"
  const { readWorkbook } = await import("../../convert/workbook")
  const [grid] = readWorkbook("回答.xlsx", new Uint8Array(await wb.xlsx.writeBuffer()))
  expect(grid!.notes).toEqual([{ row: 1, column: 1, text: "担当は試験 次郎" }])
})

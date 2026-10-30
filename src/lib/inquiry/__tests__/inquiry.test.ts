import { describe, expect, test } from "bun:test"
import ExcelJS from "exceljs"
import { readWorkbook } from "../../convert/workbook"
import { fileAddressLookup } from "../../convert/address-file"
import { NO_ADDRESSES } from "../../convert/address"
import { inquiryXlsx } from "../inquiry-xlsx"
import { finalizeAll, fixture, kojiRow } from "../../convert/__tests__/helpers"
import { heuristicPlan } from "../../convert/heuristic-plan"
import { runConversion, type AiCache, type AiCaller } from "../../convert/pipeline"
import { collectSourceRows } from "../../convert/sources"
import { aiKey, convertRows, editKey, editText, resolveRows, staffEdit, type CellEdits, type RowResult } from "../../convert/convert"
import { personToken } from "../../convert/persons"
import type { MappingPlan, SheetGrid } from "../../convert/plan"
import type { AiBatchRequest } from "../../convert/ai-tasks"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS, type KojiFieldId } from "../../spec/koji-keireki"
import { ADDRESSEE_PLACEHOLDER, inquiryEmail } from "../email"
import { collectInquiries, inquirySheet, mergeAnswers, readAnswers, type AnswerReport, type CellInquiry, type Inquiry } from "../inquiry"

const full = {
  gyoshu: "8", client: "株式会社テスト", motoukeShitauke: "1", jv: "0", workName: "テストビル電気工事", prefecture: "東京都",
  place: "千代田区", engineer: "試験　太郎", amount: "5000", specialAmount: "0", startYm: "202404", endYm: "202409",
} satisfies Partial<Record<KojiFieldId, string>>

const complete = kojiRow(full, 1)
const noEngineer = kojiRow({ ...full, engineer: "" }, 2)
const guessedPlace = (() => {
  const r = kojiRow({ ...full, workName: "テスト倉庫改修工事" }, 3)
  r.cells.place = { value: "港区", status: "warning", source: "E列", original: "", message: "現場名から推定", guessed: true }
  return r
})()
const noLocation = kojiRow({ ...full, prefecture: "", place: "", startYm: "" }, 4)

/** 工事名の列だけがあり、都道府県・場所名は工事名から AI で推定する計画 */
const inferPlan = (() => {
  const fields = Object.fromEntries(KOJI_KEIREKI.fields.map((f) => [f.id, { kind: "missing" as const }])) as MappingPlan<KojiFieldId>["fields"]
  fields.workName = { kind: "column", column: 0, transform: "rule.text" }
  fields.prefecture = { kind: "column", column: 0, transform: "ai.inferPrefecture" }
  fields.place = { kind: "column", column: 0, transform: "ai.inferPlace" }
  return { sheets: ["s"], headerRow: 0, dataRows: { start: 1, end: 1 }, skipRows: [], rowFilter: { excludeHidden: false, excludeColumns: [] }, amountUnit: "thousandYen", fields, unusedColumns: [], notes: [] } satisfies MappingPlan<KojiFieldId>
})()

const cells = (qs: Inquiry[]) => qs.flatMap((q) => (q.kind === "cell" ? [`${q.rowKey}:${q.field}:${q.reason}`] : [`case:${q.topic}`]))
/** APIキーなし（AI を呼ばない）で回答を読む */
const noAi = () => ({ ctx: { rounding: "floor" as const }, lookup: fileAddressLookup, cache: new Map(), fields: {} })
/** 顧客が書き換えた欄の反映（推定をそのまま返した「確認」は除く） */
const customerEdits = (r: AnswerReport) => r.edits.filter(([, e]) => e.by === "customer")
const cellInquiries = (qs: Inquiry[]) => qs.filter((q): q is CellInquiry => q.kind === "cell")
/** 匿名化の決まった応答: 注文者は全体、工事名は「邸」の前を個人名として印にする（記号はアプリが付ける） */
const cannedAnonymize = async (req: AiBatchRequest) => ({
  ok: true as const,
  json: {
    results: req.items.map((i) => {
      if (req.task === "anonymizeClient") return { id: i.id, value: "〔1〕", persons: [i.input], needsReview: false, note: "" }
      const m = /^(.+?)様?邸/.exec(i.input)
      return m ? { id: i.id, value: i.input.replace(m[1]!, "〔1〕"), persons: [m[1]!], needsReview: false, note: "" } : { id: i.id, value: i.input, persons: [], needsReview: false, note: "" }
    }),
  },
})

describe("collectInquiries", () => {
  test("書類に要る項目が空のセルと、推定に自信がないセルを聞く。揃っている行・CSV で任意の項目（主任技術者など）は聞かない", () => {
    const qs = collectInquiries([complete, noEngineer, guessedPlace, noLocation], { tax: "included" })
    expect(cells(qs)).toEqual([
      "s!2:engineer:missing",
      "s!3:place:needsReview",
      "s!4:prefecture:missing",
      "s!4:place:missing",
      "s!4:startYm:missing",
    ])
  })

  test("匿名化の検算に落ちて出さなかった値は、元データにあるので顧客に聞かない（職員が直す）", async () => {
    const [grid] = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
    const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid!)
    const { rows: sources } = collectSourceRows([grid!], plan)
    const leaky = async (req: AiBatchRequest) =>
      req.task === "anonymizeWorkName"
        ? { ok: true as const, json: { results: req.items.map((i) => ({ id: i.id, value: i.input, persons: ["山田太郎"], needsReview: false, note: "" })) } }
        : cannedAnonymize(req)
    const rows = finalizeAll(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx: { rounding: "floor" }, cache: new Map(), callAi: leaky }), { replacements: {}, edits: new Map() }).rows
    const yamada = rows.find((r) => r.cells.client.value === "Ａ")!
    expect(yamada.cells.workName).toMatchObject({ value: "", status: "error" })
    expect(yamada.cells.workName.message).toContain("手で入力してください")
    expect(cells(collectInquiries([yamada], { tax: "included" })).filter((q) => q.includes("workName"))).toEqual([])
  })

  test("AI を使えずに空になった欄は、元データに値があるので顧客に聞かない（職員が変換をやり直す）", async () => {
    const [grid] = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
    const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid!)
    const { rows: sources } = collectSourceRows([grid!], plan)
    const failing = async () => ({ ok: false as const, message: "AI のエラー" })
    const rows = finalizeAll(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx: { rounding: "floor" }, cache: new Map(), callAi: failing })).rows
    const noPrefecture = rows.filter((r) => r.cells.prefecture.value === "" && r.cells.prefecture.original !== "")
    expect(noPrefecture.length).toBeGreaterThan(0)
    expect(cells(collectInquiries(noPrefecture, { tax: "included" })).filter((q) => q.includes("prefecture"))).toEqual([])
  })

  test("元データに無い所在地を推定する AI が使えなかった欄は、データに無いので顧客に聞く", () => {
    const drafts = convertRows(KOJI_KEIREKI, [{ sheet: "s", row: 1, cells: ["テスト倉庫改修工事"], hidden: false }], inferPlan, { rounding: "floor", addresses: NO_ADDRESSES })
    const rows = finalizeAll(resolveRows(drafts, new Map())).rows
    expect(rows[0]!.cells.prefecture).toMatchObject({ value: "" })
    expect(rows[0]!.cells.prefecture.withheld).toBeUndefined()
    expect(cells(collectInquiries(rows, { tax: "included" })).filter((q) => q.includes("prefecture") || q.includes("place"))).toEqual(["s!1:prefecture:missing", "s!1:place:missing"])
  })

  test("職員が手直しで空にした欄は、わざと空にしたので聞かない", () => {
    const [cleared] = finalizeAll([complete], { edits: new Map([[editKey("s!1", "engineer"), { value: "", by: "staff" }]]) }).rows
    expect(cleared!.cells.engineer.value).toBe("")
    expect(cells(collectInquiries([cleared!], { tax: "included" }))).toEqual([])
    expect(cells(collectInquiries(finalizeAll([noEngineer]).rows, { tax: "included" }))).toEqual(["s!2:engineer:missing"])
  })

  test("税区分が不明なら案件単位で税込・税抜を聞く", () => {
    expect(cells(collectInquiries([complete], { tax: "unknown" }))).toEqual(["case:tax"])
    expect(collectInquiries([complete], { tax: "excluded" })).toEqual([])
  })
})

describe("記入用Excelとメール", () => {
  const rows = [complete, noEngineer, guessedPlace, noLocation]
  const qs = collectInquiries(rows, { tax: "unknown" })
  const sheet = inquirySheet(rows, cellInquiries(qs))

  test("問い合わせのある行だけ、聞くセルだけ塗る。都道府県と場所名は1つの欄にまとめる", () => {
    const headers = sheet.columns.map((c) => c.header)
    expect(headers).toEqual(["管理番号", "業種", "工事名", "注文者", "請負代金（千円）", "着工年月", "完成年月", "工事場所（都道府県・市区町村）", "配置技術者", "照合用"])
    expect(sheet.rows.map((r) => r.cells[0]!.value)).toEqual(["s!2", "s!3", "s!4"])
    const asked = sheet.rows.map((r) => r.cells.flatMap((c, i) => (c.ask ? [headers[i]] : [])))
    expect(asked).toEqual([["配置技術者"], ["工事場所（都道府県・市区町村）"], ["着工年月", "工事場所（都道府県・市区町村）"]])
    expect(sheet.askCount).toBe(4)
    expect(sheet.rows[1]!.cells[7]!.value).toBe("東京都港区")
  })

  test("場所も技術者も聞かないなら、その列を出さない", () => {
    const s = inquirySheet([noLocation], cellInquiries(collectInquiries([noLocation], { tax: "included" })))
    expect(s.columns.map((c) => c.header)).not.toContain("配置技術者")
  })

  test("メールは宛名の空欄・税込税抜の質問・記入件数を含む", () => {
    const mail = inquiryEmail([{ kind: "case", topic: "tax" }], sheet)
    expect(mail.startsWith(`${ADDRESSEE_PLACEHOLDER} 様`)).toBe(true)
    expect(mail).toContain("税込・税抜のどちら")
    expect(mail).toContain("添付のExcelの色付きの欄にご記入ください（4件）")
    expect(mail).toContain("配置技術者：1件")
  })
})

describe("回答の取り込み", () => {
  const rows = [complete, noEngineer, guessedPlace, noLocation]
  const sent = cellInquiries(collectInquiries(rows, { tax: "included" }))
  const sheet = inquirySheet(rows, sent)
  const header = sheet.columns.map((c) => c.header)
  const answered = (fill: Record<string, Record<string, string>>, extra: string[][] = []): SheetGrid[] => [
    {
      name: "記入用",
      rows: [
        ["工事経歴書の確認のお願い"],
        header,
        ...sheet.rows.map((r) => r.cells.map((c, i) => fill[r.cells[0]!.value]?.[header[i]!] ?? c.value)),
        ...extra,
      ],
      hidden: [],
    },
  ]
  const finalize = (rs: RowResult<KojiFieldId>[], edits = new Map()) => finalizeAll(rs, { edits }).rows

  test("記入を顧客の回答として適用する。氏名は全角スペースに、場所は都道府県と市区町村に分ける。聞いていない都道府県も書き換えられていれば適用して知らせる", async () => {
    const report = await readAnswers(
      answered({
        "s!2": { 配置技術者: "試験 次郎" },
        "s!3": { "工事場所（都道府県・市区町村）": "神奈川県横浜市中区山下町1" },
        "s!4": { 着工年月: "2024年5月", "工事場所（都道府県・市区町村）": "大阪府大阪市北区梅田1-1" },
      }),
      rows,
      noAi(),
    )
    if ("error" in report) throw new Error(report.error)
    expect(Object.fromEntries(report.edits)).toEqual({
      [editKey("s!2", "engineer")]: { value: "試験　次郎", by: "customer" },
      [editKey("s!3", "place")]: { value: "横浜市中区", by: "customer" },
      [editKey("s!3", "prefecture")]: { value: "神奈川県", by: "customer" },
      [editKey("s!4", "startYm")]: { value: "202405", by: "customer" },
      [editKey("s!4", "prefecture")]: { value: "大阪府", by: "customer" },
      [editKey("s!4", "place")]: { value: "大阪市北区", by: "customer" },
    })
    expect(report.alsoChanged).toEqual([{ rowKey: "s!3", field: "prefecture", was: "東京都", answer: "神奈川県" }])
    expect(report.applied.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!2:engineer", "s!3:place", "s!4:prefecture", "s!4:place", "s!4:startYm"])
    const out = finalize(rows, new Map(report.edits))
    expect(out[2]!.cells.prefecture.value + out[2]!.cells.place.value).toBe("神奈川県横浜市中区")
    expect(out[1]!.cells.engineer).toMatchObject({ value: "試験　次郎", status: "changed", message: "顧客の回答" })
    expect(cellInquiries(collectInquiries(out, { tax: "included" }))).toEqual([])
  })

  test("読んでいる間に職員が直したセルの回答は、今の手直しを上書きせず changed に回す。工事場所はもう片方も反映しない", async () => {
    const read = finalize(rows)
    const report = await readAnswers(
      answered({
        "s!2": { 配置技術者: "試験 次郎" },
        "s!3": { "工事場所（都道府県・市区町村）": "神奈川県横浜市中区" },
        "s!4": { 着工年月: "2024年5月" },
      }),
      read,
      noAi(),
    )
    if ("error" in report) throw new Error(report.error)
    const now = new Map([
      [editKey("s!2", "engineer"), { value: "職員　入力", by: "staff" as const }],
      [editKey("s!3", "place"), { value: "品川区", by: "staff" as const }],
    ])
    const merged = mergeAnswers(report, read, { rows, replacements: {}, edits: now })
    expect(Object.fromEntries(merged.edits)).toEqual({
      [editKey("s!2", "engineer")]: { value: "職員　入力", by: "staff" },
      [editKey("s!3", "place")]: { value: "品川区", by: "staff" },
      [editKey("s!4", "startYm")]: { value: "202405", by: "customer" },
    })
    expect(merged.report.changed).toEqual([
      { rowKey: "s!2", field: "engineer", now: "職員　入力", answer: "試験　次郎" },
      { rowKey: "s!3", field: "place", now: "品川区", answer: "横浜市中区" },
    ])
    expect(merged.report.heldBack).toEqual([{ rowKey: "s!3", field: "prefecture", answer: "神奈川県" }])
    expect(merged.report.alsoChanged).toEqual([])
    expect(merged.report.applied.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!4:startYm"])
    expect(mergeAnswers(report, read, { rows, replacements: {}, edits: new Map() }).edits.get(editKey("s!2", "engineer"))).toEqual({ value: "試験　次郎", by: "customer" })
  })

  test("読んでいる間に手直し以外（変換のやり直し・一括置換）でセルの値が変わっても、その回答は反映せず changed に回す", async () => {
    const read = finalize(rows)
    const report = await readAnswers(answered({ "s!2": { 配置技術者: "試験 次郎" }, "s!4": { 着工年月: "2024年5月" } }), read, noAi())
    if ("error" in report) throw new Error(report.error)
    const reconverted = rows.map((r) => (r.key === "s!4" ? { ...r, cells: { ...r.cells, startYm: { value: "202406", status: "ai" as const, source: "H列", original: "R6.6" } } } : r))
    const merged = mergeAnswers(report, read, { rows: reconverted, replacements: {}, edits: new Map() })
    expect(Object.fromEntries(merged.edits)).toEqual({
      [editKey("s!2", "engineer")]: { value: "試験　次郎", by: "customer" },
      [editKey("s!3", "place")]: { value: "港区", by: "confirmed" },
    })
    expect(merged.report.changed).toEqual([{ rowKey: "s!4", field: "startYm", now: "202406", answer: "202405" }])

    expect(mergeAnswers(report, read, { rows, replacements: { startYm: { "": { value: "202407", by: "staff" } } }, edits: new Map() }).report.changed.map((c) => `${c.rowKey}:${c.field}:${c.now}`)).toEqual(["s!4:startYm:202407"])
  })

  test("空欄・推定のまま・知らない管理番号・送ったあとに値が変わった行・読めない記入は報告して適用しない（工事場所は片方だけ読めても反映しない）", async () => {
    const now = finalize(rows, new Map([[editKey("s!2", "engineer"), { value: "職員　入力", by: "staff" }]]))
    const report = await readAnswers(
      answered(
        { "s!2": { 配置技術者: "試験 次郎" }, "s!4": { 着工年月: "そのうち", "工事場所（都道府県・市区町村）": "千代田区" } },
        [["s!99", "", "", "", "", "", "", "", ""]],
      ),
      now,
      noAi(),
    )
    if ("error" in report) throw new Error(report.error)
    expect(report.edits).toEqual([[editKey("s!3", "place"), { value: "港区", by: "confirmed" }]])
    expect(report.heldBack).toEqual([{ rowKey: "s!4", field: "place", answer: "千代田区" }])
    expect(report.unknownKeys).toEqual(["s!99"])
    expect(report.changed).toEqual([{ rowKey: sent[0]!.rowKey, field: sent[0]!.field, now: "職員　入力", answer: "試験　次郎" }])
    expect(report.invalid.map((x) => `${x.inquiry.rowKey}:${x.inquiry.field}`).sort()).toEqual(["s!4:prefecture", "s!4:startYm"])
    expect(report.unanswered).toEqual([])
    expect(report.confirmed.map((q) => `${q.rowKey}:${q.field}:${q.current}`)).toEqual(["s!3:place:港区"])
  })

  test("工事場所の記入に市区町村が読み取れなければ、残りを場所名にせず読み取れないと知らせる", async () => {
    const report = await readAnswers(answered({ "s!4": { "工事場所（都道府県・市区町村）": "東京都丸の内1-1" } }), rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.edits.filter(([k]) => k.startsWith("s!4:p"))).toEqual([])
    expect(report.invalid.map((x) => `${x.inquiry.field}:${x.answer}`).sort()).toEqual(["place:東京都丸の内1-1", "prefecture:東京都丸の内1-1"])
  })

  test("工事場所の記入は変換と同じく住所データで分ける。都府県を省いた名前（「神奈川横浜市中区」）は続く市区町村で確かめ、「長野原町」を長野県と読み違えない", async () => {
    const at = async (rowKey: string, answer: string) => {
      const r = await readAnswers(answered({ [rowKey]: { "工事場所（都道府県・市区町村）": answer } }), rows, noAi())
      if ("error" in r) throw new Error(r.error)
      return r
    }
    const placeEdits = (r: AnswerReport, row: string) => Object.fromEntries(r.edits.filter(([k]) => k.startsWith(`${row}:p`)))
    expect(placeEdits(await at("s!3", "長野原町大字長野原"), "s!3")).toEqual({ [editKey("s!3", "place")]: { value: "吾妻郡長野原町", by: "customer" } })
    expect(placeEdits(await at("s!3", "京都市中京区"), "s!3")).toEqual({ [editKey("s!3", "place")]: { value: "京都市中京区", by: "customer" } })
    expect(placeEdits(await at("s!4", "神奈川横浜市中区山下町1"), "s!4")).toEqual({
      [editKey("s!4", "prefecture")]: { value: "神奈川県", by: "customer" },
      [editKey("s!4", "place")]: { value: "横浜市中区", by: "customer" },
    })
    expect(placeEdits(await at("s!4", "神奈川県横浜市"), "s!4")).toEqual({
      [editKey("s!4", "prefecture")]: { value: "神奈川県", by: "customer" },
      [editKey("s!4", "place")]: { value: "横浜市", by: "customer" },
    })
    const noCity = await at("s!4", "東京都丸の内1-1")
    expect(noCity.invalid[0]!.message).toContain("市区町村を読み取れません")
    const unreadable = await at("s!4", "丸の内1-1")
    expect(unreadable.invalid.map((x) => x.inquiry.field).sort()).toEqual(["place", "prefecture"])
    expect(unreadable.invalid[0]!.message).toContain("都道府県名から書いてください")
  })

  test("都道府県だけ聞いて住所ごと書き直されたとき、市区町村までに縮めた場所名で聞いていない場所名を上書きしない（書き換えた場所名は反映する）", async () => {
    const detailed = kojiRow({ ...full, prefecture: "", place: "千代田区丸の内" }, 7)
    const qs = cellInquiries(collectInquiries([detailed], { tax: "included" }))
    expect(qs.map((q) => q.field)).toEqual(["prefecture"])
    const s = inquirySheet([detailed], qs)
    const header = s.columns.map((c) => c.header)
    const answer = (text: string): SheetGrid[] => [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (header[i] === "工事場所（都道府県・市区町村）" ? text : c.value)))], hidden: [] }]
    const rewritten = await readAnswers(answer("東京都千代田区丸の内1-1"), [detailed], noAi())
    if ("error" in rewritten) throw new Error(rewritten.error)
    expect(Object.fromEntries(rewritten.edits)).toEqual({ [editKey("s!7", "prefecture")]: { value: "東京都", by: "customer" } })
    expect(rewritten.alsoChanged).toEqual([])
    const moved = await readAnswers(answer("神奈川県横浜市中区"), [detailed], noAi())
    if ("error" in moved) throw new Error(moved.error)
    expect(moved.alsoChanged).toEqual([{ rowKey: "s!7", field: "place", was: "千代田区丸の内", answer: "横浜市中区" }])
  })

  test("工事場所の聞いた側が送ったあとに変わっていたら、聞いていない側（都道府県）の書き換えも反映しない", async () => {
    const now = finalize(rows, new Map([[editKey("s!3", "place"), { value: "品川区", by: "staff" }]]))
    const report = await readAnswers(answered({ "s!3": { "工事場所（都道府県・市区町村）": "神奈川県横浜市中区" } }), now, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.edits.filter(([k]) => k.startsWith("s!3:"))).toEqual([])
    expect(report.alsoChanged).toEqual([])
    expect(report.changed.map((c) => `${c.field}:${c.now}`)).toEqual(["place:品川区"])
    expect(report.heldBack).toEqual([{ rowKey: "s!3", field: "prefecture", answer: "神奈川県" }])
  })

  test("工事場所の片方だけ聞いたとき、表示したもう片方のまま返ってきた欄は未記入（読み取れないとは言わない）", async () => {
    const placeOnly = kojiRow({ ...full, place: "" }, 5)
    const prefectureOnly = kojiRow({ ...full, prefecture: "" }, 6)
    const rs = [placeOnly, prefectureOnly]
    const qs = cellInquiries(collectInquiries(rs, { tax: "included" }))
    expect(qs.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!5:place", "s!6:prefecture"])
    const s = inquirySheet(rs, qs)
    const grid: SheetGrid[] = [{ name: "記入用", rows: [s.columns.map((c) => c.header), ...s.rows.map((r) => r.cells.map((c) => c.value))], hidden: [] }]
    const report = await readAnswers(grid, rs, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.invalid).toEqual([])
    expect(report.edits).toEqual([])
    expect(report.unanswered.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!5:place", "s!6:prefecture"])
  })

  test("反映済みの回答ファイルをもう一度取り込んでも「変わっていた」とは言わず、反映済みとして数える", async () => {
    const file = answered({ "s!2": { 配置技術者: "試験 次郎" }, "s!3": { "工事場所（都道府県・市区町村）": "神奈川県横浜市中区" } })
    const first = await readAnswers(file, rows, noAi())
    if ("error" in first) throw new Error(first.error)
    const again = await readAnswers(file, finalize(rows, new Map(first.edits)), noAi())
    if ("error" in again) throw new Error(again.error)
    expect(again.edits).toEqual([])
    expect(again.changed).toEqual([])
    expect(again.alsoChanged).toEqual([])
    expect(again.alreadyApplied.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!2:engineer", "s!3:place"])
  })

  test("注文者の記入は空白だけを整え、半角の表記（半角英数・半角カナ）は顧客の書いたまま", async () => {
    const noClient = kojiRow({ ...full, client: "" }, 7)
    const qs = cellInquiries(collectInquiries([noClient], { tax: "included" }))
    const s = inquirySheet([noClient], qs)
    const header = s.columns.map((c) => c.header)
    const filled = s.rows.map((r) => r.cells.map((c, i) => (header[i] === "注文者" ? "株式会社  ABC ﾃｸﾉ" : c.value)))
    const report = await readAnswers([{ name: "記入用", rows: [header, ...filled], hidden: [] }], [noClient], noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.edits).toEqual([[editKey("s!7", "client"), { value: "株式会社 ABC ﾃｸﾉ", by: "customer" }]])
    expect(finalize([noClient], new Map(report.edits))[0]!.cells.client).toMatchObject({ status: "changed" })
  })

  test("推定に自信がない値がそのまま返ってきたら、顧客が確認したものとして推定の印を外し、次からは聞かない。データに無い欄の空欄は未記入のまま", async () => {
    const report = await readAnswers(answered({}), rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.confirmed.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!3:place"])
    expect(report.unanswered.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!2:engineer", "s!4:prefecture", "s!4:place", "s!4:startYm"])
    expect(report.edits).toEqual([[editKey("s!3", "place"), { value: "港区", by: "confirmed" }]])
    const out = finalize(rows, new Map(report.edits))
    expect(out[2]!.cells.place).toMatchObject({ value: "港区", message: "顧客が確認" })
    expect(out[2]!.cells.place.guessed).toBeUndefined()
    expect(cells(collectInquiries(out, { tax: "included" }))).not.toContain("s!3:place:needsReview")

    const again = await readAnswers(answered({}), out, noAi())
    if ("error" in again) throw new Error(again.error)
    expect(again.edits).toEqual([])
    expect(again.alreadyApplied.map((q) => `${q.rowKey}:${q.field}`)).toEqual(["s!3:place"])
  })

  test("記入用Excelは顧客に返すので個人名を氏名で出す。そのまま返った推定は、記号が付け直されても確認として扱う", async () => {
    const yamada = personToken("山田太郎")
    const guessedClient = kojiRow(full, 5)
    guessedClient.cells.client = { value: yamada, status: "ai", source: "C列", original: "山田太郎", guessed: true }
    const sentRows = finalize([guessedClient])
    expect(sentRows[0]!.cells.client.value).toBe("Ａ")
    const qs = cellInquiries(collectInquiries(sentRows, { tax: "included" }))
    const s = inquirySheet(sentRows, qs)
    const header = s.columns.map((c) => c.header)
    expect(s.rows[0]!.cells[header.indexOf("注文者")]!.value).toBe("山田太郎")
    expect(JSON.stringify(s.rows)).not.toMatch(/"Ａ"/)
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c) => c.value))], hidden: [] }]

    const nowRows = finalize([kojiRow({ ...full, client: personToken("鈴木一郎") }, 4), guessedClient])
    expect(nowRows[1]!.cells.client.value).toBe("Ｂ")
    const report = await readAnswers(grid, nowRows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.changed).toEqual([])
    expect(report.edits).toEqual([[editKey("s!5", "client"), { value: yamada, by: "confirmed" }]])
  })

  test("記入の氏名は元データの値と同じく匿名化し、案件のほかの行と同じ人には同じ記号が付く。「Ａ棟」のような文字はそのまま", async () => {
    const yamada = personToken("山田太郎")
    const guessedWork = kojiRow(full, 40)
    guessedWork.cells.workName = { value: `${yamada}邸新築工事`, status: "warning", source: "C列", original: "山田太郎邸新築工事", guessed: true }
    const before = [kojiRow({ ...full, client: personToken("鈴木一郎") }, 4), guessedWork]
    const nowRows = finalize(before)
    expect(nowRows[1]!.cells.workName.value).toBe("Ｂ邸新築工事")
    const qs = cellInquiries(collectInquiries(nowRows, { tax: "included" }))
    const s = inquirySheet(nowRows, qs)
    const header = s.columns.map((c) => c.header)
    expect(s.rows[0]!.cells[header.indexOf("工事名")]!.value).toBe("山田太郎邸新築工事")
    const grid: SheetGrid[] = [
      { name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (header[i] === "工事名" ? "山田太郎邸改修工事（Ａ棟）" : c.value)))], hidden: [] },
    ]
    const sentToAi: string[] = []
    const callAi = async (req: AiBatchRequest) => (sentToAi.push(...req.items.map((i) => i.input)), cannedAnonymize(req))
    const report = await readAnswers(grid, nowRows, { ...noAi(), callAi })
    if ("error" in report) throw new Error(report.error)
    expect(sentToAi).toEqual(["山田太郎邸改修工事（Ａ棟）"])
    expect(customerEdits(report)).toEqual([[editKey("s!40", "workName"), { value: `${yamada}邸改修工事（Ａ棟）`, by: "customer", status: "ai", byAi: true }]])
    expect(finalize(before, new Map(report.edits))[1]!.cells.workName.value).toBe("Ｂ邸改修工事（Ａ棟）")
  })

  test("あとで別の記入用Excelを作っても、前に送った記入用Excelの回答をそのまま取り込める（何を聞いたかはファイルの各行から読む）", async () => {
    const earlier = answered({ "s!2": { 配置技術者: "試験 次郎" } })
    const report = await readAnswers(earlier, rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(customerEdits(report)).toEqual([[editKey("s!2", "engineer"), { value: "試験　次郎", by: "customer" }]])
    expect(report.unknownKeys).toEqual([])
  })

  test("同じ管理番号の行が2つ以上あれば、どれが回答か分からないのでどれも取り込まずに知らせる", async () => {
    const base = answered({ "s!2": { 配置技術者: "試験 次郎" }, "s!4": { 着工年月: "2024年5月" } })
    const s2 = base[0]!.rows.find((r) => r[0] === "s!2")!
    const grid: SheetGrid[] = [{ ...base[0]!, rows: [...base[0]!.rows, s2.map((c, i) => (header[i] === "配置技術者" ? "試験 三郎" : c))] }]
    const report = await readAnswers(grid, rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.duplicateKeys).toEqual(["s!2"])
    expect(report.edits.filter(([k]) => k.startsWith("s!2:"))).toEqual([])
    expect(customerEdits(report)).toEqual([[editKey("s!4", "startYm"), { value: "202405", by: "customer" }]])
  })

  test("照合用の列が壊れた行は、何を聞いたか分からないので取り込まずに知らせる", async () => {
    const grid = answered({ "s!2": { 配置技術者: "試験 次郎", 照合用: "{" } })
    const report = await readAnswers(grid, rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.unreadable).toEqual([{ line: 3, rowKey: "s!2", reason: "照合用の列が消えているか壊れている" }])
    expect(customerEdits(report)).toEqual([])
  })

  test("管理番号が消された行は、記入があれば取り込まずに行番号を知らせる。空の行は黙って飛ばす", async () => {
    const base = answered({ "s!2": { 配置技術者: "試験 次郎" }, "s!4": { 着工年月: "2024年5月" } })
    const grid: SheetGrid[] = [{ ...base[0]!, rows: [...base[0]!.rows.map((r) => (r[0] === "s!2" ? ["", ...r.slice(1)] : r)), ["", "", ""]] }]
    const report = await readAnswers(grid, rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.unreadable).toEqual([{ line: 3, rowKey: "", reason: "管理番号が空" }])
    expect(customerEdits(report)).toEqual([[editKey("s!4", "startYm"), { value: "202405", by: "customer" }]])
  })

  test("照合用の列に記入用Excelの列が無い項目があれば、壊れた照合用として取り込まずに知らせる", async () => {
    const grid = answered({ "s!2": { 配置技術者: "試験 次郎", 照合用: JSON.stringify({ asked: [{ field: "jv", reason: "missing", current: "" }] }) } })
    const report = await readAnswers(grid, rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(report.unreadable.map((u) => u.rowKey)).toEqual(["s!2"])
  })

  test("注文者・工事名の記入も元データの値と同じ変換を通す。個人名は AI で「Ａ」等にし、AI が使えなければ反映せず前の値のまま知らせる", async () => {
    const blank = kojiRow({ ...full, client: "", workName: "" }, 8)
    const qs = cellInquiries(collectInquiries([blank], { tax: "included" }))
    const s = inquirySheet([blank], qs)
    const header = s.columns.map((c) => c.header)
    const fill: Record<string, string> = { 注文者: "山田 太郎", 工事名: "山田太郎邸新築工事" }
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => fill[header[i]!] ?? c.value))], hidden: [] }]
    const sentToAi: string[] = []
    const callAi = async (req: AiBatchRequest) => {
      sentToAi.push(...req.items.map((i) => `${req.task}:${i.input}`))
      return cannedAnonymize(req)
    }

    const report = await readAnswers(grid, [blank], { ...noAi(), callAi })
    if ("error" in report) throw new Error(report.error)
    expect(sentToAi.sort()).toEqual(["anonymizeClient:山田 太郎", "anonymizeWorkName:山田太郎邸新築工事"])
    const out = finalize([blank], new Map(report.edits))[0]!.cells
    expect([out.client.value, out.workName.value]).toEqual(["Ａ", "Ａ邸新築工事"])
    expect(out.client).toMatchObject({ status: "ai", source: "顧客の回答" })

    for (const unavailable of [noAi(), { ...noAi(), callAi: async () => ({ ok: false as const, message: "通信エラー" }) }]) {
      const offline = await readAnswers(grid, [blank], unavailable)
      if ("error" in offline) throw new Error(offline.error)
      expect(offline.edits).toEqual([])
      const held = finalize([blank], new Map(offline.edits))[0]!.cells
      expect([held.client.value, held.workName.value]).toEqual(["", ""])
      expect(offline.invalid.map((c) => [c.inquiry.field, c.answer]).sort()).toEqual([["client", "山田 太郎"], ["workName", "山田太郎邸新築工事"]])
      for (const c of offline.invalid) expect(c.message).toContain("個人名の判定ができませんでした。手で入力してください")
    }
  })

  test("工事名の記入は、計画の変換の値だけを整える部分を当ててから匿名化する（列をつなぐ工事名なら空白を除く）。元データの列に向けた指示文は使わない", async () => {
    const blank = kojiRow({ ...full, workName: "" }, 8)
    const s = inquirySheet([blank], cellInquiries(collectInquiries([blank], { tax: "included" })))
    const header = s.columns.map((c) => c.header)
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (header[i] === "工事名" ? "山田太郎邸 改修工事" : c.value)))], hidden: [] }]
    const sent: string[] = []
    const callAi = async (req: AiBatchRequest) => (sent.push(...req.items.map((i) => `${req.task}:${req.instruction ?? ""}:${i.input}`)), cannedAnonymize(req))
    const fields = { workName: { kind: "columns" as const, columns: [3, 4], transform: "rule.joinWorkName" as const, instruction: "「邸」の前は個人名" } }
    const report = await readAnswers(grid, [blank], { ...noAi(), callAi, fields })
    if ("error" in report) throw new Error(report.error)
    expect(sent).toEqual(["anonymizeWorkName::山田太郎邸改修工事"])
    expect(customerEdits(report)).toEqual([[editKey("s!8", "workName"), { value: `${personToken("山田太郎")}邸改修工事`, by: "customer", status: "ai", byAi: true }]])
  })

  test("注文者の記入は、計画が法人だけの元データに匿名化しない変換・指示文の AI を使っていても、必ず匿名化を通す", async () => {
    const blank = kojiRow({ ...full, client: "" }, 8)
    const s = inquirySheet([blank], cellInquiries(collectInquiries([blank], { tax: "included" })))
    const header = s.columns.map((c) => c.header)
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (header[i] === "注文者" ? "山田太郎" : c.value)))], hidden: [] }]
    const plans = [
      { kind: "column" as const, column: 3, transform: "rule.fullWidthText" as const },
      { kind: "column" as const, column: 3, transform: "ai.freeform" as const, instruction: "C列の略称を正式名に" },
    ]
    for (const client of plans) {
      const sent: string[] = []
      const callAi = async (req: AiBatchRequest) => (sent.push(...req.items.map((i) => `${req.task}:${req.instruction ?? ""}:${i.input}`)), cannedAnonymize(req))
      const report = await readAnswers(grid, [blank], { ...noAi(), callAi, fields: { client } })
      if ("error" in report) throw new Error(report.error)
      expect(sent).toEqual(["anonymizeClient::山田太郎"])
      expect(finalize([blank], new Map(report.edits))[0]!.cells.client.value).toBe("Ａ")
    }
  })

  test("取り込みは自分の記入の AI の失敗だけを送り直し、変換の失敗の記録には触らない", async () => {
    const blank = kojiRow({ ...full, client: "" }, 8)
    const s = inquirySheet([blank], cellInquiries(collectInquiries([blank], { tax: "included" })))
    const header = s.columns.map((c) => c.header)
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (header[i] === "注文者" ? "山田 太郎" : c.value)))], hidden: [] }]
    const cache: AiCache = new Map([[aiKey("anonymizeClient", undefined, "鈴木 一郎"), { error: "変換のときの失敗" }]])
    const failing = { ctx: { rounding: "floor" as const }, lookup: fileAddressLookup, cache, fields: {}, callAi: async () => ({ ok: false as const, message: "通信エラー" }) }
    await readAnswers(grid, [blank], failing)
    const sent: string[] = []
    const report = await readAnswers(grid, [blank], { ...failing, callAi: async (req: AiBatchRequest) => (sent.push(...req.items.map((i) => i.input)), cannedAnonymize(req)) })
    if ("error" in report) throw new Error(report.error)
    expect(sent).toEqual(["山田 太郎"])
    expect(cache.get(aiKey("anonymizeClient", undefined, "鈴木 一郎"))).toEqual({ error: "変換のときの失敗" })
    expect(finalize([blank], new Map(report.edits))[0]!.cells.client.value).toBe("Ａ")
  })

  test("推定した工事場所は、記入用Excelのセルと説明に推定だと添える（推定と知らずに「確認」されないように）", () => {
    const qs = cellInquiries(collectInquiries([complete, guessedPlace], { tax: "included" }))
    const s = inquirySheet([complete, guessedPlace], qs)
    const col = s.columns.findIndex((c) => c.header.startsWith("工事場所"))
    expect(s.rows[0]!.cells[col]).toEqual({ value: "東京都港区", ask: true, note: "推定です。正しいか確認し、違えば書き直してください" })
    expect(s.hints).toContain("工事場所（都道府県・市区町村）の欄にすでに値があるものは推定です。正しいか確認し、違えば書き直してください（正しければそのままで構いません）。")
  })

  test("区切りに自信がない配置技術者は聞き、記入用Excelに区切りの確認を添える。記入は元データと同じ変換（同じ案件の表記・AI）に通す", async () => {
    const unsure = kojiRow({ ...full, engineer: "仮名　次郎" }, 10)
    unsure.cells.engineer = { ...unsure.cells.engineer, status: "warning", guessed: true }
    const other = kojiRow({ ...full, engineer: "" }, 11)
    const third = kojiRow({ ...full, engineer: "" }, 12)
    const rs = [complete, unsure, other, third]
    const qs = cellInquiries(collectInquiries(rs, { tax: "included" }))
    expect(qs.map((q) => `${q.rowKey}:${q.field}:${q.reason}`)).toEqual(["s!10:engineer:needsReview", "s!11:engineer:missing", "s!12:engineer:missing"])
    const s = inquirySheet(rs, qs)
    const col = s.columns.findIndex((c) => c.header === "配置技術者")
    expect(s.rows.map((r) => r.cells[col])).toEqual([
      { value: "仮名　次郎", ask: true, note: "推定です。姓と名の区切りを確認してください" },
      { value: "", ask: true },
      { value: "", ask: true },
    ])

    const header = s.columns.map((c) => c.header)
    const fill: Record<string, string> = { "s!10": "仮名 次郎", "s!11": "試験太郎", "s!12": "空想花子" }
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (i === col ? fill[r.cells[0]!.value]! : c.value)))], hidden: [] }]
    const sent: string[] = []
    const callAi = async (req: AiBatchRequest) => {
      sent.push(...req.items.map((i) => `${req.task}:${i.input}`))
      return { ok: true as const, json: { results: req.items.map((i) => ({ id: i.id, value: "空想　花子", needsReview: false, note: "" })) } }
    }
    const report = await readAnswers(grid, rs, { ...noAi(), callAi })
    if ("error" in report) throw new Error(report.error)
    expect(sent).toEqual(["personName:空想花子"])
    expect(report.confirmed.map((q) => q.rowKey)).toEqual(["s!10"])
    const edits = Object.fromEntries(report.edits)
    expect(edits[editKey("s!10", "engineer")]).toEqual({ value: "仮名　次郎", by: "confirmed" })
    expect(edits[editKey("s!11", "engineer")]).toMatchObject({ value: "試験　太郎", by: "customer" })
    expect(edits[editKey("s!12", "engineer")]).toMatchObject({ value: "空想　花子", by: "customer" })
  })

  test("区切りの無い氏名を AI で区切れなかったときは、元データでも記入でも推定として残し、もう一度聞く", async () => {
    const [grid] = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
    const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid!)
    const { rows: sources } = collectSourceRows([grid!], plan)
    const down = async () => ({ ok: false as const, message: "通信エラー" })
    const converted = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx: { rounding: "floor" }, cache: new Map(), callAi: down }))
    const unsplit = converted.find((r) => r.cells.engineer.value === "青池一郎")!
    expect(unsplit.cells.engineer).toMatchObject({ status: "warning", guessed: true })
    expect(cells(collectInquiries([unsplit], { tax: "included" }))).toContain(`${unsplit.key}:engineer:needsReview`)

    const blank = kojiRow({ ...full, engineer: "" }, 30)
    const s = inquirySheet([blank], cellInquiries(collectInquiries([blank], { tax: "included" })))
    const header = s.columns.map((c) => c.header)
    const answers: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (header[i] === "配置技術者" ? "空想花子" : c.value)))], hidden: [] }]
    const report = await readAnswers(answers, [blank], { ...noAi(), callAi: down })
    if ("error" in report) throw new Error(report.error)
    expect(report.edits).toEqual([[editKey("s!30", "engineer"), expect.objectContaining({ value: "空想花子", by: "customer", status: "warning", guessed: true })]])
    expect(report.needsCheck.map((c) => c.field)).toEqual(["engineer"])
    expect(cells(collectInquiries(finalize([blank], new Map(report.edits)), { tax: "included" }))).toEqual(["s!30:engineer:needsReview"])
  })

  test("記入の氏名の区切りに使う同じ案件の表記は、元データ・確認済みの値だけ。AI が区切った氏名には合わせない", async () => {
    const byAi = kojiRow({ ...full, engineer: "架空　一郎" }, 20)
    byAi.cells.engineer = { ...byAi.cells.engineer, status: "ai", byAi: true }
    const unsure = kojiRow({ ...full, engineer: "仮名　次郎" }, 21)
    unsure.cells.engineer = { ...unsure.cells.engineer, status: "warning", guessed: true, byAi: true }
    const asked = [kojiRow({ ...full, engineer: "" }, 22), kojiRow({ ...full, engineer: "" }, 23), kojiRow({ ...full, engineer: "" }, 24)]
    const s = inquirySheet(asked, cellInquiries(collectInquiries(asked, { tax: "included" })))
    const header = s.columns.map((c) => c.header)
    const col = header.indexOf("配置技術者")
    const fill: Record<string, string> = { "s!22": "架空一郎", "s!23": "仮名次郎", "s!24": "試験太郎" }
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (i === col ? fill[r.cells[0]!.value]! : c.value)))], hidden: [] }]
    const sent: string[] = []
    const callAi = async (req: AiBatchRequest) => {
      sent.push(...req.items.map((i) => i.input))
      return { ok: true as const, json: { results: req.items.map((i) => ({ id: i.id, value: `${i.input.slice(0, 2)}　${i.input.slice(2)}`, needsReview: false, note: "" })) } }
    }
    const report = await readAnswers(grid, [complete, byAi, unsure, ...asked], { ...noAi(), callAi })
    if ("error" in report) throw new Error(report.error)
    expect(sent.sort()).toEqual(["仮名次郎", "架空一郎"])
    expect(Object.fromEntries(report.edits)[editKey("s!24", "engineer")]).toEqual({ value: "試験　太郎", by: "customer" })
  })

  test("AI が区切った氏名は、検証で状態がエラーに変わっても AI が区切ったものとして、記入の区切りに使わない", async () => {
    const g = { name: "s", rows: [["業種", "注文者", "工事名", "請負代金", "配置技術者"], ["電気", "株式会社テスト", "テスト工事", "1000000", "𠮷田一郎"]], hidden: [false, false] }
    const p = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
    const sent: string[] = []
    const split = async (req: AiBatchRequest) => {
      if (req.task !== "personName") return { ok: false as const, message: "この確認では使わない" }
      sent.push(...req.items.map((i) => i.input))
      return { ok: true as const, json: { results: req.items.map((i) => ({ id: i.id, value: `${[...i.input].slice(0, 2).join("")}　${[...i.input].slice(2).join("")}`, needsReview: false, note: "" })) } }
    }
    const converted = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources: collectSourceRows([g], p).rows, plan: p, ctx: { rounding: "floor" }, cache: new Map(), callAi: split }))
    expect(converted[0]!.cells.engineer).toMatchObject({ value: "𠮷田　一郎", status: "error" })
    sent.length = 0

    const blank = kojiRow({ ...full, engineer: "" }, 30)
    const s = inquirySheet([blank], cellInquiries(collectInquiries([blank], { tax: "included" })))
    const header = s.columns.map((c) => c.header)
    const grid: SheetGrid[] = [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => (header[i] === "配置技術者" ? "𠮷田一郎" : c.value)))], hidden: [] }]
    const report = await readAnswers(grid, [...converted, blank], { ...noAi(), callAi: split })
    if ("error" in report) throw new Error(report.error)
    expect(sent).toEqual(["𠮷田一郎"])
  })

  test("管理番号の列が無いファイルは取り込まない", async () => {
    expect(await readAnswers([{ name: "x", rows: [["工事名"]], hidden: [] }], rows, noAi())).toHaveProperty("error")
  })
})

describe("記入用Excel（.xlsx）", () => {
  const rows = [complete, noEngineer, guessedPlace, noLocation]
  const sent = cellInquiries(collectInquiries(rows, { tax: "included" }))
  const sheet = inquirySheet(rows, sent)

  test("聞くセルだけ塗り、返ってきたファイルを SheetJS で読んで取り込める", async () => {
    const bytes = await inquiryXlsx(sheet, "テスト建設")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes.buffer as ArrayBuffer)
    const ws = wb.worksheets[0]!
    let headerRow = 0
    ws.eachRow((r, n) => {
      if (r.getCell(1).value === "管理番号") headerRow = n
    })
    const fills = sheet.rows.map((_, ri) =>
      sheet.columns.map((_, ci) => {
        const fill = ws.getCell(headerRow + 1 + ri, ci + 1).fill
        return fill?.type === "pattern" && fill.pattern === "solid"
      }),
    )
    expect(fills).toEqual(sheet.rows.map((r) => r.cells.map((c) => c.ask)))
    expect(ws.getColumn(sheet.columns.length).hidden).toBe(true)

    ws.getCell(headerRow + 1, sheet.columns.findIndex((c) => c.header === "配置技術者") + 1).value = "試験 三郎"
    const filled = new Uint8Array(await wb.xlsx.writeBuffer())
    const report = await readAnswers(readWorkbook("回答.xlsx", filled), rows, noAi())
    if ("error" in report) throw new Error(report.error)
    expect(customerEdits(report)).toEqual([[editKey("s!2", "engineer"), { value: "試験　三郎", by: "customer" }]])
    expect(report.unanswered.length + report.confirmed.length).toBe(sent.length - 1)
  })
})

test("sample-inquiry.xlsx（APIキーなし）: 配置技術者の列が無い・完成日と工事場所が空の行を問い合わせにする", async () => {
  const sheets = readWorkbook("sample-inquiry.xlsx", fixture("sample-inquiry.xlsx"))
  const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, sheets[0]!)
  const { rows: sources } = collectSourceRows(sheets, plan)
  const noKey = async () => ({ ok: false as const, message: "APIキー未設定" })
  const { rows } = finalizeAll(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx: { rounding: "floor" }, cache: new Map(), callAi: noKey }), {
    replacements: {},
    edits: new Map(),
  })
  expect(cells(collectInquiries(rows, { tax: "unknown" }))).toEqual([
    "case:tax",
    "工事経歴!1:engineer:missing",
    "工事経歴!2:engineer:missing",
    "工事経歴!2:endYm:missing",
    "工事経歴!3:prefecture:missing",
    "工事経歴!3:place:missing",
    "工事経歴!3:engineer:missing",
    "工事経歴!4:engineer:missing",
  ])
})

describe("個人名の記号（セルには人を入れ、記号は最後の行から決める）", () => {
  const [grid] = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
  const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid!)
  const { rows: sources } = collectSourceRows([grid!], plan)
  const ctx = { rounding: "floor" as const, addresses: NO_ADDRESSES }
  const finalize = (rs: RowResult<KojiFieldId>[], edits: CellEdits = new Map()) => finalizeAll(rs, { edits }).rows
  const convert = (cache: AiCache, callAi: AiCaller = cannedAnonymize) => runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache, callAi })
  /** 鈴木の名前を含む依頼は AI が使えない（同じ依頼にまとめた山田も） */
  const suzukiDown = async (req: AiBatchRequest) => (req.items.some((i) => i.input.includes("鈴木")) ? { ok: false as const, message: "通信エラー" } : cannedAnonymize(req))
  const ask = (rs: RowResult<KojiFieldId>[], fill: Record<string, string>): SheetGrid[] => {
    const s = inquirySheet(rs, cellInquiries(collectInquiries(rs, { tax: "included" })))
    const header = s.columns.map((c) => c.header)
    return [{ name: "記入用", rows: [header, ...s.rows.map((r) => r.cells.map((c, i) => fill[header[i]!] ?? c.value))], hidden: [] }]
  }
  const shown = (rs: RowResult<KojiFieldId>[]) => rs.map((r) => `${r.cells.client.value}/${r.cells.workName.value}`)
  const blank = kojiRow({ ...full, client: "", workName: "" }, 90)

  test("回答の取り込み: 元データにいる人は同じ記号、新しい人は次の記号。同じ人の2回目の回答も同じ記号", async () => {
    const cache: AiCache = new Map()
    const all = [...(await convert(cache)), blank]
    expect(shown(finalize(all)).filter((v) => v.includes("Ａ") || v.includes("Ｂ"))).toEqual(["Ａ/Ａ邸新築工事", "Ｂ/Ｃ様邸リフォーム工事"])
    const first = await readAnswers(ask([blank], { 注文者: "田中 花子", 工事名: "山田太郎邸改修工事" }), finalize(all), { ctx, lookup: fileAddressLookup, cache, callAi: cannedAnonymize, fields: plan.fields })
    if ("error" in first) throw new Error(first.error)
    const edits = new Map(first.edits)
    expect(shown(finalize(all, edits)).at(-1)).toBe("Ｄ/Ａ邸改修工事")

    const second = kojiRow({ ...full, client: "" }, 91)
    const withSecond = [...all, second]
    const next = await readAnswers(ask([second], { 注文者: "田中花子" }), finalize(withSecond, edits), { ctx, lookup: fileAddressLookup, cache, callAi: cannedAnonymize, fields: plan.fields })
    if ("error" in next) throw new Error(next.error)
    expect(finalize(withSecond, new Map([...edits, ...next.edits])).at(-1)!.cells.client.value).toBe("Ｄ")
  })

  test("AI が直ってから変換をやり直しても、先に取り込んだ回答の人と記号がぶつからない", async () => {
    const cache: AiCache = new Map()
    const before = [...(await convert(cache, suzukiDown)), blank]
    const answers = await readAnswers(ask([blank], { 注文者: "田中 花子" }), finalize(before), { ctx, lookup: fileAddressLookup, cache, callAi: cannedAnonymize, fields: plan.fields })
    if ("error" in answers) throw new Error(answers.error)
    const edits = new Map(answers.edits)
    expect(finalize(before, edits).at(-1)!.cells.client.value).toBe("Ａ")

    const after = finalize([...(await convert(cache)), blank], edits)
    expect(shown(after).filter((v) => /[Ａ-Ｚ]/.test(v))).toEqual(["Ａ/Ａ邸新築工事", "Ｂ/Ｃ様邸リフォーム工事", "Ｄ/"])
  })

  test("職員の手直し: 〔Ａ〕で書いた記号はその人のまま。人が残るので次の回答の新しい人は別の記号。表に無い記号はエラー", async () => {
    const cache: AiCache = new Map()
    const all = [...(await convert(cache)), blank]
    const { rows: before, letters } = finalizeAll(all)
    const yamadaRow = before.find((r) => r.cells.client.value === "Ａ")!
    expect(editText(yamadaRow.cells.client, letters)).toBe("〔Ａ〕")
    const staff = new Map([
      [editKey(yamadaRow.key, "client"), staffEdit("〔Ａ〕様", letters)],
      [editKey(yamadaRow.key, "workName"), staffEdit("〔Ａ〕邸増築工事", letters)],
    ])
    const edited = finalize(all, staff)
    expect(shown(edited).filter((v) => v.includes("Ａ"))).toEqual(["Ａ様/Ａ邸増築工事"])

    const answers = await readAnswers(ask([blank], { 注文者: "田中 花子" }), edited, { ctx, lookup: fileAddressLookup, cache, callAi: cannedAnonymize, fields: plan.fields })
    if ("error" in answers) throw new Error(answers.error)
    expect(finalize(all, new Map([...staff, ...answers.edits])).at(-1)!.cells.client.value).toBe("Ｄ")

    const unknown = finalize(all, new Map([[editKey(yamadaRow.key, "workName"), staffEdit("〔Ｚ〕邸新築工事", letters)]]))
    expect(unknown.find((r) => r.key === yamadaRow.key)!.cells.workName).toMatchObject({ value: "〔Ｚ〕邸新築工事", status: "error" })
    expect(finalize(all, new Map([[editKey(yamadaRow.key, "workName"), staffEdit("Ａ棟改修工事", letters)]])).find((r) => r.key === yamadaRow.key)!.cells.workName).toMatchObject({ value: "Ａ棟改修工事", status: "changed" })
  })
})

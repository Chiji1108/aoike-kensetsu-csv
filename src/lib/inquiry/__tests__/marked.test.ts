import { describe, expect, test } from "bun:test"
import ExcelJS from "exceljs"
import * as XLSX from "xlsx"
import { fileAddressLookup } from "../../convert/address-file"
import { editKey } from "../../convert/convert"
import { finalizeAll } from "../../convert/__tests__/helpers"
import { heuristicPlan } from "../../convert/heuristic-plan"
import { runConversion } from "../../convert/pipeline"
import { collectSourceRows } from "../../convert/sources"
import { readWorkbook } from "../../convert/workbook"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { uploadKind } from "../../cases/upload-kind"
import { collectInquiries, type CellInquiry } from "../inquiry"
import { markability } from "../markable"
import { ADDED_SHEET_NAME, chooseAttachment, MARKED_SHEET_NAME, placeMarks, planMarks, readMarked } from "../marked"
import { markedXlsx } from "../marked-xlsx"

/**
 * 印付きの Excel（顧客の元の Excel に印を付けて返す）。合成の元の Excel（書式・結合・数式・ほかのシート付き）で、
 * 書いたあと開き直して元のセルの値と書式が残ること、返ってきた記入を読めること、別の案件・書き換えた照合用を読まないことを確かめる
 */

const KEY = "ab".repeat(32)
const ID = { caseId: "case-1", sourceFileId: "file-1", excelKey: KEY }
const noAi = () => ({ ctx: { rounding: "floor" as const }, lookup: fileAddressLookup, cache: new Map(), fields: {} })

const HEADER = ["No.", "工種", "工事件名", "発注者", "元請/下請", "施工場所", "契約金額（円）", "着工日", "完成日", "備考"]
const DATA: (string | number | Date | null)[][] = [
  [1, "建築一式", "テストビル新築工事", "株式会社テスト商事", "元請", "東京都千代田区丸の内1-1", 32_400_000, new Date(Date.UTC(2024, 3, 1)), new Date(Date.UTC(2024, 8, 30)), ""],
  [2, "電気工事", "テスト倉庫照明工事", "株式会社サンプル物流", "下請", "", 2_200_000, new Date(Date.UTC(2024, 4, 10)), null, "追加工事あり"],
  [3, "管工事", "テスト給排水更新工事", "株式会社テスト不動産", "下請", "千葉県船橋市本町1-1", 5_500_000, new Date(Date.UTC(2024, 6, 1)), new Date(Date.UTC(2024, 9, 31)), ""],
]

/** 顧客の元の Excel（表題の結合・見出しの塗り・罫線・金額の書式・合計の数式・メモのシート） */
async function sourceXlsx(opts: { mergeEnd?: true; mergeDown?: true; sheetName?: string } = {}) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(opts.sheetName ?? "工事経歴")
  ws.getCell("A1").value = "令和6年度 工事経歴一覧"
  ws.getCell("A1").font = { bold: true, size: 14, name: "游ゴシック" }
  ws.mergeCells("A1:J1")
  HEADER.forEach((h, i) => {
    const c = ws.getCell(3, i + 1)
    c.value = h
    c.font = { bold: true, color: { argb: "FF1F4E79" } }
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }
    c.border = { bottom: { style: "medium" } }
  })
  DATA.forEach((r, ri) =>
    r.forEach((v, ci) => {
      const c = ws.getCell(4 + ri, ci + 1)
      if (v !== null) c.value = v
      c.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } }
      c.font = { name: "游ゴシック", size: 10 }
      if (ci === 6) c.numFmt = "#,##0"
      if (ci === 7 || ci === 8) c.numFmt = "yyyy/m/d"
    }),
  )
  ws.getCell("F8").value = "合計"
  ws.getCell("G8").value = { formula: "SUM(G4:G6)", result: 40_100_000 }
  ws.getCell("G8").numFmt = "#,##0"
  ws.getColumn(3).width = 30
  ws.getCell("J5").note = "顧客のメモ"
  // 2行目のデータの完成日（空）を備考と横に結合する
  if (opts.mergeEnd) {
    ws.getCell("J5").value = null
    ws.mergeCells("I5:J5")
  }
  // 2行目と3行目のデータの完成日を縦に結合する（どちらも空になる）
  if (opts.mergeDown) {
    ws.getCell("I6").value = null
    ws.mergeCells("I5:I6")
  }
  wb.addWorksheet("メモ").getCell("A1").value = "担当者メモ"
  return withSource("工事経歴.xlsx", new Uint8Array(await wb.xlsx.writeBuffer()))
}

/** 画面が変換の元を読んだときと同じ形（バイト列・シート・印付きにできるか） */
const withSource = (name: string, bytes: Uint8Array) => ({ name, bytes, sheets: readWorkbook(name, bytes), markable: markability(name, bytes) })

async function convertSource(source: { name: string; bytes: Uint8Array }) {
  const sheets = readWorkbook(source.name, source.bytes)
  const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, sheets[0]!)
  const { rows: sources } = collectSourceRows(sheets, plan)
  const noKey = async () => ({ ok: false as const, message: "APIキー未設定" })
  const { rows } = finalizeAll(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx: { rounding: "floor" }, cache: new Map(), callAi: noKey }))
  const inquiries = collectInquiries(rows, { tax: "included" }).filter((q): q is CellInquiry => q.kind === "cell")
  return { sheets, plan, rows, inquiries }
}

async function marked(opts: Parameters<typeof sourceXlsx>[0] = {}) {
  const source = await sourceXlsx(opts)
  const c = await convertSource(source)
  const placement = placeMarks(c.sheets, c.plan, c.rows, c.inquiries)
  if (!placement) throw new Error("印を付ける行がありません")
  const plan = await planMarks(c.sheets, placement, ID)
  const out = await markedXlsx(source, plan, KEY, "テスト建設")
  if (!out.ok) throw new Error(out.reason)
  return { source, ...c, plan, bytes: out.bytes }
}

const load = async (bytes: Uint8Array) => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer)
  return wb
}
const isAsk = (c: ExcelJS.Cell) => c.fill?.type === "pattern" && (c.fill as ExcelJS.FillPattern).fgColor?.argb === "FFFFF2CC"

describe("印付きの Excel を書く", () => {
  test("元のセルの値・書式・結合・数式・列の幅・ほかのシート・顧客のメモはそのまま。聞くセルだけ塗り、元に列の無い項目は右端に列を足す", async () => {
    const m = await marked()
    const before = await load(m.source.bytes)
    const after = await load(m.bytes)
    expect(after.worksheets.map((w) => [w.name, w.state])).toEqual([
      ["工事経歴", "visible"],
      ["メモ", "visible"],
      [MARKED_SHEET_NAME, "veryHidden"],
    ])
    const a = before.getWorksheet("工事経歴")!
    const b = after.getWorksheet("工事経歴")!
    const painted = new Set(m.plan.cells.map((c) => `${c.row + 1}:${c.col + 1}`))
    let compared = 0
    a.eachRow({ includeEmpty: true }, (row, r) =>
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const other = b.getCell(r, c)
        expect([r, c, other.value]).toEqual([r, c, cell.value])
        expect(other.font).toEqual(cell.font)
        expect(other.border).toEqual(cell.border)
        expect(other.numFmt).toEqual(cell.numFmt)
        if (!painted.has(`${r}:${c}`)) expect(other.fill).toEqual(cell.fill)
        compared++
      }),
    )
    expect(compared).toBeGreaterThan(40)
    expect(b.model.merges).toEqual(a.model.merges)
    expect(b.getCell("G8").formula).toBe("SUM(G4:G6)")
    expect(b.getColumn(3).width).toBe(30)
    expect(b.getCell("J5").note).toBe("顧客のメモ")
    expect(after.getWorksheet("メモ")!.getCell("A1").value).toBe("担当者メモ")

    // 完成日の空いた行（2行目のデータ）と工事場所の空いた行を塗り、配置技術者の列を足す
    expect(isAsk(b.getCell("I5"))).toBe(true)
    expect(isAsk(b.getCell("F5"))).toBe(true)
    expect(isAsk(b.getCell("I4"))).toBe(false)
    expect(b.getCell(3, 11).value).toBe("配置技術者（ご記入ください）")
    expect([4, 5, 6].map((r) => isAsk(b.getCell(r, 11)))).toEqual([true, true, true])
    // 塗りを変えても、同じ書式だったほかのセルは塗らない
    expect(isAsk(b.getCell("H5"))).toBe(false)
  })

  test("足す列のセルにもとから数式（空の文字を返すもの）があれば書かない（記入用Excelにする）", async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await sourceXlsx()).bytes.slice().buffer as ArrayBuffer)
    wb.getWorksheet("工事経歴")!.getCell(3, 11).value = { formula: 'IF(A3="","","")', result: "" }
    const source = withSource("工事経歴.xlsx", new Uint8Array(await wb.xlsx.writeBuffer()))
    const c = await convertSource(source)
    const plan = await planMarks(c.sheets, placeMarks(c.sheets, c.plan, c.rows, c.inquiries)!, ID)
    expect(plan.columns[0]?.col).toBe(10)
    expect(await markedXlsx(source, plan, KEY, "テスト建設")).toEqual({ ok: false, reason: "表の右端の列に値や数式があり、列を足せないので" })
  })

  test("書いた Excel は印付きとして見分ける。色付きのセルの数は塗ったセルの数", async () => {
    const m = await marked()
    expect(uploadKind(readWorkbook("返信.xlsx", m.bytes))).toBe("marked")
    expect(m.plan.askCount).toBe(m.plan.cells.length)
  })

  test("ほかの列から推し量る変換（工事名から工事場所）の項目は、その列に付けずに列を足す", async () => {
    const c = await convertSource(await sourceXlsx())
    const plan = { ...c.plan, fields: { ...c.plan.fields, place: { kind: "column" as const, column: 2, transform: "ai.inferPlace" as const } } }
    const placement = placeMarks(c.sheets, plan, c.rows, c.inquiries)!
    expect(placement.columns.map((x) => x.header)).toContain("工事場所（ご記入ください）")
    expect(placement.cells.some((x) => x.col === 2)).toBe(false)
  })

  test("足した行（元のファイルに無い工事）の問い合わせは「追加の確認」のシートにまとめる", async () => {
    const source = await sourceXlsx()
    const c = await convertSource(source)
    const addedRow = { ...c.rows[1]!, key: "add-1", sheet: "AIが追加", row: 0 }
    const rows = [...c.rows, addedRow]
    const inquiries = [...c.inquiries, { kind: "cell" as const, rowKey: "add-1", field: "engineer" as const, reason: "missing" as const, current: "" }]
    const placement = placeMarks(c.sheets, c.plan, rows, inquiries)!
    expect(placement.added?.rows.length).toBe(1)
    const out = await markedXlsx(source, await planMarks(c.sheets, placement, ID), KEY, "テスト建設")
    if (!out.ok) throw new Error(out.reason)
    const wb = await load(out.bytes)
    expect(wb.worksheets.map((w) => w.name)).toEqual(["工事経歴", "メモ", ADDED_SHEET_NAME, MARKED_SHEET_NAME])
  })
})

describe("印付きにできるか", () => {
  test(".xls・マクロ付き・CSV・PDF は書かない。理由を返す", async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER]), "s")
    const xls = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xls" }))
    expect(markability("工事経歴.xls", xls)).toEqual({ ok: false, reason: "元のファイルが .xls（古い形）なので" })
    expect(markability("工事経歴.xlsm", xls).ok).toBe(false)
    expect(markability("工事経歴.csv", xls).ok).toBe(false)
    expect(markability("工事経歴.pdf", xls).ok).toBe(false)
    expect(markability("壊れた.xlsx", new Uint8Array([1, 2, 3])).ok).toBe(false)
    expect(markability("工事経歴.xlsx", (await sourceXlsx()).bytes)).toEqual({ ok: true })
  })

  test("スレッド形式のコメントや拡張の入力規則のような書き戻すと消える部分があれば書かない", async () => {
    const source = await sourceXlsx()
    const zip = XLSX.CFB.read(source.bytes, { type: "array" })
    XLSX.CFB.utils.cfb_add(zip, "xl/threadedComments/threadedComment1.xml", new TextEncoder().encode("<ThreadedComments/>"))
    const threaded = new Uint8Array(XLSX.CFB.write(zip, { type: "array", fileType: "zip" }) as ArrayLike<number>)
    expect(markability("工事経歴.xlsx", threaded)).toEqual({ ok: false, reason: "元のファイルにスレッド形式のコメントがあり、壊さずに書けないので" })
  })

  test("グラフや外部リンクのような書き戻すと消える部分があれば書かない", async () => {
    const source = await sourceXlsx()
    const zip = XLSX.CFB.read(source.bytes, { type: "array" })
    XLSX.CFB.utils.cfb_add(zip, "xl/externalLinks/externalLink1.xml", new TextEncoder().encode("<externalLink/>"))
    const withLink = new Uint8Array(XLSX.CFB.write(zip, { type: "array", fileType: "zip" }) as ArrayLike<number>)
    expect(markability("工事経歴.xlsx", withLink)).toEqual({ ok: false, reason: "元のファイルにほかのファイルへのリンクがあり、壊さずに書けないので" })
  })

  test("書けないときは理由を添えて記入用Excel。聞く工事がどれも元の Excel に無いときも記入用Excel", async () => {
    const source = await sourceXlsx()
    const c = await convertSource(source)
    const placement = placeMarks(c.sheets, c.plan, c.rows, c.inquiries)
    const marked = chooseAttachment({ ok: true }, placement, c.rows, c.inquiries)
    expect(marked.kind).toBe("marked")
    // メールの件数と項目ごとの内訳の合計は同じ
    expect(marked.byItem.reduce((n, x) => n + x.count, 0)).toBe(marked.askCount)
    expect(chooseAttachment({ ok: false, reason: "元のファイルが .xls（古い形）なので" }, placement, c.rows, c.inquiries)).toMatchObject({ kind: "sheet", reason: "元のファイルが .xls（古い形）なので" })
    const sheet = chooseAttachment(null, null, c.rows, c.inquiries)
    expect(sheet).toMatchObject({ kind: "sheet" })
    expect(sheet.byItem.reduce((n, x) => n + x.count, 0)).toBe(sheet.askCount)
    const added = c.rows.map((r) => ({ ...r, key: `add-${r.key}` }))
    const addedQs = c.inquiries.map((q) => ({ ...q, rowKey: `add-${q.rowKey}` }))
    expect(chooseAttachment({ ok: true }, placeMarks(c.sheets, c.plan, added, addedQs), added, addedQs)).toMatchObject({ kind: "sheet" })
  })
})

describe("返ってきた印付きの Excel を読む", () => {
  /** 顧客が記入する（ExcelJS で開いて書く） */
  async function answer(bytes: Uint8Array, write: (ws: ExcelJS.Worksheet) => void) {
    const wb = await load(bytes)
    write(wb.worksheets[0]!)
    return readWorkbook("返信.xlsx", new Uint8Array(await wb.xlsx.writeBuffer()))
  }
  const read = (m: Awaited<ReturnType<typeof marked>>, sheets: ReturnType<typeof readWorkbook>, id = ID) => readMarked(sheets, m.rows, m.sheets, { ...id, plan: m.plan === null ? null : planOf(m) }, noAi())
  const planOf = (m: Awaited<ReturnType<typeof marked>>) => heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, m.sheets[0]!)

  test("色付きのセルの記入を、同じ列の対応のまま顧客の回答にする（日付の完成日は年月に、足した列の氏名は区切る）。書かなかったセルは未記入", async () => {
    const m = await marked()
    const sheets = await answer(m.bytes, (ws) => {
      ws.getCell("I5").value = new Date(Date.UTC(2024, 10, 15))
      ws.getCell(4, 11).value = "試験 太郎"
    })
    const r = await read(m, sheets)
    if ("error" in r) throw new Error(r.error)
    const key = m.rows[1]!.key
    expect(r.report.edits).toContainEqual([editKey(key, "endYm"), { value: "202411", by: "customer" }])
    expect(r.report.edits).toContainEqual([editKey(m.rows[0]!.key, "engineer"), { value: "試験　太郎", by: "customer" }])
    expect(r.report.applied.length).toBe(2)
    expect(r.report.unanswered.length).toBeGreaterThan(0)
    expect(r.outside).toBe(0)
  })

  test("印の無いセルを顧客が直していたら入れずに数だけ返す（AI で読める）", async () => {
    const m = await marked()
    const r = await read(m, await answer(m.bytes, (ws) => void (ws.getCell("D4").value = "株式会社テスト商事（訂正）")))
    if ("error" in r) throw new Error(r.error)
    expect(r.report.edits).toEqual([])
    expect(r.outside).toBe(1)
  })

  test("印の無いセルを1つ直した行も見失わずに読み、直したセルは印の無いセルの書き換えとして数える", async () => {
    const m = await marked()
    const r = await read(
      m,
      await answer(m.bytes, (ws) => {
        ws.getCell("C5").value = "テスト倉庫照明工事（追加）"
        ws.getCell("I5").value = new Date(Date.UTC(2024, 10, 15))
      }),
    )
    if ("error" in r) throw new Error(r.error)
    expect(r.report.edits).toContainEqual([editKey(m.rows[1]!.key, "endYm"), { value: "202411", by: "customer" }])
    expect(r.report.unreadable).toEqual([])
    expect(r.outside).toBe(1)
    // 行を足したうえで1つ直しても見つける
    const moved = await read(
      m,
      await answer(m.bytes, (ws) => {
        ws.spliceRows(2, 0, ["（顧客が足した行）"])
        ws.getCell("C6").value = "テスト倉庫照明工事（追加）"
        ws.getCell("I6").value = new Date(Date.UTC(2024, 10, 15))
      }),
    )
    if ("error" in moved) throw new Error(moved.error)
    expect(moved.report.edits).toContainEqual([editKey(m.rows[1]!.key, "endYm"), { value: "202411", by: "customer" }])
    expect(moved.report.unreadable).toEqual([])
  })

  test("顧客が付けたメモは「推定です」で始まっても数え、この画面が付けたメモは数えない", async () => {
    const m = await marked()
    expect((await read(m, readWorkbook("返信.xlsx", m.bytes))) as object).toMatchObject({ outside: 0 })
    const r = await read(m, await answer(m.bytes, (ws) => void (ws.getCell("D4").note = "推定ですが、注文者は別の会社です")))
    expect(r).toMatchObject({ outside: 1 })
  })

  test("シート名の前後に空白があっても、照合用のシートを読める", async () => {
    const m = await marked({ sheetName: " 工事経歴 " })
    const r = await read(m, await answer(m.bytes, (ws) => void (ws.getCell(4, 11).value = "試験 太郎")))
    if ("error" in r) throw new Error(r.error)
    expect(r.report.edits).toContainEqual([editKey(m.rows[0]!.key, "engineer"), { value: "試験　太郎", by: "customer" }])
  })

  test("縦に結合したセルは左上に色を付け、重なる問い合わせは1つのセルにまとめる。記入はどちらの行にも入る", async () => {
    const m = await marked({ mergeDown: true })
    expect(m.plan.cells.filter((c) => c.col === 8).map((c) => c.row)).toEqual([4])
    const keys = m.inquiries.filter((q) => q.field === "endYm").map((q) => q.rowKey)
    expect(keys).toEqual([m.rows[1]!.key, m.rows[2]!.key])
    const r = await read(m, await answer(m.bytes, (ws) => void (ws.getCell("I5").value = new Date(Date.UTC(2024, 10, 15)))))
    if ("error" in r) throw new Error(r.error)
    for (const k of keys) expect(r.report.edits).toContainEqual([editKey(k, "endYm"), { value: "202411", by: "customer" }])
    expect(r.outside).toBe(0)
  })

  test("聞いたあとに表の値が変わったセルで、記入が無いか書いたときのままなら未記入に数える", async () => {
    const m = await marked()
    const key = m.rows[0]!.key
    const rows = m.rows.map((r) => (r.key === key ? { ...r, cells: { ...r.cells, engineer: { ...r.cells.engineer, value: "試験　次郎" } } } : r))
    const r = await readMarked(readWorkbook("返信.xlsx", m.bytes), rows, m.sheets, { ...ID, plan: planOf(m) }, noAi())
    if ("error" in r) throw new Error(r.error)
    expect(r.report.unanswered.some((q) => q.rowKey === key && q.field === "engineer")).toBe(true)
  })

  test("顧客が上に行を足しても、行の中身で探して読む", async () => {
    const m = await marked()
    const sheets = await answer(m.bytes, (ws) => {
      ws.spliceRows(2, 0, ["（顧客が足した行）"])
      ws.getCell("I6").value = new Date(Date.UTC(2024, 10, 15))
    })
    const r = await read(m, sheets)
    if ("error" in r) throw new Error(r.error)
    expect(r.report.edits).toContainEqual([editKey(m.rows[1]!.key, "endYm"), { value: "202411", by: "customer" }])
    expect(r.report.unreadable).toEqual([])
  })

  test("別の案件・変換の元を変えたあと・照合用を書き換えたファイルは読まない", async () => {
    const m = await marked()
    const sheets = readWorkbook("返信.xlsx", m.bytes)
    expect(await read(m, sheets, { ...ID, caseId: "case-2" })).toHaveProperty("error")
    expect(await read(m, sheets, { ...ID, excelKey: "cd".repeat(32) })).toHaveProperty("error")
    expect(await read(m, sheets, { ...ID, sourceFileId: "file-2" })).toHaveProperty("error")
    const tampered = sheets.map((s) => (s.name === MARKED_SHEET_NAME ? { ...s, rows: s.rows.map((r) => (r[0] === "cell" ? [r[0]!, r[1]!.replace('"reason":"missing"', '"reason":"needsReview"')] : r)) } : s))
    expect(await read(m, tampered)).toHaveProperty("error")
  })

  test("聞いたあとにそのセルの値が変わっていたら入れない（changed）。同じファイルをもう一度読んでも書いたときのままなら未記入", async () => {
    const m = await marked()
    const sheets = await answer(m.bytes, (ws) => void (ws.getCell(4, 11).value = "試験 太郎"))
    const key = m.rows[0]!.key
    const rows = m.rows.map((r) => (r.key === key ? { ...r, cells: { ...r.cells, engineer: { ...r.cells.engineer, value: "試験　次郎" } } } : r))
    const r = await readMarked(sheets, rows, m.sheets, { ...ID, plan: planOf(m) }, noAi())
    if ("error" in r) throw new Error(r.error)
    expect(r.report.changed).toEqual([{ rowKey: key, field: "engineer", now: "試験　次郎", answer: "試験　太郎" }])
    expect(r.report.edits.filter(([k]) => k === editKey(key, "engineer"))).toEqual([])
  })

  test("答えを承認したあとに同じファイルを上げ直しても「変わっていた」とは言わず、表にもうあるとして数える", async () => {
    const m = await marked()
    const sheets = await answer(m.bytes, (ws) => void (ws.getCell(4, 11).value = "試験 太郎"))
    const key = m.rows[0]!.key
    const rows = m.rows.map((r) => (r.key === key ? { ...r, cells: { ...r.cells, engineer: { ...r.cells.engineer, value: "試験　太郎", by: "customer" as const } } } : r))
    const r = await readMarked(sheets, rows, m.sheets, { ...ID, plan: planOf(m) }, noAi())
    if ("error" in r) throw new Error(r.error)
    expect(r.report.changed).toEqual([])
    expect(r.report.alreadyApplied.map((q) => [q.rowKey, q.field])).toEqual([[key, "engineer"]])
  })

  test("結合したセルに書いても行を見失わず、結合の隣の列を印の無いセルの書き換えとして数えない", async () => {
    const m = await marked({ mergeEnd: true })
    const r = await read(m, await answer(m.bytes, (ws) => void (ws.getCell("I5").value = new Date(Date.UTC(2024, 10, 15)))))
    if ("error" in r) throw new Error(r.error)
    expect(r.report.edits).toContainEqual([editKey(m.rows[1]!.key, "endYm"), { value: "202411", by: "customer" }])
    expect(r.report.unreadable).toEqual([])
    expect(r.outside).toBe(0)
  })
})

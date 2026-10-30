import { describe, expect, test } from "bun:test"
import ExcelJS from "exceljs"
import { deriveTable, type CaseTable } from "../../cases/view"
import { applyChanges, type ChatChange } from "../../chat/proposals"
import type { AiBatchRequest } from "../../convert/ai-tasks"
import { editKey } from "../../convert/convert"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import type { AiCaller } from "../../convert/pipeline"
import { readWorkbook } from "../../convert/workbook"
import { columnLetter } from "../../convert/plan"
import { KOJI_KEIREKI } from "../../spec/koji-keireki"
import { editSheet, INCLUDE_HEADER, META_HEADER, readEditSheet } from "../edit-sheet"
import { MAX_ADDED_ROWS } from "../../cases/added"
import { fileAddressLookup } from "../../convert/address-file"
import { editXlsx } from "../edit-xlsx"

const yamada = personToken("山田太郎")
const base = { gyoshu: "8", motoukeShitauke: "1", jv: "0", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", specialAmount: "0", startYm: "202404", endYm: "202409", chiefEngineer: "1", supervisingEngineer: "0" }
const rows = [
  kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事`, amount: "5000" }, 1),
  kojiRow({ ...base, client: "株式会社テスト", workName: "テストﾋﾞﾙ電気工事", amount: "3000" }, 2),
  kojiRow({ ...base, client: "株式会社サンプル", workName: "サンプル倉庫改修", amount: "1000" }, 3),
]
const table: CaseTable = { rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded", basis: {}, selection: "all" as const, sorted: false }

/** 匿名化の決まった応答: 注文者は全体、工事名は「様邸」「邸」の前を個人名として印にする */
const anonymize: AiCaller = async (req: AiBatchRequest) => ({
  ok: true,
  json: {
    results: req.items.map((i) => {
      if (req.task === "anonymizeClient") return { id: i.id, value: "〔1〕", persons: [i.input], needsReview: false, note: "" }
      const m = /^(.+?)様?邸/.exec(i.input)
      return m ? { id: i.id, value: i.input.replace(m[1]!, "〔1〕"), persons: [m[1]!], needsReview: false, note: "" } : { id: i.id, value: i.input, persons: [], needsReview: false, note: "" }
    }),
  },
})
const ai = { rounding: "floor" as const, cache: new Map(), callAi: anonymize, lookup: fileAddressLookup }

/** 落とした Excel を ExcelJS で開いて直し（職員の手直しの代わり）、上げ直したときと同じく SheetJS で読む */
async function roundTrip(t: CaseTable, edit: (ws: ExcelJS.Worksheet, col: (h: string) => number, rowOf: (key: string) => number) => void) {
  const view = deriveTable(t)
  const sheet = editSheet(view)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await editXlsx(sheet)).buffer as ArrayBuffer)
  const ws = wb.worksheets[0]!
  const col = (h: string) => sheet.columns.findIndex((c) => c.header === h) + 1
  const rowOf = (key: string) => sheet.keys.findIndex((k) => k.key === key) + 2
  edit(ws, col, rowOf)
  return readWorkbook("編集用.xlsx", new Uint8Array(await wb.xlsx.writeBuffer()))
}
const label = (id: string) => KOJI_KEIREKI.fields.find((f) => f.id === id)!.label

describe("編集用の Excel の往復", () => {
  test("落とした表: 個人名は実名、全セルは文字列の書式、行ごとの照合用（隠し列）と落とした行の一覧（隠しシート）を持つ", async () => {
    const sheet = editSheet(deriveTable(table))
    expect(sheet.rows[0]![sheet.columns.findIndex((c) => c.header === label("client"))]).toBe("山田太郎")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await editXlsx(sheet)).buffer as ArrayBuffer)
    const ws = wb.worksheets[0]!
    const metaCol = sheet.columns.findIndex((c) => c.header === META_HEADER) + 1
    expect(ws.getColumn(metaCol).hidden).toBe(true)
    expect(ws.getCell(2, 2).numFmt).toBe("@")
    expect(ws.getColumn(2).numFmt).toBe("@")
    expect(wb.getWorksheet("照合用")!.state).toBe("hidden")
  })

  test("何も直さずに上げ直すと変更案は無い", async () => {
    const sheets = await roundTrip(table, () => {})
    const r = await readEditSheet(sheets, deriveTable(table), ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.changes).toEqual([])
  })

  test("値を1つ直し、行を1つ消し、行を1つ足す → セル・載せない・足すの変更案。承認すると表に入る", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      ws.getCell(rowOf("s!2"), col(label("amount"))).value = "3500"
      ws.spliceRows(rowOf("s!3"), 1)
      const last = rowOf("s!3") // 消した分だけ上がるので、空いた行は最後の行の次
      ws.getCell(last, col(label("gyoshu"))).value = "08"
      ws.getCell(last, col(label("client"))).value = "株式会社あたらし"
      ws.getCell(last, col(label("workName"))).value = "あたらし工場ﾃﾅﾝﾄ工事"
      ws.getCell(last, col(label("amount"))).value = "1,200"
      ws.getCell(last, col(label("startYm"))).value = "2024年5月"
    })
    const view = deriveTable(table)
    const r = await readEditSheet(sheets, view, ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.report).toMatchObject({ cells: 1, excluded: 1, added: 1, conflicts: [], broken: [], invalid: [] })
    const [cell, exclude, add] = r.changes as [Extract<ChatChange, { kind: "cell" }>, Extract<ChatChange, { kind: "include" }>, Extract<ChatChange, { kind: "add" }>]
    expect(cell).toEqual({ kind: "cell", rowKey: "s!2", field: "amount", edit: { value: "3500", by: "excel" } })
    expect(exclude).toEqual({ kind: "include", rowKey: "s!3", include: false })
    expect(add.kind).toBe("add")
    expect(Object.fromEntries(Object.entries(add.cells).map(([f, e]) => [f, e!.value]))).toEqual({ gyoshu: "8", client: "株式会社あたらし", workName: "あたらし工場ﾃﾅﾝﾄ工事", amount: "1200", startYm: "202405" })
    const after = deriveTable(applyChanges(table, view.edited, r.changes))
    expect(after.output.map((x) => x.key)).toEqual(["s!1", "s!2", add.rowKey])
    expect(after.shown.find((x) => x.key === add.rowKey)!.cells.workName.value).toBe("あたらし工場ﾃﾅﾝﾄ工事")
    expect(after.shown.find((x) => x.key === "s!2")!.cells.amount).toMatchObject({ value: "3500", by: "excel", source: "Excel（承認）" })
  })

  test("注文者・工事名に書いた個人名は変換と同じ匿名化で印にする。確かめられない値は変更案にしない", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      ws.getCell(rowOf("s!2"), col(label("client"))).value = "鈴木一郎"
      ws.getCell(rowOf("s!1"), col(label("workName"))).value = "山田太郎様邸改修工事"
    })
    const r = await readEditSheet(sheets, deriveTable(table), ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.changes.map((c) => c.kind === "cell" && [c.rowKey, c.field, c.edit.value])).toEqual([
      ["s!1", "workName", `${yamada}様邸改修工事`],
      ["s!2", "client", personToken("鈴木一郎")],
    ])
    const after = deriveTable(applyChanges(table, deriveTable(table).edited, r.changes))
    expect(after.shown.map((x) => x.cells.client.value)).toEqual(["Ａ", "Ｂ", "株式会社サンプル"])
    const noAi = await readEditSheet(sheets, deriveTable(table), { rounding: "floor", cache: new Map(), lookup: fileAddressLookup })
    if ("error" in noAi) throw new Error(noAi.error)
    expect(noAi.changes.map((c) => c.kind === "cell" && c.field)).toEqual([])
    expect(noAi.report.refused.map((x) => x.field).sort()).toEqual(["client", "workName"])
  })

  test("照合用が壊れた行・重なる行はエラーで知らせて取り込まない（壊れた行があれば消した行も載せないにしない）。読めない値も知らせる", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      ws.getCell(rowOf("s!1"), col(META_HEADER)).value = "壊した"
      // s!2 の行を写して下に足す（照合用が2つ）
      const copy = ws.getRow(rowOf("s!2")).values as ExcelJS.CellValue[]
      ws.getRow(rowOf("s!3") + 1).values = copy
      ws.getCell(rowOf("s!3"), col(label("endYm"))).value = "そのうち"
      ws.getCell(rowOf("s!3"), col(INCLUDE_HEADER)).value = "たぶん"
    })
    const r = await readEditSheet(sheets, deriveTable(table), ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.changes).toEqual([])
    expect(r.report.broken.map((b) => b.line)).toEqual([2])
    expect(r.report.duplicateKeys).toEqual(["s!2"])
    expect(r.report.invalid.map((x) => x.field).sort()).toEqual(["endYm", "include"])
  })

  test("落としたあとに表のその値が変わっていたら、職員の手直しを上書きせず食い違いとして知らせる（ほかの値は取り込む）", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      ws.getCell(rowOf("s!2"), col(label("amount"))).value = "3500"
      ws.getCell(rowOf("s!2"), col(label("place"))).value = "港区"
    })
    const changed: CaseTable = { ...table, edits: new Map([[editKey("s!2", "amount"), { value: "3100", by: "staff" }]]) }
    const r = await readEditSheet(sheets, deriveTable(changed), ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.report.conflicts).toEqual([{ line: 3, rowKey: "s!2", field: "amount", sent: "3000", now: "3100", uploaded: "3500" }])
    expect(r.changes).toEqual([{ kind: "cell", rowKey: "s!2", field: "place", edit: { value: "港区", by: "excel" } }])
  })

  test("オートフィルタの範囲に照合用の列も入れる（フィルタで並べ替えても値と照合用が一緒に動く）", async () => {
    const sheet = editSheet(deriveTable(table))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await editXlsx(sheet)).buffer as ArrayBuffer)
    // 読み直すと範囲の文字列（例: A1:S1）になる
    expect(wb.worksheets[0]!.autoFilter).toBe(`A1:${columnLetter(sheet.columns.findIndex((c) => c.header === META_HEADER))}1`)
  })

  test("足した工事は中身から行を見分け、同じ Excel を2回上げても二重に足さない（同じ中身の行が2つなら2行）", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      const last = rowOf("s!3") + 1
      for (const r of [last, last + 1]) {
        ws.getCell(r, col(label("gyoshu"))).value = "8"
        ws.getCell(r, col(label("client"))).value = "株式会社あたらし"
        ws.getCell(r, col(label("amount"))).value = "1200"
      }
    })
    const first = await readEditSheet(sheets, deriveTable(table), ai)
    if ("error" in first) throw new Error(first.error)
    const keys = first.changes.flatMap((c) => (c.kind === "add" ? [c.rowKey] : []))
    expect(new Set(keys).size).toBe(2)
    // 承認する前にもう一度上げても同じ key（両方を承認しても1回分）
    const again = await readEditSheet(sheets, deriveTable(table), ai)
    if ("error" in again) throw new Error(again.error)
    expect(again.changes.flatMap((c) => (c.kind === "add" ? [c.rowKey] : []))).toEqual(keys)
    const both = applyChanges(applyChanges(table, deriveTable(table).edited, first.changes), deriveTable(table).edited, again.changes)
    expect(both.added).toHaveLength(2)
    // 承認したあとに同じ Excel を上げても足さない
    const third = await readEditSheet(sheets, deriveTable(both), ai)
    if ("error" in third) throw new Error(third.error)
    expect(third.changes).toEqual([])
    expect(third.report.added).toBe(0)
  })

  test("消した行は、落としたときに載っていて今も載っている行だけを載せないにする（落としたあとに画面で決めた入れ外しを覆さない）", async () => {
    const t: CaseTable = { ...table, selection: "rule7", manual: new Map([["s!3", false]]) }
    const sheets = await roundTrip(t, (ws, _col, rowOf) => {
      ws.spliceRows(rowOf("s!3"), 1)
      ws.spliceRows(rowOf("s!2"), 1)
    })
    // 落としたあとに画面で s!3 を載せ、s!2 を外した
    const now: CaseTable = { ...t, manual: new Map([["s!3", true], ["s!2", false]]) }
    const r = await readEditSheet(sheets, deriveTable(now), ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.changes).toEqual([])
    const kept = await readEditSheet(sheets, deriveTable(t), ai)
    if ("error" in kept) throw new Error(kept.error)
    expect(kept.changes).toEqual([{ kind: "include", rowKey: "s!2", include: false }])
  })

  test("新しい行の「CSVに載せる」: ○ は載せる（数える）、読めない値は知らせてその行は足さない", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      const last = rowOf("s!3") + 1
      ws.getCell(last, col(INCLUDE_HEADER)).value = "○"
      ws.getCell(last, col(label("client"))).value = "株式会社いち"
      ws.getCell(last + 1, col(INCLUDE_HEADER)).value = "たぶん"
      ws.getCell(last + 1, col(label("client"))).value = "株式会社に"
    })
    const r = await readEditSheet(sheets, deriveTable(table), ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.report).toMatchObject({ added: 1, included: 1 })
    expect(r.report.invalid.map((x) => [x.line, x.field])).toEqual([[6, "include"]])
  })

  test("足した行が上限を超えるなら、AI（匿名化）を呼ぶ前に断る", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      const last = rowOf("s!3") + 1
      for (let i = 0; i <= MAX_ADDED_ROWS; i++) ws.getCell(last + i, col(label("client"))).value = `田中${i}`
    })
    let called = 0
    const r = await readEditSheet(sheets, deriveTable(table), { ...ai, callAi: async (req) => (called++, anonymize(req)) })
    expect("error" in r && r.error).toContain(String(MAX_ADDED_ROWS))
    expect(called).toBe(0)
  })

  test("場所名に住所を書いたら変換と同じ分け方で市区町村にし、都道府県もそろえる。都道府県名と食い違えば知らせて取り込まない", async () => {
    const sheets = await roundTrip(table, (ws, col, rowOf) => {
      ws.getCell(rowOf("s!1"), col(label("place"))).value = "神奈川県横浜市中区山下町1"
      ws.getCell(rowOf("s!2"), col(label("place"))).value = "大阪府大阪市北区梅田1-1"
      ws.getCell(rowOf("s!2"), col(label("prefecture"))).value = "京都府"
      ws.getCell(rowOf("s!3"), col(label("place"))).value = "東京都丸の内1-1"
    })
    const r = await readEditSheet(sheets, deriveTable(table), ai)
    if ("error" in r) throw new Error(r.error)
    expect(r.changes.map((c) => c.kind === "cell" && [c.rowKey, c.field, c.edit.value])).toEqual([
      ["s!1", "place", "横浜市中区"],
      ["s!1", "prefecture", "神奈川県"],
    ])
    expect(r.report.invalid.map((x) => [x.line, x.field]).sort()).toEqual([
      [3, "place"],
      [3, "prefecture"],
      [4, "place"],
    ])
  })

  test("この画面で落とした Excel でなければ読まない", async () => {
    const r = await readEditSheet([{ name: "Sheet1", rows: [["a", "b"]], hidden: [] }], deriveTable(table), ai)
    expect("error" in r).toBe(true)
  })
})

import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import { describe, expect, test } from "bun:test"
import ExcelJS from "exceljs"
import { MAX_ADDED_ROWS } from "../../cases/added"
import { uploadKind } from "../../cases/upload-kind"
import { deriveTable, type CaseTable } from "../../cases/view"
import { applyChanges, type ChatChange } from "../../chat/proposals"
import type { AiBatchRequest } from "../../convert/ai-tasks"
import { fileAddressLookup } from "../../convert/address-file"
import { editKey } from "../../convert/convert"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import type { AiCaller } from "../../convert/pipeline"
import { readWorkbook } from "../../convert/workbook"
import { KOJI_KEIREKI, type KojiFieldId } from "../../spec/koji-keireki"
import { matchRows, readFinalSheet } from "../final-import"
import { CHECK_SHEET_NAME, finalSheet } from "../final-sheet"
import { finalXlsx } from "../final-xlsx"

const yamada = personToken("山田太郎")
const base = { gyoshu: "8", motoukeShitauke: "1", jv: "0", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", specialAmount: "0", startYm: "202404", endYm: "202409", chiefEngineer: "1", supervisingEngineer: "0" }
const rows = [
  kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事`, amount: "5000" }, 1),
  kojiRow({ ...base, client: "株式会社テスト", workName: "テストﾋﾞﾙ電気工事", amount: "3000" }, 2),
  kojiRow({ ...base, client: "株式会社サンプル", workName: "サンプル倉庫改修", amount: "1000" }, 3),
]
const table: CaseTable = { rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded", basis: {}, rule7Tax: "excluded" as const, selection: "all" as const, dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT }
const id = { caseId: "case-1", sourceFileId: "file-1", excelKey: "1".repeat(64) }

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
const col = (f: KojiFieldId) => KOJI_KEIREKI.fields.findIndex((x) => x.id === f) + 1

/** 落とした最後の Excel を ExcelJS で開いて直し（職員の手直しの代わり）、上げ直したときと同じく SheetJS で読む。rowOf は落としたときのその行の行番号 */
async function roundTrip(t: CaseTable, edit: (ws: ExcelJS.Worksheet, rowOf: (key: string) => number) => void) {
  const view = deriveTable(t)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await finalXlsx(await finalSheet(view, id))).buffer as ArrayBuffer)
  edit(wb.worksheets[0]!, (key) => view.output.findIndex((r) => r.key === key) + 1)
  return readWorkbook("直した.xlsx", new Uint8Array(await wb.xlsx.writeBuffer()))
}
async function read(sheets: ReturnType<typeof readWorkbook>, t: CaseTable, options = ai) {
  const r = await readFinalSheet(sheets, deriveTable(t), id, options)
  if ("error" in r) throw new Error(r.error)
  return r
}
const cellsOf = (changes: ChatChange[]) => changes.flatMap((c) => (c.kind === "cell" ? [[c.rowKey, c.field, c.edit.value]] : []))

describe("最後の Excel の上げ直し", () => {
  test("何も直さずに上げ直すと変更案は無い。この画面で落とした最後の Excel だと見分ける", async () => {
    const sheets = await roundTrip(table, () => {})
    expect(uploadKind(sheets)).toBe("final")
    const r = await read(sheets, table)
    expect(r.changes).toEqual([])
  })

  test("セルを直す → セルの変更案。承認すると表に入る", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!2"), col("amount")).value = 3500
      ws.getCell(rowOf("s!3"), col("startYm")).value = "2024年5月"
    })
    const view = deriveTable(table)
    const r = await read(sheets, table)
    expect(r.report).toMatchObject({ cells: 2, added: 0, excluded: 0, conflicts: [], invalid: [], ambiguous: [] })
    expect(r.changes).toEqual([
      { kind: "cell", rowKey: "s!2", field: "amount", edit: { value: "3500", by: "excel" } },
      { kind: "cell", rowKey: "s!3", field: "startYm", edit: { value: "202405", by: "excel" } },
    ])
    const after = deriveTable(applyChanges(table, view.edited, r.changes))
    expect(after.shown.find((x) => x.key === "s!2")!.cells.amount).toMatchObject({ value: "3500", by: "excel" })
  })

  test("行を足す → 足して載せる。同じ Excel を2回上げても二重に足さない", async () => {
    const sheets = await roundTrip(table, (ws) => {
      ws.addRow([8, "株式会社あたらし", 1, 0, "あたらし工場ﾃﾅﾝﾄ工事", "東京都", "港区", "試験　太郎", "1,200", 0, "202405", "202406", 1, 0])
    })
    const first = await read(sheets, table)
    expect(first.report).toMatchObject({ added: 1, cells: 0, excluded: 0 })
    const add = first.changes.find((c): c is Extract<ChatChange, { kind: "add" }> => c.kind === "add")!
    expect(Object.fromEntries(Object.entries(add.cells).map(([f, e]) => [f, e!.value]))).toMatchObject({ gyoshu: "8", client: "株式会社あたらし", amount: "1200", startYm: "202405" })
    expect(first.changes).toContainEqual({ kind: "include", rowKey: add.rowKey, include: true })
    const again = await read(sheets, table)
    expect(again.changes.flatMap((c) => (c.kind === "add" ? [c.rowKey] : []))).toEqual([add.rowKey])
    const approved = applyChanges(table, deriveTable(table).edited, first.changes)
    expect(deriveTable(approved).output.map((x) => x.key)).toContain(add.rowKey)
    const third = await read(sheets, approved)
    expect(third.changes).toEqual([])
    expect(third.report.alreadyAdded).toBe(1)
  })

  test("行を消す → 「載せない」の変更案（落としたあとに画面で外した行は何もしない）", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.spliceRows(rowOf("s!3"), 1)
      ws.spliceRows(rowOf("s!2"), 1)
    })
    const r = await read(sheets, table)
    expect(r.changes).toEqual([
      { kind: "include", rowKey: "s!2", include: false },
      { kind: "include", rowKey: "s!3", include: false },
    ])
    const now: CaseTable = { ...table, manual: new Map([["s!2", false]]) }
    expect((await read(sheets, now)).changes).toEqual([{ kind: "include", rowKey: "s!3", include: false }])
  })

  test("並べ替えて1つ直す → 中身で行を対応させ、直したセルだけが変更案", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!3"), col("place")).value = "港区"
      const values = [1, 2, 3].map((r) => ws.getRow(r).values as ExcelJS.CellValue[])
      values.reverse().forEach((v, i) => (ws.getRow(i + 1).values = v))
    })
    const r = await read(sheets, table)
    expect(cellsOf(r.changes)).toEqual([["s!3", "place", "港区"]])
    expect(r.report).toMatchObject({ added: 0, excluded: 0 })
  })

  test("似た行を両方直して決めきれない → 当てずに一覧に出し、その候補は「載せない」にもしない", async () => {
    const twin = { ...base, client: "株式会社テスト", workName: "テスト工事", startYm: "202404" }
    const t: CaseTable = { ...table, rows: [kojiRow({ ...twin, amount: "5000" }, 1), kojiRow({ ...twin, amount: "3000" }, 2)] }
    const sheets = await roundTrip(t, (ws, rowOf) => {
      ws.getCell(rowOf("s!1"), col("amount")).value = 4000
      ws.getCell(rowOf("s!2"), col("amount")).value = 4500
    })
    const r = await read(sheets, t)
    expect(r.changes).toEqual([])
    expect(r.report.ambiguous.map((a) => [a.line, a.candidates])).toEqual([
      [1, 2],
      [2, 2],
    ])
    expect(r.report.keptRows).toBe(2)
  })

  test("記号のまま直す → 同じ人。記号を実名に書き換える → 変換と同じ匿名化。確かめられなければ取り込まない", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!1"), col("workName")).value = "Ａ邸改修工事"
      ws.getCell(rowOf("s!2"), col("client")).value = "鈴木一郎"
    })
    const r = await read(sheets, table)
    expect(cellsOf(r.changes)).toEqual([
      ["s!1", "workName", `${yamada}邸改修工事`],
      ["s!2", "client", personToken("鈴木一郎")],
    ])
    const after = deriveTable(applyChanges(table, deriveTable(table).edited, r.changes))
    expect(after.output.map((x) => x.cells.client.value)).toEqual(["Ａ", "Ｂ", "株式会社サンプル"])
    expect(after.output[0]!.cells.workName.value).toBe("Ａ邸改修工事")
    const noAi = await read(sheets, table, { rounding: "floor", cache: new Map(), lookup: fileAddressLookup } as typeof ai)
    expect(cellsOf(noAi.changes)).toEqual([])
    expect(noAi.report.refused.map((x) => x.field).sort()).toEqual(["client", "workName"])
    expect(JSON.stringify(noAi.report)).not.toContain("山田")
  })

  test("落としたあとに記号が付け直されても（前の行を外した）、記号の人を取り違えず、食い違いにもしない", async () => {
    const t: CaseTable = { ...table, rows: [rows[0]!, kojiRow({ ...base, client: personToken("鈴木一郎"), workName: `${personToken("鈴木一郎")}邸新築工事`, amount: "3000" }, 2)] }
    const sheets = await roundTrip(t, (ws, rowOf) => {
      ws.getCell(rowOf("s!2"), col("workName")).value = "Ｂ邸改築工事"
    })
    // 落としたあとに s!1 を外したので、鈴木は Ｂ → Ａ になった
    const now: CaseTable = { ...t, manual: new Map([["s!1", false]]) }
    expect(deriveTable(now).output[0]!.cells.client.value).toBe("Ａ")
    const r = await read(sheets, now)
    expect(r.report.conflicts).toEqual([])
    expect(cellsOf(r.changes)).toEqual([["s!2", "workName", `${personToken("鈴木一郎")}邸改築工事`]])
  })

  test("落としたあとに表のその値が変わっていたら、上書きせず食い違いとして知らせる（ほかの値は取り込む）", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!2"), col("amount")).value = 3500
      ws.getCell(rowOf("s!2"), col("place")).value = "港区"
    })
    const changed: CaseTable = { ...table, edits: new Map([[editKey("s!2", "amount"), { value: "3100", by: "staff" }]]) }
    const r = await read(sheets, changed)
    expect(r.report.conflicts).toEqual([{ line: 2, field: "amount", sent: "3000", now: "3100", uploaded: "3500" }])
    expect(r.changes).toEqual([{ kind: "cell", rowKey: "s!2", field: "place", edit: { value: "港区", by: "excel" } }])
  })

  test("場所名に住所を書いたら市区町村にし、都道府県もそろえる。読めない値は知らせて取り込まない", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!1"), col("place")).value = "神奈川県横浜市中区山下町1"
      ws.getCell(rowOf("s!2"), col("endYm")).value = "そのうち"
    })
    const r = await read(sheets, table)
    expect(cellsOf(r.changes)).toEqual([
      ["s!1", "place", "横浜市中区"],
      ["s!1", "prefecture", "神奈川県"],
    ])
    expect(r.report.invalid.map((x) => [x.line, x.field])).toEqual([[2, "endYm"]])
  })

  test("足した行が上限を超えるなら、AI（匿名化）を呼ぶ前に断る", async () => {
    const sheets = await roundTrip(table, (ws) => {
      for (let i = 0; i <= MAX_ADDED_ROWS; i++) ws.addRow([8, `田中${i}`])
    })
    let called = 0
    const r = await readFinalSheet(sheets, deriveTable(table), id, { ...ai, callAi: async (req) => (called++, anonymize(req)) })
    expect("error" in r && r.error).toContain(String(MAX_ADDED_ROWS))
    expect(called).toBe(0)
  })

  test("隠しシートが無い・別の案件・変換の元を変えたあとの Excel は読まない（隠しシートの無い最後の形の表は元データと取り違えない）", async () => {
    const sheets = await roundTrip(table, () => {})
    const data = sheets.filter((s) => s.name !== CHECK_SHEET_NAME)
    expect(uploadKind(data)).toBe("unlinked")
    expect("error" in (await readFinalSheet(data, deriveTable(table), id, ai))).toBe(true)
    expect(await readFinalSheet(sheets, deriveTable(table), { ...id, caseId: "case-2" }, ai)).toEqual({ error: "別の案件で落とした Excel です" })
    expect("error" in (await readFinalSheet(sheets, deriveTable(table), { ...id, sourceFileId: "file-2" }, ai))).toBe(true)
    const broken = sheets.map((s) => (s.name === CHECK_SHEET_NAME ? { ...s, rows: s.rows.map((r, i) => (i === 1 ? ["meta", "書き換えた"] : r)) } : s))
    expect(uploadKind(broken)).toBe("final")
    expect("error" in (await readFinalSheet(broken, deriveTable(table), id, ai))).toBe(true)
  })
})

describe("最後の Excel の上げ直し（取り違え・二重・重さ）", () => {
  test("メモのシートを先頭に足してもデータのシートを読む。データを消した・別の表を上げたなら、全行を「載せない」にせず断る", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!2"), col("amount")).value = 3500
    })
    const memo = { name: "メモ", rows: [["確認済み"]], hidden: [false] }
    expect(cellsOf((await read([memo, ...sheets], table)).changes)).toEqual([["s!2", "amount", "3500"]])
    const emptied = sheets.map((s) => (s.name === CHECK_SHEET_NAME ? s : { ...s, rows: [["9", "別の表"]] }))
    const r = await readFinalSheet(emptied, deriveTable(table), id, ai)
    expect("error" in r && r.error).toContain("1つも見つかりません")
  })

  test("場所名に住所を書いて承認したあとに同じ Excel を上げても、食い違いにしない", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!1"), col("place")).value = "神奈川県横浜市中区山下町1"
    })
    const first = await read(sheets, table)
    const approved = applyChanges(table, deriveTable(table).edited, first.changes)
    const again = await read(sheets, approved)
    expect(again.report.conflicts).toEqual([])
    expect(again.changes).toEqual([])
  })

  test("場所名の住所からそろえる都道府県名は、落としたあとに画面で都道府県名を変えていたら上書きせず食い違いにする", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      ws.getCell(rowOf("s!1"), col("place")).value = "神奈川県横浜市中区山下町1"
    })
    const changed: CaseTable = { ...table, edits: new Map([[editKey("s!1", "prefecture"), { value: "千葉県", by: "staff" }]]) }
    const r = await read(sheets, changed)
    expect(cellsOf(r.changes)).toEqual([["s!1", "place", "横浜市中区"]])
    expect(r.report.conflicts).toEqual([{ line: 1, field: "prefecture", sent: "東京都", now: "千葉県", uploaded: "神奈川県" }])
  })

  test("1行で4〜6列を直した行は、当てずに決めきれない行として出す（足した行と消した行にしない）", async () => {
    const sheets = await roundTrip(table, (ws, rowOf) => {
      const r = rowOf("s!2")
      ws.getCell(r, col("client")).value = "株式会社べつ"
      ws.getCell(r, col("workName")).value = "べつの工事"
      ws.getCell(r, col("place")).value = "港区"
      ws.getCell(r, col("amount")).value = 3333
    })
    const r = await read(sheets, table)
    expect(r.changes).toEqual([])
    expect(r.report.ambiguous).toEqual([{ line: 2, candidates: 1 }])
    expect(r.report.keptRows).toBe(1)
  })

  test("請負代金の列に桁区切りの書式を付けても、直したことにしない", async () => {
    const sheets = await roundTrip(table, (ws) => {
      ws.getColumn(col("amount")).numFmt = "#,##0"
    })
    const r = await read(sheets, table)
    expect(r.changes).toEqual([])
    expect(r.report).toMatchObject({ conflicts: [], ambiguous: [], added: 0, excluded: 0 })
  })

  test("案件の照合用の鍵が無い（この案件で書き出していない）なら読まない", async () => {
    const sheets = await roundTrip(table, () => {})
    expect("error" in (await readFinalSheet(sheets, deriveTable(table), { ...id, excelKey: null }, ai))).toBe(true)
  })
})

describe("行の対応", () => {
  const row = (...v: string[]) => [...v, ...Array(14 - v.length).fill("x")]
  test("同じ中身 → 近い行の順。違う列が7つ以上の行は新しい行、4〜6列の行は決めきれない", () => {
    const sent = [row("a", "1"), row("b", "2"), row("c", "3")]
    const up = [row("c", "3"), row("a", "9"), row(..."qqqqqqq"), row(..."bqqqq")]
    const m = matchRows(up, sent)
    expect(m.pairs.sort()).toEqual([
      [0, 2],
      [1, 0],
    ])
    expect(m.unmatchedUploaded).toEqual([2, 3])
    expect(m.unmatchedSent).toEqual([1])
    expect(m.ambiguous).toEqual([3])
    expect(m.candidates.get(3)).toEqual([1])
  })
})

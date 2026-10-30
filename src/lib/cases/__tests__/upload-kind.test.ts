import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import { describe, expect, test } from "bun:test"
import { deriveTable, type CaseTable } from "../../cases/view"
import { kojiRow } from "../../convert/__tests__/helpers"
import { fixture } from "../../convert/__tests__/helpers"
import { readWorkbook } from "../../convert/workbook"
import ExcelJS from "exceljs"
import { finalSheet } from "../../excel/final-sheet"
import { finalXlsx } from "../../excel/final-xlsx"
import { collectInquiries, inquirySheet, type CellInquiry } from "../../inquiry/inquiry"
import { inquiryXlsx } from "../../inquiry/inquiry-xlsx"
import { uploadKind } from "../upload-kind"

const base = { gyoshu: "8", motoukeShitauke: "1", jv: "0", prefecture: "", place: "", engineer: "試験　太郎", specialAmount: "0", startYm: "202404", endYm: "202409", chiefEngineer: "1", supervisingEngineer: "0" }
const table: CaseTable = {
  rows: [kojiRow({ ...base, client: "株式会社テスト", workName: "テスト工事", amount: "5000" }, 1)],
  added: [],
  edits: new Map(),
  replacements: {},
  manual: new Map(),
  tax: "excluded",
  basis: {},
  rule7Tax: "excluded",
  selection: "all",
  dismissed: new Set<string>(),
  inquiryText: EMPTY_INQUIRY_TEXT,
}

describe("上げたファイルの種類", () => {
  test("最後の Excel・記入用Excel・元データ・PDF を見分ける", async () => {
    const view = deriveTable(table)
    const final = readWorkbook("最後.xlsx", await finalXlsx(await finalSheet(view, { caseId: "case-1", sourceFileId: null, excelKey: "1".repeat(64) })))
    expect(uploadKind(final)).toBe("final")
    const cells = collectInquiries(view.output, { tax: "excluded" }).filter((q): q is CellInquiry => q.kind === "cell")
    expect(cells.length).toBeGreaterThan(0)
    const answer = readWorkbook("記入のお願い.xlsx", await inquiryXlsx(inquirySheet(view.output, cells), "顧客"))
    expect(uploadKind(answer)).toBe("answer")
    expect(uploadKind(readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx")))).toBe("sheet")
    expect(uploadKind(null)).toBe("document")
  })

  test("照合用のシートの無い最後の Excel の形の表と、前の編集用の Excel は、表に戻せない Excel", async () => {
    const view = deriveTable(table)
    const final = readWorkbook("最後.xlsx", await finalXlsx(await finalSheet(view, { caseId: "case-1", sourceFileId: null, excelKey: "1".repeat(64) })))
    expect(uploadKind(final.slice(0, 1))).toBe("unlinked")
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet("工事経歴（編集用）").addRows([["業種", "照合用"], ["8", "{}"]])
    wb.addWorksheet("照合用").state = "veryHidden"
    expect(uploadKind(readWorkbook("編集用.xlsx", new Uint8Array(await wb.xlsx.writeBuffer())))).toBe("unlinked")
  })
})

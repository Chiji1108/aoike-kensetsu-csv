import { describe, expect, test } from "bun:test"
import { deriveTable, type CaseTable } from "../../cases/view"
import { kojiRow } from "../../convert/__tests__/helpers"
import { fixture } from "../../convert/__tests__/helpers"
import { readWorkbook } from "../../convert/workbook"
import { editSheet } from "../../excel/edit-sheet"
import { editXlsx } from "../../excel/edit-xlsx"
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
  selection: "all",
  sorted: false,
}

describe("上げたファイルの種類", () => {
  test("編集用の Excel・記入用Excel・元データ・PDF を見分ける", async () => {
    const view = deriveTable(table)
    const edit = readWorkbook("編集用.xlsx", await editXlsx(editSheet(view)))
    expect(uploadKind(edit)).toBe("edit")
    const cells = collectInquiries(view.output, { tax: "excluded" }).filter((q): q is CellInquiry => q.kind === "cell")
    expect(cells.length).toBeGreaterThan(0)
    const answer = readWorkbook("記入のお願い.xlsx", await inquiryXlsx(inquirySheet(view.output, cells), "顧客"))
    expect(uploadKind(answer)).toBe("answer")
    expect(uploadKind(readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx")))).toBe("sheet")
    expect(uploadKind(null)).toBe("document")
  })
})

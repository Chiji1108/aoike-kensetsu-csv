import { expect, test } from "bun:test"
import { onlyNonSheetSources, type CaseFile } from "../types"

const file = (name: string, kind: CaseFile["kind"] = "source"): CaseFile => ({ id: name, caseId: "c", kind, name, contentType: "", size: 1, createdAt: 0 })

test("表のファイルが届いていない（PDF だけ）案件だけを、AI に一から表を作らせる案件にする", () => {
  expect(onlyNonSheetSources([file("a.pdf")])).toBe(true)
  // 変換の元をまだ選んでいない表のファイルがあれば PDF だけではない
  expect(onlyNonSheetSources([file("a.pdf"), file("b.xlsx")])).toBe(false)
  // 届いたファイルが無ければ作れない。届いたファイル以外（記入用Excel など）は数えない
  expect(onlyNonSheetSources([])).toBe(false)
  expect(onlyNonSheetSources([file("c.xlsx", "inquiry_sheet")])).toBe(false)
  expect(onlyNonSheetSources([file("a.pdf"), file("c.xlsx", "edit_sheet")])).toBe(true)
})

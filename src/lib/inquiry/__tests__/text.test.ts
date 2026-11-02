import { describe, expect, test } from "bun:test"
import { kojiRow } from "../../convert/__tests__/helpers"
import { ADDRESSEE_PLACEHOLDER, countsByItem, DEFAULT_SUBJECT, inquiryEmail } from "../email"
import { ASKED_HEADER, collectInquiries, inquirySheet, MANAGEMENT_HEADER, outsideCells, QUESTION_HEADER, type CellInquiry } from "../inquiry"
import { applyInquiryChange, diffInquiryText, EMPTY_INQUIRY_TEXT, inquiryTextDiffSchema, inquiryTextSchema, otherCustomerTest, revertInquiryText } from "../text"
import type { SheetGrid } from "../../convert/plan"

const full = { gyoshu: "8", client: "株式会社テスト", motoukeShitauke: "1", jv: "0", workName: "テストビル電気工事", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", amount: "5000", specialAmount: "0", startYm: "202404", endYm: "202409" }
const guessedEnd = (n: number) => {
  const r = kojiRow({ ...full, workName: `テスト工事${n}` }, n)
  r.cells.endYm = { value: "202409", status: "warning", source: "J列", original: "", message: "引渡日から推定", guessed: true }
  return r
}
const rows = [guessedEnd(2), guessedEnd(3), kojiRow({ ...full, engineer: "" }, 4), kojiRow({ ...full, engineer: "", prefecture: "", place: "" }, 5)]
const qs = collectInquiries(rows, { tax: "unknown" })
const cells = qs.filter((q): q is CellInquiry => q.kind === "cell")
/** 添付の Excel の項目ごとの数（合計は askCount と同じ） */
const ITEMS = [
  { label: "完成年月", count: 2 },
  { label: "工事場所", count: 1 },
  { label: "配置技術者", count: 2 },
]

describe("メールの件名と前置き", () => {
  test("承認した件名と前置きを使い、無ければ決まった文。前の作業の質問の文（questions）は読み捨てる", () => {
    const text = applyInquiryChange(EMPTY_INQUIRY_TEXT, { kind: "inquiryMail", subject: "工事経歴書のご確認", intro: "資料ありがとうございました。いくつか教えてください。" })
    const mail = inquiryEmail(qs, { kind: "marked", askCount: 5, byItem: ITEMS, hints: [] }, text)
    expect(mail.subject).toBe("工事経歴書のご確認")
    expect(mail.body).toContain("資料ありがとうございました。")
    expect(inquiryEmail(qs, { kind: "marked", askCount: 5, byItem: ITEMS, hints: [] }, EMPTY_INQUIRY_TEXT).subject).toBe(DEFAULT_SUBJECT)
    const legacy = { subject: "件名", intro: null, questions: [{ id: "a", text: "前の質問", targets: [{ field: "engineer" }], by: "ai" }] }
    expect(inquiryTextSchema.parse(legacy)).toEqual({ subject: "件名", intro: null })
  })

  test("本文は宛名・税込税抜の質問・添付の Excel の色付きの欄の件数と項目ごとの内訳（合計は件数と同じ）だけ（質問の文は書かない）。印付きと記入用Excelで添える注意が違う", () => {
    const marked = inquiryEmail(qs, { kind: "marked", askCount: 5, byItem: ITEMS, hints: ["メモの付いた欄は資料から推定した値です。"] }, EMPTY_INQUIRY_TEXT).body
    expect(marked).toContain(`${ADDRESSEE_PLACEHOLDER} 様`)
    expect(marked).toContain("1. いただいた資料の請負代金は、税込・税抜のどちらでしょうか。")
    expect(marked).toContain("2. 添付のExcel（お預かりした表に色を付けたもの）の色付きの欄にご記入ください（5件）。")
    expect(marked).toContain("完成年月 2件、工事場所 1件、配置技術者 2件")
    expect(marked).toContain("行や列の並びは変えずに")
    expect(marked).not.toContain("管理番号")
    const sheet = inquiryEmail(qs, { kind: "sheet", askCount: 5, byItem: ITEMS, hints: [] }, EMPTY_INQUIRY_TEXT).body
    expect(sheet).toContain("2. 添付のExcelの色付きの欄にご記入ください（5件）。")
    expect(sheet).toContain("「管理番号」の列は照合に使います")
  })

  test("項目ごとの件数は工事の数（工事場所の都道府県と場所名は1件）。記入用Excelの欄の順", () => {
    expect(countsByItem(qs)).toEqual([
      { label: "完成年月", count: 2 },
      { label: "工事場所", count: 1 },
      { label: "配置技術者", count: 2 },
    ])
  })

  test("取り消しは、承認のあとに職員が直していなければ件名・前置きを前に戻す。前の記録の質問の文の違いは読み捨てる", () => {
    const after = { subject: "AI の件名", intro: "AI の前置き" }
    const diff = diffInquiryText(EMPTY_INQUIRY_TEXT, after)!
    expect(revertInquiryText(after, diff)).toEqual({ text: EMPTY_INQUIRY_TEXT, reverted: 2, kept: 0 })
    expect(revertInquiryText({ ...after, intro: "職員が直した" }, diff)).toEqual({ text: { subject: null, intro: "職員が直した" }, reverted: 1, kept: 1 })
    expect(inquiryTextDiffSchema.parse({ questions: [["a", null, null]] })).toBeUndefined()
  })

  test("ほかの顧客の名前は、会社の種類・空白・全角半角の違いを除いて見つける（3文字に満たない名前は見ない）", () => {
    const has = otherCustomerTest(["株式会社サンプル建設", "ＡＢ"])
    expect(has("サンプル建設様の工事と同じく、引渡日でよいですか。")).toBe(true)
    expect(has("サンプル 建設")).toBe(true)
    expect(has("ABの工事")).toBe(false)
    expect(has("この工事は引渡日を完成日としてよいですか。")).toBe(false)
    // この案件の顧客の名前の中にほかの顧客の名前があっても断らない
    expect(otherCustomerTest(["株式会社サンプル建設"], "サンプル建設工業")("サンプル建設工業様 工事経歴書のご確認")).toBe(false)
    const own = otherCustomerTest(["株式会社サンプル建設工業本社"], "サンプル建設")
    expect(own("サンプル建設工業本社様と同じ件")).toBe(true)
    expect(own("サンプル建設様の工事経歴書")).toBe(false)
  })
})

describe("記入用Excel（質問の欄は作らない）", () => {
  test("質問の欄は無く、推定の値のセルには確かめのメモを付ける", () => {
    const sheet = inquirySheet(rows, cells)
    expect(sheet.columns.map((c) => c.header)).not.toContain(QUESTION_HEADER)
    const endCol = sheet.columns.findIndex((c) => c.header === "完成年月")
    expect(sheet.rows[0]!.cells[endCol]!.note).toBe("推定です（「2024年9月」と読みました）。正しいか確認し、違えば書き直してください")
    expect(sheet.hints.some((h) => h.startsWith("メモの付いた欄"))).toBe(true)
  })

  test("前に送った記入用Excel（「ご質問」の欄あり）が返ってきたら、書き足しは欄の外の記入として数え、空にしただけなら数えない", () => {
    const asked = JSON.stringify({ asked: [{ field: "engineer", reason: "missing", current: "" }], question: "前の質問" })
    const header = [MANAGEMENT_HEADER, QUESTION_HEADER, "配置技術者", ASKED_HEADER]
    const grid = (question: string): SheetGrid[] => [{ name: "記入用", rows: [header, [rows[2]!.key, question, "", asked]], hidden: [] }]
    expect(outsideCells(grid("前の質問"), rows)).toBe(0)
    expect(outsideCells(grid("前の質問\nはい、引渡日で結構です"), rows)).toBe(1)
    expect(outsideCells(grid(""), rows)).toBe(0)
  })
})

import { describe, expect, test } from "bun:test"
import { kojiRow } from "../../convert/__tests__/helpers"
import { ADDRESSEE_PLACEHOLDER, inquiryEmail } from "../email"
import { collectInquiries, inquiryKey, inquirySheet, outsideCells, type CellInquiry, type Inquiry } from "../inquiry"
import { addQuestions, applyInquiryChanges, checkQuestions, editQuestion, EMPTY_INQUIRY_TEXT, inquiryTextSchema, MAX_QUESTION_KEYS, MAX_QUESTIONS, otherCustomerTest, questionGroups, type InquiryText } from "../text"
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

const aiText: InquiryText = applyInquiryChanges(EMPTY_INQUIRY_TEXT, "p1", [
  { index: 0, change: { kind: "inquiry", text: "この工事は引渡日を完成日としてよいですか。", targets: [{ field: "endYm", reason: "needsReview" }] } },
  { index: 1, change: { kind: "inquiry", text: "この工事に置いた主任技術者の氏名を教えてください。", targets: [{ field: "engineer" }] } },
  { index: 2, change: { kind: "inquiryMail", subject: "工事経歴書のご確認", intro: "資料ありがとうございました。いくつか教えてください。" } },
])

const textsOf = (t: InquiryText) => questionGroups(qs, t).groups.map((g) => [g.by, g.text, g.inquiries.map(inquiryKey)])

describe("質問の文のまとまり", () => {
  test("文が無ければ、同じ欄・同じ理由の問い合わせを決まった文でまとめる（工事場所は都道府県と場所名で1つ）", () => {
    expect(textsOf(EMPTY_INQUIRY_TEXT)).toEqual([
      ["fixed", "いただいた資料の請負代金は、税込・税抜のどちらでしょうか。", ["case:tax"]],
      ["fixed", "完成年月は資料から推定しました。正しいかご確認ください。", ["s!2:endYm", "s!3:endYm"]],
      ["fixed", "資料に配置技術者が見当たりませんでした。ご記入ください。", ["s!4:engineer", "s!5:engineer"]],
      ["fixed", "資料に工事場所が見当たりませんでした。ご記入ください。", ["s!5:prefecture", "s!5:place"]],
    ])
  })

  test("承認した AI の質問は当てはまる問い合わせの文になり、残りは決まった文。メールの件名・前置きも使う", () => {
    expect(textsOf(aiText)).toEqual([
      ["fixed", "いただいた資料の請負代金は、税込・税抜のどちらでしょうか。", ["case:tax"]],
      ["ai", "この工事は引渡日を完成日としてよいですか。", ["s!2:endYm", "s!3:endYm"]],
      ["ai", "この工事に置いた主任技術者の氏名を教えてください。", ["s!4:engineer", "s!5:engineer"]],
      ["fixed", "資料に工事場所が見当たりませんでした。ご記入ください。", ["s!5:prefecture", "s!5:place"]],
    ])
    expect(aiText.questions.map((q) => q.id)).toEqual(["p1:0", "p1:1"])
    const { groups, groupOf } = questionGroups(qs, aiText)
    const sheet = inquirySheet(rows, cells, (q) => groupOf.get(inquiryKey(q))!.text)
    const col = sheet.columns.findIndex((c) => c.header === "ご質問")
    expect(sheet.rows.map((r) => r.cells[col]!.value)).toEqual([
      "この工事は引渡日を完成日としてよいですか。",
      "この工事は引渡日を完成日としてよいですか。",
      "この工事に置いた主任技術者の氏名を教えてください。",
      "資料に工事場所が見当たりませんでした。ご記入ください。\nこの工事に置いた主任技術者の氏名を教えてください。",
    ])
    const mail = inquiryEmail(groups, sheet, aiText)
    expect(mail.subject).toBe("工事経歴書のご確認")
    expect(mail.body.startsWith(`${ADDRESSEE_PLACEHOLDER} 様`)).toBe(true)
    expect(mail.body).toContain("資料ありがとうございました。いくつか教えてください。")
    expect(mail.body).toContain("　・この工事は引渡日を完成日としてよいですか。（2件）")
    expect(mail.body).toContain("　・資料に工事場所が見当たりませんでした。ご記入ください。（1件）")
  })

  test("keys で選んだ行は、項目だけ・項目と理由の質問より強い。同じ強さなら後の質問", () => {
    const t = addQuestions(aiText, [
      { id: "k", text: "この工事の技術者はどなたですか。", targets: [{ field: "engineer", keys: ["s!5"] }], by: "ai" },
      { id: "later", text: "完成年月をご確認ください。", targets: [{ field: "endYm", reason: "needsReview" }], by: "ai" },
    ])
    const { groupOf } = questionGroups(qs, t)
    expect(groupOf.get("s!5:engineer")!.text).toBe("この工事の技術者はどなたですか。")
    expect(groupOf.get("s!4:engineer")!.text).toBe("この工事に置いた主任技術者の氏名を教えてください。")
    expect(groupOf.get("s!2:endYm")!.text).toBe("完成年月をご確認ください。")
  })

  test("職員は文を直せる。AI の文を直すと職員の文、空にすると決まった文に戻る。決まった文を直すと同じ欄・理由の職員の質問になる", () => {
    const { groups } = questionGroups(qs, aiText)
    const edited = editQuestion(aiText, groups[1]!, "引渡日を完成日にしてよいですか。", "x")
    expect(textsOf(edited)[1]).toEqual(["staff", "引渡日を完成日にしてよいですか。", ["s!2:endYm", "s!3:endYm"]])
    expect(textsOf(editQuestion(aiText, groups[1]!, "  ", "x"))[1]![0]).toBe("fixed")
    const place = editQuestion(aiText, groups[3]!, "工事の場所（市区町村まで）を教えてください。", "s1")
    expect(place.questions.at(-1)).toEqual({ id: "s1", text: "工事の場所（市区町村まで）を教えてください。", targets: [{ field: "prefecture", reason: "missing" }, { field: "place", reason: "missing" }], by: "staff" })
    expect(textsOf(place)[3]).toEqual(["staff", "工事の場所（市区町村まで）を教えてください。", ["s!5:prefecture", "s!5:place"]])
    // 決まった文を直しても、ほかの質問の問い合わせは取らない（まとまりにある項目と理由だけ）
    const prefOnly = addQuestions(EMPTY_INQUIRY_TEXT, [{ id: "pref", text: "都道府県を教えてください。", targets: [{ field: "prefecture" }], by: "ai" }])
    const placeGroup = questionGroups(qs, prefOnly).groups.find((g) => g.id === "fixed:工事場所（都道府県・市区町村）:missing")!
    const staffPlace = editQuestion(prefOnly, placeGroup, "市区町村を教えてください。", "s3")
    expect(staffPlace.questions.at(-1)!.targets).toEqual([{ field: "place", reason: "missing" }])
    expect(questionGroups(qs, staffPlace).groupOf.get("s!5:prefecture")!.text).toBe("都道府県を教えてください。")
    const tax = editQuestion(aiText, groups[0]!, "金額は税込ですか、税抜ですか。", "s2")
    expect(questionGroups(qs, tax).groupOf.get("case:tax")!.text).toBe("金額は税込ですか、税抜ですか。")
  })

  test("問い合わせが減っても、残った問い合わせにそのまま使う（答えた行の質問は出ない）", () => {
    const left: Inquiry[] = qs.filter((q) => inquiryKey(q) !== "s!2:endYm")
    expect(questionGroups(left, aiText).groupOf.get("s!3:endYm")!.text).toBe("この工事は引渡日を完成日としてよいですか。")
  })

  test("質問の数には上限があり、古いものから捨てる。保存の形は zod で確かめる", () => {
    const many = Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({ id: `q${i}`, text: `質問${i}`, targets: [{ field: "engineer" as const }], by: "ai" as const }))
    const t = addQuestions(EMPTY_INQUIRY_TEXT, many)
    expect(t.questions.length).toBe(MAX_QUESTIONS)
    expect(t.questions[0]!.id).toBe("q3")
    expect(inquiryTextSchema.safeParse(t).success).toBe(true)
    expect(inquiryTextSchema.safeParse({ ...t, questions: [{ ...many[0]!, text: "あ".repeat(201) }] }).success).toBe(false)
    // keys の行が多い質問は、合わせて上限を超えたら古いものから捨てる（作業の大きさを抑える）
    const keyed = (id: string) => ({ id, text: id, targets: [{ field: "engineer" as const, keys: Array.from({ length: MAX_QUESTION_KEYS }, (_, i) => `r${i}`) }], by: "ai" as const })
    const k = addQuestions(EMPTY_INQUIRY_TEXT, [keyed("a"), keyed("b"), keyed("c")])
    expect(k.questions.map((q) => q.id)).toEqual(["b", "c"])
    expect(inquiryTextSchema.safeParse(k).success).toBe(true)
  })
})

describe("AI の質問の確かめ", () => {
  test("今の問い合わせに当てはまらない対象・聞いていない行の key・同じ強さの重なりは problems。covered と決まった文のまま残る数を返す", () => {
    expect(checkQuestions([{ targets: [{ field: "endYm", reason: "needsReview" }] }, { targets: [{ field: "engineer" }] }], qs)).toEqual({ problems: [], covered: 4, fallback: 3 })
    expect(checkQuestions([{ targets: [{ field: "startYm" }] }], qs).problems).toEqual(["questions[0].targets[0]: 今の問い合わせに当てはまりません"])
    expect(checkQuestions([{ targets: [{ field: "engineer", keys: ["s!4", "s!2"] }] }], qs).problems).toEqual(["questions[0].targets[0]: 聞いていない行の key があります（s!2）"])
    expect(checkQuestions([{ targets: [{ field: "engineer" }] }, { targets: [{ field: "engineer" }] }], qs).problems[0]).toContain("同じ問い合わせに2つの質問が当てはまります（s!4:engineer, s!5:engineer）")
    expect(checkQuestions([{ targets: [{ topic: "tax" }, { field: "engineer" }] }], qs).problems).toEqual(["questions[0]: 税込・税抜の質問は、ほかの問い合わせとまとめずに1つの質問にしてください"])
    // keys の質問は項目だけの質問より強いので重ならない
    expect(checkQuestions([{ targets: [{ field: "engineer" }] }, { targets: [{ field: "engineer", keys: ["s!5"] }] }], qs).problems).toEqual([])
  })

  test("ほかの顧客の名前は、会社の種類・空白・全角半角の違いを除いて見つける（3文字に満たない名前は見ない）", () => {
    const has = otherCustomerTest(["株式会社サンプル建設", "ＡＢ"])
    expect(has("サンプル建設様の工事と同じく、引渡日でよいですか。")).toBe(true)
    expect(has("サンプル 建設")).toBe(true)
    expect(has("ABの工事")).toBe(false)
    expect(has("この工事は引渡日を完成日としてよいですか。")).toBe(false)
    // この案件の顧客の名前の中にほかの顧客の名前があっても断らない
    expect(otherCustomerTest(["株式会社サンプル建設"], "サンプル建設工業")("サンプル建設工業様 工事経歴書のご確認")).toBe(false)
  })
})

describe("ご質問の欄への書き足し", () => {
  const { groupOf } = questionGroups(qs, aiText)
  const sheet = inquirySheet(rows, cells, (q) => groupOf.get(inquiryKey(q))!.text)
  const header = sheet.columns.map((c) => c.header)
  const grid = (edit: (row: number, col: number, v: string) => string): SheetGrid[] => [{ name: "記入用", rows: [header, ...sheet.rows.map((r, ri) => r.cells.map((c, ci) => edit(ri, ci, c.value)))], hidden: [] }]

  test("書いた文のままなら欄の外の記入として数えず、書き足していれば数える（AI で読む候補）", () => {
    const col = header.indexOf("ご質問")
    expect(outsideCells(grid((_, __, v) => v), rows)).toBe(0)
    expect(outsideCells(grid((r, c, v) => (r === 0 && c === col ? `${v}\nはい、引渡日で結構です` : v)), rows)).toBe(1)
    // 今のデータに無い行の質問の欄は数えない（取り込みが知らない管理番号として出す）
    expect(outsideCells(grid((_, __, v) => v), rows.slice(1))).toBe(0)
  })
})

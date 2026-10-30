import { OFFICE_NAME } from "../constants"
import { QUESTION_HEADER, type InquirySheet } from "./inquiry"
import { groupCount, type InquiryText, type QuestionGroup } from "./text"

/** 宛名の差し込み位置（職員が書き換える） */
export const ADDRESSEE_PLACEHOLDER = "〇〇〇〇"

/** 決まった件名・前置き（AI の文も職員の文も無いとき） */
export const DEFAULT_SUBJECT = `工事経歴書の作成についてのご確認（${OFFICE_NAME}）`
export const DEFAULT_INTRO = [
  "工事経歴書の作成にあたり、お預かりした資料だけでは分からない点がございましたので、",
  "お手数をおかけしますが、以下についてご教示いただけますでしょうか。",
].join("\n")

/**
 * 顧客への問い合わせメールの件名と本文。groups は質問の文のまとまり（text.ts の questionGroups）。案件全体の質問は1つずつ、
 * セルの質問はまとまりごとに件数を添え、記入用Excelへの記入のお願いにまとめる。宛名・挨拶・記入のしかた・結びは決まった文
 */
export function inquiryEmail(groups: readonly QuestionGroup[], sheet: InquirySheet, text: Pick<InquiryText, "subject" | "intro">): { subject: string; body: string } {
  const sections: string[] = []
  const cases = groups.filter((g) => g.inquiries.some((q) => q.kind === "case"))
  cases.forEach((g, i) => sections.push(`${i + 1}. ${g.text}`))
  if (sheet.askCount > 0) {
    const cells = groups.flatMap((g) => (g.inquiries.some((q) => q.kind === "cell") ? [`　・${g.text}（${groupCount(g)}件）`] : []))
    sections.push(
      [
        `${cases.length + 1}. 添付のExcelの色付きの欄にご記入ください（${sheet.askCount}件）。行ごとの質問は「${QUESTION_HEADER}」の欄にあります。`,
        ...cells,
        ...sheet.hints.map((h) => `　※${h}`),
        "　※「管理番号」の列は照合に使いますので、消したり書き換えたりしないでください。",
        "　※分からない欄は空欄のままで構いません。",
      ].join("\n"),
    )
  }
  const body = [
    `${ADDRESSEE_PLACEHOLDER} 様`,
    "",
    `いつもお世話になっております。${OFFICE_NAME}でございます。`,
    text.intro ?? DEFAULT_INTRO,
    "",
    ...sections.flatMap((s) => [s, ""]),
    "ご不明な点がございましたら、お気軽にお問い合わせください。",
    "どうぞよろしくお願いいたします。",
    "",
    OFFICE_NAME,
  ].join("\n")
  return { subject: text.subject ?? DEFAULT_SUBJECT, body }
}

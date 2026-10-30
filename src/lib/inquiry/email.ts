import { OFFICE_NAME } from "../constants"
import { CASE_TOPICS, type CaseInquiry, type InquirySheet } from "./inquiry"

/** 宛名の差し込み位置（職員が書き換える） */
export const ADDRESSEE_PLACEHOLDER = "〇〇〇〇"

/** 顧客への問い合わせメールの文面。案件単位の質問と、記入用Excelへの記入のお願い */
export function inquiryEmail(cases: readonly CaseInquiry[], sheet: InquirySheet): string {
  const sections: string[] = []
  cases.forEach((q, i) => sections.push(`${i + 1}. ${CASE_TOPICS[q.topic].question}`))
  if (sheet.askCount > 0) {
    const counts = sheet.columns
      .map((c, i) => ({ header: c.header, n: sheet.rows.filter((r) => r.cells[i]!.ask).length }))
      .filter((c) => c.n > 0)
      .map((c) => `　・${c.header}：${c.n}件`)
    sections.push(
      [
        `${cases.length + 1}. 添付のExcelの色付きの欄にご記入ください（${sheet.askCount}件）。`,
        ...counts,
        ...sheet.hints.map((h) => `　※${h}`),
        "　※「管理番号」の列は照合に使いますので、消したり書き換えたりしないでください。",
        "　※分からない欄は空欄のままで構いません。",
      ].join("\n"),
    )
  }
  return [
    `${ADDRESSEE_PLACEHOLDER} 様`,
    "",
    `いつもお世話になっております。${OFFICE_NAME}でございます。`,
    "工事経歴書の作成にあたり、お預かりした資料だけでは分からない点がございましたので、",
    "お手数をおかけしますが、以下についてご教示いただけますでしょうか。",
    "",
    ...sections.flatMap((s) => [s, ""]),
    "ご不明な点がございましたら、お気軽にお問い合わせください。",
    "どうぞよろしくお願いいたします。",
    "",
    OFFICE_NAME,
  ].join("\n")
}

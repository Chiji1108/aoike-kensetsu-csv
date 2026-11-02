import { OFFICE_NAME } from "../constants"
import { askLabel, CASE_TOPICS, columnOf, SHEET_COLUMNS, type Inquiry, type SheetColumn } from "./inquiry"
import type { InquiryText } from "./text"

/** 宛名の差し込み位置（職員が書き換える） */
export const ADDRESSEE_PLACEHOLDER = "〇〇〇〇"

/** 決まった件名・前置き（AI の文も職員の文も無いとき） */
export const DEFAULT_SUBJECT = `工事経歴書の作成についてのご確認（${OFFICE_NAME}）`
export const DEFAULT_INTRO = [
  "工事経歴書の作成にあたり、お預かりした資料だけでは分からない点がございましたので、",
  "お手数をおかけしますが、以下についてご教示いただけますでしょうか。",
].join("\n")

/**
 * 添付する Excel。marked: 顧客の元の Excel に色とメモを付けたもの（印付き）。sheet: こちらの形の記入用Excel。
 * askCount は記入してほしい欄の数、byItem はその項目ごとの内訳（合計は askCount。marked.ts）、hints は記入のしかた（inquiry.ts の answerHints）
 */
export type InquiryAttachment = { kind: "marked" | "sheet"; askCount: number; byItem: readonly { label: string; count: number }[]; hints: readonly string[] }

/** 項目ごとの、聞く工事の数（工事場所の都道府県と場所名は1件。並びは記入用Excelの欄の順） */
export function countsByItem(inquiries: readonly Inquiry[]): { label: string; count: number }[] {
  const rows = new Map<SheetColumn, Set<string>>()
  for (const q of inquiries) {
    const column = q.kind === "cell" ? columnOf(q.field) : undefined
    if (q.kind === "cell" && column) rows.set(column, (rows.get(column) ?? new Set()).add(q.rowKey))
  }
  return [...rows]
    .sort(([a], [b]) => SHEET_COLUMNS.indexOf(a) - SHEET_COLUMNS.indexOf(b))
    .map(([column, keys]) => ({ label: askLabel(column.fields[0]!), count: keys.size }))
}

/**
 * 顧客への問い合わせメールの件名と本文。案件全体の質問（税込・税抜）は1つずつ、セルの問い合わせは添付の Excel への記入のお願いに
 * まとめ、項目ごとの件数だけを添える（何を書くかは色付きのセルとメモで伝わる）。宛名・挨拶・記入のしかた・結びは決まった文
 */
export function inquiryEmail(inquiries: readonly Inquiry[], attachment: InquiryAttachment, text: InquiryText): { subject: string; body: string } {
  const sections: string[] = []
  const cases = inquiries.flatMap((q) => (q.kind === "case" ? [CASE_TOPICS[q.topic].question] : []))
  cases.forEach((t, i) => sections.push(`${i + 1}. ${t}`))
  if (attachment.askCount > 0) {
    const what = attachment.kind === "marked" ? "添付のExcel（お預かりした表に色を付けたもの）" : "添付のExcel"
    sections.push(
      [
        `${cases.length + 1}. ${what}の色付きの欄にご記入ください（${attachment.askCount}件）。`,
        `　${attachment.byItem.map((c) => `${c.label} ${c.count}件`).join("、")}`,
        ...attachment.hints.map((h) => `　※${h}`),
        attachment.kind === "marked"
          ? "　※行や列の並びは変えずに、色付きの欄に書き込んでください。"
          : "　※「管理番号」の列は照合に使いますので、消したり書き換えたりしないでください。",
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

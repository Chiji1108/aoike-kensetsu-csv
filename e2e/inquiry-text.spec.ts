import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test, type Page } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatChange, Proposal } from "../src/lib/chat/proposals"
import { INQUIRY_TEXT_PROMPT } from "../src/lib/inquiry/text"
import { callsServerFn, deleteCustomer, openNewCase, openTab } from "./helpers"

/**
 * 問い合わせの文面: 問い合わせの欄を開くとチャットに「AI で文面を作る」が出る → 押すと決まった指示を送る → 質問の文とメールの下書きの変更案を承認すると、
 * 欄の質問の文・件名・前置き・メールの本文が変わる → 承認を取り消すと決まった文に戻る → 職員が文を直すと記入用Excelの「ご質問」の欄に出る。
 * 列の対応は見出しからの推定にし（計画の AI を断る）、チャットは決まった返事にする
 */

const FIXTURE = new URL("../fixtures/sample-inquiry.xlsx", import.meta.url).pathname

const created: string[] = []
const pageErrors: string[] = []
test.beforeEach(({ page }) => {
  pageErrors.length = 0
  page.on("pageerror", (e) => pageErrors.push(e.message))
})
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" })
  for (const customer of created.splice(0)) await deleteCustomer(page, customer)
  expect(pageErrors).toEqual([])
})

/** チャットのサーバーの代わりに、変更案を1つ付けた決まった返事を返す。届いた指示の本文を texts に、外した問い合わせを dismissed に溜める */
async function fakeChat(page: Page, changes: ChatChange[], texts: string[], dismissed: string[][] = []) {
  await page.unroute("**/api/cases/*/chat")
  await page.route("**/api/cases/*/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON() as { id: string; text: string; table: { dismissed: string[] } }
    texts.push(body.text)
    dismissed.push(body.table.dismissed)
    const proposal: Proposal = { id: `p-${Date.now()}`, origin: { kind: "chat", messageId: body.id }, question: null, state: "open", count: changes.length, applied: [], rejected: [] }
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: `a-${Date.now()}` })
        writer.write({ type: "text-start", id: "t" })
        writer.write({ type: "text-delta", id: "t", delta: "問い合わせを1つの質問にまとめ、メールの下書きを付けました。" })
        writer.write({ type: "text-end", id: "t" })
        writer.write({ type: "data-proposal", data: { id: proposal.id } })
        writer.write({ type: "data-proposal-content", data: { proposal, changes }, transient: true })
        writer.write({ type: "message-metadata", messageMetadata: { usd: 0.01, caseUsd: 0.1, ms: 1000, inputTokens: 1, outputTokens: 1, toolCalls: 2 } })
        writer.write({ type: "finish" })
      },
    })
    const res = createUIMessageStreamResponse({ stream })
    await route.fulfill({ status: 200, headers: Object.fromEntries(res.headers), body: await res.text() })
  })
}

/** 記入用Excelをダウンロードし、「ご質問」の欄の値を管理番号ごとに読む */
async function questionColumn(page: Page) {
  const downloading = page.waitForEvent("download")
  await page.getByTestId("download-inquiry-xlsx").click()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync((await (await downloading).path())!).buffer as ArrayBuffer)
  const ws = wb.worksheets[0]!
  let headerRow = 0
  ws.eachRow((r, n) => {
    if (!headerRow && (r.values as unknown[]).includes("管理番号")) headerRow = n
  })
  const header = (ws.getRow(headerRow).values as unknown[]).map(String)
  const out = new Map<string, string>()
  for (let n = headerRow + 1; n <= ws.rowCount; n++) out.set(String(ws.getRow(n).getCell(header.indexOf("管理番号")).value), String(ws.getRow(n).getCell(header.indexOf("ご質問")).value ?? ""))
  return out
}

const AI_TEXT = "この工事に置いた主任技術者（または監理技術者）の氏名を教えてください。"
const STAFF_TEXT = "この工事の主任技術者の氏名をご記入ください。"
const MAIL = { subject: "工事経歴書のご確認（合成）", intro: "資料をお送りいただきありがとうございました。いくつか教えてください。" }

test("AI の質問の文とメールの下書きを承認すると問い合わせの欄とメールに使い、取り消すと決まった文に戻る。職員が直した文は記入用Excelの「ご質問」の欄に出る", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")

  await openTab(page, "inquiry")
  const engineerKeys = (await page.locator('[data-testid="inquiry-list"] tr[data-inquiry$=":engineer"]').evaluateAll((rs) => rs.map((r) => r.getAttribute("data-inquiry")!))).map((k) => k.slice(0, -":engineer".length))
  expect(engineerKeys.length).toBeGreaterThan(0)
  const questions = page.getByTestId("inquiry-question")
  const engineerQuestion = page.locator('[data-testid="inquiry-question"][data-group="fixed:配置技術者:missing"]')
  await expect(questions.first()).toBeVisible()
  await expect(page.locator('[data-testid="inquiry-question"]:not([data-by="fixed"])')).toHaveCount(0)
  await expect(page.getByTestId("inquiry-subject")).toHaveValue("工事経歴書の作成についてのご確認（行政書士青池事務所）")

  const texts: string[] = []
  await fakeChat(page, [{ kind: "inquiry", id: "q-ai-1", text: AI_TEXT, targets: [{ field: "engineer" }] }, { kind: "inquiryMail", ...MAIL }], texts)
  const suggestion = page.locator('[data-testid="chat-suggestion"][data-suggestion="inquiry-text"]')

  await test.step("チャットの「AI で文面を作る」で指示を送り、変更案を承認すると欄の文・件名・前置き・本文が変わる", async () => {
    await expect(suggestion).toContainText("AI で文面を作る")
    await suggestion.getByTestId("chat-suggestion-send").click()
    const proposal = page.getByTestId("proposal")
    await expect(proposal).toBeVisible()
    expect(texts).toEqual([INQUIRY_TEXT_PROMPT])
    await expect(proposal).toContainText("問い合わせの文 1・メールの下書き")
    await proposal.getByTestId("proposal-apply-all").click()
    await expect(page.getByTestId("proposal-closed")).toHaveText("変更案: 反映 2 件・却下 0 件")
    await expect(page.locator('[data-testid="inquiry-question"][data-by="ai"] textarea')).toHaveValue(AI_TEXT)
    await expect(page.getByTestId("inquiry-subject")).toHaveValue(MAIL.subject)
    await expect(page.getByTestId("inquiry-intro")).toHaveValue(MAIL.intro)
    await expect(page.getByTestId("inquiry-email")).toHaveValue(new RegExp(`${MAIL.intro}[\\s\\S]*・${AI_TEXT.replace(/[()（）]/g, ".")}（${engineerKeys.length}件）`))
    // 承認した文面が出ている間は、もう案内しない
    await expect(suggestion).toHaveCount(0)
    const sheet = await questionColumn(page)
    expect(sheet.get(engineerKeys[0]!)).toContain(AI_TEXT)
  })

  await test.step("承認を取り消すと決まった文と決まった件名に戻る", async () => {
    await page.getByTestId("proposal-undo").click()
    await expect(page.locator('[data-testid="inquiry-question"][data-by="ai"]')).toHaveCount(0)
    await expect(page.getByTestId("inquiry-subject")).toHaveValue("工事経歴書の作成についてのご確認（行政書士青池事務所）")
    await expect(page.getByTestId("inquiry-email")).not.toHaveValue(new RegExp(MAIL.intro))
  })

  await test.step("職員が決まった文を直すと「直した文」になり、記入用Excelの「ご質問」の欄とメールに出る", async () => {
    const box = engineerQuestion.locator("textarea")
    await expect(box).toHaveValue("資料に配置技術者が見当たりませんでした。ご記入ください。")
    await box.fill(STAFF_TEXT)
    await box.blur()
    await expect(page.locator('[data-testid="inquiry-question"][data-by="staff"] textarea')).toHaveValue(STAFF_TEXT)
    await expect(page.getByTestId("inquiry-email")).toHaveValue(new RegExp(`・${STAFF_TEXT}（${engineerKeys.length}件）`))
    const sheet = await questionColumn(page)
    for (const k of engineerKeys) expect(sheet.get(k)).toContain(STAFF_TEXT)
  })

  await test.step("外した問い合わせはチャットに送る。作り直した AI の案を承認しても、職員が直した文は上書きせず「AI の文あり」と出す", async () => {
    await page.getByText(/問い合わせの一覧/).click()
    const first = page.locator('[data-testid="inquiry-list"] tr[data-inquiry]').first()
    const key = (await first.getAttribute("data-inquiry"))!
    await first.getByRole("checkbox").uncheck()
    const sentDismissed: string[][] = []
    await fakeChat(page, [{ kind: "inquiry", id: "q-ai-2", text: "作り直した技術者の質問です。", targets: [{ field: "engineer" }] }], texts, sentDismissed)
    await page.getByTestId("chat-input").fill("問い合わせの文面を作り直して")
    await page.getByTestId("chat-send").click()
    const proposal = page.getByTestId("proposal").last()
    await expect(proposal.getByTestId("proposal-apply-all")).toBeVisible()
    expect(sentDismissed.at(-1)).toContain(key)
    await proposal.getByTestId("proposal-apply-all").click()
    const staff = page.locator('[data-testid="inquiry-question"][data-by="staff"]')
    await expect(staff.locator("textarea")).toHaveValue(STAFF_TEXT)
    await expect(staff.getByTestId("ai-behind")).toBeVisible()
  })

})

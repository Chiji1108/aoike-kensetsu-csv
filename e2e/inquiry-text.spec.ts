import { expect, test, type Page } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatChange, Proposal } from "../src/lib/chat/proposals"
import { INQUIRY_TEXT_PROMPT } from "../src/lib/inquiry/text"
import { callsServerFn, deleteCustomer, openNewCase, openTab } from "./helpers"

/**
 * 問い合わせのメールの下書き: 問い合わせの欄を開くとチャットに「AI でメールの下書きを作る」が出る → 押すと決まった指示を送る → 件名と前置きの変更案を承認すると、
 * 件名・前置き・メールの本文が変わる → 承認を取り消すと決まった文に戻る。質問の文の欄は無く、本文は項目ごとの件数だけ。
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

const MAIL = { subject: "工事経歴書のご確認（合成）", intro: "資料をお送りいただきありがとうございました。いくつか教えてください。" }

test("AI のメールの下書きを承認すると件名・前置き・本文に使い、取り消すと決まった文に戻る。質問の文の欄は無く、本文は項目ごとの件数", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")

  await openTab(page, "inquiry")
  const engineers = await page.locator('[data-testid="inquiry-list"] tr[data-inquiry$=":engineer"]').count()
  expect(engineers).toBeGreaterThan(0)
  await expect(page.getByTestId("inquiry-question")).toHaveCount(0)
  await expect(page.getByTestId("inquiry-subject")).toHaveValue("工事経歴書の作成についてのご確認（行政書士青池事務所）")
  await expect(page.getByTestId("inquiry-email")).toHaveValue(new RegExp(`配置技術者 ${engineers}件`))

  const texts: string[] = []
  const sentDismissed: string[][] = []
  await fakeChat(page, [{ kind: "inquiryMail", ...MAIL }], texts, sentDismissed)
  const suggestion = page.locator('[data-testid="chat-suggestion"][data-suggestion="inquiry-text"]')

  await test.step("外した問い合わせはチャットに送る。「AI でメールの下書きを作る」で指示を送り、変更案を承認すると件名・前置き・本文が変わる", async () => {
    await page.getByText(/問い合わせの一覧/).click()
    const first = page.locator('[data-testid="inquiry-list"] tr[data-inquiry]').last()
    const key = (await first.getAttribute("data-inquiry"))!
    await first.getByRole("checkbox").uncheck()
    await expect(suggestion).toContainText("AI でメールの下書きを作る")
    await suggestion.getByTestId("chat-suggestion-send").click()
    const proposal = page.getByTestId("proposal")
    await expect(proposal).toBeVisible()
    expect(texts).toEqual([INQUIRY_TEXT_PROMPT])
    expect(sentDismissed.at(-1)).toContain(key)
    await expect(proposal).toContainText("メールの下書き")
    await proposal.getByTestId("proposal-apply-all").click()
    await expect(page.getByTestId("proposal-closed")).toHaveText("変更案: 反映 1 件・却下 0 件")
    await expect(page.getByTestId("inquiry-subject")).toHaveValue(MAIL.subject)
    await expect(page.getByTestId("inquiry-intro")).toHaveValue(MAIL.intro)
    await expect(page.getByTestId("inquiry-email")).toHaveValue(new RegExp(MAIL.intro))
    // 承認した文面が出ている間は、もう案内しない
    await expect(suggestion).toHaveCount(0)
  })

  await test.step("承認を取り消すと決まった件名と前置きに戻る", async () => {
    await page.getByTestId("proposal-undo").click()
    await expect(page.getByTestId("inquiry-subject")).toHaveValue("工事経歴書の作成についてのご確認（行政書士青池事務所）")
    await expect(page.getByTestId("inquiry-email")).not.toHaveValue(new RegExp(MAIL.intro))
  })
})

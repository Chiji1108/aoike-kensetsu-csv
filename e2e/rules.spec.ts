import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatMetadata } from "../src/lib/chat/messages"
import { proposalKey, type ChatChange, type Proposal, type ProposalRecord } from "../src/lib/chat/proposals"
import { callsServerFn, convertFixture, deleteCustomer, open, openNewCase, reload } from "./helpers"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname

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

const items = (page: Page, list: string) => page.getByTestId(list).getByTestId("rule-item")
const texts = async (page: Page, list: string) => (await items(page, list).getByTestId("rule-item-text").allTextContents()).map((t) => t.trim())
const item = (page: Page, list: string, text: string) => items(page, list).filter({ has: page.getByTestId("rule-item-text").getByText(text, { exact: true }) })

async function addItem(page: Page, list: string, text: string) {
  await page.getByTestId(list).getByTestId("rule-add-input").fill(text)
  await page.getByTestId(list).getByTestId("rule-add").click()
  await expect(item(page, list, text)).toHaveCount(1)
}

async function editItem(page: Page, list: string, from: string, to: string) {
  const row = item(page, list, from)
  await row.getByTestId("rule-item-edit").click()
  await page.getByTestId(list).getByTestId("rule-item-input").fill(to)
  await page.getByTestId(list).getByTestId("rule-item-save").click()
}

test("全体ルール: 項目を足す・直す・並べ替える・消す。開き直しても残る。7割の計算は選んで保存する", async ({ page }) => {
  await open(page, "/rules")
  const list = "global-rules"
  await expect(items(page, list).first()).toBeVisible()
  const before = await texts(page, list)
  const a = `全体ルールE2E-A-${Date.now()}`
  const b = `全体ルールE2E-B-${Date.now()}`
  await addItem(page, list, a)
  await addItem(page, list, b)
  await editItem(page, list, a, `${a}（直した）`)
  await expect(item(page, list, `${a}（直した）`)).toHaveCount(1)
  await item(page, list, b).getByTestId("rule-item-up").click()
  await expect.poll(() => texts(page, list)).toEqual([...before, b, `${a}（直した）`])
  await expect(item(page, list, b).getByTestId("rule-item-origin")).toHaveText("職員")
  await reload(page)
  await expect.poll(() => texts(page, list)).toEqual([...before, b, `${a}（直した）`])
  for (const t of [b, `${a}（直した）`]) await item(page, list, t).getByTestId("rule-item-delete").click()
  await expect.poll(() => texts(page, list)).toEqual(before)

  await page.getByTestId("rule7-tax-included").click()
  await reload(page)
  await expect(page.getByTestId("rule7-tax-included")).toHaveAttribute("aria-pressed", "true")
  await page.getByTestId("rule7-tax-excluded").click()
  await reload(page)
  await expect(page.getByTestId("rule7-tax-excluded")).toHaveAttribute("aria-pressed", "true")
})

test("足す欄: Enter を続けて押しても1つだけ足し、空なら何も送らない。日本語入力の確定の Enter（keyCode 229）では送らない", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.getByRole("link", { name: customer }).click()
  const list = "customer-rules"
  const input = page.getByTestId(list).getByTestId("rule-add-input")
  let calls = 0
  // 足す処理を遅らせ、返る前に Enter を続けて押す
  await page.route(
    (url) => callsServerFn(url.href, ["addRuleItemFn"]),
    async (route) => {
      calls++
      await new Promise((r) => setTimeout(r, 800))
      await route.fallback()
    },
  )
  await input.fill("備考に「除外」とある行は載せない")
  await input.press("Enter")
  await input.press("Enter")
  await input.press("Enter")
  await expect(items(page, list)).toHaveCount(1)
  expect(calls).toBe(1)

  // 空の欄で Enter: 送らず、エラーも出さない
  await input.fill("   ")
  await input.press("Enter")
  await page.waitForTimeout(300)
  expect(calls).toBe(1)
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)

  // 変換の確定の Enter（Safari は isComposing が false で keyCode 229）
  await input.fill("かんせいねんげつ")
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true })))
  // compositionstart〜end の間の Enter
  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(300)
  expect(calls).toBe(1)
  await input.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })))
  await input.press("Enter")
  await expect(items(page, list)).toHaveCount(2)
  expect(calls).toBe(2)
})

test("顧客ルール: 2つの画面で別の項目を直しても両方残る。同じ項目を後から直すと食い違いを知らせ、黙って上書きしない", async ({ page, context }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.getByRole("link", { name: customer }).click()
  const url = page.url()
  const list = "customer-rules"
  await expect(page.getByTestId(list)).toContainText("まだ項目がありません")
  await addItem(page, list, "備考に「除外」とある行は載せない")
  await addItem(page, list, "完成年月は引渡日")

  const other = await context.newPage()
  await open(other, url)
  await expect(items(other, list)).toHaveCount(2)
  await editItem(page, list, "備考に「除外」とある行は載せない", "備考に「除外」「対象外」とある行は載せない")
  await expect(item(page, list, "備考に「除外」「対象外」とある行は載せない")).toHaveCount(1)
  // もう1つの画面は古い一覧のまま、別の項目を直す
  await editItem(other, list, "完成年月は引渡日", "完成年月は引渡日（無ければ竣工日）")
  await expect(item(other, list, "完成年月は引渡日（無ければ竣工日）")).toHaveCount(1)
  await reload(page)
  await expect.poll(() => texts(page, list)).toEqual(["備考に「除外」「対象外」とある行は載せない", "完成年月は引渡日（無ければ竣工日）"])

  // 同じ項目: 古い一覧のまま直すと断り、今の文章を見せる（入力は残す）
  const third = await context.newPage()
  await open(third, url)
  await editItem(page, list, "完成年月は引渡日（無ければ竣工日）", "完成年月は引渡日")
  await expect(item(page, list, "完成年月は引渡日")).toHaveCount(1)
  await editItem(third, list, "完成年月は引渡日（無ければ竣工日）", "完成年月は竣工日")
  await expect(third.getByTestId("rule-item-conflict")).toContainText("「完成年月は引渡日」に直されました")
  await expect(third.getByTestId(list).getByTestId("rule-item-input")).toHaveValue("完成年月は竣工日")
  await reload(page)
  await expect.poll(() => texts(page, list)).toEqual(["備考に「除外」「対象外」とある行は載せない", "完成年月は引渡日"])
  await other.close()
  await third.close()
})

/** 手元の R2（開発サーバーと同じ .wrangler/state）に変更案の記録を置く（サーバーのチャットが置くのと同じ形。承認はサーバーがここから読む） */
function putProposalRecord(caseId: string, record: ProposalRecord) {
  const file = join(mkdtempSync(join(tmpdir(), "proposal-")), "record.json")
  writeFileSync(file, JSON.stringify(record))
  execFileSync("bunx", ["wrangler", "r2", "object", "put", `aoike-kensetsu-csv-files/${proposalKey(caseId, record.proposal.id)}`, "--local", "--file", file, "--content-type", "application/json"], {
    stdio: ["ignore", "ignore", "inherit"],
  })
}

test("チャットのルールの項目の案を承認すると、顧客ルールに項目として出て、由来（年度の案件でチャットから）が付く", async ({ page }) => {
  const { customer, caseUrl } = await convertFixture(page, FIXTURE)
  created.push(customer)
  const caseId = caseUrl.split("/").at(-1)!
  const rule = `注文者の株式会社は㈱にする（E2E${Date.now()}）`
  const changes: ChatChange[] = [{ kind: "rule", scope: "customer", text: rule }]
  const proposal: Proposal = { id: `rule-${Date.now()}`, origin: { kind: "chat", messageId: "m1" }, question: null, state: "open", count: 1, applied: [], rejected: [] }
  putProposalRecord(caseId, { proposal, changes })
  // チャットのサーバーの代わり（返事と変更案だけ。記録は上で置いた）
  await page.route("**/api/cases/*/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const metadata: ChatMetadata = { usd: 0.01, caseUsd: 0.5, ms: 1000, inputTokens: 100, outputTokens: 10, toolCalls: 1 }
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: "a1" })
        writer.write({ type: "text-start", id: "t" })
        writer.write({ type: "text-delta", id: "t", delta: "顧客ルールに1項目足す案です。" })
        writer.write({ type: "text-end", id: "t" })
        writer.write({ type: "data-proposal", data: { id: proposal.id } })
        writer.write({ type: "data-proposal-content", data: { proposal, changes }, transient: true })
        writer.write({ type: "message-metadata", messageMetadata: metadata })
        writer.write({ type: "finish" })
      },
    })
    const res = createUIMessageStreamResponse({ stream })
    await route.fulfill({ status: 200, headers: Object.fromEntries(res.headers), body: await res.text() })
  })
  await page.getByTestId("chat-input").fill("今日のやり方を顧客ルールに追加して")
  await page.getByTestId("chat-send").click()
  const card = page.getByTestId("proposal").last()
  await card.getByTestId("proposal-apply-all").click()
  await expect(page.getByTestId("proposal-closed").last()).toContainText("反映 1 件")
  // 承認を取り消せる記録にも「ルールの項目は残る」と出す
  await expect(page.getByTestId("proposal-undo-line").last()).toContainText("ルールの項目は取り消しても残ります")

  await page.getByRole("link", { name: customer }).click()
  const list = "customer-rules"
  await expect.poll(() => texts(page, list)).toEqual([rule])
  const origin = item(page, list, rule).getByTestId("rule-item-origin")
  await expect(origin).toHaveText("2026年度の案件でチャットから")
  await expect(origin).toHaveAttribute("data-source", "chat")
  await origin.getByRole("link").click()
  await expect(page).toHaveURL(caseUrl)
})

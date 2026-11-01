import { expect, test, type Page } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatChange, Proposal } from "../src/lib/chat/proposals"
import { callsServerFn, deleteCustomer, openNewCase, openTab, reload, showAllRows } from "./helpers"

/**
 * チャットで千円未満の端数の扱いを変える: 「端数は四捨五入で」→ 変更案に「千円未満: 四捨五入」→ 承認すると「7割と金額」のタブが四捨五入になり
 * 表の金額が変わる → 取り消すと戻る（開き直しても）。列の対応は見出しからの推定にし（計画の AI を断る）、チャットは決まった返事にする
 */

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

type ChatBody = { id: string; text: string; table: { rounding: string } }

/** チャットのサーバーの代わりに、変更案を1つ付けた決まった返事を返す。届いた指示の本文を bodies に溜める */
async function fakeChat(page: Page, changes: ChatChange[], bodies: ChatBody[]) {
  await page.route("**/api/cases/*/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON() as ChatBody
    bodies.push(body)
    const proposal: Proposal = { id: `p-${Date.now()}`, origin: { kind: "chat", messageId: body.id }, question: null, state: "open", count: changes.length, applied: [], rejected: [] }
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: `a-${Date.now()}` })
        writer.write({ type: "text-start", id: "t" })
        writer.write({ type: "text-delta", id: "t", delta: "千円未満を四捨五入にする案です。" })
        writer.write({ type: "text-end", id: "t" })
        writer.write({ type: "tool-input-available", toolCallId: "call-1", toolName: "set_selection", input: { rounding: "round" } })
        writer.write({ type: "tool-output-available", toolCallId: "call-1", output: { ok: true } })
        writer.write({ type: "data-proposal", data: { id: proposal.id } })
        writer.write({ type: "data-proposal-content", data: { proposal, changes }, transient: true })
        writer.write({ type: "message-metadata", messageMetadata: { usd: 0.01, caseUsd: 0.1, ms: 1000, inputTokens: 1, outputTokens: 1, toolCalls: 1 } })
        writer.write({ type: "finish" })
      },
    })
    const res = createUIMessageStreamResponse({ stream })
    await route.fulfill({ status: 200, headers: Object.fromEntries(res.headers), body: await res.text() })
  })
}

/** 表の行ごとの金額（行の key → 表に出ている値） */
async function amounts(page: Page) {
  await openTab(page, "table")
  const rows = await page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').evaluateAll((trs) =>
    trs.map((tr) => [(tr as HTMLElement).dataset.rowKey!, tr.querySelector('td[data-field="amount"] button > span')?.textContent ?? ""] as const),
  )
  return Object.fromEntries(rows)
}

const changedKeys = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => k in b && a[k] !== b[k])

async function expectRounding(page: Page, value: "floor" | "round") {
  await openTab(page, "selection")
  await expect(page.getByTestId(`rounding-${value}`)).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId(`rounding-${value === "floor" ? "round" : "floor"}`)).toHaveAttribute("aria-pressed", "false")
}

test("チャットで「端数は四捨五入で」→ 変更案に「千円未満: 四捨五入」→ 承認すると「7割と金額」のタブと表の金額が変わり、取り消すと戻る（開き直しても）", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")
  await showAllRows(page)
  await expectRounding(page, "floor")
  // 元データに千円未満の端数があり、切り捨てと四捨五入で合計が違う
  await expect(page.getByTestId("rounding-note")).toContainText("差")
  const floor = await amounts(page)

  const bodies: ChatBody[] = []
  await fakeChat(page, [{ kind: "settings", rounding: "round" }], bodies)

  await test.step("変更案に「千円未満: 四捨五入」と出る。承認すると「7割と金額」のタブが四捨五入になり、表の金額が変わる", async () => {
    await page.getByTestId("chat-input").fill("端数は四捨五入で")
    await page.getByTestId("chat-send").click()
    // 今の千円未満の扱いは表と一緒に送る（チャットの表はこの扱いで変換した行）
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]!.table.rounding).toBe("floor")
    const proposal = page.getByTestId("proposal")
    await expect(proposal).toContainText("7割と金額の設定")
    await proposal.getByTestId("proposal-open").click()
    await expect(page.getByTestId("proposal-dialog").getByTestId("proposal-item")).toContainText("千円未満: 四捨五入")
    await page.keyboard.press("Escape")
    await proposal.getByTestId("proposal-apply-all").click()
    await expect(page.getByTestId("proposal-closed")).toHaveText("変更案: 反映 1 件・却下 0 件")
    await expectRounding(page, "round")
    await expect.poll(async () => changedKeys(floor, await amounts(page)).length).toBeGreaterThan(0)
  })

  await test.step("取り消すと切り捨てと元の金額に戻り、開き直しても戻ったまま", async () => {
    await page.getByTestId("proposal-undo").click()
    await expect(page.getByTestId("proposal-undone")).toBeVisible()
    await expectRounding(page, "floor")
    await expect.poll(async () => changedKeys(floor, await amounts(page))).toEqual([])
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved", { timeout: 30_000 })
    await reload(page)
    await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
    await showAllRows(page)
    await expectRounding(page, "floor")
    expect(changedKeys(floor, await amounts(page))).toEqual([])
  })
})

/** 本物の AI を呼ぶ（E2E_LIVE_AI=1 のときだけ。費用は1回 $0.1 ほど） */
test("本物の AI: 「端数は四捨五入で」で千円未満の扱いの変更案が出て、承認すると四捨五入になる", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_AI !== "1", "E2E_LIVE_AI=1 のときだけ")
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done", { timeout: 300_000 })
  await page.getByTestId("chat-input").fill("端数は四捨五入で。ほかは変えないで")
  await page.getByTestId("chat-send").click()
  await expect(page.getByTestId("chat-reply-cost").last()).toBeVisible({ timeout: 300_000 })
  const proposal = page.getByTestId("proposal").last()
  if (await proposal.getByTestId("confirmation-yes").isVisible()) await proposal.getByTestId("confirmation-yes").click()
  await proposal.getByTestId("proposal-open").click()
  await expect(page.getByTestId("proposal-dialog")).toContainText("千円未満: 四捨五入")
  await page.keyboard.press("Escape")
  await proposal.getByTestId("proposal-apply-all").click()
  await expectRounding(page, "round")
})

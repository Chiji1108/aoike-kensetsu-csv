import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test, type Page } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatChange, Proposal } from "../src/lib/chat/proposals"
import { callsServerFn, deleteCustomer, openNewCase, openTab, showAllRows } from "./helpers"

/**
 * 印付きの Excel: 元の Excel（.xlsx）に印を付けて返す → 色付きのセル・推定のメモ・足した列がある → 顧客が記入してアップロードする →
 * 顧客の回答の変更案になり、承認すると表に入って問い合わせが減る → 承認を取り消すと戻る。
 * 列の対応は見出しからの推定にし（計画の AI を断る）、推定のメモを付けるセルはチャットの ask_customer の変更案で作る（決まった返事）
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

/** チャットのサーバーの代わりに、変更案を1つ付けた決まった返事を返す */
async function fakeChat(page: Page, changes: ChatChange[]) {
  await page.route("**/api/cases/*/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON() as { id: string }
    const proposal: Proposal = { id: `p-${Date.now()}`, origin: { kind: "chat", messageId: body.id }, question: null, state: "open", count: changes.length, applied: [], rejected: [] }
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: `a-${Date.now()}` })
        writer.write({ type: "text-start", id: "t" })
        writer.write({ type: "text-delta", id: "t", delta: "着工年月を顧客に確かめる変更案にしました。" })
        writer.write({ type: "text-end", id: "t" })
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

const isAsk = (c: ExcelJS.Cell) => c.fill?.type === "pattern" && (c.fill as ExcelJS.FillPattern).fgColor?.argb === "FFFFF2CC"
const cell = (page: Page, key: string, field: string) => page.locator(`tr[data-row-key="${key}"] td[data-field="${field}"] button > span`).first()
const inquiry = (page: Page, key: string) => page.locator(`[data-testid="inquiry-list"] tr[data-inquiry="${key}"]`)

test("元の Excel に印を付けてダウンロードし、記入して返すと顧客の回答の変更案になる。承認すると問い合わせが減り、取り消すと戻る", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")

  await test.step("チャットの変更案で着工年月を顧客に確かめることにする（推定のメモが付く）", async () => {
    await fakeChat(page, [{ kind: "ask", rowKey: "工事経歴!1", field: "startYm", reason: "契約日かもしれない" }])
    await page.getByTestId("chat-input").fill("1行目の着工年月を顧客に確かめて")
    await page.getByTestId("chat-send").click()
    await page.getByTestId("proposal").getByTestId("proposal-apply-all").click()
    await expect(page.getByTestId("proposal-closed")).toHaveText("変更案: 反映 1 件・却下 0 件")
  })

  await openTab(page, "inquiry")
  await expect(page.getByTestId("download-inquiry-xlsx")).toHaveAttribute("data-kind", "marked")
  await expect(page.getByTestId("inquiry-attachment")).toHaveText("顧客の元の Excel に、聞くセルの色と推定のメモを付けます。")
  await expect(page.getByTestId("inquiry-email")).toHaveValue(/お預かりした表に色を付けたもの/)

  const returned = await test.step("ダウンロードした Excel は元のシートに色とメモと足した列があり、照合用のシートは隠れている。顧客が記入する", async () => {
    const downloading = page.waitForEvent("download")
    await page.getByTestId("download-inquiry-xlsx").click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/^確認のお願い_/)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(readFileSync((await download.path())!).buffer as ArrayBuffer)
    expect(wb.worksheets.map((w) => [w.name, w.state])).toEqual([
      ["工事経歴", "visible"],
      ["照合用（印付き）", "veryHidden"],
    ])
    const ws = wb.getWorksheet("工事経歴")!
    expect(ws.getCell("B2").value).toBe("テストビル電気設備工事")
    expect(isAsk(ws.getCell("H3"))).toBe(true)
    expect(isAsk(ws.getCell("E4"))).toBe(true)
    expect(isAsk(ws.getCell("B2"))).toBe(false)
    expect(ws.getCell("I1").value).toBe("配置技術者（ご記入ください）")
    expect([2, 3, 4, 5].map((r) => isAsk(ws.getCell(r, 9)))).toEqual([true, true, true, true])
    expect(String(ws.getCell("G2").note)).toContain("推定です")
    // 顧客の記入: 1行目の配置技術者と、2行目の完成日
    ws.getCell("I2").value = "試験 太郎"
    ws.getCell("H3").value = new Date(Date.UTC(2024, 10, 15))
    return Buffer.from(await wb.xlsx.writeBuffer())
  })

  await test.step("返ってきた Excel をアップロードすると顧客の回答の変更案になる（まだ表には入らない）", async () => {
    await page.getByTestId("chat-file-input").setInputFiles({ name: "返信.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: returned })
    const panel = page.getByTestId("answer-import")
    await expect(panel.getByTestId("proposal")).toBeVisible()
    await expect(page.getByTestId("answer-report")).toContainText("変更案 2 件")
    await expect(page.getByTestId("answer-report")).toContainText("推定のまま確認 1 件")
    await expect(inquiry(page, "工事経歴!1:engineer")).toHaveCount(1)
  })

  await test.step("承認すると表に入り、問い合わせが減る", async () => {
    await page.getByTestId("answer-import").getByTestId("proposal-apply-all").click()
    await expect(page.getByTestId("answer-import").getByTestId("proposal-closed")).toHaveText("変更案: 反映 3 件・却下 0 件")
    await expect(inquiry(page, "工事経歴!1:engineer")).toHaveCount(0)
    await expect(inquiry(page, "工事経歴!2:endYm")).toHaveCount(0)
    await expect(inquiry(page, "工事経歴!1:startYm")).toHaveCount(0)
    await showAllRows(page)
    await expect(cell(page, "工事経歴!1", "engineer")).toHaveText("試験　太郎")
    await expect(cell(page, "工事経歴!2", "endYm")).toHaveText("202411")
  })

  await test.step("承認を取り消すと表と問い合わせが戻る", async () => {
    await page.getByTestId("answer-import").getByTestId("proposal-undo").click()
    await expect(cell(page, "工事経歴!1", "engineer")).toHaveText("—")
    await openTab(page, "inquiry")
    await expect(inquiry(page, "工事経歴!1:engineer")).toHaveCount(1)
    await expect(inquiry(page, "工事経歴!2:endYm")).toHaveCount(1)
  })
})

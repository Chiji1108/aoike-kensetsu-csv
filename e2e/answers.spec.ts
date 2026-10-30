import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test, type Page } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatChange, Proposal } from "../src/lib/chat/proposals"
import type { KojiFieldId } from "../src/lib/spec/koji-keireki"
import { callsServerFn, deleteCustomer, openNewCase, openTab, showAllRows } from "./helpers"

/**
 * 顧客の回答を AI で読む流れ: 記入用Excelの色付きの欄に書かず、右に足した「備考」の列に書いて返ってきた → 決まった欄の取り込みでは入らない →
 * チャットに「AI で読む」が出る → 押すと AI に読ませる指示を送る → 顧客の回答の変更案を承認すると表に入る。
 * 列の対応は見出しからの推定にし（計画の AI を断る）、チャットは決まった返事にする（AI なしで同じ結果になる）
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

/** 項目ごとの、答えとして入れる合成の値（CSV の値） */
const ANSWER: Record<string, string> = { engineer: "試験　次郎", startYm: "202404", endYm: "202410", prefecture: "東京都", place: "千代田区", workName: "テスト倉庫改修工事", client: "株式会社テスト" }

/** チャットのサーバーの代わりに、顧客の回答の変更案を1つ付けた決まった返事を返す。届いた指示の本文を texts に溜める */
async function fakeChat(page: Page, changes: ChatChange[], texts: string[]) {
  await page.route("**/api/cases/*/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON() as { id: string; text: string }
    texts.push(body.text)
    const proposal: Proposal = { id: `p-${Date.now()}`, origin: { kind: "chat", messageId: body.id }, question: null, state: "open", count: changes.length, applied: [], rejected: [] }
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: `a-${Date.now()}` })
        writer.write({ type: "text-start", id: "t" })
        writer.write({ type: "text-delta", id: "t", delta: "備考の列に書かれた答えを1件、変更案にしました。" })
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

const cell = (page: Page, key: string, field: string) => page.locator(`tr[data-row-key="${key}"] td[data-field="${field}"] button > span`).first()

test("記入用Excelの色付きの欄の外に書いた答えは、チャットの「AI で読む」で顧客の回答の変更案になり、承認すると表に入る", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")

  /** 返す記入用Excel（色付きの欄は空のまま、右に足した「備考」の列に答えを書く）と、答えた行・項目 */
  const answered = await test.step("記入用Excelをダウンロードし、色付きの欄でなく「備考」の列に答えを書く", async () => {
    await openTab(page, "inquiry")
    const downloading = page.waitForEvent("download")
    await page.getByTestId("download-inquiry-xlsx").click()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(readFileSync((await (await downloading).path())!).buffer as ArrayBuffer)
    const ws = wb.worksheets[0]!
    let headerRow = 0
    ws.eachRow((r, n) => {
      if (!headerRow && r.values && (r.values as unknown[]).includes("管理番号")) headerRow = n
    })
    const header = (ws.getRow(headerRow).values as unknown[]).map(String)
    const keyCol = header.indexOf("管理番号")
    const askedCol = header.indexOf("照合用")
    const noteCol = header.length
    ws.getCell(headerRow, noteCol).value = "備考"
    const first = ws.getRow(headerRow + 1)
    const asked = (JSON.parse(String(first.getCell(askedCol).value)) as { asked: { field: string }[] }).asked.find((a) => ANSWER[a.field])!
    first.getCell(noteCol).value = `${asked.field} は ${ANSWER[asked.field]} です`
    return { rowKey: String(first.getCell(keyCol).value), field: asked.field, buffer: Buffer.from(await wb.xlsx.writeBuffer()) }
  })

  const texts: string[] = []
  await fakeChat(page, [{ kind: "cell", rowKey: answered.rowKey, field: answered.field as KojiFieldId, edit: { value: ANSWER[answered.field]!, by: "customer" } }], texts)

  const xlsx = (name: string) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: answered.buffer })
  const suggestion = (name: string) => page.locator(`[data-testid="chat-suggestion"][data-file-name="${name}"]`)

  await test.step("返すと決まった欄を先に読み（答えは入らない）、チャットにファイルごとの「AI で読む」と、取り込んだあとに残っている問い合わせの数が出る", async () => {
    await page.getByTestId("chat-file-input").setInputFiles(xlsx("回答.xlsx"))
    await expect(page.getByTestId("answer-report")).toBeVisible()
    await expect(page.getByTestId("report-upload").last()).toContainText("AI で読む")
    await expect(page.locator('[data-testid="file-list"] [data-kind="answer"]')).toHaveCount(1)
    await expect(suggestion("回答.xlsx")).toBeVisible()
    await page.getByTestId("chat-file-input").setInputFiles(xlsx("回答2.xlsx"))
    await expect(page.locator('[data-testid="file-list"] [data-kind="answer"]')).toHaveCount(2)
    await expect(suggestion("回答2.xlsx")).toBeVisible()
    const left = await page.locator('[data-testid="inquiry-list"] tr[data-inquiry]:not([data-inquiry^="case:"])').count()
    await expect(suggestion("回答.xlsx")).toContainText(`まだ答えの無い問い合わせが ${left} 件`)
  })

  await test.step("押すと AI に読ませる指示を送り（書きかけの指示は残る。ほかのファイルの案内も残る）、顧客の回答の変更案を承認すると表に入る", async () => {
    await page.getByTestId("chat-input").fill("書きかけ")
    await suggestion("回答.xlsx").getByTestId("chat-suggestion-send").click()
    const proposal = page.getByTestId("proposal")
    await expect(proposal).toBeVisible()
    expect(texts).toEqual(["返ってきた記入用Excel「回答.xlsx」の、色付きの欄の外（別の列・メモ・別のシート）の記入と読めなかった記入を読んで、まだ聞いている項目の答えを変更案にして"])
    await expect(suggestion("回答.xlsx")).toHaveCount(0)
    await expect(suggestion("回答2.xlsx")).toBeVisible()
    await expect(page.getByTestId("chat-input")).toHaveValue("書きかけ")
    await proposal.getByTestId("proposal-open").click()
    await expect(page.getByTestId("proposal-dialog").getByTestId("proposal-item")).toContainText("（顧客の回答）")
    await page.keyboard.press("Escape")
    await proposal.getByTestId("proposal-apply-all").click()
    await expect(page.getByTestId("proposal-closed")).toHaveText("変更案: 反映 1 件・却下 0 件")
    await showAllRows(page)
    await expect(cell(page, answered.rowKey, answered.field)).toHaveText(ANSWER[answered.field]!)
  })
})

/** 本物の AI（E2E_LIVE_AI=1 のときだけ。費用は1回 $0.1 ほど）。サーバー（Worker）で工事場所の答えを住所データで分ける（異体字の市の名前も） */
test("本物の AI: 「備考」の列に書いた工事場所を読み、Worker で都道府県・市区町村に分けた変更案にする", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_AI !== "1", "E2E_LIVE_AI=1 のときだけ")
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done", { timeout: 180_000 })
  await openTab(page, "inquiry")
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
  const askedCol = header.indexOf("照合用")
  ws.getCell(headerRow, header.length).value = "備考"
  let rowKey = ""
  for (let n = headerRow + 1; n <= ws.rowCount && !rowKey; n++) {
    const asked = (JSON.parse(String(ws.getRow(n).getCell(askedCol).value)) as { asked: { field: string }[] }).asked
    if (!asked.some((a) => a.field === "place")) continue
    rowKey = String(ws.getRow(n).getCell(header.indexOf("管理番号")).value)
    ws.getRow(n).getCell(header.length).value = "工事場所は茨城県竜ヶ崎市です"
  }
  expect(rowKey).not.toBe("")
  await page.getByTestId("chat-file-input").setInputFiles({ name: "回答.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) })
  await page.locator('[data-testid="chat-suggestion"][data-file-name="回答.xlsx"]').getByTestId("chat-suggestion-send").click()
  const proposal = page.getByTestId("proposal")
  await expect(proposal).toBeVisible({ timeout: 240_000 })
  await proposal.getByTestId("proposal-open").click()
  const items = page.getByTestId("proposal-dialog").getByTestId("proposal-item")
  await expect(items.filter({ hasText: "都道府県名" })).toContainText("茨城県")
  await expect(items.filter({ hasText: "場所名" })).toContainText("龍ケ崎市")
})

import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test, type Page } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatChange, Proposal } from "../src/lib/chat/proposals"
import { callsServerFn, csvCount, deleteCustomer, openNewCase, reload, showAllRows } from "./helpers"

/**
 * チャット中心の流れ: ファイルを落とす → 自動で変換 → 変換の報告（注意書き・聞き返し・確かめる行の件数） → チャットで列の対応を直す変更案 →
 * 承認で変換し直す → 承認を取り消すと元に戻る（開き直しても） → 書き出す前の確認で決算書の額と照らす → 取り込み用の Excel と CSV。
 * 列の対応は見出しからの推定にし（計画の AI を断る）、チャットは決まった返事にする（AI なしで同じ結果になる）
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

type ChatBody = { text: string; plan: { plan: { headerRow: number }; shape: { rows: number; columns: number } } | null }

/** チャットのサーバーの代わりに、変更案を1つ付けた決まった返事を返す。届いた指示の本文を bodies に溜める */
async function fakeChat(page: Page, changes: ChatChange[], bodies: ChatBody[]) {
  await page.route("**/api/cases/*/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON() as ChatBody & { id: string }
    bodies.push(body)
    const proposal: Proposal = { id: `p-${Date.now()}`, origin: { kind: "chat", messageId: body.id }, question: null, state: "open", count: changes.length, applied: [], rejected: [] }
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: `a-${Date.now()}` })
        writer.write({ type: "text-start", id: "t" })
        writer.write({ type: "text-delta", id: "t", delta: "着工年月を完成日の列から作る案です。承認すると変換し直します。" })
        writer.write({ type: "text-end", id: "t" })
        writer.write({ type: "data-proposal", data: { id: proposal.id } })
        writer.write({ type: "data-proposal-content", data: { proposal, changes }, transient: true })
        writer.write({ type: "data-action", data: { action: "export" } })
        writer.write({ type: "message-metadata", messageMetadata: { usd: 0.01, caseUsd: 0.1, ms: 1000, inputTokens: 1, outputTokens: 1, toolCalls: 2 } })
        writer.write({ type: "finish" })
      },
    })
    const res = createUIMessageStreamResponse({ stream })
    await route.fulfill({ status: 200, headers: Object.fromEntries(res.headers), body: await res.text() })
  })
}

const cell = (page: Page, key: string, field: string) => page.locator(`tr[data-row-key="${key}"] td[data-field="${field}"] button > span`).first()

/** 着工年月と完成年月が違う行（着工年月を完成日の列から作ると、完成年月と同じになる） */
async function rowWithPeriod(page: Page) {
  const rows = await page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').evaluateAll((trs) =>
    trs.map((tr) => ({
      key: (tr as HTMLElement).dataset.rowKey!,
      start: tr.querySelector('td[data-field="startYm"] button > span')?.textContent ?? "",
      end: tr.querySelector('td[data-field="endYm"] button > span')?.textContent ?? "",
    })),
  )
  const row = rows.find((r) => /^\d{6}$/.test(r.start) && /^\d{6}$/.test(r.end) && r.start !== r.end)
  expect(row).toBeDefined()
  return row!
}

test("ファイルを落とすと自動で変換して報告で聞き返し、チャットで列の対応を直す変更案の承認で変換し直す。取り消すと戻り（開き直しても）、書き出す前に決算書の額と照らす", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))

  await test.step("チャット欄にファイルを落とすと、列の対応を考えてそのまま変換し、報告に注意書き・件数・聞き返しが出る", async () => {
    await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "empty")
    await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
    await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
    const report = page.getByTestId("case-report")
    await expect(report).toHaveAttribute("data-phase", "done")
    await expect(report.getByTestId("report-notes")).toContainText("見出しから列を推定しました")
    await expect(page.getByTestId("convert-button")).toHaveCount(0)
    await expect(page.getByTestId("row-filters").locator('[data-filter="check"]')).toHaveAttribute("aria-pressed", "true")
    await expect(report.getByTestId("report-count").first()).toBeVisible()
  })

  await test.step("聞き返し（税込か税抜か）に答えると設定に入る", async () => {
    const q = page.locator('[data-testid="report-question"][data-question="tax"]')
    await q.locator('[data-value="included"]').click()
    await expect(q).toHaveAttribute("data-answered", "税込")
    await expect(page.getByTestId("tax-included")).toHaveAttribute("aria-pressed", "true")
    // 選択肢の少ない欄はセグメントコントロール。キーボードでも選べる
    await page.getByTestId("tax-included").focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("tax-excluded")).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByTestId("tax-included")).toHaveAttribute("aria-pressed", "false")
    await page.getByTestId("tax-included").click()
  })

  await showAllRows(page)
  const row = await rowWithPeriod(page)
  const startYm = (page: Page) => cell(page, row.key, "startYm")
  const bodies: ChatBody[] = []
  await fakeChat(page, [{ kind: "plan", patch: { fields: { startYm: { kind: "column", column: 8, transform: "rule.yearMonth" } }, reason: "着工年月は完成日の列で" } }], bodies)

  await test.step("チャットで列の対応を直す変更案を出し、承認すると変換し直す", async () => {
    await page.getByTestId("chat-input").fill("着工年月は完成日の列で")
    await page.getByTestId("chat-send").click()
    const proposal = page.getByTestId("proposal")
    await expect(proposal.getByTestId("proposal-plan")).toContainText("着工年月")
    await expect(proposal.getByTestId("proposal-plan")).toContainText("I列")
    // 計画の確かめに使う今の列の対応とシートの大きさを送っている
    expect(bodies[0]!.plan!.shape.rows).toBeGreaterThan(3)
    expect(bodies[0]!.plan!.plan.headerRow).toBe(2)
    await proposal.getByTestId("proposal-apply-all").click()
    await expect(page.getByTestId("proposal-closed")).toHaveText("変更案: 反映 1 件・却下 0 件")
    await expect(startYm(page)).toHaveText(row.end, { timeout: 60_000 })
    // 返事のボタン（「CSV を出して」の offer_action）で書き出す前の確認が開く
    await expect(page.getByTestId("chat-action")).toHaveAttribute("data-action", "export")
    await page.getByTestId("chat-action").click()
    await expect(page.getByTestId("export-dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("export-dialog")).toBeHidden()
  })

  await test.step("承認を取り消すと元の列の対応で変換し直し、開き直しても戻ったまま", async () => {
    await page.getByTestId("proposal-undo").click()
    await expect(startYm(page)).toHaveText(row.start, { timeout: 60_000 })
    await expect(page.getByTestId("proposal-undone")).toBeVisible()
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved", { timeout: 30_000 })
    await reload(page)
    await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
    await showAllRows(page)
    // 会話は決まった返事なのでサーバーに残らない（変更案の札は出ない）。取り消した値は案件の作業に残る
    await expect(startYm(page)).toHaveText(row.start)
  })

  await test.step("書き出す前の確認: 決算書の額が表の合計と合わなければ知らせ（止めない）、取り込み用の Excel と CSV を出す", async () => {
    const n = await csvCount(page)
    await page.getByTestId("export-button").click()
    const dialog = page.getByTestId("export-dialog")
    await expect(dialog.getByTestId("export-rows")).toHaveText(String(n))
    await expect(dialog.getByTestId("export-basis")).toContainText("まだ入れていません")
    const firstGyoshu = dialog.locator("[data-gyoshu]").first()
    const input = firstGyoshu.getByRole("textbox").first()
    await input.fill("999999")
    await input.press("Enter")
    await expect(dialog.getByTestId("export-basis")).toHaveAttribute("data-ok", "0")
    await expect(dialog.getByTestId("export-basis")).toContainText("決算書 999,999 千円")
    // 決算書の額は7割の基準額なので、載せる件数も変わりうる（確認の件数は今の件数）
    const rows = Number(await dialog.getByTestId("export-rows").textContent())
    expect(rows).toBeGreaterThanOrEqual(n)

    const excel = page.waitForEvent("download")
    await dialog.getByTestId("export-excel").click()
    const xlsx = await excel
    expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(readFileSync((await xlsx.path())!).buffer as ArrayBuffer)
    expect(wb.worksheets).toHaveLength(1)
    const ws = wb.worksheets[0]!
    expect(ws.rowCount).toBe(rows)
    expect(ws.columnCount).toBeLessThanOrEqual(14)
    // 見出しの行なし（1行目からデータ。業種は数値、注文者は文字列）
    expect(typeof ws.getCell(1, 1).value).toBe("number")
    expect(typeof ws.getCell(1, 2).value).toBe("string")

    const csv = page.waitForEvent("download")
    await dialog.getByTestId("download-button").click()
    const text = new TextDecoder("shift_jis").decode(readFileSync((await (await csv).path())!))
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(rows)
    await expect(page.locator('[data-testid="file-list"] [data-kind="final_sheet"]')).toHaveCount(1)
  })
})

test("表ができる前に編集用の Excel を落としても、黙って捨てずに報告に理由を出す", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet("工事経歴（編集用）").addRows([["業種", "照合用"], ["8", "{}"]])
  wb.addWorksheet("照合用").state = "veryHidden"
  await page.getByTestId("chat-file-input").setInputFiles({ name: "直した.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) })
  const upload = page.getByTestId("report-upload")
  await expect(upload).toContainText("直した.xlsx")
  await expect(upload).toContainText("表がまだありません")
  await expect(upload).toHaveAttribute("data-tone", "error")
})

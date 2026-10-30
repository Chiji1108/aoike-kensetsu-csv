import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { attachAndConvert, callsServerFn, csvCount, deleteCustomer, open, openNewCase, showAllRows } from "./helpers"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname

/**
 * 翌年の形の Excel（合成）: 見出しの名前を変え（発注者 → 注文者）、2つの列を入れ替え（工期 ⇄ 完成日）、列を足し（担当部署）、シートを足す（技術者）
 */
async function nextYearWorkbook() {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(FIXTURE).buffer as ArrayBuffer)
  const ws = wb.getWorksheet("工事経歴")!
  const header = ws.getRow(3)
  const col = (h: string) => (header.values as unknown[]).findIndex((v) => v === h)
  const [period, end] = [col("工期"), col("完成日")]
  ws.getCell(3, col("発注者")).value = "注文者"
  for (let r = 3; r <= ws.rowCount; r++) {
    const a = ws.getCell(r, period).value
    ws.getCell(r, period).value = ws.getCell(r, end).value
    ws.getCell(r, end).value = a
    if (ws.getCell(r, 1).value !== null) ws.getCell(r, 12).value = r === 3 ? "担当部署" : "工務部"
  }
  wb.addWorksheet("技術者").addRows([["氏名", "資格"], ["青池　一郎", "1級建築施工管理技士"]])
  return { name: "令和6年度_工事経歴.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) }
}


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

test("同じ顧客の2年度目は去年の Excel との違いを出し、「去年のやり方で直す」は去年のコードを添える印と違いの文脈を送る。全件の切り替えで載る件数が変わる", async ({ page }) => {
  const { customer } = await openNewCase(page, "2025")
  created.push(customer)
  await attachAndConvert(page, FIXTURE)
  await expect(page.getByTestId("format-diff")).toHaveCount(0)

  await test.step("2026年度の案件で、形を変えた Excel を付けると去年との違いが出る", async () => {
    await page.getByRole("link", { name: customer }).click()
    await page.getByLabel("年度").fill("2026")
    await page.getByTestId("create-case").click()
    await expect(page.getByRole("heading", { name: `${customer} 2026年度` })).toBeVisible()
    // 列の計画の AI には、去年の列の対応と去年との違いを参考として添える
    const planBodies: string[] = []
    page.on("request", (r) => {
      if (callsServerFn(r.url(), ["planWithAi"])) planBodies.push(r.postData() ?? "")
    })
    await attachAndConvert(page, await nextYearWorkbook())
    expect(planBodies).toHaveLength(1)
    expect(planBodies[0]).toContain("去年（2025年度）の列の対応")
    expect(planBodies[0]).toContain("増えたシート")
    const diff = page.getByTestId("format-diff")
    await expect(diff).toContainText("去年（2025年度）の元の Excel との違い")
    await expect(diff).toContainText("増えたシート: 「技術者」")
    await expect(diff).toContainText("名前が変わった列: 去年 D列「発注者」 → 今年 D列「注文者」")
    await expect(diff).toContainText("並びが変わった列:")
    await expect(diff).toContainText("足された列: L列「担当部署」")
  })

  await test.step("全件を載せる切り替えで、載る件数が変わり、戻すと元の件数", async () => {
    const rule7 = await csvCount(page)
    await page.getByTestId("selection-all").check()
    await expect.poll(() => csvCount(page)).toBeGreaterThan(rule7)
    const all = await csvCount(page)
    await showAllRows(page)
    expect(await page.locator('[data-testid="preview-table"] tbody tr[data-row-key][data-included="1"]').count()).toBe(all)
    await page.getByTestId("selection-rule7").check()
    await expect.poll(() => csvCount(page)).toBe(rule7)
  })

  await test.step("チャットの「去年のやり方で直す」は carryover の印と去年との違いを送る（返事は決まったもの）", async () => {
    let body: { text: string; context: string; carryover?: boolean; carryoverNames?: string[]; carryoverHeaders?: string[] } | null = null
    let n = 0
    await page.route("**/api/cases/*/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      body = route.request().postDataJSON()
      // 1回目は途中で失敗する（サーバーは添えた印を立てない）。2回目は終わって印が立つ
      const failed = n++ === 0
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: "start", messageId: `a${n}` })
          // 添えた印の部品が返事にあっても、添えたかは会話の記録の印（metadata の carryover）で決める
          if (failed) writer.write({ type: "data-carryover", data: { fiscalYear: 2025, codes: 2 } })
          writer.write({ type: "text-start", id: "t" })
          writer.write({ type: "text-delta", id: "t", delta: failed ? "途中まで" : "顧客ルールどおりに直しました。" })
          writer.write({ type: "text-end", id: "t" })
          if (!failed) writer.write({ type: "data-carryover", data: { fiscalYear: 2025, codes: 2 } })
          writer.write({ type: "message-metadata", messageMetadata: { usd: 0.01, caseUsd: 0.5, ms: 1000, inputTokens: 1, outputTokens: 1, toolCalls: 1, carryover: !failed } })
          if (failed) throw new Error("AI の呼び出しに失敗しました")
          writer.write({ type: "finish" })
        },
        onError: (e) => (e instanceof Error ? e.message : String(e)),
      })
      const res = createUIMessageStreamResponse({ stream })
      await route.fulfill({ status: 200, headers: Object.fromEntries(res.headers), body: await res.text() })
    })
    await expect(page.getByTestId("chat-carryover")).toContainText("2025年度の案件があります")
    await page.getByTestId("chat-carryover-send").click()
    await expect(page.getByTestId("chat-error")).toContainText("AI の呼び出しに失敗しました")
    // 失敗した回は添えたことにならないので、もう一度押せる
    await expect(page.getByTestId("chat-carryover-send")).toBeEnabled()
    await page.getByTestId("chat-carryover-send").click()
    await expect(page.getByTestId("chat-carryover-note")).toContainText("2025年度の案件で承認につながったコード 2 件と、顧客ルールを添えました")
    // 失敗した回の返事にあった印の部品は描かない（会話の記録の印が立った返事の分だけ。前は2つ出ることがあった）
    await expect(page.getByTestId("chat-carryover-note")).toHaveCount(1)
    expect(body).not.toBeNull()
    expect(body!.text).toBe("顧客ルールどおりに表を直して")
    expect(body!.carryover).toBe(true)
    expect(Array.isArray(body!.carryoverNames)).toBe(true)
    // 去年と今年の見出しは、去年のコードの中で伏せない語として送る
    expect(body!.carryoverHeaders).toEqual(expect.arrayContaining(["発注者", "注文者", "担当部署"]))
    // 1つの会話で添えるのは1回だけ（会話を終えるまで出さない）
    await expect(page.getByTestId("chat-carryover")).toHaveCount(0)
    expect(body!.context).toContain("去年（2025年度）の元の Excel との違い")
    expect(body!.context).toContain("足された列: L列「担当部署」")
  })

  await test.step("去年の案件には違いも「去年のやり方で直す」も出ない", async () => {
    await open(page, "/")
    await page.locator(`[data-customer="${customer}"]`).getByRole("link").first().click()
    await page.getByRole("link", { name: /2025年度/ }).click()
    await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("format-diff")).toHaveCount(0)
  })
})

/** 本物の AI を呼ぶ（E2E_LIVE_AI=1 のときだけ。費用は1回 $0.3 ほど）。去年の会話の承認したコードを、サーバーが会話と変更案の状態から取り出して添える */
test("本物の AI: 去年のチャットで承認した変更のコードを、翌年の「去年のやり方で直す」に添える", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_AI !== "1", "E2E_LIVE_AI=1 のときだけ")
  const { customer } = await openNewCase(page, "2025")
  created.push(customer)
  await attachAndConvert(page, FIXTURE)
  await page.getByTestId("chat-input").fill("注文者の「株式会社」を「㈱」にして。ほかは変えないで")
  await page.getByTestId("chat-send").click()
  await expect(page.getByTestId("chat-reply-cost")).toBeVisible({ timeout: 300_000 })
  const proposal = page.getByTestId("proposal").last()
  if (await proposal.getByTestId("confirmation-yes").isVisible()) await proposal.getByTestId("confirmation-yes").click()
  await proposal.getByTestId("proposal-apply-all").click()
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved", { timeout: 30_000 })

  await page.getByRole("link", { name: customer }).click()
  await page.getByLabel("年度").fill("2026")
  await page.getByTestId("create-case").click()
  await attachAndConvert(page, await nextYearWorkbook())
  await page.getByTestId("chat-carryover-send").click()
  await expect(page.getByTestId("chat-carryover-note")).toContainText(/2025年度の案件で承認につながったコード [1-9]\d* 件と、顧客ルールを添えました/, { timeout: 300_000 })
  await expect(page.getByTestId("chat-reply-cost")).toBeVisible({ timeout: 300_000 })
  await expect(page.getByTestId("chat-carryover")).toHaveCount(0)
})

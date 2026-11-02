import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test, type Page } from "@playwright/test"
import { callsServerFn, deleteCustomer, openNewCase, openTab } from "./helpers"

/**
 * 7割と金額のタブの表は見るだけ。基準が何かを表の上の1行で出し、「決算書の額を入れる」を押したときだけ業種ごとの欄を開く。
 * 入れると割合が変わり、閉じても「決算書」の印が残る。空にすると顧客の表の合計に戻る。元請の工事が無い案件では元請の列を出さない。
 * 列の対応は見出しからの推定にする（計画の AI を断る）
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

async function convert(page: Page, file: Parameters<Page["setInputFiles"]>[1]) {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await page.getByTestId("chat-file-input").setInputFiles(file)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")
  await openTab(page, "selection")
}

/** 元請の工事を全部下請にした Excel（元請が1件も無い案件） */
async function noMotoukeWorkbook() {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(FIXTURE).buffer as ArrayBuffer)
  const ws = wb.getWorksheet("工事経歴")!
  const col = (ws.getRow(3).values as unknown[]).findIndex((v) => v === "元請/下請")
  expect(col).toBeGreaterThan(0)
  for (let r = 4; r <= ws.rowCount; r++) if (ws.getCell(r, col).value === "元請") ws.getCell(r, col).value = "下請"
  return { name: "下請だけ.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) }
}

test("表は見るだけ。「決算書の額を入れる」で開いて入れると割合が変わり、閉じても印が残る。書き出すの確認は届かない業種だけ。空にすると戻る", async ({ page }) => {
  await convert(page, FIXTURE)
  const panel = page.getByTestId("selection-section")
  const note = panel.getByTestId("basis-note")
  const table = panel.getByTestId("gyoshu-summary")
  await expect(note).toContainText("顧客の表の合計")
  await expect(note).toHaveAttribute("data-entered", "0")
  await expect(table).toHaveAttribute("data-motouke", "1")
  // 表に入力欄は無く、欄は押すまで出ない
  await expect(table.getByRole("textbox")).toHaveCount(0)
  await expect(panel.getByTestId("basis-editor")).toBeHidden()
  await expect(table.getByTestId("from-book")).toHaveCount(0)
  // 顧客の表の合計が基準なら、どの業種も満たす
  await expect(table.locator('[data-testid="total-ratio"][data-short="1"]')).toHaveCount(0)

  const row = table.locator("[data-gyoshu]").first()
  const code = (await row.getAttribute("data-gyoshu"))!
  const before = (await row.getByTestId("total-ratio").textContent())!
  // 金額は見るだけの形で出す（載せる額 / 基準）
  await expect(row.getByTestId("total-ratio").getByTestId("ratio-amounts")).toContainText(/載せる [\d,]+\s*\/ 基準 [\d,]+/)

  await test.step("開くとキーボードで欄に届き、入れると割合が変わる", async () => {
    await panel.getByTestId("basis-open").click()
    await expect(panel.getByTestId("basis-open")).toHaveText("閉じる")
    const editor = panel.getByTestId("basis-editor")
    await expect(editor).toBeVisible()
    await page.keyboard.press("Tab")
    const input = editor.locator(`[data-basis-gyoshu="${code}"]`).getByRole("textbox").first()
    await expect(input).toBeFocused()
    await page.keyboard.type("999999")
    await page.keyboard.press("Enter")
    await expect(row.getByTestId("total-ratio")).not.toHaveText(before)
    await expect(row.getByTestId("total-ratio")).toHaveAttribute("data-short", "1")
    await expect(row.getByTestId("total-ratio")).toContainText("届かない")
    await expect(note).toHaveAttribute("data-entered", "1")
    await expect(note).toContainText("決算書の額（1 業種）")
  })

  await test.step("閉じても、入れた額は表の「決算書」の印で分かる", async () => {
    await panel.getByTestId("basis-open").click()
    await expect(panel.getByTestId("basis-editor")).toBeHidden()
    await expect(row.getByTestId("total-ratio").getByTestId("from-book")).toBeVisible()
    await expect(table.getByTestId("from-book")).toHaveCount(1)
  })

  await test.step("書き出すの確認: 届かない業種だけを表で出す", async () => {
    await page.getByTestId("export-button").click()
    const dialog = page.getByTestId("export-dialog")
    await expect(dialog.getByTestId("export-rule7")).toHaveAttribute("data-ok", "0")
    await expect(dialog.getByTestId("export-rule7")).toContainText("7割に届かない")
    await expect(dialog.getByTestId("gyoshu-summary").locator("[data-gyoshu]")).toHaveCount(1)
    await expect(dialog.locator(`[data-gyoshu="${code}"]`).getByTestId("from-book")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })

  await test.step("空にすると顧客の表の合計に戻る", async () => {
    await panel.getByTestId("basis-open").click()
    const input = panel.getByTestId("basis-editor").locator(`[data-basis-gyoshu="${code}"]`).getByRole("textbox").first()
    await input.fill("")
    await input.press("Enter")
    await expect(row.getByTestId("total-ratio")).toHaveText(before)
    await expect(table.getByTestId("from-book")).toHaveCount(0)
    await expect(note).toHaveAttribute("data-entered", "0")
    await page.getByTestId("export-button").click()
    const dialog = page.getByTestId("export-dialog")
    await expect(dialog.getByTestId("export-rule7")).toHaveText("7割: すべての業種で満たしています（基準は顧客の表の合計）")
    await expect(dialog.getByTestId("gyoshu-summary")).toHaveCount(0)
    await page.keyboard.press("Escape")
  })

  await test.step("書き出すの確認で打った額は Escape で閉じても確定する。読めない字なら閉じずに知らせる", async () => {
    await page.getByTestId("export-button").click()
    const dialog = page.getByTestId("export-dialog")
    await dialog.getByTestId("basis-open").click()
    const input = dialog.locator(`[data-basis-gyoshu="${code}"]`).getByRole("textbox").first()
    await input.fill("abc")
    await input.press("Escape")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("1以上の数字（千円）で入力してください")).toBeVisible()
    await input.fill("999999")
    await input.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(row.getByTestId("total-ratio").getByTestId("from-book")).toBeVisible()
    await page.getByTestId("export-button").click()
    await expect(dialog.getByTestId("export-basis")).toContainText("決算書 999,999 千円")
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })
})

test("元請の工事が無い案件では、表に元請の列も、決算書の額の元請の欄も出さない", async ({ page }) => {
  await convert(page, await noMotoukeWorkbook())
  const panel = page.getByTestId("selection-section")
  const table = panel.getByTestId("gyoshu-summary")
  await expect(table).toHaveAttribute("data-motouke", "0")
  await expect(table.getByTestId("motouke-head")).toHaveCount(0)
  await expect(table.getByTestId("motouke-ratio")).toHaveCount(0)
  await panel.getByTestId("basis-open").click()
  const editor = panel.getByTestId("basis-editor")
  await expect(editor.getByRole("textbox", { name: /完成工事高/ }).first()).toBeVisible()
  await expect(editor.getByRole("textbox", { name: /うち元請/ })).toHaveCount(0)
})

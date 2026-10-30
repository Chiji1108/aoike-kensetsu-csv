import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test } from "@playwright/test"
import { convertFixture, deleteCustomer, downloadCsv, open, openTab, showAllRows } from "./helpers"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname
const ROWS = '[data-testid="preview-table"] tbody tr[data-row-key]'

const created: string[] = []
const pageErrors: string[] = []
test.beforeEach(({ page }) => {
  pageErrors.length = 0
  page.on("pageerror", (e) => pageErrors.push(e.message))
})
test.afterEach(async ({ page }) => {
  for (const customer of created.splice(0)) await deleteCustomer(page, customer)
  expect(pageErrors).toEqual([])
})


test("編集用の Excel を落とし、値を1つ直して行を1つ消して上げ直すと、変更案 → 承認 → 表と CSV に入る。開き直しても残る", async ({ page }) => {
  const { customer, caseUrl } = await convertFixture(page, FIXTURE)
  created.push(customer)
  await openTab(page, "excel")
  const edit = page.getByTestId("edit-excel")
  const downloading = page.waitForEvent("download")
  await edit.getByTestId("edit-excel-download").click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^工事経歴_編集用_.+_\d{8}\.xlsx$/)

  // 職員が Excel で直したのと同じに: 載せる行の1つ目の請負代金を変え、載せる行の2つ目を消す
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync((await download.path())!).buffer as ArrayBuffer)
  const ws = wb.worksheets[0]!
  const header = (ws.getRow(1).values as string[]).map((v) => String(v ?? ""))
  const col = (h: string) => header.indexOf(h)
  const meta = (r: number) => JSON.parse(String(ws.getCell(r, col("照合用")).value)) as { k: string; i: boolean }
  const included = Array.from({ length: ws.rowCount - 1 }, (_, i) => i + 2).filter((r) => meta(r).i)
  const [first, second] = included as [number, number]
  const changedKey = meta(first).k
  const deletedKey = meta(second).k
  const amountCell = ws.getCell(first, col("請負代金（千円）"))
  const newAmount = String(Number(amountCell.value) + 1)
  amountCell.value = newAmount
  ws.spliceRows(second, 1)
  await edit.getByTestId("edit-excel-input").setInputFiles({ name: "直した.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) })

  await expect(edit.getByTestId("edit-excel-report")).toContainText("セル 1 件")
  await expect(edit.getByTestId("edit-excel-report")).toContainText("載せない 1 行")
  const proposal = edit.getByTestId("proposal")
  await expect(proposal).toContainText("未決 2 件")
  await expect(page.locator('[data-testid="file-list"] [data-kind="edit_sheet"]')).toHaveCount(1)
  expect(await downloadCsv(page)).not.toContain(`,${newAmount},`)

  await proposal.getByTestId("proposal-open").click()
  const items = page.getByTestId("proposal-dialog").getByTestId("proposal-item")
  await expect(items).toHaveCount(2)
  await expect(items.first().locator('[data-diff="added"]')).toBeVisible()
  await page.keyboard.press("Escape")
  await proposal.getByTestId("proposal-apply-all").click()
  await expect(edit.getByTestId("proposal")).toHaveCount(0)

  await showAllRows(page)
  await expect(page.locator(`${ROWS}[data-row-key="${changedKey}"]`)).toContainText(newAmount)
  await expect(page.locator(`${ROWS}[data-row-key="${deletedKey}"]`)).toHaveAttribute("data-included", "0")
  expect(await downloadCsv(page)).toContain(`,${newAmount},`)

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved")
  await open(page, caseUrl)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
  await showAllRows(page)
  await expect(page.locator(`${ROWS}[data-row-key="${changedKey}"]`)).toContainText(newAmount, { timeout: 60_000 })
  await expect(page.locator(`${ROWS}[data-row-key="${deletedKey}"]`)).toHaveAttribute("data-included", "0")

  // 開き直しても承認を取り消せる（取り消すまで Excel の欄に残る）。取り消すと値も載せるかも戻る
  await openTab(page, "excel")
  await page.getByTestId("edit-excel").getByTestId("proposal-undo").click()
  await expect(page.locator(`${ROWS}[data-row-key="${changedKey}"]`)).not.toContainText(newAmount)
  await expect(page.locator(`${ROWS}[data-row-key="${deletedKey}"]`)).toHaveAttribute("data-included", "1")
  expect(await downloadCsv(page)).not.toContain(`,${newAmount},`)
})

test("壊れた照合用・読めない値は取り込まずに一覧で知らせる", async ({ page }) => {
  const { customer } = await convertFixture(page, FIXTURE)
  created.push(customer)
  await openTab(page, "excel")
  const edit = page.getByTestId("edit-excel")
  const downloading = page.waitForEvent("download")
  await edit.getByTestId("edit-excel-download").click()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync((await (await downloading).path())!).buffer as ArrayBuffer)
  const ws = wb.worksheets[0]!
  const header = (ws.getRow(1).values as string[]).map((v) => String(v ?? ""))
  ws.getCell(2, header.indexOf("照合用")).value = "書き換えた"
  ws.getCell(3, header.indexOf("着工年月")).value = "そのうち"
  await edit.getByTestId("edit-excel-input").setInputFiles({ name: "壊した.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) })
  await expect(edit.getByTestId("edit-excel-report")).toContainText("変わったところはありませんでした")
  await expect(edit.getByTestId("edit-excel-problem")).toHaveCount(2)
  await expect(edit).toContainText("照合用の列が壊れていて")
  await expect(edit).toContainText("そのうち")
})

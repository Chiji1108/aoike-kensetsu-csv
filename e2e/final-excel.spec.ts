import { readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { expect, test, type Page } from "@playwright/test"
import { convertFixture, deleteCustomer, downloadCsv, open, showAllRows } from "./helpers"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname
const ROWS = '[data-testid="preview-table"] tbody tr[data-row-key]'
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
/** 請負代金（千円）の列（I） */
const AMOUNT = 9

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

/** 書き出すの確認から最後の Excel を落とし、ExcelJS で開く（職員が Excel で開いたとき） */
async function downloadFinal(page: Page) {
  await page.getByTestId("export-button").click()
  const dialog = page.getByTestId("export-dialog")
  await expect(dialog.getByTestId("export-note")).toContainText("上げると表に戻ります")
  const downloading = page.waitForEvent("download")
  await dialog.getByTestId("export-excel").click()
  const path = (await (await downloading).path())!
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(path).buffer as ArrayBuffer)
  return wb
}

/** 照合用の隠しシートの行の key（データのシートの行の順） */
const keysOf = (wb: ExcelJS.Workbook) => {
  const keys: string[] = []
  wb.worksheets[1]!.eachRow((r) => {
    if (r.getCell(1).value === "row") keys.push(String(r.getCell(2).value))
  })
  return keys
}

const upload = async (page: Page, wb: ExcelJS.Workbook, name: string) =>
  page.getByTestId("chat-file-input").setInputFiles({ name, mimeType: XLSX_TYPE, buffer: Buffer.from(await wb.xlsx.writeBuffer()) })

test("書き出した Excel の値を1つ直して行を1つ消し、上げ直すと変更案 → 承認で表と CSV に入る。開き直しても取り消せる。同じ Excel をもう一度上げても（承認の前も後も）二重にならない", async ({ page }) => {
  const { customer, caseUrl } = await convertFixture(page, FIXTURE)
  created.push(customer)
  const wb = await downloadFinal(page)
  expect(wb.worksheets.map((w) => w.state)).toEqual(["visible", "veryHidden"])
  const keys = keysOf(wb)
  const [changedKey, deletedKey] = keys as [string, string]

  // 職員が Excel で直したのと同じに: 1行目の請負代金を変え、2行目を消す
  const ws = wb.worksheets[0]!
  const newAmount = Number(ws.getCell(1, AMOUNT).value) + 1
  ws.getCell(1, AMOUNT).value = newAmount
  ws.spliceRows(2, 1)
  await upload(page, wb, "直した.xlsx")

  const panel = page.getByTestId("final-import")
  await expect(panel.getByTestId("final-import-report")).toContainText("セル 1 件")
  await expect(panel.getByTestId("final-import-report")).toContainText("載せない 1 行")
  const proposal = panel.getByTestId("proposal")
  await expect(proposal).toContainText("未決 2 件")
  await expect(page.locator('[data-testid="file-list"] [data-kind="edit_sheet"]')).toHaveCount(1)
  expect(await downloadCsv(page)).not.toContain(`,${newAmount},`)

  // 承認する前に同じ Excel をもう一度上げても、変更案もファイルも足さない
  await upload(page, wb, "直した.xlsx")
  await expect(panel.getByTestId("final-import-report")).toContainText("同じ変更案がもうあります")
  await expect(panel.getByTestId("proposal")).toHaveCount(1)
  await expect(page.locator('[data-testid="file-list"] [data-kind="edit_sheet"]')).toHaveCount(1)

  await proposal.getByTestId("proposal-apply-all").click()
  await expect(panel.getByTestId("proposal-undo")).toBeVisible()
  await showAllRows(page)
  await expect(page.locator(`${ROWS}[data-row-key="${changedKey}"]`)).toContainText(String(newAmount))
  await expect(page.locator(`${ROWS}[data-row-key="${deletedKey}"]`)).toHaveAttribute("data-included", "0")
  expect(await downloadCsv(page)).toContain(`,${newAmount},`)

  // 同じ Excel をもう一度上げても、もう入っているので変更案にしない
  await upload(page, wb, "直した.xlsx")
  await expect(panel.getByTestId("final-import-report")).toContainText("変わったところはありませんでした")
  await expect(panel.getByTestId("proposal")).toHaveCount(0)
  await expect(panel.getByTestId("proposal-closed")).toHaveCount(1)

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved")
  await open(page, caseUrl)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
  await showAllRows(page)
  await expect(page.locator(`${ROWS}[data-row-key="${changedKey}"]`)).toContainText(String(newAmount), { timeout: 60_000 })

  // 開き直しても承認を取り消せる（取り消すまでチャット欄に残る）。取り消すと値も載せるかも戻る
  await page.getByTestId("final-import").getByTestId("proposal-undo").click()
  await expect(page.locator(`${ROWS}[data-row-key="${changedKey}"]`)).not.toContainText(String(newAmount))
  await expect(page.locator(`${ROWS}[data-row-key="${deletedKey}"]`)).toHaveAttribute("data-included", "1")
  expect(await downloadCsv(page)).not.toContain(`,${newAmount},`)
})

test("読めない値は取り込まずに一覧で知らせる。照合用のシートを消した Excel は表に戻せないと伝え、変換の元にするかを聞く", async ({ page }) => {
  const { customer } = await convertFixture(page, FIXTURE)
  created.push(customer)
  const wb = await downloadFinal(page)
  wb.worksheets[0]!.getCell(1, 12).value = "そのうち"
  await upload(page, wb, "直した.xlsx")
  const panel = page.getByTestId("final-import")
  await expect(panel.getByTestId("final-import-report")).toContainText("変更案にできる変更はありませんでした")
  await expect(panel.getByTestId("final-import-problem")).toHaveCount(1)
  await expect(panel).toContainText("そのうち")

  wb.removeWorksheet(wb.worksheets[1]!.id)
  await upload(page, wb, "照合用なし.xlsx")
  await expect(page.getByTestId("source-keep")).toBeVisible()
  await page.getByTestId("source-keep").click()
  await expect(page.getByTestId("report-upload").last()).toContainText("表に戻せません")
})

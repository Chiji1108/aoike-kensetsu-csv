import { expect, type Locator, type Page } from "@playwright/test"

/** ページを開き、React が画面につながる（<html data-hydrated>）まで待つ。つながる前の入力や押下は効かない */
export async function open(page: Page, url: string) {
  await page.goto(url)
  await waitHydrated(page)
}

export async function reload(page: Page) {
  await page.reload()
  await waitHydrated(page)
}

const waitHydrated = (page: Page) => expect(page.locator("html[data-hydrated]")).toBeAttached()

/**
 * サーバー関数 names のどれかを呼ぶ要求か。開発サーバーの関数の id（URL の最後）は、ファイルと関数の名前の JSON を base64url にしたもの
 * （名前そのものは URL に出ない）
 */
export function callsServerFn(url: string, names: string[]) {
  const id = new URL(url).pathname.split("/").pop() ?? ""
  let fn: { export?: unknown }
  try {
    fn = JSON.parse(Buffer.from(id, "base64url").toString("utf8"))
  } catch {
    return false
  }
  return typeof fn.export === "string" && names.some((n) => (fn.export as string).startsWith(`${n}_`))
}

/** 顧客と案件を作り、案件の画面を開く。顧客名は毎回違う名前にする（前の実行が残っていても混ざらない） */
export async function openNewCase(page: Page, year = "2026") {
  const customer = `合成建設E2E-${Date.now()}`
  await open(page, "/")
  await page.getByTestId("new-customer-name").fill(customer)
  await page.getByTestId("create-customer").click()
  await expect(page.getByRole("heading", { name: customer })).toBeVisible()
  await page.getByLabel("年度").fill(year)
  await page.getByTestId("create-case").click()
  await expect(page.getByRole("heading", { name: `${customer} ${year}年度` })).toBeVisible()
  return { customer, caseUrl: page.url() }
}

/** 案件の画面で Excel（パスか中身）を付け、列の対応が出たら変換し、プレビューの表が出るまで待つ */
export async function attachAndConvert(page: Page, file: Parameters<Locator["setInputFiles"]>[0]) {
  await page.getByTestId("file-input").setInputFiles(file)
  await expect(page.getByTestId("plan-source")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("plan-source")).not.toContainText("考えています", { timeout: 120_000 })
  await page.getByTestId("convert-button").click()
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
}

/** 新しい案件を作って Excel を変換する */
export async function convertFixture(page: Page, path: string) {
  const opened = await openNewCase(page)
  await attachAndConvert(page, path)
  return opened
}

/** 削除のダイアログで顧客名を入れて消す */
export async function confirmDelete(page: Page, customer: string) {
  const dialog = page.getByRole("alertdialog")
  await expect(dialog.getByTestId("delete-counts")).toContainText("案件")
  await dialog.getByTestId("delete-confirm-name").fill(customer)
  await dialog.getByTestId("delete-confirm").click()
  await expect(dialog).toBeHidden()
}

/** 顧客の一覧から顧客を消す（テストで作った顧客の後始末） */
export async function deleteCustomer(page: Page, customer: string) {
  await open(page, "/")
  const row = page.locator(`[data-customer="${customer}"]`)
  await row.getByTestId("delete-button").click()
  await confirmDelete(page, customer)
  await expect(row).toHaveCount(0)
}

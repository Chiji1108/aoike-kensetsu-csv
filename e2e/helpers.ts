import { readFileSync } from "node:fs"
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

/** 案件の画面のチャットの📎で Excel（パスか中身）をアップロードし、AI が列の対応を考えて自動で変換し、変換の報告と作業の画面の表が出るまで待つ */
export async function attachAndConvert(page: Page, file: Parameters<Locator["setInputFiles"]>[0]) {
  await page.getByTestId("chat-file-input").setInputFiles(file)
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done", { timeout: 300_000 })
  // 広い画面では作業の画面がチャットの右に開く（狭い画面ではチャットの「表を開く」で開く）
  if ((page.viewportSize()?.width ?? 0) >= 1280) await expect(page.getByTestId("preview-table")).toBeVisible()
}

/** 作業の画面の表のタブで、絞り込みを「すべて」にする（はじめは直す行だけ） */
export async function showAllRows(page: Page) {
  await openTab(page, "table")
  await page.getByTestId("row-filters-all").click()
  await expect(page.getByTestId("row-filters-all")).toHaveAttribute("aria-pressed", "true")
}

/** 見出しの「…」を開いて、案件の AI の費用の文を読む（閉じて返す） */
export async function caseCostText(page: Page) {
  await page.getByTestId("case-menu").click()
  const cost = page.getByTestId("case-cost")
  await expect(cost).toBeVisible()
  const text = (await cost.textContent()) ?? ""
  await page.keyboard.press("Escape")
  await expect(cost).toBeHidden()
  return text
}

/** 案件の AI の費用（ドル） */
export const caseCostUsd = async (page: Page) => Number(/\$([\d.]+)/.exec(await caseCostText(page))![1])

/** 見出しの「…」から案件を消すダイアログを開く */
export async function openCaseDelete(page: Page) {
  await page.getByTestId("case-menu").click()
  await page.getByTestId("delete-button").click()
}

/** 作業の画面のタブを開く */
export async function openTab(page: Page, tab: "table" | "selection" | "inquiry" | "location" | "replace") {
  await page.getByTestId(`tab-${tab}`).click()
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true")
}

/** 書き出すボタンの件数（CSV に載せる行） */
export const csvCount = async (page: Page) => Number(/（(\d+)件/.exec((await page.getByTestId("export-button").textContent()) ?? "")![1])

/** 書き出す前の確認を開いて CSV（控え）をダウンロードし、中身（CP932）を返す。確認は閉じる */
export async function downloadCsv(page: Page) {
  await page.getByTestId("export-button").click()
  const dialog = page.getByTestId("export-dialog")
  await expect(dialog).toBeVisible()
  const downloading = page.waitForEvent("download")
  await dialog.getByTestId("download-button").click()
  const path = (await (await downloading).path())!
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  return new TextDecoder("shift_jis").decode(readFileSync(path))
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

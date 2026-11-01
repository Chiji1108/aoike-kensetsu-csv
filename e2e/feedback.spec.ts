import { spawnSync } from "node:child_process"
import { expect, test, type Page } from "@playwright/test"
import { confirmDelete, deleteCustomer, open, openCaseDelete, openNewCase, reload } from "./helpers"

/** チャットの AI が案件で残した要望の代わりに、ローカルの D1 に行を足す（AI を呼ばずに、案件へのリンクと案件の削除を確かめる） */
function insertAiFeedback(caseId: string, want: string) {
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`
  const sql = `insert into csv_feedback (id, case_id, kind, want, did, idea, source) values (${q(crypto.randomUUID())}, ${q(caseId)}, 'detour', ${q(want)}, 'コードで直した。', 'まとめて直す道具。', 'ai')`
  const r = spawnSync("bunx", ["wrangler", "d1", "execute", "DB", "--local", "--command", sql], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`D1 に書けませんでした: ${r.stderr}`)
}

const item = (page: Page, want: string) => page.getByTestId("feedback-item").filter({ hasText: want })

const created: string[] = []
test.afterEach(async ({ page }) => {
  for (const c of created.splice(0)) await deleteCustomer(page, c).catch(() => {})
})

test("要望: メニューから開き、職員が書き足す（顧客名は断る）。状態を変えると絞り込みで分かれ、開き直しても残る", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await page.getByRole("button", { name: "メニュー", exact: true }).click()
  await page.getByTestId("menu-feedback").click()
  await expect(page.getByRole("heading", { name: "要望" })).toBeVisible()
  await expect(page.getByTestId("feedback-filter-open")).toHaveAttribute("aria-pressed", "true")

  const want = `元の Excel の列を並べ替えたい E2E-${Date.now()}`
  await page.getByTestId("feedback-new").click()
  await page.getByTestId("feedback-form-kind-repeat").click()
  await page.getByTestId("feedback-form-want").fill(`${customer} の件で困った`)
  await page.getByTestId("feedback-form-did").fill("Excel で並べ替えてから上げ直した")
  await page.getByTestId("feedback-form-idea").fill("列の並べ替えの道具")
  await page.getByTestId("feedback-form-submit").click()
  await expect(page.getByText("顧客の名前が入っています")).toBeVisible()
  await expect(page.getByTestId("feedback-form")).toBeVisible()
  await page.getByTestId("feedback-form-want").fill(want)
  await page.getByTestId("feedback-form-submit").click()
  await expect(page.getByTestId("feedback-form")).toBeHidden()
  const row = item(page, want)
  await expect(row).toContainText("繰り返し")
  await expect(row).toContainText("職員")
  await expect(row.getByTestId("feedback-case")).toHaveCount(0)

  await row.getByTestId("feedback-status-done").click()
  await expect(row).toHaveCount(0)
  await page.getByTestId("feedback-filter-done").click()
  await expect(item(page, want).getByTestId("feedback-status-done")).toHaveAttribute("aria-pressed", "true")
  await reload(page)
  await expect(item(page, want)).toHaveCount(0)
  await page.getByTestId("feedback-filter-all").click()
  await expect(item(page, want)).toHaveCount(1)
  // キーボードでも状態を変えられる（矢印で移り、Enter で選ぶ）
  await item(page, want).getByTestId("feedback-status-done").focus()
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Enter")
  await expect(item(page, want).getByTestId("feedback-status-wontfix")).toHaveAttribute("aria-pressed", "true")
})

test("要望: AI が案件で残した要望は案件へのリンクを出し、案件を消すと要望は残ってリンクが外れる", async ({ page }) => {
  const { customer, caseUrl } = await openNewCase(page)
  created.push(customer)
  const caseId = new URL(caseUrl).pathname.split("/").pop()!
  const want = `業種をまとめて直したい E2E-${Date.now()}`
  insertAiFeedback(caseId, want)
  await open(page, "/feedback")
  const link = item(page, want).getByTestId("feedback-case")
  await expect(link).toHaveText(`${customer} 2026年度`)
  await expect(item(page, want)).toContainText("AI")
  await link.click()
  await expect(page.getByRole("heading", { name: `${customer} 2026年度` })).toBeVisible()

  await openCaseDelete(page)
  await confirmDelete(page, customer)
  await open(page, "/feedback")
  await expect(item(page, want)).toHaveCount(1)
  await expect(item(page, want).getByTestId("feedback-case")).toHaveCount(0)
})

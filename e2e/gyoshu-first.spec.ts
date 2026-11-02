import { expect, test, type Page } from "@playwright/test"
import { callsServerFn, csvCount, deleteCustomer, openNewCase, openTab } from "./helpers"

/**
 * 業種を先に一度で決める: 業種のタブの一覧に、載せる行と7割の選び直しで載りうる行（業種が決まっていない行）をまとめて出し、
 * 案のまま決める（全部・選んだ行）か、違う行だけ選ぶ欄で決める。業種がそろってから7割を選ぶので、決めたあとに「直す」に業種が新しく出ない。
 * 決めたものは取り消せる。行の「要確認」「AI の推定」は「これでよい」で片付き、取り消せる。顧客に聞く印はどの欄を聞くのかを書く。
 * 合成 fixture（sample-messy.xlsx）の業種の列は使わない（全行の業種が空で、7割では一部の行だけが載る）。配置技術者の列も使わない（顧客に聞く）。計画の AI と業種の AI の案は決まったものにする
 */

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname

const col = (column: number, transform: string) => ({ kind: "column", column, transform, instruction: null })

const PLAN = {
  sheets: [0],
  sheetReason: "工事ごとに1行の一覧",
  headerRow: 2,
  dataStart: 3,
  skipRows: [10, 11, 12],
  excludeColumns: [],
  amountUnit: "yen",
  amountTax: "included",
  fields: {
    gyoshu: { kind: "missing" },
    client: col(3, "ai.anonymizeClient"),
    motoukeShitauke: { kind: "columns", columns: [4, 3], transform: "rule.motoukeShitauke", instruction: null },
    jv: { kind: "constant", value: "0", reason: "JV列なし" },
    workName: col(2, "ai.anonymizeWorkName"),
    prefecture: col(5, "rule.addressPrefecture"),
    place: col(5, "rule.addressCity"),
    // 配置技術者は元データに無い（顧客に聞く）
    engineer: { kind: "missing" },
    amount: col(6, "rule.yenToThousand"),
    specialAmount: { kind: "constant", value: "0", reason: "該当なし" },
    startYm: col(7, "rule.periodStart"),
    endYm: col(8, "rule.yearMonth"),
    chiefEngineer: { kind: "missing" },
    supervisingEngineer: { kind: "missing" },
  },
  unusedColumns: [{ column: 0, header: "No.", reason: "連番" }],
  notes: [],
  asks: [],
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

async function fakeAi(page: Page) {
  await page.route(
    (url) => callsServerFn(url.href, ["planWithAi"]),
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true, json: PLAN, usd: 0 } }) }),
  )
  // 業種の AI の案: 1件目は決められない、ほかは工事名から建築一式
  await page.route(
    (url) => callsServerFn(url.href, ["runAiBatch"]),
    async (route) => {
      if (!(route.request().postData() ?? "").includes("suggestGyoshu")) return route.continue()
      const results = Array.from({ length: 20 }, (_, id) => (id === 0 ? { id, value: "", basis: "none", confident: false, note: "" } : { id, value: "2", basis: "workName", confident: true, note: "工事名の「工事」" }))
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true, json: { results }, usd: 0.01 } }) })
    },
  )
}

const count = async (page: Page) => Number((await page.getByTestId("gyoshu-count").textContent()) ?? "0")
const gyoshuFixes = (page: Page) => page.locator('[data-testid="preview-table"] [data-testid="row-fix"][data-field="gyoshu"]')

test("業種を一覧で先に決めると、7割で載せる行が入れ替わっても直すに業種が出ない。一部だけ選ぶ欄で決め、取り消せる", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await fakeAi(page)
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done", { timeout: 300_000 })
  await expect(page.getByTestId("preview-table")).toBeVisible()
  // 7割ルールでは一部の行だけが載る（業種が空の行がみな同じ組になる）
  const loaded = await csvCount(page)
  expect(loaded).toBeLessThan(7)

  await test.step("次にやることの「業種を決める」は直すより先。行の「業種を決める」で業種のタブが開く", async () => {
    await expect(page.getByTestId("next-step-gyoshu")).toHaveText(/業種を決める\s*7行/)
    await expect(page.getByTestId("next-steps")).toHaveAttribute("data-current", "gyoshu")
    // 業種は直すに数えない（「業種を決める」と二重にしない）
    await expect(page.getByTestId("next-step-fix")).not.toHaveAttribute("title", /業種/)
    await page.getByTestId("row-filters-all").click()
    await page.locator('[data-testid="row-fix-action"][data-action="decideGyoshu"]').first().click()
    await expect(page.getByTestId("tab-gyoshu")).toHaveAttribute("aria-selected", "true")
    // 載せる行だけでなく、7割の選び直しで載りうる行も一覧に出る
    expect(await count(page)).toBe(7)
    await expect(page.getByTestId("gyoshu-panel")).toContainText(`載せる ${loaded} 行と、7割の選び直しで載りうる ${7 - loaded} 行`)
  })

  await test.step("案の無い行に AI で案を出すと、一覧に案と根拠が出る（表にはまだ入らない）", async () => {
    await page.getByTestId("gyoshu-suggest").click()
    await expect(page.locator('[data-testid="gyoshu-row"][data-plan="2"]')).toHaveCount(6)
    await expect(page.getByTestId("gyoshu-note").first()).toContainText("工事名から")
    expect(await count(page)).toBe(7)
  })

  await test.step("選んだ行だけ案のまま決める → 一覧から消える。取り消すと業種が空に戻り、選ばれていない行として一覧に戻る", async () => {
    await page.locator('[data-testid="gyoshu-row"][data-plan="2"]').first().getByTestId("gyoshu-check").click()
    await page.getByTestId("gyoshu-decide-selected").click()
    await expect.poll(() => count(page)).toBe(6)
    await page.getByTestId("gyoshu-undo").click()
    await expect.poll(() => count(page)).toBe(7)
    // AI の案の項目は決めたまま（チャットの承認の取り消しと同じ）なので、戻った行は案なし。選択も残らない
    await expect(page.locator('[data-testid="gyoshu-row"][data-plan=""]')).toHaveCount(2)
    await expect(page.getByTestId("gyoshu-decide-all")).toBeVisible()
  })

  await test.step("違う行だけ選ぶ欄で決める（キーボードで）。次の行の欄に移る", async () => {
    const row = page.locator('[data-testid="gyoshu-row"][data-plan=""]').first()
    await row.getByTestId("gyoshu-pick").focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("cell-picker-search")).toBeFocused()
    await page.keyboard.type("電気")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("cell-picker")).toBeHidden()
    await expect.poll(() => count(page)).toBe(6)
    await expect(page.locator('[data-testid="gyoshu-pick"]:focus')).toHaveCount(1)
  })

  await test.step("残りを案のまま決め、案の無い行を選ぶと一覧は空になり、次にやることの業種は済み。直すに業種が新しく出ない", async () => {
    await page.getByTestId("gyoshu-decide-all").click()
    await expect.poll(() => count(page)).toBe(1)
    await page.getByTestId("gyoshu-pick").click()
    await page.keyboard.type("建築")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("gyoshu-done")).toBeVisible()
    await expect(page.getByTestId("next-step-gyoshu")).toHaveAttribute("data-done", "1")
    // チャットの AI の案の変更案は、一覧で決めたので閉じる
    await expect(page.getByTestId("fix-suggestion").getByTestId("proposal-apply-all")).toHaveCount(0)
    await openTab(page, "table")
    await page.getByTestId("row-filters-fix").click()
    await expect(gyoshuFixes(page)).toHaveCount(0)
    await page.getByTestId("row-filters-all").click()
    await expect(gyoshuFixes(page)).toHaveCount(0)
    await expect(page.locator('td[data-field="gyoshu"] [data-code="8"]')).toHaveCount(1)
  })

  await test.step("一覧で決めたものを取り消すと、業種が空に戻り一覧に戻る", async () => {
    await openTab(page, "gyoshu")
    await page.getByTestId("gyoshu-undo").click()
    await expect.poll(() => count(page)).toBe(1)
    await page.getByTestId("gyoshu-pick").click()
    await page.keyboard.type("建築")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("gyoshu-done")).toBeVisible()
  })

  await test.step("行の「これでよい」で要確認・AI の推定がそのまま片付き、取り消せる", async () => {
    await openTab(page, "table")
    await page.getByTestId("row-filters-fix").click()
    const confirm = page.getByTestId("row-confirm").first()
    await expect(confirm).toBeVisible()
    const field = (await confirm.getAttribute("data-field"))!
    const key = (await page.locator("tr[data-row-key]").filter({ has: confirm }).getAttribute("data-row-key"))!
    const fixOf = page.locator(`tr[data-row-key="${key}"] [data-testid="row-fix"][data-field="${field}"]`)
    await confirm.click()
    await expect(fixOf).toHaveCount(0)
    await page.getByTestId("row-filters-all").click()
    await expect(page.locator(`tr[data-row-key="${key}"] td[data-field="${field}"]`)).toHaveAttribute("data-status", "changed")
    await page.getByTestId("row-filters-fix").click()
    await page.getByTestId("confirm-undo").click()
    await page.getByTestId("row-filters-all").click()
    await expect(page.locator(`tr[data-row-key="${key}"] [data-testid="row-fix"][data-field="${field}"]`)).toHaveCount(1)
  })

  await test.step("顧客に聞く印は、どの欄を聞くのかを書く", async () => {
    await page.getByTestId("row-filters-all").click()
    await expect(page.getByTestId("row-ask").first()).toHaveText("配置技術者は顧客に聞く")
  })
})

import { expect, test, type Page } from "@playwright/test"
import { callsServerFn, csvCount, deleteCustomer, openNewCase, openTab } from "./helpers"

/**
 * 「直す」の行から直し方を選ぶ: 業種が空の行に「AI で案を出す」→ チャットの流れに変更案 → 承認で入り「直す」が減る。
 * 業種などの決まった値は選ぶ欄で選ぶ（キーボードでも。Escape は欄だけ閉じる）。主任技術者・監理技術者は1つの欄で2列を決める。
 * 「顧客に聞く」で問い合わせのタブへ。計画の聞き返しの答えには載せる件数の見込みが付き、大半を外す答えは押す前に確かめる。
 * 計画の AI と業種の AI の案の応答は決まったものにする（合成 fixture）
 */

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname

const col = (column: number, transform: string) => ({ kind: "column", column, transform, instruction: null })

/** 合成 fixture（sample-messy.xlsx）の列の対応。業種の列は使わない（全行の業種が空）。場所は2行目だけ空にする代わりに使う列のまま */
const plan = (asks: unknown[]) => ({
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
    engineer: col(9, "rule.personNameSpace"),
    amount: col(6, "rule.yenToThousand"),
    specialAmount: { kind: "constant", value: "0", reason: "該当なし" },
    startYm: col(7, "rule.periodStart"),
    endYm: col(8, "rule.yearMonth"),
    chiefEngineer: { kind: "missing" },
    supervisingEngineer: { kind: "missing" },
  },
  unusedColumns: [{ column: 0, header: "No.", reason: "連番" }],
  notes: [],
  asks,
})

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

async function fakePlan(page: Page, asks: unknown[]) {
  await page.route(
    (url) => callsServerFn(url.href, ["planWithAi"]),
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true, json: plan(asks), usd: 0 } }) }),
  )
}

/** 業種の AI の案（suggestGyoshu）だけを決まった答えにする（ほかの値ごとの判断は本物）。1件目は決められない、ほかは工事名から建築一式。届いた依頼を sent に溜める */
async function fakeSuggest(page: Page, sent: string[]) {
  await page.route(
    (url) => callsServerFn(url.href, ["runAiBatch"]),
    async (route) => {
      const body = route.request().postData() ?? ""
      if (!body.includes("suggestGyoshu")) return route.continue()
      sent.push(body)
      const results = Array.from({ length: 20 }, (_, id) =>
        id === 0 ? { id, value: "", basis: "none", note: "" } : id === 1 ? { id, value: "2", basis: "trend", note: "ほかの工事 5 件中 4 件が建築一式" } : { id, value: "2", basis: "workName", note: "工事名の「工事」" },
      )
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true, json: { results }, usd: 0.01 } }) })
    },
  )
}

async function upload(page: Page) {
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done", { timeout: 300_000 })
  await expect(page.getByTestId("preview-table")).toBeVisible()
}

const fixCount = async (page: Page) => Number(/(\d+)/.exec((await page.getByTestId("next-step-fix").textContent()) ?? "0")?.[1] ?? 0)
const tableRow = (page: Page, text: string) => page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').filter({ has: page.getByTestId("row-fix").filter({ hasText: text }) })

test("業種が空の行に AI で案を出して承認すると直すが減る。決まった値は選ぶ欄で選ぶ（キーボードでも）。顧客に聞くは問い合わせへ", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await fakePlan(page, [])
  const sent: string[] = []
  await fakeSuggest(page, sent)
  await upload(page)
  // 全件を載せる（業種の空の行がすべて直すに出る）
  await openTab(page, "selection")
  await page.getByTestId("selection-all").click()
  await expect.poll(() => csvCount(page)).toBe(7)
  await openTab(page, "table")

  await test.step("直すの上に、まとめて頼める操作が出る。行の理由の横にも同じ直し方が出る", async () => {
    await page.getByTestId("row-filters-fix").click()
    const action = page.locator('[data-testid="fix-action"][data-action="suggestGyoshu"]')
    await expect(action).toHaveText("業種が空の 7 行に AI で案を出す")
    await expect(page.locator('[data-testid="row-fix-action"][data-action="suggestGyoshu"]').first()).toHaveText("AI で案を出す")
    // 次にやることの「直す」のツールチップと書き出すの確認も同じ言葉
    await expect(page.getByTestId("next-step-fix")).toHaveAttribute("title", /業種が空の 7 行に AI で案を出す/)
  })

  const before = await fixCount(page)
  await test.step("押すと、AI の案がチャットの流れに変更案として出る（結果はそのまま表に入らない）。推し量った案は根拠に推定と出る", async () => {
    await page.locator('[data-testid="fix-action"][data-action="suggestGyoshu"]').click()
    const panel = page.getByTestId("fix-suggestion")
    await expect(panel.getByTestId("fix-suggestion-summary")).toContainText("7 行のうち 6 行に案を出しました")
    await expect(panel.getByTestId("fix-suggestion-summary")).toContainText("決められなかった 1 行")
    expect(sent).toHaveLength(1)
    // 決まった処理で数えた傾向を添える（ここでは決まっている業種が無い）
    expect(sent[0]).toContain("決まっている工事がない")
    expect(await fixCount(page)).toBe(before)
    await expect(page.getByTestId("next-step-answer")).toHaveAttribute("data-done", "0")
    await panel.getByTestId("proposal-open").click()
    const dialog = page.getByTestId("proposal-dialog")
    await expect(dialog.getByTestId("diff-to").first()).toContainText("2 建築一式")
    await expect(dialog.locator('[data-testid="diff-note"][data-guess="1"]')).toHaveCount(1)
    await expect(dialog.locator('[data-testid="diff-note"][data-guess="1"]')).toContainText("推定: ほかの工事の傾向")
    await page.keyboard.press("Escape")
  })

  await test.step("承認すると入り、直すが減る。表には名前で出る", async () => {
    await page.getByTestId("fix-suggestion").getByTestId("proposal-apply-all").click()
    await expect.poll(() => fixCount(page)).toBeLessThan(before)
    await expect(tableRow(page, "業種が空")).toHaveCount(1)
    await page.getByTestId("row-filters-all").click()
    await expect(page.locator('td[data-field="gyoshu"] [data-code="2"]').first()).toContainText("建築一式")
    await page.getByTestId("row-filters-fix").click()
  })

  await test.step("業種を選ぶ欄で、名前で絞り込んで Enter で選ぶ（キーボードだけ）", async () => {
    const row = tableRow(page, "業種が空")
    await expect(row).toHaveCount(1)
    const left = await fixCount(page)
    await row.locator('td[data-field="gyoshu"] button').focus()
    await page.keyboard.press("Enter")
    const picker = page.getByTestId("cell-picker")
    await expect(picker.getByTestId("cell-picker-search")).toBeFocused()
    await page.keyboard.type("電気")
    await expect(picker.getByTestId("cell-picker-option")).toHaveCount(2)
    await page.keyboard.press("Enter")
    await expect(picker).toBeHidden()
    await expect(tableRow(page, "業種が空")).toHaveCount(0)
    expect(await fixCount(page)).toBeLessThanOrEqual(left)
    // 閉じたらセルに戻る
    await expect(page.locator('tr[data-row-key] td[data-field="gyoshu"] button:focus')).toContainText("電気")
  })

  await test.step("元請下請は2〜4択のボタン。Escape は欄だけ閉じ、値は変えない。→ と Enter で選ぶ", async () => {
    await page.getByTestId("row-filters-all").click()
    const cell = page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').first().locator('td[data-field="motoukeShitauke"]')
    const was = (await cell.locator("[data-code]").getAttribute("data-code")) ?? ""
    await cell.locator("button").focus()
    await page.keyboard.press("Enter")
    const picker = page.getByTestId("cell-picker")
    await expect(picker.getByTestId("cell-picker-option")).toHaveText(["官公庁元請", "民間元請", "下請"])
    await page.keyboard.press("Escape")
    await expect(picker).toBeHidden()
    await expect(cell.locator("[data-code]")).toHaveAttribute("data-code", was)
    await expect(page.getByTestId("work-panel")).toBeVisible()
    await cell.locator("button").focus()
    await page.keyboard.press("Enter")
    await expect(picker.locator('[data-testid="cell-picker-option"]:focus')).toHaveAttribute("data-value", was)
    await page.keyboard.press(was === "2" ? "ArrowLeft" : "ArrowRight")
    await page.keyboard.press("Enter")
    await expect(picker).toBeHidden()
    await expect(cell.locator("[data-code]")).not.toHaveAttribute("data-code", was)
  })

  await test.step("主任技術者・監理技術者は1つの欄で選び、2列を一緒に決める（どちらか一方だけが あり）", async () => {
    const r = page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').first()
    await expect(r.locator('td[data-field="chiefEngineer"]')).toContainText("あり")
    await r.locator('td[data-field="supervisingEngineer"] button').click()
    await page.getByTestId("cell-picker").locator('[data-testid="cell-picker-option"][data-value="supervising"]').click()
    await expect(r.locator('td[data-field="chiefEngineer"]')).toContainText("なし")
    await expect(r.locator('td[data-field="supervisingEngineer"]')).toContainText("あり")
  })

  await test.step("JV は なし／あり で出す", async () => {
    await expect(page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').first().locator('td[data-field="jv"]')).toContainText("なし")
  })

  await test.step("狭い画面: 重ねて開いた作業の画面の選ぶ欄は画面に収まり、Escape は欄だけ閉じる（作業の画面は閉じない）", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    if (!(await page.getByTestId("work-frame").isVisible())) await page.getByTestId("work-open").click()
    await openTab(page, "table")
    await expect(page.getByTestId("work-frame")).toHaveAttribute("role", "dialog")
    await page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').first().locator('td[data-field="gyoshu"] button').click()
    const picker = page.getByTestId("cell-picker")
    await expect(picker).toBeVisible()
    const box = (await picker.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await page.keyboard.press("Escape")
    await expect(picker).toBeHidden()
    await expect(page.getByTestId("work-frame")).toBeVisible()
    await page.setViewportSize({ width: 1500, height: 1000 })
  })

  await test.step("顧客に聞く行からは問い合わせのタブへ", async () => {
    await openTab(page, "selection")
    await page.getByTestId("tax-unknown").click()
    await openTab(page, "table")
    const ask = page.getByTestId("row-ask").first()
    if (await ask.count()) {
      await ask.click()
      await expect(page.getByTestId("tab-inquiry")).toHaveAttribute("aria-selected", "true")
    }
  })
})

test("計画の聞き返しの答えに載せる件数の見込みが付き、大半を外す答えは押す前に確かめる", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  // 工種（B列）に値のある行＝全行を「載せるか迷う行」として聞く
  await fakePlan(page, [{ kind: "doubtful", text: "工種の列に値のある行があります。", column: 1, values: [] }])
  await upload(page)
  await openTab(page, "selection")
  await page.getByTestId("selection-all").click()
  await expect.poll(() => csvCount(page)).toBe(7)
  const question = page.locator('[data-testid="report-question"][data-question="plan-ask-0"]')
  await expect(question.getByTestId("report-answer")).toHaveText(["載せない（載せる 7 → 0 件）", "載せる（7 件のまま）"])
  await expect(question.getByTestId("report-question-detail")).toContainText("データの 7 行のうち 7 行が当たります。")

  await test.step("押すと確かめが出る。やめると何も変わらない", async () => {
    await question.locator('[data-value="exclude"]').click()
    const confirm = page.getByTestId("ask-confirm")
    await expect(confirm).toContainText("載せる工事が 7 件から 0 件に減ります")
    await confirm.getByTestId("ask-confirm-cancel").click()
    await expect(confirm).toBeHidden()
    await expect(question).toHaveAttribute("data-pending", "1")
    expect(await csvCount(page)).toBe(7)
  })

  await test.step("確かめて押すと答えになる", async () => {
    await question.locator('[data-value="exclude"]').click()
    await page.getByTestId("ask-confirm").getByTestId("ask-confirm-ok").click()
    await expect(question).toHaveAttribute("data-answered", "載せない")
    await expect.poll(() => csvCount(page), { timeout: 60_000 }).toBe(0)
  })
})

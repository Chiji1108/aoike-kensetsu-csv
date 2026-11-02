import { expect, test, type Page } from "@playwright/test"
import { callsServerFn, csvCount, deleteCustomer, openNewCase, openTab } from "./helpers"

/**
 * 「直す」の行から直し方を選ぶ: 業種が空の行の「業種を決める」→ 業種のタブで「AI で案を出す」→ チャットの流れにも変更案 → 承認で入り「直す」が減る。
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

/** 業種の AI の案（suggestGyoshu）だけを決まった答えにする（ほかの値ごとの判断は本物）。1件目は決められない、2件目は AI が迷った（案にしない）、ほかは工事名から建築一式。届いた依頼を sent に溜める */
async function fakeSuggest(page: Page, sent: string[]) {
  await page.route(
    (url) => callsServerFn(url.href, ["runAiBatch"]),
    async (route) => {
      const body = route.request().postData() ?? ""
      if (!body.includes("suggestGyoshu")) return route.continue()
      sent.push(body)
      const results = Array.from({ length: 20 }, (_, id) =>
        id === 0
          ? { id, value: "", basis: "none", confident: false, note: "" }
          : id === 1
            ? { id, value: "8", basis: "workName", confident: false, note: "迷った" }
            : { id, value: "2", basis: "workName", confident: true, note: "工事名の「工事」" },
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

/** 次にやることの「業種を決める」の行数（業種は直すに数えない） */
const gyoshuCount = async (page: Page) => Number(/(\d+)/.exec((await page.getByTestId("next-step-gyoshu").textContent()) ?? "0")?.[1] ?? 0)
const tableRow = (page: Page, text: string) => page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').filter({ has: page.getByTestId("row-fix").filter({ hasText: text }) })

test("業種が空の行に業種のタブで AI の案を出し、承認すると業種を決める行が減る。決まった値は選ぶ欄で選ぶ（キーボードでも）。顧客に聞くは問い合わせへ", async ({ page }) => {
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

  await test.step("業種は直すに数えず「業種を決める」の段に数える。行の理由の横に「業種を決める」が出る", async () => {
    await page.getByTestId("row-filters-fix").click()
    await expect(page.locator('[data-testid="fix-action"][data-action="decideGyoshu"]')).toHaveCount(0)
    await expect(page.getByTestId("next-step-fix")).not.toHaveAttribute("title", /業種/)
    await expect(page.getByTestId("next-step-gyoshu")).toHaveText(/業種を決める\s*7行/)
    await page.getByTestId("row-filters-all").click()
    await expect(page.locator('[data-testid="row-fix-action"][data-action="decideGyoshu"]').first()).toHaveText("業種を決める")
  })

  const before = await gyoshuCount(page)
  await test.step("業種のタブで頼むと、AI の案がチャットの流れに変更案として出る（結果はそのまま表に入らない）。推し量った案は根拠に推定と出る", async () => {
    await page.locator('[data-testid="row-fix-action"][data-action="decideGyoshu"]').first().click()
    await expect(page.getByTestId("tab-gyoshu")).toHaveAttribute("aria-selected", "true")
    await page.getByTestId("gyoshu-suggest").click()
    const panel = page.getByTestId("fix-suggestion")
    await expect(panel.getByTestId("fix-suggestion-summary")).toContainText("7 行のうち 5 行に案を出しました")
    await expect(panel.getByTestId("fix-suggestion-summary")).toContainText("決められなかった 2 行")
    expect(sent).toHaveLength(1)
    // 決まった処理で数えた傾向を添える（ここでは決まっている業種が無い）
    expect(sent[0]).toContain("決まっている工事がない")
    expect(await gyoshuCount(page)).toBe(before)
    // 業種の AI の案は「答える」でなく「業種を決める」の段で決める
    await expect(page.getByTestId("next-step-gyoshu")).toHaveAttribute("data-done", "0")
    await panel.getByTestId("proposal-open").click()
    const dialog = page.getByTestId("proposal-dialog")
    await expect(dialog.getByTestId("diff-to").first()).toContainText("2 建築一式")
    // 工事名から推し量った案も推定（黄色）で、根拠を添える
    await expect(dialog.locator('[data-testid="diff-note"][data-guess="1"]')).toHaveCount(5)
    await expect(dialog.locator('[data-testid="diff-note"][data-guess="1"]').first()).toContainText("AI の推定・AI の案（工事名から）")
    await page.keyboard.press("Escape")
  })

  await test.step("承認すると入り、業種を決める行が減る。表には名前で出る", async () => {
    await page.getByTestId("fix-suggestion").getByTestId("proposal-apply-all").click()
    await expect.poll(() => gyoshuCount(page)).toBe(2)
    await openTab(page, "table")
    await expect(tableRow(page, "業種が空")).toHaveCount(2)
    // 承認した値は推定の印を外して入る（AI の推定として直すに残らない）
    await expect(page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').filter({ has: page.getByTestId("row-fix").filter({ hasText: "業種: AI の推定" }) })).toHaveCount(0)
    await page.getByTestId("row-filters-all").click()
    await expect(page.locator('td[data-field="gyoshu"] [data-code="2"]').first()).toContainText("建築一式")
  })

  await test.step("業種を選ぶ欄で、名前で絞り込んで Enter で選ぶ（キーボードだけ）", async () => {
    const row = tableRow(page, "業種が空").first()
    await expect(tableRow(page, "業種が空")).toHaveCount(2)
    await row.locator('td[data-field="gyoshu"] button').focus()
    await page.keyboard.press("Enter")
    const picker = page.getByTestId("cell-picker")
    await expect(picker.getByTestId("cell-picker-search")).toBeFocused()
    await page.keyboard.type("電気")
    await expect(picker.getByTestId("cell-picker-option")).toHaveCount(2)
    await page.keyboard.press("Enter")
    await expect(picker).toBeHidden()
    await expect(tableRow(page, "業種が空")).toHaveCount(1)
    await expect.poll(() => gyoshuCount(page)).toBe(1)
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

  await test.step("選ぶ欄を開いたまま別のセルを押すと、押したセルの欄が開いたまま（前のセルにフォーカスを戻して閉じない）", async () => {
    const r = page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').nth(1)
    await r.locator('td[data-field="motoukeShitauke"] button').click()
    await expect(page.getByTestId("cell-picker").getByTestId("cell-picker-option")).toHaveCount(3)
    await r.locator('td[data-field="jv"] button').click()
    await expect(page.getByTestId("cell-picker").getByTestId("cell-picker-option")).toHaveText(["なし", "あり"])
    await page.waitForTimeout(300)
    await expect(page.getByTestId("cell-picker")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("cell-picker")).toBeHidden()
  })

  await test.step("理由で絞ると、まとめての操作もその理由の見えている行だけを数える", async () => {
    await page.getByTestId("row-filters-fix").click()
    // 工事場所の AI の推定は自信のある推定なので調べない（操作を出さない）。業種は直すの操作に出さない
    await expect(page.locator('[data-testid="fix-action"][data-action="decideGyoshu"]')).toHaveCount(0)
    await page.getByTestId("fix-reason-guess").click()
    await expect(page.getByTestId("fix-action")).toHaveCount(0)
    await page.getByTestId("fix-reason-guess").click()
    await page.getByTestId("row-filters-all").click()
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

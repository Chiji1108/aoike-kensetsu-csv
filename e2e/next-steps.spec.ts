import { expect, test, type Page } from "@playwright/test"
import { callsServerFn, csvCount, deleteCustomer, openNewCase, openTab, reload } from "./helpers"

/**
 * 職員が次に何をするか分かる流れ: 計画の AI の聞き返しに答える（答えは計画の行の除外にして変換し直す・取り消すと戻る・開き直しても答えたまま）→
 * 次にやること（答える → 直す → 問い合わせ → 書き出す）を押すとそこへ移り、済むと済みになる → 行に直す理由が出る。
 * 計画の AI の応答は決まったもの（合成 fixture の列の対応と、備考の列に値のある行を「載せるか迷う行」として聞く聞き返し）にする
 */

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname

const col = (column: number, transform: string) => ({ kind: "column", column, transform, instruction: null })

/** 合成 fixture（sample-messy.xlsx の「工事経歴」）の列の対応。備考（K列）に値のある1行を聞き返す */
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
    gyoshu: col(1, "rule.gyoshu"),
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
  notes: ["メモのシートに書類待ちの工事があります。"],
  asks: [{ kind: "doubtful", text: "備考（K列）に注記のある行があります。", column: 10, values: [] }],
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

/** 計画の AI の代わりに決まった計画を返す（サーバー関数の返事は { result } の JSON） */
async function fakePlan(page: Page) {
  await page.route(
    (url) => callsServerFn(url.href, ["planWithAi"]),
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true, json: PLAN, usd: 0 } }) }),
  )
}

const question = (page: Page) => page.locator('[data-testid="report-question"][data-question="plan-ask-0"]')

test("計画の聞き返しに答えると表と載せる件数が変わり、取り消すと戻る。次にやることを押すとそこへ移り、済むと済みになる", async ({ page }) => {
  const { customer } = await openNewCase(page)
  created.push(customer)
  await fakePlan(page)
  await page.getByTestId("chat-file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done", { timeout: 300_000 })
  await expect(page.getByTestId("preview-table")).toBeVisible()

  await test.step("聞き返しと知らせを見た目で分ける。聞き返しは対象の行の数と答えの選択肢、知らせは答えが要らないと出す", async () => {
    await expect(question(page)).toContainText("備考（K列）に注記のある行があります。")
    await expect(question(page).getByTestId("report-question-detail")).toHaveText("該当 1 行")
    await expect(question(page).getByTestId("report-answer")).toHaveText(["載せない", "載せる"])
    await expect(page.getByTestId("report-notes")).toContainText("答えは要りません")
    await expect(page.getByTestId("report-notes")).toContainText("メモのシートに書類待ちの工事があります。")
    // 計画が税込と決めたので税の聞き返しは出ない。次にやることの「答える」は聞き返しの1つ
    await expect(page.locator('[data-testid="report-question"][data-question="tax"]')).toHaveCount(0)
    await expect(page.getByTestId("next-steps")).toHaveAttribute("data-current", "answer")
    await expect(page.getByTestId("next-step-answer")).toContainText("1")
  })

  await test.step("「表で見る」で対象の行だけを表に出す（答えではないので聞き返しは開いたまま）", async () => {
    await question(page).getByTestId("report-question-view").click()
    await expect(page.getByTestId("ask-filter")).toContainText("載せるか迷う行（1行）")
    await expect(page.locator('[data-testid="preview-table"] tbody tr[data-row-key]')).toHaveCount(1)
    await expect(question(page)).toHaveAttribute("data-pending", "1")
  })

  // 全件を載せる（迷う行も載る）にして、答えで載せる件数が変わるのを見る
  await openTab(page, "selection")
  await page.getByTestId("selection-all").click()
  await expect.poll(() => csvCount(page)).toBe(7)

  await test.step("「載せない」と答えると、対象の行を計画の除外にして変換し直し、載せる件数が減る。聞き返しは答えを出して閉じ、「答える」は済みになる", async () => {
    await question(page).locator('[data-value="exclude"]').click()
    await expect(question(page)).toHaveAttribute("data-answered", "載せない")
    await expect.poll(() => csvCount(page), { timeout: 60_000 }).toBe(6)
    await expect(page.getByTestId("next-step-answer")).toHaveAttribute("data-done", "1")
    await openTab(page, "table")
    await question(page).getByTestId("report-question-view").click()
    await expect(page.locator('[data-testid="preview-table"] tbody tr[data-row-key]')).toHaveAttribute("data-included", "0")
  })

  await test.step("開き直しても答えたまま", async () => {
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved", { timeout: 30_000 })
    await reload(page)
    await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
    await expect(question(page)).toHaveAttribute("data-answered", "載せない")
    await expect.poll(() => csvCount(page)).toBe(6)
  })

  await test.step("答えを取り消すと、聞き返しが開き直り、載せる件数が戻る", async () => {
    await question(page).getByTestId("report-question-undo").click()
    await expect(question(page)).toHaveAttribute("data-pending", "1")
    await expect.poll(() => csvCount(page), { timeout: 60_000 }).toBe(7)
    await expect(page.getByTestId("next-step-answer")).toHaveAttribute("data-done", "0")
    await question(page).locator('[data-value="keep"]').click()
    await expect(question(page)).toHaveAttribute("data-answered", "載せる")
    await expect.poll(() => csvCount(page)).toBe(7)
  })

  await test.step("次にやることの「直す」で表の直すに移り、行に理由が出る", async () => {
    await openTab(page, "inquiry")
    const fix = page.getByTestId("next-step-fix")
    if ((await fix.getAttribute("data-done")) === "0") {
      await fix.click()
      await expect(page.getByTestId("tab-table")).toHaveAttribute("aria-selected", "true")
      await expect(page.getByTestId("row-filters-fix")).toHaveAttribute("aria-pressed", "true")
      await expect(page.locator('[data-testid="preview-table"] tbody tr[data-row-key]').first().getByTestId("row-fix")).toBeVisible()
    }
  })

  await test.step("問い合わせを押すとそのタブに移り、案件の状態を「問い合わせ中」にすると「送った・返事待ち」になる。済んだ段は押せない", async () => {
    // 金額の税込・税抜を「分からない」にすると、顧客に聞くことが1つ以上になる
    await openTab(page, "selection")
    await page.getByTestId("tax-unknown").click()
    const step = page.getByTestId("next-step-inquiry")
    await expect(step).toHaveAttribute("data-state", "todo")
    await step.click()
    await expect(page.getByTestId("tab-inquiry")).toHaveAttribute("aria-selected", "true")
    await page.getByTestId("case-status-inquiring").click()
    await expect(step).toHaveAttribute("data-state", "waiting")
    await expect(step).toContainText("返事待ち")
    await expect(page.getByTestId("export-button")).toHaveAttribute("title", /問い合わせ \d+件（送った・返事待ち）/)
    // 「答える」は済み（押せるボタンではない）
    await expect(page.getByTestId("next-step-answer")).toHaveAttribute("data-done", "1")
    await expect(page.getByRole("button", { name: /^答える/ })).toHaveCount(0)
  })

  await test.step("書き出すの ⚠ の意味（残り）は、ツールチップと書き出すの確認で同じ言葉。残りを押すとそこへ移る", async () => {
    const button = page.getByTestId("export-button")
    const title = (await button.getAttribute("title")) ?? ""
    await button.click()
    const remaining = page.getByTestId("export-remaining")
    if ((await button.getAttribute("data-left")) === "1") {
      expect(title).toMatch(/^残り: /)
      const texts = await remaining.locator("button").allTextContents()
      expect(title).toBe(`残り: ${texts.join(" → ")}`)
      await remaining.locator("button").first().click()
      await expect(page.getByTestId("export-dialog")).toBeHidden()
    } else {
      expect(title).toBe("残りはありません")
      await expect(remaining).toContainText("残りはありません")
      await page.keyboard.press("Escape")
    }
  })
})

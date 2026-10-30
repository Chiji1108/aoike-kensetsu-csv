import { readFileSync } from "node:fs"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { convertFixture, deleteCustomer, open } from "./helpers"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname
const LARGE = new URL("../fixtures/sample-large.xlsx", import.meta.url).pathname
const ROWS = '[data-testid="preview-table"] tbody tr[data-row-key]'

/** 絞り込みごとに、表に出た行が持っているはずのセル */
const FILTER_CELL = {
  error: 'td[data-status="error"]',
  review: 'td[data-status="warning"], td[data-status="ai"]:has(> button[title*="\\a "])',
  changed: 'td[data-changed="1"]',
} as const

const filterButton = (page: Page, f: string) => page.getByTestId("row-filters").locator(`[data-filter="${f}"]`)
/** 絞り込みのボタンの件数。csv は CSV に載せる行、all は表に出る行（載せない行も含む。同じなら出さない） */
async function filterCount(page: Page, f: string, kind: "csv" | "all" = "csv") {
  const button = filterButton(page, f)
  const csv = Number(await button.locator('[data-count="csv"]').textContent())
  if (kind === "csv") return csv
  const all = button.locator('[data-count="all"]')
  return (await all.count()) ? Number(/\d+/.exec((await all.textContent()) ?? "")![0]) : csv
}
const shownCount = async (page: Page) => Number(/\d+/.exec((await page.getByTestId("shown-count").textContent()) ?? "")![0])
const cellText = (td: Locator) => td.locator("button > span").first().textContent()
const rowKeys = (page: Page) => page.locator(ROWS).evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).dataset.rowKey!))
const scrollTable = (page: Page, to: "top" | "bottom" | number) =>
  page.getByTestId("preview-table").evaluate((table, to) => {
    const box = table.parentElement!
    box.scrollTop = to === "top" ? 0 : to === "bottom" ? box.scrollHeight : to
  }, to)

/** 値を引用符で囲む CSV（csvCell）を読む */
function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") row.push(cell), (cell = "")
    else if (ch === "\r" && text[i + 1] === "\n") row.push(cell), rows.push(row), (row = []), (cell = ""), i++
    else cell += ch
  }
  return rows
}

const pageErrors: string[] = []
/** テストで作った顧客（後で消す） */
const created: string[] = []
test.beforeEach(({ page }) => {
  pageErrors.length = 0
  page.on("pageerror", (e) => pageErrors.push(e.message))
})
test.afterEach(async ({ page }) => {
  for (const customer of created.splice(0)) await deleteCustomer(page, customer)
  expect(pageErrors).toEqual([])
})

test("プレビューの表で絞り込み・並べ替え・列の表示・手直し・行の入れ外しをして CSV を書き出す", async ({ page }) => {
  created.push((await convertFixture(page, FIXTURE)).customer)
  const total = await filterCount(page, "all", "all")
  expect(await shownCount(page)).toBe(total)
  await expect(page.locator(ROWS)).toHaveCount(total)

  for (const f of ["error", "review", "changed"] as const) {
    await test.step(`絞り込み: ${f}`, async () => {
      const count = await filterCount(page, f, "all")
      await filterButton(page, f).click()
      await expect(filterButton(page, f)).toHaveAttribute("aria-pressed", "true")
      const rows = page.locator(ROWS)
      await expect(rows).toHaveCount(count)
      expect(await shownCount(page)).toBe(count)
      for (const tr of await rows.all()) await expect(tr.locator(FILTER_CELL[f]).first()).toBeAttached()
      if (count === 0) await expect(page.getByTestId("no-match")).toBeVisible()
    })
  }
  await filterButton(page, "all").click()
  await expect(page.locator(ROWS)).toHaveCount(total)

  await test.step("並べ替え: 請負代金の昇順・降順・元に戻す", async () => {
    const original = await rowKeys(page)
    const header = page.locator("th").filter({ hasText: "請負代金" })
    const amounts = async () =>
      (await Promise.all((await page.locator('td[data-field="amount"]').all()).map(cellText))).map(Number).filter((n) => !Number.isNaN(n))
    await header.getByRole("button").click()
    await expect(header).toHaveAttribute("aria-sort", "ascending")
    const asc = await amounts()
    expect(asc.length).toBeGreaterThan(1)
    expect(asc).toEqual([...asc].sort((a, b) => a - b))
    await header.getByRole("button").click()
    await expect(header).toHaveAttribute("aria-sort", "descending")
    const desc = await amounts()
    expect(desc).toEqual([...desc].sort((a, b) => b - a))
    await header.getByRole("button").click()
    await expect(header).not.toHaveAttribute("aria-sort", /./)
    expect(await rowKeys(page)).toEqual(original)
  })

  await test.step("列の表示: 工事名を隠して戻す", async () => {
    const toggle = async () => {
      await page.getByRole("button", { name: "表示する列" }).click()
      await page.getByRole("menuitemcheckbox", { name: "E 工事名" }).click()
      await page.keyboard.press("Escape")
    }
    await toggle()
    await expect(page.locator('td[data-field="workName"]')).toHaveCount(0)
    await toggle()
    await expect(page.locator('td[data-field="workName"]')).toHaveCount(total)
  })

  const row = page.locator(`${ROWS}[data-included="1"]`).first()
  const key = await row.getAttribute("data-row-key")
  const edited = page.locator(`tr[data-row-key="${key}"]`)

  await test.step("手直し: 場所名を直すと手入力の値になる", async () => {
    await edited.locator('td[data-field="place"] button').click()
    await page.getByLabel("セルの値").fill("テスト市")
    await page.getByLabel("セルの値").press("Enter")
    const td = edited.locator('td[data-field="place"]')
    await expect(td.locator("button")).toHaveAttribute("title", /手入力/)
    expect(await cellText(td)).toBe("テスト市")
    await filterButton(page, "changed").click()
    await expect(edited).toBeVisible()
    await filterButton(page, "all").click()
  })

  await test.step("手直しでエラーにすると、エラーの絞り込みにその行が出る", async () => {
    const before = await filterCount(page, "error")
    await edited.locator('td[data-field="startYm"] button').click()
    await page.getByLabel("セルの値").fill("20231")
    await page.getByLabel("セルの値").press("Enter")
    await expect(edited.locator('td[data-field="startYm"]')).toHaveAttribute("data-status", "error")
    await expect.poll(() => filterCount(page, "error")).toBe(before + 1)
    await filterButton(page, "error").click()
    await expect(edited).toBeVisible()
  })

  await test.step("エラーの絞り込みで直すと、行はその場に残って「条件に合いません」と出て、「更新」で外れる", async () => {
    const keys = await rowKeys(page)
    await edited.locator('td[data-field="startYm"] button').click()
    await page.getByLabel("セルの値").fill("202304")
    await page.getByLabel("セルの値").press("Enter")
    await expect(edited.locator('td[data-field="startYm"]')).not.toHaveAttribute("data-status", "error")
    expect(await rowKeys(page)).toEqual(keys)
    await expect(edited.getByTestId("row-unmatched")).toBeVisible()
    await page.getByTestId("outdated").getByRole("button", { name: "更新" }).click()
    await expect(edited).toHaveCount(0)
    await expect(page.getByTestId("outdated")).toHaveCount(0)
    await filterButton(page, "all").click()
    await edited.locator('td[data-field="startYm"] button').click()
    await page.getByLabel("セルの値").fill("20231")
    await page.getByLabel("セルの値").press("Enter")
    await expect(edited.locator('td[data-field="startYm"]')).toHaveAttribute("data-status", "error")
  })

  const download = page.getByTestId("download-button")
  const countOf = async () => Number(/（(\d+)件/.exec((await download.textContent()) ?? "")![1])
  const before = await countOf()

  await test.step("行の入れ外し: 外すと CSV の件数が減り、戻すと増える", async () => {
    const other = page.locator(`${ROWS}[data-included="1"]:not([data-row-key="${key}"])`).first()
    const otherKey = await other.getAttribute("data-row-key")
    const box = page.locator(`tr[data-row-key="${otherKey}"]`).getByRole("checkbox", { name: "CSVに載せる" })
    await box.click()
    await expect(page.locator(`tr[data-row-key="${otherKey}"]`)).toHaveAttribute("data-included", "0")
    expect(await countOf()).toBe(before - 1)
    await box.click()
    await expect(page.locator(`tr[data-row-key="${otherKey}"]`)).toHaveAttribute("data-included", "1")
    await expect(page.locator(`tr[data-row-key="${otherKey}"] td`).first()).toContainText("手動")
    expect(await countOf()).toBe(before)
  })

  await test.step("CSV: CP932・CRLF・14列で、手直しが入っている", async () => {
    const downloading = page.waitForEvent("download")
    await expect(download).toContainText("エラー")
    await download.click()
    const confirm = page.getByRole("alertdialog")
    await expect(confirm).toBeVisible()
    await confirm.getByRole("button", { name: "このままダウンロード" }).click()
    await expect(confirm).toBeHidden()
    const file = await (await downloading).path()
    const bytes = readFileSync(file)
    const text = new TextDecoder("shift_jis", { fatal: true }).decode(bytes)
    expect(text.endsWith("\r\n")).toBe(true)
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/)
    const lines = parseCsv(text)
    expect(lines).toHaveLength(before)
    for (const l of lines) expect(l).toHaveLength(14)
    expect(lines.some((l) => l[6] === "テスト市" && l[10] === "20231")).toBe(true)
  })
})

test("行の多い表: 仮想スクロールの先でも絞り込み・検索・並べ替え・手直しができ、手直しの下書きはスクロールで消えない", async ({ page }) => {
  created.push((await convertFixture(page, LARGE)).customer)
  await page.getByRole("switch", { name: "記載順に並べ替え" }).click()
  await expect(page.locator(`${ROWS}[data-index="0"]`)).toHaveAttribute("data-row-key", "工事経歴!3")
  // データ行の範囲は AI の計画で決まり、最後の行を外すことがあるので、行数とキーは画面から読む
  const total = await filterCount(page, "all", "all")
  expect(total).toBeGreaterThanOrEqual(239)
  expect(await shownCount(page)).toBe(total)
  const rendered = await page.locator(ROWS).count()
  expect(rendered).toBeLessThan(100)
  const errors = await filterCount(page, "error", "all")
  expect(errors).toBeGreaterThanOrEqual(7)
  let lastKey = ""
  let nextToLastKey = ""

  await test.step("スクロール: 最後の行まで出る", async () => {
    await scrollTable(page, "bottom")
    const last = page.locator(`${ROWS}[data-index="${total - 1}"]`)
    await expect(last).toBeVisible()
    lastKey = (await last.getAttribute("data-row-key"))!
    nextToLastKey = (await page.locator(`${ROWS}[data-index="${total - 2}"]`).getAttribute("data-row-key"))!
    await expect(page.locator(`${ROWS}[data-row-key="工事経歴!3"]`)).toHaveCount(0)
    await scrollTable(page, "top")
    await expect(page.locator(`${ROWS}[data-row-key="工事経歴!3"]`)).toBeVisible()
  })

  await test.step("件数: 金額がエラーの行は7割の選択で CSV に載らないので、エラーの件数は0で、かっこ内に表の行数が出る", async () => {
    await expect(page.getByTestId("download-button")).not.toContainText("エラー")
    expect(await filterCount(page, "error")).toBe(0)
  })

  await test.step("絞り込み: エラーの行は、すべて金額がエラー", async () => {
    await filterButton(page, "error").click()
    await expect(page.locator(ROWS)).toHaveCount(errors)
    for (const tr of await page.locator(ROWS).all()) await expect(tr.locator('td[data-field="amount"]')).toHaveAttribute("data-status", "error")
    await filterButton(page, "all").click()
  })

  await test.step("検索: 表に出ている列の文字で絞り込み、絞り込みのボタンと組み合わさる", async () => {
    const search = page.getByLabel("表の中を検索")
    await search.fill("第123倉庫")
    await expect.poll(() => shownCount(page)).toBe(1)
    await expect(page.locator(ROWS)).toHaveCount(1)
    await expect(page.locator(ROWS).locator('td[data-field="workName"]')).toContainText("サンプル第123倉庫改修工事")
    await search.fill("第30倉庫")
    await filterButton(page, "error").click()
    await expect.poll(() => shownCount(page)).toBe(1)
    await search.fill("第31倉庫")
    await expect(page.getByTestId("no-match")).toContainText("「第31倉庫」を含む")
    await filterButton(page, "all").click()
    await search.fill("第123倉庫")
    await page.getByRole("button", { name: "表示する列" }).click()
    await page.getByRole("menuitemcheckbox", { name: "E 工事名" }).click()
    await page.keyboard.press("Escape")
    await expect.poll(() => shownCount(page)).toBe(0)
    await page.getByRole("button", { name: "表示する列" }).click()
    await page.getByRole("menuitemcheckbox", { name: "E 工事名" }).click()
    await page.keyboard.press("Escape")
    await search.fill("")
    await expect.poll(() => shownCount(page)).toBe(total)
  })

  await test.step("並べ替え: 請負代金の降順は、スクロールした先まで降順", async () => {
    const header = page.locator("th").filter({ hasText: "請負代金" })
    await header.getByRole("button").click()
    await header.getByRole("button").click()
    await expect(header).toHaveAttribute("aria-sort", "descending")
    const amounts = async () =>
      (await page.locator('td[data-field="amount"] > button > span:first-child').evaluateAll((spans) => spans.map((s) => Number(s.textContent)))).filter(
        (n) => !Number.isNaN(n),
      )
    const top = await amounts()
    await scrollTable(page, "bottom")
    await expect(page.locator(`${ROWS}[data-index="${total - 1}"]`)).toBeVisible()
    await expect(page.locator(`${ROWS}[data-index="0"]`)).toHaveCount(0)
    const bottom = await amounts()
    const all = [...top, ...bottom]
    expect(bottom.length).toBeGreaterThan(1)
    expect(all).toEqual([...all].sort((a, b) => b - a))
    await header.getByRole("button").click()
    await expect(header).not.toHaveAttribute("aria-sort", /./)
    await scrollTable(page, "top")
  })

  const placeOf = (key: string) => page.locator(`tr[data-row-key="${key}"] td[data-field="place"]`)

  await test.step("手直し: 最初の画面より先の行を直せる", async () => {
    await scrollTable(page, "bottom")
    const td = placeOf(lastKey)
    await td.locator("button").click()
    await page.getByLabel("セルの値").fill("テスト町")
    await page.getByLabel("セルの値").press("Enter")
    await expect(td.locator("button")).toHaveAttribute("title", /手入力/)
    expect(await cellText(td)).toBe("テスト町")
    await scrollTable(page, "top")
  })

  await test.step("下書き: 手直しの途中でスクロールして戻っても入力が残り、Enter で確定する", async () => {
    const td = placeOf("工事経歴!3")
    await td.locator("button").click()
    await page.getByLabel("セルの値").fill("下書きの町")
    await scrollTable(page, "bottom")
    await expect(page.getByLabel("セルの値")).toHaveCount(0)
    await scrollTable(page, "top")
    await expect(page.getByLabel("セルの値")).toHaveValue("下書きの町")
    await page.getByLabel("セルの値").press("Enter")
    await expect(td.locator("button")).toHaveAttribute("title", /手入力/)
    expect(await cellText(td)).toBe("下書きの町")
  })

  await test.step("下書き: スクロールで隠れたまま別のセルを直し始めると、前の下書きを確定する", async () => {
    await placeOf("工事経歴!4").locator("button").click()
    await page.getByLabel("セルの値").fill("隠れた下書き")
    await scrollTable(page, "bottom")
    await expect(page.getByLabel("セルの値")).toHaveCount(0)
    await placeOf(nextToLastKey).locator("button").click()
    await page.getByLabel("セルの値").press("Escape")
    await scrollTable(page, "top")
    await expect(placeOf("工事経歴!4").locator("button > span").first()).toHaveText("隠れた下書き")
    await expect(placeOf("工事経歴!4").locator("button")).toHaveAttribute("title", /手入力/)
  })

  await test.step("絞り込みの中で直してもその場に残り、「更新」で外れる", async () => {
    await filterButton(page, "error").click()
    const key = "工事経歴!32"
    const amount = page.locator(`tr[data-row-key="${key}"] td[data-field="amount"]`)
    await amount.locator("button").click()
    await page.getByLabel("セルの値").fill("5000")
    await page.getByLabel("セルの値").press("Enter")
    await expect(amount).not.toHaveAttribute("data-status", "error")
    await expect(page.locator(ROWS)).toHaveCount(errors)
    await expect(page.locator(`tr[data-row-key="${key}"]`).getByTestId("row-unmatched")).toBeVisible()
    await expect.poll(() => filterCount(page, "error", "all")).toBe(errors - 1)
    await page.getByTestId("outdated").getByRole("button", { name: "更新" }).click()
    await expect(page.locator(ROWS)).toHaveCount(errors - 1)
  })
})

test("メニューからパスワード変更のダイアログを開いて閉じる", async ({ page }) => {
  await open(page, "/")
  await page.getByRole("button", { name: "メニュー" }).click()
  await page.getByRole("menuitem", { name: "パスワード変更" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

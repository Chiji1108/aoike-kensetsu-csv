import { readFileSync } from "node:fs"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { convertFixture, csvCount, deleteCustomer, open, showAllRows } from "./helpers"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname
const LARGE = new URL("../fixtures/sample-large.xlsx", import.meta.url).pathname
const ROWS = '[data-testid="preview-table"] tbody tr[data-row-key]'

const filterButton = (page: Page, f: "fix" | "all") => page.getByTestId(`row-filters-${f}`)
/** 絞り込みの件数（直すは CSV に載せる行だけ。すべては表の全行） */
const filterCount = async (page: Page, f: "fix" | "all") => Number(/(\d+)\s*$/.exec((await filterButton(page, f).textContent()) ?? "")![1])
/** 選んだセルの注意書き（表の上の1行） */
const cellNote = (page: Page) => page.getByTestId("cell-note")
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
  await test.step("はじめは直す（CSV に載せる行のうち、職員が直すセル: 必須が空・エラー・要確認・AI の推定のある行）だけを出し、行に理由を出す。載せない行は出さない", async () => {
    await expect(filterButton(page, "fix")).toHaveAttribute("aria-pressed", "true")
    const check = await filterCount(page, "fix")
    expect(check).toBeGreaterThan(0)
    await expect(page.locator(ROWS)).toHaveCount(check)
    for (const tr of await page.locator(ROWS).all()) {
      await expect(tr).toHaveAttribute("data-included", "1")
      await expect(tr.getByTestId("row-fix")).toBeVisible()
    }
    // 作業の画面の上の次にやることの「直す」も同じ数
    await expect(page.getByTestId("next-step-fix")).toContainText(String(check))
  })
  const checkKeys = await rowKeys(page)
  await showAllRows(page)
  const total = await filterCount(page, "all")
  await expect(page.locator(ROWS)).toHaveCount(total)
  // 載せない行は「すべて」でだけ見える
  await expect(page.locator(`${ROWS}[data-included="0"]`).first()).toBeAttached()

  await test.step("注意書きはセルの下に出さず、セルを選ぶ（キーボードでも）と表の上に出る", async () => {
    await expect(page.locator('[data-testid="preview-table"] td .line-clamp-2')).toHaveCount(0)
    const colored = page.locator(`${ROWS} td[data-status="warning"] button, ${ROWS} td[data-status="ai"] button`).first()
    await colored.focus()
    await expect(cellNote(page)).toHaveAttribute("data-status", /warning|ai/)
    await expect(colored).toHaveAttribute("aria-describedby", "preview-cell-note")
    // マウスを乗せただけのセルは、注意書きを出しても説明につながない（読み上げは選んだときだけ）
    const other = page.locator(`${ROWS} td[data-field="workName"] button`).first()
    await other.hover()
    await expect(cellNote(page)).toContainText("工事名")
    await expect(other).not.toHaveAttribute("aria-describedby", /./)
    await expect(page.getByTestId("cell-note")).not.toHaveAttribute("aria-live", /./)
  })

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
      await page.getByRole("menuitemcheckbox", { name: "工事名" }).click()
      await page.keyboard.press("Escape")
    }
    await toggle()
    await expect(page.locator('td[data-field="workName"]')).toHaveCount(0)
    await toggle()
    await expect(page.locator('td[data-field="workName"]')).toHaveCount(total)
  })

  // 直すに入っていない、載せる行を直す
  const key = (await page.locator(`${ROWS}[data-included="1"]`).evaluateAll((trs, skip) => trs.map((tr) => (tr as HTMLElement).dataset.rowKey!).find((k) => !skip.includes(k)), checkKeys))!
  expect(key).toBeTruthy()
  const edited = page.locator(`tr[data-row-key="${key}"]`)

  await test.step("手直し: 場所名を直すと手入力の値になる", async () => {
    await edited.locator('td[data-field="place"] button').click()
    await page.getByLabel("セルの値").fill("テスト市")
    await page.getByLabel("セルの値").press("Enter")
    const td = edited.locator('td[data-field="place"]')
    await expect(td).toHaveAttribute("data-changed", "1")
    await expect(cellNote(page)).toContainText("手入力")
    expect(await cellText(td)).toBe("テスト市")
  })

  await test.step("手直しでエラーにすると、直すにその行が出て、理由に「エラー」が出る", async () => {
    const before = await filterCount(page, "fix")
    await edited.locator('td[data-field="startYm"] button').click()
    await page.getByLabel("セルの値").fill("20231")
    await page.getByLabel("セルの値").press("Enter")
    await expect(edited.locator('td[data-field="startYm"]')).toHaveAttribute("data-status", "error")
    await expect.poll(() => filterCount(page, "fix")).toBe(before + 1)
    await filterButton(page, "fix").click()
    await expect(edited).toBeVisible()
    await expect(edited.getByTestId("row-fix")).toContainText("着工年月: エラー")
    // 理由で絞れる
    await page.getByTestId("fix-reason-error").click()
    await expect(edited).toBeVisible()
    await page.getByTestId("fix-reason-error").click()
  })

  await test.step("直すの中で直すと、行はその場に残って「条件に合いません」と出て、「更新」で外れる", async () => {
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

  const countOf = () => csvCount(page)
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

  await test.step("CSV（控え）: 書き出す前の確認にエラーの残りが出て、止めずに書ける。CP932・CRLF・14列で、手直しが入っている", async () => {
    await page.getByTestId("export-button").click()
    const dialog = page.getByTestId("export-dialog")
    await expect(dialog.getByTestId("export-rows")).toHaveText(String(before))
    await expect(dialog.getByTestId("export-errors")).toHaveAttribute("data-ok", "0")
    const downloading = page.waitForEvent("download")
    await dialog.getByTestId("download-button").click()
    const file = await (await downloading).path()
    await page.keyboard.press("Escape")
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
  await showAllRows(page)
  // データ行の範囲は AI の計画で決まり、最後の行を外すことがあるので、行数とキーは画面から読む
  const total = await filterCount(page, "all")
  expect(total).toBeGreaterThanOrEqual(239)
  const rendered = await page.locator(ROWS).count()
  expect(rendered).toBeLessThan(100)
  const keyAt = async (i: number) => (await page.locator(`${ROWS}[data-index="${i}"]`).getAttribute("data-row-key"))!
  const firstKey = await keyAt(0)
  const secondKey = await keyAt(1)
  let lastKey = ""
  let nextToLastKey = ""

  await test.step("スクロール: 最後の行まで出る", async () => {
    await scrollTable(page, "bottom")
    const last = page.locator(`${ROWS}[data-index="${total - 1}"]`)
    await expect(last).toBeVisible()
    lastKey = (await last.getAttribute("data-row-key"))!
    nextToLastKey = await keyAt(total - 2)
    await expect(page.locator(`${ROWS}[data-row-key="${firstKey}"]`)).toHaveCount(0)
    await scrollTable(page, "top")
    await expect(page.locator(`${ROWS}[data-row-key="${firstKey}"]`)).toBeVisible()
  })

  const search = page.getByLabel("表の中を検索")
  await test.step("直すは載せる行だけ: 金額がエラーの行は7割の選択で載らないので、直すには出ず、すべてでだけ見える", async () => {
    await search.fill("第30倉庫")
    await expect(page.locator(ROWS)).toHaveCount(1)
    await expect(page.locator(ROWS).locator('td[data-field="amount"]')).toHaveAttribute("data-status", "error")
    await expect(page.locator(ROWS)).toHaveAttribute("data-included", "0")
    await filterButton(page, "fix").click()
    await expect(page.getByTestId("no-match")).toContainText("「第30倉庫」を含む直す行")
    expect(await filterCount(page, "fix")).toBeLessThan(total)
    await search.fill("")
    for (const tr of await page.locator(ROWS).all()) await expect(tr).toHaveAttribute("data-included", "1")
    await filterButton(page, "all").click()
  })

  await test.step("検索: 表に出ている列の文字で絞り込む", async () => {
    await search.fill("第123倉庫")
    await expect(page.locator(ROWS)).toHaveCount(1)
    await expect(page.locator(ROWS).locator('td[data-field="workName"]')).toContainText("サンプル第123倉庫改修工事")
    await search.fill("第31倉庫")
    await filterButton(page, "fix").click()
    await expect(page.getByTestId("no-match")).toContainText("「第31倉庫」を含む")
    await filterButton(page, "all").click()
    await search.fill("第123倉庫")
    await page.getByRole("button", { name: "表示する列" }).click()
    await page.getByRole("menuitemcheckbox", { name: "工事名" }).click()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("no-match")).toBeVisible()
    await page.getByRole("button", { name: "表示する列" }).click()
    await page.getByRole("menuitemcheckbox", { name: "工事名" }).click()
    await page.keyboard.press("Escape")
    await search.fill("")
    await expect(page.locator(`${ROWS}[data-row-key="${firstKey}"]`)).toBeVisible()
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
    await expect(cellNote(page)).toContainText("手入力")
    expect(await cellText(td)).toBe("テスト町")
    await scrollTable(page, "top")
  })

  await test.step("下書き: 手直しの途中でスクロールして戻っても入力が残り、Enter で確定する", async () => {
    const td = placeOf(firstKey)
    await td.locator("button").click()
    await page.getByLabel("セルの値").fill("下書きの町")
    await scrollTable(page, "bottom")
    await expect(page.getByLabel("セルの値")).toHaveCount(0)
    await scrollTable(page, "top")
    await expect(page.getByLabel("セルの値")).toHaveValue("下書きの町")
    await page.getByLabel("セルの値").press("Enter")
    await expect(td).toHaveAttribute("data-changed", "1")
    expect(await cellText(td)).toBe("下書きの町")
  })

  await test.step("下書き: スクロールで隠れたまま別のセルを直し始めると、前の下書きを確定する", async () => {
    await placeOf(secondKey).locator("button").click()
    await page.getByLabel("セルの値").fill("隠れた下書き")
    await scrollTable(page, "bottom")
    await expect(page.getByLabel("セルの値")).toHaveCount(0)
    await placeOf(nextToLastKey).locator("button").click()
    await page.getByLabel("セルの値").press("Escape")
    await scrollTable(page, "top")
    await expect(placeOf(secondKey).locator("button > span").first()).toHaveText("隠れた下書き")
    await placeOf(secondKey).locator("button").hover()
    await expect(cellNote(page)).toContainText("手入力")
  })

  await test.step("検索の中で直してもその場に残り、「更新」で外れる", async () => {
    await search.fill("第123倉庫")
    const row = page.locator(ROWS).first()
    const key = (await row.getAttribute("data-row-key"))!
    const work = page.locator(`tr[data-row-key="${key}"] td[data-field="workName"]`)
    await work.locator("button").click()
    await page.getByLabel("セルの値").fill("サンプル倉庫改修工事")
    await page.getByLabel("セルの値").press("Enter")
    await expect(page.locator(ROWS)).toHaveCount(1)
    await expect(page.locator(`tr[data-row-key="${key}"]`).getByTestId("row-unmatched")).toBeVisible()
    await page.getByTestId("outdated").getByRole("button", { name: "更新" }).click()
    await expect(page.locator(ROWS)).toHaveCount(0)
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

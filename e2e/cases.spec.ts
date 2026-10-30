import { execFileSync } from "node:child_process"
import { expect, test, type Page } from "@playwright/test"
import { attachAndConvert, callsServerFn, confirmDelete, deleteCustomer, open, openNewCase, reload, showAllRows } from "./helpers"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname
const ROWS = '[data-testid="preview-table"] tbody tr[data-row-key]'
/** 合成の1ページの PDF（中身は読まない。保存と一覧だけを確かめる） */
const PDF = { name: "追加の工事.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n") }

/** 手元の R2（wrangler の local。開発サーバーと同じ .wrangler/state）にキーがあるか */
function inLocalR2(key: string) {
  try {
    execFileSync("bunx", ["wrangler", "r2", "object", "get", `aoike-kensetsu-csv-files/${key}`, "--local", "--pipe"], { stdio: ["ignore", "ignore", "ignore"] })
    return true
  } catch {
    return false
  }
}

async function waitSaved(page: Page) {
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "pending")
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved", { timeout: 30_000 })
}

const pageErrors: string[] = []
test.beforeEach(({ page }) => {
  pageErrors.length = 0
  page.on("pageerror", (e) => pageErrors.push(e.message))
})
test.afterEach(() => {
  expect(pageErrors).toEqual([])
})

test("顧客と案件を作り、変換と手直しを保存して再読み込みで続きから開き、案件と顧客を消すと何も残らない", async ({ page }) => {
  const { customer, caseUrl } = await openNewCase(page)
  const caseId = caseUrl.split("/").pop()!

  await test.step("Excel を付けると変換の元になり、変換できる", async () => {
    await attachAndConvert(page, FIXTURE)
    await expect(page.locator('[data-testid="file-list"] [data-file="sample-messy.xlsx"]')).toContainText("変換の元")
    await showAllRows(page)
  })

  const first = page.locator(ROWS).first()
  const key = (await first.getAttribute("data-row-key"))!
  const row = page.locator(`tr[data-row-key="${key}"]`)
  const other = page.locator(`${ROWS}[data-included="1"]`).nth(1)
  const otherKey = (await other.getAttribute("data-row-key"))!

  await test.step("手直しと行の外しを保存する", async () => {
    await row.locator('td[data-field="place"] button').click()
    await page.getByLabel("セルの値").fill("保存テスト市")
    await page.getByLabel("セルの値").press("Enter")
    await expect(row.locator('td[data-field="place"]')).toContainText("保存テスト市")
    await waitSaved(page)
    await page.locator(`tr[data-row-key="${otherKey}"]`).getByRole("checkbox", { name: "CSVに載せる" }).click()
    await expect(page.locator(`tr[data-row-key="${otherKey}"]`)).toHaveAttribute("data-included", "0")
    await waitSaved(page)
  })

  await test.step("再読み込みしても手直しと選択が残る（AI を呼ばずに保存した結果から開く）", async () => {
    const aiCalls: string[] = []
    page.on("request", (r) => {
      if (callsServerFn(r.url(), ["planWithAi", "runAiBatch"])) aiCalls.push(r.url())
    })
    await reload(page)
    await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
    await showAllRows(page)
    await expect(page.locator(`tr[data-row-key="${key}"] td[data-field="place"]`)).toContainText("保存テスト市")
    await expect(page.locator(`tr[data-row-key="${otherKey}"]`)).toHaveAttribute("data-included", "0")
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved")
    expect(aiCalls).toEqual([])
  })

  await test.step("PDF を付けると一覧に出て、変換の元は変わらない", async () => {
    await page.getByTestId("file-input").setInputFiles(PDF)
    const pdf = page.locator(`[data-testid="file-list"] [data-file="${PDF.name}"]`)
    await expect(pdf).toBeVisible()
    await expect(pdf).not.toContainText("変換の元")
    await expect(page.getByTestId("current-source")).toHaveCount(1)
    const res = await page.request.get((await pdf.getByRole("link").getAttribute("href"))!)
    expect(res.status()).toBe(200)
    expect(Buffer.from(await res.body()).equals(PDF.buffer)).toBe(true)
  })

  const hrefs = await page.locator('[data-testid="file-list"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href")!))
  expect(hrefs).toHaveLength(2)

  await test.step("ファイルはいつも保存させ、種類は名前から決める（送り手の種類で HTML として開かせない）", async () => {
    const pdfRes = await page.request.get(hrefs[1]!)
    expect(pdfRes.headers()).toMatchObject({ "content-type": "application/pdf", "x-content-type-options": "nosniff" })
    expect(pdfRes.headers()["content-disposition"]).toMatch(/^attachment;/)
    const html = await page.request.post(`/api/cases/${caseId}/files`, {
      headers: { "x-file-kind": "source", "x-file-name": encodeURIComponent("合成.html"), "content-type": "text/html" },
      data: "<script>alert(1)</script>",
    })
    expect(html.status()).toBe(200)
    const htmlRes = await page.request.get(`/api/files/${(await html.json()).id}`)
    expect(htmlRes.headers()).toMatchObject({ "content-type": "application/octet-stream", "x-content-type-options": "nosniff" })
    expect(htmlRes.headers()["content-disposition"]).toMatch(/^attachment;/)
  })

  await test.step("大きさ（Content-Length）の無いアップロードは断る", async () => {
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ")
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("大きさの分からない本文"))
        c.close()
      },
    })
    const res = await fetch(new URL(`/api/cases/${caseId}/files`, caseUrl), {
      method: "POST",
      headers: { cookie, "x-file-kind": "source", "x-file-name": encodeURIComponent("長さ無し.pdf") },
      body,
      duplex: "half",
    } as RequestInit)
    expect(res.status).toBe(411)
  })

  await test.step("ログインしていなければファイルを読めない", async () => {
    const anonymous = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } })
    expect((await anonymous.request.get(new URL(hrefs[0]!, caseUrl).href)).status()).toBe(401)
    await anonymous.close()
  })

  await test.step("案件を消すと、D1 の行も R2 のファイルも残らない", async () => {
    await reload(page)
    const all = await page.locator('[data-testid="file-list"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href")!))
    expect(all).toHaveLength(3)
    const keys = all.map((h) => `cases/${caseId}/${h.split("/").pop()}`)
    expect(keys.map(inLocalR2)).toEqual([true, true, true])
    await page.getByTestId("delete-button").click()
    await expect(page.getByRole("alertdialog").getByTestId("delete-counts")).toContainText("案件 1 件と、付けたファイル 3 件")
    await confirmDelete(page, customer)
    await expect(page.getByRole("heading", { name: customer })).toBeVisible()
    await expect(page.getByTestId("case-list")).toHaveCount(0)
    for (const h of all) expect((await page.request.get(h)).status()).toBe(404)
    expect(keys.map(inLocalR2)).toEqual([false, false, false])
    expect((await page.request.get(caseUrl)).status()).toBe(404)
  })

  await test.step("顧客を消す", async () => {
    await deleteCustomer(page, customer)
  })
})

test("列の対応を考えている途中で閉じても、開き直すと変換の元が残っていて考え直し、そのまま変換する", async ({ page }) => {
  const { customer } = await openNewCase(page)
  // AI の計画の返事を止め、考えている途中のまま保存させる
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), () => {})
  await page.getByTestId("file-input").setInputFiles(FIXTURE)
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "planning")
  await expect(page.getByTestId("report-progress")).toContainText("考えています")
  await waitSaved(page)
  await page.unrouteAll({ behavior: "ignoreErrors" })

  const replanned = page.waitForRequest((r) => callsServerFn(r.url(), ["planWithAi"]))
  await reload(page)
  await replanned
  await expect(page.getByTestId("current-source")).toBeVisible()
  // 「変換する」のボタンは無い。考え終えると自動で変換する
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")
  await deleteCustomer(page, customer)
})

test("全体ルールと顧客ルールを保存して、開き直しても残る", async ({ page }) => {
  await open(page, "/rules")
  const rule = `全体ルールE2E-${Date.now()}`
  await page.getByTestId("global-rules-text").fill(rule)
  await page.getByTestId("global-rules-save").click()
  await expect(page.getByTestId("global-rules-save")).toBeDisabled()
  await reload(page)
  await expect(page.getByTestId("global-rules-text")).toHaveValue(rule)

  const { customer } = await openNewCase(page)
  await page.getByRole("link", { name: customer }).click()
  await page.getByTestId("customer-rules-text").fill("備考に「除外」とある行は載せない")
  await page.getByTestId("customer-rules-save").click()
  await expect(page.getByTestId("customer-rules-save")).toBeDisabled()
  await reload(page)
  await expect(page.getByTestId("customer-rules-text")).toHaveValue("備考に「除外」とある行は載せない")
  await deleteCustomer(page, customer)
})


test("ブラウザで同梱の住所データを読み、住所を都道府県・市区町村に分ける（@geolonia/normalize-japanese-addresses）", async ({ page }) => {
  await open(page, "/")
  const book = await page.evaluate(async () => {
    // 開発サーバーはソースのモジュールをそのまま返す（画面の変換と同じモジュール）
    const path = "/src/lib/convert/address.ts"
    const m = (await import(/* @vite-ignore */ path)) as typeof import("../src/lib/convert/address")
    return [...(await m.lookupAddresses(["東京都千代田区丸の内1-1", "千葉県花見川区幕張町", "長野原町大字長野原"], new URL(m.ADDRESS_API_PATH, location.origin).href))]
  })
  expect(Object.fromEntries(book)).toEqual({
    "東京都千代田区丸の内1-1": { prefecture: "東京都", city: "千代田区" },
    千葉県花見川区幕張町: { prefecture: "千葉県", city: "千葉市花見川区" },
    長野原町大字長野原: { city: "吾妻郡長野原町" },
  })
})

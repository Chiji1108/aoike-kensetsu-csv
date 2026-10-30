import { spawnSync } from "node:child_process"
import { expect, test, type Page } from "@playwright/test"
import { attachAndConvert, callsServerFn, deleteCustomer, downloadCsv, open, openNewCase, openTab, reload, showAllRows } from "./helpers"

/**
 * 工事場所の調査: 住所のほとんど無い合成の Excel で、調べる → 進み具合 → 変更案 → 承認 → 表と CSV。
 * 裏の処理（Workflow）は開発サーバーで本当に動かす。本物の AI と Web 検索は E2E_LIVE_AI=1 のときだけ
 * （ふだんは顧客の覚えた結果を先に D1 に入れておき、覚えた結果だけで終わる回を確かめる）
 */

const FIXTURE = new URL("../fixtures/sample-no-address.xlsx", import.meta.url).pathname
const SKYTREE = { workName: "東京スカイツリー照明設備改修工事", client: "東武タワースカイツリー株式会社" }
const REDBRICK = { workName: "横浜赤レンガ倉庫空調設備更新工事", client: "横浜市" }

const sqlText = (s: string) => `'${s.replaceAll("'", "''")}'`

/** 開発サーバーの D1（ローカル）に、顧客の覚えた結果を入れる（前の年度に承認した結果の代わり） */
function seedMemory(customer: string, items: { workName: string; client: string; prefecture: string; place: string; url: string }[]) {
  const values = items
    .map(
      (i) =>
        `select id, ${sqlText(i.workName)} || char(9) || ${sqlText(i.client)}, ${sqlText(i.workName)}, ${sqlText(i.client)}, ${sqlText(i.prefecture)}, ${sqlText(i.place)}, ${sqlText(JSON.stringify([i.url]))}, 'search', 1, '', 'seed', 0 from csv_customers where name = ${sqlText(customer)}`,
    )
    .join(" union all ")
  const sql = `insert into csv_location_memory (customer_id, site_key, work_name, client, prefecture, place, urls, source, confident, note, case_id, updated_at) ${values}`
  const r = spawnSync("bunx", ["wrangler", "d1", "execute", "DB", "--local", "--command", sql], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`覚えた結果を入れられませんでした: ${r.stderr}`)
}


/**
 * 変換して全件を載せる（同じ現場の2行が両方 CSV に載るように）。列の対応は見出しからの推定にする（計画の AI を断る）。
 * 施工場所の列を住所として読むので、施工場所の空いた行の都道府県が空になり、調べる現場が決まる
 */
async function convertAll(page: Page) {
  await page.route((url) => callsServerFn(url.href, ["planWithAi"]), (route) => route.fulfill({ status: 500, body: "計画の AI を使わない" }))
  await attachAndConvert(page, FIXTURE)
  await page.unrouteAll({ behavior: "ignoreErrors" })
  await page.getByTestId("selection-all").click()
  await openTab(page, "location")
  await expect(page.getByTestId("location-count")).toContainText("件", { timeout: 30_000 })
}

/** 調べ始めて、終わるまで待つ。終わった回の文を返す。progress なら進み具合（N件中M件）が出るのも確かめる */
async function runSearch(page: Page, { progress = false } = {}) {
  const panel = page.getByTestId("location-panel")
  await expect(panel.getByTestId("location-start")).toBeEnabled({ timeout: 30_000 })
  await panel.getByTestId("location-start").click()
  if (progress) await expect(panel.getByTestId("location-progress")).toContainText(/\d+件中\d+件/)
  await expect(panel.getByTestId("location-last")).toBeVisible({ timeout: 600_000 })
  return (await panel.getByTestId("location-last").textContent()) ?? ""
}

const saved = (page: Page) => expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved", { timeout: 30_000 })

async function approveAll(page: Page, { links }: { links: boolean }) {
  const card = page.getByTestId("location-panel").getByTestId("proposal")
  await expect(card).toBeVisible()
  await card.getByTestId("proposal-open").click()
  const dialog = page.getByTestId("proposal-dialog")
  await expect(dialog.getByTestId("proposal-item").first()).toBeVisible()
  if (links) await expect(dialog.getByTestId("proposal-link").first()).toHaveAttribute("href", /^https:\/\//)
  await page.keyboard.press("Escape")
  await card.getByTestId("proposal-apply-all").click()
  await expect(page.getByTestId("location-panel").getByTestId("proposal")).toHaveCount(0)
}

const created: string[] = []
test.afterEach(async ({ page }) => {
  for (const customer of created.splice(0)) await deleteCustomer(page, customer)
})

test("覚えた結果で調べる → 進み具合 → 変更案 → 承認 → 表と CSV。個人名の現場は調べずに問い合わせへ。開き直しても決めた変更案は戻らない", async ({ page }) => {
  const { customer, caseUrl } = await openNewCase(page)
  created.push(customer)
  await convertAll(page)
  seedMemory(customer, [
    { ...SKYTREE, prefecture: "東京都", place: "墨田区", url: "https://example.com/skytree" },
    { ...REDBRICK, prefecture: "神奈川県", place: "横浜市中区", url: "https://example.com/redbrick" },
  ])
  // 覚えた結果を読み直すため開き直す
  await saved(page)
  await reload(page)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 120_000 })
  await openTab(page, "location")
  const count = page.getByTestId("location-count")
  await expect(count).toContainText("前の年度に承認した結果 2 件")
  await expect(count).toContainText("個人名などで調べない 1 件")

  const last = await runSearch(page)
  expect(last).toContain("3件中3件")
  expect(last).toContain("Web 検索 0 回")
  const card = page.getByTestId("location-panel").getByTestId("proposal")
  await expect(card).toContainText("工事場所 2現場")
  // 変更案を決めるまで、次の調査は始められない（同じ現場を二重に調べない）
  await expect(page.getByTestId("location-start")).toBeDisabled()
  await expect(card).toContainText("問い合わせ 1")
  await approveAll(page, { links: true })

  await showAllRows(page)
  const table = page.getByTestId("preview-table")
  await expect(table).toContainText("墨田区")
  await expect(table).toContainText("横浜市中区")
  const csv = await downloadCsv(page)
  const lines = csv.split(/\r?\n/)
  const skytree = lines.filter((l) => l.includes("東京スカイツリー"))
  expect(skytree).toHaveLength(2)
  for (const l of skytree) expect(l).toContain(",東京都,墨田区,")
  expect(lines.find((l) => l.includes("赤レンガ"))).toContain(",神奈川県,横浜市中区,")

  // 承認したので、もう調べる現場は個人名の1件だけ。開き直しても変更案は戻らない
  await saved(page)
  await open(page, caseUrl)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId("location-panel").getByTestId("proposal")).toHaveCount(0)
  await showAllRows(page)
  await expect(page.getByTestId("preview-table")).toContainText("墨田区")
})

/** 本物の AI と Web 検索（E2E_LIVE_AI=1 のときだけ。費用は1回 $0.2 ほど） */
test("本物の検索で調べて承認すると、翌年度の案件では覚えた結果を使い、検索しない", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_AI !== "1", "E2E_LIVE_AI=1 のときだけ")
  const { customer } = await openNewCase(page, "2025")
  created.push(customer)
  await convertAll(page)
  const first = await runSearch(page, { progress: true })
  expect(first).toContain("件中")
  await approveAll(page, { links: false })
  await saved(page)
  await showAllRows(page)
  await expect(page.getByTestId("preview-table")).toContainText("東京都")

  // 同じ顧客の翌年度
  await page.getByRole("link", { name: customer }).click()
  await page.getByLabel("年度").fill("2026")
  await page.getByTestId("create-case").click()
  await expect(page.getByRole("heading", { name: `${customer} 2026年度` })).toBeVisible()
  await convertAll(page)
  await expect(page.getByTestId("location-count")).toContainText(/前の年度に承認した結果 [12] 件/)
  const second = await runSearch(page)
  expect(second).toContain("Web 検索 0 回")
})

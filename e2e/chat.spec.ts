import { expect, test, type Page, type Route } from "@playwright/test"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ChatMetadata } from "../src/lib/chat/messages"
import type { ChatChange, Proposal } from "../src/lib/chat/proposals"
import { callsServerFn, convertFixture, csvCount, deleteCustomer, downloadCsv, open, openNewCase, reload, showAllRows } from "./helpers"
import { syntheticPdf } from "./pdf"

const FIXTURE = new URL("../fixtures/sample-messy.xlsx", import.meta.url).pathname

type WireRow = { key: string; excluded?: string; cells: Record<string, { value: string }> }
type Reply = (body: { text: string; table: { rows: WireRow[] } }) => { text: string; changes: ChatChange[]; question?: string; caseUsd?: number; delayMs?: number; failAfterCost?: string; refuse?: number }

/**
 * チャットのサーバー（/api/cases/<id>/chat）の代わりに、決まった返事を AI SDK の UI メッセージのストリームで返す。
 * 返事には変更案と費用を付ける。画面の流れ（変更案・聞き返し・承認・表と CSV・ルールの保存・費用の表示）を AI なしで確かめる
 */
async function fakeChat(page: Page, replies: Reply[]) {
  let n = 0
  await page.route("**/api/cases/*/chat", async (route: Route) => {
    // 会話を読む（GET）はサーバーのまま
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON()
    const reply = replies[n++]!(body)
    if (reply.refuse) return route.fulfill({ status: reply.refuse, body: reply.text })
    const proposal: Proposal = {
      id: `p${n}-${Date.now()}`,
      origin: { kind: "chat", messageId: body.id },
      question: reply.question ? { text: reply.question, answer: null } : null,
      state: "open",
      count: reply.changes.length,
      applied: [],
      rejected: [],
    }
    const metadata: ChatMetadata = { usd: 0.0123, caseUsd: reply.caseUsd ?? 0.5 * n, ms: 1500, inputTokens: 1000, outputTokens: 100, toolCalls: 3 }
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: `a${n}` })
        writer.write({ type: "text-start", id: "t" })
        writer.write({ type: "text-delta", id: "t", delta: reply.text })
        writer.write({ type: "text-end", id: "t" })
        if (reply.changes.length || reply.question) {
          writer.write({ type: "data-proposal", data: { id: proposal.id } })
          writer.write({ type: "data-proposal-content", data: { proposal, changes: reply.changes }, transient: true })
        }
        // サーバーと同じく、費用は失敗する回でも先に届けてから失敗を返す
        writer.write({ type: "message-metadata", messageMetadata: metadata })
        if (reply.failAfterCost) throw new Error(reply.failAfterCost)
        writer.write({ type: "finish" })
      },
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    })
    const res = createUIMessageStreamResponse({ stream })
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
    await route.fulfill({ status: 200, headers: Object.fromEntries(res.headers), body: await res.text() })
  })
}

/** 返事の Markdown（太字・表・箇条書き・リンク。javascript: のリンクは消す） */
const MARKDOWN = [
  "注文者の株式会社を **㈱** にする案を1件出しました。",
  "",
  "| 行 | 今 | 案 |",
  "|---|---|---|",
  "| 工事経歴!4 | 株式会社 | ㈱ |",
  "",
  "- 字数の上限は超えていません",
  "- 個人名らしい値はありません",
  "",
  "[危ないリンク](javascript:alert(1)) と [説明](https://example.com)",
].join("\n")

/** 注文者が「株式会社」で始まる、CSV に載せる候補の行 */
const companyRow = (rows: WireRow[]) => rows.find((r) => !r.excluded && r.cells.client!.value.startsWith("株式会社"))!

async function send(page: Page, text: string) {
  await page.getByTestId("chat-input").fill(text)
  await page.getByTestId("chat-send").click()
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

test("チャットの変更案を一覧で確かめて承認すると、表と CSV に入り、開き直しても残る。返事ごとと案件の費用を出す", async ({ page }) => {
  const { customer } = await convertFixture(page, FIXTURE)
  created.push(customer)
  let target = { key: "", from: "", to: "" }
  await fakeChat(page, [
    ({ table }) => {
      const row = companyRow(table.rows)
      target = { key: row.key, from: row.cells.client!.value, to: row.cells.client!.value.replace("株式会社", "㈱").replace(/[\s　]/g, "") }
      return { text: MARKDOWN, changes: [{ kind: "cell", rowKey: row.key, field: "client", edit: { value: target.to, by: "chat" } }] }
    },
  ])
  await send(page, "注文者の株式会社は㈱にして")

  const proposal = page.getByTestId("proposal")
  await expect(proposal).toContainText("未決 1 件")
  const reply = page.getByTestId("chat-assistant")
  await expect(reply.locator('[data-streamdown="strong"]')).toHaveText("㈱")
  await expect(reply.locator('[data-streamdown="table"]')).toContainText("工事経歴!4")
  await expect(reply.locator('[data-streamdown="list-item"]')).toHaveCount(2)
  await expect(reply.locator('a[href="https://example.com/"], a[href="https://example.com"]')).toHaveCount(1)
  await expect(reply.locator('a[href^="javascript"]')).toHaveCount(0)
  await expect(page.getByTestId("chat-reply-cost")).toContainText("$0.012")
  await expect(page.getByTestId("case-cost")).toContainText("$0.500")
  // 円はサーバーが為替のサービスから取れたときだけ出る（取れたときはレートの日付も出る）
  const costText = (await page.getByTestId("case-cost").textContent()) ?? ""
  if (costText.includes("円")) expect(costText).toMatch(/\d{2}\/\d{2} のレート/)

  expect(await downloadCsv(page)).not.toContain(target.to)
  await proposal.getByTestId("proposal-open").click()
  const item = page.getByTestId("proposal-dialog").getByTestId("proposal-item")
  await expect(item).toContainText(target.from)
  await expect(item).toContainText(target.to)
  // どの文字が変わったかを色分けする（jsdiff）
  await expect(item.locator('[data-diff="removed"]').first()).toContainText("株式会社")
  await expect(item.locator('[data-diff="added"]').first()).toContainText("㈱")
  await item.getByTestId("proposal-item-apply").click()
  await expect(page.getByTestId("proposal-dialog")).toBeHidden()
  await expect(page.getByTestId("proposal-closed")).toHaveText("変更案: 反映 1 件・却下 0 件")
  await showAllRows(page)
  await expect(page.locator(`tr[data-row-key="${target.key}"]`)).toContainText(target.to)
  expect(await downloadCsv(page)).toContain(target.to)

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved")
  await reload(page)
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 60_000 })
  await showAllRows(page)
  await expect(page.locator(`tr[data-row-key="${target.key}"]`)).toContainText(target.to)
})

test("狭い画面: チャットは表に重ねて開き、閉じても進めている指示は続き、開き直すと会話と変更案が残る", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 })
  const { customer } = await convertFixture(page, FIXTURE)
  created.push(customer)
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  await page.getByTestId("chat-open").click()
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "done")
  await fakeChat(page, [({ table }) => ({ text: "1行を外す案です。", changes: [{ kind: "include", rowKey: companyRow(table.rows).key, include: false }], delayMs: 3_000 })])
  await send(page, "注文者が株式会社の最初の行を外して")
  await page.getByRole("button", { name: "チャットを閉じる" }).click()
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  await expect(page.getByTestId("chat-open")).toContainText("1", { timeout: 15_000 })
  await page.getByTestId("chat-open").click()
  await expect(page.getByTestId("chat-messages")).toContainText("注文者が株式会社の最初の行を外して")
  await expect(page.getByTestId("proposal")).toContainText("未決 1 件")
})

test("変更案の無い聞き返しの答えは、AI に送れたときだけ回答済みにする（断られたら答え直せる）", async ({ page }) => {
  const { customer } = await convertFixture(page, FIXTURE)
  created.push(customer)
  await fakeChat(page, [
    () => ({ text: "どちらにしますか。", changes: [], question: "株式会社も㈱にしますか" }),
    () => ({ text: "この案件では別の指示を処理しています", changes: [], refuse: 409 }),
    () => ({ text: "では㈱にする案を出します。", changes: [] }),
  ])
  await send(page, "注文者を短くして")
  const confirmation = page.getByTestId("confirmation")
  await confirmation.getByTestId("confirmation-yes").click()
  await expect(page.getByTestId("chat-error")).toContainText("別の指示を処理しています")
  await expect(confirmation).not.toHaveAttribute("data-answered")
  await expect(confirmation.getByTestId("confirmation-yes")).toBeEnabled()
  await confirmation.getByTestId("confirmation-yes").click()
  await expect(page.getByTestId("chat-messages")).toContainText("では㈱にする案を出します。")
  await expect(confirmation).toHaveAttribute("data-answered", "yes")
})

test("失敗した回でも、その回の費用は画面の案件の合計に届く", async ({ page }) => {
  const { customer } = await convertFixture(page, FIXTURE)
  created.push(customer)
  await fakeChat(page, [() => ({ text: "途中まで進めました。", changes: [], caseUsd: 3.25, failAfterCost: "AI の呼び出しに失敗しました" })])
  await send(page, "工事名の空白を取って")
  await expect(page.getByTestId("chat-error")).toContainText("AI の呼び出しに失敗しました")
  await expect(page.getByTestId("case-cost")).toContainText("$3.25")
})

test("聞き返しに答えるまで承認できない。「いいえ」で全部を却下し、「はい」なら承認できる", async ({ page }) => {
  const { customer } = await convertFixture(page, FIXTURE)
  created.push(customer)
  let key = ""
  const exclude: Reply = ({ table }) => {
    key = companyRow(table.rows).key
    return { text: "この行を CSV から外す案です。", changes: [{ kind: "include", rowKey: key, include: false }], question: "この工事は外してよいですか" }
  }
  await fakeChat(page, [exclude, (body) => ({ ...exclude(body), caseUsd: 10.5 })])
  const before = await csvCount(page)

  await send(page, "注文者が株式会社の最初の行を外して")
  const first = page.getByTestId("proposal").last()
  await expect(first.getByTestId("confirmation")).toContainText("この工事は外してよいですか")
  await expect(first.getByTestId("proposal-apply-all")).toBeDisabled()
  await first.getByTestId("confirmation-no").click()
  await expect(page.getByTestId("proposal-closed").last()).toHaveText("変更案: 反映 0 件・却下 1 件")
  expect(await csvCount(page)).toBe(before)

  await send(page, "やはり外して")
  await expect(page.getByTestId("case-cost")).toHaveAttribute("data-over", "true")
  const second = page.getByTestId("proposal").last()
  await expect(second.getByTestId("proposal-apply-all")).toBeDisabled()
  await second.getByTestId("confirmation-yes").click()
  await expect(second.getByTestId("proposal-apply-all")).toBeEnabled()
  await second.getByTestId("proposal-apply-all").click()
  await expect(page.getByTestId("proposal-closed").last()).toHaveText("変更案: 反映 1 件・却下 0 件")
  await expect.poll(() => csvCount(page)).toBe(before - 1)
  expect(await downloadCsv(page)).toBeTruthy()
})

/** ルールの追記はサーバーが変更案の記録（R2）から足すので、本物の指示で確かめる（E2E_LIVE_AI=1 のときだけ） */
test("本物の AI: 顧客ルールへの追記案を承認すると顧客ルールに保存する。同じ項目をもう一度承認しても二度足さない", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_AI !== "1", "E2E_LIVE_AI=1 のときだけ")
  const { customer, caseUrl } = await convertFixture(page, FIXTURE)
  created.push(customer)
  const rule = `E2E${Date.now()}`
  await send(page, `顧客ルールに「注文者の株式会社は㈱にする（${rule}）」と1行だけ追加する案を出して。表は変えないで`)
  await expect(page.getByTestId("chat-reply-cost")).toBeVisible({ timeout: 300_000 })
  const proposal = page.getByTestId("proposal").last()
  if (await proposal.getByTestId("confirmation-yes").isVisible()) await proposal.getByTestId("confirmation-yes").click()
  // 1回目の承認の結果を画面が受け取れなかった（保存の前に閉じた）のと同じに、承認の応答を捨てて開き直し、もう一度承認する
  await page.route(
    (url) => callsServerFn(url.href, ["approveRuleFn"]),
    async (route) => {
      await route.fetch()
      await route.fulfill({ status: 500, body: "応答を捨てた" })
    },
    { times: 1 },
  )
  await proposal.getByTestId("proposal-apply-all").click()
  await expect(proposal).toContainText("未決")
  await open(page, caseUrl)
  await page.getByTestId("proposal").last().getByTestId("proposal-apply-all").click()
  await expect(page.getByTestId("proposal-closed").last()).toContainText("反映")
  await page.getByRole("link", { name: customer }).click()
  await expect.poll(async () => (await page.getByTestId("customer-rules-text").inputValue()).split(rule).length - 1).toBe(1)
})

const PDF_LINES = [
  "Construction record (synthetic)",
  "1. Sample Office Interior Renovation / Client: Sample Corporation (kabushiki kaisha) / Tokyo, Chiyoda-ku",
  "   Period: 2024-04 to 2024-09 / Contract: 5,500,000 JPY (tax excluded) / Prime contractor (private) / Interior finishing",
  "2. Test Warehouse Repair / Client: Test Logistics Co., Ltd. / Kanagawa, Yokohama-shi Naka-ku",
  "   Period: 2024-06 to 2024-07 / Contract: 2,200,000 JPY (tax excluded) / Subcontractor / Interior finishing",
]

/** PDF だけの案件を作る（表になるファイルが無いので、チャットで表を作る） */
async function openPdfCase(page: Page) {
  const opened = await openNewCase(page)
  await page.getByTestId("file-input").setInputFiles({ name: "工事経歴.pdf", mimeType: "application/pdf", buffer: syntheticPdf(PDF_LINES) })
  await expect(page.getByTestId("no-sheet-source")).toBeVisible()
  return opened
}

test("PDF だけの案件: チャットで AI が作った行は変更案になり、承認すると全部が要確認で表と CSV に入る", async ({ page }) => {
  const { customer, caseUrl } = await openPdfCase(page)
  created.push(customer)
  const cells = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).map(([f, value]) => [f, { value, by: "chat", status: "warning", message: "AI がファイルから作った行です" }]))
  await fakeChat(page, [
    ({ table }) => {
      expect(table.rows).toEqual([])
      return {
        text: "PDF から2件の工事を足す案を出しました。",
        changes: [
          { kind: "add", rowKey: "add-e2e-1", by: "chat", cells: cells({ gyoshu: "19", client: "サンプル株式会社", motoukeShitauke: "1", workName: "サンプル事務所内装改修工事", prefecture: "東京都", place: "千代田区", amount: "5500", startYm: "202404", endYm: "202409" }) },
          { kind: "add", rowKey: "add-e2e-2", by: "chat", cells: cells({ gyoshu: "19", client: "テスト物流株式会社", motoukeShitauke: "2", workName: "テスト倉庫補修工事", prefecture: "神奈川県", place: "横浜市中区", amount: "2200", startYm: "202406", endYm: "202407" }) },
        ],
      }
    },
  ])
  await expect(page.getByTestId("case-report")).toHaveAttribute("data-phase", "noSheet")
  await send(page, "PDF から工事経歴の表を作って")
  const proposal = page.getByTestId("proposal")
  await expect(proposal).toContainText("工事を足す 2")
  await proposal.getByTestId("proposal-apply-all").click()
  await showAllRows(page)
  const rows = page.locator('[data-testid="preview-table"] tbody tr[data-row-key]')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("サンプル事務所内装改修工事")
  await expect(page.getByTestId("preview-table").locator('[data-status="warning"]').first()).toBeVisible()
  // 2件目（下請・少額）は7割で載らない。足した行も変換した行と同じく7割で選ぶ
  const csv = await downloadCsv(page)
  expect(csv).toContain("サンプル事務所内装改修工事")
  await expect(rows.nth(1)).toHaveAttribute("data-included", "0")

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved")
  await open(page, caseUrl)
  await showAllRows(page)
  await expect(rows).toHaveCount(2)
})

test("本物の AI: PDF だけの案件で AI が一から表を作る", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_AI !== "1", "E2E_LIVE_AI=1 のときだけ")
  const { customer } = await openPdfCase(page)
  created.push(customer)
  await send(page, "PDF から工事経歴の表を作って。業種はどちらも内装仕上（19）")
  await expect(page.getByTestId("chat-reply-cost")).toBeVisible({ timeout: 300_000 })
  const proposal = page.getByTestId("proposal").last()
  if (await proposal.getByTestId("confirmation-yes").isVisible()) await proposal.getByTestId("confirmation-yes").click()
  await expect(proposal).toContainText("工事を足す 2")
  await proposal.getByTestId("proposal-apply-all").click()
  await showAllRows(page)
  await expect(page.locator('[data-testid="preview-table"] tbody tr[data-row-key]')).toHaveCount(2)
  expect(await downloadCsv(page)).toContain(",5500,")
})

/** 本物の AI を呼ぶ（E2E_LIVE_AI=1 のときだけ。費用は1回 $0.1 ほど） */
test("本物の AI: 指示 → 変更案 → 承認 → CSV。会話は開き直しても残り、会話を終えると印が付く", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_AI !== "1", "E2E_LIVE_AI=1 のときだけ")
  const { customer, caseUrl } = await convertFixture(page, FIXTURE)
  created.push(customer)
  await send(page, "注文者の「株式会社」を「㈱」にして。ほかは変えないで")
  await expect(page.getByTestId("chat-reply-cost")).toBeVisible({ timeout: 300_000 })
  const proposal = page.getByTestId("proposal").last()
  if (await proposal.getByTestId("confirmation-yes").isVisible()) await proposal.getByTestId("confirmation-yes").click()
  await proposal.getByTestId("proposal-apply-all").click()
  await expect(page.getByTestId("proposal-closed").last()).toContainText("反映")
  expect(await downloadCsv(page)).toContain("㈱")
  await expect(page.getByTestId("case-cost")).not.toContainText("$0.000")

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved")
  await open(page, caseUrl)
  await expect(page.getByTestId("chat-assistant")).toHaveCount(1)
  await expect(page.getByTestId("proposal-closed")).toContainText("反映")
  // 保存した会話には変更案の id だけを残す（中身は proposals/<id>.json）
  const saved = (await (await page.request.get(`${new URL(caseUrl).pathname.replace("/cases/", "/api/cases/")}/chat`)).json()) as { messages: { parts: { type: string; data?: object }[] }[]; carryover: boolean }
  expect(saved.carryover).toBe(false)
  const proposalParts = saved.messages.flatMap((m) => m.parts.filter((p) => p.type.startsWith("data-proposal")))
  expect(proposalParts.map((p) => [p.type, Object.keys(p.data ?? {})])).toEqual([["data-proposal", ["id"]]])

  // 途中で止めても、次の指示は受け付けられ（処理中の印が下りている）、止めた回の費用も案件の合計に入る
  const costBefore = Number(/\$([\d.]+)/.exec((await page.getByTestId("case-cost").textContent()) ?? "")![1])
  await send(page, "工事名の空白を全部取る案を出して")
  await expect(page.getByTestId("chat-assistant").last().getByText("コードを実行").first()).toBeVisible({ timeout: 120_000 })
  await page.getByTestId("chat-stop").click()
  await expect(page.getByTestId("chat-send")).toBeVisible()
  const replies = await page.getByTestId("chat-reply-cost").count()
  await send(page, "注文者の「有限会社」を「㈲」にして。ほかは変えないで")
  await expect(page.getByTestId("chat-reply-cost")).toHaveCount(replies + 1, { timeout: 300_000 })
  await expect(page.getByTestId("chat-error")).toHaveCount(0)
  await open(page, caseUrl)
  await expect.poll(async () => Number(/\$([\d.]+)/.exec((await page.getByTestId("case-cost").textContent()) ?? "")![1])).toBeGreaterThan(costBefore)

  await page.getByTestId("chat-end").click()
  await expect(page.getByTestId("chat-messages")).toContainText("会話を終えました")
})

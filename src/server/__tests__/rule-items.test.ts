import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { DEFAULT_GLOBAL_RULE_ITEMS, MAX_RULE_ITEMS, MAX_RULES_TOTAL, rulesText } from "@/lib/chat/rules"
import {
  addRuleItem,
  appendRuleOnce,
  createCase,
  createCustomer,
  deleteCase,
  deleteCustomer,
  deleteRuleItem,
  getSettings,
  listRuleItems,
  moveRuleItem,
  rulesForAi,
  RulesTooLongError,
  saveSettings,
  StaleRuleError,
  updateRuleItem,
  type Bucket,
  type Db,
  type RuleTarget,
} from "../case-store"
import { migratedDb } from "./sqlite"

const bucket: Bucket = {
  put: async () => ({ size: 0 }),
  delete: async () => {},
  list: async () => ({ objects: [], truncated: false }),
}

let db: Db
let sqlite: Database
beforeEach(() => {
  ;({ db, sqlite } = migratedDb())
})

const GLOBAL: RuleTarget = { scope: "global" }
const texts = async (t: RuleTarget) => (await listRuleItems(db, t)).map((i) => i.text)

describe("ルールの項目", () => {
  test("全体ルールは、はじめて読むときに初期値の項目を入れる（同時に読んでも一度だけ。全部消しても戻さない）", async () => {
    const [a, b] = await Promise.all([listRuleItems(db, GLOBAL), listRuleItems(db, GLOBAL)])
    expect(a.map((i) => i.text)).toEqual([...DEFAULT_GLOBAL_RULE_ITEMS])
    expect(b.length).toBe(DEFAULT_GLOBAL_RULE_ITEMS.length)
    expect(await getSettings(db)).toEqual({ rule7Tax: "excluded" })
    for (const i of await listRuleItems(db, GLOBAL)) await deleteRuleItem(db, GLOBAL, i.id, i.version)
    expect(await texts(GLOBAL)).toEqual([])
    await saveSettings(db, { rule7Tax: "included" })
    expect(await getSettings(db)).toEqual({ rule7Tax: "included" })
  })

  test("足す・直す・並べ替える・消す。顧客ルールは顧客ごと", async () => {
    const customer = await createCustomer(db, "合成建設")
    const t: RuleTarget = { scope: "customer", customerId: customer.id }
    const other = await createCustomer(db, "合成工務店")
    await addRuleItem(db, { scope: "customer", customerId: other.id }, "別の顧客")
    await addRuleItem(db, t, "A")
    await addRuleItem(db, t, "B")
    await addRuleItem(db, t, "C")
    const [a, b, c] = await listRuleItems(db, t)
    await moveRuleItem(db, t, c!.id, "up")
    expect(await texts(t)).toEqual(["A", "C", "B"])
    await moveRuleItem(db, t, a!.id, "up")
    expect(await texts(t)).toEqual(["A", "C", "B"])
    await updateRuleItem(db, t, b!.id, b!.version, "B2")
    await deleteRuleItem(db, t, a!.id, a!.version)
    expect(await texts(t)).toEqual(["C", "B2"])
    expect(await texts({ scope: "customer", customerId: other.id })).toEqual(["別の顧客"])
    // ほかの一覧の id では動かない
    await expect(updateRuleItem(db, GLOBAL, b!.id, 2, "x")).rejects.toBeInstanceOf(StaleRuleError)
    expect((await rulesForAi(db, customer.id)).customer).toBe("- C\n- B2")
    expect((await rulesForAi(db, customer.id)).global).toBe(rulesText(DEFAULT_GLOBAL_RULE_ITEMS.map((text) => ({ text }))))
  })

  test("2つの画面: 別の項目どうしは消し合わない。同じ項目を後から直す・消すと断る（黙って上書きしない）", async () => {
    const customer = await createCustomer(db, "合成建設")
    const t: RuleTarget = { scope: "customer", customerId: customer.id }
    await addRuleItem(db, t, "A")
    await addRuleItem(db, t, "B")
    const [a, b] = await listRuleItems(db, t) // 2つの画面が同じ一覧を読んだ
    await updateRuleItem(db, t, a!.id, a!.version, "A（画面1）")
    await updateRuleItem(db, t, b!.id, b!.version, "B（画面2）")
    expect(await texts(t)).toEqual(["A（画面1）", "B（画面2）"])
    const stale = updateRuleItem(db, t, a!.id, a!.version, "A（画面2）")
    await expect(stale).rejects.toBeInstanceOf(StaleRuleError)
    await expect(stale).rejects.toMatchObject({ current: "A（画面1）" })
    await expect(deleteRuleItem(db, t, a!.id, a!.version)).rejects.toBeInstanceOf(StaleRuleError)
    // 並べ替えは版を上げない（隣を並べ替えても、直している途中の項目の保存は断らない）
    const [a2, b2] = await listRuleItems(db, t)
    await moveRuleItem(db, t, b2!.id, "up")
    await updateRuleItem(db, t, a2!.id, a2!.version, "A3")
    expect(await texts(t)).toEqual(["B（画面2）", "A3"])
    // もう消えた項目を消すのは何もしない。直すのは断る
    await deleteRuleItem(db, t, b2!.id, b2!.version)
    await deleteRuleItem(db, t, b2!.id, b2!.version)
    await expect(updateRuleItem(db, t, b2!.id, b2!.version, "x")).rejects.toMatchObject({ current: null })
  })

  test("上限: 項目の数と合計の字数", async () => {
    const customer = await createCustomer(db, "合成建設")
    const t: RuleTarget = { scope: "customer", customerId: customer.id }
    for (let i = 0; i < MAX_RULE_ITEMS; i++) await addRuleItem(db, t, String(i))
    await expect(addRuleItem(db, t, "多い")).rejects.toBeInstanceOf(RulesTooLongError)
    const items = await listRuleItems(db, t)
    for (const i of items.slice(1)) await deleteRuleItem(db, t, i.id, i.version)
    const long = "あ".repeat(MAX_RULES_TOTAL - 1)
    await updateRuleItem(db, t, items[0]!.id, items[0]!.version, long)
    await expect(addRuleItem(db, t, "長い")).rejects.toBeInstanceOf(RulesTooLongError)
    await addRuleItem(db, t, "a")
    await expect(updateRuleItem(db, t, items[0]!.id, items[0]!.version + 1, `${long}あ`)).rejects.toBeInstanceOf(RulesTooLongError)
  })

  test("チャットの承認は項目を1つ足し、同じ項目を二度足さない（開き直して承認し直しても、同時に押しても）。由来の案件が付く", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    const t: RuleTarget = { scope: "customer", customerId: customer.id }
    const add = (item: number, text: string) => appendRuleOnce(db, t, { caseId: c.id, proposalId: "p1", item, text })
    expect(await add(0, "工事名の読点は取る")).toBe("added")
    expect(await add(0, "工事名の読点は取る")).toBe("already")
    expect((await Promise.all([add(1, "A"), add(1, "A")])).sort()).toEqual(["added", "already"])
    const items = await listRuleItems(db, t)
    expect(items.map((i) => [i.text, i.source, i.origin])).toEqual([
      ["工事名の読点は取る", "chat", { caseId: c.id, fiscalYear: 2026, customerName: "合成建設" }],
      ["A", "chat", { caseId: c.id, fiscalYear: 2026, customerName: "合成建設" }],
    ])
    expect(sqlite.query("select count(*) as n from csv_rule_appends where item_id is not null").get()).toEqual({ n: 2 })

    expect(await appendRuleOnce(db, GLOBAL, { caseId: c.id, proposalId: "p1", item: 2, text: "注文者の株式会社は㈱" })).toBe("added")
    expect((await texts(GLOBAL)).at(-1)).toBe("注文者の株式会社は㈱")
    expect((await texts(GLOBAL)).length).toBe(DEFAULT_GLOBAL_RULE_ITEMS.length + 1)

    // 案件を消すと、項目は残して由来の案件だけ外す（足した印は消す）
    await deleteCase(db, bucket, c.id)
    expect((await listRuleItems(db, t)).map((i) => [i.text, i.origin])).toEqual([
      ["工事名の読点は取る", null],
      ["A", null],
    ])
    expect(sqlite.query("select count(*) as n from csv_rule_appends").get()).toEqual({ n: 0 })
  })

  test("承認で上限を超えるなら、足さずに知らせる（印も付けない）", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    const t: RuleTarget = { scope: "customer", customerId: customer.id }
    await addRuleItem(db, t, "あ".repeat(MAX_RULES_TOTAL - 2))
    await expect(appendRuleOnce(db, t, { caseId: c.id, proposalId: "p", item: 0, text: "長い追記" })).rejects.toBeInstanceOf(RulesTooLongError)
    expect(sqlite.query("select count(*) as n from csv_rule_appends").get()).toEqual({ n: 0 })
    expect(await appendRuleOnce(db, t, { caseId: c.id, proposalId: "p", item: 0, text: "a" })).toBe("added")
  })

  test("顧客を消すと顧客ルールの項目も消える（全体ルールの項目は残り、由来だけ外れる）", async () => {
    const customer = await createCustomer(db, "合成建設")
    const c = await createCase(db, customer.id, 2026)
    const t: RuleTarget = { scope: "customer", customerId: customer.id }
    await addRuleItem(db, t, "A")
    await appendRuleOnce(db, GLOBAL, { caseId: c.id, proposalId: "p", item: 0, text: "全体へ" })
    await deleteCustomer(db, bucket, customer.id)
    expect(sqlite.query("select count(*) as n from csv_rule_items where scope = 'customer'").get()).toEqual({ n: 0 })
    expect((await listRuleItems(db, GLOBAL)).at(-1)).toMatchObject({ text: "全体へ", origin: null })
    await expect(addRuleItem(db, t, "B")).rejects.toThrow("顧客が見つかりません")
  })
})

/** マイグレーションを番号の順に、途中まで当てる（前の形のデータを入れてから 0004 を当てる） */
function applyMigrations(sqlite: Database, tags: string[]) {
  for (const tag of tags) for (const statement of readFileSync(new URL(`../../../drizzle/${tag}.sql`, import.meta.url), "utf8").split("--> statement-breakpoint")) sqlite.run(statement)
}
const BEFORE = ["0000_init", "0001_cases", "0002_rule_appends", "0003_location_search"]

describe("前の形（1つの文章）から項目に移す（0004）", () => {
  test("行ごとに項目にする。空行は飛ばし、前後の空白と先頭の箇条書きの記号を取る。並びは元の行の順。保存したことがあれば初期値を入れない", async () => {
    const old = new Database(":memory:")
    applyMigrations(old, BEFORE)
    old.run("insert into csv_rules (id, rules) values ('global', ?)", ["一行目。\r\n\n  - 二行目  \n・三行目\n　\n* 四行目\n全角　空白は中だけ残す　\n-"])
    old.run("insert into csv_customers (id, name, rules) values ('c1', '合成建設', ?)", ["A\nB\n\n"])
    old.run("insert into csv_customers (id, name, rules) values ('c2', '合成工務店', '')")
    applyMigrations(old, ["0004_rule_items"])
    const rows = old.query("select scope, customer_id as customerId, text, position, source, version from csv_rule_items order by scope, customer_id, position").all()
    expect(rows).toEqual([
      { scope: "customer", customerId: "c1", text: "A", position: 1, source: "staff", version: 1 },
      { scope: "customer", customerId: "c1", text: "B", position: 2, source: "staff", version: 1 },
      ...["一行目。", "二行目", "三行目", "四行目", "全角　空白は中だけ残す"].map((text, i) => ({ scope: "global", customerId: null, text, position: i + 1, source: "staff", version: 1 })),
    ])
    expect(old.query("select id, rule7_tax as rule7Tax from csv_settings").all()).toEqual([{ id: "global", rule7Tax: "excluded" }])
  })

  test("全体ルールを保存したことが無ければ設定の行を作らない（はじめて読むときに初期値を入れる）", () => {
    const old = new Database(":memory:")
    applyMigrations(old, [...BEFORE, "0004_rule_items"])
    expect(old.query("select count(*) as n from csv_settings").get()).toEqual({ n: 0 })
    expect(old.query("select count(*) as n from csv_rule_items").get()).toEqual({ n: 0 })
  })
})

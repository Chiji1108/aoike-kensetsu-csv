import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import { deriveTable, type CaseTable } from "../../cases/view"
import { applyChanges, proposalRecordSchema, type ChatChange } from "../../chat/proposals"
import { describeChange } from "../../chat/describe"
import { editKey, type RowResult } from "../../convert/convert"
import type { KojiFieldId } from "../../spec/koji-keireki"
import { locationItems, outcomeChanges } from "../changes"
import { checkFound, jaSchema, placeIndex } from "../check"
import { estimateUsd, ESTIMATE_USD, locationTargets, MAX_SITES_PER_RUN, runSitesOf, siteKeyOf, siteOfRow, type Found, type Outcome } from "../sites"

const index = placeIndex(jaSchema.parse(JSON.parse(readFileSync(new URL("../../../../public/japanese-addresses/api/ja.json", import.meta.url), "utf8"))))
const base = { gyoshu: "8", motoukeShitauke: "1", engineer: "試験　太郎", startYm: "202404", endYm: "202409", amount: "1000" }

/** 所在地の推定（変換の ai.inferPrefecture）で入ったセル */
function inferred(row: RowResult<KojiFieldId>, field: "prefecture" | "place", value: string, guessed: boolean) {
  row.cells[field] = { value, status: "warning", source: "工事名", original: "", byAi: true, message: guessed ? "現場名から推定: 迷った" : "現場名から推定", ...(guessed ? { guessed: true as const } : {}) }
  return row
}

/** 指示文の変換（ai.freeform）で AI が要確認と答えたセル */
function aiWarning(row: RowResult<KojiFieldId>) {
  row.cells.prefecture = { value: "東京都", status: "warning", source: "F列", original: "", byAi: true, message: "AIの判断に要確認: 工事名から推定" }
  return row
}

const tableOf = (rows: RowResult<KojiFieldId>[], over: Partial<CaseTable> = {}): CaseTable => ({ rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded", basis: {}, selection: "all", sorted: false, ...over })

describe("調べる現場を集める", () => {
  const rows = () => [
    // 都道府県が空（住所の列が空）
    kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 1),
    // 同じ現場（空白の違いはまとめる）
    kojiRow({ ...base, client: "株式会社 テスト", workName: "テストビル 改修工事" }, 2),
    // 推定に自信が無い
    inferred(inferred(kojiRow({ ...base, client: "市役所", workName: "第二小学校体育館工事" }, 3), "prefecture", "静岡県", true), "place", "静岡市", true),
    // 推定に自信がある（調べない）
    inferred(inferred(kojiRow({ ...base, client: "県", workName: "横浜駅前広場工事" }, 4), "prefecture", "神奈川県", false), "place", "横浜市西区", false),
    // 住所から読めた（調べない）
    kojiRow({ ...base, client: "株式会社サンプル", workName: "倉庫新築工事", prefecture: "東京都", place: "港区" }, 5),
    // 個人名（外に送らない）
    kojiRow({ ...base, client: personToken("山田太郎"), workName: `${personToken("山田太郎")}邸新築工事` }, 6),
    // CSV に載せない行は調べない
    kojiRow({ ...base, client: "株式会社テスト", workName: "外した工事" }, 7),
    // 指示文の変換で AI が迷った（要確認）
    aiWarning(kojiRow({ ...base, client: "株式会社X", workName: "駅前ビル工事", place: "" }, 8)),
  ]

  test("同じ工事名・注文者の行をまとめ、空・自信の無い推定の行だけを集める。個人名の現場は値を持たず、調べない印を付ける", () => {
    const view = deriveTable(tableOf(rows(), { manual: new Map([["s!7", false]]) }))
    const sites = locationTargets(view)
    expect(sites.map((s) => s.rowKeys)).toEqual([["s!1", "s!2"], ["s!3"], ["s!6"], ["s!8"]])
    expect(sites[0]).toMatchObject({ key: siteKeyOf("テストビル改修工事", "株式会社テスト"), workName: "テストビル改修工事", client: "株式会社テスト", knowledgeTried: false })
    expect(sites[1]).toMatchObject({ workName: "第二小学校体育館工事", client: "市役所", knowledgeTried: true })
    expect(sites[2]).toMatchObject({ workName: "", client: "", skip: "personal" })
    expect(JSON.stringify(sites)).not.toContain("山田")
  })

  test("手直し・顧客の回答・承認した変更案・顧客に聞くと決めた欄は調べない", () => {
    const edits = new Map([
      [editKey("s!1", "prefecture"), { value: "東京都", by: "staff" as const }],
      [editKey("s!3", "prefecture"), { value: "", by: "chat" as const, ask: true as const, status: "warning" as const }],
    ])
    const sites = locationTargets(deriveTable(tableOf(rows(), { edits, manual: new Map([["s!7", false]]) })))
    expect(sites.map((s) => s.rowKeys)).toEqual([["s!2"], ["s!6"], ["s!8"]])
  })

  test("費用の目安は覚えた結果と調べない現場を除き、変換で推定していない現場には知識の分を足す", () => {
    const sites = locationTargets(deriveTable(tableOf(rows(), { manual: new Map([["s!7", false]]) })))
    expect(estimateUsd(sites, new Set())).toBeCloseTo(ESTIMATE_USD.knowledge + 3 * ESTIMATE_USD.search)
    expect(estimateUsd(sites, new Set([sites[0]!.key]))).toBeCloseTo(2 * ESTIMATE_USD.search)
  })
})

const found = (over: Partial<Found> = {}): Found => ({ prefecture: "東京都", place: "港区", urls: ["https://example.com/a"], source: "search", confident: true, note: "", ...over })

describe("住所データでの検算", () => {
  test("都道府県の省略形・場所名の都道府県・後ろの町名をそろえ、政令市は区まで・区の無い政令市・郡を付けた町村（住所データの表記の郡なしにする）・半角の表記も読む", () => {
    expect(checkFound(index, found({ prefecture: "東京", place: "東京都港区赤坂" }))).toEqual({ ok: true, found: found() })
    expect(checkFound(index, found({ prefecture: "神奈川県", place: "横浜市西区" }))).toMatchObject({ ok: true, found: { place: "横浜市西区", confident: true } })
    expect(checkFound(index, found({ prefecture: "神奈川県", place: "横浜市" }))).toMatchObject({ ok: true, found: { place: "横浜市", confident: true } })
    expect(checkFound(index, found({ prefecture: "広島県", place: "広島市南区、三原市" }))).toMatchObject({ ok: true, found: { place: "広島市南区、三原市" } })
    expect(checkFound(index, found({ prefecture: "北海道", place: "ﾆｾｺ町" }))).toMatchObject({ ok: true, found: { place: "ニセコ町", confident: true } })
    expect(checkFound(index, found({ prefecture: "新潟県", place: "三島郡出雲崎町" }))).toMatchObject({ ok: true, found: { place: "出雲崎町", confident: true } })
    expect(checkFound(index, found({ prefecture: "福島県", place: "郡山市" }))).toMatchObject({ ok: true, found: { place: "郡山市", confident: true } })
  })

  test("47都道府県に無い都道府県は使わず、その都道府県に無い市区町村は値を残して自信なしにする", () => {
    expect(checkFound(index, found({ prefecture: "関東" }))).toMatchObject({ ok: false })
    const r = checkFound(index, found({ prefecture: "東京都", place: "横浜市" }))
    expect(r).toMatchObject({ ok: true, found: { place: "横浜市", confident: false } })
    expect(r.ok && r.found.note).toContain("確かめられませんでした")
  })
})

describe("調べた結果を変更案にする", () => {
  const sites = locationTargets(
    deriveTable(
      tableOf([
        kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 1),
        kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 2),
        kojiRow({ ...base, client: "市役所", workName: "体育館工事" }, 3),
        kojiRow({ ...base, client: personToken("山田太郎"), workName: "邸新築工事" }, 4),
        kojiRow({ ...base, client: "株式会社X", workName: "止めた回の工事" }, 5),
      ]),
    ),
  )
  const outcomes = new Map<string, Outcome>([
    [sites[0]!.key, { kind: "found", ...found({ confident: false, note: "似た名前のビルが2つ" }) }],
    [sites[1]!.key, { kind: "notFound", note: "" }],
    [sites[2]!.key, { kind: "skipped", skip: "personal" }],
  ])

  test("見つかった現場は行をまとめて1件、見つからない・調べない現場は行ごとの問い合わせ。結果の無い現場は出さない", () => {
    const changes = outcomeChanges(sites, outcomes)
    expect(changes.map((c) => c.kind)).toEqual(["location", "ask", "ask"])
    expect(changes[0]).toMatchObject({ kind: "location", rowKeys: ["s!1", "s!2"], prefecture: "東京都", place: "港区" })
    expect(changes[1]).toMatchObject({ kind: "ask", rowKey: "s!3", field: "prefecture" })
    expect((changes[2] as Extract<ChatChange, { kind: "ask" }>).reason).toContain("個人名")
  })

  test("承認すると同じ現場の行の都道府県・場所名が要確認で入り、根拠の URL を添える。自信の無い結果は顧客に確かめる印を付ける", () => {
    const table = tableOf([kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 1), kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 2)])
    const changes = outcomeChanges(sites.slice(0, 1), outcomes)
    const next = applyChanges(table, [], changes)
    const view = deriveTable(next)
    for (const r of view.output) {
      expect(r.cells.prefecture).toMatchObject({ value: "東京都", status: "warning", by: "location", guessed: true })
      expect(r.cells.place.value).toBe("港区")
      expect(r.cells.place.message).toContain("https://example.com/a")
    }
    const line = describeChange(changes[0]!, view, new Map(view.shown.map((r) => [r.key, r])))
    expect(line).toMatchObject({ what: "工事場所", links: ["https://example.com/a"] })
    expect(line.where).toContain("（2行）")
  })
})

describe("レビューで見つかった穴", () => {
  test("チャットの1件の調査は、一括調査と同じ決め方で行を選ぶ（同じ名前でも住所から決まっている行は変えない）", () => {
    const view = deriveTable(
      tableOf([
        kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 1),
        kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事", prefecture: "東京都", place: "港区" }, 2),
        kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 3),
      ]),
    )
    expect(siteOfRow(view, "s!1")!.rowKeys).toEqual(["s!1", "s!3"])
    // 聞かれた行は、決まっていても入れる
    expect(siteOfRow(view, "s!2")!.rowKeys).toEqual(["s!2", "s!1", "s!3"])
  })

  test("場所名の分からない結果（都道府県だけ）を承認しても、今の場所名は消さない", () => {
    const table = tableOf([kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事", place: "港区" }, 1)])
    const sites = locationTargets(deriveTable(table))
    const changes = outcomeChanges(sites, new Map([[sites[0]!.key, { kind: "found", ...found({ place: "" }) }]]))
    const r = deriveTable(applyChanges(table, [], changes)).output[0]!
    expect(r.cells.prefecture.value).toBe("東京都")
    expect(r.cells.place).toMatchObject({ value: "港区" })
    expect(r.cells.place.by).toBeUndefined()
  })

  test("一括調査の1回分は先頭から上限まで。残りの数も同じ決め方で数える", () => {
    const rows = Array.from({ length: MAX_SITES_PER_RUN + 5 }, (_, i) => kojiRow({ ...base, client: "株式会社テスト", workName: `工事${i}` }, i))
    const { sites, over } = runSitesOf(deriveTable(tableOf(rows)))
    expect(sites).toHaveLength(MAX_SITES_PER_RUN)
    expect(over).toBe(5)
  })
})

test("承認する工事場所の項目は変更案の記録から選び、工事場所でない項目が混ざれば断る", () => {
  const sites = locationTargets(deriveTable(tableOf([kojiRow({ ...base, client: "株式会社テスト", workName: "テストビル改修工事" }, 1), kojiRow({ ...base, client: "市役所", workName: "体育館工事" }, 2)])))
  const changes = outcomeChanges(sites, new Map<string, Outcome>([[sites[0]!.key, { kind: "found", ...found() }], [sites[1]!.key, { kind: "notFound", note: "" }]]))
  const record = { proposal: { id: "p", origin: { kind: "location" as const, runId: "p" }, question: null, state: "open" as const, count: 2, applied: [], rejected: [] }, changes }
  expect(locationItems(record, [0, 0])).toMatchObject([{ site: { workName: "テストビル改修工事" }, found: { prefecture: "東京都" } }])
  expect(locationItems(record, [0, 1])).toBeUndefined()
  expect(locationItems(record, [5])).toBeUndefined()
})

test("長い工事名・注文者の現場でも、変更案の記録は書いた形のまま読める（現場の上限は1つの定義）", () => {
  const long = "長".repeat(500)
  const sites = locationTargets(deriveTable(tableOf([kojiRow({ ...base, client: long, workName: long }, 1)])))
  const changes = outcomeChanges(sites, new Map([[sites[0]!.key, { kind: "found", ...found() }]]))
  const record = { proposal: { id: "p", origin: { kind: "location" as const, runId: "p" }, question: null, state: "open" as const, count: 1, applied: [], rejected: [] }, changes }
  expect(sites[0]!.key.length).toBeGreaterThan(1000)
  expect(proposalRecordSchema.safeParse(JSON.parse(JSON.stringify(record))).success).toBe(true)
})

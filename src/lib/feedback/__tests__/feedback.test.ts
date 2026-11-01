import { describe, expect, test } from "bun:test"
import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import { DEFAULT_GLOBAL_RULE_ITEMS } from "../../chat/rules"
import { chatTools, newTurnState } from "../../chat/turn"
import { feedbackInputSchema, feedbackNameCheck, MASKED_FEEDBACK, MAX_FEEDBACK_PER_TURN, MAX_FEEDBACK_TEXT, type FeedbackDeps } from "../feedback"
import { memoryFeedback } from "../memory"

const yamada = personToken("山田太郎")
const base = { gyoshu: "8", motoukeShitauke: "1", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", startYm: "202404", endYm: "202409", amount: "1000" }
const rows = [kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事` }, 1), kojiRow({ ...base, client: "株式会社　ミドリ商事", workName: "アオバ東ビル電気設備工事" }, 2)]
const table = { rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded" as const, basis: {}, rule7Tax: "excluded" as const, selection: "all" as const, rounding: "floor" as const, dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT }

async function call(tools: ReturnType<typeof chatTools>, name: keyof ReturnType<typeof chatTools>, input: unknown) {
  const t = tools[name] as unknown as { execute: (input: unknown, options: unknown) => Promise<string> }
  return JSON.parse(await t.execute(input, { toolCallId: "t", messages: [] }))
}

const item = (want: string, more: object = {}) => ({ kind: "missing", want, did: "コードで1行ずつ直した。", idea: "まとめて直す道具。", ...more })
const stateWith = (deps: FeedbackDeps) => newTurnState(table, undefined, undefined, null, null, null, null, deps)
const memory = () => memoryFeedback(["架空工業株式会社"], DEFAULT_GLOBAL_RULE_ITEMS)

describe("要望（record_feedback）", () => {
  test("先に list_feedback で読まないと残さない。読めば新しい要望を足し、同じ要望は件数を足す", async () => {
    const { items, deps } = memory()
    const tools = chatTools(stateWith(deps))
    expect(await call(tools, "record_feedback", { items: [item("業種が空の行をまとめて直したい。")] })).toMatchObject({ ok: false })
    expect(items).toEqual([])
    expect(await call(tools, "list_feedback", {})).toEqual({ ok: true, items: [] })
    expect(await call(tools, "record_feedback", { items: [item("業種が空の行をまとめて直したい。")] })).toMatchObject({ ok: true, added: 1, counted: 0 })
    expect(items).toHaveLength(1)

    // 次の指示: 同じ要望は same_as で件数を足す（文は増やさない）
    const next = stateWith(deps)
    const tools2 = chatTools(next)
    expect((await call(tools2, "list_feedback", {})).items).toEqual([{ id: "f1", kind: "missing", want: "業種が空の行をまとめて直したい。", idea: "まとめて直す道具。", count: 1 }])
    expect(await call(tools2, "record_feedback", { items: [item("同じ。", { same_as: "f1" })] })).toMatchObject({ ok: true, added: 0, counted: 1 })
    expect(items).toHaveLength(1)
    expect(items[0]!.count).toBe(2)
    expect(next.feedbackRecorded).toEqual([{ id: "f1", kind: "missing", added: false }])
  })

  test("same_as の要望が読んだあとに閉じられていたら、仮の文のまま新しい行にせず、書き直すよう返す", async () => {
    const { items, deps } = memory()
    const tools = chatTools(stateWith(deps))
    await call(tools, "list_feedback", {})
    await call(tools, "record_feedback", { items: [item("業種が空の行をまとめて直したい。")] })
    const next = stateWith(deps)
    const tools2 = chatTools(next)
    await call(tools2, "list_feedback", {})
    items[0]!.status = "done"
    const res = await call(tools2, "record_feedback", { items: [item("同じ。", { same_as: "f1" })] })
    expect(res).toMatchObject({ ok: false, added: 0, counted: 0, closed: ["f1"] })
    expect(res.error).toContain("閉じています")
    expect(items).toHaveLength(1)
    expect(next.feedbackRecorded).toEqual([])
  })

  test("1回の指示で残せるのは上限まで。読んでいない id・同じ id の重なりは断る", async () => {
    const { items, deps } = memory()
    const tools = chatTools(stateWith(deps))
    await call(tools, "list_feedback", {})
    const many = Array.from({ length: MAX_FEEDBACK_PER_TURN + 1 }, (_, i) => item(`要望その${i + 1}。`))
    expect(await call(tools, "record_feedback", { items: many })).toMatchObject({ ok: false })
    expect(await call(tools, "record_feedback", { items: [item("知らない要望。", { same_as: "nope" })] })).toMatchObject({ ok: false })
    expect(items).toEqual([])
    for (let i = 0; i < MAX_FEEDBACK_PER_TURN; i++) expect(await call(tools, "record_feedback", { items: [item(`要望その${i + 1}。`)] })).toMatchObject({ ok: true })
    expect(await call(tools, "record_feedback", { items: [item("もう1つ。")] })).toMatchObject({ ok: false })
    expect(items).toHaveLength(MAX_FEEDBACK_PER_TURN)
  })

  test("個人名・表の記号・顧客名・注文者・工事名の語が入っていれば何も残さない（一般の言葉は残す）", async () => {
    const { items, deps } = memory()
    const tools = chatTools(stateWith(deps))
    await call(tools, "list_feedback", {})
    for (const want of ["山田太郎の工事をまとめたい。", "〔Ａ〕の行を直したい。", "架空工業の案件で困った。", "ミドリ商事の行を直したい。", "アオバ東ビルの場所を調べたい。"]) {
      const res = await call(tools, "record_feedback", { items: [item(want), item("工事名の(仮称)をまとめて取りたい。")] })
      expect(res).toMatchObject({ ok: false })
      expect(res.words.length).toBeGreaterThan(0)
    }
    expect(items).toEqual([])
    expect(await call(tools, "record_feedback", { items: [item("工事名の(仮称)をまとめて取りたい。"), item("電気工事の業種が空の行をまとめて直したい。", { kind: "repeat" })] })).toMatchObject({ ok: true, added: 2 })
    expect(items.map((i) => i.want)).toEqual(["工事名の(仮称)をまとめて取りたい。", "電気工事の業種が空の行をまとめて直したい。"])
  })

  test("list_feedback は、この案件の名前が入った要望（ほかの案件・職員が残したもの）の中身を見せない", async () => {
    const { items, deps } = memory()
    items.push({ id: "x1", kind: "other", want: "ミドリ商事の表を直したい。", idea: "まとめて直す道具。", did: "手で直した。", count: 3, status: "open" })
    items.push({ id: "x2", kind: "other", want: "業種をまとめて直したい。", idea: "まとめて直す道具。", did: "手で直した。", count: 1, status: "open" })
    const res = await call(chatTools(stateWith(deps)), "list_feedback", {})
    expect(res.items).toEqual([
      { id: "x1", kind: "other", want: MASKED_FEEDBACK, idea: MASKED_FEEDBACK, count: 3 },
      { id: "x2", kind: "other", want: "業種をまとめて直したい。", idea: "まとめて直す道具。", count: 1 },
    ])
  })

  test("道具が無ければ使えない", async () => {
    expect(await call(chatTools(newTurnState(table)), "list_feedback", {})).toMatchObject({ ok: false })
  })
})

describe("要望の中身", () => {
  test("欄は前後の空白と改行を整え、空と長すぎるものは受け取らない", () => {
    expect(feedbackInputSchema.parse({ kind: "detour", want: " a\nb ", did: "c", idea: "d" })).toEqual({ kind: "detour", want: "a b", did: "c", idea: "d" })
    expect(feedbackInputSchema.safeParse({ kind: "detour", want: " ", did: "c", idea: "d" }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ kind: "detour", want: "あ".repeat(MAX_FEEDBACK_TEXT + 1), did: "c", idea: "d" }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ kind: "nope", want: "a", did: "c", idea: "d" }).success).toBe(false)
  })

  test("顧客名・注文者: 名そのもの・法人格を外した本体・一般の語も外した部分で探す（英字・ひらがな・全角半角・大文字小文字も）", () => {
    const check = feedbackNameCheck({ names: ["さくら建設株式会社", "ACME Holdings", "株式会社 ミドリ商事", "東京電気工業"], works: [] })
    expect(check("さくらの件で困った")).toEqual(["さくら"])
    expect(check("ＡＣＭＥの表を直したい")).toEqual(["acme"])
    expect(check("ﾐﾄﾞﾘの件")).toEqual(["ミドリ"])
    expect(check("株式会社ミドリ商事の件")).toContain("ミドリ商事")
    // 知っている語（都道府県・一般の語）だけの部分では断らない
    expect(check("東京都の工事場所をまとめて調べたい")).toEqual([])
    expect(check("工事名と注文者と業種を直したい")).toEqual([])
  })

  test("工事名: 知っている語・建物の一般の語・違う注文者の工事名に何度も出る語では断らず、現場の名は断る", () => {
    const works = [
      { client: "甲", workName: "(仮称)アオバマンション新築工事" },
      { client: "乙", workName: "コスモス保育園改修工事" },
      { client: "丙", workName: "ヒカリ物流倉庫改修工事" },
      { client: "丁", workName: "ミナト倉庫改修工事" },
    ]
    const check = feedbackNameCheck({ names: [], works, known: DEFAULT_GLOBAL_RULE_ITEMS })
    expect(check("マンションの工事名から(仮称)を取りたい")).toEqual([])
    expect(check("改修工事の業種をまとめて決めたい")).toEqual([])
    expect(check("アオバマンションの場所を調べたい")).toEqual(["アオバマンション"])
    expect(check("コスモス保育園の件")).toEqual(expect.arrayContaining(["コスモス"]))
  })
})

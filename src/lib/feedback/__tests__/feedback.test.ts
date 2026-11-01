import { describe, expect, test } from "bun:test"
import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import { chatTools, newTurnState, type FeedbackDeps } from "../../chat/turn"
import { feedbackInputSchema, MAX_FEEDBACK_PER_TURN, MAX_FEEDBACK_TEXT, properNameHits, type FeedbackSummary } from "../feedback"

const yamada = personToken("山田太郎")
const base = { gyoshu: "8", motoukeShitauke: "1", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", startYm: "202404", endYm: "202409", amount: "1000" }
const rows = [kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事` }, 1), kojiRow({ ...base, client: "株式会社　ミドリ商事", workName: "アオバ東ビル電気設備工事" }, 2)]
const table = { rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded" as const, basis: {}, rule7Tax: "excluded" as const, selection: "all" as const, dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT }

/** 本番の csv_feedback の代わり */
function memory(customer = "架空工業株式会社") {
  const items: (FeedbackSummary & { did: string })[] = []
  const deps: FeedbackDeps = {
    list: async () => items.map(({ did: _, ...f }) => f),
    add: async (input) => {
      const id = `f${items.length + 1}`
      items.push({ id, kind: input.kind, want: input.want, idea: input.idea, did: input.did, count: 1 })
      return id
    },
    bump: async (id) => {
      const f = items.find((x) => x.id === id)
      if (f) f.count++
      return f !== undefined
    },
    names: async () => [customer],
  }
  return { items, deps }
}

async function call(tools: ReturnType<typeof chatTools>, name: keyof ReturnType<typeof chatTools>, input: unknown) {
  const t = tools[name] as unknown as { execute: (input: unknown, options: unknown) => Promise<string> }
  return JSON.parse(await t.execute(input, { toolCallId: "t", messages: [] }))
}

const item = (want: string, more: object = {}) => ({ kind: "missing", want, did: "コードで1行ずつ直した。", idea: "まとめて直す道具。", ...more })
const stateWith = (deps: FeedbackDeps) => newTurnState(table, undefined, undefined, null, null, null, null, deps)

describe("要望（record_feedback）", () => {
  test("先に list_feedback で読まないと残さない。読めば新しい要望を足し、同じ要望は件数を足す", async () => {
    const { items, deps } = memory()
    const state = stateWith(deps)
    const tools = chatTools(state)
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

  test("1回の指示で残せるのは上限まで。読んでいない id・同じ id の重なりは断る", async () => {
    const { items, deps } = memory()
    const state = stateWith(deps)
    const tools = chatTools(state)
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
    }
    expect(items).toEqual([])
    expect(await call(tools, "record_feedback", { items: [item("工事名の(仮称)をまとめて取りたい。"), item("電気工事の業種が空の行をまとめて直したい。", { kind: "repeat" })] })).toMatchObject({ ok: true, added: 2 })
    expect(items.map((i) => i.want)).toEqual(["工事名の(仮称)をまとめて取りたい。", "電気工事の業種が空の行をまとめて直したい。"])
  })

  test("道具が無ければ使えない", async () => {
    const tools = chatTools(newTurnState(table))
    expect(await call(tools, "list_feedback", {})).toMatchObject({ ok: false })
  })
})

describe("要望の中身", () => {
  test("欄は前後の空白と改行を整え、空と長すぎるものは受け取らない", () => {
    expect(feedbackInputSchema.parse({ kind: "detour", want: " a\nb ", did: "c", idea: "d" })).toEqual({ kind: "detour", want: "a b", did: "c", idea: "d" })
    expect(feedbackInputSchema.safeParse({ kind: "detour", want: " ", did: "c", idea: "d" }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ kind: "detour", want: "あ".repeat(MAX_FEEDBACK_TEXT + 1), did: "c", idea: "d" }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ kind: "nope", want: "a", did: "c", idea: "d" }).success).toBe(false)
  })

  test("固有名の語: 名前の値に含まれ、書式の一般の語でない語を返す（全角・半角・空白の違いも同じ）", () => {
    expect(properNameHits("ﾐﾄﾞﾘの件", ["株式会社 ミドリ商事"])).toEqual(["ミドリ"])
    expect(properNameHits("株式会社ミドリ商事の件", ["株式会社　ミドリ商事"])).toContain("株式会社ミドリ商事")
    expect(properNameHits("工事名と注文者と業種を直したい", ["株式会社 ミドリ商事", "電気設備工事"])).toEqual([])
    expect(properNameHits("なんでも", [])).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import type { CaseTable } from "../../cases/view"
import { deriveTable } from "../../cases/view"
import type { ChatMessage } from "../messages"
import type { ChatChange, Proposal } from "../proposals"
import { hasPersonalName, reviewMaterial, reviewScrubber, reviewTurnsFromUi, type ReviewTurn } from "../review"
import { chatTools, newTurnState, type ReviewDeps } from "../turn"

const yamada = personToken("山田太郎")
const base = { gyoshu: "8", motoukeShitauke: "1", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", startYm: "202404", endYm: "202409" }
const rows = [
  kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事`, amount: "5000" }, 1),
  kojiRow({ ...base, client: "株式会社　テスト", workName: "テストビル 電気工事", amount: "3000" }, 2),
  kojiRow({ ...base, client: "有限会社サンプル", workName: "サンプル倉庫改修", amount: "1000" }, 3),
]
const table: CaseTable = {
  rows,
  added: [],
  edits: new Map([
    ["s!2:client", { value: "㈱テスト", by: "chat" }],
    ["s!3:client", { value: "㈲サンプル", by: "staff" }],
    ["s!2:workName", { value: "テストビル電気工事", by: "chat" }],
    ["s!3:endYm", { value: "202410", by: "customer" }],
    ["s!1:engineer", { value: "見本　花子", by: "customer" }],
  ]),
  replacements: { client: { "株式会社　テスト": { value: "㈱テスト", by: "staff" } } },
  manual: new Map([
    ["s!3", true],
    ["s!1", false],
  ]),
  tax: "excluded",
  basis: {},
  rule7Tax: "excluded",
  selection: "all",
  sorted: false,
}

const user = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] })
const assistant = (id: string, parts: unknown[]): ChatMessage => ({ id, role: "assistant", parts }) as ChatMessage
const tool = (name: string, input: unknown, output: unknown = "") => ({ type: `tool-${name}`, toolCallId: name, state: "output-available", input, output })
const closed = (id: string, applied: number, rejected: number, question: Proposal["question"] = null): Proposal => ({ id, origin: { kind: "chat", messageId: id }, question, state: "closed", applied, rejected })

describe("振り返る指示（画面の会話から）", () => {
  test("指示ごとに、変更案の承認の結果・聞き返しと答え・承認の対象の列の対応の変更・7割の設定・道具を会話の順に", () => {
    const ui: ChatMessage[] = [
      user("u1", "完成年月は引渡日にして"),
      assistant("a1", [{ type: "text", text: "直します" }, tool("set_plan", {}, JSON.stringify({ ok: true, changes: ["完成年月: J列（年月）"] })), tool("get_table", {}), { type: "data-proposal", data: { id: "p1" } }]),
      { id: "s1", role: "system", parts: [{ type: "text", text: "会話を終えました" }] },
      user("u2", "全部載せて"),
      assistant("a2", [tool("set_selection", { selection: "all", tax: "excluded" }), tool("set_include", {}), tool("set_include", {}), { type: "data-proposal", data: { id: "p2" } }]),
      user("u3", "(仮称)を取って"),
      assistant("a3", [tool("ask_staff", { question: "q" }), { type: "data-proposal", data: { id: "p3" } }]),
      user("u4", "これは何？"),
      assistant("a4", [{ type: "text", text: "説明" }, tool("set_plan", {}, JSON.stringify({ ok: false, problems: ["x"] }))]),
      user("u5", "止めた指示"),
    ]
    const proposals: Proposal[] = [closed("p1", 1, 0), closed("p2", 2, 0), { ...closed("p3", 0, 3, { text: "工事名の(仮称)も取ってよいですか", answer: "no" }) }]
    const turns = reviewTurnsFromUi(ui, proposals, [{ proposalId: "p2", undone: true }])
    expect(turns).toEqual([
      { instruction: "完成年月は引渡日にして", proposal: { applied: 1, count: 1, open: false, undone: false }, question: null, plan: ["完成年月: J列（年月）"], selection: [], tools: ["set_plan"] },
      { instruction: "全部載せて", proposal: { applied: 2, count: 2, open: false, undone: true }, question: null, plan: [], selection: ["Excel の金額: 税抜", "載せる工事: 全件"], tools: ["set_selection", "set_include"] },
      { instruction: "(仮称)を取って", proposal: { applied: 0, count: 3, open: false, undone: false }, question: { text: "工事名の(仮称)も取ってよいですか", answer: "no" }, plan: [], selection: [], tools: ["ask_staff"] },
      { instruction: "これは何？", proposal: null, question: null, plan: [], selection: [], tools: ["set_plan"] },
      { instruction: "止めた指示", proposal: null, question: null, plan: [], selection: [], tools: [] },
    ])
  })
})

describe("振り返りの材料", () => {
  const turns: ReviewTurn[] = [
    { instruction: "注文者の株式会社は㈱にして（山田太郎さんの件も）", proposal: { applied: 2, count: 2, open: false, undone: false }, question: null, plan: [], selection: [], tools: ["set_cells"] },
    { instruction: "配置技術者は見本 花子に", proposal: { applied: 0, count: 1, open: false, undone: false }, question: { text: "試験太郎さんでよいですか", answer: "yes" }, plan: [], selection: [], tools: [] },
    { instruction: "全部載せて", proposal: { applied: 1, count: 1, open: false, undone: true }, question: null, plan: [], selection: [], tools: [] },
    { instruction: "まだ", proposal: { applied: 0, count: 2, open: true, undone: false }, question: null, plan: [], selection: [], tools: [] },
  ]

  test("指示と承認の結果、手直しの項目ごとの数と例（職員・チャットの直しを先に）、置換・入れ外し・設定をまとめ、個人名を伏せる", () => {
    const scrub = reviewScrubber(table, ["山田太郎"])
    const m = reviewMaterial({ turns, table, view: deriveTable(table), rounding: "round", scrub })
    expect(m.instructions).toEqual([
      { n: 1, text: "注文者の株式会社は㈱にして（〔個人名〕さんの件も）", result: "承認 2/2", tools: ["set_cells"] },
      { n: 2, text: "配置技術者は〔個人名〕に", result: "却下した", question: "〔個人名〕さんでよいですか", answer: "はい" },
      { n: 3, text: "全部載せて", result: "承認を取り消した" },
      { n: 4, text: "まだ", result: "まだ決めていない" },
    ])
    const client = m.edits.find((e) => e.field === "client")!
    expect(client.counts).toEqual({ "チャット（承認）": 1, 職員: 1 })
    expect(client.examples).toEqual([
      { by: "職員", before: "有限会社サンプル", after: "㈲サンプル" },
      { by: "チャット（承認）", before: "株式会社　テスト", after: "㈱テスト" },
    ])
    expect(m.edits.find((e) => e.field === "endYm")!.examples).toEqual([{ by: "顧客の回答", before: "202409", after: "202410" }])
    // 配置技術者の値（個人名）は出さない
    expect(m.edits.find((e) => e.field === "engineer")!.examples).toEqual([{ by: "顧客の回答", before: "〔個人名〕", after: "〔個人名〕" }])
    expect(m.replacements).toEqual([{ field: "client", label: "注文者", count: 1, examples: [{ from: "株式会社　テスト", to: "㈱テスト" }] }])
    expect(m.manual).toEqual({ include: 1, exclude: 1 })
    expect(m.settings).toMatchObject({ tax: "税抜", selection: "全件", rounding: "四捨五入" })
    const text = JSON.stringify(m)
    for (const name of ["山田", "試験", "見本"]) expect(text).not.toContain(name)
  })

  test("指示が多ければ後ろの分だけ（番号は会話の順のまま）、長い指示は切る", () => {
    const many = Array.from({ length: 70 }, (_, i): ReviewTurn => ({ instruction: i === 69 ? "あ".repeat(2000) : `指示${i + 1}`, proposal: null, question: null, plan: [], selection: [], tools: [] }))
    const m = reviewMaterial({ turns: many, table, view: deriveTable(table), rounding: "floor", scrub: reviewScrubber(table) })
    expect(m.instructions).toHaveLength(60)
    expect(m.instructions[0]!.n).toBe(11)
    expect([...m.instructions.at(-1)!.text].length).toBe(601)
  })

  test("ルールの案の個人名: 表の人・分かっている名前（空白・全角半角の違いも）・表の記号を見つける。地名の一部は名前にしない", () => {
    const scrub = reviewScrubber(table, ["佐藤"])
    expect(hasPersonalName("注文者が山田 太郎のときは〔個人名〕にする", scrub)).toBe(true)
    expect(hasPersonalName("配置技術者は試験太郎にする", scrub)).toBe(true)
    expect(hasPersonalName("〔Ａ〕の工事は載せない", scrub)).toBe(true)
    expect(hasPersonalName("佐藤 の工事は外す", scrub)).toBe(true)
    expect(hasPersonalName("佐藤町の工事は外す", scrub)).toBe(false)
    expect(hasPersonalName("工事名の【支店名】は先頭に移す", scrub)).toBe(false)
  })
})

describe("振り返りの道具（get_review・propose_review）", () => {
  const deps = (over: Partial<ReviewDeps> = {}): ReviewDeps => ({
    turns: () => [{ instruction: "完成年月は引渡日にして", proposal: { applied: 1, count: 1, open: false, undone: false }, question: null, plan: ["完成年月: J列"], selection: [], tools: ["set_plan"] }],
    names: async () => ["佐藤　次郎"],
    rounding: "floor",
    ...over,
  })
  async function call(tools: ReturnType<typeof chatTools>, name: keyof ReturnType<typeof chatTools>, input: unknown) {
    const t = tools[name] as unknown as { execute: (input: unknown, options: unknown) => Promise<string> }
    const out = await t.execute(input, { toolCallId: "t", messages: [] })
    try {
      return JSON.parse(out)
    } catch {
      return out
    }
  }

  test("get_review は材料を返し、使えないときは理由を返す", async () => {
    const res = await call(chatTools(newTurnState(table, undefined, undefined, null, null, deps())), "get_review", {})
    expect(res.instructions).toEqual([{ n: 1, text: "完成年月は引渡日にして", result: "承認 1/1", plan: ["完成年月: J列"], tools: ["set_plan"] }])
    expect(await call(chatTools(newTurnState(table)), "get_review", {})).toMatchObject({ ok: false })
    expect(await call(chatTools(newTurnState(table, undefined, undefined, null, null, deps({ turns: () => "画面が古い" }))), "get_review", {})).toEqual({ ok: false, error: "画面が古い" })
  })

  test("propose_review は毎年の決まりを由来「振り返り」の顧客ルールの案にし、今年だけの事情は案にしない", async () => {
    const state = newTurnState(table, undefined, undefined, null, null, deps())
    const res = await call(chatTools(state), "propose_review", {
      yearly: [
        { text: "完成年月は引渡日の列にする。", evidence: "指示1" },
        { text: "注文者の株式会社は㈱にする。", evidence: "手直し" },
      ],
      one_off: ["1件だけ完成年月を顧客の回答で直した"],
    })
    expect(res).toMatchObject({ ok: true, yearly: 2, oneOff: 1 })
    expect(state.pending).toEqual<ChatChange[]>([
      { kind: "rule", scope: "customer", text: "完成年月は引渡日の列にする。", source: "review" },
      { kind: "rule", scope: "customer", text: "注文者の株式会社は㈱にする。", source: "review" },
    ])
    expect(state.oneOff).toEqual(["1件だけ完成年月を顧客の回答で直した"])
    // 決まりが無ければ案も無い
    const empty = newTurnState(table, undefined, undefined, null, null, deps())
    expect(await call(chatTools(empty), "propose_review", { yearly: [], one_off: ["今年だけ"] })).toMatchObject({ ok: true, yearly: 0 })
    expect(empty.pending).toEqual([])
  })

  test("個人名（表の人・分かっている名前・表の記号）の入った案は、propose_review も propose_rule も何も受け取らない", async () => {
    const state = newTurnState(table, undefined, undefined, null, null, deps())
    const tools = chatTools(state)
    const named = await call(tools, "propose_review", {
      yearly: [
        { text: "注文者の株式会社は㈱にする。", evidence: "" },
        { text: "佐藤次郎の工事は載せない。", evidence: "" },
      ],
      one_off: [],
    })
    expect(named).toMatchObject({ ok: false, yearly: [1] })
    expect(await call(tools, "propose_rule", { scope: "customer", items: ["配置技術者は試験太郎にする"] })).toMatchObject({ ok: false, items: [0] })
    expect(await call(tools, "propose_rule", { scope: "global", items: ["〔Ａ〕邸は載せない"] })).toMatchObject({ ok: false, items: [0] })
    expect(state.pending).toEqual([])
    // 振り返りの道具が無くても、表の人で確かめる
    expect(await call(chatTools(newTurnState(table)), "propose_rule", { scope: "customer", items: ["山田太郎の件は外す"] })).toMatchObject({ ok: false })
  })
})

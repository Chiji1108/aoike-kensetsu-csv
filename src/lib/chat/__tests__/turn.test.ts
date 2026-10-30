import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { kojiRow } from "../../convert/__tests__/helpers"
import { fileAddressLookup } from "../../convert/address-file"
import { CORRECTION_MESSAGE } from "../../inquiry/inquiry"
import { personToken } from "../../convert/persons"
import { deriveTable } from "../../cases/view"
import { applyChanges, type ChatChange } from "../proposals"
import { MAX_ADDED_ROWS } from "../../cases/added"
import type { AiBatchRequest } from "../../convert/ai-tasks"
import { guardPersonal, MAX_SITES_PER_RUN } from "../../location/sites"
import { AI_ADDED_NOTE, chatTools, MAX_LOOKUPS_PER_TURN, MAX_TOOL_CALLS, newTurnState, withCacheBreakpoint, type AnonymizeCaller, type LocationCaller } from "../turn"

const yamada = personToken("山田太郎")
const suzuki = personToken("鈴木一郎")
const base = { gyoshu: "8", motoukeShitauke: "1", prefecture: "東京都", place: "千代田区", engineer: "試験　太郎", startYm: "202404", endYm: "202409" }
const rows = [
  kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事`, amount: "5000" }, 1),
  kojiRow({ ...base, client: suzuki, workName: `${suzuki}様邸改修工事`, amount: "3000" }, 2),
  kojiRow({ ...base, client: "株式会社　テスト", workName: "テストビル電気工事", amount: "1000" }, 3),
]
const table = { rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded" as const, basis: {}, rule7Tax: "excluded" as const, selection: "all" as const, sorted: false, dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT }

/** 匿名化の決まった応答（変換のテストと同じ）: 注文者は全体、工事名は「様邸」「邸」の前を個人名として印にする。asked に聞いた値を溜める */
function cannedAnonymize(asked: string[] = []): AnonymizeCaller {
  return async (req: AiBatchRequest) => {
    asked.push(...req.items.map((i) => i.input))
    return {
      ok: true,
      usd: 0.001,
      json: {
        results: req.items.map((i) => {
          if (req.task === "anonymizeClient") {
            const [, name, honorific = ""] = /^(.+?)(様)?$/.exec(i.input)!
            return { id: i.id, value: `〔1〕${honorific}`, persons: [name!], needsReview: false, note: "" }
          }
          const m = /^(.+?)様?邸/.exec(i.input)
          return m ? { id: i.id, value: i.input.replace(m[1]!, "〔1〕"), persons: [m[1]!], needsReview: false, note: "" } : { id: i.id, value: i.input, persons: [], needsReview: false, note: "" }
        }),
      },
    }
  }
}

/** 道具をコードから呼んだときと同じく、入力を渡して JSON 文字列を読む */
async function call(tools: ReturnType<typeof chatTools>, name: keyof ReturnType<typeof chatTools>, input: unknown) {
  const t = tools[name] as unknown as { execute: (input: unknown, options: unknown) => Promise<string> }
  const out = await t.execute(input, { toolCallId: "t", messages: [] })
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

describe("チャットの道具（決まった入力で）", () => {
  test("add_rows は元の表に無い工事を足す案を出す。値は全部を要確認にし、注文者の個人名は匿名化に通す。足した行は続けて set_cells で直せる", async () => {
    const state = newTurnState({ ...table, rows: [] }, cannedAnonymize())
    const tools = chatTools(state)
    const res = await call(tools, "add_rows", { rows: [{ cells: { gyoshu: "8", client: "田中花子", workName: "田中花子邸新築工事", amount: "4000", prefecture: "東京都" } }, { cells: { gyoshu: "8", client: "株式会社サンプル", amount: "" } }] })
    expect(res).toMatchObject({ ok: true, applied: 2 })
    expect(res.keys).toHaveLength(2)
    const [a, b] = state.pending as Extract<ChatChange, { kind: "add" }>[]
    expect(a).toMatchObject({ kind: "add", by: "chat", rowKey: res.keys[0] })
    expect(a!.cells.client!.value).toBe(personToken("田中花子"))
    expect(Object.values(a!.cells).every((e) => e!.status === "warning" && e!.message!.startsWith(AI_ADDED_NOTE))).toBe(true)
    expect(Object.keys(b!.cells).sort()).toEqual(["client", "gyoshu"])
    const view = deriveTable(state.current)
    expect(view.shown.map((r) => r.key)).toEqual(res.keys)
    expect(view.shown[0]!.cells.client.value).toBe("Ａ")
    expect(await call(tools, "set_cells", { changes: [{ key: res.keys[1], field: "workName", value: "サンプル倉庫改修工事" }] })).toMatchObject({ ok: true })
  })

  test("add_rows は足した行の上限を超える案を出さない", async () => {
    const added = Array.from({ length: MAX_ADDED_ROWS }, (_, i) => ({ key: `add-${i}`, by: "chat" as const }))
    const state = newTurnState({ ...table, rows: [], added })
    const res = await call(chatTools(state), "add_rows", { rows: [{ cells: { gyoshu: "8" } }] })
    expect(res.ok).toBe(false)
    expect(res.error).toContain(String(MAX_ADDED_ROWS))
    expect(state.pending).toEqual([])
  })

  test("add_rows で個人名を確かめられない値は何も足さない", async () => {
    const state = newTurnState({ ...table, rows: [] })
    const res = await call(chatTools(state), "add_rows", { rows: [{ cells: { client: "田中花子" } }] })
    expect(res.ok).toBe(false)
    expect(state.pending).toEqual([])
  })

  test("get_table は個人名を「〔Ａ〕」の形で返し、set_cells の「〔Ａ〕」は同じ人の印として変更案に溜める（表には入れない）", async () => {
    const state = newTurnState(table, cannedAnonymize())
    const tools = chatTools(state)
    const got = await call(tools, "get_table", {})
    expect(got.map((r: { cells: { client: string } }) => r.cells.client)).toEqual(["〔Ａ〕", "〔Ｂ〕", "株式会社　テスト"])
    const res = await call(tools, "set_cells", { changes: [{ key: "s!1", field: "workName", value: "〔Ａ〕様邸新築工事" }, { key: "s!3", field: "client", value: "㈱テスト" }] })
    expect(res).toMatchObject({ ok: true, applied: 2 })
    expect(state.pending).toEqual([
      { kind: "cell", rowKey: "s!1", field: "workName", edit: { value: `${yamada}様邸新築工事`, by: "chat", status: "ai", byAi: true } },
      { kind: "cell", rowKey: "s!3", field: "client", edit: { value: "㈱テスト", by: "chat" } },
    ])
    expect(state.start).toBe(table)
    const after = deriveTable(applyChanges(table, deriveTable(table).edited, state.pending))
    expect(after.output.map((r) => r.cells.workName.value)).toEqual(["Ａ様邸新築工事", "Ｂ様邸改修工事", "テストビル電気工事"])
  })

  test("指示の間に行を外して記号が付け直されても、AI に見せた「〔Ｂ〕」は同じ人のまま", async () => {
    const state = newTurnState(table, cannedAnonymize())
    const tools = chatTools(state)
    await call(tools, "set_include", { rows: [{ key: "s!1", include: false }] })
    expect(deriveTable(state.current).output[0]!.cells.client.value).toBe("Ａ")
    const got = await call(tools, "get_table", { only_included: true })
    expect(got[0].cells.client).toBe("〔Ｂ〕")
    await call(tools, "set_cells", { changes: [{ key: "s!2", field: "client", value: "〔Ｂ〕様" }] })
    expect(state.pending.at(-1)).toMatchObject({ edit: { value: `${suzuki}様` } })
  })

  test("知らない key・記号の表に無い記号は何も変えずに返す", async () => {
    const state = newTurnState(table)
    const tools = chatTools(state)
    expect(await call(tools, "set_cells", { changes: [{ key: "s!9", field: "client", value: "x" }] })).toMatchObject({ ok: false, unknownKeys: ["s!9"] })
    expect(await call(tools, "set_cells", { changes: [{ key: "s!1", field: "client", value: "〔Ｚ〕" }] })).toMatchObject({ ok: false, unreadable: [{ key: "s!1", field: "client" }] })
    expect(state.pending).toEqual([])
  })

  test("check_table は CSV に載せる行の検査（字数の上限を含む）を返す", async () => {
    const state = newTurnState(table, cannedAnonymize())
    const tools = chatTools(state)
    await call(tools, "set_cells", { changes: [{ key: "s!3", field: "client", value: "〔Ａ〕様" }, { key: "s!3", field: "workName", value: "工".repeat(52) }] })
    const report = await call(tools, "check_table", {})
    expect(report).toMatchObject({ includedRows: 3, errors: 1 })
    expect(report.firstErrors).toEqual([{ key: "s!3", field: "workName", value: "工".repeat(52), message: expect.stringContaining("字数が上限") }])
  })

  test("注文者・工事名に AI が書いた素の氏名は、変換と同じ匿名化に通して印にする。法人・今と同じ値は AI に聞かない", async () => {
    const asked: string[] = []
    const state = newTurnState(table, cannedAnonymize(asked))
    const tools = chatTools(state)
    const res = await call(tools, "set_cells", {
      changes: [
        { key: "s!3", field: "client", value: "佐藤　花子" },
        { key: "s!3", field: "workName", value: "佐藤様邸改修工事" },
        { key: "s!1", field: "client", value: "㈱テスト" },
        { key: "s!2", field: "workName", value: "〔Ｂ〕様邸改修工事" },
      ],
    })
    expect(res).toMatchObject({ ok: true, applied: 4 })
    expect(asked).toEqual(["佐藤　花子", "佐藤様邸改修工事"])
    expect(state.anonymizeUsd).toBeCloseTo(0.002)
    const csv = deriveTable(applyChanges(table, deriveTable(table).edited, state.pending)).output
    const text = JSON.stringify(csv.map((r) => [r.cells.client.value, r.cells.workName.value]))
    expect(text).not.toContain("佐藤")
    expect(csv.find((r) => r.key === "s!3")!.cells.workName.value).toMatch(/^[Ａ-Ｚ]様邸改修工事$/)
  })

  test("匿名化を確かめられない（AI が無い・検算に落ちた）素の氏名は受け取らない", async () => {
    const state = newTurnState(table)
    const tools = chatTools(state)
    expect(await call(tools, "set_cells", { changes: [{ key: "s!3", field: "client", value: "佐藤　花子" }] })).toMatchObject({ ok: false, refused: [{ key: "s!3", field: "client" }] })
    const leaky: AnonymizeCaller = async (req) => ({ ok: true, usd: 0, json: { results: req.items.map((i) => ({ id: i.id, value: i.input, persons: ["佐藤花子"], needsReview: false, note: "" })) } })
    const tools2 = chatTools(newTurnState(table, leaky))
    expect(await call(tools2, "set_cells", { changes: [{ key: "s!3", field: "client", value: "佐藤　花子" }] })).toMatchObject({ ok: false })
    expect(state.pending).toEqual([])
  })

  test("聞き返し・ルールの項目の案（1項目ずつ）・7割の設定も変更案になる", async () => {
    const state = newTurnState(table)
    const tools = chatTools(state)
    await call(tools, "ask_staff", { question: "(仮称)も取ってよいですか" })
    await call(tools, "propose_rule", { scope: "customer", items: ["注文者の株式会社は㈱にする", "完成年月は引渡日"] })
    // 前の形の引数（already_applied）や知らない引数は黙って捨てず、形の誤りとして AI に返す
    const schema = tools.set_selection.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ already_applied: true }).success).toBe(false)
    expect(schema.safeParse({ selection: "all" }).success).toBe(true)
    await call(tools, "set_selection", { tax: "included", selection: "rule7" })
    expect(state.question).toBe("(仮称)も取ってよいですか")
    expect(state.pending).toEqual([
      { kind: "rule", scope: "customer", text: "注文者の株式会社は㈱にする", source: "chat" },
      { kind: "rule", scope: "customer", text: "完成年月は引渡日", source: "chat" },
      { kind: "settings", tax: "included", selection: "rule7", basis: undefined },
    ])
  })

  test(`道具を呼べるのは1回の指示で${MAX_TOOL_CALLS}回まで。超えたら動かさずに返す`, async () => {
    const state = newTurnState(table)
    const tools = chatTools(state)
    for (let i = 0; i < MAX_TOOL_CALLS; i++) await call(tools, "check_table", {})
    expect(await call(tools, "set_include", { rows: [{ key: "s!1", include: false }] })).toMatchObject({ ok: false, error: expect.stringContaining("使い切りました") })
    expect(state.pending).toEqual([])
  })
})

describe("キャッシュの区切り", () => {
  test("コードから呼んだ道具の呼び出し・結果には付けず、その前のコード実行のブロックに付ける。元の履歴は変えない", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "直して" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "code_execution", input: {}, providerExecuted: true },
          { type: "tool-call", toolCallId: "t1", toolName: "get_table", input: {} },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "get_table", output: { type: "text", value: "[]" } }] },
    ]
    const out = withCacheBreakpoint(messages)
    const assistant = out[1]!.content as { toolName: string; providerOptions?: unknown }[]
    expect(assistant.map((p) => p.providerOptions !== undefined)).toEqual([true, false])
    expect(messages[1]!.content).not.toBe(assistant)
    expect((messages[1]!.content as { providerOptions?: unknown }[])[0]!.providerOptions).toBeUndefined()
  })
})

describe("工事場所を調べる道具", () => {
  const site = { gyoshu: "8", motoukeShitauke: "1", engineer: "試験　太郎", startYm: "202404", endYm: "202409", amount: "1000" }
  const placeTable = {
    ...table,
    rows: [
      kojiRow({ ...site, client: "株式会社テスト", workName: "テストビル改修工事" }, 1),
      kojiRow({ ...site, client: "株式会社テスト", workName: "テストビル改修工事" }, 2),
      kojiRow({ ...site, client: yamada, workName: `${yamada}邸新築工事` }, 3),
      kojiRow({ ...site, client: "株式会社X", workName: "倉庫工事", prefecture: "東京都", place: "港区" }, 4),
    ],
  }
  function caller(asked: string[] = []): LocationCaller {
    return {
      locate: async (s, spent) => {
        asked.push(s.workName)
        spent.usd += 0.05
        return { kind: "found", prefecture: "東京都", place: "墨田区", urls: ["https://example.com/a"], source: "search", confident: true, note: "" }
      },
      memorized: async (keys) => new Set(keys.slice(0, 1)),
      guard: async (sites) => guardPersonal(sites, (t) => t.includes("鈴木")),
    }
  }

  test("key を省くと件数と費用の目安を返し、一括調査のボタンを見せる印を立てる（自分では調べない）", async () => {
    const asked: string[] = []
    const state = newTurnState(placeTable, undefined, caller(asked))
    const res = await call(chatTools(state), "find_location", {})
    expect(res).toMatchObject({ ok: true, sites: 2, memorized: 1, skipped: 1 })
    expect(state.locationOffer).toMatchObject({ sites: 2, memorized: 1 })
    expect(asked).toEqual([])
    expect(state.pending).toEqual([])
  })

  test("key を渡すとその行の現場を1件だけ調べ、同じ現場の行をまとめて変える案を出す。個人名の現場は調べない。回数には上限がある", async () => {
    const asked: string[] = []
    const state = newTurnState(placeTable, undefined, caller(asked))
    const tools = chatTools(state)
    const res = await call(tools, "find_location", { key: "s!1" })
    expect(res).toMatchObject({ ok: true, found: true, prefecture: "東京都", place: "墨田区", rows: 2 })
    expect(state.pending).toMatchObject([{ kind: "location", rowKeys: ["s!1", "s!2"], prefecture: "東京都" }])
    expect(state.locationSpent.usd).toBeCloseTo(0.05)
    // 決まった値の行（住所のある行）も、聞かれれば調べる
    expect(await call(tools, "find_location", { key: "s!4" })).toMatchObject({ ok: true, found: true, rows: 1 })
    expect(await call(tools, "find_location", { key: "s!3" })).toMatchObject({ ok: true, found: false })
    expect(asked).toEqual(["テストビル改修工事", "倉庫工事"])
    expect(JSON.stringify(state.pending)).not.toContain("山田")
    await call(tools, "find_location", { key: "s!1" })
    const over = await call(tools, "find_location", { key: "s!2" })
    expect(over.ok).toBe(false)
    expect(asked).toHaveLength(MAX_LOOKUPS_PER_TURN)
  })

  test("調べる道具が無ければ使えないと返す", async () => {
    expect(await call(chatTools(newTurnState(placeTable)), "find_location", {})).toMatchObject({ ok: false })
  })
})

test("find_location（key なし）の件数と目安は、一括調査の1回分（上限まで）で数える", async () => {
  const rows = Array.from({ length: MAX_SITES_PER_RUN + 3 }, (_, i) => kojiRow({ gyoshu: "8", motoukeShitauke: "1", amount: "1000", client: "株式会社テスト", workName: `工事${i}` }, i))
  const state = newTurnState({ ...table, rows }, undefined, { locate: async () => ({ kind: "notFound", note: "" }), memorized: async () => new Set(), guard: async (s) => s })
  const res = await call(chatTools(state), "find_location", {})
  expect(res).toMatchObject({ sites: MAX_SITES_PER_RUN, nextRuns: 3 })
  expect(state.locationOffer?.sites).toBe(MAX_SITES_PER_RUN)
})

test("find_location はサーバーの個人名の確かめで個人名ありとした現場を調べない（画面の表に印が無くても）", async () => {
  const asked: string[] = []
  const rows = [kojiRow({ gyoshu: "8", motoukeShitauke: "1", amount: "1000", client: "株式会社テスト", workName: "鈴木様邸改修工事" }, 1)]
  const state = newTurnState({ ...table, rows }, undefined, {
    locate: async (s) => (asked.push(s.workName), { kind: "notFound", note: "" }),
    memorized: async () => new Set(),
    guard: async (sites) => guardPersonal(sites, (t) => t.includes("鈴木")),
  })
  expect(await call(chatTools(state), "find_location", { key: "s!1" })).toMatchObject({ ok: true, found: false })
  expect(await call(chatTools(state), "find_location", {})).toMatchObject({ sites: 1, skipped: 1 })
  expect(asked).toEqual([])
})

describe("列の対応を直す（set_plan）・ボタン（offer_action）", () => {
  const plan = {
    sheets: ["工事経歴"],
    headerRow: 2,
    dataRows: { start: 3, end: 20 },
    skipRows: [],
    rowFilter: { excludeHidden: true, excludeColumns: [] },
    amountUnit: "yen" as const,
    fields: Object.fromEntries(rows[0] ? Object.keys(rows[0].cells).map((f) => [f, { kind: "missing" as const }]) : []) as never,
    unusedColumns: [],
    notes: [],
  }
  const shape = { rows: 21, columns: 8 }

  test("合う差分は変更案にし、表は変えない。続けて出す差分は前の差分を重ねた計画で確かめる", async () => {
    const state = newTurnState(table, undefined, undefined, { plan, shape })
    const tools = chatTools(state)
    const res = await call(tools, "set_plan", { fields: { amount: { kind: "column", column: "G", transform: "rule.yenToThousand" } }, reason: "金額は税込の列" })
    expect(res.ok).toBe(true)
    expect(res.changes[0]).toContain("G列")
    expect(state.pending).toEqual([{ kind: "plan", patch: { fields: { amount: { kind: "column", column: 6, transform: "rule.yenToThousand" } }, reason: "金額は税込の列" }, before: { fields: { amount: { kind: "missing" } }, reason: "" } }])
    expect(state.current).toBe(state.start)
    expect(state.plan!.plan.fields.amount).toEqual({ kind: "column", column: 6, transform: "rule.yenToThousand" })
    const again = await call(tools, "set_plan", { fields: { amount: { kind: "column", column: "H", transform: "rule.yenToThousand" } }, reason: "やっぱり H" })
    expect(again.changes[0]).toMatch(/G列.+ → H列/)
  })

  test("合わない差分（個人名の項目に匿名化しない変換・シートの外の列）は何も変えずに理由を返す。列の対応が無い案件では使えない", async () => {
    const state = newTurnState(table, undefined, undefined, { plan, shape })
    const tools = chatTools(state)
    const res = await call(tools, "set_plan", { fields: { client: { kind: "column", column: "D", transform: "rule.text" }, place: { kind: "column", column: "Z", transform: "rule.addressCity" } }, reason: "x" })
    expect(res.ok).toBe(false)
    expect(res.problems).toHaveLength(2)
    expect(state.pending).toEqual([])
    const none = newTurnState(table)
    expect((await call(chatTools(none), "set_plan", { fields: { jv: { kind: "missing" } }, reason: "x" })).ok).toBe(false)
  })

  test("offer_action は同じボタンを二度足さない", async () => {
    const state = newTurnState(table)
    const tools = chatTools(state)
    await call(tools, "offer_action", { action: "export" })
    await call(tools, "offer_action", { action: "export" })
    await call(tools, "offer_action", { action: "inquiry_excel" })
    expect(state.actions).toEqual(["export", "inquiry_excel"])
  })
})

describe("顧客の回答を読む（get_inquiries・record_answers）", () => {
  const asking = [
    kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事`, amount: "5000", engineer: "", endYm: "" }, 2),
    kojiRow({ ...base, client: "株式会社　テスト", workName: "テストビル電気工事", amount: "1000", prefecture: "", place: "" }, 3),
  ]
  const answering = { ...table, rows: asking }
  const answers = { lookup: fileAddressLookup, rounding: "floor" as const }

  test("get_inquiries は今聞いているセルを、行を見分ける値（個人名は記号）と一緒に返す", async () => {
    const out = await call(chatTools(newTurnState({ ...answering, tax: "unknown" }, undefined, undefined, null, answers)), "get_inquiries", {})
    expect(out.tax).toBe(true)
    expect(out.cells.map((c: { key: string; field: string }) => `${c.key}:${c.field}`)).toEqual(["s!2:engineer", "s!2:endYm", "s!3:prefecture", "s!3:place"])
    expect(out.cells[0]).toMatchObject({ label: "配置技術者", reason: "データに無い", workName: "〔Ａ〕邸新築工事", client: "〔Ａ〕" })
  })

  test("record_answers は記入用Excelと同じ決まりで値にして、顧客の回答の変更案に溜める（表には入れない）。読めない答えは返す", async () => {
    const asked: string[] = []
    const state = newTurnState(answering, cannedAnonymize(asked), undefined, null, answers)
    const out = await call(chatTools(state), "record_answers", {
      items: [
        { key: "s!2", field: "engineer", answer: "試験 次郎" },
        { key: "s!2", field: "endYm", answer: "そのうち" },
        { key: "s!3", field: "place", answer: "大阪府大阪市北区梅田1" },
        { key: "s!3", field: "workName", answer: "鈴木一郎様邸改修工事" },
      ],
    })
    expect(out).toMatchObject({ ok: true, applied: 4, answered: [{ key: "s!2", field: "engineer" }, { key: "s!3", field: "prefecture" }, { key: "s!3", field: "place" }], corrected: [{ key: "s!3", field: "workName" }] })
    expect(out.invalid).toEqual([{ key: "s!2", field: "endYm", answer: "そのうち", message: "年月として読めません（例: 2024年4月）" }])
    expect(asked).toEqual(["鈴木一郎様邸改修工事"])
    expect(state.pending).toEqual([
      { kind: "cell", rowKey: "s!2", field: "engineer", edit: { value: "試験　次郎", by: "customer" } },
      { kind: "cell", rowKey: "s!3", field: "prefecture", edit: { value: "大阪府", by: "customer" } },
      { kind: "cell", rowKey: "s!3", field: "place", edit: { value: "大阪市北区", by: "customer" } },
      { kind: "cell", rowKey: "s!3", field: "workName", edit: { value: `${suzuki}様邸改修工事`, by: "customer", status: "ai", byAi: true, message: CORRECTION_MESSAGE } },
    ])
    expect(state.current).not.toBe(answering)
    expect(state.start).toBe(answering)
  })

  test("record_answers の匿名化の AI の結果は指示の間で持ち、同じ答えを送り直しても AI に聞き直さない", async () => {
    const asked: string[] = []
    const state = newTurnState(answering, cannedAnonymize(asked), undefined, null, answers)
    const tools = chatTools(state)
    const items = [{ key: "s!3", field: "workName", answer: "鈴木一郎様邸改修工事" }]
    await call(tools, "record_answers", { items })
    state.current = state.start
    await call(tools, "record_answers", { items })
    expect(asked).toEqual(["鈴木一郎様邸改修工事"])
  })

  test("知らない key・answer と confirm の両方・どちらも無い項目は何もしない。道具が無ければ使えないと返す", async () => {
    const state = newTurnState(answering, undefined, undefined, null, answers)
    expect(await call(chatTools(state), "record_answers", { items: [{ key: "nope", field: "engineer", answer: "試験 次郎" }] })).toMatchObject({ ok: false, unknownKeys: ["nope"] })
    expect(state.pending).toEqual([])
    const bad = chatTools(state).record_answers.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(bad.safeParse({ items: [{ key: "s!2", field: "engineer", answer: "x", confirm: true }] }).success).toBe(false)
    expect(bad.safeParse({ items: [{ key: "s!2", field: "engineer" }] }).success).toBe(false)
    expect(bad.safeParse({ items: [{ key: "s!2", field: "amount", answer: "1" }] }).success).toBe(false)
    expect(await call(chatTools(newTurnState(answering)), "record_answers", { items: [{ key: "s!2", field: "engineer", answer: "試験 次郎" }] })).toMatchObject({ ok: false })
  })
})

describe("問い合わせの文面（propose_inquiry）", () => {
  const asking = [
    kojiRow({ ...base, client: yamada, workName: `${yamada}邸新築工事`, amount: "5000", engineer: "" }, 2),
    kojiRow({ ...base, client: "株式会社　テスト", workName: "テストビル電気工事", amount: "1000", engineer: "" }, 3),
  ]
  asking[1]!.cells.endYm = { value: "202409", status: "warning", source: "J列", original: "", message: "引渡日から推定", guessed: true }
  const asked = { ...table, rows: asking, tax: "unknown" as const }
  const mail = { subject: "工事経歴書のご確認", intro: "資料ありがとうございました。いくつか教えてください。" }
  const others = { customerName: "サンプル建設工業", otherCustomers: async () => ["株式会社サンプル建設"] }

  test("get_inquiries は理由の id と推定の根拠を返す", async () => {
    const out = await call(chatTools(newTurnState(asked)), "get_inquiries", {})
    expect(out.cells.find((c: { field: string }) => c.field === "endYm")).toMatchObject({ key: "s!3", reasonId: "needsReview", note: "引渡日から推定" })
    expect(out.cells.find((c: { field: string }) => c.field === "engineer")).toMatchObject({ reasonId: "missing" })
  })

  test("質問の文とメールの下書きを変更案に溜める（表は変えない）。決まった文のまま残る数を返す", async () => {
    const state = newTurnState(asked, undefined, undefined, null, null, null, others)
    const out = await call(chatTools(state), "propose_inquiry", {
      ...mail,
      questions: [
        { text: "この工事に置いた主任技術者の氏名を教えてください。", targets: [{ field: "engineer" }] },
        { text: "この工事は引渡日を完成日としてよいですか。", targets: [{ field: "endYm", reasonId: "needsReview", keys: ["s!3"] }] },
      ],
    })
    expect(out).toEqual({ ok: true, questions: 2, covered: 3, fallback: 1 })
    expect(state.pending).toEqual([
      { kind: "inquiry", id: expect.any(String), text: "この工事に置いた主任技術者の氏名を教えてください。", targets: [{ field: "engineer" }] },
      { kind: "inquiry", id: expect.any(String), text: "この工事は引渡日を完成日としてよいですか。", targets: [{ field: "endYm", reason: "needsReview", keys: ["s!3"] }] },
      { kind: "inquiryMail", ...mail },
    ])
    expect(state.current).toBe(asked)
  })

  test("同じ指示で2回出すと、前の質問と重なる案は断り、件名と前置きは置き換える", async () => {
    const state = newTurnState(asked, undefined, undefined, null, null, null, others)
    const tools = chatTools(state)
    await call(tools, "propose_inquiry", { ...mail, questions: [{ text: "この工事の技術者を教えてください。", targets: [{ field: "engineer" }] }] })
    const again = await call(tools, "propose_inquiry", { ...mail, questions: [{ text: "技術者をもう一度。", targets: [{ field: "engineer" }] }] })
    expect(again).toMatchObject({ ok: false })
    expect(again.problems[0]).toContain("同じ問い合わせに2つの質問が当てはまります")
    const ok = await call(tools, "propose_inquiry", { subject: "新しい件名", intro: mail.intro, questions: [{ text: "完成年月を確かめてください。", targets: [{ field: "endYm" }] }] })
    expect(ok).toMatchObject({ ok: true, covered: 3 })
    expect(state.pending.filter((c) => c.kind === "inquiryMail")).toEqual([{ kind: "inquiryMail", subject: "新しい件名", intro: mail.intro }])
  })

  test("職員が外した問い合わせは、get_inquiries にも propose_inquiry の確かめにも入れない", async () => {
    const dismissedTable = { ...asked, dismissed: new Set(["s!2:engineer", "s!3:engineer"]) }
    const out = await call(chatTools(newTurnState(dismissedTable)), "get_inquiries", {})
    expect(out.cells.map((c: { field: string }) => c.field)).toEqual(["endYm"])
    const res = await call(chatTools(newTurnState(dismissedTable, undefined, undefined, null, null, null, others)), "propose_inquiry", { ...mail, questions: [{ text: "技術者を教えてください。", targets: [{ field: "engineer" }] }] })
    expect(res).toMatchObject({ ok: false, problems: ["questions[0].targets[0]: 今の問い合わせに当てはまりません"] })
  })

  test("get_inquiries のメモは値と同じ記号で出し、分かっている名前も伏せる。今の質問の文も返す", async () => {
    const withNote = { ...asked, rows: asked.rows.map((r) => (r.key === "s!2" ? { ...r, cells: { ...r.cells, endYm: { ...r.cells.endYm, value: "202409", guessed: true as const, status: "warning" as const, message: `${yamada}様の引渡日から推定（担当 新顔一郎）` } } } : r)) }
    const review = { turns: async () => [], names: async () => ["新顔一郎"], taken: async () => ({ rules: [], pending: [] }), rounding: "floor" as const }
    const out = await call(chatTools(newTurnState(withNote, undefined, undefined, null, null, review)), "get_inquiries", {})
    const c = out.cells.find((x: { key: string; field: string }) => x.key === "s!2" && x.field === "endYm")
    expect(c.note).toBe("〔Ａ〕様の引渡日から推定（担当 〔個人名〕）")
    expect(c.question).toEqual({ text: "完成年月は資料から推定しました。正しいかご確認ください。", by: "fixed" })
  })

  test("個人名・表の記号・ほかの顧客の名前の入った文と、当てはまらない対象は何も受け取らない", async () => {
    const tryText = async (patch: object) => {
      const state = newTurnState(asked, undefined, undefined, null, null, null, others)
      const out = await call(chatTools(state), "propose_inquiry", { ...mail, questions: [{ text: "この工事の技術者を教えてください。", targets: [{ field: "engineer" }] }], ...patch })
      expect(state.pending).toEqual([])
      return out
    }
    expect(await tryText({ questions: [{ text: "山田太郎様の工事の技術者を教えてください。", targets: [{ field: "engineer" }] }] })).toMatchObject({ ok: false, items: ["questions[0]"] })
    expect(await tryText({ intro: "〔Ａ〕邸の件でご連絡します。" })).toMatchObject({ ok: false, items: ["intro"] })
    expect(await tryText({ subject: "サンプル建設様と同じ件" })).toMatchObject({ ok: false, items: ["subject"] })
    // この案件の顧客の名前（ほかの顧客の名前を含む）は書いてよい
    const state = newTurnState(asked, undefined, undefined, null, null, null, others)
    expect(await call(chatTools(state), "propose_inquiry", { ...mail, subject: "サンプル建設工業様 工事経歴書のご確認", questions: [{ text: "この工事の技術者を教えてください。", targets: [{ field: "engineer" }] }] })).toMatchObject({ ok: true })
    expect(await tryText({ questions: [{ text: "着工年月を教えてください。", targets: [{ field: "startYm" }] }] })).toMatchObject({ ok: false, problems: ["questions[0].targets[0]: 今の問い合わせに当てはまりません"] })
  })
})

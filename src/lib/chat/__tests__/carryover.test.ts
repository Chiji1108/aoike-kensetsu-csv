import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { aiKey } from "../../convert/convert"
import { personToken } from "../../convert/persons"
import { kojiRow } from "../../convert/__tests__/helpers"
import { approvedChatProposals, carryoverPrompt, carryoverReady, knownWords, MASKED, maskUnknownText, namesForCarryover, codesFromModel, codesFromUi, MAX_CARRYOVER_CHARS, namesOfCase, nameScrubber } from "../carryover"
import type { ChatMessage } from "../messages"
import type { Proposal } from "../proposals"

const code = (c: string) => ({ type: "tool-code_execution" as const, toolCallId: c, state: "output-available" as const, input: { type: "programmatic-tool-call", code: c }, output: {} })
const SET = "await set_cells({'changes': fixes})"
const READ = "t = json.loads(await get_table({}))"

function assistant(id: string, proposal: string | null, parts: unknown[]): ChatMessage {
  return { id, role: "assistant", parts: [...parts, ...(proposal ? [{ type: "data-proposal", data: { id: proposal } }] : [])] } as ChatMessage
}

const closed = (id: string, applied: number): Proposal => ({ id, origin: { kind: "chat", messageId: `u-${id}` }, question: null, state: "closed", applied, rejected: 1 })

describe("去年のコード", () => {
  test("職員が1項目でも承認したチャットの変更案だけ（Excel の変更案・全部却下は除く）", () => {
    const proposals: Proposal[] = [
      closed("p1", 2),
      closed("p2", 0),
      { id: "p3", origin: { kind: "chat", messageId: "u3" }, question: null, state: "open", count: 3, applied: [1], rejected: [] },
      { id: "p4", origin: { kind: "chat", messageId: "u4" }, question: null, state: "open", count: 3, applied: [], rejected: [0] },
      { id: "p5", origin: { kind: "excel", fileId: "f" }, question: null, state: "closed", applied: 5, rejected: 0 },
    ]
    expect([...approvedChatProposals(proposals)].sort()).toEqual(["p1", "p3"])
    // 承認を取り消した変更案（承認の記録がすべて取り消し済み）は除く。一部だけ取り消したものは残す
    expect([...approvedChatProposals(proposals, [{ proposalId: "p1", undone: true }, { proposalId: "p3", undone: true }, { proposalId: "p3" }])].sort()).toEqual(["p3"])
  })

  test("承認した変更案の付いた返事の、表を変える道具を呼ぶコードだけを会話の順に（読むだけ・bash・重なりは除く）", () => {
    const ui: ChatMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "注文者を直して" }] },
      assistant("a1", "p1", [code(READ), code(`fixes = []\n${SET}`), { type: "tool-code_execution", toolCallId: "b", state: "output-available", input: { type: "bash_code_execution", command: "set_cells(x)" }, output: {} }]),
      assistant("a2", "p2", [code("await set_include({'rows': rows})")]),
      assistant("a3", "p3", [code(`fixes = []\n${SET}`), code("await ask_customer({'items': items})")]),
      assistant("a4", null, [code("await add_rows({'rows': rows})")]),
    ]
    expect(codesFromUi(ui, new Set(["p1", "p3"]))).toEqual([`fixes = []\n${SET}`, "await ask_customer({'items': items})"])
  })

  test("照合のスクリプトは AI に送った履歴から取り出す", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "直して" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "1", toolName: "code_execution", input: { type: "programmatic-tool-call", code: READ } },
          { type: "tool-call", toolCallId: "2", toolName: "code_execution", input: { type: "programmatic-tool-call", code: SET } },
          { type: "text", text: "直しました" },
        ],
      },
    ]
    expect(codesFromModel(messages)).toEqual([SET])
  })

  test("去年の案件で分かっている個人名（匿名化の persons・氏名の区切り・手直しの印・配置技術者）を〔個人名〕にする", () => {
    const work = {
      edits: [
        ["s!1:workName", { value: `${personToken("山田太郎")}邸新築工事`, by: "staff" as const }],
        ["s!2:engineer", { value: "青池　一郎", by: "chat" as const }],
        ["s!3:client", { value: "株式会社中村建設", by: "staff" as const }],
        ["s!4:engineer", { value: "未定", by: "staff" as const }],
      ] as const,
      replacements: { engineer: { "佐藤　花子": { value: "佐藤　次郎", by: "staff" as const } } },
    }
    const aiCache = [
      [aiKey("anonymizeClient", undefined, "鈴木一郎"), { id: 0, value: "〔1〕", needsReview: false, note: "", persons: ["鈴木一郎"] }],
      [aiKey("personName", undefined, "高橋健"), { id: 0, value: "高橋　健", needsReview: false, note: "" }],
      [aiKey("gyoshu", undefined, "内装"), { id: 0, value: "13", needsReview: false, note: "" }],
    ] as const
    const names = namesOfCase(work, aiCache)
    expect([...names].sort()).toEqual(["佐藤　次郎", "佐藤　花子", "山田太郎", "青池　一郎", "高橋　健", "高橋健", "鈴木一郎"].sort())
    const src = `m = {"山田太郎": "x", "青池一郎": "y", "青池 一郎": "z", "鈴木一郎": "w"}\nif c == "株式会社中村建設": pass  # 佐藤`
    const out = nameScrubber(names)(src)
    expect(out).toBe(`m = {"〔個人名〕": "x", "〔個人名〕": "y", "〔個人名〕": "z", "〔個人名〕": "w"}\nif c == "株式会社中村建設": pass  # 佐藤`)
  })

  test("氏名は氏名ごと置き換え、会社名・地名の中の姓は壊さない。2文字以下の名前は前後が文字でないときだけ。全角半角の違う書き方も置き換える", () => {
    const names = ["中村　一郎", "山田", "ヤマダタロウ", "青池"]
    const src = [`a = "株式会社中村建設"`, `b = "山田町"`, `c = "山田"`, `d = "中村一郎邸新築工事"`, `e = "ﾔﾏﾀﾞﾀﾛｳ"`, `f = "中村 一郎"`, `g = ["青池", "青池工務店"]`].join("\n")
    expect(nameScrubber(names)(src)).toBe(
      [`a = "株式会社中村建設"`, `b = "山田町"`, `c = "〔個人名〕"`, `d = "〔個人名〕邸新築工事"`, `e = "〔個人名〕"`, `f = "〔個人名〕"`, `g = ["〔個人名〕", "青池工務店"]`].join("\n"),
    )
  })

  test("空白で囲まれた短い名前・空白の入った氏名も置き換える（空白は消さずに比べる）", () => {
    expect(nameScrubber(["山田"])("# 担当 山田 の行")).toBe("# 担当 〔個人名〕 の行")
    expect(nameScrubber(["山田　太郎"])(`a = "山田 太郎"\nb = "山田　太郎"\nc = "山田  太郎"`)).toBe(`a = "〔個人名〕"\nb = "〔個人名〕"\nc = "〔個人名〕"`)
  })

  test("集めた名前に無い固有名も伏せる: 日本語の文字列とコメントのうち、今年の表の値・見出し・ルールに無い語を含むものは伏せる", () => {
    const words = knownWords({ rows: [kojiRow({ client: "株式会社青池", workName: `${personToken("鈴木一郎")}邸新築工事`, engineer: "青池　一郎" }, 1)], edits: [] }, ["工事名は最後に「に伴う内装工事」を付ける。株式会社は㈱"], ["現場名", "発注者名"])
    const code = [
      `x = "技術者一覧の佐々木　次郎"  # 田中さんの現場`,
      `y = name + "に伴う内装工事"`,
      `z = c.replace("株式会社", "㈱")`,
      `w = df["現場名"] + "ABC 123"`,
      `v = "新築工事"`,
      `u = '青池　一郎'`,
      `t = f"{a}邸"`,
      `s = """山本さん"""`,
      `# 業種は内装`,
    ].join("\n")
    expect(maskUnknownText(code, words)).toBe(
      [
        `x = "${MASKED}"  # ${MASKED}`,
        `y = name + "に伴う内装工事"`,
        `z = c.replace("株式会社", "㈱")`,
        `w = df["現場名"] + "ABC 123"`,
        `v = "新築工事"`,
        `u = '${MASKED}'`,
        `t = f"{a}邸"`,
        `s = """${MASKED}"""`,
        `# 業種は内装`,
      ].join("\n"),
    )
  })

  test("去年の作業を読めなかったときは、読めなかったと AI に伝える", () => {
    const { text } = carryoverPrompt({ fiscalYear: 2025, codes: [], skipped: "去年の案件の作業を読めなかったので、コードは添えません" })
    expect(text).toContain("去年の案件の作業を読めなかった")
    expect(text).not.toContain("承認につながったコードはありません")
  })

  test("個人名の集め方は1つ: 去年の作業と AI の結果・去年の Excel の配置技術者・今年の表。氏名でない値・長すぎる値は名前にしない", () => {
    const names = namesForCarryover({
      previous: { work: { edits: [["s!1:engineer", { value: "同上", by: "staff" }]], replacements: {} }, aiCache: [] },
      previousEngineers: ["なし", "同上", "x".repeat(300), "青池　一郎", ""],
      current: { rows: [kojiRow({ engineer: "佐藤　花子", client: `${personToken("鈴木一郎")}` }, 1)], edits: [["s!1:engineer", { value: "高橋　健", by: "staff" }]] },
    })
    expect([...names].sort()).toEqual(["佐藤　花子", "青池　一郎", "高橋　健", "鈴木一郎"].sort())
  })

  test("「去年のやり方で直す」を押せるのは去年との違いを決め終えたとき（去年の Excel が無い・今年が PDF だけ・読めない・比べるシートが無いときは待たない）", () => {
    const base = { previousSource: true, currentSource: true, previousSheets: "loading" as const, formatDiff: false }
    expect(carryoverReady(base)).toBe(false)
    expect(carryoverReady({ ...base, formatDiff: true, previousSheets: "loaded" })).toBe(true)
    // 読めたが今年のシートが無く比べられない（違いは作れない）ときは待たない
    expect(carryoverReady({ ...base, formatDiff: "unavailable", previousSheets: "loaded" })).toBe(true)
    expect(carryoverReady({ ...base, previousSource: false })).toBe(true)
    expect(carryoverReady({ ...base, currentSource: false })).toBe(true)
    expect(carryoverReady({ ...base, previousSheets: "error" })).toBe(true)
    expect(carryoverReady({ ...base, previousSheets: "noSheet" })).toBe(true)
    // 読めたが今年の計画がまだ（違いを作れない）間は待つ
    expect(carryoverReady({ ...base, previousSheets: "loaded" })).toBe(false)
  })

  test("添える文: コードは上限の文字数まで。無ければルールだけで直すと伝える", () => {
    expect(carryoverPrompt({ fiscalYear: 2025, codes: [] })).toEqual({ text: expect.stringContaining("承認につながったコードはありません"), included: 0 })
    const big = "x".repeat(MAX_CARRYOVER_CHARS / 2)
    const { text, included } = carryoverPrompt({ fiscalYear: 2025, codes: [big, big, "small"] })
    expect(included).toBe(1)
    expect(text).toContain("去年（2025年度）の参考")
    expect(text).toContain("後ろの 2 件は省いた")
    expect(text).toContain("### コード1")
    expect(text).not.toContain("### コード2")
    expect(text).toContain("そのまま実行しない")
    // 1つ目が上限より長ければ途中で切る
    const huge = carryoverPrompt({ fiscalYear: 2025, codes: ["y".repeat(MAX_CARRYOVER_CHARS * 3)] })
    expect(huge.included).toBe(1)
    expect(huge.text.length).toBeLessThan(MAX_CARRYOVER_CHARS + 1000)
    expect(huge.text).toContain("ここから先は省いた")
  })
})

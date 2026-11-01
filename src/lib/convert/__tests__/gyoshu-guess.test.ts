import { describe, expect, test } from "bun:test"
import { AI_TASKS, parseAiResponse } from "../ai-tasks"
import { dominantGyoshu, GYOSHU_BASIS_LABELS, GYOSHU_GUESS_RULE, gyoshuTrend, suggestionEdits, suggestionInput, trendText, type GyoshuSuggestion } from "../gyoshu-guess"
import { systemPrompt } from "../../chat/turn"
import { approvedChange } from "../../chat/proposals"
import { batchUserMessage, systemPrompt as convertSystemPrompt } from "../prompt"
import { KOJI_KEIREKI } from "../../spec/koji-keireki"
import { kojiRow } from "./helpers"

const rows = [
  ...Array.from({ length: 7 }, (_, i) => kojiRow({ gyoshu: "8", workName: `合成ビル照明改修${i}` }, i)),
  kojiRow({ gyoshu: "9", workName: "合成工場空調更新" }, 7),
  kojiRow({ gyoshu: "", workName: "合成倉庫改修" }, 8),
  kojiRow({ gyoshu: "", workName: "合成事務所受変電設備更新" }, 9),
]
// AI の推定の業種は傾向に数えない
rows.push({ ...kojiRow({ gyoshu: "9", workName: "合成推定" }, 10), cells: { ...kojiRow({ gyoshu: "9" }, 10).cells, gyoshu: { value: "9", status: "warning", source: "AI", original: "", guessed: true } } })

describe("業種の推定", () => {
  test("ほかの工事の傾向は、対象の行・業種が決まっていない行・推定の行を除いて決まった処理で数える", () => {
    const t = gyoshuTrend(rows, new Set(["s!8", "s!9"]))
    expect(t).toEqual({ total: 8, counts: [{ code: "8", count: 7 }, { code: "9", count: 1 }] })
    expect(trendText(t)).toBe("ほかの工事の業種: 8 件中 7 件が電気（8）、1 件が管（9）。傾向がはっきりしている: 電気（8）")
    // 6割に届かない・少なすぎる傾向からは推し量らない
    expect(dominantGyoshu({ total: 10, counts: [{ code: "25", count: 5 }, { code: "15", count: 5 }] })).toBeUndefined()
    expect(dominantGyoshu({ total: 3, counts: [{ code: "8", count: 3 }] })).toBeUndefined()
    expect(trendText({ total: 10, counts: [{ code: "25", count: 5 }, { code: "15", count: 5 }] })).toContain("傾向ははっきりしない（推し量らない）")
    expect(trendText(gyoshuTrend([], new Set()))).toContain("決まっている工事がない")
  })

  test("AI に送るのは工事名・注文者（画面の値）と元の業種の記載だけ", () => {
    expect(suggestionInput(rows[8]!)).toBe("工事名: 合成倉庫改修 / 注文者: （空） / 元の業種の記載: （なし）")
  })

  test("答えはコード表で確かめ、決められない・コード表に無い値は案にしない。推し量った値は根拠に推定と書く", () => {
    const byId = new Map([
      [0, rows[8]!],
      [1, rows[9]!],
      [2, rows[0]!],
    ])
    const results = new Map<number, GyoshuSuggestion>([
      [0, { id: 0, value: "8", basis: "trend", confident: true, note: "ほかの工事 8 件中 7 件が電気" }],
      [1, { id: 1, value: "8", basis: "workName", confident: true, note: "受変電" }],
      [2, { id: 2, value: "31", basis: "workName", confident: true, note: "" }],
    ])
    const trend = gyoshuTrend(rows, new Set(["s!8", "s!9"]))
    const { edits, undecided } = suggestionEdits(byId, results, trend)
    expect(undecided).toBe(1)
    // AI が迷った（confident でない）答えは案にしない
    const unsure = new Map(results).set(1, { id: 1, value: "8", basis: "workName", confident: false, note: "" })
    expect(suggestionEdits(byId, unsure, trend)).toMatchObject({ undecided: 2 })
    // 傾向がはっきりしない案件では、推し量った値を受け取らない
    expect(suggestionEdits(byId, results, { total: 10, counts: [{ code: "8", count: 5 }, { code: "9", count: 5 }] }).edits.map((e) => e.basis)).toEqual(["workName"])
    expect(edits.map((e) => [e.rowKey, e.edit.value, e.basis])).toEqual([
      ["s!8", "8", "trend"],
      ["s!9", "8", "workName"],
    ])
    // 工事名・傾向から決めた値は推定の印で見せる（承認で外す: approvedChange）。元データの記載から決めた値は推定にしない
    expect(edits[0]!.edit).toEqual({ value: "8", by: "chat", message: `AI の案（${GYOSHU_BASIS_LABELS.trend}）: ほかの工事 8 件中 7 件が電気`, guessed: true })
    expect(edits[1]!.edit.guessed).toBe(true)
    const fromSource = suggestionEdits(new Map([[0, rows[8]!]]), new Map([[0, { id: 0, value: "8", basis: "source", confident: true, note: "電工" }]]), trend)
    expect(fromSource.edits[0]!.edit.guessed).toBeUndefined()
    const proposal = { origin: { kind: "fix" as const, runId: "r", field: "gyoshu" as const } }
    const change = { kind: "cell" as const, rowKey: "s!8", field: "gyoshu" as const, edit: edits[0]!.edit }
    expect(approvedChange(proposal, change)).toEqual({ ...change, edit: { value: "8", by: "chat", message: edits[0]!.edit.message } })
    // チャットの推定の印は承認しても残す
    expect(approvedChange({ origin: { kind: "chat", messageId: "m" } }, change)).toBe(change)
  })

  test("AI の答えの形は固定の schema で確かめ、頼んでいない id は捨てる", () => {
    const req = { task: "suggestGyoshu" as const, items: [{ id: 0, input: "工事名: x" }] }
    const parsed = parseAiResponse("suggestGyoshu", req, { results: [{ id: 0, value: "8", basis: "workName", confident: true, note: "照明" }, { id: 5, value: "9", basis: "source", confident: true, note: "" }] })
    expect(parsed.ok && [...parsed.results.keys()]).toEqual([0])
    expect(parseAiResponse("suggestGyoshu", req, { results: [{ id: 0, value: "8", basis: "guess", confident: true, note: "" }] }).ok).toBe(false)
    expect(parseAiResponse("suggestGyoshu", req, { results: [{ id: 0, value: "8", basis: "workName", note: "" }] }).ok).toBe(false)
  })

  test("推定の決まりは変換の AI・AI で案を出す・チャットの指示で同じ文。案の指示は共通の指示（計画・変換）に入れず、頼むときの文に書く", () => {
    expect(AI_TASKS.gyoshu.instruction).toContain(GYOSHU_GUESS_RULE)
    expect(AI_TASKS.suggestGyoshu.instruction).toContain(GYOSHU_GUESS_RULE)
    expect(convertSystemPrompt(KOJI_KEIREKI)).not.toContain(AI_TASKS.suggestGyoshu.instruction)
    expect(batchUserMessage({ task: "suggestGyoshu", instruction: "ほかの工事の業種: x", items: [] })).toContain(AI_TASKS.suggestGyoshu.instruction)
    expect(batchUserMessage({ task: "gyoshu", items: [] })).not.toContain(AI_TASKS.gyoshu.instruction)
    expect(systemPrompt({ global: "", customerName: "合成", customer: "", rule7Tax: "excluded" }, "", [])).toContain(GYOSHU_GUESS_RULE)
  })
})

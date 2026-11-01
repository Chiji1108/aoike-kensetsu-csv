import { describe, expect, test } from "bun:test"
import { AI_TASKS, parseAiResponse } from "../ai-tasks"
import { GYOSHU_BASIS_LABELS, GYOSHU_GUESS_RULE, gyoshuTrend, suggestionEdits, suggestionInput, trendText, type GyoshuSuggestion } from "../gyoshu-guess"
import { systemPrompt } from "../../chat/turn"
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
    expect(trendText(t)).toBe("ほかの工事の業種: 8 件中 7 件が電気（8）、1 件が管（9）")
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
      [0, { id: 0, value: "8", basis: "trend", note: "ほかの工事 8 件中 7 件が電気" }],
      [1, { id: 1, value: "8", basis: "workName", note: "受変電" }],
      [2, { id: 2, value: "31", basis: "workName", note: "" }],
    ])
    const { edits, undecided } = suggestionEdits(byId, results)
    expect(undecided).toBe(1)
    expect(edits.map((e) => [e.rowKey, e.edit.value, e.basis])).toEqual([
      ["s!8", "8", "trend"],
      ["s!9", "8", "workName"],
    ])
    expect(edits[0]!.edit).toEqual({ value: "8", by: "chat", message: `AI の案（${GYOSHU_BASIS_LABELS.trend}）: ほかの工事 8 件中 7 件が電気` })
    // 承認したら職員が確かめた値（推定の印は付けない。根拠は注意書きに残す）
    expect(edits[0]!.edit.guessed).toBeUndefined()
  })

  test("AI の答えの形は固定の schema で確かめ、頼んでいない id は捨てる", () => {
    const req = { task: "suggestGyoshu" as const, items: [{ id: 0, input: "工事名: x" }] }
    const parsed = parseAiResponse("suggestGyoshu", req, { results: [{ id: 0, value: "8", basis: "workName", note: "照明" }, { id: 5, value: "9", basis: "source", note: "" }] })
    expect(parsed.ok && [...parsed.results.keys()]).toEqual([0])
    expect(parseAiResponse("suggestGyoshu", req, { results: [{ id: 0, value: "8", basis: "guess", note: "" }] }).ok).toBe(false)
  })

  test("推定の決まりは変換の AI・AI で案を出す・チャットの指示で同じ文", () => {
    expect(AI_TASKS.gyoshu.instruction).toContain(GYOSHU_GUESS_RULE)
    expect(AI_TASKS.suggestGyoshu.instruction).toContain(GYOSHU_GUESS_RULE)
    expect(systemPrompt({ global: "", customerName: "合成", customer: "", rule7Tax: "excluded" }, "", [])).toContain(GYOSHU_GUESS_RULE)
  })
})

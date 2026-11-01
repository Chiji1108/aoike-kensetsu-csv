import { describe, expect, test } from "bun:test"
import { kojiRow } from "../../convert/__tests__/helpers"
import { summarizeKoji } from "../../convert/koji-selection"
import { selectRows } from "../view"
import { askFacts, askImpact as impactOf, askPrompt, askWording, needsConfirm } from "../ask-impact"

/** 合成の10行。8行が「未成」の区分（うち6行は完成年月が入っている） */
const rows = Array.from({ length: 10 }, (_, i) => kojiRow({ gyoshu: "8", motoukeShitauke: "1", amount: String(1000 - i * 10), endYm: i < 6 ? "202503" : "" }, i))
const unfinished = new Set(rows.slice(0, 8).map((r) => r.key))
const all = { manual: new Map<string, boolean>(), tax: "excluded" as const, basis: {}, rule7Tax: "excluded" as const, selection: "all" as const }

/** 画面と同じく、今の選んだ行と7割の合計を先に作って渡す */
const askImpact = (rows_: typeof rows, s: Parameters<typeof impactOf>[1], keys: ReadonlySet<string>) => {
  const inclusion = selectRows(s, rows_)
  return impactOf(rows_, s, keys, { inclusion, summary: summarizeKoji(rows_, inclusion, s) })
}

describe("計画の聞き返しの答えの見込み", () => {
  test("載せない側の答えで載せる件数がどう変わるかを、今の選び方で選び直して出す。大半を外す答えは押す前に確かめる", () => {
    const i = askImpact(rows, all, unfinished)
    expect([i.before, i.after]).toEqual([10, 2])
    expect(needsConfirm(i)).toBe(true)
  })

  test("少しだけ外す答えは確かめない。手動で載せた行は答えでも外れない（表と同じ決まり）", () => {
    const one = new Set([rows[0]!.key])
    expect(needsConfirm(askImpact(rows, all, one))).toBe(false)
    const manual = new Map(rows.slice(0, 8).map((r) => [r.key, true]))
    expect(askImpact(rows, { ...all, manual }, unfinished).after).toBe(10)
  })

  test("決算書の額を入れていれば、7割に届かなくなる答えも確かめる", () => {
    const basis = { "8": { total: 9_000 } }
    const few = new Set([rows[0]!.key, rows[1]!.key, rows[2]!.key, rows[3]!.key])
    const i = askImpact(rows, { ...all, basis }, few)
    expect(i.shortBefore).toEqual([])
    expect(i.shortAfter).toEqual(["電気（完成工事高）"])
    expect(needsConfirm(i)).toBe(true)
  })

  test("対象がデータの大半になるときだけ、事実（行の数・完成年月の入っている行）を決まった処理で数えて添える", () => {
    expect(askFacts("unfinished", rows, unfinished)).toBe("データの 10 行のうち 8 行が当たります。そのうち 6 行は完成年月が入っています（区分が古いままかもしれません）。")
    expect(askFacts("doubtful", rows, unfinished)).toBe("データの 10 行のうち 8 行が当たります。")
    expect(askFacts("unfinished", rows, new Set([rows[0]!.key]))).toBeUndefined()
  })

  /** 7割で選ぶ合成の10行（金額の大きい5行で7割に届く） */
  const r7rows = [500, 400, 300, 200, 100, 100, 100, 100, 100, 100].map((a, i) => kojiRow({ gyoshu: "8", motoukeShitauke: "1", amount: String(a) }, i))
  const rule7 = { ...all, selection: "rule7" as const }
  const keysOf = (...ix: number[]) => new Set(ix.map((i) => r7rows[i]!.key))

  test("載せる件数が変わるなら、答えのボタンに件数を付け、今載せている対象の数を出す", () => {
    const w = askWording(askImpact(rows, all, unfinished), 8)
    expect(w.detail).toBe("該当 8 行（今載せているのは 8 行）")
    expect([w.label("exclude", "載せない"), w.label("keep", "載せる")]).toEqual(["載せない（載せる 10 → 2 件）", "載せる（10 件のまま）"])
  })

  test("外すと代わりにほかの行が7割に選ばれて件数が変わらないなら、ボタンに同じ件数を並べず、代わりに選ばれると書く", () => {
    const i = askImpact(r7rows, rule7, keysOf(0))
    expect([i.before, i.after, i.targets, i.dropped, i.swapped]).toEqual([5, 5, 1, 1, 1])
    const w = askWording(i, 1)
    expect(w.detail).toBe("該当 1 行（今載せているのは 1 行）。外すとこの 1 行の代わりにほかの 1 行が7割に選ばれます（載せる件数は 5 件のまま）")
    expect(w.label("exclude", "載せない")).toBe("載せない")
    expect(w.label("keep", "載せる")).toBe("載せる")
  })

  test("対象の行を今載せていなくても、外すと7割の元の合計が減ってほかの行が要らなくなることがある（そうと書く）", () => {
    const i = askImpact(r7rows, rule7, keysOf(8, 9))
    expect([i.before, i.targets, i.othersDropped]).toEqual([5, 0, 1])
    expect(askWording(i, 2).detail).toBe("該当 2 行（今載せているのは 0 行）。外すと7割の元の合計も減るので、ほかの 1 行も載らなくなります")
  })

  test("対象の行を今載せておらず件数も変わらないなら、どちらでも変わらないと書く。手で載せた行は答えでも外れない", () => {
    const basis = { "8": { total: 2_200 } }
    const i = askImpact(r7rows, { ...rule7, basis }, keysOf(9))
    expect([i.before, i.after, i.targets]).toEqual([6, 6, 0])
    expect(askWording(i, 1).detail).toBe("該当 1 行（今載せているのは 0 行）。どちらでも載せる件数は変わりません（この 1 行は今載せていません）")
    const manual = new Map([[r7rows[0]!.key, true]])
    const m = askImpact(r7rows, { ...all, manual }, keysOf(0))
    expect(askWording(m, 1).detail).toBe("該当 1 行（今載せているのは 1 行）。どちらでも載せる件数は変わりません（手で載せた行は答えでは外れません）")
  })

  test("「AI に聞く」の質問は聞き返しの文と元の Excel の行番号（シートごと・重ねない・多ければ残りの数）を入れる", () => {
    expect(askPrompt("備考に注記のある行があります。", [{ sheet: "一覧", row: 11 }, { sheet: "一覧", row: 4 }, { sheet: "一覧", row: 4 }, { sheet: "別", row: 2 }], 1)).toBe(
      "計画の聞き返し「備考に注記のある行があります。」は、どういうことですか？ 対象は元の Excel の「一覧」5・12行目、「別」3行目（3 行。今載せているのは 1 行）です。中身を見て、判断に要ることを教えてください。",
    )
    const many = Array.from({ length: 25 }, (_, row) => ({ sheet: "一覧", row }))
    expect(askPrompt("x", many, null)).toContain("「一覧」1・2・3・4・5・6・7・8・9・10・11・12・13・14・15・16・17・18・19・20行目、ほか 5 行（25 行）です。")
  })
})

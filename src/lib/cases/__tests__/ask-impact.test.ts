import { describe, expect, test } from "bun:test"
import { kojiRow } from "../../convert/__tests__/helpers"
import { summarizeKoji } from "../../convert/koji-selection"
import { selectRows } from "../view"
import { askFacts, askImpact as impactOf, needsConfirm } from "../ask-impact"

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
})

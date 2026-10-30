import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReport, readRun, recordCost, reportMarkdown, runUsd, spread, widthPoints, type CostEntry, type RunData, type RunSummary } from "../report"

const summary = (c: string, variant: string, cellRate: number, over: Partial<RunSummary> = {}): RunSummary => ({
  status: "done",
  case: c,
  variant,
  score: {
    staffRows: 10,
    ourRows: 9,
    matchedRows: 8,
    extraRows: 1,
    cellRate,
    perField: [
      { field: "client", label: "注文者", ok: Math.round(cellRate * 8), n: 8, excluded: false },
      { field: "engineer", label: "配置技術者", ok: 0, n: 8, excluded: true },
    ],
  },
  turns: variant === "baseline" ? 0 : 3,
  ms: 60_000,
  conversionUsd: 0.5,
  usd: variant === "baseline" ? 0 : 0.25,
  ...over,
})
const run = (name: string, summaries: RunSummary[], costs: CostEntry[] = []): RunData => ({ name, summaries, costs })
const cost = (usd: number): CostEntry => ({ case: "B", variant: "edit", kind: "chat", usd })

describe("照合の表", () => {
  test("回をまたいで案件・variant ごとに平均・最小〜最大を出し、不足は職員の行から対応づいた行を引く", () => {
    const report = buildReport([
      run("run1", [summary("B", "edit", 0.9), summary("B", "baseline", 0.8)]),
      run("run2", [summary("B", "edit", 0.95), summary("B", "baseline", 0.8, { score: { ...summary("B", "baseline", 0.8).score, matchedRows: 6 } })]),
    ])
    expect(report.rows.map((r) => r.variant)).toEqual(["baseline", "edit"])
    const edit = report.rows[1]!
    expect(edit.runs).toBe(2)
    expect(edit.cellRate.min).toBeCloseTo(0.9)
    expect(edit.cellRate.max).toBeCloseTo(0.95)
    expect(edit.cellRate.mean).toBeCloseTo(0.925)
    expect(widthPoints(edit.cellRate)).toBeCloseTo(5)
    expect(report.rows[0]!.missingRows.values).toEqual([2, 4])
    expect(edit.fields.find((f) => f.field === "engineer")!.excluded).toBe(true)
  })

  test("終わらなかった回（落ちた・止めた）は値に入れず、数と理由を出す", () => {
    const report = buildReport([
      run("run1", [summary("B", "edit", 0.9)]),
      run("run2", [summary("B", "edit", 0.1, { status: "failed", reason: "stream error" })]),
      run("run3", [summary("B", "edit", 0.2, { status: "stopped", reason: "費用の上限" })]),
    ])
    const edit = report.rows[0]!
    expect(edit.runs).toBe(1)
    expect(edit.cellRate.values).toEqual([0.9])
    expect(edit.incomplete).toEqual({ count: 2, reasons: ["落ちた: stream error", "止めた: 費用の上限"] })
    expect(reportMarkdown(report)).toContain("| B | edit | 1 | 2（落ちた: stream error、止めた: 費用の上限） | 90.0 |")
    const empty = { ...summary("B", "baseline", 0).score, perField: [] }
    const onlyFailed = buildReport([run("run1", [summary("B", "edit", 0.9), summary("B", "baseline", 0, { status: "failed", reason: "x", score: empty })])])
    const md = reportMarkdown(onlyFailed)
    expect(md).toContain("| B | baseline | 0 | 1（落ちた: x） | - |")
    // 列の無い行も見出しの数だけ - を出す
    expect(md).toContain("| B | baseline | - | - |")
  })

  test("費用の合計は costs.jsonl の合計（要約の無い、落ちた照合の分も含む）", () => {
    const report = buildReport([run("run1", [summary("B", "edit", 0.9)], [cost(0.25), cost(1)]), run("run2", [], [cost(0.5)])])
    expect(report.totalUsd).toBeCloseTo(1.75)
  })

  test("案件は案件定義の順、variant は baseline → edit → rules → nextyear → location の回の順", () => {
    const report = buildReport(
      [run("run1", [summary("Z", "baseline", 1), summary("A", "location-2", 1), summary("A", "location-1", 1), summary("A", "baseline", 1), summary("B", "nextyear", 1), summary("B", "edit", 1)])],
      ["B", "A"],
    )
    expect(report.rows.map((r) => `${r.case}:${r.variant}`)).toEqual(["B:edit", "B:nextyear", "A:baseline", "A:location-1", "A:location-2", "Z:baseline"])
  })

  test("Markdown は1回なら値だけ、2回以上で違えば 平均（最小〜最大）。除外した列は括弧", () => {
    const one = reportMarkdown(buildReport([run("run1", [summary("B", "edit", 0.9)])]))
    expect(one).toContain("| B | edit | 1 | - | 90.0 | 0.0 |")
    expect(one).toContain("| B | edit | 87.5 | (0.0) |")
    const two = reportMarkdown(buildReport([run("run1", [summary("B", "edit", 0.9)]), run("run2", [summary("B", "edit", 0.95, { searches: 4 })])]))
    expect(two).toContain("92.5（90.0〜95.0） | 5.0 |")
    expect(two).toContain("（検索 4回）")
  })

  test("空の値は NaN の揺れにし、表では - にする", () => {
    expect(Number.isNaN(spread([]).mean)).toBe(true)
    const report = buildReport([run("run1", [summary("B", "edit", 0.9, { score: { ...summary("B", "edit", 0.9).score, perField: [{ field: "client", label: "注文者", ok: 0, n: 0, excluded: false }] } })])])
    expect(reportMarkdown(report)).toContain("| B | edit | - |")
  })
})

describe("回のフォルダ", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-report-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("費用は使うたびに足し（0 は足さない）、要約と一緒に読む。ほかのファイルは読まない", () => {
    recordCost(dir, cost(0.3))
    recordCost(dir, cost(0))
    recordCost(dir, cost(0.2))
    writeFileSync(join(dir, "summary-B-edit.json"), JSON.stringify(summary("B", "edit", 0.9)))
    writeFileSync(join(dir, "B-edit.json"), "{}")
    const r = readRun(dir)
    expect(r.costs).toHaveLength(2)
    expect(runUsd(r)).toBeCloseTo(0.5)
    expect(r.summaries.map((s) => s.variant)).toEqual(["edit"])
    expect(readRun(join(dir, "無い")).costs).toEqual([])
  })
})

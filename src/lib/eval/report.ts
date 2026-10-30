/**
 * 実例での照合（scripts/eval.ts）の結果を1つの表にする。scripts/eval.ts は回ごとに RunSummary を書き、
 * scripts/eval-report.ts が回のフォルダを並べて読み、案件・variant ごとに一致率・載せる行・指示の回数・時間・費用と、回をまたいだ揺れ（最小〜最大・平均）を出す。
 * 費用は使ったときに回のフォルダの costs.jsonl に1行ずつ足す（落ちた回の分も残る）。回の費用はここからだけ数える
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

export type FieldScore = { field: string; label: string; ok: number; n: number; excluded: boolean }

/** 1回の照合の要約（scripts/eval.ts の compare の結果と、指示の回数・時間・費用） */
export type RunSummary = {
  /** done: 終わった。failed: 途中で落ちた。stopped: 費用の上限で指示を止めた。表の値は done の回だけで出す */
  status: "done" | "failed" | "stopped"
  /** done でないときの理由 */
  reason?: string
  case: string
  /** baseline | edit | rules | nextyear | location-<n>（location の n 回目。2回目からは覚えた結果を使う） */
  variant: string
  score: {
    /** 職員の CSV の行（載せた行） */
    staffRows: number
    /** こちらの CSV の行 */
    ourRows: number
    /** 職員の行と対応づいた行 */
    matchedRows: number
    /** 職員の行と対応づかないこちらの行（余分） */
    extraRows: number
    /** 対応づいた行のセルのうち一致した割合（除外した列を除く） */
    cellRate: number
    perField: FieldScore[]
  }
  /** チャットの指示の回数（baseline・location は 0） */
  turns: number
  ms: number
  /** 変換（列の計画と値の判断）の AI の費用 */
  conversionUsd: number
  /** この variant の費用（チャットの指示か工事場所の調査。変換の分は入れない） */
  usd: number
  /** 工事場所の調査の Web 検索の回数 */
  searches?: number
}

/** 使った費用の1件（costs.jsonl の1行） */
export type CostEntry = { case: string; variant: string; kind: string; usd: number }

export const COSTS_FILE = "costs.jsonl"

/** 費用を使った時点で回のフォルダに足す */
export function recordCost(dir: string, entry: CostEntry) {
  if (entry.usd > 0) appendFileSync(join(dir, COSTS_FILE), JSON.stringify(entry) + "\n")
}

export type RunData = { name: string; summaries: RunSummary[]; costs: CostEntry[] }

/** 回のフォルダの要約（summary-*.json）と費用（costs.jsonl）を読む */
export function readRun(dir: string): RunData {
  const files = existsSync(dir) ? readdirSync(dir) : []
  const summaries = files.filter((f) => /^summary-.+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RunSummary)
  const costs = files.includes(COSTS_FILE)
    ? readFileSync(join(dir, COSTS_FILE), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as CostEntry)
    : []
  return { name: basename(dir), summaries, costs }
}

/** 回の費用（落ちた回・止めた回の分も含む） */
export const runUsd = (run: Pick<RunData, "costs">) => run.costs.reduce((a, c) => a + c.usd, 0)

export type Spread = { mean: number; min: number; max: number; values: number[] }

export type ReportRow = {
  case: string
  variant: string
  /** 並べた回のうち、この案件・variant が終わった（done）回の数。値はこの回だけで出す */
  runs: number
  /** 終わらなかった回（落ちた・費用の上限で止めた）の数と理由 */
  incomplete: { count: number; reasons: string[] }
  cellRate: Spread
  staffRows: number
  ourRows: Spread
  matchedRows: Spread
  extraRows: Spread
  /** 職員の行のうち、こちらに対応づく行が無い数（不足） */
  missingRows: Spread
  turns: Spread
  seconds: Spread
  conversionUsd: Spread
  usd: Spread
  searches?: Spread
  /** 列ごとの一致率（対応づいた行が 0 の回は数えない） */
  fields: { field: string; label: string; excluded: boolean; rate: Spread; ok: number[]; n: number[] }[]
}

export type Report = { runs: string[]; rows: ReportRow[]; totalUsd: number }

export function spread(values: number[]): Spread {
  if (!values.length) return { mean: Number.NaN, min: Number.NaN, max: Number.NaN, values }
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values), values }
}

const VARIANT_ORDER = ["baseline", "edit", "rules", "nextyear"]
const variantRank = (v: string) => {
  const i = VARIANT_ORDER.indexOf(v)
  return i >= 0 ? i : VARIANT_ORDER.length + (Number(/^location-(\d+)$/.exec(v)?.[1]) || 0)
}

/** runs は回の名前と、その回の要約。案件は caseOrder の順（無い案件は名前順で後ろ）、variant は baseline → edit → rules → nextyear → location-n の順 */
export function buildReport(runs: RunData[], caseOrder: string[] = []): Report {
  const groups = new Map<string, RunSummary[]>()
  for (const run of runs)
    for (const s of run.summaries) {
      const k = `${s.case}\u0000${s.variant}`
      groups.set(k, [...(groups.get(k) ?? []), s])
    }
  const caseRank = (c: string) => {
    const i = caseOrder.indexOf(c)
    return i >= 0 ? i : caseOrder.length
  }
  const rows = [...groups.values()]
    .map((all): ReportRow => {
      const first = all[0]!
      const list = all.filter((s) => s.status === "done")
      const notDone = all.filter((s) => s.status !== "done")
      const of = (f: (s: RunSummary) => number) => spread(list.map(f))
      const withSearches = list.filter((s) => s.searches !== undefined)
      return {
        case: first.case,
        variant: first.variant,
        runs: list.length,
        incomplete: { count: notDone.length, reasons: notDone.map((s) => `${s.status === "stopped" ? "止めた" : "落ちた"}: ${s.reason ?? "理由不明"}`) },
        cellRate: of((s) => s.score.cellRate),
        staffRows: first.score.staffRows,
        ourRows: of((s) => s.score.ourRows),
        matchedRows: of((s) => s.score.matchedRows),
        extraRows: of((s) => s.score.extraRows),
        missingRows: of((s) => s.score.staffRows - s.score.matchedRows),
        turns: of((s) => s.turns),
        seconds: of((s) => s.ms / 1000),
        conversionUsd: of((s) => s.conversionUsd),
        usd: of((s) => s.usd),
        ...(withSearches.length ? { searches: spread(withSearches.map((s) => s.searches!)) } : {}),
        fields: (list[0] ?? first).score.perField.map((f) => {
          const per = list.map((s) => s.score.perField.find((x) => x.field === f.field) ?? { ok: 0, n: 0 })
          return {
            field: f.field,
            label: f.label,
            excluded: f.excluded,
            rate: spread(per.filter((x) => x.n > 0).map((x) => x.ok / x.n)),
            ok: per.map((x) => x.ok),
            n: per.map((x) => x.n),
          }
        }),
      }
    })
    .sort((a, b) => caseRank(a.case) - caseRank(b.case) || a.case.localeCompare(b.case) || variantRank(a.variant) - variantRank(b.variant))
  return { runs: runs.map((r) => r.name), rows, totalUsd: runs.reduce((a, r) => a + runUsd(r), 0) }
}

const pct = (v: number) => (Number.isNaN(v) ? "-" : (v * 100).toFixed(1))
/** 1回なら値だけ、2回以上なら「平均（最小〜最大）」 */
function show(s: Spread, f: (v: number) => string) {
  if (!s.values.length) return "-"
  if (s.values.length === 1 || s.min === s.max) return f(s.mean)
  return `${f(s.mean)}（${f(s.min)}〜${f(s.max)}）`
}
/** 揺れの幅（ポイント） */
export const widthPoints = (s: Spread) => (s.values.length < 2 ? 0 : (s.max - s.min) * 100)

export function reportMarkdown(r: Report): string {
  const lines: string[] = []
  lines.push(`回: ${r.runs.join(", ")}（${r.runs.length}回）。費用の合計 $${r.totalUsd.toFixed(2)}（落ちた・止めた回の分も含む）。値は終わった回だけで出す`, "")
  lines.push("| 案件 | variant | 回数 | 未完了 | 一致率 % | 揺れ（pt） | 職員の行 | こちらの行 | 対応 | 余分 | 不足 | 指示 | 時間（秒） | 変換 $ | 指示・調査 $ |")
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  const int = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
  for (const row of r.rows) {
    const searches = row.searches ? `（検索 ${show(row.searches, int)}回）` : ""
    lines.push(
      `| ${row.case} | ${row.variant} | ${row.runs} | ${row.incomplete.count ? `${row.incomplete.count}（${row.incomplete.reasons.join("、")}）` : "-"} | ${show(row.cellRate, pct)} | ${widthPoints(row.cellRate).toFixed(1)} | ${row.staffRows} | ${show(row.ourRows, int)} | ${show(row.matchedRows, int)} | ${show(row.extraRows, int)} | ${show(row.missingRows, int)} | ${show(row.turns, int)} | ${show(row.seconds, (v) => v.toFixed(0))} | ${show(row.conversionUsd, (v) => v.toFixed(2))} | ${show(row.usd, (v) => v.toFixed(2))}${searches} |`,
    )
  }
  // 列の見出しは列のある行から（落ちた回だけの行は列を持たない）
  const fields = r.rows.find((row) => row.fields.length)?.fields ?? []
  lines.push("", "列ごとの一致率 %（除外した列は括弧。2回以上は 平均（最小〜最大））", "")
  lines.push(`| 案件 | variant | ${fields.map((f) => f.label).join(" | ")} |`)
  lines.push(`| --- | --- | ${fields.map(() => "---").join(" | ")} |`)
  for (const row of r.rows) {
    const cells = fields.map(({ field }) => {
      const f = row.fields.find((x) => x.field === field)
      if (!f) return "-"
      const v = show(f.rate, pct)
      return f.excluded ? `(${v})` : v
    })
    lines.push(`| ${row.case} | ${row.variant} | ${cells.join(" | ")} |`)
  }
  return lines.join("\n") + "\n"
}

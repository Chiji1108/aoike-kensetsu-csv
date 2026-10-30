import { columnLetter, type SheetGrid } from "./plan"
import { nfkc, removeSpaces } from "./text"

/**
 * 去年の案件の元の Excel と今年の元の Excel の形（シートの構成・見出し・列の並び）を、決まった処理で比べる。
 * 2年目以降は顧客ルールと去年のコードを最初の指示に使うので、形が変わった年（列の名前・順番が変わった、列やシートが増えた）を
 * 職員と AI の両方に先に知らせる。値そのものは比べない（工事は毎年違う）。
 */

/** 比べる側。sheet は計画の元のシート、headerRow はその見出しの行（0 から） */
export type FormatSide = { sheets: readonly SheetGrid[]; sheet: string; headerRow: number }

export type FormatColumn = { column: number; header: string }

export type FormatDiff = {
  /** 比べたシート（去年 → 今年）と見出しの行（0 から） */
  compared: { previous: { sheet: string; headerRow: number }; current: { sheet: string; headerRow: number } }
  sheets: { added: string[]; removed: string[] }
  columns: {
    added: FormatColumn[]
    removed: FormatColumn[]
    /**
     * by: name＝見出しの名前が近い、values＝名前は違うが値の文字の傾向（2文字の組の出方）がほかの列よりはっきり近い（推定）、
     * position＝名前は違うが、対応の決まった列にはさまれた同じ位置にあり値の種類が同じ（推定）
     */
    renamed: { from: FormatColumn; to: FormatColumn; by: RenameBy }[]
    /** 並びが変わった列（ほかの列との前後が去年と違う。列が足された・消えただけでずれた列と、同じ位置のままの列は入れない） */
    moved: { header: string; from: number; to: number }[]
  }
  same: boolean
}

/** 列の値の種類を見る行数（見出しの下から） */
const SAMPLE_ROWS = 200

type Kind = "number" | "date" | "text" | "empty"
type RenameBy = "name" | "values" | "position"

type Col = FormatColumn & { key: string; kind: Kind; profile: Map<string, number> }

const normalize = (s: string) => removeSpaces(nfkc(s)).toLowerCase()

const NUMBER_RE = /^[-+]?[¥￥]?[\d,]+(\.\d+)?円?$/
/**
 * 日付: 2025/4/1・2025-04・2025年4月1日・2025.4.1（「.」は年月日の3つがそろうときだけ。1234.5 は千円の小数）・R7.4.1・令和7年4月
 */
const DATE_RE = /^(\d{4}([/\-]\d{1,2}([/\-]\d{1,2})?|年\d{1,2}月(\d{1,2}日)?|\.\d{1,2}\.\d{1,2})|([RHS]|令和|平成|昭和)\.?\d{1,2}([./年]\d{1,2}))(\D.*)?$/

function kindOf(values: readonly string[]): Kind {
  const filled = values.map((v) => nfkc(v).trim()).filter(Boolean)
  if (!filled.length) return "empty"
  const share = (re: RegExp) => filled.filter((v) => re.test(v)).length / filled.length
  if (share(DATE_RE) >= 0.8) return "date"
  if (share(NUMBER_RE) >= 0.8) return "number"
  return "text"
}

/** 見出しがあるか、見出しの下に値がある列 */
function columnsOf(grid: SheetGrid, headerRow: number): Col[] {
  const header = grid.rows[headerRow] ?? []
  const body = grid.rows.slice(headerRow + 1, headerRow + 1 + SAMPLE_ROWS)
  const width = Math.max(header.length, ...body.map((r) => r.length))
  const cols: Col[] = []
  for (let column = 0; column < width; column++) {
    const h = (header[column] ?? "").trim()
    const values = body.map((r) => r[column] ?? "")
    const kind = kindOf(values)
    if (!h && kind === "empty") continue
    cols.push({ column, header: h, key: normalize(h), kind, profile: profileOf(values) })
  }
  return cols
}

/** 文字の2つ組の重なり（見出しの名前の近さ） */
export function similarity(a: string, b: string) {
  const grams = (s: string) => {
    const cs = [...s]
    return cs.length < 2 ? new Set([s]) : new Set(cs.slice(0, -1).map((c, i) => c + cs[i + 1]))
  }
  const A = grams(a)
  const B = grams(b)
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return (2 * n) / (A.size + B.size)
}

const RENAME_SIMILARITY = 0.5

/**
 * 値の文字の傾向: 2文字の組の出方（数字はどれも 0 にする。年が変わると値そのものは変わるが、注文者の「株式会社」、工事名の「工事」、
 * 日付の「0000-00-00」のような形は変わりにくい）
 */
function profileOf(values: readonly string[]) {
  const counts = new Map<string, number>()
  for (const v of values) {
    const cs = [...removeSpaces(nfkc(v)).replace(/\d/g, "0")]
    for (let i = 0; i + 1 < cs.length; i++) {
      const g = cs[i]! + cs[i + 1]!
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
  }
  return counts
}

function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) {
  let dot = 0
  for (const [k, v] of a) dot += v * (b.get(k) ?? 0)
  const norm = (m: ReadonlyMap<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0))
  const n = norm(a) * norm(b)
  return n ? dot / n : 0
}

/** 値の傾向で同じ列とみなす近さと、2番目に近い列との差（どちらとも取れるときは位置に任せる） */
const VALUES_SIMILARITY = 0.6
const VALUES_MARGIN = 0.15

const compatible = (a: Kind, b: Kind) => a === b || a === "empty" || b === "empty"

/** 最長増加部分列（old の順に並べた組のうち、new の順も保っている最大の組）。入っていない組が「並びが変わった」列 */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = []
  const prev = new Array<number>(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]!
    tails[lo] = i
  }
  const keep = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) keep.add(i)
  return keep
}

/**
 * 列の対応: ① 見出しの名前が同じ ② 名前が近い（2文字の組の重なりが半分以上で、値の種類が合う） ③ 対応の決まった列にはさまれた同じ位置に、
 * 去年と今年で同じ数だけ残った列（値の種類が合えば、名前が変わった列とみなす）。残りは足された列・無くなった列
 */
function matchColumns(prev: readonly Col[], cur: readonly Col[]) {
  const pairs = new Map<number, number>() // prev の添字 → cur の添字
  const taken = new Set<number>()
  const by = new Map<number, RenameBy>()
  const pair = (i: number, j: number) => {
    pairs.set(i, j)
    taken.add(j)
  }
  prev.forEach((p, i) => {
    if (!p.key) return
    const j = cur.findIndex((c, k) => !taken.has(k) && c.key === p.key)
    if (j >= 0) pair(i, j)
  })
  const candidates: { i: number; j: number; score: number }[] = []
  prev.forEach((p, i) => {
    if (pairs.has(i) || !p.key) return
    cur.forEach((c, j) => {
      if (taken.has(j) || !c.key || !compatible(p.kind, c.kind)) return
      const score = similarity(p.key, c.key)
      if (score >= RENAME_SIMILARITY) candidates.push({ i, j, score })
    })
  })
  candidates.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j)
  for (const c of candidates) if (!pairs.has(c.i) && !taken.has(c.j)) pair(c.i, c.j)

  // ② の2 値の傾向: 残った去年の列ごとに、残った今年の列のうち値の種類が合い、いちばん近いものがはっきり近ければ（2番目との差が大きければ）対応させる
  const valueCandidates: { i: number; j: number; score: number }[] = []
  prev.forEach((p, i) => {
    if (pairs.has(i) || p.kind === "empty") return
    const scores = cur.flatMap((c, j) => (taken.has(j) || c.kind !== p.kind ? [] : [{ i, j, score: cosine(p.profile, c.profile) }])).sort((a, b) => b.score - a.score)
    const [best, second] = scores
    if (best && best.score >= VALUES_SIMILARITY && best.score - (second?.score ?? 0) >= VALUES_MARGIN) valueCandidates.push(best)
  })
  valueCandidates.sort((a, b) => b.score - a.score || a.i - b.i)
  for (const c of valueCandidates)
    if (!pairs.has(c.i) && !taken.has(c.j)) {
      pair(c.i, c.j)
      by.set(c.i, "values")
    }

  // ③ 並びを保った対応（最長増加部分列）を目印にして、その間に残った列を位置で合わせる
  const anchors = () => {
    const sorted = [...pairs].sort((a, b) => a[0] - b[0])
    const keep = longestIncreasing(sorted.map(([, j]) => j))
    return [[-1, -1] as [number, number], ...sorted.filter((_, k) => keep.has(k)), [prev.length, cur.length] as [number, number]]
  }
  const marks = anchors()
  for (let k = 0; k + 1 < marks.length; k++) {
    const [i0, j0] = marks[k]!
    const [i1, j1] = marks[k + 1]!
    const olds = range(i0 + 1, i1).filter((i) => !pairs.has(i))
    const news = range(j0 + 1, j1).filter((j) => !taken.has(j))
    if (!olds.length || olds.length !== news.length) continue
    if (!olds.every((i, n) => compatible(prev[i]!.kind, cur[news[n]!]!.kind))) continue
    olds.forEach((i, n) => {
      pair(i, news[n]!)
      by.set(i, "position")
    })
  }
  return { pairs, by }
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k)

const toColumn = (c: Col): FormatColumn => ({ column: c.column, header: c.header })

export function compareFormats(previous: FormatSide, current: FormatSide): FormatDiff {
  const prevNames = new Set(previous.sheets.map((s) => s.name))
  const curNames = new Set(current.sheets.map((s) => s.name))
  const sheets = { added: [...curNames].filter((n) => !prevNames.has(n)), removed: [...prevNames].filter((n) => !curNames.has(n)) }
  const grid = (side: FormatSide) => side.sheets.find((s) => s.name === side.sheet) ?? { name: side.sheet, rows: [], hidden: [] }
  const prev = columnsOf(grid(previous), previous.headerRow)
  const cur = columnsOf(grid(current), current.headerRow)
  const { pairs, by } = matchColumns(prev, cur)
  const matchedCur = new Set(pairs.values())
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  const keep = longestIncreasing(sorted.map(([, j]) => j))
  const columns = {
    added: cur.filter((_, j) => !matchedCur.has(j)).map(toColumn),
    removed: prev.filter((_, i) => !pairs.has(i)).map(toColumn),
    renamed: sorted.filter(([i, j]) => prev[i]!.key !== cur[j]!.key).map(([i, j]) => ({ from: toColumn(prev[i]!), to: toColumn(cur[j]!), by: by.get(i) ?? ("name" as const) })),
    moved: sorted.filter(([i, j], k) => !keep.has(k) && prev[i]!.column !== cur[j]!.column).map(([i, j]) => ({ header: cur[j]!.header || prev[i]!.header, from: prev[i]!.column, to: cur[j]!.column })),
  }
  const same = !sheets.added.length && !sheets.removed.length && !columns.added.length && !columns.removed.length && !columns.renamed.length && !columns.moved.length
  return {
    compared: { previous: { sheet: previous.sheet, headerRow: previous.headerRow }, current: { sheet: current.sheet, headerRow: current.headerRow } },
    sheets,
    columns,
    same,
  }
}

const RENAME_NOTES: Record<RenameBy, string> = { name: "", values: "（値の傾向が近いので同じ列とみなした）", position: "（同じ位置にあるので同じ列とみなした）" }

const label = (c: FormatColumn) => `${columnLetter(c.column)}列「${c.header || "（見出しなし）"}」`

/** 1行に並べる数の上限（列の多い表でも、チャットに送る文脈が大きくなりすぎないように） */
const MAX_LISTED = 30

const listed = <T,>(xs: readonly T[], show: (x: T) => string) =>
  xs.slice(0, MAX_LISTED).map(show).join("、") + (xs.length > MAX_LISTED ? `ほか ${xs.length - MAX_LISTED} 件` : "")

/** 違いを短い日本語の行にする（画面と AI への文脈で同じ文） */
export function describeFormatDiff(d: FormatDiff): string[] {
  const { previous: p, current: c } = d.compared
  const lines = [`比べたシート: 去年「${p.sheet}」（見出し ${p.headerRow + 1}行目）→ 今年「${c.sheet}」（見出し ${c.headerRow + 1}行目）`]
  if (d.same) return [...lines, "シートの構成と見出し・列の並びは去年と同じです。"]
  if (d.sheets.added.length) lines.push(`増えたシート: ${listed(d.sheets.added, (s) => `「${s}」`)}`)
  if (d.sheets.removed.length) lines.push(`無くなったシート: ${listed(d.sheets.removed, (s) => `「${s}」`)}`)
  if (d.columns.renamed.length)
    lines.push(`名前が変わった列: ${listed(d.columns.renamed, (r) => `去年 ${label(r.from)} → 今年 ${label(r.to)}${RENAME_NOTES[r.by]}`)}`)
  if (d.columns.moved.length) lines.push(`並びが変わった列: ${listed(d.columns.moved, (m) => `「${m.header || "（見出しなし）"}」去年 ${columnLetter(m.from)}列 → 今年 ${columnLetter(m.to)}列`)}`)
  if (d.columns.added.length) lines.push(`足された列: ${listed(d.columns.added, label)}`)
  if (d.columns.removed.length) lines.push(`無くなった列: ${listed(d.columns.removed, (x) => `去年の ${label(x)}`)}`)
  return lines
}

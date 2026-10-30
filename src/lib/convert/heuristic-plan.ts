import type { CsvSpec } from "../spec/types"
import { columnCount, planColumns, type FieldPlan, type FlagColumn, type MappingPlan, type SheetGrid } from "./plan"
import { defaultSheetSelection, isSkippableRow, lastNonBlankRow, rowIsBlank } from "./sources"
import { matchKey } from "./text"
import { isFlagOn, type TransformId } from "./transforms"

/**
 * 見出しから列を推定する手がかり。項目ごとに先に書いたものほど優先。
 * - match: 見出しの語（先に書いた語ほど強い）。shared の列は他の項目と共有できる（住所 → 都道府県と場所名）。
 *   all はあてはまる列をすべて使う（現場名１＋現場名２）。when は列の値で使うかを決める。
 *   pairWith は2列目（見出しの語で探し、無ければ別の項目の列）。
 * - flags: 見出しがコード名で値が記号だけの列（電気工事列・管工事列 → 業種）。
 * - derive: 他の項目の列から AI で推定する（工事名＋注文者 → 都道府県）。
 */
export type ColumnHint<F extends string> =
  | {
      match: readonly string[]
      transform: TransformId
      shared?: boolean
      all?: boolean
      when?: (values: string[]) => boolean
      pairWith?: { headers?: readonly string[]; field?: F }
    }
  | { flags: (header: string) => string | undefined }
  | { derive: readonly F[]; transform: TransformId }

export type PlanHints<F extends string> = {
  columns: Record<F, readonly ColumnHint<F>[]>
  /** 見出しの照合順（短い語が別の項目の見出しに含まれるものを後に） */
  order: readonly F[]
  /** この語を見出しに含む列に値があれば、その行は出力しない */
  excludeHeaders: readonly string[]
}

/** 見出しが語にあてはまる強さ（あてはまらなければ 0）。先の語ほど強く、同じ語なら完全一致が強い */
function hintScore(header: string, words: readonly string[]) {
  const h = matchKey(header)
  if (!h) return 0
  for (const [i, w] of words.entries()) {
    const k = matchKey(w)
    if (h === k) return (words.length - i) * 2 + 1
    if (h.includes(k)) return (words.length - i) * 2
  }
  return 0
}

type Matched<F extends string> = { columns: number[]; transform: TransformId; pairField?: F } | { flags: FlagColumn[] }

/** 先頭30行のうち、項目の見出しの語にあてはまる項目がいちばん多い行と、その項目の数 */
export function headerMatch<F extends string>(spec: CsvSpec<F>, hints: PlanHints<F>, grid: SheetGrid) {
  let headerRow = 0
  let fields = 0
  for (let r = 0; r < Math.min(grid.rows.length, 30); r++) {
    const row = grid.rows[r] ?? []
    const score = spec.fields.filter((f) => hints.columns[f.id].some((h) => "match" in h && row.some((c) => hintScore(c, h.match) > 0))).length
    if (score > fields) [fields, headerRow] = [score, r]
  }
  return { headerRow, fields }
}

/**
 * 変換の元にするシート。見出しが項目にあてはまる数が多いシートを選び、同じなら空でない行の多いシート。
 * 行の数だけで選ぶと、顧客一覧のような工事でない大きなシートを選んでしまう。空のシートしか無ければ undefined
 */
export function primarySheet<F extends string>(spec: CsvSpec<F>, hints: PlanHints<F>, sheets: readonly SheetGrid[]): SheetGrid | undefined {
  let best: { sheet: SheetGrid; fields: number; rows: number } | undefined
  for (const sheet of sheets) {
    const rows = sheet.rows.filter((r) => !rowIsBlank(r)).length
    if (rows === 0) continue
    const { fields } = headerMatch(spec, hints, sheet)
    if (!best || fields > best.fields || (fields === best.fields && rows > best.rows)) best = { sheet, fields, rows }
  }
  return best?.sheet
}

/** 見出しの語だけで列の対応を推定する（APIキーが無いとき、AI の計画の初期値） */
export function heuristicPlan<F extends string>(
  spec: CsvSpec<F>,
  hints: PlanHints<F>,
  grid: SheetGrid,
  workbook: readonly SheetGrid[] = [grid],
): MappingPlan<F> {
  const nCols = columnCount(grid)
  const { headerRow } = headerMatch(spec, hints, grid)
  const headers = Array.from({ length: nCols }, (_, c) => grid.rows[headerRow]?.[c] ?? "")
  const body = grid.rows.slice(headerRow + 1).filter((r) => !isSkippableRow(r, headers.map((_, c) => c)))
  const values = headers.map((_, c) => body.map((r) => r[c]?.trim() ?? "").filter(Boolean))

  const claims = new Map<number, { shared: boolean }>()
  const matched = new Map<F, Matched<F>>()
  const free = (c: number, shared = false) => {
    const claim = claims.get(c)
    return !claim || (claim.shared && shared)
  }

  for (const id of hints.order) {
    for (const hint of hints.columns[id]) {
      if (!("flags" in hint)) continue
      const flags = headers.flatMap((h, column) => {
        const code = free(column) && values[column]!.every(isFlagOn) ? hint.flags(h) : undefined
        return code ? [{ column, code }] : []
      })
      if (!flags.some((f) => values[f.column]!.length > 0)) continue
      for (const f of flags) claims.set(f.column, { shared: false })
      matched.set(id, { flags })
      break
    }
  }

  for (const id of hints.order) {
    if (matched.has(id)) continue
    for (const hint of hints.columns[id]) {
      if (!("match" in hint)) continue
      const scored = headers
        .map((h, column) => ({ column, score: free(column, hint.shared) && values[column]!.length > 0 ? hintScore(h, hint.match) : 0 }))
        .filter((x) => x.score > 0 && (!hint.when || hint.when(values[x.column]!)))
      if (!scored.length) continue
      const top = scored.reduce((a, b) => (b.score > a.score ? b : a))
      const columns = hint.all ? scored.map((x) => x.column) : [top.column]
      for (const c of columns) claims.set(c, { shared: !!hint.shared })

      const pairHeaders = hint.pairWith?.headers
      const pairColumn = pairHeaders
        ? headers.findIndex((h, c) => !columns.includes(c) && values[c]!.length > 0 && hintScore(h, pairHeaders) > 0)
        : -1
      if (pairColumn >= 0) {
        claims.set(pairColumn, { shared: false })
        columns.push(pairColumn)
      }
      let transform = hint.transform
      if (transform === "rule.yenToThousand" && /千円/.test(headers[top.column]!)) transform = "rule.thousandYen"
      matched.set(id, { columns, transform, pairField: pairColumn < 0 ? hint.pairWith?.field : undefined })
      break
    }
  }

  const columnsOf = (id: F) => {
    const m = matched.get(id)
    return m && "columns" in m ? m.columns : []
  }
  for (const id of hints.order) {
    if (matched.has(id)) continue
    const hint = hints.columns[id].find((h) => "derive" in h && h.derive.every((d) => columnsOf(d).length))
    if (hint && "derive" in hint) matched.set(id, { columns: hint.derive.flatMap(columnsOf), transform: hint.transform })
  }

  const fields = {} as Record<F, FieldPlan>
  for (const f of spec.fields) {
    const m = matched.get(f.id)
    if (m && "flags" in m) {
      fields[f.id] = { kind: "flagColumns", columns: m.flags }
      continue
    }
    const columns = m ? [...m.columns, ...(m.pairField ? columnsOf(m.pairField).slice(0, 1) : [])] : []
    if (m && columns.length > 1) fields[f.id] = { kind: "columns", columns, transform: m.transform }
    else if (m && columns.length === 1) fields[f.id] = { kind: "column", column: columns[0]!, transform: m.transform }
    else if (f.whenMissing) fields[f.id] = { kind: "constant", value: f.whenMissing.value, reason: f.whenMissing.reason }
    else fields[f.id] = { kind: "missing" }
  }

  const amountIsThousand = spec.fields.some((f) => {
    const p = fields[f.id]
    return p.kind === "column" && p.transform === "rule.thousandYen"
  })
  if (amountIsThousand) {
    for (const f of spec.fields) {
      const p: FieldPlan = fields[f.id]
      if (p.kind === "column" && p.transform === "rule.yenToThousand" && !/円/.test(headers[p.column]!)) fields[f.id] = { ...p, transform: "rule.thousandYen" }
    }
  }

  const end = Math.max(headerRow, lastNonBlankRow(grid))
  const start = Math.min(headerRow + 1, end)
  const used = [...new Set(spec.fields.flatMap((f) => planColumns(fields[f.id])))]
  const skipRows: number[] = []
  for (let r = start; r <= end; r++) if (isSkippableRow(grid.rows[r], used)) skipRows.push(r)

  const excludeColumns = headers.flatMap((h, c) => (!used.includes(c) && hintScore(h, hints.excludeHeaders) > 0 ? [c] : []))

  return {
    sheets: defaultSheetSelection(workbook, grid, headerRow),
    headerRow,
    dataRows: { start, end },
    skipRows,
    rowFilter: { excludeHidden: false, excludeColumns },
    amountUnit: amountIsThousand ? "thousandYen" : "yen",
    fields,
    unusedColumns: headers.flatMap((header, column) =>
      header.trim() && !used.includes(column) && !excludeColumns.includes(column) ? [{ column, header, reason: "対応する項目がありません" }] : [],
    ),
    notes: [],
  }
}

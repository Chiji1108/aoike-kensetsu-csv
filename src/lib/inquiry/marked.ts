import { z } from "zod"
import type { RowResult } from "../convert/convert"
import type { FieldPlan, MappingPlan, SheetGrid } from "../convert/plan"
import { getTransform } from "../convert/transforms"
import { hmac, keyMark } from "../excel/final-sheet"
import { fieldIdSchema } from "../schemas"
import type { KojiFieldId } from "../spec/koji-keireki"
import {
  answerHints,
  askLabel,
  columnOf,
  inquirySheet,
  outsideCells,
  readAiAnswers,
  readAnswers,
  REVIEW_NOTE_PREFIX,
  SHEET_COLUMNS,
  reviewNoteOf,
  type AiAnswer,
  type AiAnswerReport,
  type AnswerAi,
  type CellInquiry,
  type InquiryReason,
  type InquirySheet,
  type SheetColumn,
} from "./inquiry"

/**
 * 印付きの Excel: 顧客から受け取った変換の元の Excel に、問い合わせのセルの色と推定の確かめのメモを付けて返すもの
 * （顧客は見慣れた自分の表で答えられる）。書くのは marked-xlsx.ts、ここは何をどこに付けるかと、返ってきたときの読み方。
 * - 問い合わせのセルは、列の対応（計画）がその項目に使う元の列のセルに付ける。元の表に列が無い項目は、表の右端に
 *   「注文者（ご記入ください）」のような列を足して、その行のその列に付ける
 * - 元のファイルに行の無い工事（足した行）の問い合わせは、同じファイルの「追加の確認」のシート（記入用Excelと同じ形）にまとめる
 *   （顧客に渡すファイルを1つにする。読み方も記入用Excelと同じ）
 * - 照合用の隠しシート（veryHidden）に、何をどこに聞いたかを持つ。値は書かず、案件ごとの鍵（excel-key.ts）の HMAC だけを書く。
 *   全体の HMAC も持つので、書き換えた・別の案件のファイルは読まない
 * - 返ってきたら、印を付けたセルの記入を、同じ列の対応のまま顧客の回答として読み（record_answers と同じ readAiAnswers）、
 *   印の無いセルを顧客が直していれば数だけを返す（勝手に入れない。チャットの「AI で読む」で読める）
 */

type KojiRow = RowResult<KojiFieldId>
type Plan = MappingPlan<KojiFieldId>

export const MARKED_SHEET_NAME = "照合用（印付き）"
export const MARKED_MARK = "aoike-marked-source"
export const MARKED_VERSION = 1
/** 元のファイルに行の無い工事の問い合わせのシート */
export const ADDED_SHEET_NAME = "追加の確認"
/** 足した列の見出し（「注文者（ご記入ください）」） */
export const addedHeader = (column: SheetColumn) => `${askLabel(column.fields[0]!)}（ご記入ください）`

const metaSchema = z.object({
  caseId: z.string().min(1).max(64),
  sourceFileId: z.string().min(1).max(64),
  exportedAt: z.string().max(40),
  keyMark: z.string().regex(/^[0-9a-f]{16}$/),
})
const hashSchema = z.string().regex(/^[0-9a-f]{24}$/)
const indexSchema = z.coerce.number().int().min(0).max(1_048_575)
const colsSchema = z.array(z.number().int().min(0).max(16_383)).min(1).max(20)

export type MarkedMeta = z.infer<typeof metaSchema>
/** 足した列。column は記入用Excelの欄の見出し（どの項目の列か）、headerRow は見出しを書いた行（無ければ -1） */
export type MarkedColumn = { sheet: string; col: number; headerRow: number; column: string }
/** 印を付けた行の照合（印を付けた列を除いた行の中身の HMAC。顧客が行を足した・消したときに行を探す） */
export type MarkedRow = { sheet: string; row: number; width: number; skip: number[]; hash: string }
/** 聞いたセル。cols は印を付けた列（added なら足した列）。current は聞いたときのセルの値、sent は印を付けたセルに書いてあった文字の HMAC */
export type MarkedCell = { rowKey: string; field: KojiFieldId; reason: InquiryReason; sheet: string; row: number; cols: number[]; added: boolean; current: string; sent: string }
export type MarkedCheck = { meta: MarkedMeta; columns: MarkedColumn[]; rows: MarkedRow[]; cells: MarkedCell[] }

/** 印を付けるセル。note は推定の確かめのメモ、value は足した列に書く値 */
export type MarkCell = { sheet: string; row: number; col: number; note?: string; value?: string }
export type MarkPlan = {
  cells: MarkCell[]
  /** 足す列（header は見出しの文） */
  columns: (MarkedColumn & { header: string })[]
  /** 元のファイルに行の無い工事の問い合わせ（無ければ null） */
  added: InquirySheet | null
  check: MarkedCheck
  /** 色を付けたセルの数（追加の確認のシートも） */
  askCount: number
  hints: string[]
}

export type MarkId = { caseId: string; sourceFileId: string; excelKey: string }

const hashOf = (key: string, caseId: string, text: string) => hmac(key, `marked\n${caseId}\n${text}`, 12)
/** 行の照合の文字（印を付けた列を空にし、元の幅で切る。右端の空のセルは除く） */
function rowText(cells: readonly string[] | undefined, width: number, skip: readonly number[]) {
  const values = Array.from({ length: width }, (_, i) => (skip.includes(i) ? "" : (cells?.[i] ?? "").trim()))
  while (values.length && !values[values.length - 1]) values.pop()
  return JSON.stringify(values)
}
/** 値のある最後の列の次（書式だけの右の列は数えない。足す列はここから） */
const widthOf = (grid: SheetGrid) =>
  grid.rows.reduce((w, r) => {
    let last = r.length
    while (last > 0 && !r[last - 1]!.trim()) last--
    return Math.max(w, last)
  }, 0)
const textAt = (grid: SheetGrid | undefined, row: number, cols: readonly number[]) =>
  cols
    .map((c) => (grid?.rows[row]?.[c] ?? "").trim())
    .filter(Boolean)
    .join(" ")
const storedOf = (r: KojiRow, f: KojiFieldId) => r.cells[f].stored ?? r.cells[f].value

/**
 * 計画がその項目に使う元の列（無ければ null。列を足す）。ほかの項目の列から推し量る変換（工事名から工事場所を推定するなど）は、
 * その列に答えを書いてもらうものではないので列を足す
 */
function planColumns(p: FieldPlan | undefined): number[] | null {
  if ((p?.kind === "column" || p?.kind === "columns") && INFERS.has(p.transform)) return null
  if (p?.kind === "column") return [p.column]
  if (p?.kind === "columns" && p.columns.length) return p.columns
  return null
}
const INFERS: ReadonlySet<string> = new Set(["ai.inferPrefecture", "ai.inferPlace"])

/** 元のファイルの行か（足した行・計画のシートに無い行は、追加の確認のシートに回す） */
const inSource = (r: KojiRow, sheets: readonly SheetGrid[], plan: Plan) => !r.key.startsWith("add-") && plan.sheets.includes(r.sheet) && sheets.some((s) => s.name === r.sheet)

/** 印を付ける場所（planMarks の照合用の HMAC の前まで。画面がどちらの Excel にするか・何件かを出すのにも使う） */
export type MarkPlacement = Omit<MarkPlan, "check"> & {
  placed: { q: CellInquiry; r: KojiRow; cols: number[]; added: boolean }[]
}

/**
 * 何をどこに付けるかを決める。rows は CSV に載せる行、inquiries は聞くセル（外したものは除く）。
 * 元のファイルの行に1つも聞くことが無ければ null（印付きにする意味が無いので記入用Excelにする）
 */
export function placeMarks(sheets: readonly SheetGrid[], plan: Plan, rows: readonly KojiRow[], inquiries: readonly CellInquiry[]): MarkPlacement | null {
  const rowOf = new Map(rows.map((r) => [r.key, r]))
  const gridOf = new Map(sheets.map((s) => [s.name, s]))
  const asked = inquiries.filter((q) => rowOf.has(q.rowKey))
  const inFile = asked.filter((q) => inSource(rowOf.get(q.rowKey)!, sheets, plan))
  if (!inFile.length) return null
  const extra = asked.filter((q) => !inFile.includes(q))

  // 足す列（シートごとに、記入用Excelの欄の順で右端に足す）
  const columns: MarkPlan["columns"] = []
  const addedCol = (sheet: string, column: SheetColumn) => {
    const found = columns.find((c) => c.sheet === sheet && c.column === column.header)
    if (found) return found.col
    const grid = gridOf.get(sheet)!
    const col = widthOf(grid) + columns.filter((c) => c.sheet === sheet).length
    columns.push({ sheet, col, headerRow: plan.headerRow >= 0 && plan.headerRow < grid.rows.length ? plan.headerRow : -1, column: column.header, header: addedHeader(column) })
    return col
  }
  const placed = [...inFile]
    .sort((a, b) => SHEET_ORDER(a) - SHEET_ORDER(b))
    .map((q) => {
      const r = rowOf.get(q.rowKey)!
      const fromPlan = planColumns(plan.fields[q.field])
      const cols = fromPlan ?? [addedCol(r.sheet, columnOf(q.field)!)]
      return { q, r, cols, added: !fromPlan }
    })

  const cells = new Map<string, MarkCell>()
  for (const { q, r, cols, added } of placed) {
    const column = columnOf(q.field)!
    cols.forEach((col, i) => {
      const at = `${r.sheet}\t${r.row}\t${col}`
      const cell = cells.get(at) ?? { sheet: r.sheet, row: r.row, col }
      // 推定の確かめは最初の列にだけ。足した列には推定の値を書いておく（そのままなら確認）
      const note = q.reason === "needsReview" && i === 0 ? reviewNoteOf(column, r) : undefined
      if (note && !cell.note?.includes(note)) cell.note = cell.note ? `${cell.note}\n${note}` : note
      if (added && q.reason === "needsReview") cell.value = column.show(r)
      cells.set(at, cell)
    })
  }
  const added = extra.length ? inquirySheet(rows, extra) : null
  const review = placed.some((p) => p.q.reason === "needsReview")
  return {
    cells: [...cells.values()],
    columns,
    added,
    placed,
    askCount: cells.size + (added?.askCount ?? 0),
    hints: [...new Set([...answerHints([...new Set(placed.map((p) => columnOf(p.q.field)!))], review), ...(added?.hints ?? [])])],
  }
}

/** 印を付ける場所に、照合用の隠しシートの中身（HMAC）を足す */
export async function planMarks(sheets: readonly SheetGrid[], placement: MarkPlacement, id: MarkId, now = new Date()): Promise<MarkPlan> {
  const gridOf = new Map(sheets.map((s) => [s.name, s]))
  const { placed, ...rest } = placement
  const byRow = new Map<string, { sheet: string; row: number; skip: Set<number> }>()
  for (const { r, cols, added } of placed) {
    const at = `${r.sheet}\t${r.row}`
    const entry = byRow.get(at) ?? { sheet: r.sheet, row: r.row, skip: new Set<number>() }
    if (!added) for (const c of cols) entry.skip.add(c)
    byRow.set(at, entry)
  }
  const markedRows = await Promise.all(
    [...byRow.values()].map(async ({ sheet, row, skip }) => {
      const grid = gridOf.get(sheet)!
      const width = widthOf(grid)
      const s = [...skip].sort((a, b) => a - b)
      return { sheet, row, width, skip: s, hash: await hashOf(id.excelKey, id.caseId, rowText(grid.rows[row], width, s)) }
    }),
  )
  const valueAt = new Map(rest.cells.map((c) => [`${c.sheet}\t${c.row}\t${c.col}`, c.value ?? ""]))
  const markedCells = await Promise.all(
    placed.map(async ({ q, r, cols, added }): Promise<MarkedCell> => {
      const sent = added ? (valueAt.get(`${r.sheet}\t${r.row}\t${cols[0]}`) ?? "") : textAt(gridOf.get(r.sheet), r.row, cols)
      return {
        rowKey: q.rowKey,
        field: q.field,
        reason: q.reason,
        sheet: r.sheet,
        row: r.row,
        cols,
        added,
        current: await hashOf(id.excelKey, id.caseId, storedOf(r, q.field)),
        sent: await hashOf(id.excelKey, id.caseId, sent.trim()),
      }
    }),
  )
  return {
    ...rest,
    check: {
      meta: { caseId: id.caseId, sourceFileId: id.sourceFileId, exportedAt: now.toISOString(), keyMark: await keyMark(id.excelKey, id.caseId) },
      columns: rest.columns.map(({ header: _, ...c }) => c),
      rows: markedRows,
      cells: markedCells,
    },
  }
}

/** 足す列の並び（記入用Excelの欄の順） */
const SHEET_ORDER = (q: CellInquiry) => SHEET_COLUMNS.indexOf(columnOf(q.field)!)

// ---- 照合用の隠しシート ----

/** 隠しシートのセル（1行目は印、そのあと識別・足した列・行・セル、最後に全体の HMAC）。全セル文字列 */
export async function markedSheetRows(check: MarkedCheck, excelKey: string): Promise<string[][]> {
  const body: string[][] = [
    [MARKED_MARK, String(MARKED_VERSION)],
    ["meta", JSON.stringify(check.meta)],
    ...check.columns.map((c) => ["column", c.sheet, String(c.col), String(c.headerRow), c.column]),
    ...check.rows.map((r) => ["row", r.sheet, String(r.row), String(r.width), JSON.stringify(r.skip), r.hash]),
    ...check.cells.map((c) => ["cell", c.rowKey, c.field, c.reason, c.sheet, String(c.row), JSON.stringify(c.cols), c.added ? "1" : "0", c.current, c.sent]),
  ]
  return [...body, ["sig", await signatureOf(body, excelKey, check.meta.caseId)]]
}

const signatureOf = (rows: readonly (readonly string[])[], key: string, caseId: string) => hmac(key, `marked-sig\n${caseId}\n${JSON.stringify(rows)}`, 16)

const BROKEN = "照合用のシートが書き換えられていて読めません。印付きの Excel を作り直して送ってください"

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type ParsedCheck = { check: MarkedCheck; body: string[][]; sig: string }

/** 返ってきたファイルの照合用の隠しシートを読む。印付きの Excel でなければ null、壊れていれば error（全体の HMAC は readMarked が確かめる） */
export function markedCheckOf(sheets: readonly SheetGrid[]): ParsedCheck | { error: string } | null {
  const sheet = sheets.find((s) => s.name === MARKED_SHEET_NAME)
  if (!sheet || (sheet.rows[0]?.[0] ?? "").trim() !== MARKED_MARK) return null
  const version = Number((sheet.rows[0]?.[1] ?? "").trim())
  if (version !== MARKED_VERSION) return { error: version > MARKED_VERSION ? "この画面より新しい形の Excel です。画面を読み込み直してからアップロードしてください" : BROKEN }
  const rows = sheet.rows.filter((r) => r.some((c) => c.trim()))
  const sigRow = rows[rows.length - 1]
  if (sigRow?.[0] !== "sig" || !sigRow[1]) return { error: BROKEN }
  // 空のセルは SheetJS が読まない（右端の空は無い）ので、書いたときの形に戻してから HMAC を比べる
  const body = rows.slice(0, -1).map((r) => {
    const out = [...r]
    while (out.length && out[out.length - 1] === "") out.pop()
    return out
  })
  let meta: MarkedMeta | undefined
  const columns: MarkedColumn[] = []
  const markedRows: MarkedRow[] = []
  const cells: MarkedCell[] = []
  for (const r of body.slice(1)) {
    const [kind, ...v] = r
    if (kind === "meta") {
      const p = metaSchema.safeParse(json(v[0] ?? ""))
      if (!p.success) return { error: BROKEN }
      meta = p.data
    } else if (kind === "column") {
      const p = z.object({ sheet: z.string().min(1), col: indexSchema, headerRow: z.coerce.number().int().min(-1), column: z.string().min(1) }).safeParse({ sheet: v[0], col: v[1], headerRow: v[2], column: v[3] })
      if (!p.success) return { error: BROKEN }
      columns.push(p.data)
    } else if (kind === "row") {
      const p = z.object({ sheet: z.string().min(1), row: indexSchema, width: indexSchema, skip: z.array(z.number().int().min(0)), hash: hashSchema }).safeParse({ sheet: v[0], row: v[1], width: v[2], skip: json(v[3] ?? ""), hash: v[4] })
      if (!p.success) return { error: BROKEN }
      markedRows.push(p.data)
    } else if (kind === "cell") {
      const p = z
        .object({ rowKey: z.string().min(1).max(200), field: fieldIdSchema, reason: z.enum(["missing", "needsReview"]), sheet: z.string().min(1), row: indexSchema, cols: colsSchema, added: z.enum(["0", "1"]), current: hashSchema, sent: hashSchema })
        .safeParse({ rowKey: v[0], field: v[1], reason: v[2], sheet: v[3], row: v[4], cols: json(v[5] ?? ""), added: v[6], current: v[7], sent: v[8] })
      if (!p.success || !columnOf(p.data.field as KojiFieldId)) return { error: BROKEN }
      cells.push({ ...p.data, field: p.data.field as KojiFieldId, added: p.data.added === "1" })
    } else return { error: BROKEN }
  }
  if (!meta) return { error: BROKEN }
  return { check: { meta, columns, rows: markedRows, cells }, body, sig: sigRow[1] }
}

/** 返ってきた印付きの Excel の読み方の結果。outside は印の無いセルで顧客が書き換えた・書き足したセルの数（入れない。AI で読める） */
export type MarkedRead = { report: AiAnswerReport; outside: number }

/**
 * 返ってきた印付きの Excel を顧客の回答にする（record_answers と同じ readAiAnswers の決まりで値にする）。
 * rows は今の全行、source は今の変換の元のシート（印の無いセルの書き換えを数える）、id は今の案件と変換の元。
 * - 印を付けたセルが書いたときのまま: データに無い欄は未記入、推定は確認（推定の印を外す）
 * - 書き換えられた: 同じ列の対応のまま読む（年月・工事場所は計画の決まった変換で値にし、注文者・工事名・配置技術者は書いたまま渡して匿名化などを通す）
 * - 聞いたあとにそのセルの値が変わっていた: 入れずに changed
 * - 行は中身（印の無い列）で探す（顧客が行を足した・消したとき）。見つからない行は unreadable
 */
export async function readMarked(sheets: readonly SheetGrid[], rows: readonly KojiRow[], source: readonly SheetGrid[] | null, id: MarkId & { plan: Plan | null }, ai: AnswerAi): Promise<MarkedRead | { error: string }> {
  const parsed = markedCheckOf(sheets)
  if (!parsed) return { error: "印付きの Excel ではありません" }
  if ("error" in parsed) return parsed
  const { check } = parsed
  const own = check.meta.caseId === id.caseId && check.meta.keyMark === (await keyMark(id.excelKey, id.caseId)) && parsed.sig === (await signatureOf(parsed.body, id.excelKey, id.caseId))
  if (!own) return { error: "この案件で作った印付きの Excel ではないか、照合用のシートが書き換えられています。読み込んでいません" }
  if (check.meta.sourceFileId !== id.sourceFileId) return { error: "変換の元を変える前に作った印付きの Excel です。今の問い合わせで作り直して送ってください" }

  const hash = (text: string) => hashOf(id.excelKey, id.caseId, text)
  const gridOf = new Map(sheets.map((s) => [s.name, s]))
  const now = new Map(rows.map((r) => [r.key, r]))
  const report: AiAnswerReport = {
    edits: [],
    applied: [],
    unknownKeys: [],
    unreadable: [],
    duplicateKeys: [],
    unanswered: [],
    confirmed: [],
    alreadyApplied: [],
    changed: [],
    alsoChanged: [],
    heldBack: [],
    needsCheck: [],
    invalid: [],
    uncorrected: [],
  }

  // 行を探す: 同じ行の中身が同じならその行、違えば同じ中身の行がシートに1つだけあればその行（行の中身の HMAC は、同じ幅・同じ印の列の組ごとに1回だけ数える）
  const found = new Map<string, number | null>()
  const indexes = new Map<string, Map<string, number[]>>()
  async function indexOf(grid: SheetGrid, width: number, skip: readonly number[]) {
    const k = JSON.stringify([grid.name, width, skip])
    let index = indexes.get(k)
    if (!index) {
      index = new Map()
      for (const [i, r] of grid.rows.entries()) {
        const h = await hash(rowText(r, width, skip))
        index.set(h, [...(index.get(h) ?? []), i])
      }
      indexes.set(k, index)
    }
    return index
  }
  for (const r of check.rows) {
    const grid = gridOf.get(r.sheet)
    let at: number | null = null
    if (grid) {
      if ((await hash(rowText(grid.rows[r.row], r.width, r.skip))) === r.hash) at = r.row
      else {
        const hits = (await indexOf(grid, r.width, r.skip)).get(r.hash) ?? []
        at = hits.length === 1 ? hits[0]! : null
      }
    }
    found.set(`${r.sheet}\t${r.row}`, at)
  }
  // 足した列: 書いた位置に同じ見出しがあればそこ、無ければシートで同じ見出しのセルを探す（顧客が列や行を足したとき。1つだけなら）
  const addedAt = new Map<string, number | null>()
  for (const c of check.columns) {
    const grid = gridOf.get(c.sheet)
    const column = SHEET_COLUMNS.find((x) => x.header === c.column)
    if (!column) return { error: BROKEN }
    const want = addedHeader(column)
    let col: number | null = c.headerRow < 0 || (grid?.rows[c.headerRow]?.[c.col] ?? "").trim() === want ? c.col : null
    if (col === null && grid) {
      const hits = new Set(grid.rows.flatMap((r) => r.flatMap((v, i) => (v.trim() === want ? [i] : []))))
      col = hits.size === 1 ? [...hits][0]! : null
    }
    addedAt.set(`${c.sheet}\t${c.col}`, col)
  }

  const items: AiAnswer[] = []
  const toRead: { cell: MarkedCell; row: KojiRow; raws: string[] }[] = []
  for (const cell of check.cells) {
    const row = now.get(cell.rowKey)
    if (!row) {
      if (!report.unknownKeys.includes(cell.rowKey)) report.unknownKeys.push(cell.rowKey)
      continue
    }
    const at = found.get(`${cell.sheet}\t${cell.row}`)
    const cols = cell.added ? cell.cols.map((c) => addedAt.get(`${cell.sheet}\t${c}`) ?? null) : cell.cols
    if (at === null || at === undefined || cols.some((c) => c === null)) {
      if (!report.unreadable.some((u) => u.rowKey === cell.rowKey))
        report.unreadable.push({ line: cell.row + 1, rowKey: cell.rowKey, reason: at == null ? "行が見つからない（行を消した・書き換えた）" : "足した列が見つからない" })
      continue
    }
    const q: CellInquiry = { kind: "cell", rowKey: cell.rowKey, field: cell.field, reason: cell.reason, current: storedOf(row, cell.field) }
    const raws = (cols as number[]).map((c) => (gridOf.get(cell.sheet)!.rows[at]?.[c] ?? "").trim())
    const text = raws.filter(Boolean).join(" ")
    if ((await hash(storedOf(row, cell.field))) !== cell.current) {
      if (text && (await hash(text)) !== cell.sent) report.changed.push({ rowKey: cell.rowKey, field: cell.field, now: storedOf(row, cell.field), answer: text })
      continue
    }
    if ((await hash(text)) === cell.sent || !text) {
      if (cell.reason === "needsReview" && text) items.push({ rowKey: cell.rowKey, field: cell.field, confirm: true })
      else report.unanswered.push(q)
      continue
    }
    toRead.push({ cell, row, raws })
  }
  items.push(...(await answersOf(toRead, id.plan, ai)))
  // 同じ欄（工事場所の都道府県と場所名）のもう一方に答えがあれば、その欄はまとめて読む（未記入と二重に数えない）
  const answeredColumn = new Set(items.map((i) => `${i.rowKey}\t${columnOf(i.field)!.header}`))
  report.unanswered = report.unanswered.filter((q) => !answeredColumn.has(`${q.rowKey}\t${columnOf(q.field)!.header}`))
  const read = items.length ? await readAiAnswers(items, rows, ai) : null
  if (read) merge(report, read)

  // 元のファイルに行の無い工事の問い合わせ（記入用Excelと同じ読み方）
  const addedSheet = gridOf.get(ADDED_SHEET_NAME)
  let outside = 0
  if (addedSheet) {
    const r = await readAnswers([addedSheet], rows, ai)
    if (!("error" in r)) merge(report, { ...r, uncorrected: [] })
    outside += outsideCells([addedSheet], rows)
  }
  if (source) outside += changedOutside(sheets, source, check, found, addedAt)
  return { report, outside }
}

function merge(into: AiAnswerReport, from: AiAnswerReport) {
  for (const k of Object.keys(into) as (keyof AiAnswerReport)[]) (into[k] as unknown[]).push(...(from[k] as unknown[]))
}

/**
 * 書き換えられた印のセルを、顧客の答え（readAiAnswers の answer）にする。年月・工事場所は計画の決まった変換（工期 → 着工年月など）で
 * 値にする（同じ列の対応のまま読む。変換で決まらなければ書いたまま渡す）。注文者・工事名・配置技術者・足した列は書いたまま渡す
 * （readAiAnswers が計画の値を整える部分と匿名化を通す）
 */
async function answersOf(list: readonly { cell: MarkedCell; row: KojiRow; raws: string[] }[], plan: Plan | null, ai: AnswerAi): Promise<AiAnswer[]> {
  const ruleOf = (c: MarkedCell) => {
    const p = plan?.fields[c.field]
    const column = columnOf(c.field)!
    if (c.added || column.transform || (p?.kind !== "column" && p?.kind !== "columns")) return null
    const t = getTransform(p.transform)
    return t.kind === "rule" || t.ai ? t : null
  }
  const addresses = await ai.lookup(list.flatMap((x) => (ruleOf(x.cell)?.readsAddress && x.raws[0] ? [x.raws[0]] : [])))
  return list.map(({ cell, raws }): AiAnswer => {
    const text = raws.filter(Boolean).join(" ")
    const t = ruleOf(cell)
    const out = t?.run(raws, { rounding: ai.ctx.rounding, addresses })
    return { rowKey: cell.rowKey, field: cell.field, answer: out?.kind === "value" && out.value ? out.value : text }
  })
}

/**
 * 印の無いセルで、顧客が書き換えた・書き足したセルの数（顧客が付けたメモも）。行が動いていなければセルごとに比べ、
 * 動いていれば（行を足した・消した）印を付けた列を除いた行の中身で数える。照合用のシートは数えない
 */
function changedOutside(sheets: readonly SheetGrid[], source: readonly SheetGrid[], check: MarkedCheck, found: ReadonlyMap<string, number | null>, addedAt: ReadonlyMap<string, number | null>): number {
  let n = 0
  const filled = (cells: readonly string[]) => cells.filter((c) => c.trim()).length
  for (const s of sheets) {
    if (s.name === MARKED_SHEET_NAME || s.name === ADDED_SHEET_NAME) continue
    const before = source.find((x) => x.name === s.name)
    const theirs = (s.notes ?? []).filter((x) => !x.text.startsWith(REVIEW_NOTE_PREFIX) && !before?.notes?.some((b) => b.row === x.row && b.column === x.column && b.text === x.text))
    n += theirs.length
    if (!before) {
      n += s.rows.reduce((k, r) => k + filled(r), 0)
      continue
    }
    const markedAt = new Map<number, Set<number>>()
    for (const c of check.cells) {
      if (c.sheet !== s.name) continue
      const cols = c.added ? c.cols.map((x) => addedAt.get(`${c.sheet}\t${x}`) ?? -1) : c.cols
      const set = markedAt.get(c.row) ?? new Set<number>()
      for (const x of cols) set.add(x)
      markedAt.set(c.row, set)
    }
    const added = new Set(check.columns.filter((c) => c.sheet === s.name).flatMap((c) => [addedAt.get(`${c.sheet}\t${c.col}`) ?? -1]))
    const moved = s.rows.length !== before.rows.length || check.rows.some((r) => r.sheet === s.name && found.get(`${r.sheet}\t${r.row}`) !== r.row)
    if (!moved) {
      s.rows.forEach((cells, i) => {
        cells.forEach((v, j) => {
          if (markedAt.get(i)?.has(j)) return
          if (added.has(j)) {
            if (v.trim() && i !== check.columns.find((c) => c.sheet === s.name)?.headerRow) n++
            return
          }
          if (v.trim() !== (before.rows[i]?.[j] ?? "").trim()) n++
        })
      })
      continue
    }
    // 行が動いたときは、印を付けた列と足した列を除いた行の中身の数で比べる（元に無い中身の行を数える）
    const skip = new Set([...[...markedAt.values()].flatMap((x) => [...x]), ...added])
    const key = (cells: readonly string[]) => JSON.stringify(cells.map((v, j) => (skip.has(j) ? "" : v.trim())).filter((_, j) => !added.has(j)))
    const left = new Map<string, number>()
    for (const r of before.rows) left.set(key(r), (left.get(key(r)) ?? 0) + 1)
    for (const r of s.rows) {
      const k = key(r)
      const c = left.get(k) ?? 0
      if (c > 0) left.set(k, c - 1)
      else if (r.some((v) => v.trim())) n++
    }
  }
  return n
}

/** 添付する Excel の選び方（画面の「Excel をダウンロード」とメール）。marked なら印付き、sheet なら記入用Excel と理由 */
export type AttachmentChoice = { kind: "marked"; askCount: number; hints: string[] } | { kind: "sheet"; askCount: number; hints: string[]; reason: string }

/**
 * どちらの Excel を添付するかを決める。source は変換の元（sheets と、印付きにできるか＝markable.ts の markability）。
 * 印付きにできなければ、理由を添えて記入用Excel
 */
export function chooseAttachment(
  source: { sheets: readonly SheetGrid[]; markable: { ok: true } | { ok: false; reason: string } } | null,
  plan: Plan | null,
  rows: readonly KojiRow[],
  inquiries: readonly CellInquiry[],
): AttachmentChoice {
  const sheet = (reason: string): AttachmentChoice => {
    const s = inquirySheet(rows, inquiries)
    return { kind: "sheet", askCount: s.askCount, hints: s.hints, reason }
  }
  if (!source || !plan) return sheet("元の Excel が無いので")
  if (!source.markable.ok) return sheet(source.markable.reason)
  const placed = placeMarks(source.sheets, plan, rows, inquiries)
  if (!placed) return sheet("聞く工事がどれも元の Excel に無いので")
  return { kind: "marked", askCount: placed.askCount, hints: placed.hints }
}

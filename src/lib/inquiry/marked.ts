import { z } from "zod"
import { editKey, type RowResult } from "../convert/convert"
import type { FieldPlan, MappingPlan, SheetGrid } from "../convert/plan"
import { getTransform } from "../convert/transforms"
import { hmac, keyMark } from "../excel/final-sheet"
import { fieldIdSchema } from "../schemas"
import type { KojiFieldId } from "../spec/koji-keireki"
import {
  answerHints,
  askLabel,
  emptyReport,
  columnOf,
  inquirySheet,
  outsideCells,
  readAiAnswers,
  readAnswers,
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

const metaSchema = z.strictObject({
  caseId: z.string().min(1).max(64),
  sourceFileId: z.string().min(1).max(64),
  exportedAt: z.string().max(40),
  keyMark: z.string().regex(/^[0-9a-f]{16}$/),
})
const hashSchema = z.string().regex(/^[0-9a-f]{24}$/)
const indexSchema = z.number().int().min(0).max(1_048_575)
const colSchema = z.number().int().min(0).max(16_383)
const columnSchema = z.strictObject({ sheet: z.string().min(1), col: colSchema, headerRow: z.number().int().min(-1), column: z.string().min(1) })
/** 行のセルごとの HMAC（4バイト。印を付けた列は空）。「,」でつなぐ */
const rowSchema = z.strictObject({ sheet: z.string().min(1), row: indexSchema, skip: z.array(colSchema), cells: z.string().regex(/^([0-9a-f]{8})?(,([0-9a-f]{8})?)*$/) })
const cellSchema = z.strictObject({
  rowKey: z.string().min(1).max(200),
  field: fieldIdSchema,
  reason: z.enum(["missing", "needsReview"]),
  sheet: z.string().min(1),
  row: indexSchema,
  cols: z.array(colSchema).min(1).max(20),
  added: z.boolean(),
  current: hashSchema,
  sent: hashSchema,
})
const noteSchema = z.strictObject({ sheet: z.string().min(1), row: indexSchema, col: colSchema, text: z.string().max(2000) })

export type MarkedMeta = z.infer<typeof metaSchema>
/** 足した列。column は記入用Excelの欄の見出し（どの項目の列か）、headerRow は見出しを書いた行（無ければ -1） */
export type MarkedColumn = { sheet: string; col: number; headerRow: number; column: string }
/**
 * 印を付けた行の照合: 印を付けた列（skip。同じ結合の列も）を除いたセルごとの HMAC（cells は列ごとに「,」でつなぐ。skip の列は空）。
 * 顧客が行を足した・消した・印の無いセルを少し直したときも、大半のセルが合う行を探す
 */
export type MarkedRow = { sheet: string; row: number; skip: number[]; cells: string }
/** 聞いたセル。cols は印を付けた列（added なら足した列）。current は聞いたときのセルの値、sent は印を付けたセルに書いてあった文字の HMAC */
export type MarkedCell = { rowKey: string; field: KojiFieldId; reason: InquiryReason; sheet: string; row: number; cols: number[]; added: boolean; current: string; sent: string }
/** この画面が付けたメモ（返ってきたファイルで、顧客が付けたメモと見分ける。工事場所・年月のほかは決まった文で、個人名は入らない） */
export type MarkedNote = { sheet: string; row: number; col: number; text: string }
export type MarkedCheck = { meta: MarkedMeta; columns: MarkedColumn[]; rows: MarkedRow[]; cells: MarkedCell[]; notes: MarkedNote[] }

/** 印を付けるセル。note は推定の確かめのメモ、value は足した列に書く値 */
export type MarkCell = { sheet: string; row: number; col: number; note?: string; value?: string }
export type MarkPlan = {
  cells: MarkCell[]
  /** 足す列（header は見出しの文） */
  columns: (MarkedColumn & { header: string })[]
  /** 元のファイルに行の無い工事の問い合わせ（無ければ null） */
  added: InquirySheet | null
  check: MarkedCheck
  /** 記入してほしい欄の数（項目ごとの数の合計。メールと画面の件数） */
  askCount: number
  /** 項目ごとの記入してほしい欄の数（印付きは色を付けたセル、追加の確認のシートも） */
  byItem: { label: string; count: number }[]
  hints: string[]
}

export type MarkId = { caseId: string; sourceFileId: string; excelKey: string }

const hashOf = (key: string, caseId: string, text: string) => hmac(key, `marked\n${caseId}\n${text}`, 12)
/** 行の照合のセルの HMAC（短い。行を探すだけに使う） */
const cellHashOf = (key: string, caseId: string, text: string) => hmac(key, `marked-cell\n${caseId}\n${text.trim()}`, 4)
/** 行のセルごとの HMAC（元の幅まで。skip の列は空） */
const rowHashes = (key: string, caseId: string, cells: readonly string[] | undefined, width: number, skip: readonly number[]) =>
  Promise.all(Array.from({ length: width }, (_, i) => (skip.includes(i) ? "" : cellHashOf(key, caseId, cells?.[i] ?? ""))))
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

/** その行のその列のセルを含む結合の範囲（無ければ undefined） */
const mergeAt = (grid: SheetGrid, row: number, col: number) => grid.merges?.find((x) => x.s.r <= row && row <= x.e.r && x.s.c <= col && col <= x.e.c)
/** その行のその列のセルと同じ結合の範囲にある列（結合していなければその列だけ） */
function mergedColumns(grid: SheetGrid, row: number, col: number): number[] {
  const m = mergeAt(grid, row, col)
  return m ? Array.from({ length: m.e.c - m.s.c + 1 }, (_, i) => m.s.c + i) : [col]
}
/** 色やメモを付けるセル（結合の中なら左上。結合の左上以外のセルの塗りは Excel に見えない） */
function paintAt(grid: SheetGrid, row: number, col: number) {
  const m = mergeAt(grid, row, col)
  return m ? { row: m.s.r, col: m.s.c } : { row, col }
}

/**
 * 計画がその項目に使う元の列（無ければ null。列を足す）。ほかの項目の列から推し量る変換（工事名から工事場所を推定するなど）は、
 * その列に答えを書いてもらうものではないので列を足す
 */
function planColumns(p: FieldPlan | undefined): number[] | null {
  if ((p?.kind === "column" || p?.kind === "columns") && getTransform(p.transform).infers) return null
  if (p?.kind === "column") return [p.column]
  if (p?.kind === "columns" && p.columns.length) return p.columns
  return null
}


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

  // 1つの結合に重なる問い合わせ（縦に結合した2行の工事など）は、結合の左上の1つのセルにまとめ、メモは重ねる。記入はどの行にもそのセルの値として読む
  const cells = new Map<string, MarkCell>()
  const items = new Map<SheetColumn, Set<string>>()
  for (const { q, r, cols, added } of placed) {
    const column = columnOf(q.field)!
    cols.forEach((col, i) => {
      const p = added ? { row: r.row, col } : paintAt(gridOf.get(r.sheet)!, r.row, col)
      const at = `${r.sheet}\t${p.row}\t${p.col}`
      if (i === 0) items.set(column, (items.get(column) ?? new Set()).add(at))
      const cell = cells.get(at) ?? { sheet: r.sheet, row: p.row, col: p.col }
      // 推定の確かめは最初の列にだけ。足した列には推定の値を書いておく（そのままなら確認）
      const note = q.reason === "needsReview" && i === 0 ? reviewNoteOf(column, r) : undefined
      if (note && !cell.note?.includes(note)) cell.note = cell.note ? `${cell.note}\n${note}` : note
      if (added && q.reason === "needsReview") cell.value = column.show(r)
      cells.set(at, cell)
    })
  }
  const added = extra.length ? inquirySheet(rows, extra) : null
  const review = placed.some((p) => p.q.reason === "needsReview")
  const counts = new Map([...items].map(([c, set]) => [c, set.size]))
  for (const [c, n] of added ? sheetCounts(added) : []) counts.set(c, (counts.get(c) ?? 0) + n)
  const byItem = itemCounts(counts)
  return {
    cells: [...cells.values()],
    columns,
    added,
    placed,
    byItem,
    askCount: byItem.reduce((n, x) => n + x.count, 0),
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
    // 結合セルに書くと、読み直した表では結合の範囲の列がすべて変わるので、同じ結合の列も行の照合から除く
    if (!added) for (const c of cols) for (const x of mergedColumns(gridOf.get(r.sheet)!, r.row, c)) entry.skip.add(x)
    byRow.set(at, entry)
  }
  const markedRows = await Promise.all(
    [...byRow.values()].map(async ({ sheet, row, skip }) => {
      const grid = gridOf.get(sheet)!
      const s = [...skip].sort((a, b) => a - b)
      return { sheet, row, skip: s, cells: (await rowHashes(id.excelKey, id.caseId, grid.rows[row], widthOf(grid), s)).join(",") }
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
      notes: rest.cells.flatMap((c) => (c.note ? [{ sheet: c.sheet, row: c.row, col: c.col, text: c.note }] : [])),
    },
  }
}

/** 記入用Excelの形のシートの、欄ごとの記入してほしいセルの数 */
function sheetCounts(sheet: InquirySheet): Map<SheetColumn, number> {
  const out = new Map<SheetColumn, number>()
  sheet.columns.forEach((c, i) => {
    const column = SHEET_COLUMNS.find((x) => x.header === c.header)
    const n = sheet.rows.filter((r) => r.cells[i]?.ask).length
    if (column && n) out.set(column, n)
  })
  return out
}

/** 項目ごとの数（記入用Excelの欄の順） */
const itemCounts = (counts: ReadonlyMap<SheetColumn, number>) =>
  [...counts].sort(([a], [b]) => SHEET_COLUMNS.indexOf(a) - SHEET_COLUMNS.indexOf(b)).map(([c, count]) => ({ label: askLabel(c.fields[0]!), count }))

/** 記入用Excelの項目ごとの数（メールの内訳。合計は askCount と同じ） */
export const sheetItems = (sheet: InquirySheet) => itemCounts(sheetCounts(sheet))

/** 印を付ける場所の印（同じ場所なら同じ。書けなかったことを覚えておき、問い合わせや列の対応が変わったら判定し直す） */
export function placementKey(p: MarkPlacement): string {
  const text = JSON.stringify([p.cells.map((c) => [c.sheet, c.row, c.col, c.value ?? null]), p.columns.map((c) => [c.sheet, c.col, c.headerRow]), p.added?.rows.length ?? 0])
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return `${text.length.toString(16)}-${h.toString(16)}`
}

/** 足す列の並び（記入用Excelの欄の順） */
const SHEET_ORDER = (q: CellInquiry) => SHEET_COLUMNS.indexOf(columnOf(q.field)!)

// ---- 照合用の隠しシート ----

/**
 * 隠しシートのセル（1行目は印、そのあと識別・足した列・行・セル・メモを1行に1つ、最後に全体の HMAC）。全セル文字列。
 * 中身は JSON の文字（頭と終わりが括弧）にするので、読み直すときの前後の空白の扱いで HMAC が変わらない
 */
export async function markedSheetRows(check: MarkedCheck, excelKey: string): Promise<string[][]> {
  const body: string[][] = [
    [MARKED_MARK, String(MARKED_VERSION)],
    ["meta", JSON.stringify(check.meta)],
    ...check.columns.map((c) => ["column", JSON.stringify(c)]),
    ...check.rows.map((r) => ["row", JSON.stringify(r)]),
    ...check.cells.map((c) => ["cell", JSON.stringify(c)]),
    ...check.notes.map((n) => ["note", JSON.stringify(n)]),
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
  const body = rows.slice(0, -1).map((r) => r.slice(0, 2))
  body[0] = [MARKED_MARK, String(MARKED_VERSION)]
  const check: MarkedCheck = { meta: undefined as unknown as MarkedMeta, columns: [], rows: [], cells: [], notes: [] }
  let meta = false
  for (const [kind, payload] of body.slice(1)) {
    const value = json(payload ?? "")
    const read = <T>(schema: z.ZodType<T>, push: (v: T) => void) => {
      const p = schema.safeParse(value)
      if (!p.success) return false
      push(p.data)
      return true
    }
    const ok =
      kind === "meta"
        ? read(metaSchema, (v) => ((check.meta = v), (meta = true)))
        : kind === "column"
          ? read(columnSchema, (v) => check.columns.push(v))
          : kind === "row"
            ? read(rowSchema, (v) => check.rows.push(v))
            : kind === "cell"
              ? read(cellSchema, (v) => check.cells.push({ ...v, field: v.field as KojiFieldId }))
              : kind === "note"
                ? read(noteSchema, (v) => check.notes.push(v))
                : false
    if (!ok) return { error: BROKEN }
  }
  if (!meta || check.cells.some((c) => !columnOf(c.field))) return { error: BROKEN }
  return { check, body, sig: sigRow[1] }
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
  const report: AiAnswerReport = { ...emptyReport(), uncorrected: [] }

  // 行を探す: 書いた位置の行のセルが大半合えばその行（印の無いセルを少し直しても見失わない。直したセルは印の無いセルの書き換えとして数える）。
  // 合わなければ（行を足した・消した）、いちばん合う行が1つだけで大半合えばその行
  const found = new Map<string, number | null>()
  const cellHash = new Map<string, Promise<string>>()
  const hashAt = (grid: SheetGrid, r: number, c: number) => {
    const k = `${grid.name}\t${r}\t${c}`
    let h = cellHash.get(k)
    if (!h) cellHash.set(k, (h = cellHashOf(id.excelKey, id.caseId, grid.rows[r]?.[c] ?? "")))
    return h
  }
  const empty = await cellHashOf(id.excelKey, id.caseId, "")
  for (const r of check.rows) {
    const grid = gridOf.get(r.sheet)
    const want = r.cells.split(",")
    const cols = want.flatMap((h, c) => (h ? [c] : []))
    // 合わなくてよいセルの数（1つは必ず許す）。空でないセルが1つも合わない行は別の行
    const allowed = Math.max(1, Math.floor(cols.length / 5))
    const score = async (i: number) => {
      const got = await Promise.all(cols.map((c) => hashAt(grid!, i, c)))
      const miss = cols.filter((c, k) => got[k] !== want[c]).length
      const hit = cols.some((c, k) => got[k] === want[c] && want[c] !== empty)
      return hit ? miss : Infinity
    }
    let at: number | null = null
    if (grid) {
      if ((await score(r.row)) <= allowed) at = r.row
      else {
        const misses = await Promise.all(grid.rows.map((_, i) => score(i)))
        const best = Math.min(...misses)
        at = best <= allowed && misses.filter((m) => m === best).length === 1 ? misses.indexOf(best) : null
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
  /** 聞いたあとにセルの値が変わっていて、記入もある（答えが今の値と同じなら表にもうある、違えば入れずに changed） */
  const stale: { cell: MarkedCell; row: KojiRow; raws: string[] }[] = []
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
      // 聞いたあとにセルの値が変わった: 記入があれば答えを比べ、記入が無い・書いたときのままなら未記入
      if (text && (await hash(text)) !== cell.sent) stale.push({ cell, row, raws })
      else report.unanswered.push(q)
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
  // 聞いたあとに変わったセル: 同じ答え（承認したあとに同じファイルを上げ直したなど）は表にもうある、違う答えは入れずに知らせる
  if (stale.length) {
    const again = await readAiAnswers(await answersOf(stale, id.plan, ai), rows, ai)
    for (const { cell, row, raws } of stale) {
      const key = editKey(cell.rowKey, cell.field)
      const edit = again.edits.find(([k]) => k === key)?.[1]
      const unread = [...again.invalid.map((i) => i.inquiry), ...again.uncorrected].some((i) => i.rowKey === cell.rowKey && i.field === cell.field)
      const now = storedOf(row, cell.field)
      if (edit || unread) report.changed.push({ rowKey: cell.rowKey, field: cell.field, now, answer: edit?.value ?? raws.filter(Boolean).join(" ") })
      else report.alreadyApplied.push({ kind: "cell", rowKey: cell.rowKey, field: cell.field, reason: cell.reason, current: now })
    }
  }

  // 元のファイルに行の無い工事の問い合わせ（記入用Excelと同じ読み方）
  const addedSheet = gridOf.get(ADDED_SHEET_NAME)
  let outside = 0
  if (addedSheet) {
    const r = await readAnswers([addedSheet], rows, ai)
    if ("error" in r) report.unreadable.push({ line: 0, rowKey: "", reason: `「${ADDED_SHEET_NAME}」のシート: ${r.error}` })
    else merge(report, { ...r, uncorrected: [] })
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
  const addresses = await ai.lookup(
    list.flatMap((x) => {
      const t = ruleOf(x.cell)
      const key = t?.readsAddress ? (t.addressOf?.(x.raws) ?? x.raws[0]) : undefined
      return key ? [key] : []
    }),
  )
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
    // この画面が付けたメモ（もとのメモがあったセルは、この画面のメモに続けたもの）と、もとからあったメモは数えない
    const ours = new Set(
      check.notes
        .filter((x) => x.sheet === s.name)
        .flatMap((x) => {
          const b = before?.notes?.find((y) => y.row === x.row && y.column === x.col)
          return b ? [x.text, `${x.text}\n――\n${b.text}`] : [x.text]
        }),
    )
    const theirs = (s.notes ?? []).filter((x) => !ours.has(x.text) && !before?.notes?.some((b) => b.text === x.text))
    n += theirs.length
    if (!before) {
      n += s.rows.reduce((k, r) => k + filled(r), 0)
      continue
    }
    // 印を付けた列（同じ結合の列も。行の照合の skip）と足した列
    const markedAt = new Map<number, Set<number>>()
    for (const r of check.rows) if (r.sheet === s.name) markedAt.set(r.row, new Set(r.skip))
    for (const c of check.cells) {
      if (c.sheet !== s.name || !c.added) continue
      const set = markedAt.get(c.row) ?? new Set<number>()
      for (const x of c.cols) set.add(addedAt.get(`${c.sheet}\t${x}`) ?? -1)
      markedAt.set(c.row, set)
    }
    // 印を付けたセルを含む結合（縦の結合のほかの行も）
    for (const c of check.cells) {
      if (c.sheet !== s.name || c.added) continue
      for (const col of c.cols) {
        const m = mergeAt(before, c.row, col)
        if (!m) continue
        for (let r = m.s.r; r <= m.e.r; r++) {
          const set = markedAt.get(r) ?? new Set<number>()
          for (let x = m.s.c; x <= m.e.c; x++) set.add(x)
          markedAt.set(r, set)
        }
      }
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
export type AttachmentChoice = { askCount: number; byItem: { label: string; count: number }[]; hints: string[] } & ({ kind: "marked" } | { kind: "sheet"; reason: string })

/**
 * どちらの Excel を添付するかを決める。markable は変換の元を印付きにできるか（markable.ts の markability か、書いてみて書けなかった理由）、
 * placement は印を付ける場所（placeMarks。画面は1回だけ求めて、ダウンロードにも使う）。印付きにできなければ、理由を添えて記入用Excel
 */
export function chooseAttachment(
  markable: { ok: true } | { ok: false; reason: string } | null,
  placement: MarkPlacement | null,
  rows: readonly KojiRow[],
  inquiries: readonly CellInquiry[],
): AttachmentChoice {
  const sheet = (reason: string): AttachmentChoice => {
    const s = inquirySheet(rows, inquiries)
    return { kind: "sheet", askCount: s.askCount, byItem: sheetItems(s), hints: s.hints, reason }
  }
  if (!markable) return sheet("元の Excel が無いので")
  if (!markable.ok) return sheet(markable.reason)
  if (!placement) return sheet("聞く工事がどれも元の Excel に無いので")
  return { kind: "marked", askCount: placement.askCount, byItem: placement.byItem, hints: placement.hints }
}

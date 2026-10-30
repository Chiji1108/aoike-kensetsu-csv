import { z } from "zod"
import { MAX_ADDED_ROWS } from "../cases/added"
import type { TableView } from "../cases/view"
import type { ChatChange } from "../chat/proposals"
import { addressKey, NO_ADDRESSES, type AddressLookup } from "../convert/address"
import { collapseSpaces } from "../convert/text"
import { leadingPrefecture, type Prefecture } from "../spec/prefectures"
import { resolveRows, transformCell, type CellDraft, type CellEdit, type CellResult, type RowDraft } from "../convert/convert"
import { INCLUSION_LABELS } from "../convert/koji-selection"
import { withNames } from "../convert/persons"
import { fillAiCache, type AiCache, type AiCaller } from "../convert/pipeline"
import type { SheetGrid } from "../convert/plan"
import { normalizePersonName, type Rounding, type TransformId } from "../convert/transforms"
import { groupBy } from "../group-by"
import { fieldIdSchema } from "../schemas"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"

/**
 * 職員が直す Excel（編集用）。案件の今の表（CSV に載る行も載らない行も）を落とし、職員が Excel で直して上げ直すと、
 * 落としたときの値との差分を変更案（出どころ excel）にする。
 * - 行ごとに隠し列（照合用）に行の key・落としたときの値・載せるかを持つ（行の同一性と、落としたあとに表が変わったかの見分けに使う）
 * - 隠しシート（照合用）に落とした行の key と、そのとき載せていたかの一覧を持つ（消した行を「載せない」にするため）
 * - 照合用の無い行（足した工事）は、行の中身から key を決める（同じ Excel を2回上げても二重に足さない）
 * - 個人名は実名で見せる（記入用Excelと同じ。取り込むときに注文者・工事名を変換と同じ匿名化に通す）
 * - 全セルを文字列の書式にする（先頭の 0・日付への変換を防ぐ。書式は edit-xlsx.ts）
 */

type F = KojiFieldId
const FIELDS = KOJI_KEIREKI.fields

export const EDIT_SHEET_NAME = "工事経歴（編集用）"
/** 1つの Excel の変更案に入れられる項目の数（R2 の記録と画面の一覧が重くなりすぎないように） */
export const MAX_EXCEL_CHANGES = 20_000
export const KEYS_SHEET_NAME = "照合用"
export const META_HEADER = "照合用"
export const INCLUDE_HEADER = "CSVに載せる"
const REFERENCE_HEADERS = { origin: "元の行（参考）", reason: "載せる理由（参考）", issues: "検査（参考）" } as const

/** 隠し列の中身。v は落としたときの値（空の項目は書かない）、i は載せるか */
const metaSchema = z.object({ k: z.string().min(1), v: z.partialRecord(fieldIdSchema, z.string()), i: z.boolean() })
type Meta = z.infer<typeof metaSchema>

/** Excel に出す値（個人名は実名。記号は画面と CSV だけ） */
const excelText = (cell: CellResult) => withNames(cell.stored ?? cell.value, (name) => name)

export type EditSheet = {
  name: string
  columns: { header: string; width: number; hidden?: true; reference?: true }[]
  rows: string[][]
  /** 落とした行の key と、そのとき載せていたか（隠しシート） */
  keys: { key: string; included: boolean }[]
}

/** 案件の今の表（画面の順）を編集用の表にする。最後の列は照合用（隠し列） */
export function editSheet(view: TableView): EditSheet {
  const columns = [
    { header: INCLUDE_HEADER, width: 8 },
    ...FIELDS.map((f) => ({ header: f.label, width: f.id === "workName" ? 40 : f.id === "client" ? 26 : f.id === "place" ? 16 : 11 })),
    { header: REFERENCE_HEADERS.origin, width: 14, reference: true as const },
    { header: REFERENCE_HEADERS.reason, width: 12, reference: true as const },
    { header: REFERENCE_HEADERS.issues, width: 40, reference: true as const },
    { header: META_HEADER, width: 4, hidden: true as const },
  ]
  const rows = view.shown.map((r) => {
    const inc = view.inclusion.get(r.key)
    const included = inc?.included === true
    const values = Object.fromEntries(FIELDS.map((f) => [f.id, excelText(r.cells[f.id])])) as Record<F, string>
    const meta: Meta = { k: r.key, v: Object.fromEntries(Object.entries(values).filter(([, v]) => v)), i: included }
    const issues = FIELDS.flatMap((f) => {
      const c = r.cells[f.id]
      return (c.status === "error" || c.status === "warning") && c.message ? [`${f.label}: ${c.message}`] : []
    })
    return [
      included ? "○" : "",
      ...FIELDS.map((f) => values[f.id]),
      `${r.sheet}!${r.row + 1}行`,
      inc ? INCLUSION_LABELS[inc.reason] : "",
      issues.join(" / "),
      JSON.stringify(meta),
    ]
  })
  return { name: EDIT_SHEET_NAME, columns, rows, keys: view.shown.map((r) => ({ key: r.key, included: view.inclusion.get(r.key)?.included === true })) }
}

/** 取り込んだ値を項目の値にする決まった処理（AI に頼らない。注文者・工事名は変換と同じ匿名化） */
const READ_AS: Record<F, TransformId | "personName" | "address"> = {
  gyoshu: "rule.gyoshu",
  client: "ai.anonymizeClient",
  motoukeShitauke: "rule.motoukeShitauke",
  jv: "rule.flag01",
  workName: "ai.anonymizeWorkName",
  prefecture: "rule.prefecture",
  place: "address",
  engineer: "personName",
  amount: "rule.thousandYen",
  specialAmount: "rule.thousandYen",
  startYm: "rule.yearMonth",
  endYm: "rule.yearMonth",
  chiefEngineer: "rule.flag01",
  supervisingEngineer: "rule.flag01",
}

const INCLUDE_ON = /^(○|〇|◯|●|1|はい|載せる|有)$/
const INCLUDE_OFF = /^(|×|✕|0|いいえ|載せない|無|-|ー)$/

export type EditReport = {
  /** 変更案にしたセル・行の数 */
  cells: number
  added: number
  /** もう表にある（前に上げて承認した）ので足さなかった行 */
  alreadyAdded: number
  included: number
  excluded: number
  /** 落としたあとに表のその値が変わっていた（職員の手直しを上書きしないので、変更案にしない） */
  conflicts: { line: number; rowKey: string; field: F | "include"; sent: string; now: string; uploaded: string }[]
  /** 読めない値（業種・年月など）。変更案にしない */
  invalid: { line: number; field: F | "include"; value: string; message: string }[]
  /** 個人名かもしれないのに匿名化を確かめられなかった値。変更案にしない */
  refused: { line: number; field: F; value: string; message: string }[]
  /** 照合用の列が壊れた行（書き換えた・別の行から貼った）。どの行か分からないので取り込まない */
  broken: { line: number; reason: string }[]
  /** 2つ以上の行にあった照合用（行を写して足したなど）。どれが正しいか分からないので、どの行も取り込まない */
  duplicateKeys: string[]
  /** 今の表に無い行（変換の元を変えたなど） */
  unknownKeys: string[]
  /** 見つからなかった列（その列の値は変えない） */
  missingColumns: string[]
  /** 壊れた行があるので、消した行を「載せない」にしなかった（壊れた行が消した行かもしれない） */
  deletionsSkipped: boolean
}

/** lookup は場所名に書いた住所を引く（変換と同じ分け方。address.ts） */
export type EditAi = { rounding: Rounding; cache: AiCache; callAi?: AiCaller; lookup: AddressLookup }

type Cell = { line: number; rowKey: string; field: F; value: string }

/**
 * 上げ直された編集用の Excel を、今の表（view）との差分の変更案にする。差分の元は落としたときの値（照合用の列）。
 * 職員が変えた値だけを変更案にし、落としたあとに表のその値も変わっていたら変更案にせず知らせる（黙って上書きしない）。
 * 消した行は「載せない」、照合用の無い行は新しい工事として足す。取り込んだ値は変換と同じ決まった処理・匿名化に通す
 */
export async function readEditSheet(sheets: readonly SheetGrid[], view: TableView, ai: EditAi): Promise<{ changes: ChatChange[]; report: EditReport } | { error: string }> {
  const sheet = sheets.find((s) => s.rows[0]?.some((c) => c.trim() === META_HEADER) && s.name !== KEYS_SHEET_NAME)
  const keysSheet = sheets.find((s) => s.name === KEYS_SHEET_NAME)
  if (!sheet || !keysSheet) return { error: `「${META_HEADER}」の列か、隠しシート「${KEYS_SHEET_NAME}」が見つかりません。この画面で落とした編集用の Excel を選んでください` }
  const header = sheet.rows[0]!.map((c) => c.trim())
  const col = (h: string) => header.indexOf(h)
  const metaCol = col(META_HEADER)
  const includeCol = col(INCLUDE_HEADER)
  const fieldCols = FIELDS.map((f) => ({ field: f.id, col: col(f.label) }))
  const report: EditReport = {
    cells: 0,
    added: 0,
    alreadyAdded: 0,
    included: 0,
    excluded: 0,
    conflicts: [],
    invalid: [],
    refused: [],
    broken: [],
    duplicateKeys: [],
    unknownKeys: [],
    missingColumns: [...fieldCols.filter((c) => c.col < 0).map((c) => FIELDS.find((f) => f.id === c.field)!.label), ...(includeCol < 0 ? [INCLUDE_HEADER] : [])],
    deletionsSkipped: false,
  }
  const now = new Map(view.shown.map((r) => [r.key, r]))
  const valueAt = (row: string[], c: number) => (c < 0 ? undefined : (row[c] ?? "").trim())

  // 行を、照合用のある行（今の表の行）と無い行（新しい工事）に分ける
  type Known = { line: number; meta: Meta; row: string[] }
  const known: Known[] = []
  const fresh: { line: number; row: string[] }[] = []
  sheet.rows.slice(1).forEach((row, i) => {
    const line = i + 2
    const raw = (row[metaCol] ?? "").trim()
    if (!raw) {
      if (fieldCols.some((c) => valueAt(row, c.col))) fresh.push({ line, row })
      return
    }
    const meta = parseMeta(raw)
    if (!meta) report.broken.push({ line, reason: "照合用の列が書き換えられていて読めません" })
    else known.push({ line, meta, row })
  })
  for (const [key, list] of groupBy(known, (k) => k.meta.k)) if (list.length > 1) report.duplicateKeys.push(key)
  const duplicated = new Set(report.duplicateKeys)

  const cellChanges: Cell[] = []
  const includes: { rowKey: string; include: boolean }[] = []
  /**
   * 載せるかの変更。落としたときの値（sent）から変えていなければ何もしない。今がもう望みどおりなら何もしない。
   * 落としたあとに画面で入れ外しを変えていたら（今が sent と違う）、黙って覆さず食い違いにする
   */
  const decideInclude = (rowKey: string, sent: boolean, desired: boolean, conflict: () => void) => {
    const nowIncluded = view.inclusion.get(rowKey)?.included === true
    if (desired === sent || nowIncluded === desired) return
    if (nowIncluded !== sent) conflict()
    else includes.push({ rowKey, include: desired })
  }
  for (const { line, meta, row } of known) {
    if (duplicated.has(meta.k)) continue
    const current = now.get(meta.k)
    if (!current) {
      report.unknownKeys.push(meta.k)
      continue
    }
    for (const { field, col: c } of fieldCols) {
      const uploaded = valueAt(row, c)
      const sent = meta.v[field] ?? ""
      if (uploaded === undefined || uploaded === sent) continue
      const nowText = excelText(current.cells[field])
      if (nowText !== sent) {
        report.conflicts.push({ line, rowKey: meta.k, field, sent, now: nowText, uploaded })
        continue
      }
      cellChanges.push({ line, rowKey: meta.k, field, value: uploaded })
    }
    const uploaded = valueAt(row, includeCol)
    if (uploaded === undefined) continue
    const include = INCLUDE_ON.test(uploaded) ? true : INCLUDE_OFF.test(uploaded) ? false : undefined
    if (include === undefined) {
      report.invalid.push({ line, field: "include", value: uploaded, message: "「○」か空欄にしてください" })
      continue
    }
    decideInclude(meta.k, meta.i, include, () => report.conflicts.push({ line, rowKey: meta.k, field: "include", sent: meta.i ? "○" : "", now: meta.i ? "" : "○", uploaded }))
  }

  // 消した行: 落とした行のうち、上げ直した表に無い行は載せない（壊れた行があれば、それが消した行かもしれないので何もしない）。
  // 落としたときに載せていなかった行・落としたあとに画面で外した行は何もしない（落としたあとに画面で載せた行は、落としたときに載せていなかったので覆さない）
  const present = new Set(known.map((k) => k.meta.k))
  const sent = keysSheet.rows.slice(1).flatMap((r) => ((r[0] ?? "").trim() ? [{ key: r[0]!.trim(), included: INCLUDE_ON.test((r[1] ?? "").trim()) }] : []))
  const deleted = sent.filter((s) => !present.has(s.key))
  if (report.broken.length) report.deletionsSkipped = deleted.length > 0
  else for (const s of deleted) decideInclude(s.key, s.included, false, () => {})

  // 値を項目の値にする（注文者・工事名は変換と同じ匿名化。AI の結果は変換と同じ cache に溜める）
  // 同じ中身の何番目かは Excel の行の順で数える（ハッシュの計算が終わる順に依らない）
  const hashes = await Promise.all(fresh.map(({ row }) => contentKey(fieldCols.map(({ col: c }) => valueAt(row, c) ?? ""))))
  const seen = new Map<string, number>()
  const newRows = fresh
    .map(({ line, row }, i) => {
      const hash = hashes[i]!
      const n = (seen.get(hash) ?? 0) + 1
      seen.set(hash, n)
      const rowKey = `add-${hash}-${n}`
      const cells = fieldCols.flatMap(({ field, col: c }): Cell[] => (valueAt(row, c) ? [{ line, rowKey, field, value: valueAt(row, c)! }] : []))
      const mark = valueAt(row, includeCol) ?? ""
      return { line, rowKey, cells, mark, include: INCLUDE_ON.test(mark) ? true : INCLUDE_OFF.test(mark) ? false : undefined }
    })
    .filter((r) => {
      // 前に上げて承認した行（同じ中身の同じ番目）はもう表にある
      if (!now.has(r.rowKey)) return true
      report.alreadyAdded++
      return false
    })
  // 上限は AI（匿名化）を呼ぶ前に確かめる
  const addedNow = view.shown.filter((r) => r.key.startsWith("add-")).length
  if (addedNow + newRows.length > MAX_ADDED_ROWS) return { error: `足す行が ${newRows.length} 行あります。案件に足せる行は ${MAX_ADDED_ROWS} 行までです（今 ${addedNow} 行）` }
  const planned = cellChanges.length + includes.length + newRows.length * 2
  if (planned > MAX_EXCEL_CHANGES) return { error: `変更が ${planned} 件あります。1回に取り込めるのは ${MAX_EXCEL_CHANGES} 件までです（分けて上げ直してください）` }
  const read = await readValues([...cellChanges, ...newRows.flatMap((r) => r.cells)], ai)
  // 場所名に書いた住所の都道府県で、都道府県名をそろえる（都道府県名も書き換えていて違えば、どちらも取り込まない）
  const align = (rowKey: string, cells: Cell[], add: (c: Cell) => void) => {
    const place = cells.find((c) => c.field === "place")
    const r = place && read.get(place)
    if (!place || !r?.ok || !r.prefecture) return
    const pref = cells.find((c) => c.field === "prefecture")
    const pr = pref && read.get(pref)
    if (pref && pr?.ok && pr.edit.value !== r.prefecture) {
      const message = `場所名の住所の都道府県「${r.prefecture}」が都道府県名「${pr.edit.value}」と違います`
      read.set(place, { ok: false, message })
      read.set(pref, { ok: false, message })
      return
    }
    if (pref) return
    const synthetic: Cell = { line: place.line, rowKey, field: "prefecture", value: r.prefecture }
    read.set(synthetic, { ok: true, edit: { value: r.prefecture, by: "excel" } })
    add(synthetic)
  }
  for (const [rowKey, cells] of groupBy(cellChanges, (c) => c.rowKey)) align(rowKey, cells, (c) => cellChanges.push(c))
  for (const r of newRows) align(r.rowKey, r.cells, (c) => r.cells.push(c))

  const changes: ChatChange[] = []
  for (const c of cellChanges) {
    const r = read.get(c)!
    if (!r.ok) {
      ;(r.refused ? report.refused : report.invalid).push({ line: c.line, field: c.field, value: c.value, message: r.message })
      continue
    }
    const cell = now.get(c.rowKey)!.cells[c.field]
    if (r.edit.value === (cell.stored ?? cell.value)) continue
    changes.push({ kind: "cell", rowKey: c.rowKey, field: c.field, edit: r.edit })
    report.cells++
  }
  for (const i of includes) {
    changes.push({ kind: "include", rowKey: i.rowKey, include: i.include })
    if (i.include) report.included++
    else report.excluded++
  }
  // 新しい工事は、読めない値が1つでもあれば足さない（直して上げ直してもらう）。「○」を付けた行は載せる
  for (const r of newRows) {
    const results = r.cells.map((c) => ({ c, res: read.get(c)! }))
    let failed = r.include === undefined
    if (failed) report.invalid.push({ line: r.line, field: "include", value: r.mark, message: "「○」か空欄にしてください（この行は足していません）" })
    for (const { c, res } of results) {
      if (res.ok) continue
      failed = true
      ;(res.refused ? report.refused : report.invalid).push({ line: r.line, field: c.field, value: c.value, message: `${res.message}（この行は足していません）` })
    }
    if (failed) continue
    changes.push({ kind: "add", rowKey: r.rowKey, by: "excel", cells: Object.fromEntries(results.flatMap(({ c, res }) => (res.ok ? [[c.field, res.edit]] : []))) })
    report.added++
    if (r.include) {
      changes.push({ kind: "include", rowKey: r.rowKey, include: true })
      report.included++
    }
  }
  return { changes, report }
}

function parseMeta(raw: string): Meta | undefined {
  try {
    const r = metaSchema.safeParse(JSON.parse(raw))
    return r.success ? r.data : undefined
  } catch {
    return undefined
  }
}

/** prefecture は、場所名に住所を書いたときの、住所に書いてあった都道府県 */
type Read = { ok: true; edit: CellEdit; prefecture?: Prefecture } | { ok: false; message: string; refused?: true }

/** 値を項目ごとの決まった処理に通す。空にした値は空のまま（職員が消した） */
async function readValues(cells: readonly Cell[], ai: EditAi): Promise<Map<Cell, Read>> {
  const ctx = { rounding: ai.rounding, addresses: NO_ADDRESSES }
  const out = new Map<Cell, Read>()
  const places = cells.filter((c) => READ_AS[c.field] === "address" && c.value)
  const addresses = places.length ? await ai.lookup(places.map((c) => c.value)) : NO_ADDRESSES
  const drafts: { cell: Cell; draft: RowDraft<F> }[] = []
  for (const c of cells) {
    const how = READ_AS[c.field]
    if (!c.value) {
      out.set(c, { ok: true, edit: { value: "", by: "excel" } })
      continue
    }
    if (how === "personName") {
      out.set(c, { ok: true, edit: { value: normalizePersonName(c.value), by: "excel" } })
      continue
    }
    if (how === "address") {
      // 住所を書いたら市区町村にする（都道府県は後でそろえる）。住所データに無い場所名（町名だけなど）はそのまま。都道府県から書いて市区町村が読めなければ読めない
      const { prefecture, city } = addresses.get(addressKey(c.value)) ?? {}
      if (city) out.set(c, { ok: true, edit: { value: city, by: "excel" }, ...(prefecture ? { prefecture } : {}) })
      else if (leadingPrefecture(addressKey(c.value))) out.set(c, { ok: false, message: "市区町村を読み取れません（例: 東京都千代田区）" })
      else out.set(c, { ok: true, edit: { value: collapseSpaces(c.value), by: "excel" } })
      continue
    }
    const draft = transformCell(how, [c.value], "Excel", ctx)
    drafts.push({ cell: c, draft: { key: `${drafts.length}`, sheet: "", row: 0, cells: { [c.field]: draft } as Record<F, CellDraft> } })
  }
  const pending = drafts.filter((d) => Object.values<CellDraft>(d.draft.cells)[0]!.kind === "ai" && READ_AS[d.cell.field].startsWith("ai."))
  if (ai.callAi && pending.length) await fillAiCache(pending.map((d) => d.draft), ai.cache, ai.callAi)
  const resolved = resolveRows(
    drafts.map((d) => d.draft),
    ai.cache,
  )
  drafts.forEach(({ cell: c, draft }, i) => {
    const before = Object.values<CellDraft>(draft.cells)[0]!
    const r = resolved[i]!.cells[c.field]
    const anonymize = READ_AS[c.field].startsWith("ai.")
    if (before.kind === "ai" && !anonymize) {
      out.set(c, { ok: false, message: `読めません（${before.reason}）` })
      return
    }
    if (r.status === "error" || r.withheld) {
      out.set(c, anonymize ? { ok: false, refused: true, message: r.message ?? "個人名の判定ができませんでした" } : { ok: false, message: r.message ?? "読めません" })
      return
    }
    const note = r.status === "warning" ? { status: "warning" as const, ...(r.message ? { message: r.message } : {}) } : {}
    out.set(c, { ok: true, edit: { value: r.value, by: "excel", ...note, ...(r.byAi ? { byAi: true } : {}), ...(r.guessed ? { guessed: true } : {}) } })
  })
  return out
}

/** 足した工事の行の key に使う、行の中身のハッシュ（SHA-256 の先頭16バイト） */
async function contentKey(content: readonly string[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)))
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

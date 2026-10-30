import { groupBy } from "../group-by"
import { codeLabel } from "../spec/code-sets"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import { addressKey, type AddressBook, type AddressLookup } from "../convert/address"
import { applyEdits, editKey, resolveRows, type CellEdits, type Replacements, transformCell, type CellDraft, type CellEdit, type CellResult, type RowDraft, type RowResult } from "../convert/convert"
import { fillAiCache, type AiCache, type AiCaller } from "../convert/pipeline"
import { formatYearMonth, parseYearMonth } from "../convert/dates"
import type { TaxMode } from "../convert/koji-selection"
import type { FieldPlan, SheetGrid } from "../convert/plan"
import { getTransform, knownNameSplits, normalizePersonName, type TransformContext, type TransformId } from "../convert/transforms"
import { withNames } from "../convert/persons"
import { collapseSpaces } from "../convert/text"
import { z } from "zod"

/**
 * 顧客への問い合わせ。データに無い・分からないことだけを聞く（聞かなくてもできる整形は事務所でやる）。
 * 対象は CSV に載せる行だけ。セルの問い合わせは記入用Excelの色付きの欄になり、
 * 返ってきた Excel の値は管理番号（行の key）で行を探して顧客の回答として適用する。
 */

type KojiRow = RowResult<KojiFieldId>

export type InquiryReason = "missing" | "needsReview"
export type CaseTopic = "tax"

/**
 * current は聞いたときのセルの値（個人名は印のまま。照合はこれで行う）。
 * 記入用Excelは顧客に返すものなので、個人名は記号ではなく氏名で出す（記号は CSV と画面だけ）。顧客の記入の氏名は元データの値と同じく匿名化する
 */
export type CellInquiry = {
  kind: "cell"
  rowKey: string
  field: KojiFieldId
  reason: InquiryReason
  current: string
}
export type CaseInquiry = { kind: "case"; topic: CaseTopic }
export type Inquiry = CellInquiry | CaseInquiry

export type InquirySettings = { tax: TaxMode }

export const inquiryKey = (q: Inquiry) => (q.kind === "cell" ? editKey(q.rowKey, q.field) : `case:${q.topic}`)

/** セルを問い合わせる理由。上から順に最初に当てはまるもの */
export const REASONS: Record<InquiryReason, { label: string; applies: (cell: CellResult) => boolean }> = {
  /**
   * 元データにあって出さなかった値（withheld）は職員が直すので聞かない。職員が手直しで空にした欄（チャットの変更案の承認も）も聞かない。
   * 職員が聞くと決めた空の欄（ask）は聞く
   */
  missing: { label: "データに無い", applies: (c) => c.value === "" && !c.withheld && (c.ask === true || (c.by !== "staff" && c.by !== "chat" && c.by !== "excel")) },
  needsReview: { label: "推定に自信がない", applies: (c) => c.guessed === true },
}

/** 案件全体の問い合わせ。question はメールにそのまま載せる */
export const CASE_TOPICS: Record<CaseTopic, { label: string; applies: (s: InquirySettings) => boolean; question: string }> = {
  tax: {
    label: "金額の税込・税抜",
    applies: (s) => s.tax === "unknown",
    question: "いただいた資料の請負代金は、税込・税抜のどちらでしょうか。",
  },
}

type Parsed = { ok: true; values: Partial<Record<KojiFieldId, string>> } | { ok: false; message: string }

/**
 * 記入用Excelの列。fields のある列は値を表示し、問い合わせ中のセルを塗って記入してもらう。
 * askOnly の列は問い合わせがあるときだけ出す。parse は顧客の記入を列の値にする。
 */
export type SheetColumn = {
  header: string
  width: number
  fields: readonly KojiFieldId[]
  show: (row: KojiRow) => string
  askOnly?: boolean
  /** メールと Excel の説明に載せる記入のしかた */
  hint?: string
  /** addresses は記入と表示した値を住所として引いた結果（工事場所の欄だけが読む） */
  parse?: (answer: string, addresses: AddressBook) => Parsed
  /**
   * 記入を元データの値と同じ変換に通す（注文者・工事名の個人名を印にする。記号は finalizeRows が付けるので、同じ人は同じ記号。
   * 氏名は同じ案件の区切りに合わせ、無ければ AI）。parse は送った値のままかの比較に使う。
   * 記入は必ずこの変換に通す（注文者・工事名なら必ず匿名化する）。計画がその項目に使う変換に値だけを整える部分（cleanAnswer）があれば先に当てる。
   * 計画の指示文は元データの列に向けたものなので使わない。
   * AI が使えなかったときの扱いも元データと同じ（個人名の判定ができなければ反映しない。transforms.ts の withoutAi）
   */
  transform?: TransformId
  /** 推定に自信がない値を聞くときにセルに添える確認（セルには「推定です。」を前に付ける。値が推定だと分からないまま「確認」されないように） */
  reviewNote?: string
}

/** セルの値を、送った値（q.current）と比べられる形で。個人名は印どうしで比べる（記号は付け直されるので比べない） */
const storedOf = (cell: CellResult) => cell.stored ?? cell.value
/** 記入用Excelに出す値。個人名は氏名で出す */
const namedOf = (cell: CellResult) => withNames(storedOf(cell), (name) => name)
const valueOf = (f: KojiFieldId) => (r: KojiRow) => namedOf(r.cells[f])
/** 文字列の記入は空白だけを整える（半角カナなどの表記は顧客の書いたまま） */
function text(f: KojiFieldId) {
  return (answer: string): Parsed => ({ ok: true, values: { [f]: collapseSpaces(answer) } })
}

function yearMonth(f: KojiFieldId) {
  return (answer: string): Parsed => {
    const ym = parseYearMonth(answer)
    return ym ? { ok: true, values: { [f]: formatYearMonth(ym) } } : { ok: false, message: "年月として読めません（例: 2024年4月）" }
  }
}

/**
 * 「東京都千代田区丸の内1-1」→ 都道府県＋市区町村。都道府県が無ければ場所名だけ。住所の分け方は変換と同じ（address.ts の lookupAddresses。
 * 都道府県は書いてあるときだけ読み、市区町村は住所データで決まるときだけ読む）。都道府県だけの記入は都道府県だけ。市区町村が読めなければ読み取れない
 */
function location(answer: string, addresses: AddressBook): Parsed {
  const a = addressKey(answer)
  if (!a) return { ok: true, values: {} }
  const { prefecture, city } = addresses.get(a) ?? {}
  if (!city && a !== prefecture)
    return { ok: false, message: prefecture ? "市区町村を読み取れません。市区町村まで書いてください（例: 東京都千代田区）" : "都道府県名から書いてください（例: 東京都千代田区）" }
  return { ok: true, values: { ...(prefecture ? { prefecture } : {}), ...(city ? { place: city } : {}) } }
}

export const MANAGEMENT_HEADER = "管理番号"

export const SHEET_COLUMNS: readonly SheetColumn[] = [
  { header: MANAGEMENT_HEADER, width: 12, fields: [], show: (r) => r.key },
  { header: "業種", width: 14, fields: [], show: (r) => codeLabel("gyoshu", r.cells.gyoshu.value) ?? r.cells.gyoshu.value },
  { header: "工事名", width: 36, fields: ["workName"], show: valueOf("workName"), parse: text("workName"), transform: "ai.anonymizeWorkName" },
  { header: "注文者", width: 24, fields: ["client"], show: valueOf("client"), parse: text("client"), transform: "ai.anonymizeClient" },
  { header: "請負代金（千円）", width: 14, fields: [], show: valueOf("amount") },
  { header: "着工年月", width: 11, fields: ["startYm"], show: valueOf("startYm"), hint: "着工・完成年月は「2024年4月」のようにご記入ください。", parse: yearMonth("startYm") },
  { header: "完成年月", width: 11, fields: ["endYm"], show: valueOf("endYm"), parse: yearMonth("endYm") },
  {
    header: "工事場所（都道府県・市区町村）",
    width: 28,
    fields: ["prefecture", "place"],
    show: (r) => r.cells.prefecture.value + r.cells.place.value,
    askOnly: true,
    hint: "工事場所は都道府県から市区町村までご記入ください（例: 東京都千代田区）。",
    parse: location,
    reviewNote: "正しいか確認し、違えば書き直してください",
  },
  {
    header: "配置技術者",
    width: 16,
    fields: ["engineer"],
    show: valueOf("engineer"),
    askOnly: true,
    hint: "配置技術者は、その工事に置いた主任技術者（または監理技術者）の氏名を、姓と名の間を空けてご記入ください。",
    parse: (answer) => ({ ok: true, values: { engineer: normalizePersonName(answer) } }),
    transform: "rule.personNameSpace",
    reviewNote: "姓と名の区切りを確認してください",
  },
]

const PERSON_FIELDS = KOJI_KEIREKI.fields.filter((f) => f.valueType.type === "personName").map((f) => f.id)

const columnOf = (field: KojiFieldId) => SHEET_COLUMNS.find((c) => c.fields.includes(field))

/** 問い合わせられる項目: CSV の必須か書類に要る項目のうち、記入用Excelに列があるもの */
const ASKABLE = new Set(KOJI_KEIREKI.fields.filter((f) => (f.required || f.filing) && columnOf(f.id)).map((f) => f.id))

/** そのセルを顧客に聞く理由（聞けない項目・聞かなくてよいセルは undefined）。問い合わせを集めるのと表の絞り込みで同じ決まり */
export function askReasonOf(field: string, cell: CellResult): InquiryReason | undefined {
  if (!ASKABLE.has(field as KojiFieldId)) return undefined
  return (Object.keys(REASONS) as InquiryReason[]).find((k) => REASONS[k].applies(cell))
}

/** CSV に載せる行（rows）と案件の設定から、顧客に聞くことを集める */
export function collectInquiries(rows: readonly KojiRow[], settings: InquirySettings): Inquiry[] {
  const cases = (Object.keys(CASE_TOPICS) as CaseTopic[]).filter((t) => CASE_TOPICS[t].applies(settings)).map((topic): Inquiry => ({ kind: "case", topic }))
  const cells = rows.flatMap((r) =>
    KOJI_KEIREKI.fields.flatMap((f): Inquiry[] => {
      const cell = r.cells[f.id]
      const reason = askReasonOf(f.id, cell)
      if (!reason) return []
      return [{ kind: "cell", rowKey: r.key, field: f.id, reason, current: storedOf(cell) }]
    }),
  )
  return [...cases, ...cells]
}

/** 記入用Excelの1行に書いておく照合用の情報（隠し列）。何を聞いたかを、パネルの状態に頼らずファイルから読めるようにする */
export type AskedRow = { asked: Omit<CellInquiry, "kind" | "rowKey">[] }

export const ASKED_HEADER = "照合用"

/** 記入用Excelに列がある項目（照合用の列に書けるのはこれだけ。ほかの項目名は壊れた照合用として読まない） */
const SHEET_FIELD_IDS = SHEET_COLUMNS.flatMap((c) => c.fields) as [KojiFieldId, ...KojiFieldId[]]
const AskedRowSchema = z.object({
  asked: z.array(z.object({ field: z.enum(SHEET_FIELD_IDS), reason: z.enum(["missing", "needsReview"]), current: z.string() })).min(1),
})

function parseAskedRow(cell: string): AskedRow | undefined {
  try {
    const r = AskedRowSchema.safeParse(JSON.parse(cell))
    return r.success ? r.data : undefined
  } catch {
    return undefined
  }
}

export type InquirySheet = {
  columns: { header: string; width: number; hidden?: true }[]
  rows: { cells: { value: string; ask: boolean; note?: string }[] }[]
  /** 記入してほしいセルの数 */
  askCount: number
  hints: string[]
}

/** 記入用Excelの中身（書式は inquiry-xlsx.ts）。問い合わせのある行だけを、渡した行の順に並べる。最後の列は照合用（隠し列） */
export function inquirySheet(rows: readonly KojiRow[], inquiries: readonly CellInquiry[]): InquirySheet {
  const byRow = groupBy(inquiries, (q) => q.rowKey)
  const isAsked = (r: KojiRow, c: SheetColumn) => c.fields.some((f) => byRow.get(r.key)?.some((q) => q.field === f))
  const target = rows.filter((r) => SHEET_COLUMNS.some((c) => isAsked(r, c)))
  const columns = SHEET_COLUMNS.filter((c) => !c.askOnly || target.some((r) => isAsked(r, c)))
  const sheetRows = target.map((r) => {
    const asked: AskedRow = { asked: (byRow.get(r.key) ?? []).map(({ kind: _, rowKey: __, ...a }) => a) }
    const note = (c: SheetColumn) => (c.reviewNote && asked.asked.some((q) => q.reason === "needsReview" && c.fields.includes(q.field)) ? { note: `推定です。${c.reviewNote}` } : {})
    return { cells: [...columns.map((c) => ({ value: c.show(r), ask: isAsked(r, c), ...note(c) })), { value: JSON.stringify(asked), ask: false }] }
  })
  return {
    columns: [...columns.map(({ header, width }) => ({ header, width })), { header: ASKED_HEADER, width: 4, hidden: true }],
    rows: sheetRows,
    askCount: sheetRows.reduce((n, r) => n + r.cells.filter((c) => c.ask).length, 0),
    hints: [
      ...columns.flatMap((c) => (c.hint && target.some((r) => isAsked(r, c)) ? [c.hint] : [])),
      ...columns.flatMap((c, i) =>
        sheetRows.some((r) => r.cells[i]!.note) ? [`${c.header}の欄にすでに値があるものは推定です。${c.reviewNote}（正しければそのままで構いません）。`] : [],
      ),
    ],
  }
}

export type AnswerReport = {
  /** 反映する手直し（applied・confirmed・alsoChanged の値） */
  edits: [string, CellEdit][]
  /** 聞いた項目で、顧客の記入を反映したもの */
  applied: CellInquiry[]
  /** Excel にあったが、今のデータに無い管理番号 */
  unknownKeys: string[]
  /** 取り込めなかった行（line は記入用Excelの行番号）。照合用の列が消えた・壊れていて何を聞いたか分からない、または管理番号が消されていて行が分からない */
  unreadable: { line: number; rowKey: string; reason: string }[]
  /** 2つ以上の行にあった管理番号（どれが回答か分からないので、どの行も取り込まない） */
  duplicateKeys: string[]
  /** データに無い欄が空欄のまま、または表示したもう一方の欄のまま返ってきた */
  unanswered: CellInquiry[]
  /** 推定に自信がない値がそのまま返ってきた（顧客が確認した）。推定の印を外し、次からは聞かない */
  confirmed: CellInquiry[]
  /** 回答が今の値と同じ（同じファイルをもう一度取り込んだなど） */
  alreadyApplied: CellInquiry[]
  /** 送ったあと、または読んでいる間に、セルの値が変わっていたので適用しなかった（mergeAnswers） */
  changed: { rowKey: string; field: KojiFieldId; now: string; answer: string }[]
  /** 聞いていないのに顧客が書き換えた、同じ欄のもう一方の項目（都道府県など）。適用したうえで確認してもらう */
  alsoChanged: { rowKey: string; field: KojiFieldId; was: string; answer: string }[]
  /** 同じ欄のほかの項目を反映できなかったので、反映しなかった項目（工事場所は都道府県と場所名を必ず一緒に反映する） */
  heldBack: { rowKey: string; field: KojiFieldId; answer: string }[]
  /** 反映したが、変換（個人名の判定など）で要確認になった記入 */
  needsCheck: { rowKey: string; field: KojiFieldId; answer: string; message: string }[]
  invalid: { inquiry: CellInquiry; answer: string; message: string }[]
}

const emptyReport = (): AnswerReport => ({
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
})

/** 顧客の回答を変換するときの設定（AI の結果は変換と同じ cache に溜める。前に失敗した記入は送り直す）。callAi が無ければ AI は呼ばない */
export type AnswerAi = { ctx: Omit<TransformContext, "addresses">; lookup: AddressLookup; cache: AiCache; callAi?: AiCaller; fields: Partial<Record<KojiFieldId, FieldPlan>> }

/** 記入を欄の変換に通す前に、計画がその項目の元データの列に使う変換の、値だけを整える部分を当てる（無ければそのまま） */
function cleanAnswer(column: SheetColumn, fields: AnswerAi["fields"], answer: string) {
  const p = fields[column.fields[0]!]
  const clean = p?.kind === "column" || p?.kind === "columns" ? getTransform(p.transform).cleanAnswer : undefined
  return clean ? clean(answer) : answer
}

const ANSWER_SOURCE = "顧客の回答"

/**
 * 返ってきた記入用Excelを顧客の回答にする。何を聞いたかは各行の照合用の列から読む（どの版の記入用Excelでも取り込める）。
 * 見出しが「管理番号」の列がある最初のシートを読む。rows は今の（手直し後の）全行。
 * 変換のある欄（注文者・工事名）の記入は、元データの値と同じくルール → AI の順に変換してから照合する。
 */
export async function readAnswers(sheets: readonly SheetGrid[], rows: readonly KojiRow[], ai: AnswerAi): Promise<AnswerReport | { error: string }> {
  const found = sheets.flatMap((s) => {
    const headerRow = s.rows.findIndex((r) => r.some((c) => c.trim() === MANAGEMENT_HEADER))
    return headerRow < 0 ? [] : [{ sheet: s, headerRow }]
  })[0]
  if (!found) return { error: `「${MANAGEMENT_HEADER}」の列が見つかりません。記入用Excelを選んでください` }
  const header = found.sheet.rows[found.headerRow]!.map((c) => c.trim())
  const keyCol = header.indexOf(MANAGEMENT_HEADER)
  const askedCol = header.indexOf(ASKED_HEADER)
  if (askedCol < 0) return { error: `「${ASKED_HEADER}」の列が見つかりません。この画面でダウンロードした記入用Excelを選んでください` }

  const now = new Map(rows.map((r) => [r.key, r]))
  const report = emptyReport()
  const answerRows = found.sheet.rows.slice(found.headerRow + 1).flatMap((answers, i) => {
    const rowKey = answers[keyCol]?.trim() ?? ""
    const line = found.headerRow + 2 + i
    if (rowKey) return [{ rowKey, answers, line }]
    if (answers.some((c) => c.trim())) report.unreadable.push({ line, rowKey, reason: "管理番号が空" })
    return []
  })
  for (const [rowKey, list] of groupBy(answerRows, (a) => a.rowKey)) if (list.length > 1) report.duplicateKeys.push(rowKey)
  const duplicated = new Set(report.duplicateKeys)

  /** 照合できた行の、欄ごとの記入（shown は送ったときに欄に表示していた内容） */
  const read = answerRows.flatMap(({ rowKey, answers, line }) => {
    if (duplicated.has(rowKey)) return []
    const row = now.get(rowKey)
    if (!row) {
      report.unknownKeys.push(rowKey)
      return []
    }
    const meta = parseAskedRow(answers[askedCol] ?? "")
    if (!meta) {
      report.unreadable.push({ line, rowKey, reason: "照合用の列が消えているか壊れている" })
      return []
    }
    const sent = meta.asked.map((a): CellInquiry => ({ kind: "cell", rowKey, ...a }))
    return [...groupBy(sent, (q) => columnOf(q.field)!)].map(([column, rowQs]) => {
      const col = header.indexOf(column.header)
      const answer = (col < 0 ? "" : answers[col] ?? "").trim()
      return { rowKey, row, column, rowQs, answer, shown: column.show(asSent(row, rowQs)) }
    })
  })
  await answerColumns(report, read, rows, ai)
  return report
}

/** 1つの欄への記入（記入用Excelの欄、または AI が読んだ答え）。rowQs はその欄で聞いた項目、shown は聞いたときに欄に表示していた内容 */
type ColumnAnswer = { rowKey: string; row: KojiRow; column: SheetColumn; rowQs: CellInquiry[]; answer: string; shown: string }

/**
 * 欄ごとの記入を項目の値にして report に入れる（記入用Excelと AI が読んだ答えで同じ）。
 * 変換のある欄（注文者・工事名・配置技術者）の記入は、元データの値と同じくルール → AI の順に変換してから照合する。
 */
async function answerColumns(report: AnswerReport, read: readonly ColumnAnswer[], rows: readonly KojiRow[], ai: AnswerAi) {
  // 工事場所の欄（記入と表示した値）は、変換と同じく住所として先に引いておく
  const addresses = await ai.lookup(read.flatMap((c) => (c.column.parse === location && c.answer ? [c.answer, c.shown] : [])))
  const columns = read.map((c) => ({ ...c, unchanged: !!c.answer && untouched(c.column.parse!, c.answer, c.shown, addresses) }))

  const ctx = { ...ai.ctx, addresses, knownNames: knownNameSplits(rows.flatMap((r) => PERSON_FIELDS.flatMap((f) => (splitByAi(r.cells[f]) ? [] : [r.cells[f].value])))) }
  const drafts: RowDraft<KojiFieldId>[] = columns.flatMap(({ rowKey, row, column, answer, unchanged }) => {
    if (!column.transform || !answer || unchanged) return []
    const cell = transformCell(column.transform, [cleanAnswer(column, ai.fields, answer)], ANSWER_SOURCE, ctx)
    return [{ key: rowKey, sheet: row.sheet, row: row.row, cells: { [column.fields[0]!]: cell } as Record<KojiFieldId, CellDraft> }]
  })
  if (ai.callAi) await fillAiCache(drafts, ai.cache, ai.callAi)
  const converted = new Map(resolveRows(drafts, ai.cache).flatMap((r) => Object.entries(r.cells).map(([f, c]) => [editKey(r.key, f), c] as const)))

  for (const { rowKey, row, column, rowQs, answer, unchanged } of columns) {
    if (!answer) {
      report.unanswered.push(...rowQs)
      continue
    }
    if (unchanged) {
      applyColumn(report, rowKey, rowQs.map((q) => kept(row, q)), [], answer)
      continue
    }
    const parsed = readColumn(column, answer, addresses, (f) => converted.get(editKey(rowKey, f)))
    if (!parsed.ok) {
      for (const q of rowQs) report.invalid.push({ inquiry: q, answer, message: parsed.message })
      continue
    }
    /** 聞いていない項目の書き換え。読んだ値が今の値の頭だけ（住所を市区町村までに縮めて読んだ）なら書き換えではない */
    const unasked = column.fields.flatMap((field) => {
      const value = parsed.values[field]
      const was = row.cells[field].value
      return !value || rowQs.some((q) => q.field === field) || was.startsWith(value) ? [] : [{ rowKey, field, was, answer: value }]
    })
    applyColumn(report, rowKey, rowQs.map((q) => answered(row, q, parsed.values[q.field] ?? "", answer, parsed.notes?.[q.field])), unasked, answer)
  }
}

/** AI が顧客の回答から読める項目（記入用Excelに記入の欄がある項目）。工事場所は都道府県・場所名のどちらで送っても1つの欄として読む */
export const ANSWER_FIELDS = SHEET_COLUMNS.flatMap((c) => (c.parse ? c.fields : [])) as [KojiFieldId, ...KojiFieldId[]]

/**
 * AI が顧客の回答（メールの本文・別の形のファイル・記入用Excelの決まった欄の外）から読んだ1項目。answer は項目の値として読める形の顧客の答え
 * （年月は「2024年4月」、工事場所は都道府県から市区町村まで、氏名・会社名は書いたまま）。confirm は「今の値のとおり」という答え
 */
export type AiAnswer = { rowKey: string; field: KojiFieldId } & ({ answer: string; confirm?: undefined } | { confirm: true; answer?: undefined })

/**
 * AI が読んだ顧客の回答を、記入用Excelの記入と同じ決まり（answerColumns）で項目の値にする。照合は今の値と比べる（rows は今の全行）。
 * 聞いている項目（askReasonOf）への答えはその問い合わせへの回答、聞いていない項目の答え（顧客からの訂正）は値が今と違えば変更にする。
 * 同じ欄に2つの答え（同じ項目に違う答え）があれば、どちらも読まない（invalid）
 */
export async function readAiAnswers(items: readonly AiAnswer[], rows: readonly KojiRow[], ai: AnswerAi): Promise<AnswerReport> {
  const report = emptyReport()
  const now = new Map(rows.map((r) => [r.key, r]))
  const read: ColumnAnswer[] = []
  for (const [, list] of groupBy(items, (i) => `${i.rowKey}\t${columnOf(i.field)!.header}`)) {
    const { rowKey } = list[0]!
    const row = now.get(rowKey)
    if (!row) {
      report.unknownKeys.push(rowKey)
      continue
    }
    const column = columnOf(list[0]!.field)!
    const asked = column.fields.flatMap((field): CellInquiry[] => {
      const reason = askReasonOf(field, row.cells[field])
      return reason ? [{ kind: "cell", rowKey, field, reason, current: storedOf(row.cells[field]) }] : []
    })
    // 聞いていない欄への答えは、その欄の項目すべてを照合する（今と同じ値なら変えない）
    const rowQs = asked.length ? asked : column.fields.map((field): CellInquiry => ({ kind: "cell", rowKey, field, reason: "needsReview", current: storedOf(row.cells[field]) }))
    const shown = column.show(row)
    const answers = [...new Set(list.map((i) => (i.confirm ? shown : i.answer.trim())))]
    // 工事場所は都道府県と場所名を別に送ってもよい（つなげて1つの住所として読む）
    const joined = column.fields.length > 1 && list.length === column.fields.length && new Set(list.map((i) => i.field)).size === list.length && !list.some((i) => i.confirm)
    const answer = joined ? column.fields.map((f) => list.find((i) => i.field === f)!.answer!.trim()).join("") : answers.length === 1 ? answers[0]! : null
    if (answer === null) {
      for (const q of rowQs) report.invalid.push({ inquiry: q, answer: answers.join(" / "), message: "同じ欄に違う答えが2つあります" })
      continue
    }
    read.push({ rowKey, row, column, rowQs, answer, shown })
  }
  await answerColumns(report, read, rows, ai)
  return report
}

/**
 * 記入用Excelの、決まった欄（管理番号・照合用と記入の欄の見出しの列）の外にある記入の数（別の列・別のシートに書いた答え）。
 * 決まった欄で読めなかった答えを AI に読ませるかを決める（readAnswers は決まった欄だけを読む）
 */
export function outsideCells(sheets: readonly SheetGrid[]): number {
  const known = new Set([ASKED_HEADER, ...SHEET_COLUMNS.map((c) => c.header)])
  let n = 0
  let found = false
  for (const s of sheets) {
    const headerRow = found ? -1 : s.rows.findIndex((r) => r.some((c) => c.trim() === MANAGEMENT_HEADER))
    if (headerRow < 0) {
      n += s.rows.reduce((k, r) => k + r.filter((c) => c.trim()).length, 0)
      continue
    }
    found = true
    const header = s.rows[headerRow]!.map((c) => c.trim())
    for (const r of s.rows.slice(headerRow + 1)) r.forEach((c, i) => c.trim() && !known.has(header[i] ?? "") && n++)
  }
  return n
}

/** AI が姓と名を区切った氏名（自信があってもなくても）。同じ案件の表記として、ほかの記入の区切りには使わない */
const splitByAi = (c: CellResult) => c.byAi === true

type EditNote = Pick<CellEdit, "status" | "message" | "guessed" | "byAi">

/** 欄の記入を項目の値にする。変換のある欄は変換の結果（AI の判断待ちが解けたもの）を使い、要確認ならその旨を notes に残す */
function readColumn(column: SheetColumn, answer: string, addresses: AddressBook, convertedOf: (f: KojiFieldId) => CellResult | undefined): Parsed & { notes?: Partial<Record<KojiFieldId, EditNote>> } {
  if (!column.transform) return column.parse!(answer, addresses)
  const field = column.fields[0]!
  const cell = convertedOf(field)!
  if (cell.status === "error") return { ok: false, message: cell.message ?? `${fieldLabel(field)}を変換できません` }
  const note: EditNote | undefined =
    cell.status === "ai" || cell.status === "warning"
      ? { status: cell.status, ...(cell.message ? { message: cell.message } : {}), ...(cell.guessed ? { guessed: true } : {}), ...(cell.byAi ? { byAi: true } : {}) }
      : undefined
  return { ok: true, values: { [field]: cell.value }, ...(note ? { notes: { [field]: note } } : {}) }
}

/** 聞いた1項目の回答の扱い。changed・invalid があると、同じ欄のほかの項目も反映しない */
type Outcome =
  | { kind: "edit"; q: CellInquiry; value: string; note?: EditNote }
  | { kind: "confirmed"; q: CellInquiry; value: string }
  | { kind: "unanswered" | "alreadyApplied"; q: CellInquiry }
  | { kind: "changed"; q: CellInquiry; now: string; answer: string }
  | { kind: "invalid"; q: CellInquiry; answer: string; message: string }

/** 送った値のまま返ってきた項目 */
function kept(row: KojiRow, q: CellInquiry): Outcome {
  const now = row.cells[q.field]
  if (q.reason === "missing") return { kind: "unanswered", q }
  if (storedOf(now) !== q.current) return { kind: "changed", q, now: storedOf(now), answer: q.current }
  return now.guessed ? { kind: "confirmed", q, value: q.current } : { kind: "alreadyApplied", q }
}

/** 書き換えられた欄の、聞いた1項目（value は記入を読んだ値。個人名は印のまま） */
function answered(row: KojiRow, q: CellInquiry, value: string, answer: string, note?: EditNote): Outcome {
  const now = storedOf(row.cells[q.field])
  if (!value) return { kind: "invalid", q, answer, message: `${fieldLabel(q.field)}を読み取れません` }
  if (value === q.current) return kept(row, q)
  if (value === now) return { kind: "alreadyApplied", q }
  if (now !== q.current) return { kind: "changed", q, now, answer: value }
  return { kind: "edit", q, value, ...(note ? { note } : {}) }
}

/**
 * 1つの欄（工事場所なら都道府県と場所名）の回答をまとめて反映する。
 * どれか1項目でも反映できない（送ったあとに変わった・読めない）なら、同じ欄のほかの項目も反映せず heldBack で知らせる。
 */
function applyColumn(report: AnswerReport, rowKey: string, outcomes: Outcome[], unasked: AnswerReport["alsoChanged"], answer: string) {
  type Write = { field: KojiFieldId; edit: CellEdit }
  const writes: Write[] = [
    ...outcomes.flatMap((o): Write[] => {
      if (o.kind === "edit") return [{ field: o.q.field, edit: { value: o.value, by: "customer", ...o.note } }]
      if (o.kind === "confirmed") return [{ field: o.q.field, edit: { value: o.value, by: "confirmed" } }]
      return []
    }),
    ...unasked.map((c): Write => ({ field: c.field, edit: { value: c.answer, by: "customer" } })),
  ]
  const rejected = outcomes.some((o) => o.kind === "changed" || o.kind === "invalid")
  for (const o of outcomes) {
    if (o.kind === "changed") report.changed.push({ rowKey: o.q.rowKey, field: o.q.field, now: o.now, answer: o.answer })
    else if (o.kind === "invalid") report.invalid.push({ inquiry: o.q, answer: o.answer, message: o.message })
    else if (rejected) continue
    else if (o.kind === "unanswered") report.unanswered.push(o.q)
    else if (o.kind === "alreadyApplied") report.alreadyApplied.push(o.q)
    else if (o.kind === "confirmed") report.confirmed.push(o.q)
    else if (o.kind === "edit") report.applied.push(o.q)
  }
  if (rejected) {
    report.heldBack.push(...writes.map((w) => ({ rowKey, field: w.field, answer: w.edit.value })))
    return
  }
  for (const { field, edit } of writes) {
    report.edits.push([editKey(rowKey, field), edit])
    if (edit.status === "warning") report.needsCheck.push({ rowKey, field, answer, message: edit.message ?? "要確認" })
  }
  report.alsoChanged.push(...unasked)
}

/** 送ったときの行: 聞いた項目は送ったときの値に戻す（同じ欄の聞いていない項目は今の値） */
function asSent(row: KojiRow, qs: readonly CellInquiry[]): KojiRow {
  const cells = { ...row.cells }
  for (const q of qs) {
    const { stored: _, ...cell } = cells[q.field]
    cells[q.field] = { ...cell, value: q.current }
  }
  return { ...row, cells }
}

/** 記入が、送ったときに欄に表示していた内容のまま（書式の違いは問わない） */
function untouched(parse: NonNullable<SheetColumn["parse"]>, answer: string, shown: string, addresses: AddressBook) {
  if (!shown) return false
  if (answer === shown) return true
  const a = parse(answer, addresses)
  const b = parse(shown, addresses)
  return a.ok && b.ok && JSON.stringify(a.values) === JSON.stringify(b.values)
}

/**
 * 取り込んだ回答を、今の変換の結果・一括置換・手直し（now）に重ねる。回答は読み始めたときの行（against）と照合しているので、
 * 読んでいる間（AI の待ち）にセルの値が変わっていたら（職員の手直し・一括置換・変換のやり直しなど、何で変わっても）、
 * その回答は反映せず changed に回す。比べるのは個人名を印にした値（記号は付け直されるので比べない）。
 * 工事場所は都道府県と場所名を一緒に反映するので、片方を回したら同じ欄のもう片方も heldBack に回す。
 */
export function mergeAnswers(
  report: AnswerReport,
  against: readonly KojiRow[],
  now: { rows: readonly KojiRow[]; replacements: Replacements<KojiFieldId>; edits: CellEdits },
): { edits: CellEdits; report: AnswerReport } {
  const fieldOf = (key: string) => {
    const at = key.lastIndexOf(":")
    return { rowKey: key.slice(0, at), field: key.slice(at + 1) as KojiFieldId }
  }
  const storedIn = (rows: readonly KojiRow[]) => {
    const byKey = new Map(rows.map((r) => [r.key, r]))
    return (key: string) => {
      const { rowKey, field } = fieldOf(key)
      const cell = byKey.get(rowKey)?.cells[field]
      return cell && storedOf(cell)
    }
  }
  const readAgainst = storedIn(against)
  /** applyEdits は行ごとに閉じているので、回答のある行だけ当てれば今の値が分かる */
  const answeredRows = new Set(report.edits.map(([key]) => fieldOf(key).rowKey))
  const current = storedIn(applyEdits(KOJI_KEIREKI, now.rows.filter((r) => answeredRows.has(r.key)), now))
  const conflicts = report.edits.filter(([key]) => readAgainst(key) !== current(key))
  const conflicted = new Set(conflicts.map(([key]) => key))
  const siblings = new Set(
    conflicts.flatMap(([key]) => {
      const { rowKey, field } = fieldOf(key)
      return (columnOf(field)?.fields ?? []).map((f) => editKey(rowKey, f)).filter((k) => k !== key && !conflicted.has(k))
    }),
  )
  const kept = (key: string) => !conflicted.has(key) && !siblings.has(key)
  const keptEdit = (rowKey: string, field: KojiFieldId) => kept(editKey(rowKey, field))
  const merged: AnswerReport = {
    ...report,
    edits: report.edits.filter(([key]) => kept(key)),
    applied: report.applied.filter((q) => keptEdit(q.rowKey, q.field)),
    confirmed: report.confirmed.filter((q) => keptEdit(q.rowKey, q.field)),
    alsoChanged: report.alsoChanged.filter((c) => keptEdit(c.rowKey, c.field)),
    needsCheck: report.needsCheck.filter((c) => keptEdit(c.rowKey, c.field)),
    changed: [...report.changed, ...conflicts.map(([key, edit]) => ({ ...fieldOf(key), now: current(key) ?? "", answer: edit.value }))],
    heldBack: [...report.heldBack, ...report.edits.filter(([key]) => siblings.has(key)).map(([key, edit]) => ({ ...fieldOf(key), answer: edit.value }))],
  }
  return { edits: new Map([...now.edits, ...merged.edits]), report: merged }
}

export const fieldLabel = (f: KojiFieldId) => KOJI_KEIREKI.fields.find((x) => x.id === f)!.label

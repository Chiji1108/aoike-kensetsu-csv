import type { CsvSpec } from "../spec/types"
import { MAX_ITEMS_PER_REQUEST, type AiBatchRequest, type AiItemResult, type AiTaskId } from "./ai-tasks"
import type { FieldSpec } from "../spec/types"
import { columnLetter, type FieldPlan, type FlagColumn, type MappingPlan, type SourceRow } from "./plan"
import { hasPersons, personLetters, readMarked, showPersons, type PersonLetters } from "./persons"
import { excludedReason, sourceKey } from "./sources"
import { getTransform, isFlagOn, knownNameSplits, normalizePersonName, WITHOUT_AI, type TransformContext, type TransformId } from "./transforms"
import { checkRow, checkValue } from "./validate"

export type CellStatus = "ok" | "changed" | "ai" | "warning" | "error"

export type CellResult = {
  value: string
  status: CellStatus
  /** 元データのどこから来た値か（例: 「C列: 山田太郎」「定数」「手入力」「顧客の回答」） */
  source: string
  /** 変換する前の元データの値（列をつないだときは空白でつなぐ。元データに無い・定数は空）。手直ししても残す */
  original: string
  message?: string
  /** AI の推定で、AI 自身も自信がないと答えた値（顧客に確かめる） */
  guessed?: true
  /** AI の結果で決めた値（検証で status が warning・error に変わっても残る出どころ） */
  byAi?: true
  /**
   * finalizeRows が個人名の印を記号（Ａ・Ｂ…）にしたときの、置き換える前の値（印入り。persons.ts）。
   * value は記号にした値（画面・CSV）。CSV には出さない
   */
  stored?: string
  /** 元データに値はあるが、出さなかった（匿名化の検算に落ちた・AI を使えず空にした）。職員が直す（顧客には聞かない） */
  withheld?: true
  /** 手直し（applyEdits の edits）で入れた値なら、誰が入れたか */
  by?: CellEdit["by"]
  /** 職員が顧客に聞くと決めた（チャットの問い合わせの変更案の承認）。空でも聞く */
  ask?: true
}

/** 出力行の元。flagColumns で1行を複数に分けたときは同じ元を持つ行が複数できる */
export type RowOrigin = {
  /** 出力行の識別子（元の行＋分けたときのコード）。手直し・選択の鍵 */
  key: string
  sheet: string
  row: number
  /** 計画の rowFilter で出力しない理由 */
  excluded?: string
}

export type RowResult<F extends string> = RowOrigin & { cells: Record<F, CellResult> }

/** AI の判断待ちのセル。AI の結果（または使えなかった理由）が揃うと CellResult になる */
type PendingCell = { kind: "ai"; transform: TransformId; raw: string; source: string; original: string; instruction?: string; reason: string }
export type CellDraft = { kind: "done"; cell: CellResult } | PendingCell
export type RowDraft<F extends string> = RowOrigin & { cells: Record<F, CellDraft> }

/** AI の結果の置き場所。キーは aiKey()。失敗したときは理由を入れる */
export type AiResultStore = ReadonlyMap<string, AiItemResult | { error: string }>

export function aiKey(task: AiTaskId, instruction: string | undefined, input: string) {
  return JSON.stringify([task, instruction ?? "", input])
}

const done = (cell: CellResult): CellDraft => ({ kind: "done", cell })

type CellPlan = Exclude<FieldPlan, { kind: "flagColumns" }>

function convertCell(plan: CellPlan, row: string[], ctx: TransformContext): CellDraft {
  if (plan.kind === "missing") return done({ value: "", status: "ok", source: "元データに無い", original: "" })
  if (plan.kind === "constant") return done({ value: plan.value, status: "changed", source: "定数", original: "", message: plan.reason })

  const columns = plan.kind === "column" ? [plan.column] : plan.columns
  const inputs = columns.map((c) => row[c] ?? "")
  const raw = inputs.map((s) => s.trim()).filter(Boolean).join(" ")
  return transformCell(plan.transform, inputs, columns.map((c) => columnLetter(c)).join("+") + "列: " + raw, ctx, plan.instruction)
}

/**
 * 値を変換の登録表で変換する（ルール → 決まらなければ AI 待ち）。元データの列の値も、顧客の回答もここを通す。
 * source はセルに残す出どころ（例: 「C列: 山田太郎」「顧客の回答」）。
 */
export function transformCell(id: TransformId, inputs: string[], source: string, ctx: TransformContext, instruction?: string): CellDraft {
  const raw = inputs.map((s) => s.trim()).filter(Boolean).join(" ")
  if (!raw) return done({ value: "", status: "ok", source, original: raw })
  const transform = getTransform(id)
  const out = transform.run(inputs, ctx)
  switch (out.kind) {
    case "value":
      return done({
        value: out.value,
        status: out.warning ? "warning" : out.value === raw ? "ok" : "changed",
        source,
        original: raw,
        message: out.message,
      })
    case "error":
      return done({ value: raw, status: "error", source, original: raw, message: out.message })
    case "ai": {
      const input = transform.ai?.input?.(inputs) ?? raw
      return { kind: "ai", transform: id, raw: input, source, original: raw, instruction, reason: out.reason }
    }
  }
}

/** 記号のある列ごとのセル（記号が無ければ空） */
function flagCells(columns: FlagColumn[], row: string[]): CellResult[] {
  return columns
    .filter((c) => isFlagOn(row[c.column] ?? ""))
    .map((c) => {
      const original = row[c.column]!.trim()
      return { value: c.code, status: "changed", source: `${columnLetter(c.column)}列: ${original}`, original, message: "記号の列から" }
    })
}

/**
 * ルールで変換する。決まらなかったセルは AI 待ちとして残る。
 * flagColumns の項目は記号のある列ごとに行を分け、記号が1つも無い元の行は出力しない。
 */
export function convertRows<F extends string>(
  spec: CsvSpec<F>,
  sources: readonly SourceRow[],
  plan: MappingPlan<F>,
  rules: TransformContext,
): RowDraft<F>[] {
  const ctx = { ...rules, knownNames: knownNameSplits(sourceNames(spec, sources, plan)) }
  const drafts: RowDraft<F>[] = []
  for (const src of sources) {
    const base = {} as Record<F, CellDraft>
    for (const f of spec.fields) {
      const p = plan.fields[f.id]
      if (p.kind !== "flagColumns") base[f.id] = convertCell(p, src.cells, ctx)
    }
    let variants: { suffix: string[]; cells: Record<F, CellDraft> }[] = [{ suffix: [], cells: base }]
    for (const f of spec.fields) {
      const p = plan.fields[f.id]
      if (p.kind !== "flagColumns") continue
      const options = flagCells(p.columns, src.cells)
      variants = variants.flatMap((v) => options.map((cell) => ({ suffix: [...v.suffix, cell.value], cells: { ...v.cells, [f.id]: done(cell) } })))
    }
    const excluded = excludedReason(src, plan.rowFilter)
    for (const v of variants) {
      const key = [sourceKey(src), ...v.suffix].join("#")
      drafts.push({ key, sheet: src.sheet, row: src.row, ...(excluded ? { excluded } : {}), cells: v.cells })
    }
  }
  return drafts
}

/** 氏名の項目に使う列の、元データの値（列を分けた姓・名は空白でつなぐ） */
function* sourceNames<F extends string>(spec: CsvSpec<F>, sources: readonly SourceRow[], plan: MappingPlan<F>) {
  for (const f of spec.fields) {
    const p = plan.fields[f.id]
    if (f.valueType.type !== "personName" || (p.kind !== "column" && p.kind !== "columns")) continue
    const columns = p.kind === "column" ? [p.column] : p.columns
    for (const src of sources) yield columns.map((c) => src.cells[c] ?? "").join(" ")
  }
}

function pendingTask(p: PendingCell) {
  return getTransform(p.transform).ai!.task
}

/** AI に送る依頼。値は重複を除き、まだ結果が無いもの（前に失敗したものは送り直す）だけを最大100件ずつにまとめる */
export function collectAiBatches<F extends string>(
  drafts: RowDraft<F>[],
  store: AiResultStore,
): { request: AiBatchRequest; keys: string[] }[] {
  const groups = new Map<string, { task: AiTaskId; instruction?: string; inputs: Map<string, string> }>()
  for (const d of drafts) {
    for (const cell of Object.values<CellDraft>(d.cells)) {
      if (cell.kind !== "ai") continue
      const task = pendingTask(cell)
      const key = aiKey(task, cell.instruction, cell.raw)
      const known = store.get(key)
      if (known && !("error" in known)) continue
      const groupKey = JSON.stringify([task, cell.instruction ?? ""])
      const g = groups.get(groupKey) ?? { task, instruction: cell.instruction, inputs: new Map() }
      g.inputs.set(key, cell.raw)
      groups.set(groupKey, g)
    }
  }
  const batches: { request: AiBatchRequest; keys: string[] }[] = []
  for (const g of groups.values()) {
    const entries = [...g.inputs]
    for (let i = 0; i < entries.length; i += MAX_ITEMS_PER_REQUEST) {
      const chunk = entries.slice(i, i + MAX_ITEMS_PER_REQUEST)
      batches.push({
        request: {
          task: g.task,
          ...(g.instruction ? { instruction: g.instruction } : {}),
          items: chunk.map(([, input], id) => ({ id, input })),
        },
        keys: chunk.map(([key]) => key),
      })
    }
  }
  return batches
}

/** AI 待ちのセルを結果で埋める（検算は各変換の ai.apply）。結果が無いセルは各変換の ai.withoutAi で決める */
export function resolveRows<F extends string>(drafts: RowDraft<F>[], store: AiResultStore): RowResult<F>[] {
  return drafts.map(({ cells: draftCells, ...origin }) => {
    const cells = {} as Record<F, CellResult>
    for (const [id, cell] of Object.entries(draftCells) as [F, CellDraft][]) {
      if (cell.kind === "done") {
        cells[id] = cell.cell
        continue
      }
      const step = getTransform(cell.transform).ai!
      const result = store.get(aiKey(step.task, cell.instruction, cell.raw))
      if (result && !("error" in result)) {
        cells[id] = { ...step.apply(cell.raw, result), source: cell.source, original: cell.original, byAi: true }
      } else {
        cells[id] = { ...WITHOUT_AI[step.withoutAi](cell.raw, { reason: cell.reason, error: result?.error ?? "未実行" }), source: cell.source, original: cell.original }
      }
    }
    return { ...origin, cells }
  })
}

/**
 * 職員の手直し、問い合わせへの顧客の回答、推定の値を顧客がそのまま返した（確認した）、またはチャットの変更案を職員が承認した。
 * value の個人名は印のまま（記号は finalizeRows が付ける）。
 * status と message は、顧客の回答を変換（個人名の匿名化など）した結果が AI・要確認のとき、職員の手直しの記号が読めないとき（error）に持つ。
 */
export type CellEdit = {
  value: string
  by: "staff" | "customer" | "confirmed" | "chat" | "excel" | "location"
  status?: "ai" | "warning" | "error"
  message?: string
  guessed?: true
  /** 顧客の回答を AI の結果で変換した */
  byAi?: true
  /** 顧客に聞くと決めた（CellResult.ask） */
  ask?: true
}
export type CellEdits = ReadonlyMap<string, CellEdit>

const EDITED: Record<CellEdit["by"], Pick<CellResult, "source" | "message">> = {
  staff: { source: "手入力" },
  customer: { source: "顧客の回答", message: "顧客の回答" },
  confirmed: { source: "顧客が確認", message: "顧客が確認" },
  chat: { source: "チャット（承認）" },
  excel: { source: "Excel（承認）" },
  location: { source: "場所の調査（承認）" },
}

/** 職員が画面で直した値。「〔Ａ〕」は今の記号の表（personLettersOf）でその人に戻し、表に無い記号ならエラーのまま残す */
export function staffEdit(text: string, letters: PersonLetters): CellEdit {
  const read = readMarked(text, letters)
  return read.ok ? { value: read.value, by: "staff" } : { value: text, by: "staff", status: "error", message: read.message }
}

/** 手直しで直す元の文字列（個人名は「〔Ａ〕」の形） */
export function editText(cell: CellResult, letters: PersonLetters) {
  return cell.stored === undefined ? cell.value : showPersons(cell.stored, letters, true)
}

/**
 * セルの手直しの1回分。開いたときの記号の表で「〔Ａ〕」の形に書き、確定した文字列も同じ表で読む
 * （開いている間に行の入れ外しなどで記号が付け直されても、別の人にならない）
 */
export type EditSession = { text: string; read: (draft: string) => CellEdit }

export function editSession(cell: CellResult, letters: PersonLetters): EditSession {
  return { text: editText(cell, letters), read: (draft) => staffEdit(draft, letters) }
}

export function editKey(rowKey: string, field: string) {
  return `${rowKey}:${field}`
}

/** 列ごとの一括置換（変換後の値 → 置換先）。置換先は職員の手直しと同じく staffEdit で読んだもの（「〔Ａ〕」はその人） */
export type Replacements<F extends string> = Partial<Record<F, Readonly<Record<string, CellEdit>>>>

/** 置換先も列の型に合わせて整える（氏名は姓と名の間を全角スペースに） */
function normalizeReplacement(field: FieldSpec, v: string) {
  return field.valueType.type === "personName" ? normalizePersonName(v) : v.trim()
}

/**
 * 一括置換 → 職員の手直し → 空欄を埋める（fillRules・whenMissing）。行ごとに閉じた処理（ほかの行を見ない）。
 * 個人名は印のまま、検証もまだ（記号と検証は finalizeRows。どの行を CSV に書くかはこの結果から選ぶ）。
 */
export function applyEdits<F extends string>(
  spec: CsvSpec<F>,
  rows: readonly RowResult<F>[],
  { replacements, edits }: { replacements: Replacements<F>; edits: CellEdits },
): RowResult<F>[] {
  return rows.map((row) => {
    const cells = { ...row.cells }
    const edited = new Set<F>()
    for (const f of spec.fields) {
      const to = replacements[f.id]?.[cells[f.id].value]
      if (to !== undefined) {
        const { guessed: _, byAi: __, ...cell } = cells[f.id]
        cells[f.id] = { ...cell, value: normalizeReplacement(f, to.value), status: to.status ?? "changed", message: ["一括置換", to.message].filter(Boolean).join(": ") }
      }
      const edit = edits.get(editKey(row.key, f.id))
      if (edit) {
        const { source, message } = EDITED[edit.by]
        const note = [message, edit.message].filter(Boolean).join(": ")
        cells[f.id] = {
          value: edit.value,
          status: edit.status ?? "changed",
          source,
          original: cells[f.id].original,
          by: edit.by,
          ...(note ? { message: note } : {}),
          ...(edit.guessed ? { guessed: true } : {}),
          ...(edit.ask ? { ask: true } : {}),
          ...(edit.byAi ? { byAi: true } : {}),
        }
        edited.add(f.id)
      }
    }
    for (const rule of spec.fillRules) {
      const values = Object.fromEntries(spec.fields.map((f) => [f.id, cells[f.id].value])) as Record<F, string>
      const open = new Set(rule.fields.filter((id) => values[id] === "" && !edited.has(id)))
      const filled = rule.fill(values, open)
      for (const [id, value] of Object.entries(filled?.values ?? {}) as [F, string][]) {
        if (open.has(id)) cells[id] = { ...cells[id], value, status: filled!.review ? "warning" : "changed", message: filled!.reason, ...(filled!.review ? { guessed: true as const } : {}) }
      }
    }
    for (const f of spec.fields) {
      if (f.whenMissing && cells[f.id].value === "" && !edited.has(f.id)) cells[f.id] = { ...cells[f.id], value: f.whenMissing.value, status: "changed", message: f.whenMissing.reason }
    }
    return { ...row, cells }
  })
}

/**
 * 個人名の記号 → 列ごと・行ごとの検証。rows は applyEdits の結果を CSV（画面）の順に並べたもの。
 * 記号は CSV に書く行（exported）だけから CSV の順に付ける（Ａ から欠けなく）。
 * 載せない行・置換の元の値（original）・一括置換の置換先にだけいる人は、画面では「〔未掲載１〕」の形にする（personLetters）。
 * 返す letters はその表（手直し・置換先の「〔Ａ〕」をその人に戻すのに使う）。
 */
export function finalizeRows<F extends string>(
  spec: CsvSpec<F>,
  rows: readonly RowResult<F>[],
  { exported, original = [], replacements = {} }: { exported: (row: RowResult<F>) => boolean; original?: readonly RowResult<F>[]; replacements?: Replacements<F> },
): { rows: RowResult<F>[]; letters: PersonLetters } {
  const valuesOf = function* (rs: readonly RowResult<F>[]) {
    for (const r of rs) for (const f of spec.fields) yield r.cells[f.id].value
  }
  const replacedTo = Object.values<Readonly<Record<string, CellEdit>> | undefined>(replacements).flatMap((table) => Object.values(table ?? {}).map((e) => e.value))
  const letters = personLetters(valuesOf(rows.filter(exported)), [...valuesOf(rows), ...valuesOf(original), ...replacedTo])
  const finalized = rows.map((row) => {
    const cells = { ...row.cells }
    for (const f of spec.fields) {
      const stored = cells[f.id]
      const cell = hasPersons(stored.value) ? { ...stored, value: showPersons(stored.value, letters), stored: stored.value } : stored
      cells[f.id] = withIssue(cell, checkValue(f, cell.value))
    }
    const values = Object.fromEntries(spec.fields.map((f) => [f.id, cells[f.id].value])) as Record<F, string>
    for (const [id, issue] of checkRow(spec, values)) cells[id] = withIssue(cells[id], issue)
    return { ...row, cells }
  })
  return { rows: finalized, letters }
}

function withIssue(cell: CellResult, issue: ReturnType<typeof checkValue>): CellResult {
  if (!issue) return cell
  const message = [cell.message, issue.message].filter(Boolean).join(" / ")
  if (issue.severity === "error") return { ...cell, status: "error", message }
  return { ...cell, status: cell.status === "error" ? "error" : "warning", message }
}

export function countByStatus<F extends string>(rows: RowResult<F>[]) {
  const counts: Record<CellStatus, number> = { ok: 0, changed: 0, ai: 0, warning: 0, error: 0 }
  for (const r of rows) for (const c of Object.values<CellResult>(r.cells)) counts[c.status]++
  return counts
}

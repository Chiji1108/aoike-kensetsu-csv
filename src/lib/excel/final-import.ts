import { MAX_ADDED_ROWS } from "../cases/added"
import type { TableView } from "../cases/view"
import type { ChatChange } from "../chat/proposals"
import { addressKey, NO_ADDRESSES, type AddressLookup } from "../convert/address"
import { resolveRows, transformCell, type CellDraft, type CellEdit, type CellResult, type RowDraft } from "../convert/convert"
import { personKey, withNames } from "../convert/persons"
import { fillAiCache, type AiCache, type AiCaller } from "../convert/pipeline"
import type { SheetGrid } from "../convert/plan"
import { collapseSpaces } from "../convert/text"
import { normalizePersonName, type Rounding, type TransformId } from "../convert/transforms"
import { groupBy } from "../group-by"
import { leadingPrefecture, type Prefecture } from "../spec/prefectures"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import { CHECK_SHEET_NAME, FINAL_SHEET_NAME, keyMark, MARK_RE, NUMERIC_FIELDS, personHash, readCheckSheet, toHex, type FinalCheck } from "./final-sheet"

/**
 * 直した最後の Excel を上げ直したときの取り込み。照合用の隠しシートのダウンロードしたときの値と、データのシートの今の値を比べ、
 * 職員が直したセルを変更案（出どころ excel）にする。
 * - 行は中身で対応させる（職員が行を足した・消した・並べ替えたときも）。同じ中身の行 → 14列のうち MATCH_FIELDS 列以上が同じで、
 *   互いにいちばん近い行、の順に当てる。決めきれない行（近い行が2つ以上・CANDIDATE_FIELDS 列以上が同じだが当てるほどは近くない）は
 *   黙って当てず ambiguous に出す（その候補の行は「載せない」にもしない）。ダウンロードした行が1つも見つからなければ（別のシートを上げたなど）読まない
 * - 当たらなかった今の行は足した工事、当たらなかったダウンロードした行は「載せない」の変更案
 * - 値は CSV の値（匿名化のあと・業種などのコード・千円・YYYYMM）なので、変換と同じ決まった処理で表の値に直す。記号（Ａ・Ｂ…）は
 *   そのまま匿名化の値として、照合用のハッシュでその人に戻す。注文者・工事名に書いた実名は変換と同じ匿名化に通す（確かめられなければ取り込まない）
 * - ダウンロードしたあとに表のその値が変わっていたら、黙って上書きせず食い違い（conflicts）に出す
 */

type F = KojiFieldId
const FIELDS = KOJI_KEIREKI.fields

/** 1つの Excel の変更案に入れられる項目の数（R2 の記録と画面の一覧が重くなりすぎないように） */
export const MAX_EXCEL_CHANGES = 20_000
/** ダウンロードした行と今の行を同じ工事とみなす、同じ値の列の数（14列のうち。3列までの手直しは同じ工事） */
export const MATCH_FIELDS = 11
/** 同じ工事かもしれない（決めきれない）とする、同じ値の列の数 */
export const CANDIDATE_FIELDS = 8
/** 候補を探す列。CANDIDATE_FIELDS 列以上が同じなら、違う列は6列までなので、この7列のどれかは必ず同じ */
const INDEX_FIELDS: readonly F[] = ["client", "workName", "place", "engineer", "amount", "startYm", "endYm"]
/** 数値の列の値は、Excel の書式の桁区切り・空白を除いて比べる（「1,234」と「1234」は同じ） */
const comparable = (values: readonly string[]) => values.map((v, c) => (NUMERIC_FIELDS.has(FIELDS[c]!.id) ? v.replace(/[,，\s　]/g, "") : v))

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

export type FinalReport = {
  /** 変更案にしたセル・足した行・載せないにした行の数 */
  cells: number
  added: number
  excluded: number
  /** もう表にある（前に上げて承認した）ので足さなかった行 */
  alreadyAdded: number
  /** ダウンロードしたあとに表のその値が変わっていた（職員の手直しを上書きしないので、変更案にしない）。値は CSV の値（記号） */
  conflicts: { line: number; field: F; sent: string; now: string; uploaded: string }[]
  /** 開いている・却下した直した Excel の変更案と同じなので除いた項目の数（画面が withoutKnown で数える） */
  skipped?: number
  /** N列より右に値のある行。取り込まない（「CSV で保存」すると CSV にも出る） */
  extraColumns: number[]
  /** 読めない値（業種・年月など）。変更案にしない */
  invalid: { line: number; field: F; value: string; message: string }[]
  /** 個人名かもしれないのに匿名化を確かめられなかった値。変更案にしない */
  refused: { line: number; field: F; value: string; message: string }[]
  /** どの工事を直したのか決めきれなかった行（候補が2つ以上）。取り込まない */
  ambiguous: { line: number; candidates: number }[]
  /** 決めきれない行の候補なので「載せない」にしなかった、ダウンロードした行の数 */
  keptRows: number
  /** 今の表に無い行（ダウンロードしたあとに足した行を消したなど）の数 */
  unknownRows: number
}

/** lookup は場所名に書いた住所を引く（変換と同じ分け方。address.ts） */
export type FinalAi = { rounding: Rounding; cache: AiCache; callAi?: AiCaller; lookup: AddressLookup }

/** 最後の Excel の照合用の隠しシートを読む。無ければ null（この画面でダウンロードした最後の Excel ではない） */
export function finalCheckOf(sheets: readonly SheetGrid[]): FinalCheck | { error: string } | null {
  const sheet = sheets.find((s) => s.name === CHECK_SHEET_NAME)
  return sheet ? (readCheckSheet(sheet.rows) ?? { error: "照合用のシートが書き換えられていて読めません" }) : null
}

type Cell = { line: number; rowKey: string; field: F; value: string; /** ダウンロードしたときにこのセルにあった、人ではない記号の形の文字（「Ｋ建設」の Ｋ） */ literal: ReadonlySet<string> }

const unmark = (marked: string) => marked.replace(MARK_RE, "$1")
const ALNUM = "Ａ-Ｚａ-ｚA-Za-z０-９0-9"
/** 記号の形の文字（前後が英数字でない Ａ・Ｂ２…） */
const LETTER_RE = new RegExp(`(?<![${ALNUM}])([Ａ-Ｚ][０-９]*)(?![${ALNUM}])`, "g")
/** ダウンロードしたときの値のうち、人の記号ではない記号の形の文字 */
const literalIn = (marked: string) => {
  const persons = new Set([...marked.matchAll(MARK_RE)].map((m) => m[1]!))
  return new Set([...marked.replace(MARK_RE, "").matchAll(LETTER_RE)].map((m) => m[1]!).filter((l) => !persons.has(l)))
}
/** 値を比べる形（人の印の中の氏名は空白を除いて比べる） */
const comparableValue = (v: string) => withNames(v, (name) => `\u0000${personKey(name)}\u0000`)

/** 変更案の項目の印（同じ Excel を上げ直したときに、前に出した・却下した項目と同じかを見る） */
export function changeSignature(c: ChatChange): string {
  if (c.kind === "cell") return JSON.stringify(["cell", c.rowKey, c.field, comparableValue(c.edit.value)])
  if (c.kind === "include") return JSON.stringify(["include", c.rowKey, c.include])
  if (c.kind === "add") return JSON.stringify(["add", c.rowKey])
  return JSON.stringify([c.kind, c])
}

/** known の項目を除く。足す行を除いたら、その行を載せる項目も除く */
export function withoutKnown(changes: readonly ChatChange[], known: ReadonlySet<string>) {
  const droppedAdds = new Set(changes.flatMap((c) => (c.kind === "add" && known.has(changeSignature(c)) ? [c.rowKey] : [])))
  const kept = changes.filter((c) => !known.has(changeSignature(c)) && !(c.kind === "include" && c.include && droppedAdds.has(c.rowKey)))
  return { changes: kept, skipped: changes.length - kept.length }
}

/** 除いたあとの件数で報告を数え直す */
export function recount(report: FinalReport, changes: readonly ChatChange[], skipped: number): FinalReport {
  const n = (k: ChatChange["kind"], f: (c: ChatChange) => boolean = () => true) => changes.filter((c) => c.kind === k && f(c)).length
  return { ...report, cells: n("cell"), added: n("add"), excluded: n("include", (c) => c.kind === "include" && !c.include), ...(skipped ? { skipped } : {}) }
}

/**
 * 上げ直した最後の Excel を、今の表（view）との差分の変更案にする。id は今の案件と変換の元（別の案件・元を変えたあとの Excel は読まない）
 */
export async function readFinalSheet(
  sheets: readonly SheetGrid[],
  view: TableView,
  id: { caseId: string; sourceFileId: string | null; excelKey: string },
  ai: FinalAi,
): Promise<{ changes: ChatChange[]; report: FinalReport } | { error: string }> {
  const check = finalCheckOf(sheets)
  if (!check) return { error: "照合用のシートがありません。この画面の「書き出す」でダウンロードした Excel を直してアップロードしてください" }
  if ("error" in check) return check
  if (check.meta.caseId !== id.caseId) return { error: "別の案件でダウンロードした Excel です" }
  if (check.meta.sourceFileId !== id.sourceFileId) return { error: "ダウンロードしたあとに変換の元のファイルが変わったので、この Excel は表に戻せません。書き出し直してから直してください" }
  if (check.meta.keyMark !== (await keyMark(id.excelKey, id.caseId))) return { error: "この Excel の記録と合いません。書き出し直してから直してください" }
  const data = sheets.find((s) => s.name === FINAL_SHEET_NAME) ?? sheets.find((s) => s.name !== CHECK_SHEET_NAME)
  if (!data) return { error: "データのシートがありません" }
  const extraColumns = data.rows.flatMap((r, i) => (r.slice(FIELDS.length).some(Boolean) ? [i + 1] : []))
  const uploaded = data.rows.flatMap((r, i) => {
    const values = FIELDS.map((_, c) => (r[c] ?? "").trim())
    return values.some(Boolean) ? [{ line: i + 1, values }] : []
  })
  if (uploaded.length > MAX_EXCEL_CHANGES) return { error: `行が ${uploaded.length} 行あります。取り込めるのは ${MAX_EXCEL_CHANGES} 行までです` }

  // 記号の人: ダウンロードしたときの記号 → 今の表の人（照合用のハッシュで見つける。記号が付け直されていても同じ人）
  const nameByHash = new Map<string, string>()
  await Promise.all([...view.letters.personOf.values()].map(async (name) => nameByHash.set(await personHash(id.excelKey, name), name)))
  const nameOfLetter = new Map(check.persons.flatMap((p) => (nameByHash.has(p.hash) ? [[p.letter, nameByHash.get(p.hash)!] as const] : [])))
  const sentLetters = new Set(check.persons.map((p) => p.letter))
  const letterOfPerson = new Map([...nameOfLetter].map(([letter, name]) => [personKey(name), letter]))
  /** 今の表のセルを、ダウンロードしたときの記号の「〔Ａ〕」の形にする。ダウンロードしたときにいなかった人がいれば undefined */
  const asSent = (cell: CellResult) => {
    let ok = true
    const v = cell.stored
      ? withNames(cell.stored, (name) => {
          const l = letterOfPerson.get(personKey(name))
          if (!l) ok = false
          return `〔${l ?? ""}〕`
        })
      : cell.value
    return ok ? v : undefined
  }

  const sent = check.rows.map((r) => ({ key: r.key, marked: r.marked, csv: FIELDS.map((f) => unmark(r.marked[f.id])) }))
  const match = matchRows(
    uploaded.map((u) => comparable(u.values)),
    sent.map((s) => comparable(s.csv)),
  )
  if (sent.length && !match.pairs.length && !match.candidates.size) return { error: "ダウンロードしたときの工事が1つも見つかりません。書き出した Excel のデータのシートをアップロードしてください" }
  const report: FinalReport = { cells: 0, added: 0, excluded: 0, alreadyAdded: 0, conflicts: [], invalid: [], refused: [], ambiguous: [], keptRows: 0, unknownRows: 0, extraColumns }
  const now = new Map(view.shown.map((r) => [r.key, r]))

  const cellChanges: Cell[] = []
  const suspects: { cell: Cell; sent: string }[] = []
  /** 当てた行の、ダウンロードしたときの値（場所名からそろえる都道府県名が、ダウンロードしたあとに変わっていないかを見る） */
  const sentOf = new Map(match.pairs.map(([, si]) => [sent[si]!.key, sent[si]!]))
  for (const [ui, si] of match.pairs) {
    const u = uploaded[ui]!
    const s = sent[si]!
    const current = now.get(s.key)
    if (!current) {
      report.unknownRows++
      continue
    }
    const up = comparable(u.values)
    const was = comparable(s.csv)
    FIELDS.forEach((f, c) => {
      if (up[c] === was[c]) return
      const cell: Cell = { line: u.line, rowKey: s.key, field: f.id, value: u.values[c]!, literal: literalIn(s.marked[f.id]) }
      const cur = asSent(current.cells[f.id])
      // 前に上げて承認した値（同じ Excel を2回上げた）
      if (cur !== undefined && unmark(cur) === u.values[c]) return
      // ダウンロードしたあとに表が変わっていた。上げた値を読んで今の値と同じなら（承認した値を形を変えて読んだ）何もしない。違えば食い違い
      if (cur !== s.marked[f.id]) suspects.push({ cell, sent: s.csv[c]! })
      else cellChanges.push(cell)
    })
  }
  for (const ui of match.ambiguous) report.ambiguous.push({ line: uploaded[ui]!.line, candidates: match.candidates.get(ui)!.length })
  const kept = new Set([...match.candidates.values()].flat())
  report.keptRows = match.unmatchedSent.filter((si) => kept.has(si)).length
  // 消した行は「載せない」（今も載っているときだけ。ダウンロードしたあとに画面で外した行は何もしない）
  const excludes = match.unmatchedSent.filter((si) => !kept.has(si) && view.inclusion.get(sent[si]!.key)?.included === true).map((si) => sent[si]!.key)

  // 足した工事（同じ中身の何番目かを Excel の行の順で数え、同じ Excel を2回上げても二重に足さない）
  const fresh = match.unmatchedUploaded.filter((ui) => !match.candidates.has(ui)).map((ui) => uploaded[ui]!)
  const hashes = await Promise.all(fresh.map((u) => contentKey(u.values)))
  const seen = new Map<string, number>()
  const newRows = fresh
    .map((u, i) => {
      const hash = hashes[i]!
      const n = (seen.get(hash) ?? 0) + 1
      seen.set(hash, n)
      const rowKey = `add-${hash}-${n}`
      const cells = FIELDS.flatMap((f, c): Cell[] => (u.values[c] ? [{ line: u.line, rowKey, field: f.id, value: u.values[c]!, literal: new Set() }] : []))
      return { line: u.line, rowKey, cells }
    })
    .filter((r) => {
      if (!now.has(r.rowKey)) return true
      report.alreadyAdded++
      return false
    })
  // 上限は AI（匿名化）を呼ぶ前に確かめる（場所名の住所からそろえる都道府県名も、出るかもしれない分を数える）
  const addedNow = view.shown.filter((r) => r.key.startsWith("add-")).length
  if (addedNow + newRows.length > MAX_ADDED_ROWS) return { error: `足す行が ${newRows.length} 行あります。案件に足せる行は ${MAX_ADDED_ROWS} 行までです（今 ${addedNow} 行）` }
  const places = new Set(cellChanges.filter((c) => c.field === "place").map((c) => c.rowKey)).size
  const planned = cellChanges.length + places + excludes.length + newRows.length * 2
  if (planned > MAX_EXCEL_CHANGES) return { error: `変更が ${planned} 件あります。1回に取り込めるのは ${MAX_EXCEL_CHANGES} 件までです（分けてアップロードし直してください）` }

  const read = await readValues([...cellChanges, ...newRows.flatMap((r) => r.cells)], ai, nameOfLetter, sentLetters)
  /** 今の表の値と同じか（人の印の氏名は空白を除いて比べる） */
  const isCurrent = (c: Cell, value: string) => {
    const cell = now.get(c.rowKey)!.cells[c.field]
    return comparableValue(value) === comparableValue(cell.stored ?? cell.value)
  }
  // ダウンロードしたあとに表が変わっていたセルは、決まった処理で読んで今の値と同じなら何もしない（AI には通さない。注文者・工事名は食い違いのまま）
  const checked = await readValues(
    suspects.filter((x) => !READ_AS[x.cell.field].startsWith("ai.")).map((x) => x.cell),
    { ...ai, callAi: undefined },
    nameOfLetter,
    sentLetters,
  )
  for (const { cell: c, sent: was } of suspects) {
    const r = checked.get(c)
    if (r?.ok && isCurrent(c, r.edit.value)) continue
    report.conflicts.push({ line: c.line, field: c.field, sent: was, now: now.get(c.rowKey)!.cells[c.field].value, uploaded: c.value })
  }
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
    // ダウンロードしたあとに画面で都道府県名を変えていたら、黙って上書きしない
    const s = sentOf.get(rowKey)
    const current = now.get(rowKey)
    if (s && current && current.cells.prefecture.value !== s.marked.prefecture) {
      if (current.cells.prefecture.value !== r.prefecture)
        report.conflicts.push({ line: place.line, field: "prefecture", sent: s.marked.prefecture, now: current.cells.prefecture.value, uploaded: r.prefecture })
      return
    }
    const synthetic: Cell = { line: place.line, rowKey, field: "prefecture", value: r.prefecture, literal: new Set() }
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
    if (isCurrent(c, r.edit.value)) continue
    changes.push({ kind: "cell", rowKey: c.rowKey, field: c.field, edit: r.edit })
    report.cells++
  }
  for (const rowKey of excludes) {
    changes.push({ kind: "include", rowKey, include: false })
    report.excluded++
  }
  // 新しい工事は、読めない値が1つでもあれば足さない（直して上げ直してもらう）。最後の Excel の行なので載せる
  for (const r of newRows) {
    const results = r.cells.map((c) => ({ c, res: read.get(c)! }))
    let failed = false
    for (const { c, res } of results) {
      if (res.ok) continue
      failed = true
      ;(res.refused ? report.refused : report.invalid).push({ line: r.line, field: c.field, value: c.value, message: `${res.message}（この行は足していません）` })
    }
    if (failed) continue
    changes.push({ kind: "add", rowKey: r.rowKey, by: "excel", cells: Object.fromEntries(results.flatMap(({ c, res }) => (res.ok ? [[c.field, res.edit]] : []))) })
    changes.push({ kind: "include", rowKey: r.rowKey, include: true })
    report.added++
  }
  return { changes, report }
}

/** 候補を探す手がかりにする値の、同じ値の行の数の上限（どの行にもある値で候補を探すと、行の数の2乗の手間になる） */
const INDEX_LIMIT = 500

export type RowMatch = {
  /** [今の行, ダウンロードした行] */
  pairs: [number, number][]
  /** 決めきれなかった今の行 */
  ambiguous: number[]
  /** 決めきれなかった今の行 → 候補のダウンロードした行 */
  candidates: Map<number, number[]>
  unmatchedUploaded: number[]
  unmatchedSent: number[]
}

/**
 * 今の行とダウンロードした行を中身で対応させる。1) 14列が同じ行を上から順に当てる。2) 残りは MATCH_FIELDS 列以上が同じ候補のうち、
 * 互いにいちばん近い（同じ列が多い）ただ1つの行どうしを当て、当てた分を除いて繰り返す。3) CANDIDATE_FIELDS 列以上が同じ候補が残るのに
 * 決めきれない今の行は ambiguous。候補は INDEX_FIELDS のどれかが同じ行だけを数える（同じ値の行が INDEX_LIMIT を超える値は手がかりにしない）
 */
export function matchRows(uploaded: readonly (readonly string[])[], sent: readonly (readonly string[])[]): RowMatch {
  const pairs: [number, number][] = []
  const exact = groupBy(
    sent.map((_, i) => i),
    (i) => JSON.stringify(sent[i]),
  )
  const queues = new Map([...exact].map(([k, list]) => [k, [...list]]))
  const restU: number[] = []
  uploaded.forEach((u, i) => {
    const si = queues.get(JSON.stringify(u))?.shift()
    if (si === undefined) restU.push(i)
    else pairs.push([i, si])
  })
  const restS = new Set([...queues.values()].flat())
  const index = INDEX_FIELDS.map((f) => {
    const c = FIELDS.findIndex((x) => x.id === f)
    const m = new Map<string, number[]>()
    for (const si of restS) {
      const v = sent[si]![c]!
      const list = m.get(v)
      if (list) list.push(si)
      else m.set(v, [si])
    }
    return { c, m }
  })
  const score = (u: readonly string[], s: readonly string[]) => u.reduce((n, v, c) => n + (v === s[c] ? 1 : 0), 0)
  // 今の行ごとの候補（MATCH_FIELDS 列以上が同じダウンロードした行と、同じ列の数）
  const cand = new Map<number, Map<number, number>>()
  /** 同じ値の多すぎる手がかりを使わなかった今の行（候補を見落としたかもしれない） */
  const partial = new Set<number>()
  for (const ui of restU) {
    const u = uploaded[ui]!
    const near = new Map<number, number>()
    for (const { c, m } of index) {
      const list = m.get(u[c]!) ?? []
      if (list.length > INDEX_LIMIT) {
        partial.add(ui)
        continue
      }
      for (const si of list) if (!near.has(si)) near.set(si, score(u, sent[si]!))
    }
    for (const [si, n] of near) if (n < CANDIDATE_FIELDS) near.delete(si)
    if (near.size) cand.set(ui, near)
  }
  const left = new Set(cand.keys())
  for (let changed = true; changed; ) {
    changed = false
    const bestOfS = new Map<number, { n: number; us: number[] }>()
    const bestOfU = new Map<number, { n: number; ss: number[] }>()
    for (const ui of left) {
      for (const [si, n] of cand.get(ui)!) {
        if (!restS.has(si) || n < MATCH_FIELDS) continue
        const bu = bestOfU.get(ui)
        if (!bu || n > bu.n) bestOfU.set(ui, { n, ss: [si] })
        else if (n === bu.n) bu.ss.push(si)
        const bs = bestOfS.get(si)
        if (!bs || n > bs.n) bestOfS.set(si, { n, us: [ui] })
        else if (n === bs.n) bs.us.push(ui)
      }
    }
    for (const [ui, b] of bestOfU) {
      if (b.ss.length !== 1) continue
      const si = b.ss[0]!
      const bs = bestOfS.get(si)!
      if (bs.us.length !== 1 || bs.us[0] !== ui) continue
      pairs.push([ui, si])
      left.delete(ui)
      restS.delete(si)
      changed = true
    }
  }
  const candidates = new Map<number, number[]>()
  for (const ui of left) {
    const ss = [...cand.get(ui)!.keys()].filter((si) => restS.has(si))
    if (ss.length) candidates.set(ui, ss)
  }
  // 手がかりを使わなかった行は、残った（載せないになる）ダウンロードした行と全部比べ、近い行があれば黙って差し替えず決めきれない行にする
  // （残ったダウンロードした行は消した行だけのことが多く、少ない）
  const matched = new Set(pairs.map(([u]) => u))
  for (const ui of partial) {
    if (matched.has(ui) || candidates.has(ui)) continue
    const ss = [...restS].filter((si) => score(uploaded[ui]!, sent[si]!) >= CANDIDATE_FIELDS)
    if (ss.length) candidates.set(ui, ss)
  }
  const matchedU = matched
  return {
    pairs,
    ambiguous: [...candidates.keys()],
    candidates,
    unmatchedUploaded: uploaded.map((_, i) => i).filter((i) => !matchedU.has(i)),
    unmatchedSent: [...restS].sort((a, b) => a - b),
  }
}

/** prefecture は、場所名に住所を書いたときの、住所に書いてあった都道府県 */
type Read = { ok: true; edit: CellEdit; prefecture?: Prefecture } | { ok: false; message: string; refused?: true }

/**
 * 値の記号（Ａ・Ｂ…）を、その人の氏名にした値（匿名化に通す元の値。変換のときと同じく、匿名化の AI が氏名を同じ人の印にする）。
 * 前後が英数字でない記号の形の文字は、ダウンロードしたときにこの Excel に書いた記号の人（照合用のハッシュ）として読む。ダウンロードしたときにこのセルに
 * あった人ではない文字（literal）はそのまま。人に戻せない記号は黙って文字にせず読めない
 */
function withLetterNames(text: string, literal: ReadonlySet<string>, nameOfLetter: ReadonlyMap<string, string>, sentLetters: ReadonlySet<string>): { ok: true; value: string } | { ok: false; message: string } {
  const found = [...text.matchAll(LETTER_RE)].map((m) => m[1]!).filter((l) => !literal.has(l))
  const missing = [...new Set(found.filter((l) => !nameOfLetter.has(l)))]
  if (missing.length)
    return { ok: false, message: `記号「${missing.join("・")}」${missing.some((l) => sentLetters.has(l)) ? "の人が今の表にいません" : "に当たる人がこの Excel にいません"}` }
  return { ok: true, value: text.replace(LETTER_RE, (l) => (literal.has(l) ? l : nameOfLetter.get(l)!)) }
}

/** 値を項目ごとの決まった処理に通す。空にした値は空のまま（職員が消した） */
async function readValues(cells: readonly Cell[], ai: FinalAi, nameOfLetter: ReadonlyMap<string, string>, sentLetters: ReadonlySet<string>): Promise<Map<Cell, Read>> {
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
    const named = how.startsWith("ai.") ? withLetterNames(c.value, c.literal, nameOfLetter, sentLetters) : { ok: true as const, value: c.value }
    if (!named.ok) {
      out.set(c, { ok: false, message: named.message })
      continue
    }
    // 記号の人を氏名に戻した値は、決まった処理で法人名・個人名の無い工事名と読めても、必ず匿名化に通す（氏名を CSV に出さない）
    const ruled = transformCell(how, [named.value], "Excel", ctx)
    const draft: CellDraft = named.value !== c.value && ruled.kind === "done" ? { kind: "ai", transform: how, raw: collapseSpaces(named.value), source: "Excel", original: named.value, reason: "記号の人を含む" } : ruled
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
  return toHex(new Uint8Array(digest).slice(0, 16))
}

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
import { CHECK_SHEET_NAME, MARK_RE, personHash, readCheckSheet, type FinalCheck } from "./final-sheet"

/**
 * 直した最後の Excel を上げ直したときの取り込み。照合用の隠しシートの落としたときの値と、データのシートの今の値を比べ、
 * 職員が直したセルを変更案（出どころ excel）にする。
 * - 行は中身で対応させる（職員が行を足した・消した・並べ替えたときも）。同じ中身の行 → 14列のうち MATCH_FIELDS 列以上が同じで、
 *   互いにいちばん近い行、の順に当てる。決めきれない行は黙って当てず ambiguous に出す（その候補の行は「載せない」にもしない）
 * - 当たらなかった今の行は足した工事、当たらなかった落とした行は「載せない」の変更案
 * - 値は CSV の値（匿名化のあと・業種などのコード・千円・YYYYMM）なので、変換と同じ決まった処理で表の値に直す。記号（Ａ・Ｂ…）は
 *   そのまま匿名化の値として、照合用のハッシュでその人に戻す。注文者・工事名に書いた実名は変換と同じ匿名化に通す（確かめられなければ取り込まない）
 * - 落としたあとに表のその値が変わっていたら、黙って上書きせず食い違い（conflicts）に出す
 */

type F = KojiFieldId
const FIELDS = KOJI_KEIREKI.fields

/** 1つの Excel の変更案に入れられる項目の数（R2 の記録と画面の一覧が重くなりすぎないように） */
export const MAX_EXCEL_CHANGES = 20_000
/** 落とした行と今の行を同じ工事とみなす、同じ値の列の数（14列のうち。3列までの手直しは同じ工事） */
export const MATCH_FIELDS = 11
/** 当てる候補を探す列。MATCH_FIELDS 列以上が同じなら、違う列は3列までなので、この4列のどれかは必ず同じ */
const INDEX_FIELDS: readonly F[] = ["client", "workName", "amount", "startYm"]

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
  /** 落としたあとに表のその値が変わっていた（職員の手直しを上書きしないので、変更案にしない）。値は CSV の値（記号） */
  conflicts: { line: number; field: F; sent: string; now: string; uploaded: string }[]
  /** 読めない値（業種・年月など）。変更案にしない */
  invalid: { line: number; field: F; value: string; message: string }[]
  /** 個人名かもしれないのに匿名化を確かめられなかった値。変更案にしない */
  refused: { line: number; field: F; value: string; message: string }[]
  /** どの工事を直したのか決めきれなかった行（候補が2つ以上）。取り込まない */
  ambiguous: { line: number; candidates: number }[]
  /** 決めきれない行の候補なので「載せない」にしなかった、落とした行の数 */
  keptRows: number
  /** 今の表に無い行（落としたあとに足した行を消したなど）の数 */
  unknownRows: number
}

/** lookup は場所名に書いた住所を引く（変換と同じ分け方。address.ts） */
export type FinalAi = { rounding: Rounding; cache: AiCache; callAi?: AiCaller; lookup: AddressLookup }

/** 最後の Excel の照合用の隠しシートを読む。無ければ null（この画面で落とした最後の Excel ではない） */
export function finalCheckOf(sheets: readonly SheetGrid[]): FinalCheck | { error: string } | null {
  const sheet = sheets.find((s) => s.name === CHECK_SHEET_NAME)
  return sheet ? (readCheckSheet(sheet.rows) ?? { error: "照合用のシートが書き換えられていて読めません" }) : null
}

type Cell = { line: number; rowKey: string; field: F; value: string; /** 落としたときにこのセルにいた記号（記号はその人として読む） */ letters: ReadonlySet<string> }

const unmark = (marked: string) => marked.replace(MARK_RE, "$1")
const lettersIn = (marked: string) => new Set([...marked.matchAll(MARK_RE)].map((m) => m[1]!))

/**
 * 上げ直した最後の Excel を、今の表（view）との差分の変更案にする。id は今の案件と変換の元（別の案件・元を変えたあとの Excel は読まない）
 */
export async function readFinalSheet(
  sheets: readonly SheetGrid[],
  view: TableView,
  id: { caseId: string; sourceFileId: string | null },
  ai: FinalAi,
): Promise<{ changes: ChatChange[]; report: FinalReport } | { error: string }> {
  const check = finalCheckOf(sheets)
  if (!check) return { error: "照合用のシートがありません。この画面の「書き出す」で落とした Excel を直して上げてください" }
  if ("error" in check) return check
  if (check.meta.caseId !== id.caseId) return { error: "別の案件で落とした Excel です" }
  if (check.meta.sourceFileId !== id.sourceFileId) return { error: "落としたあとに変換の元のファイルが変わったので、この Excel は表に戻せません。書き出し直してから直してください" }
  const data = sheets.find((s) => s.name !== CHECK_SHEET_NAME)
  if (!data) return { error: "データのシートがありません" }
  const uploaded = data.rows.flatMap((r, i) => {
    const values = FIELDS.map((_, c) => (r[c] ?? "").trim())
    return values.some(Boolean) ? [{ line: i + 1, values }] : []
  })
  if (uploaded.length > MAX_EXCEL_CHANGES) return { error: `行が ${uploaded.length} 行あります。取り込めるのは ${MAX_EXCEL_CHANGES} 行までです` }

  // 記号の人: 落としたときの記号 → 今の表の人（照合用のハッシュで見つける。記号が付け直されていても同じ人）
  const nameByHash = new Map<string, string>()
  await Promise.all([...view.letters.personOf.values()].map(async (name) => nameByHash.set(await personHash(check.meta.salt, name), name)))
  const nameOfLetter = new Map(check.persons.flatMap((p) => (nameByHash.has(p.hash) ? [[p.letter, nameByHash.get(p.hash)!] as const] : [])))
  const letterOfPerson = new Map([...nameOfLetter].map(([letter, name]) => [personKey(name), letter]))
  /** 今の表のセルを、落としたときの記号の「〔Ａ〕」の形にする。落としたときにいなかった人がいれば undefined */
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
    uploaded.map((u) => u.values),
    sent.map((s) => s.csv),
  )
  const report: FinalReport = { cells: 0, added: 0, excluded: 0, alreadyAdded: 0, conflicts: [], invalid: [], refused: [], ambiguous: [], keptRows: 0, unknownRows: 0 }
  const now = new Map(view.shown.map((r) => [r.key, r]))

  const cellChanges: Cell[] = []
  for (const [ui, si] of match.pairs) {
    const u = uploaded[ui]!
    const s = sent[si]!
    const current = now.get(s.key)
    if (!current) {
      report.unknownRows++
      continue
    }
    FIELDS.forEach((f, c) => {
      const up = u.values[c]!
      if (up === s.csv[c]) return
      const cur = asSent(current.cells[f.id])
      // 前に上げて承認した値（同じ Excel を2回上げた）
      if (cur !== undefined && unmark(cur) === up) return
      if (cur !== s.marked[f.id]) {
        report.conflicts.push({ line: u.line, field: f.id, sent: s.csv[c]!, now: current.cells[f.id].value, uploaded: up })
        return
      }
      cellChanges.push({ line: u.line, rowKey: s.key, field: f.id, value: up, letters: lettersIn(s.marked[f.id]) })
    })
  }
  for (const ui of match.ambiguous) report.ambiguous.push({ line: uploaded[ui]!.line, candidates: match.candidates.get(ui)!.length })
  const kept = new Set([...match.candidates.values()].flat())
  report.keptRows = match.unmatchedSent.filter((si) => kept.has(si)).length
  // 消した行は「載せない」（今も載っているときだけ。落としたあとに画面で外した行は何もしない）
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
      const cells = FIELDS.flatMap((f, c): Cell[] => (u.values[c] ? [{ line: u.line, rowKey, field: f.id, value: u.values[c]!, letters: new Set() }] : []))
      return { line: u.line, rowKey, cells }
    })
    .filter((r) => {
      if (!now.has(r.rowKey)) return true
      report.alreadyAdded++
      return false
    })
  // 上限は AI（匿名化）を呼ぶ前に確かめる
  const addedNow = view.shown.filter((r) => r.key.startsWith("add-")).length
  if (addedNow + newRows.length > MAX_ADDED_ROWS) return { error: `足す行が ${newRows.length} 行あります。案件に足せる行は ${MAX_ADDED_ROWS} 行までです（今 ${addedNow} 行）` }
  const planned = cellChanges.length + excludes.length + newRows.length * 2
  if (planned > MAX_EXCEL_CHANGES) return { error: `変更が ${planned} 件あります。1回に取り込めるのは ${MAX_EXCEL_CHANGES} 件までです（分けて上げ直してください）` }

  const read = await readValues([...cellChanges, ...newRows.flatMap((r) => r.cells)], ai, nameOfLetter)
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
    const synthetic: Cell = { line: place.line, rowKey, field: "prefecture", value: r.prefecture, letters: new Set() }
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

export type RowMatch = {
  /** [今の行, 落とした行] */
  pairs: [number, number][]
  /** 決めきれなかった今の行 */
  ambiguous: number[]
  /** 決めきれなかった今の行 → 候補の落とした行 */
  candidates: Map<number, number[]>
  unmatchedUploaded: number[]
  unmatchedSent: number[]
}

/**
 * 今の行と落とした行を中身で対応させる。1) 14列が同じ行を上から順に当てる。2) 残りは MATCH_FIELDS 列以上が同じ候補のうち、
 * 互いにいちばん近い（同じ列が多い）ただ1つの行どうしを当て、当てた分を除いて繰り返す。3) 候補があるのに決めきれない今の行は ambiguous
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
      m.set(v, [...(m.get(v) ?? []), si])
    }
    return { c, m }
  })
  const score = (u: readonly string[], s: readonly string[]) => u.reduce((n, v, c) => n + (v === s[c] ? 1 : 0), 0)
  // 今の行ごとの候補（MATCH_FIELDS 列以上が同じ落とした行と、同じ列の数）
  const cand = new Map<number, Map<number, number>>()
  for (const ui of restU) {
    const u = uploaded[ui]!
    const near = new Map<number, number>()
    for (const { c, m } of index) for (const si of m.get(u[c]!) ?? []) if (!near.has(si)) near.set(si, score(u, sent[si]!))
    for (const [si, n] of near) if (n < MATCH_FIELDS) near.delete(si)
    if (near.size) cand.set(ui, near)
  }
  const left = new Set(cand.keys())
  for (let changed = true; changed; ) {
    changed = false
    const bestOfS = new Map<number, { n: number; us: number[] }>()
    const bestOfU = new Map<number, { n: number; ss: number[] }>()
    for (const ui of left) {
      for (const [si, n] of cand.get(ui)!) {
        if (!restS.has(si)) continue
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
  const matchedU = new Set(pairs.map(([u]) => u))
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

const ALNUM = "Ａ-Ｚａ-ｚA-Za-z０-９0-9"
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * 値の記号（Ａ・Ｂ…）を、その人の氏名にした値（匿名化に通す元の値。変換のときと同じく、匿名化の AI が氏名を同じ人の印にする）。
 * 落としたときにこのセルにいた記号は、前後が英数字でない所をその人とする。値がまるごと1つの記号なら、ほかのセルの記号でもその人
 * （注文者を「Ｂ」にした）。今の表にいない人の記号は読めない
 */
function withLetterNames(text: string, letters: ReadonlySet<string>, nameOfLetter: ReadonlyMap<string, string>): { ok: true; value: string } | { ok: false; message: string } {
  const whole = text.trim()
  const used = /^[Ａ-Ｚ][０-９]*$/.test(whole) && nameOfLetter.has(whole) ? [whole] : [...letters]
  if (!used.length) return { ok: true, value: text }
  const re = new RegExp(`(?<![${ALNUM}])(${used.sort((a, b) => b.length - a.length).map(escape).join("|")})(?![${ALNUM}])`, "g")
  const missing = [...new Set([...text.matchAll(re)].map((m) => m[1]!).filter((l) => !nameOfLetter.has(l)))]
  if (missing.length) return { ok: false, message: `記号「${missing.join("・")}」の人が今の表にいません` }
  return { ok: true, value: text.replace(re, (l) => nameOfLetter.get(l)!) }
}

/** 値を項目ごとの決まった処理に通す。空にした値は空のまま（職員が消した） */
async function readValues(cells: readonly Cell[], ai: FinalAi, nameOfLetter: ReadonlyMap<string, string>): Promise<Map<Cell, Read>> {
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
    const named = how.startsWith("ai.") ? withLetterNames(c.value, c.letters, nameOfLetter) : { ok: true as const, value: c.value }
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
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

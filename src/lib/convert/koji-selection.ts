import { groupBy } from "../group-by"
import { codeLabel } from "../spec/code-sets"
import type { KojiFieldId } from "../spec/koji-keireki"
import type { RowResult } from "./convert"

/**
 * 工事経歴書に載せる工事の選び方（7割ルール）と並べ方。
 * 業種ごとに ① 元請を金額の大きい順に、元請合計の7割を超えるまで
 * ② 残りの元請と下請を金額の大きい順に、全体の7割を超えるまで。
 * ①②を通して軽微な工事は10件まで（超える軽微な工事は飛ばして続ける）。
 * 7割の基準は損益計算書の完成工事高のうち当該業種の額（Basis）。入力が無ければ行の合計を使う。
 * 基準額が税抜か税込かは7割の計算（Rule7Tax。事務所の初期値は税抜）で決まる。行の金額は税抜にそろえて足し（税込・不明は 1.1 で割る。net11Of）、
 * 税込の基準額も税抜にそろえて比べる（basis11Of）。軽微の判定は税込の基準のまま（keibiYen）。
 */

type KojiRow = RowResult<KojiFieldId>

/** 元データの金額が税込か税抜か（軽微と7割の判定に使う。金額そのものは変換しない）。不明は税込として扱う */
export type TaxMode = "unknown" | "included" | "excluded"

/** 顧客の Excel の金額が税込か税抜か（行の金額を7割の計算にそろえるために聞く） */
export const TAX_LABELS: Record<TaxMode, string> = { included: "税込", excluded: "税抜", unknown: "分からない" }

/** 7割の計算を税抜・税込のどちらでするか（基準額＝決算書の完成工事高と、集計の金額がどちらか）。顧客の Excel の金額（TaxMode）とは別 */
export const RULE7_TAXES = ["excluded", "included"] as const
export type Rule7Tax = (typeof RULE7_TAXES)[number]
export const RULE7_TAX_LABELS: Record<Rule7Tax, string> = { excluded: "税抜", included: "税込" }
/** 1/11 千円の単位から、7割の計算の税の千円にする割り算（税抜 x 千円 = 11x、税込 x 千円 = 10x） */
const unitOf = (rule7Tax: Rule7Tax) => (rule7Tax === "excluded" ? 11 : 10)

const KEIBI_YEN = 5_000_000
const KEIBI_YEN_KENCHIKU = 15_000_000
const MAX_KEIBI = 10

/** 軽微な工事の上限（この金額未満が軽微）。基準は税込なので、税抜の金額は 1.1 で割った額と比べる。不明は税込扱い */
export function keibiYen(tax: TaxMode) {
  return (gyoshu: string) => {
    const base = gyoshu === "2" ? KEIBI_YEN_KENCHIKU : KEIBI_YEN
    return tax === "excluded" ? base / 1.1 : base
  }
}

const amountOf = (r: KojiRow) => (/^\d+$/.test(r.cells.amount.value) ? Number(r.cells.amount.value) : 0)
const yenOf = (r: KojiRow) => amountOf(r) * 1000
/**
 * 7割は税抜で計算する（基準額の完成工事高が税抜）。税込・不明の金額を 1.1 で割ると端数で7割ちょうどが超えた扱いになるので、
 * 1/11 千円を単位にした整数で持つ（税抜 x 千円 → 11x、税込 x 千円 → 10x）
 */
const net11Of = (tax: TaxMode) => (r: KojiRow) => amountOf(r) * (tax === "excluded" ? 11 : 10)
/** 7割を超えたか（acc > basis × 0.7 を整数のまま比べる） */
const over70 = (acc11: number, basis11: number) => acc11 * 10 > basis11 * 7
const isMotouke = (r: KojiRow) => r.cells.motoukeShitauke.value === "0" || r.cells.motoukeShitauke.value === "1"
const classRank = (r: KojiRow) => (isMotouke(r) ? 0 : r.cells.motoukeShitauke.value === "2" ? 1 : 2)
const gyoshuRank = (r: KojiRow) => (/^\d+$/.test(r.cells.gyoshu.value) ? Number(r.cells.gyoshu.value) : 999)
const byAmountDesc = (a: KojiRow, b: KojiRow) => amountOf(b) - amountOf(a)
const sumBy = (rows: KojiRow[], amount: (r: KojiRow) => number) => rows.reduce((s, r) => s + amount(r), 0)

const groupByGyoshu = (rows: readonly KojiRow[]) => groupBy(rows, (r) => r.cells.gyoshu.value)

/** 7割で選ぶ対象の行（除外した行を除く）を業種ごとに。基準額が空欄の側の行の合計もこの行から出す（selectBy7Rule と summarizeKoji で同じ） */
const ruleRowsByGyoshu = (rows: readonly KojiRow[]) => groupByGyoshu(rows.filter((r) => !r.excluded))

/** 業種コード → 7割の基準額（7割の計算の税の千円）。total＝完成工事高の合計、motouke＝うち元請。空欄の側は行の合計を使う */
export type Basis = Partial<Record<string, { total?: number; motouke?: number }>>

/** 基準額として使える入力（正の数）。0 以下は7割の目標が無くなり選択が止まるので、入力が無いのと同じに扱う */
export const isUsableBasis = (v: number | undefined): v is number => v !== undefined && v > 0

/** 基準額（1/11 千円単位。入れた額は7割の計算の税の千円） */
const basis11Of = (basis: Basis | undefined, rule7Tax: Rule7Tax, gyoshu: string, list: KojiRow[], net11: (r: KojiRow) => number) => {
  const entered = basis?.[gyoshu]
  const unit = unitOf(rule7Tax)
  return {
    total: isUsableBasis(entered?.total) ? entered.total * unit : sumBy(list, net11),
    motouke: isUsableBasis(entered?.motouke) ? entered.motouke * unit : sumBy(list.filter(isMotouke), net11),
  }
}

/**
 * 7割ルールで選んだ行の key。除外した行（rowFilter）は対象にしない。
 * 基準額が行の合計より大きく行を使い切っても届かないとき（顧客がすでに7割で絞ったデータ）は、
 * 軽微な工事の上限を除いて全行が選ばれる。届いたかは summarizeKoji の比率で見る。
 */
export function selectBy7Rule(rows: readonly KojiRow[], opts: { tax: TaxMode; basis?: Basis; rule7Tax?: Rule7Tax }): Set<string> {
  const selected = new Set<string>()
  const net11 = net11Of(opts.tax)
  for (const [gyoshu, list] of ruleRowsByGyoshu(rows)) {
    const basis = basis11Of(opts.basis, opts.rule7Tax ?? "excluded", gyoshu, list, net11)
    const threshold = keibiYen(opts.tax)(gyoshu)
    let keibi = 0
    let acc = 0
    const take = (candidates: KojiRow[], basis11: number) => {
      for (const r of candidates) {
        if (over70(acc, basis11)) return
        if (yenOf(r) < threshold) {
          if (keibi >= MAX_KEIBI) continue
          keibi++
        }
        selected.add(r.key)
        acc += net11(r)
      }
    }
    const motouke = list.filter(isMotouke).sort(byAmountDesc)
    if (basis.motouke > 0) take(motouke, basis.motouke)
    if (basis.total > 0) take(list.filter((r) => !selected.has(r.key)).sort(byAmountDesc), basis.total)
  }
  return selected
}

/**
 * 載せる工事の選び方。rule7: 東京都の記入例のとおり（上の selectBy7Rule。7割を超えたところで止め、軽微な工事は10件まで）。
 * all: 全件を載せる（除外した行と手動で外した行のほか）。7割を超えて多く載せるのは構わないので、7割以上なら件数は自由にする。
 * 軽微の10件は「それより多くは載せなくてよい」上限なので、all では軽微な工事も全部載せる。顧客がすでに7割で絞ったデータもこちら
 */
export const SELECTION_MODES = ["rule7", "all"] as const
export type SelectionMode = (typeof SELECTION_MODES)[number]
export const SELECTION_LABELS: Record<SelectionMode, string> = { rule7: "7割ルール", all: "全件" }

export type Inclusion =
  | { included: true; reason: "rule7" | "all" | "threshold" | "manual" }
  | { included: false; reason: "excluded" | "manual" | "unselected" }

export const INCLUSION_LABELS: Record<Inclusion["reason"], string> = {
  rule7: "7割ルール",
  all: "全件",
  threshold: "金額で追加",
  manual: "手動",
  excluded: "除外",
  unselected: "",
}

export type SelectionOptions = {
  tax: TaxMode
  basis?: Basis
  /** 7割の計算（基準額が税抜か税込か）。無ければ税抜 */
  rule7Tax?: Rule7Tax
  selection: SelectionMode
  /** この金額（円）以上の行は7割に関係なく載せる */
  includeAtLeastYen?: number
  /** 職員がチェックで入れ外しした行（key → 載せるか） */
  manual: ReadonlyMap<string, boolean>
}

/** 行ごとに載せるか。手動 > 除外 > 全件 > 7割ルール > 金額で追加 の順に決める */
export function selectKojiRows(rows: readonly KojiRow[], opts: SelectionOptions): Map<string, Inclusion> {
  const all = opts.selection === "all"
  const rule7 = all ? new Set<string>() : selectBy7Rule(rows, opts)
  const result = new Map<string, Inclusion>()
  for (const r of rows) {
    const manual = opts.manual.get(r.key)
    if (manual !== undefined) result.set(r.key, manual ? { included: true, reason: "manual" } : { included: false, reason: "manual" })
    else if (r.excluded) result.set(r.key, { included: false, reason: "excluded" })
    else if (all) result.set(r.key, { included: true, reason: "all" })
    else if (rule7.has(r.key)) result.set(r.key, { included: true, reason: "rule7" })
    else if (opts.includeAtLeastYen !== undefined && yenOf(r) >= opts.includeAtLeastYen) result.set(r.key, { included: true, reason: "threshold" })
    else result.set(r.key, { included: false, reason: "unselected" })
  }
  return result
}

/** 業種ごとに、元請（官公庁・民間）→ 下請、それぞれ金額の大きい順 */
export function orderKojiRows(rows: readonly KojiRow[]): KojiRow[] {
  return [...rows].sort((a, b) => gyoshuRank(a) - gyoshuRank(b) || classRank(a) - classRank(b) || byAmountDesc(a, b))
}

/**
 * 業種ごとの集計。件数・合計・比率は7割で選ぶ対象の行（除外した行を除く）だけで出す（selectBy7Rule と同じ行）。
 * 除外した行を手動で載せたものは7割の対象ではないので、fromExcluded に別に数える。金額は7割の計算の税（税抜・税込）の千円
 */
export type GyoshuSummary = {
  code: string
  label: string
  count: number
  /** count のうち載せる行 */
  selected: number
  total: number
  motoukeTotal: number
  /** 7割の基準額（入力が無い側は行の合計） */
  basis: { total: number; motouke: number }
  /** 載せる元請の合計 / 元請の基準額（基準額が 0 なら undefined） */
  motoukeRatio?: number
  /** 載せる工事の合計 / 全体の基準額 */
  totalRatio?: number
  /** 載せる合計が基準額の7割を超えていない（基準額が 0 の側は false） */
  short: { motouke: boolean; total: boolean }
  /** 除外した行のうち、手動で載せたもの（比率に入れない） */
  fromExcluded: { count: number; total: number }
}

export function summarizeKoji(rows: readonly KojiRow[], inclusion: ReadonlyMap<string, Inclusion>, opts: { tax: TaxMode; basis?: Basis; rule7Tax?: Rule7Tax }): GyoshuSummary[] {
  const included = (r: KojiRow) => inclusion.get(r.key)?.included ?? false
  const net11 = net11Of(opts.tax)
  const rule7Tax = opts.rule7Tax ?? "excluded"
  const unit = unitOf(rule7Tax)
  const sum11 = (list: KojiRow[]) => sumBy(list, net11)
  const ruleRows = ruleRowsByGyoshu(rows)
  const addedFromExcluded = groupByGyoshu(rows.filter((r) => r.excluded && included(r)))
  const codes = new Set([...ruleRows.keys(), ...addedFromExcluded.keys()])
  return [...codes]
    .sort((a, b) => (Number(a) || 999) - (Number(b) || 999))
    .map((code) => {
      const candidates = ruleRows.get(code) ?? []
      const added = addedFromExcluded.get(code) ?? []
      const b = basis11Of(opts.basis, rule7Tax, code, candidates, net11)
      const selected = candidates.filter(included)
      const selectedMotouke = sum11(selected.filter(isMotouke))
      const selectedTotal = sum11(selected)
      return {
        code,
        label: codeLabel("gyoshu", code) ?? "（業種未確定）",
        count: candidates.length,
        selected: selected.length,
        total: sum11(candidates) / unit,
        motoukeTotal: sum11(candidates.filter(isMotouke)) / unit,
        basis: { total: b.total / unit, motouke: b.motouke / unit },
        motoukeRatio: b.motouke > 0 ? selectedMotouke / b.motouke : undefined,
        totalRatio: b.total > 0 ? selectedTotal / b.total : undefined,
        short: { motouke: b.motouke > 0 && !over70(selectedMotouke, b.motouke), total: b.total > 0 && !over70(selectedTotal, b.total) },
        fromExcluded: { count: added.length, total: sum11(added) / unit },
      }
    })
}

import { applyEdits, finalizeRows, type CellEdits, type Replacements, type RowResult } from "../convert/convert"
import { orderKojiRows, selectKojiRows, type Basis, type Rule7Tax, type SelectionMode, type TaxMode } from "../convert/koji-selection"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import { addedRowResults, type AddedRow } from "./added"
import type { InquiryText } from "../inquiry/text"

/** 案件の表を決めるもの: 変換の結果（手直しの前）と、それに重ねる手直し・置換・入れ外し・7割の設定 */
export type CaseTable = {
  rows: readonly RowResult<KojiFieldId>[]
  /** 元のファイルに無い、足した工事（cases/added.ts） */
  added: readonly AddedRow[]
  edits: CellEdits
  replacements: Replacements<KojiFieldId>
  manual: ReadonlyMap<string, boolean>
  tax: TaxMode
  basis: Basis
  /** 7割の計算（基準額が税抜か税込か） */
  rule7Tax: Rule7Tax
  selection: SelectionMode
  /** この金額（円）以上の行も載せる */
  includeAtLeastYen?: number
  /** 職員が外した問い合わせ（inquiryKey）。チャットの問い合わせの道具はこれを除く */
  dismissed: ReadonlySet<string>
  /** 問い合わせの文面（承認した AI の文・職員が直した文） */
  inquiryText: InquiryText
}

/**
 * 画面・CSV・チャットが見る表。edited は手直しまで当てた行（個人名は印のまま）、shown は画面と CSV の順に並べて記号と検証を当てた行、
 * output は CSV に載せる行。letters は shown の個人名の記号の表
 */
export const deriveTable = (t: CaseTable) => viewOf(t, editRows(t))

/** 変換した行と足した行（手直しの前） */
export const baseRows = (t: Pick<CaseTable, "rows" | "added">) => (t.added.length ? [...t.rows, ...addedRowResults(t.added)] : t.rows)

/** 手直しまで当てた行（個人名は印のまま）。行・足した行・手直し・置換が変わったときだけ作り直せばよい（入れ外し・7割・並びでは変わらない） */
export const editRows = (t: Pick<CaseTable, "rows" | "added" | "edits" | "replacements">) => applyEdits(KOJI_KEIREKI, baseRows(t), { replacements: t.replacements, edits: t.edits })

type Edited = ReturnType<typeof editRows>

/** CSV に載せる行を選ぶ（入れ外し・7割の設定が変わったときだけ作り直せばよい。並べ替えでは変わらない） */
export const selectRows = (t: Pick<CaseTable, "tax" | "basis" | "rule7Tax" | "selection" | "includeAtLeastYen" | "manual">, edited: Edited) =>
  selectKojiRows(edited, { tax: t.tax, basis: t.basis, rule7Tax: t.rule7Tax, selection: t.selection, includeAtLeastYen: t.includeAtLeastYen, manual: t.manual })

/** edited（editRows の結果）から、選ぶ・並べる・記号と検証を当てる */
export const viewOf = (t: CaseTable, edited: Edited) => orderAndFinalize(t, edited, selectRows(t, edited))

/** 選んだ行（inclusion）を画面と CSV の順（記載順: 業種ごとに元請→下請、金額の大きい順。記載ルールの決まり）に並べ、記号と検証を当てる */
export function orderAndFinalize(t: Pick<CaseTable, "rows" | "added" | "replacements">, edited: Edited, inclusion: ReturnType<typeof selectRows>) {
  const ordered = orderKojiRows(edited)
  const { rows: shown, letters } = finalizeRows(KOJI_KEIREKI, ordered, { exported: (r) => inclusion.get(r.key)?.included === true, original: baseRows(t), replacements: t.replacements })
  const output = shown.filter((r) => inclusion.get(r.key)?.included)
  return { edited, inclusion, shown, letters, output }
}
export type TableView = ReturnType<typeof orderAndFinalize>

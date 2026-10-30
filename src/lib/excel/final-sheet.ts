import type { RowResult } from "../convert/convert"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"

/**
 * 取り込み用の Excel（最後に職員が確かめ、Excel の「CSV で保存」で建設業.NET に取り込む形）。職員がこれまで作っていた Excel に合わせる:
 * シート1枚・A〜N の14列・見出しの行なし・1行目からデータ。業種・元請下請・JV・請負代金・PC等の額・主任・監理は数値、ほかは文字列。
 * 値は CSV に出す値と同じ（匿名化のあと）。照合用の隠し列は入れない（「CSV で保存」すると CSV に出てしまう）
 */

export const FINAL_SHEET_NAME = "工事経歴"

/** 数値で書く項目（A・C・D・I・J・M・N） */
export const NUMERIC_FIELDS: ReadonlySet<KojiFieldId> = new Set(["gyoshu", "motoukeShitauke", "jv", "amount", "specialAmount", "chiefEngineer", "supervisingEngineer"])

/** 数値にしてよい値（先頭の 0 が無い整数。「CSV で保存」で同じ文字に戻る） */
const NUMBER_RE = /^(0|[1-9]\d{0,14})$/

export type FinalCell = string | number | null

/** CSV に出す行（output）を、取り込み用の Excel の行にする。空の値は空のセル。数値の項目でも数値にできない値は文字列のまま（値を変えない） */
export function finalSheetRows(rows: readonly RowResult<KojiFieldId>[]): FinalCell[][] {
  return rows.map((r) =>
    KOJI_KEIREKI.fields.map((f): FinalCell => {
      const v = r.cells[f.id].value
      if (v === "") return null
      return NUMERIC_FIELDS.has(f.id) && NUMBER_RE.test(v) ? Number(v) : v
    }),
  )
}

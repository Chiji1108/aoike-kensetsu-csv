import type { CodeSetId } from "./code-sets"

/** 列の値の型。検証・UI・AIへの列説明はここから生成する */
export type ValueType =
  | { type: "code"; set: CodeSetId }
  | {
      type: "text"
      /** 建設業.NET の入力欄に入る字数（全角で数え、半角は0.5字） */
      maxWidth?: number
      /** 個人名が残っていそうな値の見分け方。name: 値そのものが氏名、residence: 「〇〇様邸」のような個人の住まい */
      person?: "name" | "residence"
    }
  | { type: "prefecture" }
  | { type: "thousandYen"; maxDigits: number }
  | { type: "yearMonth" }
  | { type: "flag" }
  | { type: "personName" }

/** 変換の対象を選ぶときの鍵。コード型はコード表ごとに別の型として扱う */
export type ValueTypeKey = Exclude<ValueType["type"], "code"> | `code:${CodeSetId}`

export function valueTypeKey(vt: ValueType): ValueTypeKey {
  return vt.type === "code" ? `code:${vt.set}` : vt.type
}

export type FieldSpec<F extends string = string> = {
  id: F
  /** CSV の列記号（A〜） */
  letter: string
  /** 雛形の見出しセルの文字列そのもの（セル内改行を含む） */
  header: string
  /** 画面に出す短い名前 */
  label: string
  required: boolean
  /** CSV では任意でも、提出書類（工事経歴書）には要る。データに無ければ顧客に問い合わせる */
  filing?: true
  valueType: ValueType
  /** 職員・AI 向けの説明 */
  description: string
  /** 元データに値が無いときに入れる値（例: JV → 0） */
  whenMissing?: { value: string; reason: string }
}

export type RowRule<F extends string> = {
  id: string
  /** エラーを表示するセル */
  field: F
  message: string
  /** 既定は error */
  severity?: "warning"
  holds: (cells: Record<F, string>) => boolean
}

/**
 * 空欄を同じ行のほかの項目から埋める（例: 主任技術者・監理技術者はちょうど一方が 1）。
 * fill は今の値と、埋めてよい項目（空欄で、手入力で空にしたのではない）を受け取り、埋めてよい項目に入れる値を返す。
 * 手入力で空にした項目は「空と決まった値」として扱う（両方空のときの値をもう片方にだけ入れない）。
 * review は、決めた値が推定で確かめが要る（要確認・推定の印を付ける）とき。
 */
export type FillRule<F extends string> = {
  id: string
  fields: readonly F[]
  /** 職員・AI 向けの埋め方の説明 */
  description: string
  fill: (cells: Record<F, string>, open: ReadonlySet<F>) => { values: Partial<Record<F, string>>; reason: string; review?: true } | undefined
}

export type CsvSpec<F extends string> = {
  id: string
  title: string
  /** ダウンロードするファイル名の先頭 */
  fileNamePrefix: string
  fields: readonly FieldSpec<F>[]
  rowRules: readonly RowRule<F>[]
  fillRules: readonly FillRule<F>[]
  /** 公式の記載ルール（AIへの指示と画面の注意書きに使う） */
  writingRules: readonly string[]
}

/** 元データに無くても applyEdits が埋める項目の埋め方（whenMissing・fillRules から）。埋めない項目は undefined */
export function autoFillOf<F extends string>(spec: CsvSpec<F>, f: FieldSpec<F>): string | undefined {
  if (f.whenMissing) return `${f.whenMissing.value}（${f.whenMissing.reason}）`
  return spec.fillRules.find((r) => r.fields.includes(f.id))?.description
}

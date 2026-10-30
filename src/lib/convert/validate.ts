import { CODE_SETS } from "../spec/code-sets"
import { isPrefecture } from "../spec/prefectures"
import type { CsvSpec, FieldSpec, ValueType } from "../spec/types"
import { nonCp932Chars, removeSpaces } from "./text"
import { looksLikeOrganization } from "./transforms"

export type Issue = { severity: "error" | "warning"; message: string }

type Check<K extends ValueType["type"]> = (v: string, vt: Extract<ValueType, { type: K }>) => Issue | undefined

const error = (message: string): Issue => ({ severity: "error", message })
const warning = (message: string): Issue => ({ severity: "warning", message })

/** 建設業.NET の字数の数え方（全角1字、半角英数・半角カナは0.5字） */
export const widthOf = (s: string) => [...s].reduce((n, c) => n + (/[ -~｡-ﾟ]/.test(c) ? 0.5 : 1), 0)

/** 個人名が残っていそうな値（警告。記号「Ａ」「Ｂ２」で始まる値は記号にしたもの） */
const PERSON_LIKE: Record<"name" | "residence", (v: string) => boolean> = {
  name: (v) => !/^[Ａ-Ｚ]/.test(v) && !looksLikeOrganization(v) && /^[一-龥々]{1,4}[ 　]?[一-龥々ぁ-ん]{1,4}(様)?$/.test(v),
  residence: (v) => /[一-龥々](?<![様公官別])(様邸|様宅|邸)/.test(removeSpaces(v)),
}

/** 値の型ごとの検証（空欄は必須チェックで扱うので、ここには空でない値だけが来る） */
const VALUE_CHECKS: { [K in ValueType["type"]]: Check<K> } = {
  code: (v, vt) => (CODE_SETS[vt.set].some((c) => c.code === v) ? undefined : error(`「${v}」は使えるコードではありません`)),
  text: (v, vt) => {
    const width = widthOf(v)
    if (vt.maxWidth !== undefined && width > vt.maxWidth) return error(`字数が上限を超えています（${width}字／全角${vt.maxWidth}字まで。半角は0.5字）`)
    if (vt.person && PERSON_LIKE[vt.person](v)) return warning("個人名が残っていそうです（個人なら「Ａ」等の記号に）")
    return undefined
  },
  prefecture: (v) => (isPrefecture(v) ? undefined : error(`「${v}」は47都道府県名と一致しません`)),
  thousandYen: (v, vt) => {
    if (!/^\d+$/.test(v)) return error("千円単位の整数で入力してください（カンマなし）")
    if (v.length > vt.maxDigits) return error(`${vt.maxDigits}桁を超えています`)
    return undefined
  },
  yearMonth: (v) => {
    const m = v.match(/^(\d{4})(\d{2})$/)
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return error("西暦の YYYYMM（6桁）で入力してください")
    return undefined
  },
  flag: (v) => (v === "0" || v === "1" ? undefined : error("0 か 1 で入力してください")),
  personName: (v) => {
    if (/[ \t]/.test(v)) return error("半角スペースが含まれています（姓と名の間は全角スペース）")
    if (!/^[^　]+　[^　]+$/.test(v)) return warning("姓と名の間に全角スペースを1つ入れてください")
    return undefined
  },
}

export function checkValue(field: FieldSpec, v: string): Issue | undefined {
  if (!v) return field.required ? error("必須の項目です") : undefined
  if (/[\r\n]/.test(v)) return error("改行は使えません")
  const bad = nonCp932Chars(v)
  if (bad.length) return error(`建設業.NET で使えない文字があります: ${[...new Set(bad)].join(" ")}`)
  const check = VALUE_CHECKS[field.valueType.type] as Check<ValueType["type"]>
  return check(v, field.valueType) ?? (/[",]/.test(v) ? warning("カンマ・ダブルクォートを含むため CSV で囲みます。建設業.NET で正しく取り込めないことがあるので、できれば別の文字に") : undefined)
}

/** 行をまたぐ検証（J ≤ I、K ≤ L など）。どのセルにどの問題があるかを返す */
export function checkRow<F extends string>(spec: CsvSpec<F>, values: Record<F, string>): Map<F, Issue> {
  const issues = new Map<F, Issue>()
  for (const rule of spec.rowRules) {
    if (!rule.holds(values)) issues.set(rule.field, { severity: rule.severity ?? "error", message: rule.message })
  }
  return issues
}

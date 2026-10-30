import { z } from "zod"
import type { TaxMode } from "../convert/koji-selection"
import type { MappingPlan } from "../convert/plan"
import { taxSchema } from "../schemas"

/**
 * Excel の金額が税込か税抜か（tax）と、それを誰が決めたか（taxBy）。plan は計画の AI が見出し・注記から決めた値、
 * staff は職員が決めた値（報告の聞き返しの答え・7割と金額の欄・チャットの変更案の承認。「分からない」を選んだのも staff）、null はまだ誰も決めていない。
 * 2つはいつも setTax で一緒に書く（片方だけ書かない）
 */
export type TaxBy = "plan" | "staff"
export type TaxSource = { tax: TaxMode; taxBy: TaxBy | null }

export const taxBySchema = z.enum(["plan", "staff"]).nullable()

/** 税の設定と出どころを一緒に書く（ここ以外で tax・taxBy を書かない） */
export function setTax<T extends { tax: TaxMode; taxBy?: TaxBy | null }>(t: T, tax: TaxMode, by: TaxBy | null): T {
  return t.tax === tax && t.taxBy === by ? t : { ...t, tax, taxBy: by }
}

/**
 * 計画の税込・税抜（plan.amountTax）を税の設定に入れる。書くのは、まだ誰も決めていないときと、前の計画が決めた値のままのときだけ
 * （職員が決めた値は、「分からない」も含めて上書きしない）。計画が分からなければ、前の計画が決めた値を外して「まだ誰も決めていない」に戻す
 */
export function withPlanTax<T extends TaxSource>(t: T, plan: Pick<MappingPlan<string>, "amountTax">): T {
  if (t.taxBy === "staff") return t
  if (plan.amountTax) return setTax(t, plan.amountTax, "plan")
  return t.taxBy === "plan" ? setTax(t, "unknown", null) : t
}

/** 取り消しの記録に残す税の設定（前の版の記録は値だけなので、出どころは分からない＝null として読む） */
export const taxSettingSchema = z.union([
  z.object({ tax: taxSchema, taxBy: taxBySchema }),
  taxSchema.transform((tax) => ({ tax, taxBy: null })),
])
export type TaxSetting = TaxSource

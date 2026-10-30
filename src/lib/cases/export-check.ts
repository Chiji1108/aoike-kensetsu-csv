import type { RowResult } from "../convert/convert"
import type { Basis, GyoshuSummary } from "../convert/koji-selection"
import { nonCp932Chars } from "../convert/text"
import { fieldLabel, KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"

/**
 * 書き出す前の確認（CSV・取り込み用の Excel）。決まった検査の残り（エラー・要確認）と、Excel の「CSV で保存」で「?」になる文字、
 * 決算書の業種ごとの完成工事高（基準額）と表の合計の食い違いをまとめる。止めずに知らせる（書き出すかは職員が決める）
 */

type Row = RowResult<KojiFieldId>

export type ExportIssue = { status: "error" | "warning"; field: KojiFieldId; message: string; count: number }

export type BasisMismatch = { code: string; label: string; side: "total" | "motouke"; entered: number; rows: number; diff: number }

export type ExportCheck = {
  rows: number
  errors: number
  warnings: number
  /** 項目と内容ごとの件数（多い順） */
  issues: ExportIssue[]
  /** Shift_JIS（CP932）で書けない文字のあるセル（Excel の保存では黙って「?」になる） */
  unencodable: { field: KojiFieldId; chars: string[]; rowKey: string }[]
  /** 7割に届いていない業種 */
  short: { code: string; label: string; side: "total" | "motouke" }[]
  /** 入れた基準額（決算書の額）と表の行の合計（どちらも7割の計算の税）が合わない業種 */
  mismatches: BasisMismatch[]
}


/**
 * 基準額と行の合計が「合う」幅（千円）。行ごとに千円未満を切り捨て・四捨五入するので、行の数だけずれうる
 */
const tolerance = (count: number) => Math.max(1, count)

export function exportCheck(output: readonly Row[], summary: readonly GyoshuSummary[], basis: Basis): ExportCheck {
  const byIssue = new Map<string, ExportIssue>()
  let errors = 0
  let warnings = 0
  const unencodable: ExportCheck["unencodable"] = []
  for (const r of output) {
    for (const f of KOJI_KEIREKI.fields) {
      const c = r.cells[f.id]
      const bad = nonCp932Chars(c.value)
      if (bad.length) unencodable.push({ field: f.id, chars: [...new Set(bad)], rowKey: r.key })
      if (c.status !== "error" && c.status !== "warning") continue
      if (c.status === "error") errors++
      else warnings++
      const message = (c.message ?? "").split(" / ").at(-1) || (c.status === "error" ? "エラー" : "要確認")
      const k = `${c.status}\u0000${f.id}\u0000${message}`
      const now = byIssue.get(k)
      byIssue.set(k, { status: c.status, field: f.id, message, count: (now?.count ?? 0) + 1 })
    }
  }
  const issues = [...byIssue.values()].sort((a, b) => (a.status === b.status ? b.count - a.count : a.status === "error" ? -1 : 1))
  const short = summary.flatMap((g) => [
    ...(g.short.total ? [{ code: g.code, label: g.label, side: "total" as const }] : []),
    ...(g.short.motouke ? [{ code: g.code, label: g.label, side: "motouke" as const }] : []),
  ])
  const mismatches: BasisMismatch[] = []
  for (const g of summary) {
    const entered = basis[g.code]
    for (const side of ["total", "motouke"] as const) {
      const v = entered?.[side]
      if (v === undefined || v <= 0) continue
      const rows = Math.round(side === "total" ? g.total : g.motoukeTotal)
      const diff = v - rows
      if (Math.abs(diff) > tolerance(g.count)) mismatches.push({ code: g.code, label: g.label, side, entered: v, rows, diff })
    }
  }
  return { rows: output.length, errors, warnings, issues, unencodable, short, mismatches }
}

export const issueLabel = (i: ExportIssue) => `${fieldLabel(i.field)}: ${i.message}`

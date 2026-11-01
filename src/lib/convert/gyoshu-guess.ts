import { z } from "zod"
import { codeLabel, GYOSHU } from "../spec/code-sets"
import type { KojiFieldId } from "../spec/koji-keireki"
import type { CellEdit, RowResult } from "./convert"

/**
 * 業種コードの推定の決まり（1か所）。変換の AI（ai-tasks の gyoshu）・「AI で案を出す」（suggestGyoshu）・チャットの指示で同じ文を使う。
 * 業種は事務所が決めるもの（顧客には聞かない）。推し量った値は推定の印を付け、根拠を短く添えて職員が承認する。
 * ほかの工事の傾向（何件中何件が何の業種か）は決まった処理で数えて渡す（AI に数えさせない）
 */
export const GYOSHU_GUESS_RULE =
  "業種コードは、まず元データの業種の記載（業種・工種の列、備考）で決め、無ければ工事名の言葉で決める（例: 照明・受変電・弱電→電気、空調・給排水・衛生→管、内装・クロス・間仕切→内装仕上）。それでも決まらないときだけ、同じ案件のほかの工事の業種の傾向（こちらで数えて渡したもの）から推し量ってよい。推し量った値は推定（needsReview を true）にし、note に根拠を短く書く（例「ほかの工事 40 件中 35 件が電気」）。傾向がはっきりしない（いちばん多い業種がほかの工事の半分に満たない）ときは推し量らず空にする。"

/** AI の案の根拠の種類。source: 元データの記載、workName: 工事名、trend: ほかの工事の傾向（推定）、none: 決められない */
export const GYOSHU_BASES = ["source", "workName", "trend", "none"] as const
export type GyoshuBasis = (typeof GYOSHU_BASES)[number]
export const GYOSHU_BASIS_LABELS: Record<GyoshuBasis, string> = { source: "元データの記載から", workName: "工事名から", trend: "推定: ほかの工事の傾向", none: "決められない" }

/** 「AI で案を出す」の AI の1件の答え */
export const gyoshuSuggestionItem = z.object({
  id: z.number().int(),
  value: z.string(),
  basis: z.enum(GYOSHU_BASES),
  note: z.string(),
})
export type GyoshuSuggestion = z.infer<typeof gyoshuSuggestionItem>

type Row = RowResult<KojiFieldId>

/** ほかの工事の業種の傾向（業種コードが決まっている行の、業種ごとの件数。多い順） */
export type GyoshuTrend = { total: number; counts: { code: string; count: number }[] }

/**
 * 傾向を数える。対象の行（targets）と、業種が決まっていない・推定の行は数えない（推定から推定を重ねない）。載せない行も同じ案件の工事なので数える
 */
export function gyoshuTrend(rows: readonly Row[], targets: ReadonlySet<string>): GyoshuTrend {
  const counts = new Map<string, number>()
  let total = 0
  for (const r of rows) {
    const c = r.cells.gyoshu
    if (targets.has(r.key) || c.guessed || c.status === "error" || !codeLabel("gyoshu", c.value)) continue
    counts.set(c.value, (counts.get(c.value) ?? 0) + 1)
    total++
  }
  return { total, counts: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || Number(a.code) - Number(b.code)) }
}

/** 傾向の言葉（AI に渡し、根拠にも使う。例「ほかの工事 40 件中 35 件が電気（8）、5 件が管（9）」）。上位 5 業種まで */
export function trendText(t: GyoshuTrend): string {
  if (!t.total) return "ほかの工事の業種: 決まっている工事がない"
  const top = t.counts.slice(0, 5).map((c) => `${c.count} 件が${codeLabel("gyoshu", c.code)}（${c.code}）`)
  return `ほかの工事の業種: ${t.total} 件中 ${top.join("、")}`
}

/** AI に送る1件（工事名・注文者は画面の値〔個人名は記号のまま〕、元の業種の記載は変換する前の値） */
export function suggestionInput(r: Row): string {
  const c = r.cells
  return [`工事名: ${c.workName.value || "（空）"}`, `注文者: ${c.client.value || "（空）"}`, `元の業種の記載: ${c.gyoshu.original || "（なし）"}`].join(" / ")
}

/**
 * AI の答えを手直しの案にする。コード表に無い値・決められないものは案にしない（数えて知らせる）。
 * 推し量った値（trend）は承認するまで推定の印を付けて見せ、承認したら職員が確かめた値として入る（根拠は注意書きに残す）
 */
export function suggestionEdits(rows: ReadonlyMap<number, Row>, results: ReadonlyMap<number, GyoshuSuggestion>) {
  const edits: { rowKey: string; edit: CellEdit; basis: GyoshuBasis }[] = []
  let undecided = 0
  for (const [id, row] of rows) {
    const r = results.get(id)
    const code = r?.value.normalize("NFKC").trim() ?? ""
    if (!r || r.basis === "none" || !GYOSHU.some((g) => g.code === code)) {
      undecided++
      continue
    }
    if (code === row.cells.gyoshu.value && !row.cells.gyoshu.guessed && row.cells.gyoshu.status !== "error") continue
    const note = r.note.trim().slice(0, 120)
    edits.push({ rowKey: row.key, basis: r.basis, edit: { value: code, by: "chat", message: `AI の案（${GYOSHU_BASIS_LABELS[r.basis]}）${note ? `: ${note}` : ""}` } })
  }
  return { edits, undecided }
}

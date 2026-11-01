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
  "業種コードは、まず元データの業種の記載（業種・工種の列、備考）で決め、無ければ工事名の言葉で決める（例: 照明・受変電・弱電→電気、空調・給排水・衛生→管、内装・クロス・間仕切→内装仕上）。それでも決まらないときだけ、同じ案件のほかの工事の業種の傾向（こちらで数えて渡したもの）から推し量ってよい。推し量ってよいのは、こちらが「傾向がはっきりしている」と渡した業種だけ（いちばん多い業種がほかの工事の6割以上）。推し量った値は推定（needsReview を true）にし、note に根拠を短く書く（例「ほかの工事 40 件中 35 件が電気」）。傾向がはっきりしないときは推し量らず空にする。"

/** AI の案の根拠の種類。source: 元データの記載、workName: 工事名、trend: ほかの工事の傾向（推定）、none: 決められない */
export const GYOSHU_BASES = ["source", "workName", "trend", "none"] as const
export type GyoshuBasis = (typeof GYOSHU_BASES)[number]
export const GYOSHU_BASIS_LABELS: Record<GyoshuBasis, string> = { source: "元データの記載から", workName: "工事名から", trend: "ほかの工事の傾向から", none: "決められない" }

/** 「AI で案を出す」の AI の1件の答え */
export const gyoshuSuggestionItem = z.object({
  id: z.number().int(),
  value: z.string(),
  basis: z.enum(GYOSHU_BASES),
  /** 迷わず決められたか（false なら案にしない） */
  confident: z.boolean(),
  note: z.string(),
})
export type GyoshuSuggestion = z.infer<typeof gyoshuSuggestionItem>

type Row = RowResult<KojiFieldId>

/** ほかの工事の業種の傾向（業種コードが決まっている行の、業種ごとの件数。多い順） */
export type GyoshuTrend = { total: number; counts: { code: string; count: number }[] }

/** 傾向から推し量ってよい業種（いちばん多い業種がほかの工事の6割以上で、ほかの工事が5件以上）。照合で、2つの業種が半々（5割台）の案件では推し量ると外れ、7割・9割近い案件では当たった */
const DOMINANT_SHARE = 0.6
const MIN_TREND_ROWS = 5
export function dominantGyoshu(t: GyoshuTrend): string | undefined {
  const top = t.counts[0]
  return top && t.total >= MIN_TREND_ROWS && top.count >= t.total * DOMINANT_SHARE ? top.code : undefined
}

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
  const dominant = dominantGyoshu(t)
  return `ほかの工事の業種: ${t.total} 件中 ${top.join("、")}。${dominant ? `傾向がはっきりしている: ${codeLabel("gyoshu", dominant)}（${dominant}）` : "傾向ははっきりしない（推し量らない）"}`
}

/** AI に送る1件（工事名・注文者は画面の値〔個人名は記号のまま〕、元の業種の記載は変換する前の値） */
export function suggestionInput(r: Row): string {
  const c = r.cells
  return [`工事名: ${c.workName.value || "（空）"}`, `注文者: ${c.client.value || "（空）"}`, `元の業種の記載: ${c.gyoshu.original || "（なし）"}`].join(" / ")
}

/**
 * AI の答えを手直しの案にする。コード表に無い値・決められないものは案にしない（数えて知らせる）。
 * AI が迷った値（confident が false）は案にしない。推し量った値（trend）は、傾向がはっきりしている業種（dominantGyoshu）のときだけ案にする。
 * 工事名・傾向から決めた値は推定の印（guessed）を付けて見せ、承認したら職員が確かめた値として入る（confirmedChange。根拠は注意書きに残す）
 */
export function suggestionEdits(rows: ReadonlyMap<number, Row>, results: ReadonlyMap<number, GyoshuSuggestion>, trend: GyoshuTrend) {
  const dominant = dominantGyoshu(trend)
  const edits: { rowKey: string; edit: CellEdit; basis: GyoshuBasis }[] = []
  let undecided = 0
  for (const [id, row] of rows) {
    const r = results.get(id)
    const code = r?.value.normalize("NFKC").trim() ?? ""
    // 傾向から推し量った値は、決まった処理で数えた「はっきりしている」業種のときだけ受け取る
    if (!r || r.basis === "none" || !r.confident || !GYOSHU.some((g) => g.code === code) || (r.basis === "trend" && code !== dominant)) {
      undecided++
      continue
    }
    if (code === row.cells.gyoshu.value && !row.cells.gyoshu.guessed && row.cells.gyoshu.status !== "error") continue
    const note = r.note.trim().slice(0, 120)
    // 元データの記載から決めた値のほかは推定（工事名・傾向から推し量った）。承認するまで推定の印で見せる
    const guessed = r.basis !== "source"
    edits.push({ rowKey: row.key, basis: r.basis, edit: { value: code, by: "chat", message: `AI の案（${GYOSHU_BASIS_LABELS[r.basis]}）${note ? `: ${note}` : ""}`, ...(guessed ? { guessed: true as const } : {}) } })
  }
  return { edits, undecided }
}

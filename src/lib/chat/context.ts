import { columnLetter, type MappingPlan, type SheetGrid } from "../convert/plan"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"

/** AI に渡す案件の文脈: 元データの見出しと数行、今の列の対応。全行は送らない（AI はコードで元のファイルを読む） */
export function caseContext(sheets: readonly SheetGrid[], grid: SheetGrid, plan: MappingPlan<KojiFieldId>, previous?: { fiscalYear: number; lines: readonly string[] }) {
  /** 空でないセルだけを「列:値」で並べる */
  const row = (r: string[] | undefined) =>
    (r ?? [])
      .flatMap((c, i) => (c.trim() ? [`${columnLetter(i)}:${c.slice(0, 30)}`] : []))
      .join(" | ")
  const lines = [
    `シート: ${sheets.map((s) => `${s.name}（${s.rows.length}行）`).join("、")}。計画の元は「${grid.name}」（使うシート: ${plan.sheets.join("、")}）`,
    `見出し（${plan.headerRow + 1}行目）: ${row(grid.rows[plan.headerRow])}`,
    ...grid.rows.slice(plan.headerRow + 1, plan.headerRow + 4).map((r, i) => `${plan.headerRow + 2 + i}行目: ${row(r)}`),
    `データ行: ${plan.dataRows.start + 1}〜${plan.dataRows.end + 1}行目、金額の単位: ${plan.amountUnit === "yen" ? "円" : "千円"}`,
    "今の列の対応:",
  ]
  for (const f of KOJI_KEIREKI.fields) {
    const p = plan.fields[f.id]
    const how =
      p.kind === "column"
        ? `${columnLetter(p.column)}列 → ${p.transform}${p.instruction ? `（指示: ${p.instruction}）` : ""}`
        : p.kind === "columns"
          ? `${p.columns.map(columnLetter).join("+")}列 → ${p.transform}`
          : p.kind === "flagColumns"
            ? `記号の列 ${p.columns.map((c) => `${columnLetter(c.column)}=${c.code}`).join(" ")}`
            : p.kind === "constant"
              ? `定数 ${p.value}`
              : "元データに無い"
    lines.push(`- ${f.id}: ${how}`)
  }
  if (plan.notes.length) lines.push(`計画のメモ: ${plan.notes.join(" / ")}`)
  // 去年の元の Excel と形が変わった年は、去年のルール・コードの列の名前と位置をそのまま使えない
  if (previous) lines.push(`去年（${previous.fiscalYear}年度）の元の Excel との違い（決まった処理で見出しを比べたもの）:`, ...previous.lines.map((l) => `- ${l}`))
  return lines.join("\n")
}

/** 変換の元の表が無い案件（届いたファイルが PDF だけ）の文脈。AI がファイルを読んで一から表を作る */
export const NO_SOURCE_CONTEXT = [
  "変換の元の表はありません（届いたファイルは PDF など、表として読めないもの）。今の表は空か、前に足した行だけ。",
  "コンテナのファイル（PDF は pypdf などで読む）から工事を読み取り、add_rows で行を足す。足した行はすべて要確認として職員に見せる。",
  "読み取れない値は空のままにし、推測で埋めない（空の欄は顧客への問い合わせに回る）。",
].join("\n")

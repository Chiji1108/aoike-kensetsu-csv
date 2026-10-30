import { CODE_SETS } from "../spec/code-sets"
import { lastNonBlankRow, rowIsBlank, sheetOverlaps } from "./sources"
import type { CsvSpec, ValueType } from "../spec/types"
import { autoFillOf } from "../spec/types"
import { AI_TASKS, type AiBatchRequest } from "./ai-tasks"
import { columnCount, columnLetter, type MappingPlan, type SheetGrid } from "./plan"
import { TRANSFORMS, transformsFor, type Transform } from "./transforms"

function describeType(vt: ValueType) {
  switch (vt.type) {
    case "code":
      return `コード（${CODE_SETS[vt.set].map((c) => `${c.code}=${c.label}`).join(" ")}）`
    case "text":
      return "文字列"
    case "prefecture":
      return "都道府県名"
    case "thousandYen":
      return `千円単位の整数（${vt.maxDigits}桁まで）`
    case "yearMonth":
      return "西暦 YYYYMM"
    case "flag":
      return "0/1"
    case "personName":
      return "氏名（姓と名の間に全角スペース）"
  }
}

/**
 * システムプロンプト。定義表と変換の登録表だけから作るので、リクエストごとに同じ文字列になりキャッシュが効く。
 */
export function systemPrompt<F extends string>(spec: CsvSpec<F>) {
  const fields = spec.fields
    .map((f) => ({ f, autoFill: autoFillOf(spec, f) }))
    .map(
      ({ f, autoFill }) =>
        `- ${f.id}（${f.letter}列・${f.label}${f.required ? "・必須" : ""}）: ${describeType(f.valueType)}。${f.description}` +
        (autoFill ? `。元データに無ければ自動で埋める（${autoFill}）ので、合う列が無ければ missing にする` : "") +
        `。使える変換: ${transformsFor(f.valueType)
          .map((t) => t.id)
          .join(", ")}`,
    )
    .join("\n")
  // どの項目にも使えない変換（前の版の保存済みの計画を読むためだけに残したもの）は出さない
  const transforms = Object.values(TRANSFORMS)
    .filter((t: Transform) => spec.fields.some((f) => transformsFor(f.valueType).some((x) => x.id === t.id)))
    .map((t: Transform) => `- ${t.id}: ${t.label}${t.multiColumn ? "（複数列可。columns の順に渡す）" : ""}`)
    .join("\n")
  const tasks = Object.entries(AI_TASKS)
    .map(([id, t]) => `- ${id}: ${t.instruction}`)
    .join("\n")

  return `あなたは行政書士事務所の職員を手伝い、顧客から受け取った工事経歴の表を、書類作成ソフト「建設業.NET」に取り込む「${spec.title}」CSVに変換する。

## 出力するCSVの列（${spec.fields.length}列、順序固定）
${fields}

## 公式の記載ルール
${spec.writingRules.map((r) => `- ${r}`).join("\n")}

## 変換の一覧（列の計画で transform に指定する）
${transforms}
rule.motoukeShitauke は columns に [元請/下請の列, 官民の区分の列] か [元請/下請の列, 注文者の列] を渡すと、官公庁元請か民間元請かを判定する。
rule.joinWorkName は複数の列（現場名１・現場名２など）を区切りなしでつなぎ、空白と先頭の「(仮称)」を除く。
ai.inferPrefecture / ai.inferPlace は columns に [工事名の列…, 注文者の列] を渡すと、AI が工事場所を推定する。都道府県・場所名が元データに無い（列が無い・列が空）ときだけ使う。

## 列の計画を作るとき
- ブックの全部のシートの抜粋を渡す。まず工事の一覧（工事ごとに1行）のシートを選び、sheets の先頭に名前を書く。顧客一覧・技術者の一覧・集計・メモなど工事の一覧でないシートは、行が多くても選ばない。
- 工事が同じ見出し（同じ行に同じ並びの見出し）の複数のシートに分かれている（年度ごと・部署ごとなど）ときだけ、2枚目以降を sheets に足す。ほかのシートの写し（行の内容のほとんどが別のシートにもある、業種ごとにフィルタをかけたシートなど）は足さない。
- sheetReason に、そのシートを選んだ理由を職員向けに短く書く（他のシートを選ばなかった理由も、あれば）。
- 見出し行・データの行・列番号は、すべて sheets の先頭のシートのもの。
- 行番号・列番号は 0 始まり。表題行・空行の後に見出し行があることが多い。
- dataStart はデータの最初の行。データの終わりはこちらでシートの最後の空でない行とする。データでない行（合計行・小計行・空行・注記行、表の後ろの注記・署名・作成者など）は、見える範囲のものをすべて skipRows に入れる。
- fields には全項目を必ず1つずつ入れる。元データの列から作れるなら column / columns、全行同じ値なら constant（reason に理由）、無ければ missing。
- 見出しが業種名（電気工事・管工事など）で値が「○」などの記号だけの列が並んでいるときは、gyoshu を flagColumns にし、columns に各列と業種コードを入れる（記号が無い業種の列も入れる）。1行に記号が複数あれば行が分かれる。
- 見出しはあっても値が入っていない列は、無いものとして扱う（列ごとの値の例を見る）。
- 1つの列から複数の項目を作ってよい（住所 → 都道府県と場所名、工期 → 着工と完成）。
- ai.freeform を使うときだけ instruction に指示文を書く。それ以外は instruction は null。
- amountUnit は請負代金の列が円か千円か。見出しや値の桁から判断する。
- excludeColumns には「工事実績から除外」のように、値があればその行を出力しない列を入れる（無ければ空）。
- unusedColumns には使わない列を理由つきで、notes には職員への注意（金額が税込か不明、など）を短く書く。

## 値ごとの判断を頼まれたとき
items の各 input について、results に同じ id で1件ずつ返す。推測で埋めず、迷うものは needsReview を true にして note に理由を書く。
${tasks}`
}

function tsvRows(rows: { index: number; cells: string[] }[]) {
  const width = rows.reduce((n, r) => Math.max(n, r.cells.length), 0)
  const head = ["行", ...Array.from({ length: width }, (_, c) => `${c}(${columnLetter(c)})`)].join("\t")
  const body = rows.map((r) => [String(r.index), ...r.cells.map((c) => c.replace(/[\t\r\n]+/g, " "))].join("\t"))
  return [head, ...body].join("\n")
}

/** 計画の AI に渡す1枚のシートの抜粋 */
export type SheetExcerpt = {
  name: string
  rowCount: number
  columnCount: number
  hiddenCount: number
  /** 先頭と末尾の行（重複なし）。抜粋の大きさの上限に合わせて、シートが多いと減らす */
  rows: { index: number; cells: string[] }[]
  /** 列ごとの空でない行数と値の例（先頭・末尾だけでは分からない、ほとんど空の列や記号の列のため） */
  columns: { index: number; filled: number; examples: string[] }[]
  /** 行の内容がいちばん多く重なる別のシートと、その割合（%。sheetOverlaps。フィルタをかけた写しを見分ける） */
  overlap?: { sheet: string; percent: number }
}

/** 計画の AI に渡すブックの抜粋 */
export type PlanExcerpt = {
  sheets: SheetExcerpt[]
  /** 職員が計画の元に指定したシート（無ければ AI が選ぶ） */
  requiredSheet?: string
  /** 同じ顧客の去年の列の対応と、去年の Excel との違い（previousPlanContext。参考） */
  previous?: string
}

function sheetSection(s: SheetExcerpt) {
  const head = `### シート「${s.name}」（全${s.rowCount}行・${s.columnCount}列、うち非表示${s.hiddenCount}行）${
    s.overlap ? `\n行の内容の${s.overlap.percent}%はシート「${s.overlap.sheet}」にもある。` : ""
  }`
  if (!s.rows.length) return `${head}\n（空のシート）`
  const columns = s.columns.map((c) => `${c.index}(${columnLetter(c.index)}): ${c.filled}行 ${JSON.stringify(c.examples)}`).join("\n")
  return `${head}

${tsvRows(s.rows)}

列ごとの空でない行数と値の例（全行から）:
${columns}`
}

export function planUserMessage(excerpt: PlanExcerpt) {
  const ask = excerpt.requiredSheet
    ? `職員がシート「${excerpt.requiredSheet}」を計画の元に指定しました。sheets の先頭はこのシートにし、このシートの列の計画を作ってください。`
    : "工事の一覧のシートを選び、そのシートの列の計画を作ってください。"
  return `ブックの全${excerpt.sheets.length}枚のシートの先頭と末尾です。${ask}

${excerpt.sheets.map(sheetSection).join("\n\n")}${excerpt.previous ? `\n\n${excerpt.previous}` : ""}`
}

/** 去年の文脈の文字数の上限（列の多い表でも計画の指示が大きくなりすぎないように） */
export const MAX_PREVIOUS_CONTEXT = 8_000

/**
 * 列の計画の AI に渡す、同じ顧客の去年の列の対応（列は去年の見出しの名前で書く。列の位置は年で変わる）と、去年の Excel との違い
 * （format-diff の文）。そのまま当てはめさせず、今年の見出しと値で決めさせる
 */
export function previousPlanContext<F extends string>(spec: CsvSpec<F>, p: { fiscalYear: number; grid: SheetGrid; plan: MappingPlan<F>; diff: readonly string[] }) {
  const header = (c: number) => `「${(p.grid.rows[p.plan.headerRow]?.[c] ?? "").trim() || `${columnLetter(c)}列（見出しなし）`}」`
  const lines = spec.fields.map((f) => {
    const fp = p.plan.fields[f.id]
    const how =
      fp.kind === "column"
        ? `${header(fp.column)} → ${fp.transform}`
        : fp.kind === "columns"
          ? `${fp.columns.map(header).join("+")} → ${fp.transform}`
          : fp.kind === "flagColumns"
            ? `記号の列 ${fp.columns.map((c) => `${header(c.column)}=${c.code}`).join(" ")}`
            : fp.kind === "constant"
              ? `定数 ${fp.value}`
              : "元データに無い"
    return `- ${f.id}: ${how}`
  })
  const text = [
    `## 参考: 同じ顧客の去年（${p.fiscalYear}年度）の列の対応`,
    "去年の Excel をこう読んだ（職員が確かめた計画）。今年もこの読み方が当てはまるかは、今年の見出しと値で確かめて決める。去年の列の名前・位置・意味が今年と違うことがある（下の違いを見る）。",
    `去年のシート「${p.plan.sheets.join("、")}」、見出し ${p.plan.headerRow + 1}行目、金額の単位: ${p.plan.amountUnit === "yen" ? "円" : "千円"}`,
    ...lines,
    "去年の Excel との違い（決まった処理で見出しを比べたもの）:",
    ...p.diff.map((l) => `- ${l}`),
  ].join("\n")
  return text.length > MAX_PREVIOUS_CONTEXT ? `${text.slice(0, MAX_PREVIOUS_CONTEXT)}\n（長いので省いた）` : text
}

export function batchUserMessage(req: AiBatchRequest) {
  const task = AI_TASKS[req.task]
  return `作業: ${req.task}（${task.label}）
${req.instruction ? `職員の指示: ${req.instruction}\n` : ""}items:
${JSON.stringify(req.items)}`
}

const MAX_EXAMPLES = 6
/** 抜粋に入れるシートの数・セルの数の上限（シートの多いブックでも計画の指示が大きくなりすぎないように） */
export const MAX_EXCERPT_SHEETS = 30
export const MAX_EXCERPT_CELLS = 10_000
const HEAD = 30
const TAIL = 10
/** シートが多くて行を減らすときも、これだけは残す */
const MIN_HEAD = 8
const MIN_TAIL = 3

/** 1枚のシートの抜粋: 先頭 head 行・最後の空でない行までの末尾 tail 行（重複なし）と、列ごとの値の例 */
function sheetExcerpt(grid: SheetGrid, head: number, tail: number, overlap?: { sheet: string; ratio: number }): SheetExcerpt {
  const n = grid.rows.length
  // 書式だけの空行がシートの後ろに続いても、表の後ろの注記が AI に見えるように、末尾は最後の空でない行から数える
  const last = n ? lastNonBlankRow(grid) + 1 : 0
  const idx = [...new Set([...Array.from({ length: Math.min(head, n) }, (_, i) => i), ...Array.from({ length: Math.min(tail, last) }, (_, i) => last - Math.min(tail, last) + i)])]
  const width = columnCount(grid)
  const empty = grid.rows.every(rowIsBlank)
  return {
    name: grid.name,
    rowCount: n,
    columnCount: width,
    hiddenCount: grid.hidden.filter(Boolean).length,
    rows: empty ? [] : idx.map((i) => ({ index: i, cells: grid.rows[i]!.map((c) => c.slice(0, 200)) })),
    columns: empty
      ? []
      : Array.from({ length: width }, (_, c) => {
          const values = grid.rows.map((r) => r[c]?.trim() ?? "").filter(Boolean)
          return { index: c, filled: values.length, examples: [...new Set(values.slice(1))].slice(0, MAX_EXAMPLES).map((v) => v.slice(0, 40)) }
        }),
    ...(overlap ? { overlap: { sheet: overlap.sheet, percent: Math.floor(overlap.ratio * 100) } } : {}),
  }
}

/**
 * 計画の AI に送るブックの抜粋。全部のシート（MAX_EXCERPT_SHEETS 枚まで）の先頭30行・末尾10行と列ごとの値の例。
 * セルの合計が MAX_EXCERPT_CELLS を超えるときは、どのシートも同じ割合で行を減らす（どのシートが工事の一覧かは AI が決めるので、シートで差をつけない）
 */
export function planExcerpt(sheets: readonly SheetGrid[], headerRowOf: (grid: SheetGrid) => number, requiredSheet?: string): PlanExcerpt {
  const listed = sheets.slice(0, MAX_EXCERPT_SHEETS)
  // 重なりはデータの行だけで比べる（見出しの行は見出しからの推定）
  const overlaps = sheetOverlaps(listed.map((grid) => ({ grid, headerRow: headerRowOf(grid) })))
  const cells = (head: number, tail: number) => listed.reduce((sum, g) => sum + Math.min(g.rows.length, head + tail) * columnCount(g), 0)
  const scale = Math.min(1, MAX_EXCERPT_CELLS / Math.max(1, cells(HEAD, TAIL)))
  let head = Math.max(MIN_HEAD, Math.floor(HEAD * scale))
  let tail = Math.max(MIN_TAIL, Math.floor(TAIL * scale))
  // 下限の行でも上限を超える（列の多いシートがたくさんある）ときは、先頭だけ減らす
  while (head > 1 && cells(head, tail) > MAX_EXCERPT_CELLS) head--
  if (cells(head, tail) > MAX_EXCERPT_CELLS) tail = 0
  return {
    sheets: listed.map((g) => sheetExcerpt(g, head, tail, overlaps.get(g.name))),
    ...(requiredSheet ? { requiredSheet } : {}),
  }
}

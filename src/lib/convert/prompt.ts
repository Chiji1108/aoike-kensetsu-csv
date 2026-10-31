import { z } from "zod"
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
- ブックのシートの抜粋を渡す（工事の一覧の候補でないシートは要約だけ）。まず工事の一覧（工事ごとに1行）のシートを選び、sheets の先頭にそのシートの番号（「### シート n」の n）を書く。シートは名前でなく番号で返す。顧客一覧・技術者の一覧・集計・メモなど工事の一覧でないシートは、行が多くても選ばない。
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
- amountTax は請負代金の列の金額が税込か税抜か。見出し・表題・注記に「税込」「税抜」「消費税込」などとはっきり書いてあるときだけ included / excluded にする。書いていなければ推測せず unknown（職員が顧客に確かめる）。
- unusedColumns には使わない列を理由つきで書く。
- asks は職員に答えを選んでもらう聞き返し。種類は次の2つだけ。対象の行は「column の列の値が values のどれか」（values が空なら「column の列に値がある」）で決まるように書く（こちらでその行を数えて職員に見せ、答えで行を載せる・載せないを決める）。values には列ごとの値の例にある値をそのまま書く。
  - unfinished: 未成の工事（完成していない工事）の行がある。column は未成／完成の区分の列、values は未成を表す値（例: 「未成」「施工中」）。職員が「完成だけ載せる／未成も載せる」を選ぶ。
  - doubtful: 載せるか迷う行がある（メモの列に「重複」「対象外」「削除済み」などの注記がある行など）。column はその注記の列、values は迷う値（列に値がある行すべてなら空）。職員が「載せない／載せる」を選ぶ。
  text は状況を職員向けに1文で短く書く（例: 「F列が「未成」の行は完成していない工事です。」）。「確認してください」で終えない（答えの選択肢はこちらが出す）。どちらでもない、行で決められないことは asks にせず notes に書く。excludeColumns に入れた列は asks にしない。
- notes は職員が知っておくべきこと（答えは要らない知らせ）だけを、1件1文で短く、多くても3件まで書く（例: 備考に「追加工事あり」とある行は、金額に追加分が入っているかもしれない）。事実と気づいたことを書き、「確認してください」「確かめてください」で終えない。無ければ空にする。asks に書いたこと、こちらで決まった処理として行うこと（無い列の自動補完、個人名の匿名化、都道府県の補完、7割の選定、千円への丸め）、空の必須の項目や AI の推定（こちらで行ごとに印を付けて表に出す）、どの列を使ったかの説明、amountTax で答えた税込・税抜は notes に書かない。

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
  /** ブックの中のシートの番号（0 から）。AI はシートを名前でなくこの番号で返す（名前の書き間違いで計画が壊れないように） */
  index: number
  name: string
  rowCount: number
  columnCount: number
  hiddenCount: number
  /** 要約だけ（見出しらしい行と数行。列ごとの値の例は無い）。工事の一覧の候補でないシート */
  summary: boolean
  /** 抜粋の行（重複なし。左から MAX_EXCERPT_COLUMNS 列まで）。詳しいシートは先頭と末尾、要約は先頭と見出しらしい行のまわり */
  rows: { index: number; cells: string[] }[]
  /** 列ごとの空でない行数と値の例（先頭・末尾だけでは分からない、ほとんど空の列や記号の列のため。要約には無い） */
  columns: { index: number; filled: number; examples: string[] }[]
  /** データの行がいちばん多く重なる別のシートと、その割合（%。sheetOverlaps。フィルタをかけた写しを見分ける） */
  overlap?: { sheet: string; percent: number }
}

/** 計画の AI に渡すブックの抜粋 */
export type PlanExcerpt = {
  /** ブックの全シート数（送らなかったシートも数える） */
  sheetCount: number
  sheets: SheetExcerpt[]
  /** 職員が計画の元に指定したシートの番号（無ければ AI が選ぶ。指定があれば、そのシートと見出しが同じシートだけを送る） */
  requiredSheet?: number
  /** 同じ顧客の去年の列の対応と、去年の Excel との違い（previousPlanContext。参考） */
  previous?: string
}

function sheetSection(s: SheetExcerpt) {
  const cut = s.columnCount > MAX_EXCERPT_COLUMNS ? `${MAX_EXCERPT_COLUMNS + 1}列目から右は省いた。` : ""
  const head = `### シート ${s.index}「${s.name}」（全${s.rowCount}行・${s.columnCount}列、うち非表示${s.hiddenCount}行）${s.summary ? "要約: 先頭と見出しらしい行のまわりだけ。" : ""}${cut}${
    s.overlap ? `\nデータの行の${s.overlap.percent}%はシート「${s.overlap.sheet}」にもある。` : ""
  }`
  if (!s.rows.length) return `${head}\n（空のシート）`
  if (s.summary) return `${head}\n\n${tsvRows(s.rows)}`
  const columns = s.columns.map((c) => `${c.index}(${columnLetter(c.index)}): ${c.filled}行 ${JSON.stringify(c.examples)}`).join("\n")
  return `${head}

${tsvRows(s.rows)}

列ごとの空でない行数と値の例（全行から）:
${columns}`
}

export function planUserMessage(excerpt: PlanExcerpt) {
  const required = excerpt.sheets.find((s) => s.index === excerpt.requiredSheet)
  const intro = required
    ? `職員がシート ${required.index}「${required.name}」を計画の元に指定しました。送るのはこのシートと、見出しが同じシートだけです。sheets の先頭は ${required.index} にし、このシートの列の計画を作ってください。`
    : `ブックの全${excerpt.sheetCount}枚のシートです${excerpt.sheets.length < excerpt.sheetCount ? `（うち${excerpt.sheets.length}枚を送る）` : ""}。工事の一覧のシートを選び、そのシートの列の計画を作ってください。`
  return `${intro}

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
/** 抜粋に入れるシートの数（指定のシート・工事の一覧の候補は必ず入れる） */
export const MAX_EXCERPT_SHEETS = 30
/** 1行に入れる列の数（右は省く。列の多いシートがあっても抜粋が大きくなりすぎず、サーバーの入力の検証で落ちないように） */
export const MAX_EXCERPT_COLUMNS = 100
/** 詳しいシートのセルの合計の上限（超えるときは、詳しいシートの行を同じ割合で減らす） */
const MAX_DETAIL_CELLS = 12_000
const HEAD = 30
const TAIL = 10
/** 行を減らすときも、これだけは残す */
const MIN_HEAD = 8
const MIN_TAIL = 3
/** 要約のシートの行と列の数 */
const SUMMARY_ROWS = 6
const SUMMARY_COLUMNS = 30
/** 抜粋のセルの合計の上限（サーバーの入力の検証と同じ） */
export const MAX_EXCERPT_CELLS = MAX_DETAIL_CELLS + MAX_EXCERPT_SHEETS * SUMMARY_ROWS * SUMMARY_COLUMNS

/** 計画の AI に送るシート。headerRow は見出しからの推定（要約の行・重なりの比べ方に使う）、detail は詳しく送るか（heuristic-plan.ts の planSheets） */
export type PlanSheet = { index: number; grid: SheetGrid; headerRow: number; detail: boolean }

const rowOf = (grid: SheetGrid, i: number, width: number) => ({ index: i, cells: grid.rows[i]!.slice(0, width).map((c) => c.slice(0, 200)) })

function detailExcerpt(grid: SheetGrid, head: number, tail: number) {
  const n = grid.rows.length
  // 書式だけの空行がシートの後ろに続いても、表の後ろの注記が AI に見えるように、末尾は最後の空でない行から数える
  const last = lastNonBlankRow(grid) + 1
  const idx = [...new Set([...Array.from({ length: Math.min(head, n) }, (_, i) => i), ...Array.from({ length: Math.min(tail, last) }, (_, i) => last - Math.min(tail, last) + i)])]
  return {
    rows: idx.map((i) => rowOf(grid, i, MAX_EXCERPT_COLUMNS)),
    columns: Array.from({ length: Math.min(columnCount(grid), MAX_EXCERPT_COLUMNS) }, (_, c) => {
      const values = grid.rows.map((r) => r[c]?.trim() ?? "").filter(Boolean)
      return { index: c, filled: values.length, examples: [...new Set(values.slice(1))].slice(0, MAX_EXAMPLES).map((v) => v.slice(0, 40)) }
    }),
  }
}

/** 要約: 先頭2行と、見出しらしい行から3行（空行を除いて SUMMARY_ROWS 行まで） */
function summaryRows(grid: SheetGrid, headerRow: number) {
  const idx = [...new Set([0, 1, headerRow, headerRow + 1, headerRow + 2, headerRow + 3])].filter((i) => i < grid.rows.length && !rowIsBlank(grid.rows[i]))
  return idx.slice(0, SUMMARY_ROWS).map((i) => rowOf(grid, i, SUMMARY_COLUMNS))
}

/**
 * 計画の AI に送るブックの抜粋。詳しいシート（工事の一覧の候補・職員の指定）は先頭30行・末尾10行と列ごとの値の例、
 * ほかのシートは名前・行数と見出しらしい行のまわりだけ。詳しいシートのセルが多いときは、詳しいシートの行を同じ割合で減らす
 */
export function planExcerpt(sheetCount: number, sheets: readonly PlanSheet[], requiredSheet?: number): PlanExcerpt {
  const overlaps = sheetOverlaps(sheets)
  const detailed = sheets.filter((s) => s.detail && !s.grid.rows.every(rowIsBlank))
  const width = (g: SheetGrid) => Math.min(columnCount(g), MAX_EXCERPT_COLUMNS)
  const cells = (head: number, tail: number) => detailed.reduce((sum, s) => sum + Math.min(s.grid.rows.length, head + tail) * width(s.grid), 0)
  const scale = Math.min(1, MAX_DETAIL_CELLS / Math.max(1, cells(HEAD, TAIL)))
  let head = Math.max(MIN_HEAD, Math.floor(HEAD * scale))
  let tail = Math.max(MIN_TAIL, Math.floor(TAIL * scale))
  // 下限の行でも上限を超える（列の多いシートがたくさんある）ときは、先頭だけ減らす
  while (head > 1 && cells(head, tail) > MAX_DETAIL_CELLS) head--
  if (cells(head, tail) > MAX_DETAIL_CELLS) tail = 0
  return {
    sheetCount,
    sheets: sheets.map(({ index, grid, headerRow, detail }) => {
      const empty = grid.rows.every(rowIsBlank)
      const overlap = overlaps.get(grid.name)
      return {
        index,
        name: grid.name,
        rowCount: grid.rows.length,
        columnCount: columnCount(grid),
        hiddenCount: grid.hidden.filter(Boolean).length,
        summary: !detail,
        ...(empty ? { rows: [], columns: [] } : detail ? detailExcerpt(grid, head, tail) : { rows: summaryRows(grid, headerRow), columns: [] }),
        ...(overlap ? { overlap: { sheet: overlap.sheet, percent: Math.floor(overlap.ratio * 100) } } : {}),
      }
    }),
    ...(requiredSheet !== undefined ? { requiredSheet } : {}),
  }
}

const excerptCell = z.string().max(200)
/** サーバー関数が受け取る抜粋の検証（planExcerpt が作る形と上限。抜粋の側で上限に収めるので、どのブックでもここで落ちない） */
export const planExcerptShape = {
  sheetCount: z.number().int().min(1),
  sheets: z
    .array(
      z.object({
        index: z.number().int().min(0),
        name: z.string().max(100),
        rowCount: z.number().int().min(0),
        columnCount: z.number().int().min(0),
        hiddenCount: z.number().int().min(0),
        summary: z.boolean(),
        rows: z.array(z.object({ index: z.number().int().min(0), cells: z.array(excerptCell).max(MAX_EXCERPT_COLUMNS) })).max(HEAD + TAIL),
        columns: z.array(z.object({ index: z.number().int().min(0), filled: z.number().int().min(0), examples: z.array(z.string().max(40)).max(MAX_EXAMPLES) })).max(MAX_EXCERPT_COLUMNS),
        overlap: z.object({ sheet: z.string().max(100), percent: z.number().int().min(0).max(100) }).optional(),
      }),
    )
    .min(1)
    .max(MAX_EXCERPT_SHEETS)
    .refine((sheets) => sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.cells.length, 0), 0) <= MAX_EXCERPT_CELLS, "抜粋が大きすぎます"),
  requiredSheet: z.number().int().min(0).optional(),
}

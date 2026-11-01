import type { CellResult, CellStatus, RowResult } from "@/lib/convert/convert"
import { askReasonOf } from "@/lib/inquiry/inquiry"
import { fieldLabel, type KojiFieldId } from "@/lib/spec/koji-keireki"

export const STATUS: Record<CellStatus, { label: string; cell: string; dot: string }> = {
  ok: { label: "そのまま", cell: "", dot: "bg-muted-foreground/40" },
  changed: { label: "ルールで変換", cell: "bg-sky-50", dot: "bg-sky-500" },
  ai: { label: "AIで変換", cell: "bg-violet-50", dot: "bg-violet-500" },
  warning: { label: "要確認", cell: "bg-amber-50", dot: "bg-amber-500" },
  error: { label: "エラー", cell: "bg-red-50 text-red-900", dot: "bg-red-500" },
}

/** AI が値を補った（例: 都道府県の補完）セルは、AI の変換でも要確認として黄色で目立たせる */
const needsReview = (c: CellResult) => c.status === "warning" || (c.status === "ai" && !!c.message)

export function cellClass(c: CellResult) {
  return needsReview(c) ? STATUS.warning.cell : STATUS[c.status].cell
}

/** 表の絞り込み。直す（CSV に載せる行のうち、職員が直すセルがある行）か、すべて（載せない行も） */
export type RowFilter = "fix" | "all"

/** AI が推定した値（AI 自身も自信がない値・AI が補った値） */
const aiGuess = (c: CellResult) => c.guessed === true || (c.status === "ai" && !!c.message)

/** 元データと値が違うセル（ルール・AIで変換、補った値、手直し、顧客の回答）。表のセルの印（data-changed）に使う */
export const changedCell = (c: CellResult) => c.value !== c.original || c.by === "staff" || c.by === "customer" || c.by === "excel" || c.by === "location"

/**
 * 職員が直すセルの理由。empty: 必須が空、error: 値がエラー、review: 要確認、guess: AI の推定。
 * 顧客への問い合わせに回るセル（問い合わせのタブにあり、外していないもの）は ask（直さなくてよい。顧客の答えで埋まる）
 */
export type FixKind = "empty" | "error" | "review" | "guess"
export type CellFixKind = FixKind | "ask"

export const FIX_LABELS: Record<FixKind, string> = { empty: "必須が空", error: "エラー", review: "要確認", guess: "AI の推定" }
export const FIX_KINDS = Object.keys(FIX_LABELS) as FixKind[]

/**
 * セルを誰がどう片付けるか（片付けることが無ければ undefined）。問い合わせに回るもの（askReasonOf）は顧客に聞き、ほかは職員が直す。
 * asked は問い合わせを外していないか（外した問い合わせは、空の必須なら直す・推定なら職員が確かめる・空の任意の項目なら片付いた）
 */
export function cellFix(c: CellResult, field: string, asked: boolean): CellFixKind | undefined {
  // 顧客に聞くかは問い合わせを集めるのと同じ決まり（askReasonOf。値のあるエラーは聞かない）。1つのセルは直すか聞くかの片方にだけ数える
  if (askReasonOf(field, c) && asked) return "ask"
  if (c.status === "error") return c.value !== "" ? "error" : "empty"
  if (aiGuess(c)) return "guess"
  if (needsReview(c)) return "review"
  return undefined
}

/** 行の片付けること: 職員が直すセル（fixes）と、顧客に聞くセルの数（ask） */
export type RowFix<F extends string = string> = { fixes: { field: F; kind: FixKind }[]; ask: number }

/** 行の片付けること。isAsked(field) はそのセルの問い合わせを外していないか */
export function rowFix<F extends string>(row: RowResult<F>, isAsked: (field: F) => boolean): RowFix<F> {
  const fixes: RowFix<F>["fixes"] = []
  let ask = 0
  for (const [field, c] of Object.entries<CellResult>(row.cells) as [F, CellResult][]) {
    const kind = cellFix(c, field, isAsked(field))
    if (kind === "ask") ask++
    else if (kind) fixes.push({ field, kind })
  }
  return { fixes, ask }
}

export const NO_FIX: RowFix<never> = { fixes: [], ask: 0 }

/** 表の絞り込みの状態。reason は直すの中の理由、ask は計画の聞き返しの対象の行だけ（載せない行も） */
export type TableFilter = { kind: RowFilter; reason?: FixKind; ask?: string }

export const ROW_FILTERS: Record<RowFilter, { label: string; empty: string }> = {
  fix: { label: "直す", empty: "直す行" },
  all: { label: "すべて", empty: "行" },
}

/** 行がその絞り込みに出るか。直すは CSV に載せる行だけ（載せない行は「すべて」でだけ見える）。asked は聞き返しの対象の行か */
export function inFilter<F extends string>(filter: TableFilter, fix: RowFix<F>, included: boolean, asked: (key: string) => boolean, key: string) {
  if (filter.ask) return asked(key)
  if (filter.kind === "all") return true
  return included && (filter.reason ? fix.fixes.some((f) => f.kind === filter.reason) : fix.fixes.length > 0)
}

/** 直す行の数と、理由ごとの行の数（1行に理由が複数あれば、それぞれに数える）。表・次にやること・書き出すの確認で同じ数を使う */
export type FixCounts = { rows: number; byKind: Record<FixKind, number>; all: number }

export function countFixes<F extends string>(rows: readonly RowResult<F>[], inclusion: ReadonlyMap<string, { included: boolean }>, fixes: ReadonlyMap<string, RowFix<F>>): FixCounts {
  const byKind = Object.fromEntries(FIX_KINDS.map((k) => [k, 0])) as Record<FixKind, number>
  let n = 0
  for (const r of rows) {
    const f = fixes.get(r.key)
    if (!inclusion.get(r.key)?.included || !f?.fixes.length) continue
    n++
    for (const k of new Set(f.fixes.map((x) => x.kind))) byKind[k]++
  }
  return { rows: n, byKind, all: rows.length }
}

/** 項目の短い名前（「請負代金（千円）」→「請負代金」） */
export const shortLabel = (field: string) => fieldLabel(field as KojiFieldId).replace(/（.*）$/, "")

/** 行の理由の1つ（例:「業種が空」「工事名: AI の推定」）。表の行・次にやること・書き出すの確認で同じ言葉 */
export const fixText = (f: { field: string; kind: FixKind }) => (f.kind === "empty" ? `${shortLabel(f.field)}が空` : `${shortLabel(f.field)}: ${FIX_LABELS[f.kind]}`)

/**
 * 直し方。理由（項目と種類）ごとに、職員が押せる操作を1つ決める（1か所の表）。
 * suggestGyoshu: 業種は事務所が決めるので、AI に案を出させて職員が承認する。
 * findLocation: 工事場所は今の調査の仕組み（費用のかかる検索は工事場所のタブで職員が押して始める）。
 * askCustomer: 顧客にしか分からない項目は問い合わせへ（外した問い合わせを戻す）。
 * 表にない理由（元請下請・金額など）は、職員がセルを選んで直す
 */
export type FixActionId = "suggestGyoshu" | "findLocation" | "askCustomer"
export const FIX_ACTIONS: Record<FixActionId, { label: string; title: string }> = {
  suggestGyoshu: { label: "AI で案を出す", title: "AI が業種の案と根拠を出します。承認したものだけが表に入ります" },
  findLocation: { label: "AI で案を出す", title: "工事場所のタブを開きます。費用の目安を見てから調べ始めます" },
  askCustomer: { label: "顧客に聞く", title: "問い合わせのタブを開きます（外した問い合わせを戻すと顧客に聞きます）" },
}

const ACTION_OF_FIELD: Partial<Record<KojiFieldId, FixActionId>> = {
  gyoshu: "suggestGyoshu",
  prefecture: "findLocation",
  place: "findLocation",
  client: "askCustomer",
  workName: "askCustomer",
  startYm: "askCustomer",
  endYm: "askCustomer",
  engineer: "askCustomer",
}

/** 理由の直し方（無ければ職員がセルで直す）。値のあるエラー（コード表に無いなど）も同じ操作で直せる */
export const fixActionOf = (f: { field: string; kind: FixKind }): FixActionId | undefined => ACTION_OF_FIELD[f.field as KojiFieldId]

/** まとめて頼める直し方: 同じ操作・同じ項目の、直す行（載せる行）の key と理由の種類 */
export type FixActionGroup = { action: FixActionId; field: KojiFieldId; kinds: FixKind[]; keys: string[] }

export function fixActionGroups(rows: readonly { key: string }[], inclusion: ReadonlyMap<string, { included: boolean }>, fixes: ReadonlyMap<string, RowFix<KojiFieldId>>): FixActionGroup[] {
  const groups = new Map<string, FixActionGroup>()
  for (const r of rows) {
    if (!inclusion.get(r.key)?.included) continue
    for (const f of fixes.get(r.key)?.fixes ?? []) {
      const action = fixActionOf(f)
      if (!action) continue
      // 工事場所は都道府県と場所名を1つの現場として調べるので、1つにまとめる
      const field = action === "findLocation" ? "prefecture" : f.field
      const id = `${action}:${field}`
      const g = groups.get(id) ?? { action, field, kinds: [], keys: [] }
      if (!g.kinds.includes(f.kind)) g.kinds.push(f.kind)
      if (!g.keys.includes(r.key)) g.keys.push(r.key)
      groups.set(id, g)
    }
  }
  return [...groups.values()]
}

/** まとめて頼む操作の言葉（例「業種が空の 3 行に AI で案を出す」「注文者が空の 2 行を顧客に聞く」）。表の上・次にやること・書き出すの確認で同じ言葉 */
export function fixActionText(g: FixActionGroup) {
  const what = g.action === "findLocation" ? "工事場所" : shortLabel(g.field)
  const reasons = FIX_KINDS.filter((k) => g.kinds.includes(k)).map((k) => (k === "empty" ? "空" : FIX_LABELS[k]))
  const target = `${what}が${reasons.join("・")}の ${g.keys.length} 行`
  return g.action === "askCustomer" ? `${target}を${FIX_ACTIONS[g.action].label}` : `${target}に ${FIX_ACTIONS[g.action].label}`
}

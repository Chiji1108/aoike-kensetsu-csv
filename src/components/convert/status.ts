import type { CellResult, CellStatus, RowResult } from "@/lib/convert/convert"
import { askReasonOf } from "@/lib/inquiry/inquiry"
import { checkRow, checkValue } from "@/lib/convert/validate"
import type { Inclusion } from "@/lib/convert/koji-selection"
import { fieldLabel, KOJI_KEIREKI, type KojiFieldId } from "@/lib/spec/koji-keireki"
import { needsLookup } from "@/lib/location/sites"

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

/**
 * 行の片付けること: 職員が直すセル（fixes。action はその理由の直し方。無ければセルで直す。confirm は「これでよい」で片付くか）と、
 * 顧客に聞くセルの項目（ask）、業種の未決（gyoshu）。
 * 業種は業種のタブで7割で載りうる行とまとめて決める（決めるたびに載せる行が入れ替わる）ので、直すの理由（fixes）には入れず、
 * 「業種を決める」の段だけに数える（直すと業種を決めるで二重に数えない）
 */
export type RowFix<F extends string = string> = { fixes: { field: F; kind: FixKind; action?: FixActionId; confirm?: true }[]; ask: F[]; gyoshu?: FixKind }

/** 行の片付けること。isAsked(field) はそのセルの問い合わせを外していないか */
export function rowFix<F extends string>(row: RowResult<F>, isAsked: (field: F) => boolean): RowFix<F> {
  const fixes: RowFix<F>["fixes"] = []
  const ask: F[] = []
  let gyoshu: FixKind | undefined
  // 行をまたぐ検査は行ごとに1回だけ（「これでよい」を出すかに使う）
  let rowIssues: ReadonlyMap<KojiFieldId, unknown> | null = null
  const issuesOf = () => (rowIssues ??= checkRow(KOJI_KEIREKI, Object.fromEntries(KOJI_KEIREKI.fields.map((f) => [f.id, (row.cells as Record<string, CellResult>)[f.id]?.value ?? ""])) as Record<KojiFieldId, string>))
  for (const [field, c] of Object.entries<CellResult>(row.cells) as [F, CellResult][]) {
    const kind = cellFix(c, field, isAsked(field))
    if (kind === "ask") ask.push(field)
    else if (kind && field === "gyoshu") gyoshu = kind
    else if (kind) {
      const action = fixActionOf(field, row.cells)
      fixes.push({ field, kind, ...(action ? { action } : {}), ...(confirmable(kind, field, c, issuesOf) ? { confirm: true as const } : {}) })
    }
  }
  return gyoshu ? { fixes, ask, gyoshu } : { fixes, ask }
}

export const NO_FIX: RowFix<never> = { fixes: [], ask: [] }

/**
 * 「これでよい」: 要確認・AI の推定の値を、職員が同じ値を手で入れたのと同じ手直し（by staff）にして片付ける。
 * 手で入れた値も決まった検査（checkValue・checkRow）を通るので、検査の警告が残る値（姓と名の間の空白など）は片付かない。そういう値には出さない。
 * 検査するのは画面の値（個人名は記号）: 手直しには本当の値（印）を書くが、finalizeRows は記号にした画面の値を検査するので、手直しのあとに検査されるのもこの値
 */
export const CONFIRM_LABEL = "これでよい"
function confirmable(kind: FixKind, field: string, c: CellResult, rowIssues: () => ReadonlyMap<KojiFieldId, unknown>) {
  if ((kind !== "review" && kind !== "guess") || !c.value) return false
  const spec = KOJI_KEIREKI.fields.find((f) => f.id === field)
  return !!spec && !checkValue(spec, c.value) && !rowIssues().has(field as KojiFieldId)
}

/** 顧客に聞く印の言葉（例「配置技術者は顧客に聞く」）。どの欄を聞くのかを書き、ほかの理由（業種など）と見分ける */
export const askText = (fields: readonly string[]) => `${fields.map(shortLabel).join("・")}は顧客に聞く`

/**
 * 業種を決める行: 業種が空・エラー・要確認・AI の推定の行のうち、7割で載りうる行（載せる行と、7割の選び直しで載る側に入りうる行）。
 * 業種を決めると、その業種の7割で選ぶ行が入れ替わる。業種が決まっていない行は、どの業種になるかでどの行とも入れ替わりうるので、
 * 載せる行だけでなく、除外・手動で外した行のほかは全部を先に決める。業種がそろってから7割を選ぶと、入れ替わって入ってくる行の業種はもう決まっている
 */
export function gyoshuTodo<F extends string>(rows: readonly RowResult<F>[], inclusion: ReadonlyMap<string, Inclusion>, fixes: ReadonlyMap<string, RowFix<F>>) {
  return rows.filter((r) => {
    const inc = inclusion.get(r.key)
    return (inc?.included || inc?.reason === "unselected") && fixes.get(r.key)?.gyoshu !== undefined
  })
}

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
 * decideGyoshu: 業種は事務所が決める。業種を決めるたびに7割で載せる行が入れ替わるので、1行ずつでなく「業種」のタブの一覧で
 * 7割で載りうる行（gyoshuTodo）をまとめて決める（AI の案もそこで頼む）。
 * findLocation: 工事場所は今の調査の仕組み（費用のかかる検索は工事場所のタブで職員が押して始める）。
 * askCustomer: 顧客にしか分からない項目は問い合わせへ（外した問い合わせを戻す）。
 * 表にない理由（元請下請・金額など）は、職員がセルを選んで直す
 */
export type FixActionId = "decideGyoshu" | "findLocation" | "askCustomer"
export const FIX_ACTIONS: Record<FixActionId, { label: string; title: string }> = {
  decideGyoshu: { label: "業種を決める", title: "業種のタブを開きます。7割の選び直しで載る行も一緒に決めます" },
  findLocation: { label: "AI で案を出す", title: "工事場所のタブを開きます。費用の目安を見てから調べ始めます" },
  askCustomer: { label: "顧客に聞く", title: "問い合わせのタブを開きます（外した問い合わせを戻すと顧客に聞きます）" },
}

const ACTION_OF_FIELD: Partial<Record<KojiFieldId, FixActionId>> = {
  gyoshu: "decideGyoshu",
  prefecture: "findLocation",
  place: "findLocation",
  client: "askCustomer",
  workName: "askCustomer",
  startYm: "askCustomer",
  endYm: "askCustomer",
  engineer: "askCustomer",
}

/**
 * セルの直し方（無ければ職員がセルで直す）。行ける先と同じ判定で決める: 工事場所は一括調査が調べる行（needsLookup）だけ、
 * 顧客に聞くのは問い合わせに載るセル（askReasonOf。外した問い合わせを戻せる）だけ。値のあるエラー・職員が空にした欄などは操作を出さない
 */
export function fixActionOf(field: string, cells: Readonly<Record<string, CellResult>>): FixActionId | undefined {
  const action = ACTION_OF_FIELD[field as KojiFieldId]
  if (action === "findLocation") return cells.prefecture && cells.place && needsLookup(cells.prefecture, cells.place) ? action : undefined
  if (action === "askCustomer") return askReasonOf(field, cells[field]!) ? action : undefined
  return action
}

/** まとめて頼める直し方: 同じ操作・同じ項目の、直す行（載せる行）の key と理由の種類 */
export type FixActionGroup = { action: FixActionId; field: KojiFieldId; kinds: FixKind[]; keys: string[] }

/** reason があれば、その理由の直すだけを数える（表の理由の絞り込みで見えている分） */
export function fixActionGroups(
  rows: readonly { key: string }[],
  inclusion: ReadonlyMap<string, { included: boolean }>,
  fixes: ReadonlyMap<string, RowFix<KojiFieldId>>,
  reason?: FixKind,
): FixActionGroup[] {
  const groups = new Map<string, { action: FixActionId; field: KojiFieldId; kinds: Set<FixKind>; keys: Set<string> }>()
  for (const r of rows) {
    if (!inclusion.get(r.key)?.included) continue
    for (const f of fixes.get(r.key)?.fixes ?? []) {
      if (!f.action || (reason && f.kind !== reason)) continue
      // 工事場所は都道府県と場所名を1つの現場として調べるので、1つにまとめる
      const field = f.action === "findLocation" ? "prefecture" : f.field
      const id = `${f.action}:${field}`
      const g = groups.get(id) ?? { action: f.action, field, kinds: new Set(), keys: new Set() }
      g.kinds.add(f.kind)
      g.keys.add(r.key)
      groups.set(id, g)
    }
  }
  return [...groups.values()].map((g) => ({ action: g.action, field: g.field, kinds: [...g.kinds], keys: [...g.keys] }))
}

/** まとめて頼む操作の言葉（例「工事場所が空の 3 行に AI で案を出す」「注文者が空の 2 行を顧客に聞く」）。表の上・次にやること・書き出すの確認で同じ言葉 */
export function fixActionText(g: FixActionGroup) {
  const what = g.action === "findLocation" ? "工事場所" : shortLabel(g.field)
  const reasons = FIX_KINDS.filter((k) => g.kinds.includes(k)).map((k) => (k === "empty" ? "空" : FIX_LABELS[k]))
  const joined = reasons.join("・")
  // 「AI の推定」のように英字で始まるときは空白を挟む（「工事場所が AI の推定」）
  const target = `${what}が${/^[A-Za-z]/.test(joined) ? " " : ""}${joined}の ${g.keys.length} 行`
  return g.action === "askCustomer" ? `${target}を${FIX_ACTIONS[g.action].label}` : `${target}に ${FIX_ACTIONS[g.action].label}`
}

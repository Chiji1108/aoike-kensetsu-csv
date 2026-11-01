import type { RowResult } from "../convert/convert"
import { summarizeKoji, type GyoshuSummary } from "../convert/koji-selection"
import type { KojiFieldId } from "../spec/koji-keireki"
import { selectRows, type CaseTable } from "./view"

type Row = RowResult<KojiFieldId>
type Settings = Pick<CaseTable, "tax" | "basis" | "rule7Tax" | "selection" | "manual">

/**
 * 計画の聞き返しの「載せない」側の答えで、CSV に載せる件数と7割がどう変わるか。答えは対象の行を計画の出さない行に足す（行は「除外」になって残る）ので、
 * 対象の行を除外にした表で、今の7割の選び方・手動の入れ外しのまま選び直す（表・書き出すの確認と同じ selectRows・summarizeKoji）。
 * short は7割に届かない業種（基準額の側ごと。決算書の額を入れていない側は行の合計が基準額なので届く）。
 * targets は対象の行のうち今載せている数、dropped はそのうち答えで載らなくなる数（手で載せた行は外れない）。
 * othersDropped・swapped は対象でない行のうち、載らなくなる数（7割の元の合計が減って要らなくなる）と代わりに載る数
 */
export type AskImpact = {
  before: number
  after: number
  shortBefore: string[]
  shortAfter: string[]
  targets: number
  dropped: number
  othersDropped: number
  swapped: number
}

const EXCLUDED_BY_ANSWER = "聞き返しの答えで載せない"

const shortOf = (summary: readonly GyoshuSummary[]) =>
  summary.flatMap((g) => [
    ...(g.short.total ? [`${g.label}（完成工事高）`] : []),
    ...(g.short.motouke ? [`${g.label}（うち元請）`] : []),
  ])

const includedCount = (inclusion: ReturnType<typeof selectRows>) => [...inclusion.values()].filter((i) => i.included).length

/** current は今の表の選んだ行と7割の合計（画面がもう作ったもの。作り直さない）。答えたあとの側だけを選び直す */
export function askImpact(edited: Row[], s: Settings, keys: ReadonlySet<string>, current: { inclusion: ReturnType<typeof selectRows>; summary: readonly GyoshuSummary[] }): AskImpact {
  const without = edited.map((r) => (keys.has(r.key) && !r.excluded ? { ...r, excluded: EXCLUDED_BY_ANSWER } : r))
  const next = selectRows(s, without)
  const after = summarizeKoji(without, next, { tax: s.tax, basis: s.basis, rule7Tax: s.rule7Tax })
  const now = (k: string) => current.inclusion.get(k)?.included === true
  const later = (k: string) => next.get(k)?.included === true
  const keysNow = [...current.inclusion.keys()]
  return {
    before: includedCount(current.inclusion),
    after: includedCount(next),
    shortBefore: shortOf(current.summary),
    shortAfter: shortOf(after),
    targets: [...keys].filter(now).length,
    dropped: [...keys].filter((k) => now(k) && !later(k)).length,
    othersDropped: keysNow.filter((k) => !keys.has(k) && now(k) && !later(k)).length,
    swapped: keysNow.filter((k) => !keys.has(k) && !now(k) && later(k)).length,
  }
}

/**
 * 聞き返しのカードの言葉（数は askImpact のもの。数え直さない）。数える単位は表の行（記号の列で分けた行は別々に数える。載せる・載せないは表の行ごとなので）。
 * count は「該当 N 行」（答えたあとのカードはこれだけ。答えで載せ方が変わったあとの件数の説明は事実と合わない）、detail は今載せている数と、
 * 件数が変わらないときはその理由。件数が変わらないときは答えのボタンに件数を付けない（同じ件数を2つ並べない）。impact が無い（表をまだ作っていない）なら数だけ
 */
export function askWording(i: AskImpact | null, size: number): { count: string; detail: string; label: (value: "exclude" | "keep", label: string) => string } {
  const count = `該当 ${size} 行`
  if (!i) return { count, detail: count, label: (_, l) => l }
  const head = `${count}（今載せているのは ${i.targets} 行）`
  // 対象でない行が載らなくなる・代わりに載るのは7割の選び直しのとき（決算書の額が無ければ、7割の元は表の合計）
  const lost = i.othersDropped > 0 ? `外すと7割の元の合計も減るので、ほかの ${i.othersDropped} 行も載らなくなります` : null
  const gained =
    i.swapped === 0
      ? null
      : lost
        ? `代わりにほかの ${i.swapped} 行が7割に選ばれます`
        : i.dropped > 0
          ? `外すとこの ${i.dropped} 行の代わりにほかの ${i.swapped} 行が7割に選ばれます`
          : `外すとほかの ${i.swapped} 行が7割に選ばれます`
  const others = [lost, gained].filter(Boolean).join("。")
  if (i.before !== i.after) return { count, detail: [head, others].filter(Boolean).join("。"), label: (v, l) => (v === "exclude" ? `${l}（載せる ${i.before} → ${i.after} 件）` : `${l}（${i.before} 件のまま）`) }
  const why = others
    ? `${others}（載せる件数は ${i.before} 件のまま）`
    : i.targets === 0
      ? `どちらでも載せる件数は変わりません（この ${size} 行は今載せていません）`
      : "どちらでも載せる件数は変わりません（手で載せた行は答えでは外れません）"
  return { count, detail: `${head}。${why}`, label: (_, l) => l }
}

/** 押す前に確かめるか: 載せる件数が半分以上減る、または7割に届かなくなる（今届いている業種が届かなくなる） */
export function needsConfirm(i: AskImpact) {
  const halved = i.before > 0 && i.after <= i.before / 2
  const newlyShort = i.shortAfter.some((g) => !i.shortBefore.includes(g))
  return halved || newlyShort
}

/**
 * 対象の行がデータの行の大半（半分以上）になる聞き返しに添える事実（決まった処理で数える。AI に数えさせない）。
 * 未成の区分なら、対象の行のうち完成年月の入っている行の数（区分が締める前のまま残っているかもしれない）
 */
export function askFacts(kind: "unfinished" | "doubtful", rows: readonly Row[], keys: ReadonlySet<string>): string | undefined {
  if (!rows.length || keys.size * 2 < rows.length) return undefined
  const head = `データの ${rows.length} 行のうち ${keys.size} 行が当たります。`
  if (kind !== "unfinished") return head
  const ended = rows.filter((r) => keys.has(r.key) && r.cells.endYm.value !== "").length
  return ended ? `${head}そのうち ${ended} 行は完成年月が入っています（区分が古いままかもしれません）。` : head
}

/** 「AI に聞く」の質問に並べる元の行番号の数（多いときは残りの数だけ書く。AI は計画の聞き返しの列と値から全行を読める） */
const PROMPT_ROWS = 20

/**
 * 計画の聞き返しの「AI に聞く」で、チャットに職員の発言として送る決まった質問。どの聞き返しか取り違えないよう、聞き返しの文（チャットの指示の
 * 「この案件」にも同じ文がある）と、対象の行の元の Excel の行番号（get_table の source と同じ番号）を入れる。
 * 数はカードと同じ表の行で数え（rows は表の行、targets はそのうち今載せている数）、行番号は場所として重ねずに並べる。対象の行が無ければ作らない
 */
export function askPrompt(text: string, rows: readonly Pick<Row, "sheet" | "row">[], targets: number | null): string | undefined {
  if (!rows.length) return undefined
  const bySheet = new Map<string, Set<number>>()
  for (const r of rows) bySheet.set(r.sheet, (bySheet.get(r.sheet) ?? new Set()).add(r.row))
  let left = PROMPT_ROWS
  let rest = 0
  const parts: string[] = []
  for (const [sheet, set] of bySheet) {
    const xs = [...set].sort((a, b) => a - b)
    const shown = xs.slice(0, left)
    left -= shown.length
    rest += xs.length - shown.length
    if (shown.length) parts.push(`「${sheet}」${shown.map((x) => x + 1).join("・")}行目`)
  }
  const where = [...parts, ...(rest ? [`ほか ${rest} 行`] : [])].join("、")
  const now = targets === null ? "" : `。今載せているのは ${targets} 行`
  return `計画の聞き返し「${text}」は、どういうことですか？ 対象は表の ${rows.length} 行（元の Excel の${where}${now}）です。中身を見て、判断に要ることを教えてください。`
}

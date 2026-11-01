import type { RowResult } from "../convert/convert"
import { summarizeKoji } from "../convert/koji-selection"
import type { KojiFieldId } from "../spec/koji-keireki"
import { selectRows, type CaseTable } from "./view"

type Row = RowResult<KojiFieldId>
type Settings = Pick<CaseTable, "tax" | "basis" | "rule7Tax" | "selection" | "manual">

/**
 * 計画の聞き返しの「載せない」側の答えで、CSV に載せる件数と7割がどう変わるか。答えは対象の行を計画の出さない行に足す（行は「除外」になって残る）ので、
 * 対象の行を除外にした表で、今の7割の選び方・手動の入れ外しのまま選び直す（表・書き出すの確認と同じ selectRows・summarizeKoji）。
 * short は7割に届かない業種（基準額の側ごと。決算書の額を入れていない側は行の合計が基準額なので届く）
 */
export type AskImpact = { before: number; after: number; shortBefore: string[]; shortAfter: string[] }

const EXCLUDED_BY_ANSWER = "聞き返しの答えで載せない"

function shortOf(rows: readonly Row[], s: Settings, inclusion: ReturnType<typeof selectRows>) {
  return summarizeKoji(rows, inclusion, { tax: s.tax, basis: s.basis, rule7Tax: s.rule7Tax }).flatMap((g) => [
    ...(g.short.total ? [`${g.label}（完成工事高）`] : []),
    ...(g.short.motouke ? [`${g.label}（うち元請）`] : []),
  ])
}

const includedCount = (inclusion: ReturnType<typeof selectRows>) => [...inclusion.values()].filter((i) => i.included).length

export function askImpact(edited: Row[], s: Settings, keys: ReadonlySet<string>): AskImpact {
  const now = selectRows(s, edited)
  const without = edited.map((r) => (keys.has(r.key) && !r.excluded ? { ...r, excluded: EXCLUDED_BY_ANSWER } : r))
  const next = selectRows(s, without)
  return { before: includedCount(now), after: includedCount(next), shortBefore: shortOf(edited, s, now), shortAfter: shortOf(without, s, next) }
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

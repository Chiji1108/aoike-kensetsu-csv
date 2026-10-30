import { namesForCarryover, nameScrubber } from "@/lib/chat/carryover"
import type { CaseTableWire } from "@/lib/chat/wire"
import { savedAiCacheSchema, savedWorkSchema } from "@/lib/cases/state"
import { tryParseJson } from "@/lib/json"
import { nfkc, removeSpaces } from "@/lib/convert/text"
import { getCaseState, type Db } from "./case-store"

/**
 * 外に送る文字列に個人名が含まれないかを、サーバーに保存した案件の作業から確かめる（画面から届いた表の印だけに頼らない）。
 * 表の元の行はブラウザが元の Excel から作り直すもの（住所の分け方もブラウザ）で、サーバーには行が無いので現場そのものは作り直せない。
 * 代わりに、保存した手直し・置換・匿名化の AI の結果（persons）・氏名の区切りの AI に出てくる個人名と、届いた表の印の人を集め、
 * そのどれかを含む文字列は個人名ありとする。保存した作業が読めなければ確かめられないので投げる（送らない）
 */
export async function personalChecker(db: Db, caseId: string, table: Pick<CaseTableWire, "rows" | "edits"> | null): Promise<(text: string) => boolean> {
  const row = await getCaseState(db, caseId)
  const work = savedWorkSchema.safeParse(row && tryParseJson(row.json))
  const aiCache = savedAiCacheSchema.safeParse(row && tryParseJson(row.aiCache))
  if (!work.success || !aiCache.success) throw new Error("案件の保存した作業を読めないため、個人名を確かめられません（変換して保存してからもう一度）")
  const names = namesForCarryover({ previous: { work: work.data, aiCache: aiCache.data }, ...(table ? { current: table } : {}) })
  const scrub = nameScrubber(names)
  const has = (t: string) => scrub(t) !== t
  // 空白で区切った氏名（「田中 花子」）も見落とさないよう、空白を除いた文字列でも確かめる
  return (text) => has(text) || has(removeSpaces(nfkc(text)))
}

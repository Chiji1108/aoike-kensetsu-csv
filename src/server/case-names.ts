import { namesOfCase } from "@/lib/chat/carryover"
import { savedAiCacheSchema, savedWorkSchema } from "@/lib/cases/state"
import { tryParseJson } from "@/lib/json"
import { getCaseState, type Db } from "./case-store"

/**
 * サーバーに保存した案件の作業から分かっている個人名（手直し・置換・匿名化の AI の結果 persons・氏名の区切りの AI。去年のコードと同じ集め方）。
 * 画面から届いた表の印だけに頼らないために使う（工事場所の調査に送る文字列・ルールの案の確かめ）。
 * 保存した作業が読めなければ確かめられないので投げる（送らない・案にしない）
 */
export async function savedCaseNames(db: Db, caseId: string): Promise<Set<string>> {
  const row = await getCaseState(db, caseId)
  const work = savedWorkSchema.safeParse(row && tryParseJson(row.json))
  const aiCache = savedAiCacheSchema.safeParse(row && tryParseJson(row.aiCache))
  if (!work.success || !aiCache.success) throw new Error("案件の保存した作業を読めないため、個人名を確かめられません（変換して保存してからもう一度）")
  return namesOfCase(work.data, aiCache.data)
}

import { namesOfCase } from "@/lib/chat/carryover"
import { savedAiCacheSchema, savedWorkSchema, type SavedAiCache, type SavedWork } from "@/lib/cases/state"
import { tryParseJson } from "@/lib/json"
import { getCaseState, type Db } from "./case-store"

/** 保存した作業が読めない（形が変わった）。個人名を確かめられないので、外に送る・案にする処理は止める */
export class UnreadableCaseError extends Error {
  constructor() {
    super("案件の保存した作業を読めないため、個人名を確かめられません（変換して保存してからもう一度）")
  }
}

/** 保存した案件の作業と AI の結果。まだ保存が無ければ null、読めなければ UnreadableCaseError */
export async function readSavedCase(db: Db, caseId: string): Promise<{ work: SavedWork; aiCache: SavedAiCache } | null> {
  const row = await getCaseState(db, caseId)
  if (!row) return null
  const work = savedWorkSchema.safeParse(tryParseJson(row.json))
  const aiCache = savedAiCacheSchema.safeParse(tryParseJson(row.aiCache))
  if (!work.success || !aiCache.success) throw new UnreadableCaseError()
  return { work: work.data, aiCache: aiCache.data }
}

/**
 * 保存した作業から分かっている個人名（手直し・置換・匿名化の AI の結果 persons・氏名の区切りの AI。去年のコードと同じ集め方）。
 * 画面から届いた表の印だけに頼らないために使う（工事場所の調査に送る文字列・ルールの案の確かめ）。まだ保存が無ければ空
 */
export const namesOfSaved = (saved: { work: SavedWork; aiCache: SavedAiCache } | null) => (saved ? namesOfCase(saved.work, saved.aiCache) : new Set<string>())

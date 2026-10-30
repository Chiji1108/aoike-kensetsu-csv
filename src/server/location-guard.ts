import { namesForCarryover, personalNameTest } from "@/lib/chat/carryover"
import type { CaseTableWire } from "@/lib/chat/wire"
import type { Db } from "./case-store"
import { namesOfSaved, readSavedCase, UnreadableCaseError } from "./case-names"

/**
 * 外に送る文字列に個人名が含まれないかを、サーバーに保存した案件の作業から確かめる（画面から届いた表の印だけに頼らない）。
 * 表の元の行はブラウザが元の Excel から作り直すもの（住所の分け方もブラウザ）で、サーバーには行が無いので現場そのものは作り直せない。
 * 代わりに、保存した作業に出てくる個人名（savedCaseNames）と、届いた表の印の人を集め、そのどれかを含む文字列は個人名ありとする。
 * 保存した作業が読めなければ確かめられないので投げる（送らない）
 */
export async function personalChecker(db: Db, caseId: string, table: Pick<CaseTableWire, "rows" | "edits"> | null): Promise<(text: string) => boolean> {
  // 工事場所の調査は保存した作業が無ければ送らない（前のまま）
  const saved = await readSavedCase(db, caseId)
  if (!saved) throw new UnreadableCaseError()
  const names = namesOfSaved(saved)
  if (table) for (const n of namesForCarryover({ current: table })) names.add(n)
  return personalNameTest(names)
}

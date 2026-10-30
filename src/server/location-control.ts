import { env } from "cloudflare:workers"
import type { Db } from "./case-store"
import * as loc from "./location-store"

/**
 * 案件を消す前に、走っている一括調査の Workflow を止める。止められなくても削除は進める: 裏の処理は AI を呼ぶ前に削除中の印を見て止まり、
 * 結果・費用・変更案は案件の行が無ければ書かない（location-run.ts）。ここで止めるのは、待っている検索の分の費用を減らすため
 */
export async function stopRunsBeforeDelete(db: Db, caseIds: readonly string[]) {
  for (const id of await loc.runningRunIds(db, caseIds)) {
    try {
      await (await env.LOCATION_SEARCH.get(id)).terminate()
    } catch (e) {
      console.error("工事場所の調査の Workflow を止められませんでした（削除は進める）", id, e)
    }
  }
}

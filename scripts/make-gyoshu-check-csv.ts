/**
 * 業種コード確認用の CSV を作る
 *
 *   bun scripts/make-gyoshu-check-csv.ts   # docs/業種コード確認.csv
 *
 * 業種コード 1〜30 を1行ずつ並べた工事経歴データ。建設業.NET の更新後に取り込み、
 * 各行（工事名「業種コード確認n」）がどの業種になったかを見て src/lib/spec/code-sets.ts の表と合っているか確かめる。
 * 完成年月が無い工事は工事経歴書の画面でどの決算期にも出ないため、着工・完成年月と主任・監理技術者（空欄不可）も入れる。
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { CellResult, RowResult } from "../src/lib/convert/convert"
import { toCsvBytes } from "../src/lib/convert/csv"
import { KOJI_KEIREKI, type KojiFieldId } from "../src/lib/spec/koji-keireki"

const here = fileURLToPath(new URL("..", import.meta.url))

const values = (n: number): Record<KojiFieldId, string> => ({
  gyoshu: String(n),
  client: "確認用",
  motoukeShitauke: "1",
  jv: "0",
  workName: `業種コード確認${n}`,
  prefecture: "東京都",
  place: "千代田区",
  engineer: "確認　太郎",
  amount: "1",
  specialAmount: "0",
  startYm: "202509",
  endYm: "202509",
  chiefEngineer: "1",
  supervisingEngineer: "0",
})

const rows: RowResult<KojiFieldId>[] = Array.from({ length: 30 }, (_, i) => ({
  key: String(i),
  sheet: "確認用",
  row: i,
  cells: Object.fromEntries(
    Object.entries(values(i + 1)).map(([k, v]): [string, CellResult] => [k, { value: v, status: "ok", source: "確認用", original: v }]),
  ) as Record<KojiFieldId, CellResult>,
}))

const out = `${here}docs/業種コード確認.csv`
writeFileSync(out, toCsvBytes(KOJI_KEIREKI, rows))
console.log(`✔ ${out}`)

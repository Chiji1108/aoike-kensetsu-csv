/**
 * 表の仮想スクロールを確かめる、行の多い合成の工事経歴 Excel を作る（値はすべて作り物）
 *
 *   bun scripts/make-sample-large.ts   # fixtures/sample-large.xlsx
 *
 * 注文者は法人、工事名に個人名を含めないので、変換はルールだけで決まる（AI は列の対応の計画だけ）。
 * 30行ごとに契約金額を「見積中」にしてエラーの行を、一部の現場代理人を空白なしにして変換した行を混ぜる。
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as XLSX from "xlsx"

const here = fileURLToPath(new URL("..", import.meta.url))
const LARGE_ROWS = 240

const excelDate = (y: number, m: number, d: number): XLSX.CellObject => ({
  t: "n",
  v: (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000,
  z: "yyyy/m/d",
})
const yen = (v: number): XLSX.CellObject => ({ t: "n", v, z: "#,##0" })

const header = ["No.", "工種", "工事件名", "発注者", "元請/下請", "施工場所", "契約金額（円）", "工期", "完成日", "現場代理人", "備考"]
const gyoshu = ["建築一式", "電気工事", "管工事", "とび土工", "内装仕上"]
const places = ["東京都大田区平和島", "神奈川県横浜市港北区新横浜", "千葉県船橋市本町", "埼玉県さいたま市大宮区桜木町"]
const engineers = ["青池 一郎", "佐藤 花子", "鈴木 次郎", "田中 三郎", "高橋 健"]

const rows = Array.from({ length: LARGE_ROWS }, (_, i) => {
  const n = i + 1
  const month = (i % 9) + 1
  const engineer = engineers[i % engineers.length]!
  return [
    n,
    gyoshu[i % gyoshu.length]!,
    `サンプル第${n}倉庫改修工事`,
    `株式会社サンプル商事${(i % 17) + 1}`,
    i % 3 === 0 ? "下請" : "元請",
    `${places[i % places.length]}${n}-1`,
    n % 30 === 0 ? "見積中" : yen(1_000_000 + ((i * 7_919) % 240) * 101_000 + n),
    `2023/${month}/1～2023/${month + 2}/28`,
    excelDate(2023, month + 2, 28),
    n % 11 === 0 ? engineer.replace(" ", "") : engineer,
    "",
  ]
})

const aoa = [["令和5年度 工事経歴一覧（合成データ・行数の多い版）"], [], header, ...rows]
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "工事経歴")

const out = `${here}fixtures/sample-large.xlsx`
writeFileSync(out, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }))

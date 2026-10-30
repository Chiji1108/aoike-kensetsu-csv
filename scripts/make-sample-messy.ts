/**
 * 検証用の「わざと崩れた」工事経歴 Excel を作る
 *
 *   bun scripts/make-sample-messy.ts   # fixtures/sample-messy.xlsx
 *
 * 表題行と空行のあとに見出し、顧客ごとの列名、和暦・Excel日付・工期の範囲表記の混在、
 * 空白なしの氏名、都道府県を省いた住所、個人の注文者、合計行、JV列なし、業種名の表記ゆれを含む。
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as XLSX from "xlsx"

const here = fileURLToPath(new URL("..", import.meta.url))

const excelDate = (y: number, m: number, d: number): XLSX.CellObject => ({
  t: "n",
  v: (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000,
  z: "yyyy/m/d",
})
const yen = (v: number): XLSX.CellObject => ({ t: "n", v, z: "#,##0" })

const header = ["No.", "工種", "工事件名", "発注者", "元請/下請", "施工場所", "契約金額（円）", "工期", "完成日", "現場代理人", "備考"]

const rows: (string | number | XLSX.CellObject)[][] = [
  [1, "建築一式", "山田太郎邸新築工事", "山田太郎", "元請", "東京都世田谷区桜丘1-2-3", yen(32_400_500), "R5.4.1～R6.3.31", excelDate(2024, 3, 31), "青池一郎", ""],
  [2, "電気工事", "〇〇ビル電気設備改修工事", "株式会社サンプル商事", "元請", "横浜市中区山下町10", yen(12_345_678), "令和5年6月～令和5年12月", excelDate(2023, 12, 20), "佐藤 花子", ""],
  [3, "とび土工", "市道123号線擁壁工事", "横浜市", "元請", "神奈川県横浜市港北区新横浜2-5", yen(8_800_000), "令和5年4月", excelDate(2023, 9, 30), "鈴木次郎", ""],
  [4, "管工事", "△△マンション給排水更新工事", "株式会社大成サンプル", "下請", "千葉県船橋市本町1-1", yen(5_500_000), "2023/7/1～2023/10/31", excelDate(2023, 10, 31), "田中　三郎", ""],
  [5, "建築一式", "□□店舗内装工事", "有限会社みどり商店", "元請", "埼玉県さいたま市大宮区桜木町1", yen(18_000_000), "R5.9.1～R5.12.25", excelDate(2023, 12, 25), "青池一郎", ""],
  [6, "電気", "倉庫照明LED化工事", "株式会社サンプル物流", "下請", "東京都大田区平和島3-3", yen(2_200_450), "R5.10.1～R5.11.30", excelDate(2023, 11, 30), "高橋 健", "追加工事あり"],
  [7, "建築", "鈴木様邸リフォーム工事", "鈴木一郎", "元請", "川崎市川崎区駅前本町5", yen(4_320_000), "R6.1.10～R6.2.28", excelDate(2024, 2, 28), "青池一郎", ""],
]

const first = 4 // データの先頭行（Excel の行番号）
const last = first + rows.length - 1
const total: XLSX.CellObject = {
  t: "n",
  f: `SUM(G${first}:G${last})`,
  v: rows.reduce((s, r) => s + ((r[6] as XLSX.CellObject).v as number), 0),
  z: "#,##0",
}

const aoa = [
  ["令和5年度 工事経歴一覧（株式会社青池サンプル建設）"],
  [],
  header,
  ...rows,
  [],
  ["", "", "合計", "", "", "", total],
  ["※金額は税込です"],
]

const ws = XLSX.utils.aoa_to_sheet(aoa)
ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }]
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, "工事経歴")
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["担当者メモ"], ["7月の工事は書類待ち"]]), "メモ")

const out = `${here}fixtures/sample-messy.xlsx`
writeFileSync(out, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }))
console.log(`✔ ${out}`)

/**
 * 問い合わせの確認用（fixtures/sample-inquiry.xlsx）。配置技術者の列が無く、完成日・工事場所が空の行がある。
 * 法人の注文者・都道府県つきの住所・個人名の無い工事名だけなので、AI の値の判断は要らない。
 */
const inquiryHeader = ["工種", "工事件名", "発注者", "元請/下請", "施工場所", "契約金額（円）", "着工日", "完成日"]
const inquiryRows: (string | XLSX.CellObject)[][] = [
  ["電気工事", "テストビル電気設備工事", "株式会社テスト商事", "元請", "東京都千代田区丸の内1-1", yen(12_000_000), excelDate(2024, 4, 1), excelDate(2024, 9, 30)],
  ["電気工事", "テスト工場照明更新工事", "株式会社サンプル製作所", "下請", "神奈川県横浜市中区山下町2", yen(8_000_000), excelDate(2024, 5, 1), ""],
  ["管工事", "テスト病院給排水改修工事", "医療法人テスト会", "元請", "", yen(6_000_000), excelDate(2024, 6, 1), excelDate(2024, 12, 20)],
  ["管工事", "テスト倉庫空調設備工事", "株式会社テスト物流", "元請", "千葉県船橋市本町1-1", yen(3_000_000), excelDate(2024, 7, 1), excelDate(2024, 8, 31)],
]
const inquiryWb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(inquiryWb, XLSX.utils.aoa_to_sheet([inquiryHeader, ...inquiryRows]), "工事経歴")
const inquiryOut = `${here}fixtures/sample-inquiry.xlsx`
writeFileSync(inquiryOut, XLSX.write(inquiryWb, { type: "buffer", bookType: "xlsx" }))
console.log(`✔ ${inquiryOut}`)

/**
 * 検証用の「工事場所がほとんど書いていない」工事経歴 Excel を作る（工事場所の調査の確認用。実在の公共施設・会社の名前だけを使う合成データ）
 *
 *   bun scripts/make-sample-no-address.ts   # fixtures/sample-no-address.xlsx
 *
 * 施工場所の列はあるが、半分ほどの行は空（空の行の工事場所を調べる）。同じ現場が2行（工期を分けた工事）、個人の注文者の行を含む
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as XLSX from "xlsx"

const here = fileURLToPath(new URL("..", import.meta.url))
const yen = (v: number): XLSX.CellObject => ({ t: "n", v, z: "#,##0" })

const header = ["No.", "工種", "工事件名", "発注者", "元請/下請", "施工場所", "請負金額（円）", "着工", "完成", "現場代理人"]
const rows: (string | number | XLSX.CellObject)[][] = [
  [1, "電気工事", "東京スカイツリー照明設備改修工事", "東武タワースカイツリー株式会社", "下請", "", yen(48_000_000), "2024/04", "2024/09", "青池一郎"],
  [2, "電気工事", "東京スカイツリー照明設備改修工事", "東武タワースカイツリー株式会社", "下請", "", yen(12_000_000), "2024/10", "2024/12", "青池一郎"],
  [3, "電気工事", "横浜赤レンガ倉庫空調設備更新工事", "横浜市", "元請", "", yen(26_500_000), "2024/05", "2024/11", "佐藤花子"],
  [4, "電気工事", "倉庫照明LED化工事", "株式会社サンプル物流", "元請", "東京都大田区平和島3-3", yen(3_200_000), "2024/06", "2024/07", "佐藤花子"],
  [5, "電気工事", "山田太郎邸電気設備工事", "山田太郎", "元請", "", yen(2_100_000), "2024/08", "2024/08", "青池一郎"],
  [6, "電気工事", "事務所ビル受変電設備更新工事", "株式会社サンプル商事", "下請", "神奈川県横浜市中区山下町10", yen(9_800_000), "2024/09", "2025/01", "佐藤花子"],
  [7, "電気工事", "店舗内装電気工事", "有限会社みどり商店", "元請", "埼玉県さいたま市大宮区桜木町1-1", yen(4_400_000), "2024/11", "2025/02", "青池一郎"],
]

const aoa = [["令和6年度 工事経歴（合成サンプル電設）"], [], header, ...rows]
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "工事経歴")
writeFileSync(`${here}fixtures/sample-no-address.xlsx`, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }))

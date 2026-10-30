/**
 * 照合（scripts/eval.ts）の合成の例を作る。実データは使わない（会社名は「サンプル」、人名は架空、住所は実在の市区町村だけ）。
 *
 *   bun scripts/make-sample-eval.ts   # fixtures/eval/
 *
 * - synth-engineers: 管工事の工事台帳に配置技術者の列が無く、技術者一覧が別ファイル（工事番号で引く）
 * - synth-pdf: 電気工事の Excel と、Excel に無い3件が PDF で届いた（PDF は Chrome で印刷して作る。E2E_CHROME で Chrome を指定できる）
 *
 * 期待値（期待.csv、CP932）は職員が作る CSV として、ここで決める: 7割以上なので全件を載せる、注文者・工事名は元のまま（字数の上限に収まる）、
 * 姓と名の間は全角スペース、千円未満は切り捨て、JV・内訳は 0、主任技術者 1・監理技術者 0（どの工事も監理技術者の要る規模でない）。
 * 案件定義は fixtures/eval/cases.json（scripts/eval.ts の EVAL_CASES の形。実データの案件定義と1つにまとめて使う）。
 */
import { chromium } from "@playwright/test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as XLSX from "xlsx"
import { encodeCp932 } from "../src/lib/convert/text"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = `${root}fixtures/eval`

type Work = {
  no: string
  name: string
  client: string
  /** 0 官公庁元請 / 1 民間元請 / 2 下請 */
  kind: "0" | "1" | "2"
  address: string
  prefecture: string
  place: string
  yen: number
  start: [number, number, number]
  end: [number, number, number]
  /** 姓 名（元のファイルでは半角スペース） */
  engineer: string
}

const KIND_LABEL = { "0": "元請", "1": "元請", "2": "下請" } as const
const ym = ([y, m]: [number, number, number]) => `${y}${String(m).padStart(2, "0")}`
const date = ([y, m, d]: [number, number, number]) => new Date(Date.UTC(y, m - 1, d))
const expectedRow = (gyoshu: string, w: Work) =>
  [gyoshu, w.client, w.kind, "0", w.name, w.prefecture, w.place, w.engineer.replace(" ", "　"), String(Math.floor(w.yen / 1000)), "0", ym(w.start), ym(w.end), "1", "0"].join(",")
const writeCsv = (path: string, rows: string[]) => writeFileSync(path, encodeCp932(rows.join("\r\n") + "\r\n"))
const writeXlsx = (path: string, sheets: { name: string; aoa: unknown[][] }[]) => {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa, { cellDates: true }), s.name)
  writeFileSync(path, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }))
}
const yenCell = (v: number): XLSX.CellObject => ({ t: "n", v, z: "#,##0" })

// ---- 技術者一覧が別ファイル（管工事） ----
const ENG = ["青池 一郎", "佐藤 花子", "鈴木 次郎"] as const
const engineersWorks: Work[] = [
  { no: "K-101", name: "サンプル病院給排水設備改修工事", client: "株式会社サンプル建設", kind: "2", address: "東京都品川区東品川2-3-12", prefecture: "東京都", place: "品川区", yen: 38_420_000, start: [2024, 4, 8], end: [2024, 12, 20], engineer: ENG[0] },
  { no: "K-102", name: "川崎市立小学校空調設備更新工事", client: "川崎市", kind: "0", address: "神奈川県川崎市中原区小杉町3-1", prefecture: "神奈川県", place: "川崎市中原区", yen: 26_800_500, start: [2024, 6, 3], end: [2024, 9, 30], engineer: ENG[1] },
  { no: "K-103", name: "物流倉庫衛生設備新設工事", client: "株式会社サンプル物流", kind: "1", address: "埼玉県川口市領家5-14", prefecture: "埼玉県", place: "川口市", yen: 19_350_000, start: [2024, 5, 13], end: [2024, 10, 31], engineer: ENG[2] },
  { no: "K-104", name: "共同住宅給水管更生工事", client: "サンプル管理組合", kind: "1", address: "神奈川県横浜市港北区新横浜2-5", prefecture: "神奈川県", place: "横浜市港北区", yen: 12_640_000, start: [2024, 7, 1], end: [2024, 8, 30], engineer: ENG[0] },
  { no: "K-105", name: "事務所ビル排水管更新工事", client: "株式会社サンプル不動産", kind: "1", address: "千葉県船橋市本町1-3-1", prefecture: "千葉県", place: "船橋市", yen: 8_765_432, start: [2024, 9, 2], end: [2024, 11, 15], engineer: ENG[1] },
  { no: "K-106", name: "工場冷却水配管工事", client: "株式会社サンプル設備", kind: "2", address: "東京都大田区平和島4-1-23", prefecture: "東京都", place: "大田区", yen: 6_200_000, start: [2024, 10, 7], end: [2024, 12, 6], engineer: ENG[2] },
  { no: "K-107", name: "店舗厨房給排水設備工事", client: "株式会社サンプル食品", kind: "1", address: "東京都世田谷区玉川3-17-1", prefecture: "東京都", place: "世田谷区", yen: 4_380_000, start: [2024, 11, 11], end: [2024, 12, 25], engineer: ENG[0] },
  { no: "K-108", name: "社員寮給湯設備更新工事", client: "株式会社サンプル商事", kind: "1", address: "埼玉県さいたま市浦和区高砂3-15-1", prefecture: "埼玉県", place: "さいたま市浦和区", yen: 3_150_000, start: [2025, 1, 14], end: [2025, 2, 28], engineer: ENG[1] },
  { no: "K-109", name: "診療所空調ドレン配管工事", client: "医療法人サンプル会", kind: "1", address: "東京都練馬区豊玉北6-12-1", prefecture: "東京都", place: "練馬区", yen: 2_460_000, start: [2025, 2, 3], end: [2025, 2, 21], engineer: ENG[2] },
  { no: "K-110", name: "マンション屋外給水管漏水修繕工事", client: "株式会社サンプル建設", kind: "2", address: "神奈川県相模原市中央区中央2-11-15", prefecture: "神奈川県", place: "相模原市中央区", yen: 1_980_000, start: [2025, 2, 10], end: [2025, 3, 7], engineer: ENG[0] },
  { no: "K-111", name: "保育園トイレ改修に伴う衛生設備工事", client: "社会福祉法人サンプル福祉会", kind: "1", address: "千葉県柏市柏5-10-1", prefecture: "千葉県", place: "柏市", yen: 1_520_000, start: [2025, 3, 3], end: [2025, 3, 24], engineer: ENG[1] },
  { no: "K-112", name: "飲食店グリストラップ交換工事", client: "株式会社サンプル食品", kind: "1", address: "東京都台東区上野4-9-6", prefecture: "東京都", place: "台東区", yen: 860_000, start: [2025, 3, 17], end: [2025, 3, 28], engineer: ENG[2] },
]

// ---- PDF で届いた数件（電気工事） ----
const pdfExcelWorks: Work[] = [
  { no: "1", name: "物流センター受変電設備更新工事", client: "株式会社サンプル物流", kind: "1", address: "千葉県市川市塩浜2-1", prefecture: "千葉県", place: "市川市", yen: 42_300_000, start: [2024, 4, 15], end: [2024, 11, 29], engineer: "青池 一郎" },
  { no: "2", name: "市民会館照明設備LED化工事", client: "所沢市", kind: "0", address: "埼玉県所沢市並木1-9", prefecture: "埼玉県", place: "所沢市", yen: 18_900_000, start: [2024, 6, 10], end: [2024, 10, 18], engineer: "佐藤 花子" },
  { no: "3", name: "オフィスビル幹線改修工事", client: "株式会社サンプル建設", kind: "2", address: "東京都千代田区丸の内3-4-1", prefecture: "東京都", place: "千代田区", yen: 11_250_000, start: [2024, 7, 1], end: [2024, 9, 13], engineer: "青池 一郎" },
  { no: "4", name: "工場動力設備増設工事", client: "株式会社サンプル製作所", kind: "1", address: "神奈川県厚木市中町3-17-17", prefecture: "神奈川県", place: "厚木市", yen: 7_480_000, start: [2024, 8, 5], end: [2024, 10, 4], engineer: "佐藤 花子" },
  { no: "5", name: "店舗内装に伴う電気設備工事", client: "株式会社サンプル商事", kind: "2", address: "東京都渋谷区神南1-23-1", prefecture: "東京都", place: "渋谷区", yen: 4_120_000, start: [2024, 9, 9], end: [2024, 10, 25], engineer: "青池 一郎" },
  { no: "6", name: "共同住宅共用部照明改修工事", client: "サンプル管理組合", kind: "1", address: "神奈川県横浜市西区みなとみらい2-2-1", prefecture: "神奈川県", place: "横浜市西区", yen: 2_870_000, start: [2024, 11, 4], end: [2024, 12, 13], engineer: "佐藤 花子" },
  { no: "7", name: "事務所コンセント増設工事", client: "株式会社サンプル不動産", kind: "1", address: "東京都新宿区西新宿2-8-1", prefecture: "東京都", place: "新宿区", yen: 1_340_000, start: [2025, 1, 20], end: [2025, 2, 7], engineer: "青池 一郎" },
  { no: "8", name: "倉庫防犯カメラ配線工事", client: "株式会社サンプル物流", kind: "2", address: "埼玉県戸田市美女木5-1", prefecture: "埼玉県", place: "戸田市", yen: 960_000, start: [2025, 2, 17], end: [2025, 3, 14], engineer: "佐藤 花子" },
]
const pdfWorks: Work[] = [
  { no: "9", name: "研究所非常用発電設備更新工事", client: "株式会社サンプル製作所", kind: "1", address: "茨城県つくば市千現1-2-1", prefecture: "茨城県", place: "つくば市", yen: 23_650_000, start: [2024, 5, 20], end: [2024, 12, 20], engineer: "鈴木 次郎" },
  { no: "10", name: "商業施設キュービクル改修工事", client: "株式会社サンプル建設", kind: "2", address: "千葉県千葉市美浜区中瀬2-6-1", prefecture: "千葉県", place: "千葉市美浜区", yen: 9_870_000, start: [2024, 10, 1], end: [2025, 1, 31], engineer: "鈴木 次郎" },
  { no: "11", name: "賃貸住宅分電盤交換工事", client: "株式会社サンプル不動産", kind: "1", address: "東京都杉並区阿佐谷南1-15-1", prefecture: "東京都", place: "杉並区", yen: 1_760_000, start: [2025, 3, 3], end: [2025, 3, 21], engineer: "鈴木 次郎" },
]

function pdfHtml(works: Work[]) {
  const d = ([y, m, day]: [number, number, number]) => `${y}年${m}月${day}日`
  const rows = works
    .map(
      (w) =>
        `<tr><td>${w.name}</td><td>${w.client}</td><td>${KIND_LABEL[w.kind]}</td><td>${w.address}</td><td class="n">${w.yen.toLocaleString("ja-JP")}</td><td>${d(w.start)}〜${d(w.end)}</td><td>${w.engineer}</td></tr>`,
    )
    .join("")
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>
body{font-family:"Hiragino Sans","Noto Sans JP",sans-serif;font-size:10pt;margin:24px}
h1{font-size:14pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:4px 6px}.n{text-align:right}
</style><h1>工事経歴の追加分（Excel に入れ忘れた工事）</h1>
<p>合成サンプル電設　御中　金額は税抜・円</p>
<table><tr><th>工事名</th><th>発注者</th><th>元請・下請</th><th>工事場所</th><th>請負金額</th><th>工期</th><th>担当技術者</th></tr>${rows}</table></html>`
}

mkdirSync(`${dir}/synth-engineers`, { recursive: true })
mkdirSync(`${dir}/synth-pdf`, { recursive: true })

writeXlsx(`${dir}/synth-engineers/工事台帳.xlsx`, [
  {
    name: "工事台帳",
    aoa: [
      ["令和6年度 工事台帳（合成サンプル設備工業）"],
      [],
      ["工事番号", "工種", "工事名", "発注者", "元請・下請", "現場住所", "請負金額（税抜）", "着工日", "完成日"],
      ...engineersWorks.map((w) => [w.no, "管工事", w.name, w.client, KIND_LABEL[w.kind], w.address, yenCell(w.yen), date(w.start), date(w.end)]),
    ],
  },
])
writeXlsx(`${dir}/synth-engineers/技術者一覧.xlsx`, [
  { name: "技術者", aoa: [["工事番号", "主任技術者", "資格"], ...engineersWorks.map((w) => [w.no, w.engineer, "1級管工事施工管理技士"])] },
])
writeCsv(`${dir}/synth-engineers/期待.csv`, engineersWorks.map((w) => expectedRow("9", w)))

writeXlsx(`${dir}/synth-pdf/工事経歴.xlsx`, [
  {
    name: "工事経歴",
    aoa: [
      ["No.", "工種", "工事名", "発注者", "区分", "工事場所", "金額（税抜）", "着工", "完成", "担当技術者"],
      ...pdfExcelWorks.map((w) => [Number(w.no), "電気工事", w.name, w.client, KIND_LABEL[w.kind], w.address, yenCell(w.yen), date(w.start), date(w.end), w.engineer]),
    ],
  },
])
writeCsv(`${dir}/synth-pdf/期待.csv`, [...pdfExcelWorks, ...pdfWorks].map((w) => expectedRow("8", w)))

const browser = await chromium.launch(process.env.E2E_CHROME ? { executablePath: process.env.E2E_CHROME } : {})
try {
  const page = await browser.newPage()
  await page.setContent(pdfHtml(pdfWorks))
  writeFileSync(`${dir}/synth-pdf/追加の工事.pdf`, await page.pdf({ format: "A4", landscape: true, printBackground: true }))
} finally {
  await browser.close()
}

const allRows = "7割以上なら件数は自由なので、全部の工事を載せて"
const cases = {
  "synth-engineers": {
    xlsx: "fixtures/eval/synth-engineers/工事台帳.xlsx",
    staffCsv: "fixtures/eval/synth-engineers/期待.csv",
    files: ["fixtures/eval/synth-engineers/技術者一覧.xlsx"],
    customerName: "合成サンプル設備工業",
    customerRules: "",
    staffErrors: [],
    notDerivable: [],
    instructions: [allRows, "配置技術者は技術者一覧.xlsx から工事番号で引いて入れて"],
    variants: ["baseline", "edit"],
  },
  "synth-pdf": {
    xlsx: "fixtures/eval/synth-pdf/工事経歴.xlsx",
    staffCsv: "fixtures/eval/synth-pdf/期待.csv",
    files: ["fixtures/eval/synth-pdf/追加の工事.pdf"],
    customerName: "合成サンプル電設",
    customerRules: "",
    staffErrors: [],
    notDerivable: [],
    instructions: [allRows, "追加の工事.pdf の3件も表に足して（配置技術者は PDF の担当技術者）"],
    variants: ["baseline", "edit"],
  },
}
// ほかの合成の例（scripts/make-sample-answers.ts の synth-answers-*）は残す
const existing = JSON.parse(readFileSync(`${dir}/cases.json`, "utf8")) as Record<string, unknown>
writeFileSync(`${dir}/cases.json`, JSON.stringify({ ...existing, ...cases }, null, 1) + "\n")
console.log(`wrote ${dir}`)

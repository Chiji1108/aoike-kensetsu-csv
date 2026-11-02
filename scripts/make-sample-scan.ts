/**
 * 文字の層の無い PDF・手書きの写真の照合（scripts/eval-scan.ts）と e2e に使う合成の例を作る。実データは使わない（会社名は「サンプル」、人名は架空、住所は実在の市区町村だけ）。
 *
 *   bun scripts/make-sample-scan.ts   # fixtures/eval/synth-scan/、e2e/fixtures/scan.pdf
 *
 * - 工事経歴_スキャン.pdf: 1ページ目は活字の表、2ページ目は手書きの表。どちらも Chrome で描いた絵を JPEG にして PDF に貼る（文字の層が無い。スキャンと同じ）
 * - 手書きメモ.jpg: 手書きの工事のメモを撮った写真（少し傾けて、紙の色と影を付ける）
 * - 期待.json: 正しい値（注文者・工事名・元請下請・都道府県・場所名・配置技術者・金額〔千円〕・着工・完成）
 * 手書きは macOS の Klee（手書き風の書体）で描く。E2E_CHROME で Chrome を指定できる。
 */
import { chromium, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { PDFDocument } from "pdf-lib"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = `${root}fixtures/eval/synth-scan`

type Work = {
  name: string
  client: string
  kind: "元請" | "下請"
  address: string
  prefecture: string
  place: string
  yen: number
  start: [number, number]
  end: [number, number]
  engineer: string
}

const typed: Work[] = [
  { name: "サンプル中学校体育館照明LED化工事", client: "さいたま市", kind: "元請", address: "埼玉県さいたま市浦和区高砂3-1", prefecture: "埼玉県", place: "さいたま市浦和区", yen: 18_640_000, start: [2024, 5], end: [2024, 8], engineer: "青池 一郎" },
  { name: "物流センター受変電設備更新工事", client: "株式会社サンプル物流", kind: "下請", address: "千葉県市川市塩浜2-13", prefecture: "千葉県", place: "市川市", yen: 32_150_000, start: [2024, 6], end: [2024, 11], engineer: "佐藤 花子" },
  { name: "共同住宅共用部電気設備改修工事", client: "サンプル住宅管理組合", kind: "元請", address: "東京都練馬区豊玉北5-2", prefecture: "東京都", place: "練馬区", yen: 7_480_000, start: [2024, 9], end: [2024, 10], engineer: "鈴木 次郎" },
  { name: "店舗新築電気設備工事", client: "株式会社サンプル建設", kind: "下請", address: "神奈川県相模原市中央区中央1-1", prefecture: "神奈川県", place: "相模原市中央区", yen: 11_920_000, start: [2024, 10], end: [2025, 1], engineer: "青池 一郎" },
]
const handPdf: Work[] = [
  { name: "倉庫屋外照明増設工事", client: "株式会社サンプル運輸", kind: "元請", address: "東京都江東区新木場1-4", prefecture: "東京都", place: "江東区", yen: 2_860_000, start: [2024, 11], end: [2024, 12], engineer: "佐藤 花子" },
  { name: "事務所分電盤交換工事", client: "株式会社サンプル商事", kind: "元請", address: "埼玉県川越市新富町2-7", prefecture: "埼玉県", place: "川越市", yen: 1_540_000, start: [2025, 1], end: [2025, 2], engineer: "鈴木 次郎" },
]
const handPhoto: Work[] = [
  { name: "工場動力配線工事", client: "株式会社サンプル製作所", kind: "下請", address: "神奈川県厚木市金田1-2", prefecture: "神奈川県", place: "厚木市", yen: 5_270_000, start: [2025, 1], end: [2025, 3], engineer: "青池 一郎" },
  { name: "保育園防犯カメラ設置工事", client: "社会福祉法人サンプル会", kind: "元請", address: "東京都杉並区高円寺南3-5", prefecture: "東京都", place: "杉並区", yen: 980_000, start: [2025, 2], end: [2025, 2], engineer: "佐藤 花子" },
  { name: "マンション電気容量増設工事", client: "サンプル不動産株式会社", kind: "元請", address: "千葉県柏市柏4-8", prefecture: "千葉県", place: "柏市", yen: 3_310_000, start: [2025, 3], end: [2025, 3], engineer: "鈴木 次郎" },
]

const ymText = ([y, m]: [number, number]) => `${y}年${m}月`
const ym = ([y, m]: [number, number]) => `${y}${String(m).padStart(2, "0")}`

/** スキャンした紙の見た目（少し傾け、灰色にし、にじませる。紙のざらつきは SVG の雑音） */
const SCAN_STYLE = `
html,body{margin:0;background:#fff}
.paper{width:1754px;height:1240px;box-sizing:border-box;padding:70px 90px;position:relative;transform:rotate(0.5deg);transform-origin:center;filter:grayscale(1) contrast(1.15) blur(0.5px)}
.paper::after{content:"";position:absolute;inset:0;opacity:.22;background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
table{border-collapse:collapse;width:100%}td,th{border:2px solid #222;padding:10px 12px}`

function typedHtml(works: Work[]) {
  const rows = works.map((w) => `<tr><td>${w.name}</td><td>${w.client}</td><td>${w.kind}</td><td>${w.address}</td><td style="text-align:right">${w.yen.toLocaleString("ja-JP")}</td><td>${ymText(w.start)}〜${ymText(w.end)}</td><td>${w.engineer}</td></tr>`).join("")
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>${SCAN_STYLE}
body{font-family:"Hiragino Mincho ProN","Noto Serif JP",serif;font-size:21px}h1{font-size:32px}</style>
<div class="paper"><h1>工事経歴（電気工事）</h1><p>合成サンプル電設　金額は税抜・円</p>
<table><tr><th>工事名</th><th>発注者</th><th>元請・下請</th><th>工事場所</th><th>請負金額</th><th>工期</th><th>担当技術者</th></tr>${rows}</table></div></html>`
}

/** 手書きの表（罫線の紙に手書き風の書体。字の大きさと位置を少しずつずらす） */
function handHtml(works: Work[], title: string) {
  const jitter = (i: number) => `transform:translate(${(i * 7) % 5}px,${(i * 3) % 4}px) rotate(${((i % 3) - 1) * 0.6}deg)`
  const rows = works
    .map(
      (w, i) =>
        `<tr style="${jitter(i)}"><td>${w.name}</td><td>${w.client}</td><td>${w.kind}</td><td>${w.address}</td><td style="text-align:right">${w.yen.toLocaleString("ja-JP")}円</td><td>${ymText(w.start)}〜${ymText(w.end)}</td><td>${w.engineer}</td></tr>`,
    )
    .join("")
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>${SCAN_STYLE}
body{font-family:"Klee","Klee One","Yuji Syuku",cursive;font-size:25px;color:#1a2a6c}
.paper{background:repeating-linear-gradient(#fff 0 58px,#9bb 58px 60px)}td,th{border:1.5px solid #557}h1{font-size:34px}</style>
<div class="paper"><h1>${title}</h1><table><tr><th>工事名</th><th>注文者</th><th>元請/下請</th><th>場所</th><th>金額(税抜)</th><th>工期</th><th>担当</th></tr>${rows}</table></div></html>`
}

async function shot(page: Page, html: string, size: { width: number; height: number }) {
  await page.setViewportSize(size)
  await page.setContent(html)
  // 手書き風の書体は使うときに読み込まれるので、読み終えてから撮る
  await page.evaluate(async () => {
    await document.fonts.load('25px "Klee"', "工事")
    await document.fonts.ready
  })
  return page.screenshot({ type: "jpeg", quality: 72, fullPage: false })
}

/** 絵だけの PDF（A4 横。1ページに1枚の JPEG を貼る。文字の層は無い） */
async function imagePdf(images: Uint8Array[]) {
  const doc = await PDFDocument.create()
  for (const jpg of images) {
    const img = await doc.embedJpg(jpg)
    const page = doc.addPage([842, 595])
    page.drawImage(img, { x: 0, y: 0, width: 842, height: 595 })
  }
  return doc.save()
}

mkdirSync(dir, { recursive: true })
mkdirSync(`${root}e2e/fixtures`, { recursive: true })
const browser = await chromium.launch(process.env.E2E_CHROME ? { executablePath: process.env.E2E_CHROME } : {})
try {
  const page = await browser.newPage()
  const a4 = { width: 1754, height: 1240 }
  const p1 = await shot(page, typedHtml(typed), a4)
  const p2 = await shot(page, handHtml(handPdf, "追加の工事（手書き）"), a4)
  writeFileSync(`${dir}/工事経歴_スキャン.pdf`, await imagePdf([p1, p2]))
  // 写真: 紙を少し傾け、机の色と影を付ける
  const photo = handHtml(handPhoto, "工事メモ　合成サンプル電設").replace(
    "html,body{margin:0;background:#fff}",
    "html,body{margin:0;background:#6b5a45;height:1320px;overflow:hidden}.paper{margin:40px;box-shadow:12px 16px 30px rgba(0,0,0,.5);transform:rotate(-2deg) !important;filter:sepia(.25) contrast(1.05) blur(.6px) !important}",
  )
  writeFileSync(`${dir}/手書きメモ.jpg`, await shot(page, photo, { width: 1834, height: 1320 }))
  // e2e: 文字の層の無い PDF（1ページ。中身は照合と同じ活字の表）
  writeFileSync(`${root}e2e/fixtures/scan.pdf`, await imagePdf([p1]))
} finally {
  await browser.close()
}

const truth = (file: string, works: Work[]) =>
  works.map((w) => ({
    file,
    client: w.client,
    workName: w.name,
    motoukeShitauke: w.kind === "下請" ? "2" : w.client.endsWith("市") ? "0" : "1",
    prefecture: w.prefecture,
    place: w.place,
    engineer: w.engineer.replace(" ", "　"),
    amount: String(Math.floor(w.yen / 1000)),
    startYm: ym(w.start),
    endYm: ym(w.end),
  }))
writeFileSync(
  `${dir}/期待.json`,
  JSON.stringify([...truth("工事経歴_スキャン.pdf p1（活字）", typed), ...truth("工事経歴_スキャン.pdf p2（手書き）", handPdf), ...truth("手書きメモ.jpg", handPhoto)], null, 1) + "\n",
)
console.log(`wrote ${dir}`)

/**
 * 照合（scripts/eval.ts の answers）の合成の例を作る: 顧客の回答をいろいろな形で受け取る。実データは使わない（会社名は「サンプル」、人名は架空、住所は実在の市区町村だけ）。
 *
 *   bun scripts/make-sample-answers.ts   # fixtures/eval/synth-answers/ と fixtures/eval/cases.json の synth-answers-*
 *
 * 元の Excel（工事経歴.xlsx）は配置技術者・完成日・工事場所が抜けた行がある内装工事の表。問い合わせはこの抜けた欄になる。
 * - synth-answers-mail: 顧客がメールの本文で答える（職員がチャットに貼る）。「倉庫の件」は2つの倉庫の工事に当てはまるので、AI は決めずに職員に聞くのが正しい
 * - synth-answers-column: 記入用Excelの色付きの欄に書かず、右に足した「備考」の列に書いて返す（照合の回に記入用Excelを作る。決まった欄は空のまま）
 * - synth-answers-partial: 一部だけ答えるメール（残りは確認中）。答えていない項目は埋めないのが正しい
 * 正しい答え（answerTruth）は工事名・項目・CSV の値。ここに無い問い合わせは答えが無い（埋めたら誤り）
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as XLSX from "xlsx"
import { encodeCp932 } from "../src/lib/convert/text"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = `${root}fixtures/eval`

type Work = { no: number; name: string; client: string; kind: "元請" | "下請"; address: string; prefecture: string; place: string; yen: number; start: [number, number, number]; end: [number, number, number] | null; engineer: string }
const date = ([y, m, d]: [number, number, number]) => new Date(Date.UTC(y, m - 1, d))

const works: Work[] = [
  { no: 1, name: "サンプル本社ビル事務所内装改修工事", client: "株式会社サンプル不動産", kind: "元請", address: "東京都港区芝浦3-1-1", prefecture: "東京都", place: "港区", yen: 32_400_000, start: [2024, 4, 8], end: [2024, 9, 27], engineer: "青池 一郎" },
  { no: 2, name: "物流倉庫休憩室内装工事", client: "株式会社サンプル物流", kind: "下請", address: "埼玉県川口市領家5-14", prefecture: "埼玉県", place: "川口市", yen: 14_800_000, start: [2024, 5, 13], end: [2024, 8, 30], engineer: "" },
  { no: 3, name: "サンプル病院外来待合室改装工事", client: "医療法人サンプル会", kind: "元請", address: "千葉県船橋市本町1-3-1", prefecture: "千葉県", place: "船橋市", yen: 12_350_000, start: [2024, 6, 3], end: null, engineer: "佐藤 花子" },
  { no: 4, name: "店舗内装仕上工事", client: "株式会社サンプル商事", kind: "下請", address: "", prefecture: "", place: "", yen: 9_870_000, start: [2024, 7, 1], end: [2024, 9, 13], engineer: "鈴木 次郎" },
  { no: 5, name: "冷凍倉庫事務所間仕切り工事", client: "株式会社サンプル食品", kind: "元請", address: "神奈川県川崎市川崎区東扇島7", prefecture: "神奈川県", place: "川崎市川崎区", yen: 7_480_000, start: [2024, 8, 5], end: null, engineer: "" },
  { no: 6, name: "共同住宅エントランス改修工事", client: "サンプル管理組合", kind: "元請", address: "", prefecture: "", place: "", yen: 5_120_000, start: [2024, 9, 9], end: [2024, 11, 22], engineer: "青池 一郎" },
  { no: 7, name: "保育園保育室床改修工事", client: "社会福祉法人サンプル福祉会", kind: "元請", address: "東京都練馬区豊玉北6-12-1", prefecture: "東京都", place: "練馬区", yen: 3_340_000, start: [2024, 11, 4], end: [2024, 12, 13], engineer: "" },
  { no: 8, name: "診療所天井ボード張替工事", client: "医療法人サンプル会", kind: "下請", address: "東京都杉並区阿佐谷南1-15-1", prefecture: "東京都", place: "杉並区", yen: 1_960_000, start: [2025, 1, 20], end: [2025, 2, 7], engineer: "佐藤 花子" },
]

writeFileSync(
  `${dir}/synth-answers/工事経歴.xlsx`,
  (() => {
    const wb = XLSX.utils.book_new()
    const aoa = [
      ["No.", "工種", "工事名", "発注者", "区分", "工事場所", "金額（税抜）", "着工", "完成", "担当技術者"],
      ...works.map((w) => [w.no, "内装仕上工事", w.name, w.client, w.kind, w.address, { t: "n", v: w.yen, z: "#,##0" }, date(w.start), w.end ? date(w.end) : "", w.engineer]),
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), "工事経歴")
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
  })(),
)

/** 正しい答え（CSV の値）。問い合わせのうちここに無いものは、顧客が答えていない */
type Truth = { workName: string; field: string; value: string }
const all: Truth[] = [
  { workName: works[1]!.name, field: "engineer", value: "山本　健太" },
  { workName: works[2]!.name, field: "endYm", value: "202410" },
  { workName: works[3]!.name, field: "prefecture", value: "神奈川県" },
  { workName: works[3]!.name, field: "place", value: "横浜市中区" },
  { workName: works[4]!.name, field: "endYm", value: "202411" },
  { workName: works[5]!.name, field: "prefecture", value: "東京都" },
  { workName: works[5]!.name, field: "place", value: "世田谷区" },
  { workName: works[6]!.name, field: "engineer", value: "山本　健太" },
]

const mail = [
  "顧客からのメールの本文です。答えを取り込んで。",
  "",
  "-----",
  "青池事務所 御中",
  "",
  "いつもお世話になっております。お問い合わせの件、回答いたします。",
  "",
  "・病院の待合室の改装は、10月18日に引き渡しました。",
  "・店舗の内装仕上は横浜市中区の店舗です（神奈川県横浜市中区元町2丁目）。",
  "・冷凍倉庫の間仕切りは11月末に完成しています。",
  "・共同住宅のエントランスは世田谷区です。東京都世田谷区上馬4丁目のマンションになります。",
  "・保育園の床の工事の技術者は山本 健太です。",
  "・倉庫の件の担当技術者も山本です。",
  "",
  "以上、よろしくお願いいたします。",
  "サンプル内装 工事部",
].join("\n")

const partial = [
  "顧客からのメールの本文です。答えを取り込んで。",
  "",
  "-----",
  "お世話になっております。一部ですが先に回答します。",
  "物流倉庫の休憩室の工事の担当は山本 健太です。",
  "病院の待合室は10月に完成しています。",
  "そのほかの件は現場に確認中のため、分かり次第ご連絡します。",
].join("\n")

/** 記入用Excelの「備考」の列（色付きの欄は空のまま）。工事名 → 備考 */
const column: Record<string, string> = {
  [works[1]!.name]: "担当は山本 健太です",
  [works[2]!.name]: "完成は2024年10月",
  [works[3]!.name]: "神奈川県横浜市中区です",
  [works[4]!.name]: "2024年11月完成",
  [works[5]!.name]: "東京都世田谷区",
  [works[6]!.name]: "技術者は山本 健太",
}

const base = {
  xlsx: "fixtures/eval/synth-answers/工事経歴.xlsx",
  staffCsv: "fixtures/eval/synth-answers/期待.csv",
  customerName: "合成サンプル内装",
  customerRules: "",
  staffErrors: [],
  notDerivable: [],
  instructions: [],
  variants: ["baseline", "answers"],
}
// 期待.csv は照合の行の対応づけに使う（答えの正しさは answerTruth で数える）。行は元の Excel のとおり、答えはすべて入れたもの
const expected = (w: Work) => {
  const t = (f: string) => all.find((x) => x.workName === w.name && x.field === f)?.value
  const [pref, place] = w.address ? [w.prefecture, w.place] : [t("prefecture") ?? "", t("place") ?? ""]
  const ym = (d: [number, number, number] | null, f: string) => (d ? `${d[0]}${String(d[1]).padStart(2, "0")}` : (t(f) ?? ""))
  return ["19", w.client, w.kind === "元請" ? "1" : "2", "0", w.name, pref, place, w.engineer ? w.engineer.replace(" ", "　") : (t("engineer") ?? ""), String(Math.floor(w.yen / 1000)), "0", ym(w.start, "startYm"), ym(w.end, "endYm"), "1", "0"].join(",")
}
writeFileSync(`${dir}/synth-answers/期待.csv`, encodeCp932(works.map(expected).join("\r\n") + "\r\n"))

const cases = JSON.parse(readFileSync(`${dir}/cases.json`, "utf8")) as Record<string, unknown>
// 「倉庫の件」は2つの倉庫の工事（物流倉庫・冷凍倉庫）の技術者に当てはまるので、どちらも答えの無いものとして数える
cases["synth-answers-mail"] = { ...base, answerInstructions: [mail], answerTruth: all.filter((t) => t.workName !== works[1]!.name) }
cases["synth-answers-column"] = { ...base, answerSheet: column, answerTruth: all.filter((t) => t.workName in column) }
cases["synth-answers-partial"] = { ...base, answerInstructions: [partial], answerTruth: all.filter((t) => t.workName === works[1]!.name || t.workName === works[2]!.name) }
writeFileSync(`${dir}/cases.json`, JSON.stringify(cases, null, 1) + "\n")
console.log(`wrote ${dir}/synth-answers`)

import * as XLSX from "xlsx"

/**
 * 変換の元のファイルに印を付けて返せるか（判定はここだけ。画面がどちらの Excel にするかを出すのも、書くとき（marked-xlsx.ts）も同じ決まり）。
 * 書けるのは .xlsx だけ。.xls（古い形）・マクロ付き・CSV・PDF は書けない。.xlsx でも、ExcelJS で書き戻すと消える部分
 * （グラフ・図形や画像・ピボット・外部リンク・フォームの部品・埋め込み・スレッド形式のコメント・セルの中の画像・
 * 拡張の入力規則や条件付き書式・スパークライン）があれば書かない（顧客の表を壊さない）。書けないときは記入用Excelにする。
 * 消えても表の中身に関わらないもの（プリンターの設定・customXml のファイルの情報）は止めない
 */
export type Markability = { ok: true } | { ok: false; reason: string }

/** 書き戻すと消える・壊れる部分（zip の中のパスの頭） */
const UNSAFE_PARTS: readonly [prefix: string, what: string][] = [
  ["xl/vbaProject.bin", "マクロ"],
  ["xl/charts/", "グラフ"],
  ["xl/chartsheets/", "グラフ"],
  ["xl/drawings/drawing", "図形や画像"],
  ["xl/pivotTables/", "ピボットテーブル"],
  ["xl/pivotCache/", "ピボットテーブル"],
  ["xl/slicers/", "スライサー"],
  ["xl/slicerCaches/", "スライサー"],
  ["xl/timelines/", "タイムライン"],
  ["xl/externalLinks/", "ほかのファイルへのリンク"],
  ["xl/ctrlProps/", "フォームの部品"],
  ["xl/activeX/", "フォームの部品"],
  ["xl/embeddings/", "埋め込んだファイル"],
  ["xl/model/", "データモデル"],
  ["xl/queryTables/", "外部データの取り込み"],
  ["xl/connections.xml", "外部データの取り込み"],
  ["xl/threadedComments/", "スレッド形式のコメント"],
  ["xl/persons/", "スレッド形式のコメント"],
  ["xl/richData/", "セルの中の画像"],
  ["xl/webextensions/", "アドイン"],
  ["xl/namedSheetViews/", "シートのビュー"],
]

/** シートの XML の中の、ExcelJS が読まずに消す拡張（x14 の入力規則・条件付き書式・スパークライン） */
const UNSAFE_SHEET_PARTS: readonly [tag: string, what: string][] = [
  ["<x14:dataValidations", "ほかのシートを参照する入力規則"],
  ["<x14:conditionalFormattings", "拡張の条件付き書式"],
  ["<x14:sparklineGroups", "スパークライン"],
]

export function markability(name: string, bytes: Uint8Array): Markability {
  if (/\.xls$/i.test(name)) return { ok: false, reason: "元のファイルが .xls（古い形）なので" }
  if (/\.xlsm$/i.test(name)) return { ok: false, reason: "元のファイルがマクロ付きなので" }
  if (/\.csv$/i.test(name)) return { ok: false, reason: "元のファイルが CSV なので" }
  if (!/\.xlsx$/i.test(name)) return { ok: false, reason: "元のファイルが Excel（.xlsx）ではないので" }
  let paths: string[]
  let sheetXml: string[]
  try {
    const zip = XLSX.CFB.read(bytes, { type: "array" })
    paths = zip.FullPaths.map((p: string) => p.replace(/^Root Entry\//, ""))
    const decoder = new TextDecoder()
    sheetXml = zip.FileIndex.flatMap((f: { content?: unknown }, i: number) => (/^xl\/worksheets\/[^/]+\.xml$/.test(paths[i] ?? "") && f.content ? [decoder.decode(f.content as Uint8Array)] : []))
  } catch {
    return { ok: false, reason: "元のファイルを開き直せないので" }
  }
  if (!paths.includes("xl/workbook.xml")) return { ok: false, reason: "元のファイルにパスワードが付いているか、読めない形なので" }
  const unsafe = [
    ...new Set([
      ...UNSAFE_PARTS.filter(([prefix]) => paths.some((p) => p.startsWith(prefix))).map(([, what]) => what),
      ...UNSAFE_SHEET_PARTS.filter(([tag]) => sheetXml.some((x) => x.includes(tag))).map(([, what]) => what),
    ]),
  ]
  if (unsafe.length) return { ok: false, reason: `元のファイルに${unsafe.join("・")}があり、壊さずに書けないので` }
  return { ok: true }
}

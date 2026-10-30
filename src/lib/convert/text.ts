import Encoding from "encoding-japanese"

/** 照合用の正規化（全角英数→半角、半角カナ→全角、前後の空白除去） */
export function nfkc(s: string) {
  return s.normalize("NFKC").trim()
}

/** 画面に入力された金額などの整数。全角数字・カンマ（全角も）・空白を許す。読めなければ undefined */
export function parseInputNumber(s: string): number | undefined {
  const digits = nfkc(s).replace(/[,\s]/g, "")
  return /^\d+$/.test(digits) ? Number(digits) : undefined
}

/** 照合用キー: NFKC のうえ空白と区切り記号を除く */
export function matchKey(s: string) {
  return nfkc(s).replace(/[\s・･()（）［］\[\]「」【】/／:：_\-－]/g, "")
}

/** ASCII と半角カナを全角に。スペースは全角スペースに */
export function toFullWidth(s: string) {
  return s
    .replace(/[｡-ﾟ]+/g, (m) => m.normalize("NFKC"))
    .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    .replace(/ /g, "　")
}

/** 連続する空白（半角・全角・タブ）を1つの半角スペースに */
export function collapseSpaces(s: string) {
  return s.replace(/[\s　]+/g, " ").trim()
}

export function removeSpaces(s: string) {
  return s.replace(/[\s　]+/g, "")
}

export function encodeCp932(s: string): Uint8Array {
  return Uint8Array.from(Encoding.convert(Encoding.stringToCode(s), { to: "SJIS", from: "UNICODE" }))
}

export function decodeCp932(bytes: Uint8Array) {
  return Encoding.codeToString(Encoding.convert(Array.from(bytes), { to: "UNICODE", from: "SJIS" }))
}

/** 文字ごとの「CP932 で表せるか」。検証は行のチェックや手直しのたびに全セルを見直すので、同じ文字の変換を繰り返さない */
const cp932Representable = new Map<string, boolean>()

/** CP932 で表せない文字（例: 一部の異体字・絵文字）を返す */
export function nonCp932Chars(s: string) {
  return [...s].filter((c) => {
    let ok = cp932Representable.get(c)
    if (ok === undefined) cp932Representable.set(c, (ok = decodeCp932(encodeCp932(c)) === c))
    return !ok
  })
}

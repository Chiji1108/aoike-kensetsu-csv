import { nfkc, removeSpaces } from "./text"

/**
 * 値の中の個人名。セルには記号（Ａ・Ｂ…）ではなく、誰かを表す印（personToken）を入れておく。
 * 記号は personLetters が CSV に書く行（一括置換・手直し・顧客の回答を当てたあと）から、CSV の順に決める。
 * 同じ人には案件のどこでも同じ記号が付き、値を作る側（変換・回答・手直し）はほかの側の記号を知らなくてよい。
 */

const OPEN = ""
const CLOSE = ""
/** 私用領域の文字で囲むので、元データの文字と混ざらない */
const TOKEN_RE = /([^]+)/g

/** AI が個人名の代わりに入れる印。n は persons の何番目か（1から） */
const PLACEHOLDER_RE = /〔([0-9０-９]+)〕/g

/** CSV に載せない行・値にだけいる人の、画面での呼び名（〔未掲載１〕）。記号と違う形なので CSV の記号とぶつからない */
const UNLISTED = "未掲載"

/** 職員が手直しで記号を書くときの形（例: 〔Ａ〕邸新築工事、〔未掲載１〕様） */
const MARKED_RE = /〔([Ａ-Ｚ][０-９]*|未掲載[０-９]+)〕/g

const LETTERS = [..."ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"]

export const personKey = (name: string) => removeSpaces(nfkc(name))

export const personToken = (name: string) => OPEN + name + CLOSE

export const hasPersons = (value: string) => value.includes(OPEN)

const fullWidthDigits = (n: number) => String(n).replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0))

/** i 番目の記号（Ａ…Ｚ、その先は Ａ２…Ｚ２、Ａ３…） */
function letterAt(i: number) {
  const round = Math.floor(i / LETTERS.length)
  return LETTERS[i % LETTERS.length]! + (round === 0 ? "" : fullWidthDigits(round + 1))
}

/**
 * AI の結果（個人名を「〔n〕」にした値と、その個人名 persons）を印の入った値にする。
 * 検算: 印がすべて persons を指し、どの人も印になっていて、印を個人名に戻すと元の値（raw）になる。
 * 個人名が値のどこかに残っているかではなく、AI が印にした場所がちょうどその人の名前だったかを見る（「森林公園前 森様邸」の「森林」は個人名ではない）。
 */
export function placePersons(value: string, persons: readonly string[], raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const used = new Set<number>()
  for (const [, n] of value.matchAll(PLACEHOLDER_RE)) {
    const i = Number(nfkc(n!))
    if (!(i >= 1 && i <= persons.length)) return { ok: false, message: `AIの印「〔${n}〕」に対応する個人名がありません` }
    used.add(i)
  }
  if (used.size < persons.length) return { ok: false, message: "AIが個人名とした人のうち、印になっていない人がいます（個人名が残っています）" }
  const placed = value.replace(PLACEHOLDER_RE, (_, n: string) => personToken(persons[Number(nfkc(n)) - 1]!))
  if (removeSpaces(nfkc(withNames(placed, (name) => name))) !== removeSpaces(nfkc(raw)))
    return { ok: false, message: "AIが印にした場所が元の値の個人名と一致しません" }
  return { ok: true, value: placed }
}

/** 記号の表。CSV の人は CSV に出てくる順に Ａ, Ｂ, …、CSV にいない人は 未掲載１, 未掲載２, … */
export type PersonLetters = {
  /** 氏名（空白を除く）→ 記号 */
  letterOf: ReadonlyMap<string, string>
  /** 記号 → 氏名（最初に出てきた表記） */
  personOf: ReadonlyMap<string, string>
}

/**
 * 印の人に記号を付ける。csv は CSV に書く値を CSV の順に並べたもの（記号は Ａ から欠けなく付く）。
 * others は画面にだけ出る値（載せない行・置換の元の値など）。そこにだけいる人は 未掲載n にする。同じ値の並びからは必ず同じ表になる
 */
export function personLetters(csv: Iterable<string>, others: Iterable<string> = []): PersonLetters {
  const letterOf = new Map<string, string>()
  const personOf = new Map<string, string>()
  let unlisted = 0
  const add = (values: Iterable<string>, next: () => string) => {
    for (const v of values) {
      for (const [, name] of v.matchAll(TOKEN_RE)) {
        const key = personKey(name!)
        if (letterOf.has(key)) continue
        const letter = next()
        letterOf.set(key, letter)
        personOf.set(letter, name!)
      }
    }
  }
  add(csv, () => letterAt(letterOf.size))
  add(others, () => UNLISTED + fullWidthDigits(++unlisted))
  return { letterOf, personOf }
}

/**
 * 印を記号にする。marked なら手直し用に「〔Ａ〕」の形にする。CSV にいない人はいつも「〔未掲載１〕」の形（CSV の記号に見えない）。
 * letters は値の人をすべて含む表（finalizeRows の letters）。表に無い人を記号にはできない（氏名を出すと CSV に個人名が載る）ので投げる
 */
export function showPersons(value: string, letters: PersonLetters, marked = false) {
  return withNames(value, (name) => {
    const letter = letters.letterOf.get(personKey(name))
    if (letter === undefined) throw new Error("個人名の記号の表に無い人がいます（記号の表は finalizeRows の letters を使ってください）")
    return marked || letter.startsWith(UNLISTED) ? `〔${letter}〕` : letter
  })
}

/** 印を show の結果にする。職員向けの知らせでは氏名を出す */
export function withNames(value: string, show: (name: string) => string = (name) => `〔${name}〕`) {
  return value.replace(TOKEN_RE, (_, name: string) => show(name))
}

/** 職員の手直しの「〔Ａ〕」を、今の記号の表でその人の印に戻す。表に無い記号は読めない */
export function readMarked(text: string, letters: PersonLetters): { ok: true; value: string } | { ok: false; message: string } {
  const unknown = [...text.matchAll(MARKED_RE)].map((m) => m[1]!).filter((l) => !letters.personOf.has(l))
  if (unknown.length) return { ok: false, message: `記号「${unknown.map((l) => `〔${l}〕`).join("")}」に当たる個人名がありません（個人名の記号は今の表の〔Ａ〕等を使ってください）` }
  return { ok: true, value: text.replace(MARKED_RE, (_, l: string) => personToken(letters.personOf.get(l)!)) }
}

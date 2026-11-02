import { prefectureFromShortName, type Prefecture } from "../spec/prefectures"
import { PLACE_LIST, placeIssue, readPlace, tidyPlace, type PlaceIndex } from "../spec/place"
import { nfkc, removeSpaces } from "../convert/text"
import type { Found } from "./sites"

/**
 * 調べた都道府県・場所名の検算。住所の分け方（convert/address.ts）と同じ住所データ（Geolonia の市区町村の一覧 ja.json）の索引（spec/place.ts）で、
 * 場所名がその都道府県の市区町村（政令市は区まで・区まで書いていない政令市）の名前かを確かめ、決まりの形の名前（郡の扱いも spec/place.ts）にそろえる
 */

export { jaSchema, placeIndex, type PlaceIndex } from "../spec/place"

export type Checked = { ok: true; found: Found } | { ok: false; note: string }

/**
 * 答えに書かれた地域の数。句読点で区切ったそれぞれを市区町村として読み（「西区」のような区だけの略記は、前に読んだ政令市の区として読む）、
 * 読めた名前の重なり（「横浜市中区」と「横浜市」のような言い直し）は1つに数える。市区町村として読めず決まりの形でもない部分（説明）は数えない
 */
function regionCount(index: PlaceIndex, prefecture: Prefecture, value: string) {
  const read: string[] = []
  for (const part of value.split(PLACE_LIST).filter(Boolean)) {
    let name = readPlace(index, prefecture, part)
    if (!name && !placeIssue(part)) {
      const city = read.map((n) => /^.+?市(?=.+区$)/.exec(n)?.[0]).find(Boolean)
      name = (city && readPlace(index, prefecture, city + part)) || part
    }
    if (name) read.push(name)
  }
  const unique = [...new Set(read)]
  return unique.filter((n) => !unique.some((m) => m !== n && m.startsWith(n))).length
}

/**
 * 検算する。都道府県が47都道府県（省略形も読む）でなければ使わない。場所名は決まった処理（tidyPlace）で直せるところを直し、
 * その都道府県の市区町村の名前か（「港区赤坂」「三島郡出雲崎町大字乙茂」「横浜市中区（赤レンガ倉庫）」のように後ろに町名・説明が続けば市区町村まで）を
 * 確かめて決まりの形の名前にする（直した値で読めなければ元の答えでも読む）。複数の地域を並べた答え・市区町村として読めず決まりも守らない答え
 * （施設名だけ・郡だけ）は場所名を使わず（空の場所名＝今の場所名を残す）、自信なしにして顧客に確かめる。読めないが決まりの形の名前は値を残し、自信なしにする
 */
export function checkFound(index: PlaceIndex, f: Found): Checked {
  const prefecture = prefectureFromShortName(f.prefecture.trim())
  if (!prefecture) return { ok: false, note: f.prefecture ? `都道府県「${f.prefecture}」が47都道府県名と一致しません` : "都道府県が分かりませんでした" }
  const raw = f.place.trim()
  const unsure = (why: string, place = ""): Checked => ({ ok: true, found: { ...f, prefecture, place, confident: false, note: [f.note, why].filter(Boolean).join(" / ") } })
  if (!raw) return { ok: true, found: { ...f, prefecture, place: "" } }
  if (!index.get(prefecture)) return unsure(`場所名「${raw}」を${prefecture}の市区町村として確かめられませんでした`, raw)
  const tidy = tidyPlace(raw, prefecture)
  if (regionCount(index, prefecture, tidy.value) > 1) return unsure(`場所名「${raw}」は複数の地域なので使いません`)
  const written = removeSpaces(nfkc(raw))
  const read = readPlace(index, prefecture, tidy.value) ?? readPlace(index, prefecture, written.startsWith(prefecture) ? written.slice(prefecture.length) : written)
  if (read) return { ok: true, found: { ...f, prefecture, place: read } }
  if (tidy.issue) return unsure(`場所名「${raw}」は市区町村の名前でないため使いません`)
  return unsure(`場所名「${tidy.value}」を${prefecture}の市区町村として確かめられませんでした`, tidy.value)
}

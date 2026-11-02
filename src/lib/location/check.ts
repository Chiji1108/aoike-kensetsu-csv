import { z } from "zod"
import { PREFECTURES, prefectureFromShortName, type Prefecture } from "../spec/prefectures"
import { PLACE_LIST, tidyPlace, withoutGun } from "../spec/place"
import type { Found } from "./sites"

/**
 * 調べた都道府県・場所名の検算。住所の分け方（convert/address.ts）と同じ住所データ（Geolonia の市区町村の一覧 ja.json）で、
 * 場所名がその都道府県の市区町村（政令市は区まで・区まで書いていない政令市。郡は付けない。spec/place.ts の決まり）の名前かを確かめ、住所データの表記にそろえる
 */

export const jaSchema = z.object({ data: z.array(z.object({ pref: z.string(), cities: z.array(z.object({ city: z.string(), ward: z.string().optional() })) })) })

/** 都道府県 → 市区町村の名前（揺れを畳んだもの）→ 住所データの表記 */
export type PlaceIndex = ReadonlyMap<Prefecture, ReadonlyMap<string, string>>

/** 表記の揺れを畳む（ヶ・ヵ → ケ、空白を除く）。比べるのにだけ使う */
const fold = (s: string) => s.normalize("NFKC").replace(/\s/g, "").replace(/[ヶヵ]/g, "ケ")

export function placeIndex(ja: z.infer<typeof jaSchema>): PlaceIndex {
  const index = new Map<Prefecture, Map<string, string>>()
  for (const p of ja.data) {
    const pref = PREFECTURES.find((x) => x === p.pref)
    if (!pref) continue
    const names = new Map<string, string>()
    const add = (name: string) => names.set(fold(name), name)
    for (const c of p.cities) {
      add(c.city + (c.ward ?? ""))
      // 区まで書いていない政令市（「横浜市」）
      if (c.ward) add(c.city)
    }
    index.set(pref, names)
  }
  return index
}

export type Checked = { ok: true; found: Found } | { ok: false; note: string }

/**
 * 検算する。都道府県が47都道府県（省略形も読む）でなければ使わない。場所名は決まった処理（spec/place.ts の tidyPlace）で直せるところを直し、
 * その都道府県の市区町村の名前か（「港区赤坂」「横浜市中区（赤レンガ倉庫）」のように後ろに町名・説明が続けば市区町村まで）を確かめて、
 * 住所データの表記（郡なし）にする。複数の地域を並べた答え・市区町村として読めず決まりも守らない答え（施設名だけ・郡だけ）は場所名を使わず
 * （空の場所名＝今の場所名を残す）、自信なしにして顧客に確かめる。読めないが決まりの形の名前は値を残し、自信なしにする
 */
export function checkFound(index: PlaceIndex, f: Found): Checked {
  const prefecture = prefectureFromShortName(f.prefecture.trim())
  if (!prefecture) return { ok: false, note: f.prefecture ? `都道府県「${f.prefecture}」が47都道府県名と一致しません` : "都道府県が分かりませんでした" }
  const names = index.get(prefecture)
  const raw = f.place.trim()
  const unsure = (why: string, place = ""): Checked => ({ ok: true, found: { ...f, prefecture, place, confident: false, note: [f.note, why].filter(Boolean).join(" / ") } })
  if (!raw) return { ok: true, found: { ...f, prefecture, place: "" } }
  const tidy = tidyPlace(raw, prefecture)
  const readOne = (s: string) => (names ? (readName(names, fold(s)) ?? readName(names, fold(withoutGun(s)))) : undefined)
  // 2つ以上の市区町村を並べた答えは1つに決められない（句読点のあとが説明なら、前の市区町村を読む）
  if (tidy.value.split(PLACE_LIST).filter((part) => part && readOne(part)).length > 1) return unsure(`場所名「${raw}」は複数の地域なので使いません`)
  const read = readOne(tidy.value)
  if (read) return { ok: true, found: { ...f, prefecture, place: read } }
  if (tidy.issue) return unsure(`場所名「${raw}」は市区町村の名前でないため使いません`)
  return unsure(`場所名「${tidy.value}」を${prefecture}の市区町村として確かめられませんでした`, tidy.value)
}


/** 市区町村の名前（完全に一致するか、後ろに町名などが続くなら一番長い名前） */
function readName(names: ReadonlyMap<string, string>, folded: string) {
  const exact = names.get(folded)
  if (exact) return exact
  const longest = [...names.keys()].filter((n) => folded.startsWith(n)).sort((a, b) => b.length - a.length)[0]
  return longest === undefined ? undefined : names.get(longest)
}

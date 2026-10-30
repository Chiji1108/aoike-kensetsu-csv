import { z } from "zod"
import { PREFECTURES, prefectureFromShortName, type Prefecture } from "../spec/prefectures"
import type { Found } from "./sites"

/**
 * 調べた都道府県・場所名の検算。住所の分け方（convert/address.ts）と同じ住所データ（Geolonia の市区町村の一覧 ja.json）で、
 * 場所名がその都道府県の市区町村（政令市は区まで・区まで書いていない政令市。郡は付けない）の名前かを確かめ、住所データの表記にそろえる
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
 * 検算する。都道府県が47都道府県（省略形も読む）でなければ使わない。場所名は「、」で並べた地域ごとに、その都道府県の市区町村の名前か
 * （「港区赤坂」のように後ろに町名が続けば市区町村まで）を確かめ、住所データの表記にする。読めない地域があれば値は残し、自信なしにする
 */
export function checkFound(index: PlaceIndex, f: Found): Checked {
  const prefecture = prefectureFromShortName(f.prefecture.trim())
  if (!prefecture) return { ok: false, note: f.prefecture ? `都道府県「${f.prefecture}」が47都道府県名と一致しません` : "都道府県が分かりませんでした" }
  const names = index.get(prefecture)
  let place = f.place.trim()
  if (place.startsWith(prefecture)) place = place.slice(prefecture.length)
  if (!place || !names) return { ok: true, found: { ...f, prefecture, place } }
  const parts = place.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
  const readPart = (folded: string) => {
    const exact = names.get(folded)
    if (exact) return exact
    const longest = [...names.keys()].filter((n) => folded.startsWith(n)).sort((a, b) => b.length - a.length)[0]
    return longest === undefined ? undefined : names.get(longest)
  }
  // 住所データの町村には郡が無いので、「三島郡出雲崎町」は郡を除いて読む
  const read = parts.map((part) => readPart(fold(part)) ?? readPart(fold(part).replace(/^[^市区町村]+?郡/, "")))
  if (read.some((r) => r === undefined))
    return { ok: true, found: { ...f, prefecture, place, confident: false, note: [f.note, `場所名「${place}」を${prefecture}の市区町村として確かめられませんでした`].filter(Boolean).join(" / ") } }
  return { ok: true, found: { ...f, prefecture, place: [...new Set(read as string[])].join("、") } }
}

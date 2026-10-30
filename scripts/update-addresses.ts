/**
 * 同梱の住所データ（市区町村の一覧）を Geolonia の住所データ（CC BY 4.0）の最新に更新する。
 * 住所の分割（@geolonia/normalize-japanese-addresses）は市区町村までしか使わないので、町字のデータは同梱しない。
 *
 *   bun scripts/update-addresses.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ADDRESS_API_PATH } from "../src/lib/convert/address"

const SOURCE = "https://japanese-addresses-v2.geoloniamaps.com/api/ja.json"
const out = fileURLToPath(new URL(`../public${ADDRESS_API_PATH}.json`, import.meta.url))
const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`)
const json = (await res.json()) as { meta: { updated: number }; data: { pref: string; cities: unknown[] }[] }
if (json.data.length !== 47) throw new Error(`都道府県が ${json.data.length} 件（47件のはず）`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(json))
console.log(`${out}: 市区町村 ${json.data.reduce((n, p) => n + p.cities.length, 0)} 件（データの更新 ${new Date(json.meta.updated * 1000).toISOString().slice(0, 10)}）`)

import { PREFECTURES, type Prefecture } from "../spec/prefectures"
import { z } from "zod"
import { nfkc, removeSpaces } from "./text"

/**
 * 住所 → 都道府県・市区町村。市区町村の照合は @geolonia/normalize-japanese-addresses（政令市の区・郡・表記ゆれ）に任せる。
 * 照合は非同期（住所データを読む）なので、変換の前に住所の値をまとめて引いておき（lookupAddresses）、変換はその結果（AddressBook）を読む。
 * 住所データ（市区町村の一覧 ja.json）は public/ に同梱する（scripts/update-addresses.ts で更新。Geolonia の公開 API は停止・変更がありうると案内されている）
 */

export type AddressSplit = {
  /** 住所に書いてあった都道府県（正式名か「神奈川」のような省略形）。書いていなければ無い（市区町村から推し量らない） */
  prefecture?: Prefecture
  /** 市区町村（政令市は区まで、郡部は郡＋町村）。住所データの正式な表記 */
  city?: string
}

/** 住所の値（空白を除き NFKC で揃えたもの）→ 分けた結果。引いていない値は無い（変換は AI に回す） */
export type AddressBook = ReadonlyMap<string, AddressSplit>
export const NO_ADDRESSES: AddressBook = new Map()

/** 住所の値を引く（ブラウザは同梱の住所データを URL で、照合スクリプト・テストはファイルで読む） */
export type AddressLookup = (raws: Iterable<string>) => Promise<AddressBook>

export const addressKey = (raw: string) => removeSpaces(nfkc(raw))

/** 同梱の住所データの場所（public/ の下。ライブラリが `${api}.json` を読む） */
export const ADDRESS_API_PATH = "/japanese-addresses/api/ja"

/** 「神奈川県」→「神奈川」（北海道はそのまま） */
const shortName = (p: Prefecture) => (p === "北海道" ? p : p.slice(0, -1))

type Normalize = (typeof import("@geolonia/normalize-japanese-addresses"))["normalize"]

/** 住所データ（ja.json）のうち、政令市の区の一覧に使うところ */
const jaSchema = z.object({ data: z.array(z.object({ pref: z.string(), cities: z.array(z.object({ city: z.string(), ward: z.string().optional() })) })) })

/** 都道府県ごとの、政令市の区の名前 → 政令市の名前（同じ区の名前が県内の2つの政令市にあれば両方） */
type Wards = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>

function wardsOf(ja: z.infer<typeof jaSchema>): Wards {
  return new Map(
    ja.data.map((p) => {
      const wards = new Map<string, string[]>()
      for (const c of p.cities) if (c.ward) wards.set(c.ward, [...(wards.get(c.ward) ?? []), c.city])
      return [p.pref, wards]
    }),
  )
}

/** 都道府県ごとの市区町村の名前（政令市は区まで。郡部は「郡」を省いた名前も）。都道府県の無い住所をどの都道府県で読むかを絞る */
type CityNames = ReadonlyMap<Prefecture, readonly string[]>

/** 表記の揺れを畳む（ヶ・ヵ → ケ）。候補を絞るのにだけ使い、市区町村の名前はライブラリが決める */
const fold = (s: string) => s.replace(/[ヶヵ]/g, "ケ")

function cityNamesOf(ja: z.infer<typeof jaSchema>): CityNames {
  return new Map(
    ja.data.flatMap((p) => {
      const pref = PREFECTURES.find((x) => x === p.pref)
      if (!pref) return []
      const names = p.cities.flatMap((c) => {
        const name = fold(c.city + (c.ward ?? ""))
        const town = /^.+?郡(.+)$/.exec(name)?.[1]
        // 政令市は区まで書かないこともある（「横浜市」）ので、市の名前も入れる
        return [name, ...(town ? [town] : []), ...(c.ward ? [fold(c.city)] : [])]
      })
      return [[pref, names] as const]
    }),
  )
}

type Reader = { normalize: Normalize; wards: Wards; cities: CityNames }

/**
 * 都道府県 p の市区町村として読めたら、その市区町村（住所データの表記）。町字のデータで候補を絞ろうとした（同梱していない）ときも読めない。
 * withWard なら、政令市の名前を省いた区（「千葉県花見川区」）も、県内にその区を持つ政令市が1つだけなら政令市の区として読む。
 * 区まで書いていない政令市（「横浜市」）は市として読む
 */
async function cityIn({ normalize, wards }: Reader, p: Prefecture, rest: string, withWard: boolean) {
  try {
    const r = await normalize(p + rest, { level: 2 })
    if (r.level >= 2 && r.pref === p && r.city) return r.city
  } catch {
    // 下の区・政令市の照合に進む
  }
  const designated = wards.get(p) ?? new Map<string, readonly string[]>()
  if (withWard) {
    const found = [...designated].filter(([ward]) => rest.startsWith(ward))
    const cities = found.flatMap(([ward, cs]) => cs.map((c) => c + ward))
    if (cities.length === 1) return cities[0]
  }
  // 区まで書いていない政令市（「横浜市」「横浜市役所」）は市として読む。住所データに無い区が続く（「浜松市中区」のような廃止された区）なら読まない（AI へ）
  const city = [...new Set([...designated.values()].flat())].find((c) => fold(rest).startsWith(fold(c)))
  return city && !/^[^市区町村]{1,4}区/.test(rest.slice(city.length)) ? city : undefined
}

/**
 * 住所を1つ分ける。都道府県の正式名で始まればその都道府県の市区町村として読む（政令市の名前を省いた区も読む）。
 * 始まらなければ、その名前の市区町村がある都道府県（索引で絞る）のそれぞれの市区町村として読んでみて、ちょうど1つに決まるときだけ市区町村にする
 * （ライブラリに任せると「長野原町」を長野県と読んだり、「府中市」をどちらかの都に決めたりする。都道府県の無い「北区」は政令市の区として読まない）。
 * 都府県を省いた名前（「神奈川横浜市中区」）は、そのあとに続く市区町村がその都道府県にあるときだけ都道府県として読む。
 * 都道府県は住所に書いてあるときだけ返す（市区町村から推し量らない。「北区」は東京都とは限らない）
 */
async function splitOne(reader: Reader, key: string): Promise<AddressSplit> {
  const full = PREFECTURES.find((p) => key.startsWith(p))
  if (full) {
    const city = await cityIn(reader, full, key.slice(full.length), true)
    return { prefecture: full, ...(city ? { city } : {}) }
  }
  // 読んでみる都道府県を、市区町村の名前の索引で絞る（47都道府県すべてをライブラリで試さない）
  const folded = fold(key)
  const tries = PREFECTURES.flatMap((p) => {
    const short = shortName(p)
    const written = short !== p && key.startsWith(short) ? [{ p, rest: key.slice(short.length), written: true }] : []
    const bare = reader.cities.get(p)?.some((n) => folded.startsWith(n)) ? [{ p, rest: key, written: false }] : []
    return [...written, ...bare]
  })
  const results = await Promise.all(tries.map(async (t) => ({ ...t, city: await cityIn(reader, t.p, t.rest, t.written) })))
  const found = new Map<string, AddressSplit>()
  for (const r of results.filter((x) => x.written)) if (r.city) found.set(`${r.p}${r.city}`, { prefecture: r.p, city: r.city })
  for (const r of results.filter((x) => !x.written)) if (r.city && !found.has(`${r.p}${r.city}`)) found.set(`${r.p}${r.city}`, { city: r.city })
  return found.size === 1 ? [...found.values()][0]! : {}
}

/** 住所データを読み、索引を作ったもの（api ごとに1回。読めなかったら持たずに、次に呼ばれたとき読み直す） */
const readers = new Map<string, Promise<Reader>>()

function readerFor(api: string): Promise<Reader> {
  const known = readers.get(api)
  if (known) return known
  const loading = (async () => {
    const { normalize, config } = await import("@geolonia/normalize-japanese-addresses")
    config.japaneseAddressesApi = api
    const ja = await fetch(`${api}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j: unknown) => jaSchema.parse(j))
      .catch((e: unknown) => {
        throw new Error("住所データを読めませんでした", { cause: e })
      })
    return { normalize, wards: wardsOf(ja), cities: cityNamesOf(ja) }
  })()
  readers.set(api, loading)
  loading.catch(() => readers.delete(api))
  return loading
}

/**
 * 住所の値をまとめて引く。api は住所データの URL（`${api}.json` を読む）。
 * 都道府県・市区町村が決まらない値は空の結果にする（変換は AI に回す）。住所データを読めなければ投げる（すべての住所を黙って AI に回さない）
 */
export async function lookupAddresses(raws: Iterable<string>, api: string): Promise<AddressBook> {
  const keys = [...new Set([...raws].map(addressKey))].filter(Boolean)
  if (!keys.length) return NO_ADDRESSES
  const reader = await readerFor(api)
  return new Map(await Promise.all(keys.map(async (key) => [key, await splitOne(reader, key)] as const)))
}

/** 同梱の住所データを渡す URL（実在しない名前。この URL への fetch だけを手元の住所データで答える） */
const BUNDLED_API = "https://japanese-addresses.bundled.invalid/api/ja"

/**
 * 手元にある住所データ（ja.json の中身）で引く（サーバー用）。分け方は lookupAddresses と同じ（同じライブラリ・同じ splitOne）。
 * Worker からは同梱の静的ファイルを URL で読めず、ライブラリは住所データを fetch で読むので、住所データの URL への fetch だけを
 * 手元の住所データで答える（ほかの URL はそのままの fetch に渡す）
 */
export function bundledAddressLookup(json: unknown): AddressLookup {
  serveBundled(json)
  return (raws) => lookupAddresses(raws, BUNDLED_API)
}

const SERVED = Symbol.for("aoike.bundledAddresses")

function serveBundled(json: unknown) {
  const g = globalThis as typeof globalThis & { [SERVED]?: true }
  if (g[SERVED]) return
  g[SERVED] = true
  const original = g.fetch.bind(g)
  g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BUNDLED_API)) return original(input, init)
    // 市区町村の一覧（ja.json）だけを持つ。町字のデータ（level 3 以上）は同梱していないので、画面と同じく無いものとして答える
    return Promise.resolve(url.split("?")[0] === `${BUNDLED_API}.json` ? Response.json(json) : new Response("", { status: 404 }))
  }) as typeof fetch
}

/**
 * 引いた住所を持ち続ける（画面用）。ensure は持っていない値だけを引き、引き終わると持っている全部を返す。
 * 計画の住所と関係ない変更では引き直さず、住所の列が変わったときも新しい値だけを引く。
 * 住所データを読めなかった値は、その間だけ空の結果として見せ（AI に回す）、持ち続けない（次の ensure で引き直す）
 */
export function addressCache(lookup: AddressLookup) {
  let book: AddressBook = NO_ADDRESSES
  let failed: ReadonlySet<string> = new Set()
  /** 見せるもの（引いた住所と、引けなかった値の空の結果）。変わったときだけ作り直す（同じ中身なら同じ Map） */
  let shown: AddressBook = NO_ADDRESSES
  const refresh = () => {
    shown = failed.size ? new Map([...book, ...[...failed].map((k) => [k, {}] as const)]) : book
  }
  let inflight: Promise<unknown> = Promise.resolve()
  return {
    /** values の住所をすべて見せられれば、見せるもの全部（引いていない値があれば undefined） */
    covering(values: Iterable<string>): AddressBook | undefined {
      for (const v of values) {
        const k = addressKey(v)
        if (k && !shown.has(k)) return undefined
      }
      return shown
    },
    /** values のうち持っていない住所（前に引けなかった値も）を引く（同時に呼ばれたら順に引く）。住所データを読めなければ投げる */
    async ensure(values: Iterable<string>): Promise<AddressBook> {
      const list = [...values]
      const run = inflight.then(async () => {
        const missing = [...new Set(list.map(addressKey))].filter((k) => k && !book.has(k))
        if (!missing.length) return
        try {
          const got = await lookup(missing)
          book = new Map([...book, ...missing.map((k) => [k, got.get(k) ?? {}] as const)])
          failed = new Set([...failed].filter((k) => !book.has(k)))
        } catch (e) {
          failed = new Set([...failed, ...missing])
          throw e
        } finally {
          refresh()
        }
      })
      inflight = run.catch(() => undefined)
      await run
      return shown
    },
  }
}

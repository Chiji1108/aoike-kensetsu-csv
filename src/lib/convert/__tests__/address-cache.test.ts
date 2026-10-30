import { expect, test } from "bun:test"
import { addressCache, type AddressLookup } from "../address"

test("引いた住所は持ち続け、持っていない値だけを引く。読めなければ空の結果で持って知らせる", async () => {
  const asked: string[][] = []
  const lookup: AddressLookup = async (raws) => {
    const keys = [...raws]
    asked.push(keys)
    return new Map(keys.map((k) => [k, { city: k }]))
  }
  const cache = addressCache(lookup)
  expect(cache.covering(["東京都千代田区"])).toBeUndefined()
  await Promise.all([cache.ensure(["東京都千代田区", "東京都港区"]), cache.ensure(["東京都港区"])])
  expect(cache.covering(["東京都 港区", "東京都千代田区"])?.get("東京都港区")).toEqual({ city: "東京都港区" })
  await cache.ensure(["東京都千代田区", "大阪府大阪市北区"])
  expect(asked).toEqual([["東京都千代田区", "東京都港区"], ["大阪府大阪市北区"]])

})

test("住所データを読めなかった値は、その間だけ空の結果として見せ、持ち続けない（次に引くとき引き直す）", async () => {
  let down = true
  const asked: string[][] = []
  const cache = addressCache(async (raws) => {
    asked.push([...raws])
    if (down) throw new Error("住所データを読めませんでした")
    return new Map([...raws].map((k) => [k, { city: "千代田区" }]))
  })
  await expect(cache.ensure(["東京都千代田区"])).rejects.toThrow("住所データ")
  expect(cache.covering(["東京都千代田区"])?.get("東京都千代田区")).toEqual({})
  down = false
  await cache.ensure(["東京都千代田区"])
  expect(cache.covering(["東京都千代田区"])?.get("東京都千代田区")).toEqual({ city: "千代田区" })
  expect(asked).toHaveLength(2)
})

test("住所データは api ごとに1回だけ読む", async () => {
  const { lookupAddresses } = await import("../address")
  const { pathToFileURL, fileURLToPath } = await import("node:url")
  const api = pathToFileURL(fileURLToPath(new URL("../../../../public/japanese-addresses/api/ja", import.meta.url))).href
  const real = globalThis.fetch
  let reads = 0
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `${api}.json`) reads++
    return real(input, init)
  }) as typeof fetch
  try {
    await lookupAddresses(["東京都港区"], api)
    await lookupAddresses(["東京都品川区"], api)
  } finally {
    globalThis.fetch = real
  }
  expect(reads).toBeLessThanOrEqual(1)
})

import { describe, expect, test } from "bun:test"
import { fetchUsdJpy, FX_URL, yenOf, type FxCache } from "../fx"

/** Workers の Cache API の代わり（URL ごとに1つ持つ） */
function memoryCache(): FxCache & { size: () => number } {
  const m = new Map<string, Response>()
  return {
    size: () => m.size,
    async match(req) {
      return m.get(req.url)?.clone()
    },
    async put(req, res) {
      m.set(req.url, res)
    },
  }
}

const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })

describe("ドル円", () => {
  test("取れたらレートと日付を返し、1日持つ。2回目は為替のサービスに聞かない", async () => {
    const cache = memoryCache()
    const asked: string[] = []
    const fetchFn = async (url: string) => (asked.push(url), new Response(JSON.stringify({ amount: 1, base: "USD", date: "2026-10-28", rates: { JPY: 157.96 } })))
    expect(await fetchUsdJpy(fetchFn, cache)).toEqual({ rate: 157.96, date: "2026-10-28" })
    expect(await fetchUsdJpy(fetchFn, cache)).toEqual({ rate: 157.96, date: "2026-10-28" })
    expect(asked).toEqual([FX_URL])
    expect(yenOf(0.5, { rate: 157.96, date: "2026-10-28" })).toBe(79)
  })

  test("取れない（失敗の応答・形が違う・通信の失敗）ときは null（円を出さない）。取れなかった応答は持たない", async () => {
    const cache = memoryCache()
    expect(await fetchUsdJpy(answer({ message: "not found" }, 404), cache)).toBeNull()
    expect(await fetchUsdJpy(answer({ date: "2026-10-28", rates: {} }), cache)).toBeNull()
    expect(
      await fetchUsdJpy(async () => {
        throw new TypeError("fetch failed")
      }, cache),
    ).toBeNull()
    expect(cache.size()).toBe(0)
  })
})

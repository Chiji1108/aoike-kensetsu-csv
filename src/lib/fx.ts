import { z } from "zod"

/**
 * 費用を円でも見せるときのドル円（欧州中央銀行の参照レート。Frankfurter、キー不要、毎営業日更新）。
 * 費用はドルで保存し、円は見せるときだけ換算する。取れなければ円は出さない（決め打ちの値は使わない）
 */
export type UsdJpy = { rate: number; date: string }

export const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY"

/** 取ったレートを持つ時間（参照レートは1日1回なので1日） */
const CACHE_SECONDS = 24 * 60 * 60

const responseSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rates: z.object({ JPY: z.number().positive() }) })

/** Workers の Cache API のうち使うところ */
export type FxCache = { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> }

/** レートを取る。cache にあればそれを使い、無ければ取って入れる。取れない・形が違うときは null */
export async function fetchUsdJpy(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, cache: FxCache | null): Promise<UsdJpy | null> {
  const key = new Request(FX_URL)
  try {
    const hit = await cache?.match(key)
    const res = hit ?? (await fetchFn(FX_URL, { signal: AbortSignal.timeout(3_000) }))
    if (!res.ok) return null
    const parsed = responseSchema.safeParse(await res.json())
    if (!parsed.success) return null
    if (!hit) await cache?.put(key, new Response(JSON.stringify(parsed.data), { headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_SECONDS}` } }))
    return { rate: parsed.data.rates.JPY, date: parsed.data.date }
  } catch {
    // 為替のサービスに届かない（タイムアウト・通信の失敗）ときは円を出さないだけにする
    return null
  }
}

export const yenOf = (usd: number, fx: UsdJpy) => Math.round(usd * fx.rate)

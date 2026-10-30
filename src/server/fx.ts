import { fetchUsdJpy } from "@/lib/fx"

/** ドル円（Workers の Cache API に1日持つ）。取れなければ null */
export function getUsdJpy() {
  return fetchUsdJpy((url, init) => fetch(url, init), typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default)
}

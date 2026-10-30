import { toHex } from "./final-sheet"

/**
 * 案件の最後の Excel の照合用の鍵。サーバーの秘密（BETTER_AUTH_SECRET）と案件の id の HMAC で決めるので、案件ごとにいつも同じ
 * （保存しない。2つのタブ・保存の前に閉じても同じ鍵になる）。画面に渡し、Excel には書かない
 */
export async function excelKeyOf(secret: string, caseId: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`final-excel\n${caseId}`))))
}

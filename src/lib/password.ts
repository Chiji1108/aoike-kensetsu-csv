// Workers の CPU 制限を考慮し、Web Crypto ネイティブの PBKDF2-SHA256 でパスワードをハッシュ化する。
// 形式: pbkdf2$<iterations>$<salt(base64)>$<hash(base64)>
// （Cloudflare Workers の PBKDF2 は最大 100,000 回まで）

const ITERATIONS = 100_000
const KEY_LENGTH = 32

function toBase64(bytes: Uint8Array) {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(b64: string) {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_LENGTH * 8,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }) {
  const [scheme, iter, saltB64, hashB64] = hash.split("$")
  if (scheme !== "pbkdf2" || !iter || !saltB64 || !hashB64) return false
  const expected = fromBase64(hashB64)
  const actual = await derive(password, fromBase64(saltB64), Number(iter))
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!
  return diff === 0
}

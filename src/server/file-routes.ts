import { env } from "cloudflare:workers"
import { z } from "zod"
import { getDb } from "@/db"
import { contentTypeOf, FILE_KINDS } from "@/lib/cases/types"
import * as store from "./case-store"
import { signedIn, text } from "./http"

/** Workers が受け取れる本文の上限（無料・Pro プラン） */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

const uploadHeaders = z.object({
  kind: z.enum(FILE_KINDS),
  name: z.string().trim().min(1).max(200),
})


/**
 * 案件にファイルを付ける。本文はファイルそのもの。種類と名前はヘッダー（X-File-Kind、X-File-Name は encodeURIComponent したもの）で受け、
 * ファイル名を URL（ログに残る）に載せない。独自のヘッダーが要るので、ほかのサイトのフォームや CORS の許可の無い fetch からは送れない（サーバー関数の CSRF の確認の代わり）。
 * 大きさは Content-Length で先に受ける（R2 は長さの分からない本文を置けない。上限を超えるものは読まずに断る）。記録する大きさは R2 に置いた実際の大きさ
 */
export const uploadCaseFile = (request: Request, caseId: string) => signedIn(request, () => upload(request, caseId))

async function upload(request: Request, caseId: string) {
  const h = request.headers
  const length = h.get("content-length")
  if (length === null) return text("ファイルの大きさ（Content-Length）がありません", 411)
  if (!/^\d+$/.test(length)) return text("ファイルの大きさ（Content-Length）が読めません", 400)
  if (Number(length) > MAX_UPLOAD_BYTES) return text("ファイルは 100MB までです", 413)
  if (!request.body || Number(length) === 0) return text("ファイルが空です", 400)
  let name: string
  try {
    name = decodeURIComponent(h.get("x-file-name") ?? "")
  } catch {
    return text("ファイル名が読めません", 400)
  }
  const parsed = uploadHeaders.safeParse({ kind: h.get("x-file-kind"), name })
  if (!parsed.success) return text("ファイルの種類・名前が正しくありません", 400)
  const saved = await store.addFile(getDb(), env.FILES, caseId, { ...parsed.data, contentType: contentTypeOf(parsed.data.name), body: request.body })
  return saved ? Response.json(saved) : text("案件が見つかりません（削除された案件にはファイルを付けられません）", 404)
}

/** ファイルを返す（ログインしているときだけ。R2 は公開しない）。いつも保存させ、ブラウザに中身から種類を推測させない */
export const downloadCaseFile = (request: Request, fileId: string) => signedIn(request, () => download(fileId))

async function download(fileId: string) {
  const row = await store.getFileRow(getDb(), fileId)
  const object = row && (await env.FILES.get(row.r2Key))
  if (!row || !object) return text("ファイルが見つかりません", 404)
  return new Response(object.body, {
    headers: {
      "content-type": row.contentType,
      "content-length": String(object.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  })
}

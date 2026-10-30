import { requireSession, SignedOutError } from "./middleware"

/** 文章の応答（エラーの理由など） */
export const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } })

/** ログインしているときだけ handle を実行する（していなければ 401）。サーバー関数ではない API のルートで使う */
export async function signedIn(request: Request, handle: () => Promise<Response>) {
  try {
    await requireSession(request.headers)
  } catch (e) {
    if (e instanceof SignedOutError) return text(e.message, 401)
    throw e
  }
  return handle()
}

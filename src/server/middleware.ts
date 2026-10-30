import { createMiddleware, createServerOnlyFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { getAuth } from "@/lib/auth"

export class SignedOutError extends Error {
  constructor() {
    super("ログインが必要です")
  }
}

/** 要求のログインを確かめる。ログインしていなければ SignedOutError を投げる */
export const requireSession = createServerOnlyFn(async (headers: Headers) => {
  const session = await getAuth().api.getSession({ headers })
  if (!session) throw new SignedOutError()
  return session
})

/** ログイン必須のサーバー関数に付けるミドルウェア */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => next({ context: { session: await requireSession(getRequestHeaders()) } }))

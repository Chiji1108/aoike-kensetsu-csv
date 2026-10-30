import { createCsrfMiddleware, createStart } from "@tanstack/react-start"

// サーバー関数（データの読み書き）は同一オリジンからの呼び出しのみ許可する
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
})

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}))

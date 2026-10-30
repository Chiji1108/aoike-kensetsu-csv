import { createServerFn } from "@tanstack/react-start"
import { getUsdJpy } from "./fx"
import { authMiddleware } from "./middleware"

/** ドル円（表示だけの値なので、画面は表示を止めずにあとから読む） */
export const getUsdJpyFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => getUsdJpy())

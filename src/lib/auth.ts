import { env } from "cloudflare:workers"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { getDb } from "@/db"
import * as schema from "@/db/schema"
import { APP_NAME } from "./constants"
import { hashPassword, verifyPassword } from "./password"

function createAuth() {
  return betterAuth({
    appName: APP_NAME,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || undefined,
    database: drizzleAdapter(getDb(), {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // 公開ユーザー登録は行わない（アカウントは scripts/set-password.ts で作成）
      disableSignUp: true,
      minPasswordLength: 8,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      // 一度ログインすれば、毎回パスワードを入力しなくてよいように長めに保持する
      expiresIn: 60 * 60 * 24 * 90, // 90日
      updateAge: 60 * 60 * 24, // 1日ごとに有効期限を延長
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: [tanstackStartCookies()],
  })
}

let instance: ReturnType<typeof createAuth> | undefined

export function getAuth() {
  instance ??= createAuth()
  return instance
}

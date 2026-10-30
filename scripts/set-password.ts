/**
 * 事務所共通アカウントの作成 / パスワード再設定
 *
 *   bun run set-password            # ローカル（開発用 D1）
 *   bun run set-password --remote   # 本番 D1
 *
 * パスワードを変更すると、すべての端末でログアウトされます。
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OFFICE_ACCOUNT_EMAIL, OFFICE_ACCOUNT_NAME } from "../src/lib/constants"
import { hashPassword } from "../src/lib/password"

const remote = process.argv.includes("--remote")
const fromArg = process.argv.slice(2).find((a) => !a.startsWith("--"))

const password = fromArg ?? prompt("新しいパスワードを入力してください（8文字以上）:")?.trim()
if (!password || password.length < 8) {
  console.error("パスワードは8文字以上で入力してください。")
  process.exit(1)
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`
const hash = await hashPassword(password)
const now = Date.now()
const userIdExpr = `(SELECT id FROM "user" WHERE email = ${q(OFFICE_ACCOUNT_EMAIL)})`

const sql = `
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('office', ${q(OFFICE_ACCOUNT_NAME)}, ${q(OFFICE_ACCOUNT_EMAIL)}, 1, ${now}, ${now})
ON CONFLICT(email) DO NOTHING;

INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
VALUES ('office-credential', ${userIdExpr}, 'credential', ${userIdExpr}, ${q(hash)}, ${now}, ${now})
ON CONFLICT(id) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at;

DELETE FROM session WHERE user_id = ${userIdExpr};
`

const dir = mkdtempSync(join(tmpdir(), "aoike-"))
const file = join(dir, "set-password.sql")
writeFileSync(file, sql)
try {
  const proc = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "DB", remote ? "--remote" : "--local", "--yes", `--file=${file}`],
    { stdio: "inherit" },
  )
  if (proc.status !== 0) process.exit(proc.status ?? 1)
  console.log(`\n✔ パスワードを設定しました（${remote ? "本番" : "ローカル"}）`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

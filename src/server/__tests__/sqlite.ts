import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import * as schema from "@/db/schema"
import type { Db } from "../case-store"

const MIGRATIONS = new URL("../../../drizzle/", import.meta.url).pathname

/**
 * 本番と同じマイグレーションを当てた sqlite（D1 と同じく外部キーを効かせる）。file を渡すとそのファイルに置く（照合スクリプトが覚えた結果を回をまたいで持つ）。
 * 当てたマイグレーションは drizzle の記録の表に残し、まだ当てていないものだけを当てる（あとから足したマイグレーションも当たる）
 */
export function migratedDb(file = ":memory:"): { db: Db; sqlite: Database } {
  const sqlite = new Database(file)
  sqlite.run("PRAGMA foreign_keys = ON")
  const base = drizzle(sqlite, { schema })
  migrate(base, { migrationsFolder: MIGRATIONS })
  // D1 の batch と同じく、渡した書き込みを1つのトランザクションで流し、それぞれの結果（returning の行）を返す
  const batch = async (queries: readonly { all: () => unknown }[]) => sqlite.transaction(() => queries.map((q) => q.all()))()
  return { db: Object.assign(base, { batch }) as unknown as Db, sqlite }
}

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migratedDb } from "./sqlite"

describe("照合・テストの sqlite", () => {
  test("ファイルの sqlite は、当てたマイグレーションを覚え、まだ当てていないものだけを当てる", () => {
    const file = join(mkdtempSync(join(tmpdir(), "mig-")), "db.sqlite")
    const first = migratedDb(file)
    const journal = JSON.parse(readFileSync(new URL("../../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] }
    // 最後のマイグレーション（0005: 前の形のルールの表と列を消す）を当てる前の状態にする（記録を消し、消した表と列を戻す）
    first.sqlite.run("delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)")
    first.sqlite.run("create table csv_rules (id text primary key not null, rules text default '' not null, updated_at integer not null)")
    first.sqlite.run("alter table csv_customers add column rules text default '' not null")
    first.sqlite.close()
    const again = migratedDb(file)
    expect(again.sqlite.query("select name from sqlite_master where name = 'csv_rules'").all()).toEqual([])
    expect(again.sqlite.query("select name from pragma_table_info('csv_customers') where name = 'rules'").all()).toEqual([])
    expect((again.sqlite.query("select count(*) as n from __drizzle_migrations").get() as { n: number }).n).toBe(journal.entries.length)
  })
})

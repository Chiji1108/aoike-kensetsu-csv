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
    // 最後のマイグレーション（0007: 要望の表を足す）を当てる前の状態にする（記録を消し、足した表を消す）
    first.sqlite.run("delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)")
    first.sqlite.run("drop table csv_feedback")
    first.sqlite.close()
    const again = migratedDb(file)
    expect(again.sqlite.query("select name from sqlite_master where type = 'table' and name = 'csv_feedback'").all()).toEqual([{ name: "csv_feedback" }])
    expect((again.sqlite.query("select count(*) as n from __drizzle_migrations").get() as { n: number }).n).toBe(journal.entries.length)
  })
})

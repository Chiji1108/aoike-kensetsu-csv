import { describe, expect, test } from "bun:test"
import { caseTableWireSchema } from "../wire"

describe("チャットに送る表の形", () => {
  test("7割の計算が無い前の形（デプロイの前から開いていた画面）も読み、税抜にする", () => {
    const old = { rows: [], added: [], edits: [], replacements: {}, manual: [], tax: "unknown", basis: {}, selection: "rule7", sorted: true }
    const parsed = caseTableWireSchema.safeParse(old)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.rule7Tax).toBe("excluded")
    expect(caseTableWireSchema.parse({ ...old, rule7Tax: "included" }).rule7Tax).toBe("included")
  })
})

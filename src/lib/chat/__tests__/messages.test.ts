import { describe, expect, test } from "bun:test"
import { chatDataSchemas, currentAction } from "../messages"

describe("保存した会話のボタン", () => {
  test("前の edit_excel（編集用の Excel）も読め、書き出す前の確認のボタンになる", () => {
    expect(chatDataSchemas.action.parse({ action: "edit_excel" })).toEqual({ action: "edit_excel" })
    expect(currentAction("edit_excel")).toBe("export")
    expect(currentAction("inquiry_excel")).toBe("inquiry_excel")
    expect(chatDataSchemas.action.safeParse({ action: "nope" }).success).toBe(false)
  })
})

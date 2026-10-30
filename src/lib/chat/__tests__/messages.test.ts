import { expect, test } from "bun:test"
import { conversationUsd, ENDED_TEXT, type ChatMessage } from "../messages"

const reply = (id: string, usd: number): ChatMessage => ({ id, role: "assistant", parts: [], metadata: { usd, caseUsd: 0, ms: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 } })
const ended = (id: string): ChatMessage => ({ id, role: "system", parts: [{ type: "text", text: ENDED_TEXT }] })

test("この会話の費用は、最後に会話を終えたより後の返事だけを足す", () => {
  expect(conversationUsd([reply("a", 0.5), ended("e"), reply("b", 0.25), { id: "u", role: "user", parts: [] }, reply("c", 0.125)])).toBe(0.375)
  expect(conversationUsd([reply("a", 0.5)])).toBe(0.5)
  expect(conversationUsd([reply("a", 0.5), ended("e")])).toBe(0)
})

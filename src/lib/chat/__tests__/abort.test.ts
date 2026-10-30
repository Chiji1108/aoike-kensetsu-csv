import { describe, expect, test } from "bun:test"
import { isStepCount, simulateReadableStream, streamText, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { z } from "zod"

/**
 * AI SDK のふるまいの確かめ: 止めた回の responseMessages は途中までの内容で resolve せず reject する
 * （server/chat.ts は responseMessages が resolve したときだけ回を履歴に足す）
 */
const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1 } }
const textStep = (words: number) => ({
  stream: simulateReadableStream({
    chunkDelayInMs: 20,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      ...Array.from({ length: words }, (_, i) => ({ type: "text-delta", id: "t", delta: `w${i} ` })),
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as never,
  }),
})
const toolStep = () => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "get_table", input: "{}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
    ] as never,
  }),
})

async function outcome(steps: (() => ReturnType<typeof textStep>)[], abortAfterMs: number) {
  let n = 0
  // 応答の部品の型（@ai-sdk/provider）は直接の依存ではないので、決まった応答はここで型を合わせる
  const model = new MockLanguageModelV4({ doStream: async () => steps[n++]!() as never })
  const ctrl = new AbortController()
  const r = streamText({
    model,
    prompt: "x",
    abortSignal: ctrl.signal,
    stopWhen: isStepCount(5),
    tools: { get_table: tool({ inputSchema: z.object({}), execute: async () => "[]" }) },
  })
  void r.consumeStream()
  setTimeout(() => ctrl.abort(new Error("職員が止めました")), abortAfterMs)
  return r.responseMessages.then(
    () => "resolved",
    () => "rejected",
  )
}

describe("止めた回の responseMessages", () => {
  test("返事の途中で止めると reject する", async () => {
    expect(await outcome([() => textStep(30)], 150)).toBe("rejected")
  })

  test("道具を呼んだ往復のあと、次の往復の途中で止めても reject する", async () => {
    expect(await outcome([toolStep as never, () => textStep(30)], 150)).toBe("rejected")
  })

  test("止める前に終わった回は resolve する", async () => {
    expect(await outcome([() => textStep(2)], 500)).toBe("resolved")
  })
})

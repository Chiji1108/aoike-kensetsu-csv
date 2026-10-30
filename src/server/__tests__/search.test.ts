import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type Anthropic from "@anthropic-ai/sdk"
import { jaSchema, placeIndex } from "@/lib/location/check"
import { siteKeyOf } from "@/lib/location/sites"
import { SearchError, searchLocation } from "../location"

const index = placeIndex(jaSchema.parse(JSON.parse(readFileSync(new URL("../../../public/japanese-addresses/api/ja.json", import.meta.url), "utf8"))))
const site = { key: siteKeyOf("テストビル改修工事", "株式会社テスト"), workName: "テストビル改修工事", client: "株式会社テスト", rowKeys: ["s!1"], knowledgeTried: true }
const usage = { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }

/** 決まった返事を順に返す Anthropic の代わり。送った要求を requests に溜める */
function fakeClient(replies: { stop_reason: string; content: unknown[] }[], requests: unknown[] = []) {
  let n = 0
  return { beta: { messages: { create: async (req: unknown) => (requests.push(req), { ...replies[n++]!, usage }) } } } as unknown as Anthropic
}

const results = (url: string) => ({ type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url, title: "t", encrypted_content: "x" }] })
const report = (input: object) => ({ type: "tool_use", id: "t", name: "report_location", input })

describe("Web 検索の答えの受け取り", () => {
  test("答えは道具で受け取り、根拠は止まって続けさせた返事（pause_turn）の検索結果も合わせて集める", async () => {
    const requests: unknown[] = []
    const spent = { usd: 0, searches: 0 }
    const out = await searchLocation(
      fakeClient(
        [
          { stop_reason: "pause_turn", content: [results("https://example.com/first")] },
          { stop_reason: "tool_use", content: [report({ prefecture: "東京都", place: "港区", confident: true, note: "ビルの所在地" })] },
        ],
        requests,
      ),
      index,
      site,
      spent,
    )
    expect(out).toMatchObject({ kind: "found", prefecture: "東京都", place: "港区", urls: ["https://example.com/first"] })
    expect(spent.searches).toBe(2)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify((requests[0] as { tools: unknown[] }).tools)).toContain('"strict":true')
  })

  test("答えの道具を呼ばなかったら投げる（やり直す）。返事の文の JSON は読まない", async () => {
    const client = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: '{"prefecture":"東京都","place":"港区","confident":true,"note":""}' }] }])
    await expect(searchLocation(client, index, site, { usd: 0, searches: 0 })).rejects.toBeInstanceOf(SearchError)
  })

  test("分からなければ notFound。長い文は切る", async () => {
    const out = await searchLocation(fakeClient([{ stop_reason: "tool_use", content: [report({ prefecture: "", place: "", confident: false, note: "あ".repeat(1000) })] }]), index, site, { usd: 0, searches: 0 })
    expect(out.kind).toBe("notFound")
    expect((out as { note: string }).note.length).toBeLessThanOrEqual(300)
  })
})

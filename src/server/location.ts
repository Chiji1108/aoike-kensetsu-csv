import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"
import { parseAiResponse, type AiBatchRequest } from "@/lib/convert/ai-tasks"
import { tokensOfMessage, usdOf } from "@/lib/cost"
import { checkFound, type PlaceIndex } from "@/lib/location/check"
import { normalizeOutcome, siteInput, type Found, type Outcome, type Site } from "@/lib/location/sites"
import type { AnonymizeCaller } from "@/lib/chat/turn"
import { searchable } from "./location-store"

/**
 * 工事場所の調べ方（Workers の env に依らないので、照合スクリプトからも使える）。
 * 1. AI の知識: 変換の所在地の推定と同じ AI（inferLocation）。自信ありで、住所データで検算できたものだけ使う。
 * 2. Web 検索: Claude API の web_search（web_search_20260209）。チャットとは別のやり取りで1現場ずつ聞き、答えは道具（report_location、strict）で受け取り、根拠は検索の引用の URL。
 * 外に送るのは CSV に出す工事名・注文者（匿名化のあと）だけ。個人名のある現場は呼ぶ前に断る
 */

const MODEL = "claude-opus-5-5"
/** Web 検索の料金（1,000回 $10） */
export const USD_PER_SEARCH = 0.01
/** 1現場で検索してよい回数 */
const MAX_SEARCHES_PER_SITE = 3
/** 長い検索の途中で止まった（pause_turn）ときに続けさせる回数 */
const MAX_CONTINUES = 3

export type Spent = { usd: number; searches: number }

/** AI の知識に1回で聞く現場の数（応答が長くなりすぎず、失敗したときにやり直す分が小さい大きさ） */
export const KNOWLEDGE_CHUNK = 25

/** AI の知識で答える。site ごとに、自信ありで検算できた場所（無ければ undefined。Web 検索に回す） */
export async function knowLocations(call: AnonymizeCaller, index: PlaceIndex, sites: readonly Site[]): Promise<{ found: Map<string, Found>; usd: number; failure?: string }> {
  const found = new Map<string, Found>()
  let usd = 0
  let failure: string | undefined
  const asked = sites.filter(searchable)
  for (let i = 0; i < asked.length; i += KNOWLEDGE_CHUNK) {
    const chunk = asked.slice(i, i + KNOWLEDGE_CHUNK)
    const request: AiBatchRequest = { task: "inferLocation", items: chunk.map((s, id) => ({ id, input: siteInput(s) })) }
    const res = await call(request)
    usd += res.usd
    const parsed = res.ok ? parseAiResponse("inferLocation", request, res.json) : res
    if (!parsed.ok) {
      failure = parsed.message
      continue
    }
    chunk.forEach((s, id) => {
      const r = parsed.results.get(id)
      if (!r || r.needsReview || !r.prefecture) return
      const checked = checkFound(index, { prefecture: r.prefecture, place: r.place, urls: [], source: "knowledge", confident: true, note: r.note })
      if (checked.ok && checked.found.confident) found.set(s.key, checked.found)
    })
  }
  return { found, usd, ...(failure ? { failure } : {}) }
}

const answerSchema = z.strictObject({ prefecture: z.string(), place: z.string(), confident: z.boolean(), note: z.string() })

/** 答えを受け取る道具（返事の文から JSON を探さない。strict なので引数は形どおりに届く） */
const REPORT_TOOL = "report_location"
const reportTool: Anthropic.Beta.BetaTool = {
  name: REPORT_TOOL,
  description: "調べ終えたら、工事の場所をこの道具で1回だけ答える。",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      prefecture: { type: "string", description: "47都道府県名と完全一致（「東京」でなく「東京都」）。分からなければ空文字" },
      place: { type: "string", description: "市区町村（政令指定都市は区まで。分からなければ市まで）。都道府県名は含めない。分からなければ空文字" },
      confident: { type: "boolean", description: "自信があれば true。少しでも迷えば false" },
      note: { type: "string", description: "根拠や迷った点を短く" },
    },
    required: ["prefecture", "place", "confident", "note"],
    additionalProperties: false,
  },
}

const SEARCH_SYSTEM = `あなたは行政書士事務所で建設業の工事経歴書を作る補助をする。工事名と注文者から、その工事の場所（都道府県と市区町村）を Web 検索で調べる。
- 施設名・建物名・地名・注文者（会社・官公庁・学校など）の所在地や、工事の発注・入札の情報を手がかりにする。注文者の本社の所在地は工事の場所とは限らない（工事名に地名や施設名があればそちらを優先する）。
- 調べるのは都道府県と市区町村まで。番地は要らない。複数の地域にまたがるときは place に「広島市南区、三原市」のように並べる。
- 調べ終えたら、${REPORT_TOOL} を1回だけ呼んで答える（返事の文には答えを書かなくてよい）。検索しても場所が分からなければ prefecture と place を空文字にする。少しでも迷えば confident を false にする。`

/** 根拠の URL: 引用（検索結果のどこを使ったか）を先に、無ければ検索結果の上から。続けさせた返事（pause_turn）の分も合わせて見る */
function evidence(content: readonly Anthropic.Beta.BetaContentBlock[]) {
  const cited: string[] = []
  const results: string[] = []
  for (const b of content) {
    if (b.type === "text") for (const c of b.citations ?? []) if (c.type === "web_search_result_location") cited.push(c.url)
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) results.push(r.url)
  }
  return [...new Set(cited.length ? cited : results)]
}

/** 検索がエラーで返ったか（Web 検索の誤りは 200 の中の結果に入る。料金はかからない） */
function searchErrors(content: readonly Anthropic.Beta.BetaContentBlock[]) {
  return content.flatMap((b) => (b.type === "web_search_tool_result" && !Array.isArray(b.content) ? [b.content.error_code] : []))
}

export class SearchError extends Error {}

/**
 * 1つの現場を Web 検索で調べる。答えは道具 report_location で受け取る（返事の文から読まない）。
 * 答えの道具を呼ばなかった・拒否された・検索が終わらなかったときは投げる（呼び出し側がやり直す）。
 * 費用は投げる前にも spent に足す（やり直した回の費用も数える）。根拠の URL は続けさせた返事も合わせて集める
 */
export async function searchLocation(anthropic: Anthropic, index: PlaceIndex, site: Site, spent: Spent, signal?: AbortSignal): Promise<Outcome> {
  if (!searchable(site)) return { kind: "skipped", skip: site.skip ?? "empty" }
  const user = `工事名: ${site.workName || "（なし）"}\n注文者: ${site.client || "（なし）"}`
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: user }]
  const content: Anthropic.Beta.BetaContentBlock[] = []
  let res: Anthropic.Beta.BetaMessage | undefined
  for (let i = 0; i <= MAX_CONTINUES; i++) {
    res = await anthropic.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: [{ type: "text", text: SEARCH_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES_PER_SITE, user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" } },
          reportTool,
        ],
        messages,
      },
      { signal },
    )
    content.push(...res.content)
    spent.usd += usdOf(tokensOfMessage(res.usage)) + (res.usage.server_tool_use?.web_search_requests ?? 0) * USD_PER_SEARCH
    spent.searches += res.usage.server_tool_use?.web_search_requests ?? 0
    // 長い検索の途中で止まったら、止まった返事をそのまま送り直して続けさせる
    if (res.stop_reason !== "pause_turn") break
    messages.push({ role: "assistant", content: res.content })
  }
  if (!res || res.stop_reason === "pause_turn") throw new SearchError("検索が終わりませんでした")
  if (res.stop_reason === "refusal") throw new SearchError("AI が応答を拒否しました")
  const call = res.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === REPORT_TOOL)
  const answer = answerSchema.safeParse(call?.input)
  if (!answer.success) {
    const errors = searchErrors(content)
    throw new SearchError(errors.length ? `検索のエラー（${[...new Set(errors)].join("・")}）` : "AI が答えの道具を呼びませんでした")
  }
  const a = answer.data
  if (!a.prefecture.trim()) return normalizeOutcome({ kind: "notFound", note: a.note })
  const checked = checkFound(index, { prefecture: a.prefecture, place: a.place, urls: evidence(content), source: "search", confident: a.confident, note: a.note })
  // 根拠の URL の形・数と文の長さは normalizeOutcome がそろえる
  return normalizeOutcome(checked.ok ? { kind: "found", ...checked.found } : { kind: "notFound", note: checked.note })
}

/** 投げられた誤りの説明（問い合わせの理由に書く。キーなどは出さない） */
export function searchFailure(e: unknown) {
  if (e instanceof SearchError) return e.message
  if (e instanceof Anthropic.RateLimitError) return "AI が混み合っていました"
  if (e instanceof Anthropic.APIError) return `AI のエラー（${e.status ?? "不明"}）`
  return "AI の呼び出しに失敗しました"
}

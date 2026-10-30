import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import type { z } from "zod"
import { aiResponseSchema, type AiBatchRequest } from "@/lib/convert/ai-tasks"
import { mappingPlanWireSchema } from "@/lib/convert/plan"
import { batchUserMessage, planUserMessage, systemPrompt, type PlanExcerpt } from "@/lib/convert/prompt"
import { tokensOfMessage, usdOf } from "@/lib/cost"
import { MODEL } from "@/lib/constants"
import { KOJI_KEIREKI } from "@/lib/spec/koji-keireki"

/** Claude の呼び出し（Workers の env に依存しないので、ローカルの照合スクリプトからも使える） */


export type AiFailure = { ok: false; reason: "noKey" | "error"; message: string }

function failure(e: unknown): AiFailure {
  if (e instanceof Anthropic.AuthenticationError) return { ok: false, reason: "error", message: "APIキーが正しくありません" }
  if (e instanceof Anthropic.RateLimitError) return { ok: false, reason: "error", message: "AI が混み合っています。しばらく待ってからお試しください" }
  if (e instanceof Anthropic.APIConnectionError) return { ok: false, reason: "error", message: "AI に接続できませんでした" }
  if (e instanceof Anthropic.APIError) return { ok: false, reason: "error", message: `AI のエラー（${e.status ?? "不明"}）` }
  console.error(e)
  return { ok: false, reason: "error", message: "AI の呼び出しに失敗しました" }
}

/**
 * 構造化出力で JSON を受け取る。システムプロンプト（定義表から生成・毎回同じ）はキャッシュする。
 * 拒否されたときは既定のフォールバックモデルで再実行される（server-side fallback）。
 * 結果には費用の目安（usd）を付ける（失敗しても応答があれば数える）。
 */
async function ask<S extends z.ZodType>(
  anthropic: Anthropic,
  schema: S,
  user: string,
  effort: "medium" | "high",
): Promise<({ ok: true; json: z.infer<S> } | AiFailure) & { usd: number }> {
  try {
    const res = await anthropic.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: betaZodOutputFormat(schema) },
      system: [{ type: "text", text: systemPrompt(KOJI_KEIREKI), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    })
    const usd = usdOf(tokensOfMessage(res.usage))
    if (res.stop_reason === "refusal") return { ok: false, reason: "error", message: "AI が応答を拒否しました", usd }
    if (res.stop_reason === "max_tokens") return { ok: false, reason: "error", message: "AI の応答が長すぎて途中で切れました", usd }
    if (res.parsed_output == null) return { ok: false, reason: "error", message: "AI の応答を読めませんでした", usd }
    return { ok: true, json: res.parsed_output, usd }
  } catch (e) {
    return { ...failure(e), usd: 0 }
  }
}

export function planWithClaude(anthropic: Anthropic, excerpt: PlanExcerpt) {
  return ask(anthropic, mappingPlanWireSchema(KOJI_KEIREKI), planUserMessage(excerpt), "high")
}

export function batchWithClaude(anthropic: Anthropic, req: AiBatchRequest) {
  return ask(anthropic, aiResponseSchema(req.task), batchUserMessage(req), "medium")
}

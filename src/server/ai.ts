import { env } from "cloudflare:workers"
import Anthropic from "@anthropic-ai/sdk"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { AI_TASK_IDS, MAX_ITEMS_PER_REQUEST } from "@/lib/convert/ai-tasks"
import { MAX_PREVIOUS_CONTEXT, planExcerptShape } from "@/lib/convert/prompt"
import { getDb } from "@/db"
import { addCaseCost } from "./case-store"
import { batchWithClaude, planWithClaude, type AiFailure } from "./claude"
import { authMiddleware } from "./middleware"

const NO_KEY: AiFailure & { usd: number } = {
  ok: false,
  reason: "noKey",
  message: "APIキー未設定",
  usd: 0,
}

function client() {
  return env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : undefined
}

const caseId = z.string().min(1).max(64)

/** 費用を案件の合計に足して返す。足せなくても AI の結果は返す（結果を捨てて同じ費用をもう一度かけさせない。失敗はログに残す） */
async function charged<T extends { usd: number }>(id: string, res: T) {
  if (res.usd > 0) await addCaseCost(getDb(), id, res.usd).catch((e: unknown) => console.error("案件の費用を記録できませんでした", id, res.usd, e))
  return res
}

/** 列の計画。送るのはシートごとの先頭・末尾の数十行と、列ごとの値の例だけ（上限は planExcerpt と同じ）。費用は案件の合計に足す */
export const planWithAi = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      caseId,
      ...planExcerptShape,
      previous: z.string().max(MAX_PREVIOUS_CONTEXT + 100).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const anthropic = client()
    if (!anthropic) return NO_KEY
    const { caseId: id, ...excerpt } = data
    return charged(id, await planWithClaude(anthropic, excerpt))
  })

/** 値ごとの判断。送るのは重複を除いた値だけ（最大100件） */
export const runAiBatch = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      caseId,
      task: z.enum(AI_TASK_IDS),
      instruction: z.string().max(500).optional(),
      items: z.array(z.object({ id: z.number().int().min(0), input: z.string().max(500) })).min(1).max(MAX_ITEMS_PER_REQUEST),
    }),
  )
  .handler(async ({ data }) => {
    const anthropic = client()
    if (!anthropic) return NO_KEY
    const { caseId: id, ...req } = data
    return charged(id, await batchWithClaude(anthropic, req))
  })

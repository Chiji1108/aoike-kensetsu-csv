import type { CsvSpec } from "../spec/types"
import { NO_ADDRESSES, type AddressBook, type AddressLookup } from "./address"
import { parseAiResponse, type AiBatchRequest, type AiItemResult } from "./ai-tasks"
import { collectAiBatches, convertRows, resolveRows, type RowDraft, type RowResult } from "./convert"
import type { MappingPlan, SourceRow } from "./plan"
import { getTransform, type TransformContext } from "./transforms"

/** サーバー関数（Claude）の呼び出し結果。APIキー未設定や通信エラーは ok: false */
export type AiCallResult = { ok: true; json: unknown } | { ok: false; message: string }
export type AiCaller = (req: AiBatchRequest) => Promise<AiCallResult>

/** 同時に送る AI の依頼の数（1件に1分近くかかることがあるため、順番に送ると数百件で数分待つ） */
const AI_CONCURRENCY = 4

export type AiCache = Map<string, AiItemResult | { error: string }>

/**
 * ルール変換 → 決まらなかった値だけ AI → 検算。一括置換・手直しは applyEdits、記号と検証は finalizeRows で後からかける。
 * cache に AI の結果を溜めるので、端数処理を変えて再実行しても同じ値を AI に再送しない。
 * 失敗した値は cache に理由を残し、次に callAi を渡して実行したときに送り直す。
 */
export async function runConversion<F extends string>(args: {
  spec: CsvSpec<F>
  sources: readonly SourceRow[]
  plan: MappingPlan<F>
  ctx: Omit<TransformContext, "addresses">
  lookup: AddressLookup
  cache: AiCache
  callAi?: AiCaller
}): Promise<RowResult<F>[]> {
  const { spec, sources, plan, cache, callAi } = args
  const ctx = { ...args.ctx, addresses: await addressBookFor(spec, sources, plan, args.lookup) }
  const drafts = convertRows(spec, sources, plan, ctx)
  if (callAi) await fillAiCache(drafts, cache, callAi)
  return resolveRows(drafts, cache)
}

/** AI 待ちのセルの値を AI に送り、結果を cache に入れる（resolveRows で使う）。drafts のうち前に失敗した値は送り直す（ほかの値の記録には触らない） */
export async function fillAiCache<F extends string>(drafts: RowDraft<F>[], cache: AiCache, callAi: AiCaller) {
  const queue = collectAiBatches(drafts, cache)
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      const { request, keys } = batch
      const res = await callAi(request)
      const parsed = res.ok ? parseAiResponse(request.task, request, res.json) : res
      keys.forEach((key, id) => {
        const r = parsed.ok ? parsed.results.get(id) : undefined
        cache.set(key, r ?? { error: parsed.ok ? "AI の応答にこの値の結果がありません" : parsed.message })
      })
    }
  }
  await Promise.all(Array.from({ length: AI_CONCURRENCY }, worker))
}

/** 計画が住所として読む列（readsAddress の変換の最初の列）の値を、変換の前にまとめて引く */
export function addressBookFor<F extends string>(spec: CsvSpec<F>, sources: readonly SourceRow[], plan: MappingPlan<F>, lookup: AddressLookup): Promise<AddressBook> {
  const values = addressInputs(spec, sources, plan)
  return values.length ? lookup(values) : Promise.resolve(NO_ADDRESSES)
}

/** 計画が住所として読む列（readsAddress の変換の最初の列）の値 */
export function addressInputs<F extends string>(spec: CsvSpec<F>, sources: readonly SourceRow[], plan: MappingPlan<F>): string[] {
  const columns = new Set(
    spec.fields.flatMap((f) => {
      const p = plan.fields[f.id]
      if ((p.kind !== "column" && p.kind !== "columns") || !getTransform(p.transform).readsAddress) return []
      return [p.kind === "column" ? p.column : p.columns[0]!]
    }),
  )
  return sources.flatMap((s) => [...columns].map((c) => s.cells[c] ?? "")).filter((v) => v.trim())
}

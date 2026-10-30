/**
 * Claude の費用の目安（claude-opus-5-5 の料金: 入力 $4、出力 $20、キャッシュの書き込み $5（5分）、読み込み $0.20、いずれも100万トークンあたり）。
 * 拒否されて既定のフォールバックのモデルが答えた分も同じ料金で数える（目安）。コード実行のコンテナの時間の料金は入れない
 */
export type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number }

const PER_MILLION: Tokens = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 }

export const usdOf = (t: Tokens) => (t.input * PER_MILLION.input + t.cacheWrite * PER_MILLION.cacheWrite + t.cacheRead * PER_MILLION.cacheRead + t.output * PER_MILLION.output) / 1e6

/** Anthropic SDK の usage（input_tokens はキャッシュを除いた分） */
export const tokensOfMessage = (u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): Tokens => ({
  input: u.input_tokens,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  output: u.output_tokens,
})

/** AI SDK の usage（inputTokens はキャッシュを含めた合計） */
export function tokensOfAiSdk(u: { inputTokens: number | undefined; outputTokens: number | undefined; inputTokenDetails: { noCacheTokens: number | undefined; cacheReadTokens: number | undefined; cacheWriteTokens: number | undefined } }): Tokens {
  const cacheRead = u.inputTokenDetails.cacheReadTokens ?? 0
  const cacheWrite = u.inputTokenDetails.cacheWriteTokens ?? 0
  return { input: u.inputTokenDetails.noCacheTokens ?? (u.inputTokens ?? 0) - cacheRead - cacheWrite, cacheWrite, cacheRead, output: u.outputTokens ?? 0 }
}

/** 案件の費用がこれを超えたら注意を出す（止めない） */
export const CASE_COST_NOTICE_USD = 10

export const formatUsd = (usd: number) => `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`


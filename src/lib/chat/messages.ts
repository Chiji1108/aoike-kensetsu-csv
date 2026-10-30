import type { Rounding } from "../convert/transforms"
import type { UIMessage } from "ai"
import { z } from "zod"
import { chatChangeSchema, proposalSchema, type ChatChange, type Proposal } from "./proposals"
import type { MappingPlan } from "../convert/plan"
import type { SheetShape } from "../convert/plan-patch"
import type { KojiFieldId } from "../spec/koji-keireki"

/**
 * 返事ごとの記録（画面に出す）。usd はこの返事の費用、caseUsd は返事のあとの案件の合計。carryover は返事のあと、この会話で去年のコードを添えたか
 * （会話の記録の印。この項目より前の返事には無い）
 */
export type ChatMetadata = { usd: number; caseUsd: number; ms: number; inputTokens: number; outputTokens: number; toolCalls: number; carryover?: boolean }

/** 画面に出す会話（GET /api/cases/<caseId>/chat）。carryover はこの会話で去年のコードを添えたか（ChatMetadata の carryover と同じ印） */
export type ChatHistory = { messages: ChatMessage[]; carryover: boolean }

/**
 * 返事に付ける部品。proposal は返事のどこに変更案が付いたか（id だけ。会話と一緒に保存する）。
 * proposal-content は変更案の状態と中身（届いたときだけ画面に渡し、会話には残さない。中身はサーバーが R2 に置いてある）。
 * carryover は去年の案件のコードを添えた印（何年度の何件か。コードそのものは画面の会話に残さない）
 */
export type ChatDataParts = {
  proposal: { id: string }
  "proposal-content": { proposal: Proposal; changes: ChatChange[] }
  carryover: { fiscalYear: number; codes: number; skipped?: string }
  /** 工事場所の一括調査を始めるボタン（チャットの find_location。件数と費用の目安。始めるのは職員） */
  "location-offer": { sites: number; memorized: number; usd: number }
  /** 画面の決まった処理を始めるボタン（チャットの offer_action。保存した会話には前の edit_excel もある） */
  action: { action: SavedChatAction }
}

export type ChatMessage = UIMessage<ChatMetadata, ChatDataParts>

/** 返事に付けるボタン（画面の決まった処理を始める）。export: 書き出す前の確認（最後の Excel・CSV）、inquiry_excel: 問い合わせの Excel */
export const CHAT_ACTIONS = ["export", "inquiry_excel"] as const
export type ChatAction = (typeof CHAT_ACTIONS)[number]
/**
 * 保存した会話のボタン。edit_excel は前の「編集用の Excel をダウンロードする」（編集用の Excel は最後の Excel に1つにしたので、書き出す前の確認を開く）。
 * 保存した会話を読めなくしないよう、読むときだけ受け付ける
 */
export const SAVED_CHAT_ACTIONS = [...CHAT_ACTIONS, "edit_excel"] as const
export type SavedChatAction = (typeof SAVED_CHAT_ACTIONS)[number]
export const currentAction = (a: SavedChatAction): ChatAction => (a === "edit_excel" ? "export" : a)

/** 保存した会話を読むときの形の確かめ（AI SDK の validateUIMessages に渡す） */
export const chatMetadataSchema: z.ZodType<ChatMetadata> = z.object({
  usd: z.number(),
  caseUsd: z.number(),
  ms: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  toolCalls: z.number(),
  carryover: z.boolean().optional(),
})
export const chatDataSchemas = {
  proposal: z.object({ id: z.string() }),
  "proposal-content": z.object({ proposal: proposalSchema, changes: z.array(chatChangeSchema) }),
  carryover: z.object({ fiscalYear: z.number().int(), codes: z.number().int().min(0), skipped: z.string().optional() }),
  "location-offer": z.object({ sites: z.number().int().min(0), memorized: z.number().int().min(0), usd: z.number().min(0) }),
  action: z.object({ action: z.enum(SAVED_CHAT_ACTIONS) }),
}

/** 会話を終えた印（画面にだけ出す。AI の履歴には入らない） */
export const ENDED_TEXT = "会話を終えました（AI に渡したファイルは消しました）。次の指示から新しい会話になります。"

/** 画面から送る1回の指示 */
export type ChatRequest = {
  id: string
  text: string
  /** 案件の表（lib/chat/wire.ts） */
  table: unknown
  /** 元データの見出しと列の対応（lib/chat/context.ts） */
  context: string
  sourceFileId: string | null
  /** 今の列の対応と計画の元のシートの大きさ（set_plan の確かめ） */
  plan: { plan: MappingPlan<KojiFieldId>; shape: SheetShape } | null
  /** 金額の千円未満の扱い（顧客の回答を値にするときの変換の設定） */
  rounding: Rounding
  /** 去年の案件のコードを参考に添える（「去年のやり方で直す」） */
  carryover?: boolean
  /** 去年の元の Excel の配置技術者の列の値（去年のコードから個人名を消すのに使う） */
  carryoverNames?: string[]
  /** 去年と今年の元の Excel の見出し（去年のコードの文字列のうち、見出しの名前は伏せない） */
  carryoverHeaders?: string[]
}

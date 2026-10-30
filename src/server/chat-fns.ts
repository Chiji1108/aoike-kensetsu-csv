import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { getDb } from "@/db"
import * as store from "./case-store"
import { chatChangeSchema, proposalSchema } from "@/lib/chat/proposals"
import { ruleTextSchema } from "@/lib/chat/rules"
import { MAX_EXCEL_CHANGES } from "@/lib/excel/edit-sheet"
import { endChat, readProposal, recordExcelProposal, stopChat } from "./chat"
import { authMiddleware } from "./middleware"

/** 会話を終える（AI に渡したファイルを消す）。画面に足す「終えた」印を返す。会話が無ければ null */
export const endChatFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId: z.string().min(1).max(64) }))
  .handler(({ data }) => endChat(data.caseId))

/** 処理している指示を止める（turnId は送った指示の id） */
export const stopChatFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId: z.string().min(1).max(64), turnId: z.string().min(1).max(100) }))
  .handler(({ data }) => stopChat(data.caseId, data.turnId))

/**
 * 変更案のルールの追記を承認する。中身（由来も）はサーバーの変更案の記録から読み、ルールの項目と「足した」印を1つの処理で書く（同じ項目は二度足さない）。
 * 足したか、もう足してあれば ok（画面はその項目に承認の印を付ける）
 */
export const approveRuleFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId: z.string().min(1).max(64), proposalId: z.string().min(1).max(64), item: z.number().int().min(0) }))
  .handler(async ({ data }) => {
    const db = getDb()
    const kase = await store.getCase(db, data.caseId)
    const change = (await readProposal(data.caseId, data.proposalId))?.changes[data.item]
    if (!kase || kase.deleting || change?.kind !== "rule") throw new Error("変更案のルールの追記が見つかりません")
    const target: store.RuleTarget = change.scope === "global" ? { scope: "global" } : { scope: "customer", customerId: kase.customerId }
    const text = ruleTextSchema.safeParse(change.text)
    if (!text.success) throw new Error(text.error.issues[0]?.message ?? "ルールの追記の形が正しくありません")
    return store.appendRuleOnce(db, target, { caseId: kase.id, proposalId: data.proposalId, item: data.item, text: text.data, source: change.source })
  })

/** 返ってきた編集用の Excel の変更案を置く（画面が作った差分。形はここで確かめる） */
export const recordExcelProposalFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId: z.string().min(1).max(64), record: z.object({ proposal: proposalSchema, changes: z.array(chatChangeSchema).max(MAX_EXCEL_CHANGES) }) }))
  .handler(({ data }) => recordExcelProposal(data.caseId, data.record))

import { and, desc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { csvCases, csvCustomers, csvFeedback } from "@/db/cases-schema"
import { feedbackKindSchema, feedbackSourceSchema, feedbackStatusSchema, MAX_FEEDBACK_LISTED, summaryText, type FeedbackInput, type FeedbackItem, type FeedbackSource, type FeedbackStatus, type FeedbackSummary } from "@/lib/feedback/feedback"
import type { Db } from "./case-store"

/** 要望の読み書き（D1 の csv_feedback。lib/feedback/feedback.ts）。中身の確かめ（字数・固有名）は呼ぶ側で済ませる */

/** 画面に出す要望の数の上限（新しい順） */
const MAX_LISTED = 500

/** D1 から読んだ値の形（種類・状態・由来は文字列の列なので確かめる） */
const rowSchema = z.object({ kind: feedbackKindSchema, status: feedbackStatusSchema, source: feedbackSourceSchema })

export async function listFeedback(db: Db, status: FeedbackStatus | null): Promise<FeedbackItem[]> {
  const rows = await db
    .select({ f: csvFeedback, fiscalYear: csvCases.fiscalYear, customerName: csvCustomers.name })
    .from(csvFeedback)
    .leftJoin(csvCases, eq(csvCases.id, csvFeedback.caseId))
    .leftJoin(csvCustomers, eq(csvCustomers.id, csvCases.customerId))
    .where(status ? eq(csvFeedback.status, status) : undefined)
    // 同じ時刻に足したものは後に足した方を上に（rowid は足した順）
    .orderBy(desc(csvFeedback.createdAt), desc(sql`${csvFeedback}.rowid`))
    .limit(MAX_LISTED)
  return rows.map(({ f, fiscalYear, customerName }) => ({
    id: f.id,
    want: f.want,
    did: f.did,
    idea: f.idea,
    count: f.count,
    ...rowSchema.parse(f),
    caseId: f.caseId && fiscalYear !== null ? f.caseId : null,
    caseLabel: f.caseId && fiscalYear !== null && customerName !== null ? `${customerName} ${fiscalYear}年度` : null,
    createdAt: f.createdAt.getTime(),
    updatedAt: f.updatedAt.getTime(),
  }))
}

/** チャットの AI に見せる未対応の要望（件数の多い順に MAX_FEEDBACK_LISTED 件まで。欄は短い要約） */
export async function openFeedbackSummaries(db: Db): Promise<FeedbackSummary[]> {
  const rows = await db
    .select({ id: csvFeedback.id, kind: csvFeedback.kind, want: csvFeedback.want, idea: csvFeedback.idea, count: csvFeedback.count })
    .from(csvFeedback)
    .where(eq(csvFeedback.status, "open"))
    .orderBy(desc(csvFeedback.count), desc(csvFeedback.updatedAt), desc(sql`${csvFeedback}.rowid`))
    .limit(MAX_FEEDBACK_LISTED)
  return rows.map((r) => ({ ...r, kind: feedbackKindSchema.parse(r.kind), want: summaryText(r.want), idea: summaryText(r.idea) }))
}

/**
 * 要望を足す。caseId は由来の案件（無ければ null）。案件が無い・削除中なら由来を付けない（削除と同時に届いても、消えた案件を指す行を残さない。
 * 削除は印を立ててから由来を外すので、確かめと足すのを1つの文にすれば、どちらの順でも残らない）
 */
export async function addFeedback(db: Db, input: FeedbackInput & { caseId: string | null; source: FeedbackSource }): Promise<string> {
  const id = crypto.randomUUID()
  const caseId = input.caseId === null ? null : sql`(select ${csvCases.id} from ${csvCases} where ${csvCases.id} = ${input.caseId} and ${csvCases.deleting} = 0)`
  await db.insert(csvFeedback).values({ id, caseId, kind: input.kind, want: input.want, did: input.did, idea: input.idea, source: input.source })
  return id
}

/** 同じ要望がまた出た: 未対応の要望の件数を1つ足す。未対応の要望が無ければ false */
export async function bumpFeedback(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(csvFeedback)
    .set({ count: sql`${csvFeedback.count} + 1` })
    .where(and(eq(csvFeedback.id, id), eq(csvFeedback.status, "open")))
    .returning({ id: csvFeedback.id })
  return rows.length > 0
}

/** 状態を変える。要望が無ければ false */
export async function setFeedbackStatus(db: Db, id: string, status: FeedbackStatus): Promise<boolean> {
  const rows = await db.update(csvFeedback).set({ status }).where(eq(csvFeedback.id, id)).returning({ id: csvFeedback.id })
  return rows.length > 0
}

/** 案件を消すときに由来を外す（要望は残す） */
export async function unlinkFeedbackOfCase(db: Db, caseId: string) {
  await db.update(csvFeedback).set({ caseId: null }).where(eq(csvFeedback.caseId, caseId))
}

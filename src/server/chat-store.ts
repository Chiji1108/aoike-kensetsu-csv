import type { ModelMessage } from "ai"
import { z } from "zod"
import type { ChatMessage } from "@/lib/chat/messages"

/**
 * 案件の会話（R2 の cases/<caseId>/chat.json）。案件のキーの頭の下に置くので、案件を消すと一緒に消える。
 * ui は画面に出す会話（会話を終えても残す）。session は今の会話で AI に送る履歴・コンテナ・Files API に上げたファイル。
 * AI に送る履歴（model）は足していくだけで、前の部分は変えない（考えたことのブロックは履歴が変わると読めなくなる）
 */
export type ChatSession = {
  model: ModelMessage[]
  container: { id: string; expiresAt: string } | null
  /** Files API に上げてコンテナに渡したファイル（案件のファイルごとに1つ） */
  files: { anthropicId: string; caseFileId: string; name: string; original: string }[]
  /** コード実行が作ったファイル（Files API に残るので、会話を終えるときに消す） */
  generated: string[]
  /** この会話の履歴に去年のコードを添えた（「去年のやり方で直す」は1つの会話で1回。履歴に同じ長い文を重ねない） */
  carryover?: true
}
/**
 * turn は指示を処理している印（指示の初めに立て、終わりに下ろす）。立っている間はほかの画面の指示と「会話を終える」を断るので、
 * 1回の指示の履歴・作ったファイル・画面の会話は、その指示を処理している1つの Worker だけが書く。
 * Worker が落ちて下ろせなかった印は TURN_LOCK_MS で切れる
 */
export type ChatTurn = { id: string; startedAt: number }
export type ChatDoc = { ui: ChatMessage[]; session: ChatSession | null; turn: ChatTurn | null }

/** 1回の指示にかかる時間の上限の目安（これより古い印は、落ちた指示のものとして引き継ぐ） */
export const TURN_LOCK_MS = 15 * 60_000

export const turnActive = (doc: ChatDoc, now: number) => doc.turn !== null && now - doc.turn.startedAt < TURN_LOCK_MS

export const chatKey = (caseId: string) => `cases/${caseId}/chat.json`

/** R2Bucket のうち使うところ */
export type ChatBucket = {
  get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>
  put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string } }): Promise<unknown | null>
  delete(key: string): Promise<void>
}

const docSchema = z.object({
  ui: z.array(z.custom<ChatMessage>((m) => typeof m === "object" && m !== null && "id" in m && "role" in m && "parts" in m)),
  session: z
    .object({
      model: z.array(z.custom<ModelMessage>((m) => typeof m === "object" && m !== null && "role" in m)),
      container: z.object({ id: z.string(), expiresAt: z.string() }).nullable(),
      files: z.array(z.object({ anthropicId: z.string(), caseFileId: z.string(), name: z.string(), original: z.string() })),
      generated: z.array(z.string()),
      carryover: z.literal(true).optional(),
    })
    .nullable(),
  turn: z.object({ id: z.string(), startedAt: z.number() }).nullable().default(null),
})

/** etag は読んだときの版（まだ無ければ null）。書くときに渡し、別の指示が先に書いていたら書かない */
export type Loaded = { doc: ChatDoc; etag: string | null }

export async function loadChat(bucket: ChatBucket, caseId: string): Promise<Loaded> {
  const object = await bucket.get(chatKey(caseId))
  if (!object) return { doc: { ui: [], session: null, turn: null }, etag: null }
  return { doc: docSchema.parse(JSON.parse(await object.text())), etag: object.etag }
}

export class ChatConflictError extends Error {
  constructor() {
    super("別の画面でこの案件の会話が進みました。再読み込みしてください")
  }
}

/** 読んだときの版のままなら書く（別の画面の指示と同時に進んだら ChatConflictError） */
export async function saveChat(bucket: ChatBucket, caseId: string, loaded: Loaded, doc: ChatDoc): Promise<Loaded> {
  const onlyIf = loaded.etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: loaded.etag }
  const put = await bucket.put(chatKey(caseId), JSON.stringify(doc), { onlyIf, httpMetadata: { contentType: "application/json" } })
  if (!put) throw new ChatConflictError()
  return { doc, etag: (put as { etag: string }).etag }
}

export class ChatBusyError extends Error {
  constructor() {
    super("この案件では別の指示を処理しています。返事が終わってからもう一度送ってください")
  }
}

/**
 * 指示を処理している印を立てる。ほかの指示が処理中なら waitMs まで待ち（止めた指示の後始末が終わるのを待つ）、それでも処理中なら
 * ChatBusyError。同時に立てようとしたら ChatConflictError
 */
export async function beginTurn(bucket: ChatBucket, caseId: string, turn: ChatTurn, waitMs = 5_000): Promise<Loaded & { created: boolean }> {
  for (let waited = 0; ; waited += BUSY_POLL_MS) {
    const loaded = await loadChat(bucket, caseId)
    if (!turnActive(loaded.doc, turn.startedAt)) return { ...(await saveChat(bucket, caseId, loaded, { ...loaded.doc, turn })), created: loaded.etag === null }
    if (waited >= waitMs) throw new ChatBusyError()
    await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS))
  }
}

const BUSY_POLL_MS = 500

/**
 * 印を取ったあとで案件が削除の途中だと分かったときに、何も始めずに印を返す。会話をこの印で作ったのなら消す
 * （削除が R2 を消したあとに作った会話を残さない）
 */
export async function abandonTurn(bucket: ChatBucket, caseId: string, held: Loaded & { created: boolean }) {
  if (held.created) await bucket.delete(chatKey(caseId))
  else await saveChat(bucket, caseId, held, { ...held.doc, turn: null })
}

/**
 * 会話を終える: 指示と同じ印を取ってから、Files API のファイル（上げたものとコード実行が作ったもの）を消し、AI に送る履歴を捨てる
 * （画面の会話は残して ended を足す）。消している間に指示が始まらない。消せなければ印だけ下ろして投げる。会話が無ければ false
 */
export async function endSession(bucket: ChatBucket, caseId: string, deleteFiles: (ids: string[]) => Promise<void>, ended: ChatMessage, waitMs?: number): Promise<boolean> {
  // 会話がまだ無くても（最初の指示の途中でも）印を取る。取れたら、その指示はもう終わっている
  const held = await beginTurn(bucket, caseId, { id: `end:${ended.id}`, startedAt: Date.now() }, waitMs)
  const session = held.doc.session
  if (!session) {
    await abandonTurn(bucket, caseId, held)
    return false
  }
  try {
    await deleteFiles([...session.files.map((f) => f.anthropicId), ...session.generated])
  } catch (e) {
    await saveChat(bucket, caseId, held, { ...held.doc, turn: null })
    throw e
  }
  try {
    await saveChat(bucket, caseId, held, { ui: [...held.doc.ui, ended], session: null, turn: null })
  } catch (e) {
    // ファイルはもう消した。会話は残る（次に終えるときにもう一度消しに行く。消えたものは消えたとみなす）が、印は下ろす
    await saveChat(bucket, caseId, held, { ...held.doc, turn: null }).catch(() => undefined)
    throw e
  }
  return true
}

/**
 * 1回の指示の終わり方。completed は AI に送る履歴に足すメッセージ（指示と返事）。止めた・失敗した回は足さない
 * （コードの途中で止まった履歴は次の指示で送れない）。steps はそれまでに終わった往復のメッセージ（作ったファイルを拾う）
 */
export type TurnOutcome = { completed: ModelMessage[] | null; steps: ModelMessage[]; container: ChatSession["container"] }

/**
 * 指示のあとの会話。終わった回は履歴とコンテナを進める。止めた・失敗した回は履歴を変えず、この回で上げたファイルが
 * コンテナに届いていないかもしれないので、上げたものがあればコンテナを捨てる（次の指示で全部を新しいコンテナに付け直す）。
 * どちらでも、コード実行が作ったファイルは記録する（会話を終えるときに消す）
 */
export function settleSession(session: ChatSession, outcome: TurnOutcome, uploadedThisTurn: boolean): ChatSession {
  const generated = [...new Set([...session.generated, ...generatedFileIds(outcome.steps), ...generatedFileIds(outcome.completed ?? [])])]
  if (outcome.completed) return { ...session, model: [...session.model, ...outcome.completed], container: outcome.container, generated }
  return { ...session, container: uploadedThisTurn ? null : session.container, generated }
}

/** コード実行の結果に出てくる、コンテナが作ったファイルの id */
export function generatedFileIds(messages: readonly ModelMessage[]): string[] {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.role !== "tool" && m.role !== "assistant") continue
    for (const p of typeof m.content === "string" ? [] : m.content) {
      if (p.type !== "tool-result" || p.toolName !== "code_execution") continue
      for (const [, id] of JSON.stringify(p.output).matchAll(/"file_?[iI]d"\s*:\s*"(file_[A-Za-z0-9_-]+)"/g)) ids.add(id!)
    }
  }
  return [...ids]
}

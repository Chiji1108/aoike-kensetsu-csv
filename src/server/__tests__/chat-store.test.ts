import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { abandonTurn, beginTurn, ChatBusyError, ChatConflictError, chatKey, endSession, loadChat, saveChat, settleSession, TURN_LOCK_MS, type ChatBucket, type ChatSession } from "../chat-store"

/** R2 の代わり。etag は書くたびに変わり、onlyIf の条件が合わなければ null を返す（R2 の条件付きの put と同じ） */
function memoryBucket(): ChatBucket {
  const objects = new Map<string, { etag: string; body: string }>()
  let n = 0
  return {
    async get(key) {
      const o = objects.get(key)
      return o ? { etag: o.etag, text: async () => o.body } : null
    },
    async put(key, value, options) {
      const now = objects.get(key)
      const cond = options?.onlyIf
      if (cond?.etagMatches !== undefined && now?.etag !== cond.etagMatches) return null
      if (cond?.etagDoesNotMatch === "*" && now) return null
      const etag = `e${++n}`
      objects.set(key, { etag, body: value })
      return { etag }
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

const session: ChatSession = { model: [{ role: "user", content: "前の指示" }], container: { id: "c1", expiresAt: "2099-01-01T00:00:00Z" }, files: [], generated: ["file_old"] }
const codeResult = (fileId: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-result", toolCallId: "x", toolName: "code_execution", output: { type: "json", value: { content: [{ type: "bash_code_execution_output", file_id: fileId }] } } }],
})

describe("指示を処理している印", () => {
  test("処理中はほかの画面の指示を断り、下ろしたら受ける。古い印（落ちた指示）は引き継ぐ", async () => {
    const bucket = memoryBucket()
    const first = await beginTurn(bucket, "k", { id: "t1", startedAt: 1_000 })
    await expect(beginTurn(bucket, "k", { id: "t2", startedAt: 2_000 }, 0)).rejects.toBeInstanceOf(ChatBusyError)
    await saveChat(bucket, "k", first, { ...first.doc, turn: null })
    await beginTurn(bucket, "k", { id: "t2", startedAt: 3_000 })
    const taken = await beginTurn(bucket, "k", { id: "t3", startedAt: 3_000 + TURN_LOCK_MS })
    expect(taken.doc.turn?.id).toBe("t3")
  })

  test("処理中でも、少し待つ間に印が下りれば受ける（止めた指示の後始末を待つ）", async () => {
    const bucket = memoryBucket()
    const first = await beginTurn(bucket, "k", { id: "t1", startedAt: Date.now() })
    setTimeout(() => void saveChat(bucket, "k", first, { ...first.doc, turn: null }), 100)
    const next = await beginTurn(bucket, "k", { id: "t2", startedAt: Date.now() }, 2_000)
    expect(next.doc.turn?.id).toBe("t2")
  })

  test("読んだときの版のままでなければ書かない（同時に立てた2つ目は書けない）", async () => {
    const bucket = memoryBucket()
    const a = await loadChat(bucket, "k")
    const b = await loadChat(bucket, "k")
    await saveChat(bucket, "k", a, { ...a.doc, turn: { id: "a", startedAt: 1 } })
    await expect(saveChat(bucket, "k", b, { ...b.doc, turn: { id: "b", startedAt: 1 } })).rejects.toBeInstanceOf(ChatConflictError)
  })
})

describe("削除の途中の案件", () => {
  test("印を取ってから削除の途中と分かったら、印で作った会話は消し、前からある会話は印だけ下ろす", async () => {
    const bucket = memoryBucket()
    await abandonTurn(bucket, "new", await beginTurn(bucket, "new", { id: "t", startedAt: 1 }))
    expect(await bucket.get(chatKey("new"))).toBeNull()
    const l = await loadChat(bucket, "old")
    await saveChat(bucket, "old", l, { ...l.doc, session })
    await abandonTurn(bucket, "old", await beginTurn(bucket, "old", { id: "t", startedAt: 1 }))
    expect((await loadChat(bucket, "old")).doc).toMatchObject({ session, turn: null })
  })
})

describe("会話を終える", () => {
  const ended = { id: "e1", role: "system" as const, parts: [{ type: "text" as const, text: "終えました" }] }

  test("指示を処理している間は、ファイルを消さずに断る。終わったら消して履歴を捨てる", async () => {
    const bucket = memoryBucket()
    const first = await beginTurn(bucket, "k", { id: "t1", startedAt: Date.now() })
    const withSession = await saveChat(bucket, "k", first, { ...first.doc, session })
    const deleted: string[] = []
    const del = async (ids: string[]) => void deleted.push(...ids)
    await expect(endSession(bucket, "k", del, ended, 0)).rejects.toBeInstanceOf(ChatBusyError)
    expect(deleted).toEqual([])
    await saveChat(bucket, "k", withSession, { ...withSession.doc, turn: null })
    expect(await endSession(bucket, "k", del, ended, 0)).toBe(true)
    expect(deleted).toEqual(["file_old"])
    const after = await loadChat(bucket, "k")
    expect([after.doc.session, after.doc.turn, after.doc.ui.at(-1)?.id]).toEqual([null, null, "e1"])
  })

  test("会話がまだ保存されていない最初の指示の途中でも、終わるのを待つ（その間に消さない）。会話が無ければ何も残さない", async () => {
    const bucket = memoryBucket()
    const first = await beginTurn(bucket, "k", { id: "t1", startedAt: Date.now() })
    await expect(endSession(bucket, "k", async () => {}, ended, 0)).rejects.toBeInstanceOf(ChatBusyError)
    await saveChat(bucket, "k", first, { ...first.doc, turn: null })
    expect(await endSession(bucket, "k", async () => {}, ended, 0)).toBe(false)
    expect((await loadChat(bucket, "k")).doc.turn).toBeNull()
    expect(await endSession(memoryBucket(), "none", async () => {}, ended, 0)).toBe(false)
  })

  test("消している間に始めた指示は待たされ、消せなかったら印だけ下ろす（会話は残る）", async () => {
    const bucket = memoryBucket()
    const l = await loadChat(bucket, "k")
    await saveChat(bucket, "k", l, { ...l.doc, session })
    let during: unknown = null
    const failing = async () => {
      during = await beginTurn(bucket, "k", { id: "t", startedAt: Date.now() }, 0).catch((e) => e)
      throw new Error("Files API に届かない")
    }
    await expect(endSession(bucket, "k", failing, ended, 0)).rejects.toThrow("Files API に届かない")
    expect(during).toBeInstanceOf(ChatBusyError)
    const after = await loadChat(bucket, "k")
    expect([after.doc.session?.generated, after.doc.turn]).toEqual([["file_old"], null])
  })
})

describe("指示のあとの会話", () => {
  test("終わった回は履歴とコンテナを進め、作ったファイルを記録する", () => {
    const done = [{ role: "user", content: "直して" } as ModelMessage, codeResult("file_a")]
    const next = settleSession(session, { completed: done, steps: [codeResult("file_a")], container: { id: "c2", expiresAt: "2099-01-02T00:00:00Z" } }, false)
    expect(next.model).toEqual([...session.model, ...done])
    expect(next.container?.id).toBe("c2")
    expect(next.generated).toEqual(["file_old", "file_a"])
  })

  test("止めた回は履歴を変えず、それまでに作ったファイルは記録する。この回で上げたファイルがあればコンテナを捨てる", () => {
    const aborted = { completed: null, steps: [codeResult("file_b")], container: null }
    expect(settleSession(session, aborted, false)).toEqual({ ...session, generated: ["file_old", "file_b"] })
    expect(settleSession(session, aborted, true).container).toBeNull()
  })
})

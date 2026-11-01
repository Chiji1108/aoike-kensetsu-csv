import type { FeedbackDeps, FeedbackStatus, FeedbackSummary } from "./feedback"

/**
 * 要望の置き場のメモリの代わり（照合のスクリプトとテスト。本番は server/feedback-store.ts の D1）。同じ要望は件数を足し、閉じた要望には足さない
 */
export function memoryFeedback(names: readonly string[] = [], known: readonly string[] = []) {
  const items: (FeedbackSummary & { did: string; status: FeedbackStatus })[] = []
  const deps: FeedbackDeps = {
    list: async () => items.filter((f) => f.status === "open").map(({ did: _, status: __, ...f }) => f),
    add: async (input) => {
      const id = `f${items.length + 1}`
      items.push({ id, kind: input.kind, want: input.want, idea: input.idea, did: input.did, count: 1, status: "open" })
      return id
    },
    bump: async (id) => {
      const f = items.find((x) => x.id === id && x.status === "open")
      if (f) f.count++
      return f !== undefined
    },
    names: async () => names,
    known,
  }
  return { items, deps }
}

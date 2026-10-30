import { describe, expect, test } from "bun:test"
import { closeTurn, finishTurn, watchStop } from "../turn-close"

describe("指示の後始末", () => {
  test("片付けが失敗しても、履歴の記録と費用は飛ばさない", async () => {
    const done: string[] = []
    const r = await closeTurn({
      cleanup: async () => {
        throw new Error("R2 に届かない")
      },
      record: async () => (done.push("record"), "saved"),
      addCost: async () => void done.push("cost"),
    })
    expect(done).toEqual(["record", "cost"])
    expect(r).toMatchObject({ recorded: "saved", ours: true, error: { message: "R2 に届かない" } })
  })

  test("費用（D1）が失敗しても、履歴は先に書いてあり、印は自分のもの（下ろしに行く）", async () => {
    const done: string[] = []
    const r = await closeTurn({
      cleanup: async () => {},
      record: async () => (done.push("record"), "saved"),
      addCost: async () => {
        throw new Error("D1 に書けない")
      },
    })
    expect(done).toEqual(["record"])
    expect(r).toMatchObject({ recorded: "saved", ours: true, error: { message: "D1 に書けない" } })
  })

  test("履歴を書けなかったのが印を引き継がれたためなら ours は false。ほかの失敗なら下ろしに行く", async () => {
    expect(await closeTurn({ cleanup: async () => {}, record: async () => null, addCost: async () => {} })).toMatchObject({ ours: false, error: null })
    const r = await closeTurn({
      cleanup: async () => {},
      record: async () => {
        throw new Error("R2 の失敗")
      },
      addCost: async () => {},
    })
    expect(r).toMatchObject({ recorded: null, ours: true, error: { message: "R2 の失敗" } })
  })
})

describe("止める印の見張り", () => {
  test("見張りは重ならず、見に行けなかった回は次でまた見る。印を見つけたら止める", async () => {
    let running = 0
    let most = 0
    let calls = 0
    const stopped = Promise.withResolvers<void>()
    const stop = watchStop(
      async () => {
        running++
        most = Math.max(most, running)
        calls++
        await new Promise((r) => setTimeout(r, 30))
        running--
        if (calls === 1) throw new Error("見に行けない")
        return calls === 3
      },
      () => stopped.resolve(),
      5,
    )
    await stopped.promise
    stop()
    expect([calls, most]).toEqual([3, 1])
  })
})

describe("変更案の出る指示の終わり", () => {
  const base = () => {
    const done: string[] = []
    return {
      done,
      steps: {
        putProposal: async () => void done.push("put"),
        deleteProposal: async () => void done.push("delete"),
        cleanup: async () => void done.push("cleanup"),
        record: async (completed: boolean) => (done.push(`record:${completed}`), "saved" as string | null),
        addCost: async () => void done.push("cost"),
      },
    }
  }

  test("変更案を置いてから履歴を書く。片付け・費用が失敗しても変更案は画面に出す", async () => {
    const { done, steps } = base()
    const r = await finishTurn({ ...steps, addCost: async () => Promise.reject(new Error("D1 の失敗")) })
    expect(done).toEqual(["put", "cleanup", "record:true"])
    expect(r).toMatchObject({ proposal: true, ours: true, error: { message: "D1 の失敗" } })
  })

  test("変更案を置けなければ、履歴に足さない（AI が出したつもりの変更案を残さない）", async () => {
    const { done, steps } = base()
    const r = await finishTurn({ ...steps, putProposal: async () => Promise.reject(new Error("R2 の失敗")) })
    expect(done).toEqual(["cleanup", "record:false", "cost"])
    expect(r).toMatchObject({ proposal: false, error: { message: "R2 の失敗" } })
  })

  test("履歴を書けなかったら置いた変更案を消す。消せなければ残っているので画面にも出す", async () => {
    const { done, steps } = base()
    expect(await finishTurn({ ...steps, record: async () => null })).toMatchObject({ proposal: false, ours: false })
    expect(done).toContain("delete")
    const failing = await finishTurn({ ...steps, record: async () => Promise.reject(new Error("R2 の失敗")), deleteProposal: async () => Promise.reject(new Error("消せない")) })
    expect(failing).toMatchObject({ proposal: true, ours: true, error: { message: "R2 の失敗" } })
  })

  test("変更案が無い回は置かない", async () => {
    const { done, steps } = base()
    expect(await finishTurn({ ...steps, putProposal: null })).toMatchObject({ proposal: false, error: null })
    expect(done).toEqual(["cleanup", "record:true", "cost"])
  })
})

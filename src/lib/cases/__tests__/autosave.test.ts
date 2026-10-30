import { describe, expect, test } from "bun:test"
import { editKey } from "../../convert/convert"
import { createAutosave, type SaveRequest, type SaveResponse, type SaveStatus } from "../autosave"
import { newWork, type CaseWork } from "../state"

const edited = (w: CaseWork, value: string): CaseWork => ({ ...w, edits: new Map(w.edits).set(editKey("工事経歴!3", "place"), { value, by: "staff" }) })
const converted = (w: CaseWork): CaseWork => ({ ...w, converted: true, aiCache: new Map([["横浜市", { id: 0, value: "横浜市", needsReview: false, note: "" }]]) })

/** 答えを順に返す保存先。答えが尽きたら保存できたことにする。投げる答えは Error */
function server(answers: (SaveResponse | Error)[] = []) {
  const requests: SaveRequest[] = []
  let version = 0
  return {
    requests,
    async save(req: SaveRequest): Promise<SaveResponse> {
      requests.push(structuredClone(req))
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      if (answer) return answer
      version = req.version + 1
      return { ok: true, version }
    },
  }
}

function setup(s: ReturnType<typeof server>, saved: CaseWork | null = null) {
  const statuses: SaveStatus["kind"][] = []
  const autosave = createAutosave({
    save: s.save,
    version: saved ? 5 : 0,
    saved,
    onStatus: (st) => statuses.push(st.kind),
    errorMessage: (e) => (e as Error).message,
    debounceMs: 2,
    retryMs: () => 5,
  })
  return { autosave, statuses, last: () => statuses.at(-1) }
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(2)
  expect(cond()).toBe(true)
}

describe("案件の作業の自動保存", () => {
  test("AI の結果は変わったときだけ送り、手直しだけの変更は小さい作業だけを送る", async () => {
    const s = server()
    const loaded = newWork("file-1")
    const { autosave, last } = setup(s, loaded)
    const afterConvert = converted(loaded)
    autosave.change(afterConvert)
    await until(() => last() === "saved")
    autosave.change(edited(afterConvert, "横浜市中区"))
    await until(() => s.requests.length === 2 && last() === "saved")
    expect(s.requests.map((r) => [r.version, r.aiCache])).toEqual([
      [5, [["横浜市", { id: 0, value: "横浜市", needsReview: false, note: "" }]]],
      [6, undefined],
    ])
    expect(s.requests[1]!.work.edits).toEqual([[editKey("工事経歴!3", "place"), { value: "横浜市中区", by: "staff" }]])
  })

  test("まだ保存の無い案件は、最初の保存で AI の結果も送る", async () => {
    const s = server()
    const { autosave, last } = setup(s)
    autosave.change(edited(newWork(), "a"))
    await until(() => last() === "saved")
    expect(s.requests.map((r) => [r.version, r.aiCache])).toEqual([[0, []]])
  })

  test("送れなければ、変更が無くても間を空けて送り直し、保存できるまで失敗を出し続ける", async () => {
    const s = server([new Error("通信できません"), new Error("通信できません")])
    const { autosave, statuses, last } = setup(s, newWork())
    autosave.change(edited(newWork(), "a"))
    await until(() => last() === "saved")
    expect(s.requests).toHaveLength(3)
    expect(statuses).toEqual(["pending", "failed", "failed", "saved"])
  })

  test("送れない間の変更は、送り直しのときに最新のものを送る", async () => {
    const s = server([new Error("通信できません")])
    const { autosave, last } = setup(s, newWork())
    autosave.change(edited(newWork(), "a"))
    await until(() => last() === "failed")
    autosave.change(edited(newWork(), "b"))
    await until(() => last() === "saved")
    expect(s.requests.map((r) => r.work.edits[0]![1].value)).toEqual(["a", "b"])
  })

  test("大きすぎて保存できなくても止めず、次の変更で送り直す。保存できるまで大きすぎることを出し続ける", async () => {
    const s = server([{ ok: false, reason: "tooLarge" }])
    const { autosave, statuses, last } = setup(s, newWork())
    autosave.change(edited(newWork(), "a"))
    await until(() => last() === "tooLarge")
    await Bun.sleep(20)
    expect(s.requests).toHaveLength(1)
    autosave.change(edited(newWork(), "b"))
    await until(() => last() === "saved")
    expect(statuses).toEqual(["pending", "tooLarge", "saved"])
    expect(s.requests).toHaveLength(2)
  })

  for (const reason of ["conflict", "gone"] as const) {
    test(`${reason === "conflict" ? "別の画面が先に保存した" : "案件が消された"}ら、それ以上送らない`, async () => {
      const s = server([{ ok: false, reason }])
      const { autosave, last } = setup(s, newWork())
      autosave.change(edited(newWork(), "a"))
      await until(() => last() === reason)
      autosave.change(edited(newWork(), "b"))
      await Bun.sleep(20)
      expect(s.requests).toHaveLength(1)
      expect(autosave.unsaved()).toBe(false)
    })
  }

  test("送っている間の変更は、その後に1回にまとめて、次の版で送る", async () => {
    let release!: () => void
    const s = server()
    const slow = { ...s, save: async (req: SaveRequest) => (s.requests.length === 0 ? (await new Promise<void>((r) => (release = r)), s.save(req)) : s.save(req)) }
    const { autosave, last } = setup(slow, newWork())
    autosave.change(edited(newWork(), "a"))
    await until(() => release !== undefined)
    autosave.change(edited(newWork(), "b"))
    autosave.change(edited(newWork(), "c"))
    await Bun.sleep(10)
    expect(autosave.unsaved()).toBe(true)
    release()
    await until(() => last() === "saved" && s.requests.length === 2)
    expect(s.requests.map((r) => [r.version, r.work.edits[0]![1].value])).toEqual([
      [5, "a"],
      [6, "c"],
    ])
    expect(autosave.unsaved()).toBe(false)
  })

  test("settle は今の変更まで保存し終えるのを待つ（待つ間を置かずに送る）。送れなければ false", async () => {
    const s = server([new Error("つながらない")])
    const loaded = newWork("file-1")
    const { autosave } = setup(s, loaded)
    expect(await autosave.settle()).toBe(true)
    autosave.change(edited(loaded, "横浜市"))
    expect(await autosave.settle()).toBe(false)
    autosave.change(edited(loaded, "横浜市中区"))
    expect(await autosave.settle()).toBe(true)
    expect(s.requests.at(-1)!.work.edits).toEqual([[editKey("工事経歴!3", "place"), { value: "横浜市中区", by: "staff" }]])
    expect(autosave.unsaved()).toBe(false)
  })
})

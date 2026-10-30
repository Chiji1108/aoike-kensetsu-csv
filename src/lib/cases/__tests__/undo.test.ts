import { describe, expect, test } from "bun:test"
import { applyChanges, type ChatChange } from "../../chat/proposals"
import { editKey, type CellEdit } from "../../convert/convert"
import { fromSaved, newWork, type SavedPlan, savedWorkSchema, toSavedWork, toSavedAiCache, type CaseWork } from "../state"
import { applyInquiryChange, EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import { canUndo, MAX_UNDO_BYTES, MAX_UNDO_ENTRIES, pushUndo, undo, undoEntry } from "../undo"

const chat = (value: string): CellEdit => ({ value, by: "chat" })
const staff = (value: string): CellEdit => ({ value, by: "staff" })

/** 変更を承認したときと同じく、作業に重ねて取り消しの記録を足す */
function approve(w: CaseWork, proposalId: string, changes: ChatChange[]): CaseWork {
  const next = applyChanges(w, [], changes)
  const entry = undoEntry(w, next, { id: `u-${proposalId}`, proposalId, label: proposalId, at: 0 })
  return entry ? { ...next, undo: pushUndo(next.undo, entry) } : next
}

/** 保存して読み直す（開き直したとき） */
const reopen = (w: CaseWork) => fromSaved(savedWorkSchema.parse(JSON.parse(JSON.stringify(toSavedWork(w)))), toSavedAiCache(w.aiCache))

describe("承認の取り消し", () => {
  const base = { ...newWork("f"), edits: new Map([[editKey("r1", "client"), staff("元の手直し")]]) }

  test("承認で変わった手直し・入れ外し・設定・足した行を前に戻す。開き直しても取り消せる", () => {
    const w = approve(base, "p1", [
      { kind: "cell", rowKey: "r1", field: "client", edit: chat("㈱青池") },
      { kind: "cell", rowKey: "r2", field: "workName", edit: chat("新築工事") },
      { kind: "include", rowKey: "r3", include: false },
      { kind: "settings", tax: "included", selection: "all" },
      { kind: "add", rowKey: "add-1", by: "chat", cells: { workName: chat("足した工事") } },
    ])
    expect(w.undo).toHaveLength(1)
    const r = undo(reopen(w), w.undo[0]!.id)!
    expect(r.kept).toBe(0)
    expect(r.work.edits.get(editKey("r1", "client"))).toEqual(staff("元の手直し"))
    expect(r.work.edits.has(editKey("r2", "workName"))).toBe(false)
    expect(r.work.edits.has(editKey("add-1", "workName"))).toBe(false)
    expect(r.work.manual.has("r3")).toBe(false)
    expect(r.work.tax).toBe("unknown")
    expect(r.work.selection).toBe("rule7")
    expect(r.work.added).toEqual([])
    expect(r.work.undo[0]!.undone).toBe(true)
    // 2回は取り消さない
    expect(undo(r.work, w.undo[0]!.id)).toBeNull()
  })

  test("承認のあとに変えた値は戻さずに数える。ほかの値は戻す（直前でない承認も取り消せる）", () => {
    let w = approve(base, "p1", [
      { kind: "cell", rowKey: "r1", field: "client", edit: chat("㈱青池") },
      { kind: "cell", rowKey: "r2", field: "client", edit: chat("㈲青池") },
    ])
    w = approve(w, "p2", [{ kind: "cell", rowKey: "r2", field: "client", edit: chat("青池商店") }])
    w = { ...w, edits: new Map(w.edits).set(editKey("r1", "client"), staff("職員が直した")) }
    const r = undo(w, "u-p1")!
    expect(r.kept).toBe(2)
    expect(r.work.edits.get(editKey("r1", "client"))).toEqual(staff("職員が直した"))
    expect(r.work.edits.get(editKey("r2", "client"))).toEqual(chat("青池商店"))
    // 新しい承認は取り消せる
    const r2 = undo(r.work, "u-p2")!
    expect(r2.kept).toBe(0)
    expect(r2.work.edits.get(editKey("r2", "client"))).toEqual(chat("㈲青池"))
  })

  test("足した行のセルを後から変えていれば、行は外さない", () => {
    let w = approve(base, "p1", [{ kind: "add", rowKey: "add-1", by: "chat", cells: { workName: chat("足した工事") } }])
    w = { ...w, edits: new Map(w.edits).set(editKey("add-1", "workName"), staff("直した")) }
    const r = undo(w, "u-p1")!
    expect(r.work.added.map((a) => a.key)).toEqual(["add-1"])
    expect(r.kept).toBe(1)
  })

  test("足した行の、承認では書いていない項目を後から直していても、行は外さずに数える（その手直しを黙って消さない）", () => {
    let w = approve(base, "p1", [{ kind: "add", rowKey: "add-1", by: "chat", cells: { workName: chat("足した工事") } }])
    w = { ...w, edits: new Map(w.edits).set(editKey("add-1", "client"), staff("後から足した注文者")) }
    const r = undo(w, "u-p1")!
    expect(r.work.added.map((a) => a.key)).toEqual(["add-1"])
    expect(r.work.edits.get(editKey("add-1", "client"))).toEqual(staff("後から足した注文者"))
    expect(r.kept).toBe(1)
  })

  test("記録の大きさは UTF-8 のバイト数で測る（日本語は1文字3バイト）", () => {
    const n = Math.floor(MAX_UNDO_BYTES / 3 / 80) + 10
    const changes = Array.from({ length: n }, (_, i): ChatChange => ({ kind: "cell", rowKey: `r${i}`, field: "workName", edit: chat("あ".repeat(80)) }))
    const entry = undoEntry(base, applyChanges(base, [], changes), { id: "jp", proposalId: "jp", label: "", at: 0 })!
    expect(JSON.stringify(entry).length).toBeLessThan(MAX_UNDO_BYTES)
    expect(pushUndo([], entry).at(-1)!.tooLarge).toBe(true)
  })

  test("計画を戻すと planChanged。今の計画が承認のあとに変わっていれば戻さない", () => {
    const plan: SavedPlan = { plan: { sheets: ["s"], headerRow: 0, dataRows: { start: 1, end: 2 }, skipRows: [], rowFilter: { excludeHidden: true, excludeColumns: [] }, amountUnit: "yen", fields: {} as never, unusedColumns: [], notes: [] }, source: "ai" }
    const before: CaseWork = { ...base, plan }
    const after: CaseWork = { ...before, plan: { ...plan, plan: { ...plan.plan, amountUnit: "thousandYen" as const } } }
    const entry = undoEntry(before, after, { id: "u", proposalId: "p", label: "計画", at: 0 })!
    const w: CaseWork = { ...after, undo: [entry] }
    const r = undo(w, "u")!
    expect(r.planChanged).toBe(true)
    expect(r.work.plan).toEqual(plan)
    const moved: CaseWork = { ...w, plan: { ...plan, plan: { ...plan.plan, headerRow: 1 } } }
    expect(undo(moved, "u")!.planChanged).toBe(false)
  })

  test("外への書き込み（ルールの追記）だけの承認も記録に残し、戻す値は無いので取り消せない", () => {
    const entry = undoEntry(base, base, { id: "u", proposalId: "p", label: "ルール", at: 0, external: ["rule"] })!
    expect(entry.external).toEqual(["rule"])
    expect(canUndo(entry)).toBe(false)
    expect(undoEntry(base, base, { id: "u", proposalId: "p", label: "x", at: 0 })).toBeNull()
  })

  test("記録の数と大きさに上限を付け、1件で上限を超える記録は取り消せない印だけを残す", () => {
    let list = [] as ReturnType<typeof pushUndo>
    for (let i = 0; i < MAX_UNDO_ENTRIES + 5; i++) list = pushUndo(list, undoEntry(base, approve(base, `p${i}`, [{ kind: "include", rowKey: `r${i}`, include: true }]), { id: `u${i}`, proposalId: `p${i}`, label: "", at: i })!)
    expect(list).toHaveLength(MAX_UNDO_ENTRIES)
    expect(list[0]!.id).toBe("u5")
    const big = Array.from({ length: 3000 }, (_, i): ChatChange => ({ kind: "cell", rowKey: `r${i}`, field: "workName", edit: chat("あ".repeat(80)) }))
    const huge = undoEntry(base, applyChanges(base, [], big), { id: "big", proposalId: "big", label: "", at: 0 })!
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_UNDO_BYTES)
    const pushed = pushUndo(list, huge).at(-1)!
    expect(pushed.tooLarge).toBe(true)
    expect(canUndo(pushed)).toBe(false)
  })

  test("前の版で保存した作業（取り消しの記録が無い）も読める", () => {
    const { undo: _u, reportAnswers: _r, ...old } = toSavedWork(newWork("f"))
    const read = savedWorkSchema.parse(JSON.parse(JSON.stringify(old)))
    expect(read.undo).toEqual([])
    expect(read.reportAnswers).toEqual({})
  })
})

describe("問い合わせの文面の承認の取り消し", () => {
  const text = applyInquiryChange(EMPTY_INQUIRY_TEXT, { kind: "inquiry", id: "p1:0", text: "この工事に置いた主任技術者の氏名を教えてください。", targets: [{ field: "engineer" }] })

  test("承認で足した文を取り消すと前の文面に戻る。前の作業（文面の無い保存）は空の文面として読む。承認のあとに職員が直していたら残す", () => {
    const before = newWork("f")
    const after = { ...before, inquiryText: text }
    const entry = undoEntry(before, after, { id: "u", proposalId: "p1", label: "p1", at: 0 })!
    expect(canUndo(entry)).toBe(true)
    const w = reopen({ ...after, undo: [entry] })
    expect(w.inquiryText).toEqual(text)
    expect(undo(w, "u")!.work.inquiryText).toEqual(EMPTY_INQUIRY_TEXT)
    // 承認のあとに直したもの（件名）は残し、承認で足した質問だけを外す
    const withMail = { ...after, inquiryText: { ...text, subject: "AI の件名" } }
    const e2 = undoEntry(before, withMail, { id: "u2", proposalId: "p1", label: "p1", at: 0 })!
    const edited = { ...withMail, undo: [e2], inquiryText: { ...withMail.inquiryText, subject: "職員の件名" } }
    const r = undo(edited, "u2")!
    expect(r).toMatchObject({ kept: 1, reverted: 1 })
    expect(r.work.inquiryText).toEqual({ ...EMPTY_INQUIRY_TEXT, subject: "職員の件名" })
    const { inquiryText: _, ...old } = toSavedWork(newWork("f"))
    expect(savedWorkSchema.parse(old).inquiryText).toEqual(EMPTY_INQUIRY_TEXT)
  })
})

import { describe, expect, test } from "bun:test"
import { applyChanges } from "../../chat/proposals"
import { newWork, savedWorkSchema, toSavedWork, type CaseWork } from "../state"
import { setTax, withPlanTax } from "../tax"
import { pushUndo, undo, undoEntry } from "../undo"

const included = { amountTax: "included" as const }
const excluded = { amountTax: "excluded" as const }
const unknown = {}

/** チャットの変更案で税の設定を承認する（画面と同じく取り消しの記録を残す） */
function approveTax(w: CaseWork, tax: "included" | "excluded"): CaseWork {
  const after = applyChanges(w, [], [{ kind: "settings", tax }])
  const entry = undoEntry(w, after, { id: "u1", proposalId: "p1", label: "p1", at: 0 })!
  return { ...after, undo: pushUndo(after.undo, entry) }
}

describe("税の設定と出どころ", () => {
  test("まだ誰も決めていなければ計画の値を入れる（出どころは計画）。計画が分からなければ決めない", () => {
    expect(withPlanTax(newWork("f"), included)).toMatchObject({ tax: "included", taxBy: "plan" })
    expect(withPlanTax(newWork("f"), unknown)).toMatchObject({ tax: "unknown", taxBy: null })
  })
  test("前の計画が決めた値のままなら、計画し直すと合わせ直す（分からなければ「まだ誰も決めていない」に戻す）", () => {
    const first = withPlanTax(newWork("f"), included)
    expect(withPlanTax(first, excluded)).toMatchObject({ tax: "excluded", taxBy: "plan" })
    expect(withPlanTax(first, unknown)).toMatchObject({ tax: "unknown", taxBy: null })
  })
  test("職員が「分からない」を選んだら、計画し直しても上書きしない", () => {
    const w = setTax(withPlanTax(newWork("f"), included), "unknown", "staff")
    expect(withPlanTax(w, excluded)).toMatchObject({ tax: "unknown", taxBy: "staff" })
  })
  test("チャットで承認した税の設定は職員の値。シートを変えて計画し直しても残る", () => {
    const approved = approveTax(withPlanTax(newWork("f"), included), "excluded")
    expect(approved).toMatchObject({ tax: "excluded", taxBy: "staff" })
    expect(withPlanTax(approved, included)).toMatchObject({ tax: "excluded", taxBy: "staff" })
  })
  test("承認を取り消すと、値と出どころを一緒に戻す（計画の値に戻れば、また計画し直しで合わせ直す）", () => {
    const approved = approveTax(withPlanTax(newWork("f"), included), "excluded")
    const r = undo(approved, "u1")!
    expect(r.work).toMatchObject({ tax: "included", taxBy: "plan" })
    expect(withPlanTax(r.work, excluded)).toMatchObject({ tax: "excluded", taxBy: "plan" })
    // 誰も決めていないときに承認したものを取り消すと、誰も決めていないに戻る
    const fromNone = undo(approveTax(newWork("f"), "included"), "u1")!
    expect(fromNone.work).toMatchObject({ tax: "unknown", taxBy: null })
  })
  test("承認のあとに職員が変えた税は、取り消しても残す", () => {
    const approved = approveTax(newWork("f"), "included")
    const changed = setTax(approved, "unknown", "staff")
    const r = undo(changed, "u1")!
    expect(r.work).toMatchObject({ tax: "unknown", taxBy: "staff" })
    expect(r.kept).toBe(1)
  })
  test("前の版の保存した作業（出どころが無い）も読める", () => {
    const { taxBy: _, ...old } = toSavedWork(newWork("f"))
    expect(savedWorkSchema.parse(old).taxBy).toBeNull()
  })
})

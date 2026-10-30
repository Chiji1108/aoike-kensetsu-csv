import { expect, test } from "bun:test"
import { heuristicPlan } from "../../convert/heuristic-plan"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import { caseContext } from "../context"

test("元データの文脈は空のセルだけを除き、「備考:」のように「:」で終わる値も残す", () => {
  const grid = { name: "s", rows: [["工事名", "", "備考"], ["テストビル工事", "", "備考:"]], hidden: [] }
  const text = caseContext([grid], grid, heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid))
  expect(text).toContain("A:工事名 | C:備考")
  expect(text).toContain("A:テストビル工事 | C:備考:")
})

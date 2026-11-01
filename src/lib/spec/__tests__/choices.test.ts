import { describe, expect, test } from "bun:test"
import { engineerRoleOf, ENGINEER_ROLES } from "../code-sets"
import { choiceLabel, choicesOf, matchesChoice } from "../choices"
import { KOJI_KEIREKI } from "../koji-keireki"

const field = (id: string) => KOJI_KEIREKI.fields.find((f) => f.id === id)!

describe("決まった値の項目の選ぶ欄", () => {
  test("数字で決まった値の項目は全部選ぶ欄。業種は絞り込める欄、少ないものはボタン、主任・監理は1つの欄。自由な項目は打つ", () => {
    const kinds = Object.fromEntries(KOJI_KEIREKI.fields.map((f) => {
      const c = choicesOf(f)
      return [f.id, !c ? "text" : c.kind === "engineerRole" ? "role" : c.search ? "search" : `buttons${c.options.length}`]
    }))
    expect(kinds).toEqual({
      gyoshu: "search",
      client: "text",
      motoukeShitauke: "buttons3",
      jv: "buttons2",
      workName: "text",
      prefecture: "text",
      place: "text",
      engineer: "text",
      amount: "text",
      specialAmount: "text",
      startYm: "text",
      endYm: "text",
      chiefEngineer: "role",
      supervisingEngineer: "role",
    })
  })

  test("表には名前で出す（コード表に無い値・自由な項目はそのまま）", () => {
    expect(choiceLabel(field("gyoshu"), "8")).toBe("電気")
    expect(choiceLabel(field("motoukeShitauke"), "2")).toBe("下請")
    expect(choiceLabel(field("jv"), "0")).toBe("なし")
    expect(choiceLabel(field("chiefEngineer"), "1")).toBe("あり")
    expect(choiceLabel(field("gyoshu"), "31")).toBeUndefined()
    expect(choiceLabel(field("amount"), "1")).toBeUndefined()
  })

  test("業種は名前・コード・別名・全角で絞り込める", () => {
    const c = choicesOf(field("gyoshu"))
    if (c?.kind !== "codes") throw new Error("業種は選ぶ欄")
    const options = c.options
    const hit = (q: string) => options.filter((o) => matchesChoice(o, q)).map((o) => o.code)
    expect(hit("電気")).toEqual(["8", "22"])
    expect(hit("8")).toEqual(["8", "18", "28"])
    expect(hit("８ 電")).toEqual(["8"])
    expect(hit("内装")).toEqual(["19"])
    expect(hit("")).toHaveLength(30)
  })

  test("主任技術者・監理技術者は、どちらか一方だけが 1 の組み合わせを1つ選ぶ", () => {
    expect(ENGINEER_ROLES.map((r) => r.values)).toEqual([
      { chiefEngineer: "1", supervisingEngineer: "0" },
      { chiefEngineer: "0", supervisingEngineer: "1" },
    ])
    expect(engineerRoleOf("1", "0")).toBe("chief")
    expect(engineerRoleOf("0", "1")).toBe("supervising")
    expect(engineerRoleOf("1", "1")).toBeUndefined()
    // どの組み合わせも決まり（oneEngineerRole）に合う
    const rule = KOJI_KEIREKI.rowRules.find((r) => r.id === "oneEngineerRole")!
    for (const r of ENGINEER_ROLES) expect(rule.holds({ ...r.values } as never)).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS } from "../../spec/koji-keireki"
import type { AiBatchRequest, AiItemResult } from "../../convert/ai-tasks"
import { editKey, staffEdit } from "../../convert/convert"
import { heuristicPlan } from "../../convert/heuristic-plan"
import { personLetters } from "../../convert/persons"
import { runConversion, type AiCache, type AiCaller } from "../../convert/pipeline"
import { fileAddressLookup } from "../../convert/address-file"
import { collectSourceRows } from "../../convert/sources"
import { readWorkbook } from "../../convert/workbook"
import { fixture } from "../../convert/__tests__/helpers"
import { chatChangeSchema } from "../../chat/proposals"
import { fromSaved, newWork, savedAiCacheSchema, savedWorkSchema, toSavedAiCache, toSavedWork, withPlanTax, type CaseWork } from "../state"

const [grid] = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid!)
const sources = collectSourceRows([grid!], plan).rows

/** 種類ごとの形で答える AI（個人名の匿名化は persons 付き、住所は分割、ほかは値をそのまま） */
const cannedAi: AiCaller = async (req: AiBatchRequest) => ({
  ok: true,
  json: {
    results: req.items.map(({ id, input }) => {
      const base = { id, needsReview: false, note: "" }
      switch (req.task) {
        case "anonymizeClient":
        case "anonymizeWorkName":
          return { ...base, value: "〔1〕", persons: [input] }
        case "splitAddress":
          return { ...base, prefecture: "神奈川県", city: input.slice(0, 3), rest: input.slice(3), prefectureInferred: true }
        default:
          return { ...base, value: input }
      }
    }),
  },
})

const viaJson = (v: unknown) => JSON.parse(JSON.stringify(v))
const roundTrip = (w: CaseWork) => fromSaved(savedWorkSchema.parse(viaJson(toSavedWork(w))), savedAiCacheSchema.parse(viaJson(toSavedAiCache(w.aiCache))))

describe("案件の状態の保存と読み出し", () => {
  test("保存した AI の結果から、AI を呼ばずに同じ行を作り直せ、手直し・選択・設定が残る", async () => {
    const cache = new Map()
    const rows = await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx: { rounding: "round" }, cache, callAi: cannedAi })
    expect(cache.size).toBeGreaterThan(0)
    const key = rows[0]!.key
    const work: CaseWork = {
      ...newWork("file-1"),
      plan: { plan, source: "rule", notice: "見出しから列を推定しました" },
      converted: true,
      aiNotice: "一部失敗",
      aiCache: new Map([...cache, ["失敗した値", { error: "通信エラー" }]]),
      edits: new Map([[editKey(key, "workName"), staffEdit("手直しした工事", personLetters([]))]]),
      replacements: { engineer: { "青池　一郎": { value: "青池　次郎", by: "staff" } } },
      manual: new Map([[key, false]]),
      dismissed: new Set([`case:tax`]),
      tax: "excluded",
      basis: { "01": { total: 1000, motouke: 500 } },
      selection: "all",
      rounding: "round",
      threshold: { on: true, yen: "3000000" },
    }

    const restored = roundTrip(work)
    expect(restored).toEqual(work)
    const again = await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan: restored.plan!.plan, ctx: { rounding: restored.rounding }, cache: new Map(restored.aiCache) })
    expect(again).toEqual(rows)
  })

  test("AI の結果の項目（個人名の persons など）を削らずに読む", () => {
    const anonymized = { id: 0, value: "〔1〕邸", needsReview: true, note: "", persons: ["山田太郎"] }
    const address = { id: 1, prefecture: "東京都", city: "港区", rest: "1", prefectureInferred: false, needsReview: false, note: "" }
    const aiCache: AiCache = new Map<string, AiItemResult>([
      ["a", anonymized],
      ["b", address],
    ])
    const work = { ...newWork(), aiCache }
    expect([...roundTrip(work).aiCache]).toEqual([["a", anonymized], ["b", address]])
  })

  test("前の形（7割適用済み alreadyApplied）の作業と変更案は、載せる工事の選び方（selection）にして読む", () => {
    const { selection: _, ...saved } = toSavedWork(newWork())
    expect(savedWorkSchema.parse({ ...saved, alreadyApplied: true }).selection).toBe("all")
    expect(savedWorkSchema.parse({ ...saved, alreadyApplied: false }).selection).toBe("rule7")
    expect(savedWorkSchema.parse(saved).selection).toBe("rule7")
    expect("alreadyApplied" in savedWorkSchema.parse({ ...saved, alreadyApplied: true })).toBe(false)
    expect(chatChangeSchema.parse({ kind: "settings", alreadyApplied: true })).toEqual({ kind: "settings", selection: "all" })
    expect(chatChangeSchema.parse({ kind: "settings", tax: "included" })).toEqual({ kind: "settings", tax: "included" })
  })

  test("7割の計算は新しい作業なら渡した初期値。この項目より前の保存は税抜（前はいつも税抜で計算していた）", () => {
    expect(newWork(null, "included").rule7Tax).toBe("included")
    const { rule7Tax: _, ...old } = toSavedWork(newWork(null, "included"))
    expect(savedWorkSchema.parse(old).rule7Tax).toBe("excluded")
    expect(savedWorkSchema.parse(toSavedWork(newWork(null, "included"))).rule7Tax).toBe("included")
  })

  test("形の違う保存は読まない", () => {
    const saved = toSavedWork(newWork())
    expect(savedWorkSchema.safeParse({ ...saved, tax: "both" }).success).toBe(false)
    expect(savedWorkSchema.safeParse({ ...saved, edits: [["k", { value: "x", by: "someone" }]] }).success).toBe(false)
    expect(savedAiCacheSchema.safeParse([["k", { id: 0, value: "x" }]]).success).toBe(false)
  })
})

describe("計画の税込・税抜を案件の税の設定に入れる", () => {
  const included = { ...plan, amountTax: "included" as const }
  const excluded = { ...plan, amountTax: "excluded" as const }
  test("未設定なら計画の値を入れ、聞き返しは要らない", () => {
    const w = withPlanTax(newWork("f"), included)
    expect(w.tax).toBe("included")
    expect(w.planTax).toBe("included")
  })
  test("計画が分からなければ未設定のまま", () => {
    expect(withPlanTax(newWork("f"), plan).tax).toBe("unknown")
  })
  test("職員が決めた値・聞き返しに答えた（顧客に聞く）ときは上書きしない", () => {
    expect(withPlanTax({ ...newWork("f"), tax: "excluded" }, included).tax).toBe("excluded")
    expect(withPlanTax({ ...newWork("f"), reportAnswers: { tax: "ask" } }, included).tax).toBe("unknown")
  })
  test("前の計画が決めた値のままなら、計画をやり直すと合わせ直す（分からなければ未設定に戻す）", () => {
    const first = withPlanTax(newWork("f"), included)
    expect(withPlanTax(first, excluded)).toMatchObject({ tax: "excluded", planTax: "excluded" })
    expect(withPlanTax(first, plan)).toMatchObject({ tax: "unknown", planTax: null })
    // 職員が変えたあとは計画の値として扱わない
    expect(withPlanTax({ ...first, tax: "excluded" }, plan)).toMatchObject({ tax: "excluded", planTax: null })
  })
  test("前の版の保存した作業（planTax が無い）も読める", () => {
    const { planTax: _, ...old } = toSavedWork(newWork("f"))
    expect(savedWorkSchema.parse(old).planTax).toBeNull()
  })
})

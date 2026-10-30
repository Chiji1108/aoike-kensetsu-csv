import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS, type KojiFieldId } from "../../spec/koji-keireki"
import type { AiBatchRequest } from "../ai-tasks"
import { aiKey, applyEdits, collectAiBatches, convertRows, editKey, editSession, editText, finalizeRows, resolveRows, staffEdit, transformCell, type CellDraft, type CellEdits, type Replacements, type RowResult } from "../convert"
import { toCsvBytes, toCsvText } from "../csv"
import { heuristicPlan } from "../heuristic-plan"
import { orderKojiRows } from "../koji-selection"
import { addressBookFor, runConversion, type AiCache } from "../pipeline"
import { fileAddressLookup } from "../address-file"
import { decodeCp932 } from "../text"
import { personToken, showPersons, withNames } from "../persons"
import { collectSourceRows } from "../sources"
import { readWorkbook } from "../workbook"
import { finalizeAll, fixture, kojiRow, valuesOf } from "./helpers"

const [grid] = readWorkbook("sample-messy.xlsx", fixture("sample-messy.xlsx"))
const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, grid!)
const sources = collectSourceRows([grid!], plan).rows
const ctx = { rounding: "floor" as const, addresses: await addressBookFor(KOJI_KEIREKI, sources, plan, fileAddressLookup) }
const finalize = (rows: RowResult<KojiFieldId>[], edits: CellEdits = new Map()) => finalizeAll(rows, { edits }).rows
const noKey = async () => ({ ok: false as const, message: "APIキー未設定" })

describe("sample-messy.xlsx（APIキーなし）", () => {
  test("Excel の日付セルと結合セルを読める", () => {
    expect(grid!.name).toBe("工事経歴")
    expect(grid!.rows[3]![8]).toBe("2024-03-31")
    expect(grid!.rows[0]![5]).toBe(grid!.rows[0]![0]!)
  })

  test("見出しから列の対応を推定する", () => {
    expect(plan.headerRow).toBe(2)
    expect(plan.dataRows).toEqual({ start: 3, end: 12 })
    expect(plan.skipRows).toEqual([10, 11, 12])
    expect(plan.amountUnit).toBe("yen")
    expect(plan.fields).toMatchObject({
      gyoshu: { kind: "column", column: 1, transform: "rule.gyoshu" },
      client: { kind: "column", column: 3, transform: "ai.anonymizeClient" },
      motoukeShitauke: { kind: "columns", columns: [4, 3], transform: "rule.motoukeShitauke" },
      jv: { kind: "constant", value: "0" },
      workName: { kind: "column", column: 2, transform: "ai.anonymizeWorkName" },
      prefecture: { kind: "column", column: 5, transform: "rule.addressPrefecture" },
      place: { kind: "column", column: 5, transform: "rule.addressCity" },
      engineer: { kind: "column", column: 9, transform: "rule.personNameSpace" },
      amount: { kind: "column", column: 6, transform: "rule.yenToThousand" },
      specialAmount: { kind: "constant", value: "0" },
      startYm: { kind: "column", column: 7, transform: "rule.periodStart" },
      endYm: { kind: "column", column: 8, transform: "rule.yearMonth" },
      chiefEngineer: { kind: "missing" },
      supervisingEngineer: { kind: "missing" },
    })
    expect(plan.unusedColumns.map((c) => c.header)).toEqual(["No.", "備考"])
  })

  test("AI に送るのはルールで決まらなかった値だけ（重複なし）", () => {
    const batches = collectAiBatches(convertRows(KOJI_KEIREKI, sources, plan, ctx), new Map())
    const asked = Object.fromEntries(batches.map((b) => [b.request.task, b.request.items.map((i) => i.input)]))
    expect(asked).toEqual({
      anonymizeClient: ["山田太郎", "鈴木一郎"],
      anonymizeWorkName: ["山田太郎邸新築工事", "鈴木様邸リフォーム工事"],
      splitAddress: ["横浜市中区山下町10", "川崎市川崎区駅前本町5"],
      personName: ["青池一郎", "鈴木次郎"],
    })
  })

  test("ルール変換の結果と、AI 部分の「APIキー未設定」の警告。個人名か判定できない注文者・工事名は元の値を出さない", async () => {
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: noKey }))
    expect(rows).toHaveLength(7)
    expect(valuesOf(rows[0]!)).toEqual({
      gyoshu: "2",
      client: "",
      motoukeShitauke: "1",
      jv: "0",
      workName: "",
      prefecture: "東京都",
      place: "世田谷区",
      engineer: "青池一郎",
      amount: "32400",
      specialAmount: "0",
      startYm: "202304",
      endYm: "202403",
      chiefEngineer: "1",
      supervisingEngineer: "0",
    })
    for (const cell of [rows[0]!.cells.client, rows[0]!.cells.workName]) {
      expect(cell).toMatchObject({ status: "error", withheld: true })
      expect(cell.message).toContain("個人名の判定ができませんでした。手で入力してください")
      expect(cell.message).toContain("APIキー未設定")
    }
    expect(rows[0]!.cells.engineer).toMatchObject({ status: "warning" })
    expect(rows[0]!.cells.engineer.message).toContain("APIキー未設定")
    expect(rows[0]!.cells.amount).toMatchObject({ status: "changed", message: "千円未満（500円）を切り捨て" })

    const r2 = valuesOf(rows[1]!)
    expect(r2).toMatchObject({ gyoshu: "8", client: "株式会社サンプル商事", place: "横浜市中区", engineer: "佐藤　花子", startYm: "202306", endYm: "202312" })
    expect(rows[1]!.cells.prefecture.status).toBe("error")
    expect(valuesOf(rows[2]!)).toMatchObject({ gyoshu: "5", client: "横浜市", motoukeShitauke: "0", prefecture: "神奈川県", place: "横浜市港北区" })
    expect(valuesOf(rows[3]!)).toMatchObject({ gyoshu: "9", motoukeShitauke: "2", engineer: "田中　三郎", amount: "5500" })
  })

  test("手直しは再変換しても残り、検証し直される", async () => {
    const edits = new Map([
      [editKey("工事経歴!4", "prefecture"), { value: "神奈川県", by: "staff" as const }],
      [editKey("工事経歴!3", "specialAmount"), { value: "99999", by: "staff" as const }],
    ])
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: noKey }), edits)
    expect(rows[1]!.cells.prefecture).toMatchObject({ value: "神奈川県", status: "changed", source: "手入力" })
    expect(rows[0]!.cells.specialAmount).toMatchObject({ status: "error", message: "請負代金のうち（PC・法面・鋼橋上部）が請負代金を超えています" })
  })

  test("生成した CSV を CP932 で読み直すと、見出し行なし・CRLF・14列・業種順", async () => {
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: noKey }))
    const lines = decodeCp932(toCsvBytes(KOJI_KEIREKI, orderKojiRows(rows))).split("\r\n")
    expect(lines.pop()).toBe("")
    expect(lines).toHaveLength(7)
    for (const l of lines) expect(l.split(",")).toHaveLength(14)
    expect(lines.map((l) => l.split(",")[0])).toEqual(["2", "2", "2", "5", "8", "8", "9"])
  })
})

describe("並べ替え", () => {
  test("業種ごとに元請→下請、それぞれ金額の大きい順", async () => {
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: noKey }))
    expect(orderKojiRows(rows).map((r) => [r.cells.gyoshu.value, r.cells.motoukeShitauke.value, r.cells.amount.value])).toEqual([
      ["2", "1", "32400"],
      ["2", "1", "18000"],
      ["2", "1", "4320"],
      ["5", "0", "8800"],
      ["8", "1", "12345"],
      ["8", "2", "2200"],
      ["9", "2", "5500"],
    ])
  })
})

describe("AI の結果の検算（決まった応答で確認）", () => {
  const canned: Record<string, (req: AiBatchRequest) => unknown> = {
    anonymizeClient: (req) => ({ results: req.items.map((i) => ({ id: i.id, value: "〔1〕", persons: [i.input], needsReview: false, note: "個人" })) }),
    anonymizeWorkName: (req) => ({
      results: req.items.map((i) => {
        const person = /山田太郎|鈴木/.exec(i.input)![0]
        return { id: i.id, value: i.input.replace(person, "〔1〕"), persons: [person], needsReview: i.input.includes("鈴木"), note: "記号を確認" }
      }),
    }),
    splitAddress: (req) => ({
      results: req.items.map((i) =>
        i.input.startsWith("横浜")
          ? { id: i.id, prefecture: "神奈川県", city: "横浜市中区", rest: "山下町10", prefectureInferred: true, needsReview: false, note: "" }
          : { id: i.id, prefecture: "神奈川県", city: "川崎市", rest: "駅前本町5", prefectureInferred: true, needsReview: false, note: "" },
      ),
    }),
    personName: (req) => ({
      results: req.items.map((i) => ({ id: i.id, value: i.input === "青池一郎" ? "青池　一郎" : "鈴木　二郎", needsReview: false, note: "" })),
    }),
  }
  const cannedAi = async (req: AiBatchRequest) => ({ ok: true as const, json: canned[req.task]!(req) })

  test("検算に通った値は ai、要確認は warning、通らない値は error で元の値を残す", async () => {
    const cache: AiCache = new Map()
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache, callAi: cannedAi }))
    expect(rows[0]!.cells.client).toMatchObject({ value: "Ａ", status: "ai" })
    expect(rows[6]!.cells.client).toMatchObject({ value: "Ｂ", status: "ai" })
    expect(rows[0]!.cells.workName).toMatchObject({ value: "Ａ邸新築工事", status: "ai" })
    expect(rows[6]!.cells.workName).toMatchObject({ value: "Ｃ様邸リフォーム工事", status: "warning" })

    expect(rows[1]!.cells.prefecture).toMatchObject({ value: "神奈川県", status: "ai", message: "都道府県「神奈川県」を補完" })
    expect(rows[6]!.cells.prefecture).toMatchObject({ status: "error", value: "" })
    expect(rows[6]!.cells.prefecture.message).toContain("検算エラー")

    expect(rows[0]!.cells.engineer).toMatchObject({ value: "青池　一郎", status: "ai" })
    expect(rows[2]!.cells.engineer).toMatchObject({ value: "鈴木次郎", status: "error" })
    expect(rows[2]!.cells.engineer.message).toContain("検算エラー")
  })

  test("個人名の記号は注文者・工事名を通して案件で1つの表から付ける（同じ人は同じ記号、AI の印に個人名が残れば error）", async () => {
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: cannedAi }))
    expect(withNames(rows[0]!.cells.workName.stored!)).toBe("〔山田太郎〕邸新築工事")
    const leaky = async (req: AiBatchRequest) =>
      req.task === "anonymizeWorkName"
        ? { ok: true as const, json: { results: req.items.map((i) => ({ id: i.id, value: i.input, persons: ["山田太郎"], needsReview: false, note: "" })) } }
        : cannedAi(req)
    const leaked = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: leaky }))
    expect(leaked[0]!.cells.workName).toMatchObject({ status: "error", value: "", withheld: true })
    expect(leaked[0]!.cells.workName.message).toContain("個人名が残っています")
  })

  test("個人名の検算は AI が印にした場所を見る。名前の字がほかの語にあっても残ったとは言わず、印にしていない人・印の場所が名前と違えば error", () => {
    const anonymizeWorkName = (raw: string, value: string, persons: string[]) => {
      const draft = transformCell("ai.anonymizeWorkName", [raw], "C列", ctx)
      const store = new Map([[aiKey("anonymizeWorkName", undefined, raw), { id: 0, value, persons, needsReview: false, note: "" }]])
      const [row] = resolveRows([{ key: "k", sheet: "s", row: 0, cells: { workName: draft } as Record<KojiFieldId, CellDraft> }], store)
      return finalizeAll([{ ...kojiRow({}), cells: { ...kojiRow({}).cells, workName: row!.cells.workName } }], { replacements: {}, edits: new Map() }).rows[0]!.cells.workName
    }
    expect(anonymizeWorkName("森林公園前 森様邸新築工事", "森林公園前 〔1〕様邸新築工事", ["森"])).toMatchObject({ value: "森林公園前 Ａ様邸新築工事", status: "ai" })
    expect(anonymizeWorkName("森林公園前 森様邸新築工事", "森林公園前 森様邸新築工事", ["森"]).message).toContain("印になっていない人")
    expect(anonymizeWorkName("山田太郎邸新築工事", "〔1〕邸新築工事", ["田中"]).message).toContain("一致しません")
  })

  test("一度得た結果は再実行で AI に再送しない", async () => {
    const cache: AiCache = new Map()
    await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache, callAi: cannedAi })
    const calls: AiBatchRequest[] = []
    await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache, callAi: async (r) => (calls.push(r), cannedAi(r)) })
    expect(calls).toEqual([])
  })

  test("前に失敗した値は、次に AI を呼んで実行したときに送り直す", async () => {
    const cache: AiCache = new Map()
    await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache, callAi: noKey })
    const resent: string[] = []
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache, callAi: async (r) => (resent.push(r.task), cannedAi(r)) }))
    expect(resent.sort()).toEqual(["anonymizeClient", "anonymizeWorkName", "personName", "splitAddress"])
    expect(rows[0]!.cells.engineer).toMatchObject({ value: "青池　一郎", status: "ai" })
  })

  test("形式の崩れた応答・依頼していない id・欠けた id は AI 変換できなかった扱い", async () => {
    const broken = async (req: AiBatchRequest) =>
      req.task === "personName"
        ? { ok: true as const, json: { results: [{ id: 99, value: "誰か　さん", needsReview: false, note: "" }] } }
        : { ok: true as const, json: { results: "壊れた応答" } }
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: broken }))
    expect(rows[0]!.cells.engineer).toMatchObject({ value: "青池一郎", status: "warning" })
    expect(rows[0]!.cells.engineer.message).toContain("結果がありません")
    expect(rows[0]!.cells.client.message).toContain("形式が正しくありません")
  })

  test("AI が表に無い業種コードを返したらエラー", async () => {
    const g = { name: "s", rows: [["業種", "金額"], ["外構工事", "1000"]], hidden: [false, false] }
    const p = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
    const rows = await runConversion({
      lookup: fileAddressLookup, spec: KOJI_KEIREKI,
      sources: collectSourceRows([g], p).rows,
      plan: p,
      ctx,
      cache: new Map(),
      callAi: async (req) => ({ ok: true, json: { results: req.items.map((i) => ({ id: i.id, value: "31", needsReview: false, note: "" })) } }),
    })
    expect(rows[0]!.cells.gyoshu.status).toBe("error")
  })
})

test("主任技術者・監理技術者は建設業.NET で空欄にできないので、空欄は主任技術者 1・監理技術者 0 で埋め、手入力で空にしたら（もう片方も決められず）エラー", () => {
  const { rows: out } = finalizeAll([kojiRow({}, 1), kojiRow({}, 2)], {
    replacements: {},
    edits: new Map([[editKey("s!1", "supervisingEngineer"), { value: "", by: "staff" as const }]]),
  })
  expect(out[0]!.cells.chiefEngineer).toMatchObject({ value: "", status: "error", message: "必須の項目です" })
  expect(out[0]!.cells.supervisingEngineer).toMatchObject({ value: "", status: "error", message: "必須の項目です" })
  expect([out[1]!.cells.chiefEngineer, out[1]!.cells.supervisingEngineer]).toMatchObject([
    { value: "1", status: "changed" },
    { value: "0", status: "changed" },
  ])
})

test("主任技術者と監理技術者はちょうど一方が 1。両方 0・両方 1 は警告（エラーにはしない）", () => {
  const status = (chiefEngineer: string, supervisingEngineer: string) =>
    finalizeAll([kojiRow({ chiefEngineer, supervisingEngineer }, 1)], { replacements: {}, edits: new Map() }).rows[0]!.cells.chiefEngineer.status
  expect([status("1", "0"), status("0", "1"), status("0", "0"), status("1", "1")]).toEqual(["ok", "ok", "warning", "warning"])
})

test("主任技術者・監理技術者の片方だけ元データにあれば、もう片方はその逆で埋める（両方 1 にしない）", () => {
  const roles = (values: Partial<Record<KojiFieldId, string>>) => {
    const c = finalizeAll([kojiRow(values, 1)], { replacements: {}, edits: new Map() }).rows[0]!.cells
    return `${c.chiefEngineer.value}/${c.supervisingEngineer.value}`
  }
  expect(roles({ supervisingEngineer: "1" })).toBe("0/1")
  expect(roles({ supervisingEngineer: "0" })).toBe("1/0")
  expect(roles({ chiefEngineer: "0" })).toBe("0/1")
  expect(roles({ chiefEngineer: "1" })).toBe("1/0")
  expect(roles({})).toBe("1/0")
})

test("主任技術者 0 だけから監理技術者 1 を決めたときは、資格者がいると黙って決めず要確認にする（主任技術者 1 は黙って決めてよい）", () => {
  const cells = (values: Partial<Record<KojiFieldId, string>>) => finalizeAll([kojiRow(values, 1)], { replacements: {}, edits: new Map() }).rows[0]!.cells
  const derived = cells({ chiefEngineer: "0" }).supervisingEngineer
  expect(derived).toMatchObject({ value: "1", status: "warning", guessed: true })
  expect(derived.message).toContain("要確認")
  expect(cells({ supervisingEngineer: "0" }).chiefEngineer).toMatchObject({ value: "1", status: "changed" })
  expect(cells({ supervisingEngineer: "0" }).chiefEngineer.guessed).toBeUndefined()
  expect(cells({}).supervisingEngineer).toMatchObject({ value: "0", status: "changed" })
})

test("職員が手で空にした側は空のまま扱い、もう片方を両方空のときの値で埋めない（理由も実際の値と合う）", () => {
  const cleared = (field: "chiefEngineer" | "supervisingEngineer") =>
    finalizeAll([kojiRow({}, 1)], { replacements: {}, edits: new Map([[editKey("s!1", field), { value: "", by: "staff" as const }]]) }).rows[0]!.cells
  for (const field of ["chiefEngineer", "supervisingEngineer"] as const) {
    const c = cleared(field)
    expect([c.chiefEngineer.value, c.supervisingEngineer.value]).toEqual(["", ""])
    expect(c.chiefEngineer.message ?? "").not.toContain("主任技術者とする")
    expect(c.supervisingEngineer.message ?? "").not.toContain("主任技術者とする")
  }
  const c = finalizeAll([kojiRow({}, 1)], { replacements: {}, edits: new Map([[editKey("s!1", "chiefEngineer"), { value: "0", by: "staff" as const }]]) }).rows[0]!.cells
  expect([c.chiefEngineer.value, c.supervisingEngineer.value]).toEqual(["0", "1"])
})

describe("配置技術者の姓と名の区切り", () => {
  const g = {
    name: "s",
    rows: [
      ["業種", "注文者", "工事名", "請負代金", "配置技術者"],
      ["電気", "株式会社テスト", "テスト工事1", "1000000", "架空 一郎"],
      ["電気", "株式会社テスト", "テスト工事2", "1000000", "架空一郎"],
      ["電気", "株式会社テスト", "テスト工事3", "1000000", "仮名次郎"],
    ],
    hidden: [false, false, false, false],
  }
  const p = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
  const src = collectSourceRows([g], p).rows

  test("同じファイルに空白で区切った同じ氏名があれば、AI に送らずその区切りに合わせる", async () => {
    const sent: string[] = []
    const unsure = async (req: AiBatchRequest) => {
      if (req.task !== "personName") return { ok: false as const, message: "この確認では使わない" }
      sent.push(...req.items.map((i) => i.input))
      return { ok: true as const, json: { results: req.items.map((i) => ({ id: i.id, value: "仮名　次郎", needsReview: true, note: "区切りに迷う" })) } }
    }
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources: src, plan: p, ctx, cache: new Map(), callAi: unsure }))
    expect(sent).toEqual(["仮名次郎"])
    expect(rows[1]!.cells.engineer).toMatchObject({ value: "架空　一郎", status: "changed", message: "同じファイル内の表記に合わせた" })
    expect(rows[2]!.cells.engineer).toMatchObject({ value: "仮名　次郎", status: "warning", guessed: true })
  })
})

test("監理技術者の列だけある元データでは、主任技術者を定数 1 にせず監理技術者から決める", async () => {
  const g = { name: "s", rows: [["業種", "注文者", "工事名", "請負代金", "監理技術者"], ["電気", "株式会社テスト", "テスト工事", "1000000", "○"]], hidden: [false, false] }
  const p = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
  const rows = await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources: collectSourceRows([g], p).rows, plan: p, ctx: { rounding: "floor" }, cache: new Map() })
  const c = finalizeAll(rows).rows[0]!.cells
  expect([c.chiefEngineer.value, c.supervisingEngineer.value]).toEqual(["0", "1"])
})

describe("個人名の記号の表（finalizeRows の letters）", () => {
  const yamada = personToken("山田太郎")
  const suzuki = personToken("鈴木一郎")
  const tanaka = personToken("田中花子")
  const finalizeIn = (rows: RowResult<KojiFieldId>[], exported: (r: RowResult<KojiFieldId>) => boolean, opts: { replacements?: Replacements<KojiFieldId>; edits?: CellEdits } = {}) =>
    finalizeRows(KOJI_KEIREKI, applyEdits(KOJI_KEIREKI, rows, { replacements: opts.replacements ?? {}, edits: opts.edits ?? new Map() }), { exported, original: rows, replacements: opts.replacements })

  test("記号は CSV に書く行だけから CSV の順に Ａ から欠けなく付ける。載せない行にだけいる人は〔未掲載１〕で、CSV の記号とぶつからない", () => {
    const rows = [kojiRow({ client: yamada }, 1, { excluded: "除外" }), kojiRow({ client: suzuki }, 2), kojiRow({ client: tanaka }, 3), kojiRow({ client: `${suzuki}様` }, 4)]
    const exported = (r: RowResult<KojiFieldId>) => r.key !== "s!1" && r.key !== "s!3"
    const { rows: out, letters } = finalizeIn(rows, exported)
    expect(out.filter(exported).map((r) => r.cells.client.value)).toEqual(["Ａ", "Ａ様"])
    expect(toCsvText(KOJI_KEIREKI, out.filter(exported))).not.toContain("未掲載")
    expect(out.map((r) => r.cells.client.value)).toEqual(["〔未掲載１〕", "Ａ", "〔未掲載２〕", "Ａ様"])
    expect(editText(out[0]!.cells.client, letters)).toBe("〔未掲載１〕")
    expect(staffEdit("〔未掲載１〕邸", letters)).toEqual({ value: `${yamada}邸`, by: "staff" })

    const reordered = finalizeIn([rows[3]!, rows[2]!, rows[1]!, rows[0]!], () => true)
    expect(reordered.rows.map((r) => r.cells.client.value)).toEqual(["Ａ様", "Ｂ", "Ａ", "Ｃ"])
  })

  test("手直しで消えた人・手直しの古い値・置換の元の値は CSV の記号を飛ばさない", () => {
    const rows = [kojiRow({ client: yamada }, 1), kojiRow({ client: suzuki }, 2)]
    const edits = new Map([[editKey("s!1", "client"), { value: "株式会社テスト", by: "staff" as const }], [editKey("s!9", "client"), { value: tanaka, by: "staff" as const }]])
    const { rows: out, letters } = finalizeIn(rows, () => true, { edits })
    expect(out.map((r) => r.cells.client.value)).toEqual(["株式会社テスト", "Ａ"])
    expect(showPersons(yamada, letters)).toBe("〔未掲載１〕")
  })

  test("手直しを開いている間に記号が付け直されても、開いたときの記号の人として読む", () => {
    const rows = [kojiRow({ client: yamada }, 1), kojiRow({ client: suzuki }, 2)]
    const before = finalizeIn(rows, () => true)
    const session = editSession(before.rows[1]!.cells.client, before.letters)
    expect(session.text).toBe("〔Ｂ〕")
    const after = finalizeIn(rows, (r) => r.key === "s!2")
    expect(showPersons(suzuki, after.letters, true)).toBe("〔Ａ〕")
    expect(session.read(`${session.text}様`)).toEqual({ value: `${suzuki}様`, by: "staff" })
  })

  test("CSV に載らない置換先の人も画面に出せる（〔未掲載１〕）", () => {
    const row = kojiRow({ client: "個人" }, 1)
    const replacements = { client: { 個人: { value: `${yamada}様`, by: "staff" as const } } }
    const edits = new Map([[editKey("s!1", "client"), { value: "株式会社テスト", by: "staff" as const }]])
    const { rows, letters } = finalizeIn([row], () => true, { replacements, edits })
    expect(rows[0]!.cells.client.value).toBe("株式会社テスト")
    expect(showPersons(replacements.client.個人.value, letters)).toBe("〔未掲載１〕様")
  })
})

import { describe, expect, test } from "bun:test"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS, type KojiFieldId } from "../../spec/koji-keireki"
import type { AiBatchRequest } from "../ai-tasks"
import { editKey, staffEdit, type RowResult } from "../convert"
import { heuristicPlan } from "../heuristic-plan"
import { keibiYen, orderKojiRows, selectBy7Rule, selectKojiRows, summarizeKoji, type Basis, type Inclusion } from "../koji-selection"
import { runConversion } from "../pipeline"
import { fileAddressLookup } from "../address-file"
import { NO_ADDRESSES } from "../address"
import type { SheetGrid } from "../plan"
import { collectSourceRows, defaultSheetSelection } from "../sources"
import { personToken, showPersons } from "../persons"
import { joinWorkName } from "../transforms"
import { finalizeAll, kojiRow, valuesOf } from "./helpers"

const ctx = { rounding: "floor" as const, addresses: NO_ADDRESSES }
const sheet = (name: string, rows: string[][], hidden: boolean[] = rows.map(() => false)): SheetGrid => ({ name, rows, hidden })
const finalize = (rows: RowResult<KojiFieldId>[]) => finalizeAll(rows).rows
const noKey = async () => ({ ok: false as const, message: "APIキー未設定" })

/** 業種ごとのシートに分かれ、業種を○の列で表す社内システムの書き出し（例1と同じ形の合成データ） */
const HEADER = [
  "番号", "売上担当者名", "客先名略称", "請負区分名", "官民区分名", "納期（Ｆｒｏｍ）", "納期（Ｔｏ）", "現場名１", "現場名２",
  "受注金額", "都道府県", "市区町村", "配置技術者", "電気工事", "菅工事", "消防施設　　工事", "工事実績から除外",
]
const ROWS = [
  ["1", "青池　一郎", "株式会社テスト不動産", "元請", "民間物件", "20250401", "20260331", "（仮称）テスト ビル", "改修工事", "12,345,678", "", "", "", "〇", "○", "", ""],
  ["2", "鈴木　花子", "テスト市", "元請", "官庁物件", "20250601", "20250930", "テスト市民会館", "", "3,000,000", "", "", "", "", "〇", "", ""],
  ["3", "佐藤　次郎", "テスト設備㈱", "下請", "民間物件", "20250701", "20251031", "テスト倉庫", "", "800,000", "", "", "", "", "", "", ""],
  ["4", "佐藤　次郎", "テスト設備㈱", "下請", "民間物件", "20250801", "20251130", "テスト工場", "", "1,500,000", "", "", "", "", "〇", "", "除外"],
]
const TOTAL = ["", "", "", "", "", "", "", "", "合計", "17,645,678", "", "", "", "", "", "", ""]
const all = sheet("全件", [HEADER, ...ROWS, TOTAL])
const kan = sheet("管工事", [HEADER, ...ROWS, TOTAL], [false, false, true, false, false, false])
const book = [all, kan]

describe("業種シートに分かれ、業種を○で表す表", () => {
  const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, all, book)

  test("見出しから ○ の列・現場名の連結・所在地の推定・除外の列を選ぶ", () => {
    expect(plan.sheets).toEqual(["全件"])
    expect(plan.fields.gyoshu).toEqual({
      kind: "flagColumns",
      columns: [{ column: 13, code: "8" }, { column: 14, code: "9" }, { column: 15, code: "27" }],
    })
    expect(plan.fields).toMatchObject({
      client: { kind: "column", column: 2 },
      motoukeShitauke: { kind: "columns", columns: [3, 4], transform: "rule.motoukeShitauke" },
      workName: { kind: "columns", columns: [7, 8], transform: "rule.joinWorkName" },
      prefecture: { kind: "columns", columns: [7, 8, 2], transform: "ai.inferPrefecture" },
      place: { kind: "columns", columns: [7, 8, 2], transform: "ai.inferPlace" },
      engineer: { kind: "column", column: 1, transform: "rule.personNameSpace" },
      amount: { kind: "column", column: 9, transform: "rule.yenToThousand" },
      startYm: { kind: "column", column: 5, transform: "rule.yearMonth" },
      endYm: { kind: "column", column: 6, transform: "rule.yearMonth" },
    })
    expect(plan.rowFilter).toEqual({ excludeHidden: false, excludeColumns: [16] })
    expect(plan.skipRows).toEqual([5])
  })

  test("○ が複数ある行は業種ごとに分け、○ の無い行は出さず、除外の印がある行は除外にする", async () => {
    const { rows: sources } = collectSourceRows(book, plan)
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi: noKey }))
    expect(rows.map((r) => [r.key, r.cells.gyoshu.value, r.excluded ?? ""])).toEqual([
      ["全件!1#8", "8", ""],
      ["全件!1#9", "9", ""],
      ["全件!2#9", "9", ""],
      ["全件!4#9", "9", "Q列（除外の印）に値がある"],
    ])
    expect(valuesOf(rows[0]!)).toMatchObject({
      client: "株式会社テスト不動産",
      motoukeShitauke: "1",
      workName: "テストビル改修工事",
      amount: "12345",
      startYm: "202504",
      endYm: "202603",
      engineer: "青池　一郎",
    })
    expect(rows[2]!.cells.motoukeShitauke.value).toBe("0")
  })

  test("所在地は工事名と注文者から1回だけ推定し、結果は常に要確認。47都道府県名でなければエラー", async () => {
    const { rows: sources } = collectSourceRows(book, plan)
    const asked: AiBatchRequest[] = []
    const callAi = async (req: AiBatchRequest) => {
      asked.push(req)
      if (req.task !== "inferLocation") return { ok: false as const, message: "対象外" }
      return {
        ok: true as const,
        json: {
          results: req.items.map((i) =>
            i.input.startsWith("（仮称）テスト")
              ? { id: i.id, prefecture: "東京都", place: "東京都中野区", needsReview: false, note: "" }
              : { id: i.id, prefecture: "東京", place: "", needsReview: true, note: "不明" },
          ),
        },
      }
    }
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan, ctx, cache: new Map(), callAi }))
    const location = asked.filter((r) => r.task === "inferLocation")
    expect(location).toHaveLength(1)
    expect(location[0]!.items.map((i) => i.input)).toEqual([
      "（仮称）テスト ビル 改修工事 株式会社テスト不動産",
      "テスト市民会館 テスト市",
      "テスト工場 テスト設備㈱",
    ])
    expect(rows[0]!.cells.prefecture).toMatchObject({ value: "東京都", status: "warning", message: "現場名から推定" })
    expect(rows[0]!.cells.place).toMatchObject({ value: "中野区", status: "warning" })
    expect(rows[2]!.cells.prefecture.status).toBe("error")
  })

  test("非表示の行を除く設定なら、隠れた行は除外", async () => {
    const p = { ...plan, sheets: ["管工事"], rowFilter: { ...plan.rowFilter, excludeHidden: true } }
    const { rows: sources } = collectSourceRows(book, p)
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources, plan: p, ctx, cache: new Map(), callAi: noKey }))
    expect(rows.map((r) => [r.key, r.excluded ?? ""])).toEqual([
      ["管工事!1#8", ""],
      ["管工事!1#9", ""],
      ["管工事!2#9", "非表示の行"],
      ["管工事!4#9", "Q列（除外の印）に値がある"],
    ])
  })
})

describe("シートの選択と重複", () => {
  test("ほかのシートに中身がすべて含まれるシート・空のシートは最初は選ばない。見出しの右端の空セルは無視する", () => {
    const part = sheet("一部", [[...HEADER, "", ""], ROWS[1]!])
    const other = sheet("別", [HEADER, ["9", "田中　三郎", "別会社", "元請", "民間物件", "20250101", "20250301", "別現場", "", "900,000", "", "", "", "〇", "", "", ""]])
    const empty = sheet("空", [HEADER])
    const unrelated = sheet("メモ", [["メモ"], ["何か"]])
    expect(defaultSheetSelection([all, part, other, empty, unrelated], all, 0)).toEqual(["全件", "別"])
  })

  test("合計行の値が違うだけ・一部の行を手直ししただけの写しのシートも、最初は選ばない", () => {
    const many = Array.from({ length: 20 }, (_, i) => [String(i), "青池　一郎", "株式会社テスト", "元請", "民間物件", "20250401", "20250901", `現場${i}`, "", "1,000,000", "", "", "", "〇", "", "", ""])
    const base = sheet("全件", [HEADER, ...many, [...TOTAL.slice(0, 9), "20,000,000", ...TOTAL.slice(10)]])
    const edited = many.map((r, i) => (i === 3 ? r.map((c, j) => (j === 7 ? "手直しした現場名" : c)) : r))
    const copy = sheet("電気工事", [HEADER, ...edited, [...TOTAL.slice(0, 9), "1,000,000", ...TOTAL.slice(10)]])
    expect(defaultSheetSelection([base, copy], base, 0)).toEqual(["全件"])
  })

  test("選んだシートをまたいで同じ行は1件にまとめ、件数を数える", () => {
    const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, all, book)
    const { rows, duplicates } = collectSourceRows(book, { ...plan, sheets: ["全件", "管工事"] })
    expect(duplicates).toBe(4)
    expect(rows.map((r) => r.sheet)).toEqual(["全件", "全件", "全件", "全件"])
  })
})

describe("古い建設業.NET 雛形の見出し", () => {
  const old = sheet("工事経歴書", [
    [
      "業種\n1から28の数値を入力して下さい\nその他の工事は29を入力して下さい", "注文者", "元請下請\n0から2の数値を入力して下さい", "JV　　　0：無1：有",
      "工事名", "都道府県名", "配置技術者", "請負代金\n     単位(千円)", "内訳業種分\n請負代金のうち、内訳業種（PC工事、法面工事、鋼橋上部工事）分の代金",
      "着工年月\n入力例：\n平成13年8月\n↓\n200108", "完成予定年月\n入力は着工年月と同じ",
    ],
    ["9", "株式会社テスト", "2", "0", "（仮称）テスト計画新築工事", "東京都文京区", "青池一郎", "12,500", "0", "202407", "202501"],
  ])
  const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, old)

  test("都道府県名の列に市区町村まで入っていれば住所として分ける", async () => {
    expect(plan.fields).toMatchObject({
      gyoshu: { kind: "column", column: 0, transform: "rule.gyoshu" },
      motoukeShitauke: { kind: "columns", columns: [2, 1] },
      jv: { kind: "column", column: 3, transform: "rule.flag01" },
      prefecture: { kind: "column", column: 5, transform: "rule.addressPrefecture" },
      place: { kind: "column", column: 5, transform: "rule.addressCity" },
      amount: { kind: "column", column: 7, transform: "rule.thousandYen" },
      specialAmount: { kind: "column", column: 8, transform: "rule.thousandYen" },
      startYm: { kind: "column", column: 9 },
      endYm: { kind: "column", column: 10 },
    })
    const rows = finalize(await runConversion({ lookup: fileAddressLookup, spec: KOJI_KEIREKI, sources: collectSourceRows([old], plan).rows, plan, ctx, cache: new Map(), callAi: noKey }))
    expect(valuesOf(rows[0]!)).toMatchObject({ gyoshu: "9", prefecture: "東京都", place: "文京区", amount: "12500", specialAmount: "0", startYm: "202407", endYm: "202501" })
  })
})

describe("着工・完成の列", () => {
  test("見出しに「完了」があっても、値が日付でない列は選ばない", () => {
    const g = sheet("s", [
      ["ＳＲ完了フラグ名", "納期（Ｆｒｏｍ）", "納期（Ｔｏ）", "受注金額"],
      ["ＳＲ完了済", "20250401", "20250930", "1000"],
      ["未完了", "20250501", "20251031", "2000"],
    ])
    const plan = heuristicPlan(KOJI_KEIREKI, KOJI_PLAN_HINTS, g)
    expect(plan.fields.startYm).toEqual({ kind: "column", column: 1, transform: "rule.yearMonth" })
    expect(plan.fields.endYm).toEqual({ kind: "column", column: 2, transform: "rule.yearMonth" })
  })
})

describe("工事名の整形", () => {
  test.each([
    [["（仮称）テスト ビル", "改修工事"], "テストビル改修工事"],
    [["(仮称)　テスト計画"], "テスト計画"],
    [["テスト（仮称）工事"], "テスト（仮称）工事"],
  ])("%j → %s", (inputs, expected) => {
    expect(joinWorkName(inputs)).toBe(expected)
  })
})

describe("一括置換", () => {
  test("置換は変換の後・手直しの前。置換先の氏名も全角スペースに整える", () => {
    const rows = [kojiRow({ engineer: "山川　一郎", amount: "100" }, 1), kojiRow({ engineer: "山川　一郎" }, 2), kojiRow({ engineer: "別　人" }, 3)]
    const { rows: out } = finalizeAll(rows, {
      replacements: { engineer: { "山川　一郎": { value: "海野 二郎", by: "staff" } } },
      edits: new Map([[editKey("s!2", "engineer"), { value: "手入　力", by: "staff" }]]),
    })
    expect(out.map((r) => r.cells.engineer.value)).toEqual(["海野　二郎", "手入　力", "別　人"])
    expect(out[0]!.cells.engineer).toMatchObject({ status: "changed", message: "一括置換" })
  })

  const yamada = personToken("山田太郎")
  const suzuki = personToken("鈴木一郎")
  const clients = () => [kojiRow({ client: yamada }, 1), kojiRow({ client: suzuki }, 2)]

  test("置換で CSV から消えた人は、置換の一覧では「〔未掲載１〕」で出す。CSV に残る人の記号は消えた人に左右されない", () => {
    const { rows: out, letters } = finalizeAll(clients(), { replacements: { client: { [yamada]: { value: "株式会社テスト", by: "staff" } } }, edits: new Map() })
    expect(out.map((r) => r.cells.client.value)).toEqual(["株式会社テスト", "Ａ"])
    expect([showPersons(yamada, letters), showPersons(suzuki, letters)]).toEqual(["〔未掲載１〕", "Ａ"])
  })

  test("置換先の「〔Ａ〕」は手直しと同じく今の表のその人、ただの「Ａ」は文字のまま。表に無い記号はエラー", () => {
    const { letters } = finalizeAll(clients(), { replacements: {}, edits: new Map() })
    const replaced = (text: string) =>
      finalizeAll(clients(), { replacements: { client: { [suzuki]: staffEdit(text, letters) } }, edits: new Map() })
    const marked = replaced("〔Ａ〕邸新築工事")
    expect(marked.rows[1]!.cells.client.value).toBe("Ａ邸新築工事")
    expect(marked.rows[1]!.cells.client.stored).toBe(`${yamada}邸新築工事`)
    const plain = replaced("Ａ邸新築工事").rows[1]!.cells.client
    expect([plain.value, plain.stored]).toEqual(["Ａ邸新築工事", undefined])
    expect(replaced("〔Ｚ〕邸新築工事").rows[1]!.cells.client).toMatchObject({ value: "〔Ｚ〕邸新築工事", status: "error" })
  })
})

describe("7割ルール", () => {
  const netTax = { tax: "excluded" as const, selection: "rule7" as const }
  const row = (n: number, gyoshu: string, ms: string, amount: number, excluded?: string) =>
    kojiRow({ gyoshu, motoukeShitauke: ms, amount: String(amount) }, n, excluded ? { excluded } : {})

  test("① 元請を元請合計の7割を超えるまで ② 残りを全体の7割を超えるまで、金額の大きい順", () => {
    const rows = [row(1, "9", "1", 10000), row(2, "9", "0", 6000), row(3, "9", "1", 4000), row(4, "9", "2", 30000), row(5, "9", "2", 2000)]
    expect([...selectBy7Rule(rows, netTax)].sort()).toEqual(["s!1", "s!2", "s!4"])
    const inclusion = selectKojiRows(rows, { ...netTax, manual: new Map() })
    expect(summarizeKoji(rows, inclusion, netTax)).toEqual([
      {
        code: "9", label: "管", count: 5, selected: 3, total: 52000, motoukeTotal: 20000,
        basis: { total: 52000, motouke: 20000 }, motoukeRatio: 0.8, totalRatio: 46000 / 52000,
        short: { motouke: false, total: false }, fromExcluded: { count: 0, total: 0 },
      },
    ])
  })

  test("軽微な工事（税込500万円未満）は通して10件まで。超える軽微は飛ばして続ける", () => {
    const rows = [...Array.from({ length: 16 }, (_, i) => row(i + 1, "9", "1", 1000)), row(17, "9", "2", 6000)]
    const selected = selectBy7Rule(rows, netTax)
    expect(selected.size).toBe(11)
    expect(selected.has("s!17")).toBe(true)
  })

  test("全件を載せる切り替え: 7割を超えて止めず、軽微な工事も10件を超えて載せる。比率は載せた全件で出す", () => {
    const rows = [...Array.from({ length: 16 }, (_, i) => row(i + 1, "9", "1", 1000)), row(17, "9", "2", 6000)]
    const count = (selection: "rule7" | "all") => [...selectKojiRows(rows, { ...netTax, selection, manual: new Map() }).values()].filter((i) => i.included).length
    expect(count("rule7")).toBe(11)
    expect(count("all")).toBe(17)
    const all = selectKojiRows(rows, { ...netTax, selection: "all", manual: new Map() })
    const [g] = summarizeKoji(rows, all, netTax)
    expect(g).toMatchObject({ selected: 17, totalRatio: 1, short: { motouke: false, total: false } })
    // 基準額が行の合計より大きく、全件でも7割に届かなければ足りないと出す
    const [short] = summarizeKoji(rows, all, { ...netTax, basis: { "9": { total: 100000 } } })
    expect(short!.short.total).toBe(true)
  })

  test("軽微の基準は建築一式なら1,500万円。税抜の金額は1.1で割った基準と比べ、不明は税込扱い", () => {
    expect(keibiYen("unknown")("9")).toBe(5_000_000)
    expect(keibiYen("included")("2")).toBe(15_000_000)
    expect(keibiYen("excluded")("9")).toBeCloseTo(5_000_000 / 1.1)
    const rows = [...Array.from({ length: 16 }, (_, i) => row(i + 1, "9", "1", 4600))]
    expect(selectBy7Rule(rows, { tax: "included" }).size).toBe(10)
    expect(selectBy7Rule(rows, { tax: "excluded" }).size).toBe(12)
  })

  test("除外した行は数えない。金額で追加・手動の入れ外しは7割より優先", () => {
    const rows = [row(1, "8", "1", 9000), row(2, "8", "1", 1000), row(3, "8", "2", 500), row(4, "8", "1", 50000, "除外の印")]
    const inclusion = selectKojiRows(rows, { ...netTax, includeAtLeastYen: 1_000_000, manual: new Map([["s!1", false], ["s!4", true]]) })
    expect(rows.map((r) => inclusion.get(r.key))).toEqual([
      { included: false, reason: "manual" },
      { included: true, reason: "threshold" },
      { included: false, reason: "unselected" },
      { included: true, reason: "manual" },
    ])
    expect(selectBy7Rule(rows, netTax)).toEqual(new Set(["s!1"]))
  })

  test("手動で入れた除外の行は載せるが、件数・基準額の既定・比率には入れず、別に数える", () => {
    const rows = [row(1, "8", "1", 6000), row(2, "8", "1", 4000), row(3, "8", "1", 50000, "除外の印")]
    const inclusion = selectKojiRows(rows, { ...netTax, manual: new Map([["s!2", false], ["s!3", true]]) })
    expect([...selectBy7Rule(rows, netTax)].sort()).toEqual(["s!1", "s!2"])
    const [g] = summarizeKoji(rows, inclusion, netTax)
    expect(g).toEqual({
      code: "8", label: "電気", count: 2, selected: 1, total: 10000, motoukeTotal: 10000,
      basis: { total: 10000, motouke: 10000 }, motoukeRatio: 0.6, totalRatio: 0.6,
      short: { motouke: true, total: true }, fromExcluded: { count: 1, total: 50000 },
    })
  })

  test("除外した行だけを手動で入れた業種も、別に数えて出す（比率は出さない）", () => {
    const rows = [row(1, "8", "1", 6000), row(2, "9", "1", 3000, "除外の印")]
    const [, g] = summarizeKoji(rows, selectKojiRows(rows, { ...netTax, manual: new Map([["s!2", true]]) }), netTax)
    expect(g).toMatchObject({ code: "9", count: 0, selected: 0, totalRatio: undefined, short: { motouke: false, total: false }, fromExcluded: { count: 1, total: 3000 } })
  })

  describe("基準額（損益計算書の完成工事高）", () => {
    const rows = [row(1, "9", "1", 10000), row(2, "9", "0", 6000), row(3, "9", "1", 4000), row(4, "9", "2", 30000), row(5, "9", "2", 2000)]
    const keys = (basis: Basis) => [...selectBy7Rule(rows, { ...netTax, basis })].sort()

    test("合計の基準額の7割を超えるまで載せる（行の合計 52,000 ではなく 70,000 の7割 = 49,000）", () => {
      expect(keys({})).toEqual(["s!1", "s!2", "s!4"])
      expect(keys({ "9": { total: 70000 } })).toEqual(["s!1", "s!2", "s!3", "s!4"])
    })

    test("うち元請の基準額で ① の目標が変わる（30,000 の7割 = 21,000 まで元請を載せる）", () => {
      expect(keys({ "9": { motouke: 30000 } })).toEqual(["s!1", "s!2", "s!3", "s!4"])
    })

    test("税込（と不明）の金額は1.1で割って税抜の基準額と比べ、比率も税抜で出す", () => {
      const basis = { "9": { total: 60000 } }
      expect(keys(basis)).toEqual(["s!1", "s!2", "s!4"])
      for (const tax of ["included", "unknown"] as const) {
        expect([...selectBy7Rule(rows, { tax, basis })].sort()).toEqual(["s!1", "s!2", "s!3", "s!4"])
        const [g] = summarizeKoji(rows, selectKojiRows(rows, { tax, basis, selection: "rule7", manual: new Map() }), { tax, basis })
        expect(g!.totalRatio).toBeCloseTo(50000 / 1.1 / 60000)
        expect(g!.total).toBeCloseTo(52000 / 1.1)
      }
    })

    test("税込・不明でもちょうど7割は超えていない（元請 7,000 と 3,000 で 7,000 は7割ちょうど、3,000 まで載せる）", () => {
      const exact = [row(1, "9", "1", 7000), row(2, "9", "1", 3000)]
      for (const tax of ["excluded", "included", "unknown"] as const) {
        expect([...selectBy7Rule(exact, { tax })].sort()).toEqual(["s!1", "s!2"])
        const [g] = summarizeKoji(exact, selectKojiRows(exact, { tax, selection: "rule7", manual: new Map([["s!2", false]]) }), { tax })
        expect(g!.short).toEqual({ motouke: true, total: true })
        const [all] = summarizeKoji(exact, selectKojiRows(exact, { tax, selection: "rule7", manual: new Map() }), { tax })
        expect(all!.short).toEqual({ motouke: false, total: false })
      }
    })

    test("基準額 0 は使わず、行の合計で選ぶ（0 を目標にすると何も選ばれない）", () => {
      expect(keys({ "9": { total: 0, motouke: 0 } })).toEqual(keys({}))
      const [g] = summarizeKoji(rows, selectKojiRows(rows, { ...netTax, basis: { "9": { total: 0 } }, manual: new Map() }), { ...netTax, basis: { "9": { total: 0 } } })
      expect(g!.basis.total).toBe(52000)
    })

    test("別の業種の基準額は効かない", () => {
      expect(keys({ "8": { total: 1_000_000 } })).toEqual(["s!1", "s!2", "s!4"])
    })

    test("行を使い切っても基準額の7割に届かないときは全行を載せ、比率は基準額に対して出す", () => {
      const basis = { "9": { total: 100000 } }
      expect(keys(basis)).toEqual(["s!1", "s!2", "s!3", "s!4", "s!5"])
      const [g] = summarizeKoji(rows, selectKojiRows(rows, { ...netTax, basis, manual: new Map() }), { ...netTax, basis })
      expect(g).toMatchObject({ total: 52000, basis: { total: 100000, motouke: 20000 }, motoukeRatio: 1, totalRatio: 0.52 })
    })

    test("全件を載せるときは、除外と手動で外した行のほかは全部載せる", () => {
      const withExcluded = [...rows, row(6, "9", "2", 100, "除外の印")]
      const inclusion = selectKojiRows(withExcluded, { ...netTax, selection: "all", manual: new Map([["s!5", false]]) })
      expect(withExcluded.map((r) => inclusion.get(r.key))).toEqual([
        ...Array.from({ length: 4 }, (): Inclusion => ({ included: true, reason: "all" })),
        { included: false, reason: "manual" },
        { included: false, reason: "excluded" },
      ])
    })
  })

  test("出力は業種ごと・元請→下請・金額の大きい順", () => {
    const rows = [row(1, "9", "2", 900), row(2, "8", "2", 5000), row(3, "9", "0", 100), row(4, "9", "1", 300)]
    expect(orderKojiRows(rows).map((r) => r.key)).toEqual(["s!2", "s!4", "s!3", "s!1"])
  })
})

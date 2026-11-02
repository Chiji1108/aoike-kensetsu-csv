import { describe, expect, test } from "bun:test"
import { editKey, editSession, type CellResult, type RowResult } from "@/lib/convert/convert"
import { personToken } from "@/lib/convert/persons"
import { finalizeAll, kojiRow } from "@/lib/convert/__tests__/helpers"
import { askReasonOf } from "@/lib/inquiry/inquiry"
import type { Inclusion } from "@/lib/convert/koji-selection"
import { askText, cellFix, changedCell, countFixes, fixActionGroups, fixActionOf, fixActionText, fixText, gyoshuTodo, inFilter, rowFix, type RowFix } from "../status"

const ok: CellResult = { value: "x", status: "ok", source: "A列: x", original: "x" }
const row = (key: string, other: Partial<CellResult>): RowResult<"a" | "b"> => ({
  key,
  sheet: "S",
  row: 1,
  cells: { a: ok, b: { ...ok, ...other } },
})

const rows = [
  row("plain", {}),
  row("error", { status: "error", message: "不正" }),
  row("warning", { status: "warning", message: "推定" }),
  row("aiFilled", { status: "ai", value: "東京都", original: "", message: "都道府県を補った" }),
  row("ai", { status: "ai", value: "Ａ", original: "山田太郎" }),
  row("aiSame", { status: "ai" }),
  row("rule", { status: "changed", value: "202304", original: "R5.4" }),
  row("guessedFill", { status: "warning", value: "東京都", original: "", message: "注文者から推定", guessed: true }),
  row("ruleThenWarning", { status: "warning", value: "202304", original: "R5.4", message: "工期の終わりより後" }),
  row("staffError", { status: "error", by: "staff", source: "手入力" }),
  row("customerSame", { status: "changed", by: "customer", source: "顧客の回答" }),
  row("confirmed", { status: "ok", by: "confirmed" }),
]
const fixOf = (r: RowResult<"a" | "b">) => rowFix(r, () => true)
const checked = rows.filter((r) => fixOf(r).fixes.length > 0).map((r) => r.key)
const never = () => false
const changed = rows.filter((r) => Object.values(r.cells).some(changedCell)).map((r) => r.key)

describe("表の絞り込み", () => {
  test("変更ありの印は元データと値が違うセルか、職員・顧客が入れたセル。状態（要確認など）には左右されない", () => {
    expect(changed).toEqual(["aiFilled", "ai", "rule", "guessedFill", "ruleThenWarning", "staffError", "customerSame"])
  })
  test("直すは CSV に載せる行だけ。載せない行はすべてでだけ出る。理由で絞れ、数は表と次にやることで同じ", () => {
    const err = fixOf(rows.find((r) => r.key === "error")!)
    expect(inFilter({ kind: "fix" }, err, true, never, "error")).toBe(true)
    expect(inFilter({ kind: "fix" }, err, false, never, "error")).toBe(false)
    expect(inFilter({ kind: "all" }, err, false, never, "error")).toBe(true)
    expect(inFilter({ kind: "fix", reason: "error" }, err, true, never, "error")).toBe(true)
    expect(inFilter({ kind: "fix", reason: "guess" }, err, true, never, "error")).toBe(false)
    const inclusion = new Map(rows.map((r, i) => [r.key, { included: i % 2 === 0 }]))
    const fixes = new Map(rows.map((r) => [r.key, fixOf(r)]))
    const counts = countFixes(rows, inclusion, fixes)
    expect(counts.rows).toBe(rows.filter((r, i) => i % 2 === 0 && checked.includes(r.key)).length)
    expect(counts.all).toBe(rows.length)
  })
  test("聞き返しの「表で見る」は対象の行だけ（載せない行も）", () => {
    const none: RowFix = { fixes: [], ask: [] }
    expect(inFilter({ kind: "all", ask: "q" }, none, false, (k) => k === "r1", "r1")).toBe(true)
    expect(inFilter({ kind: "all", ask: "q" }, none, true, (k) => k === "r1", "r2")).toBe(false)
  })
})

test("変換の流れで、推定で補って要確認になったセルは変更あり、元のままのセルは変更なし", () => {
  const cells = finalizeAll([kojiRow({ chiefEngineer: "0", workName: "倉庫改修工事" }, 1)], { replacements: {}, edits: new Map() }).rows[0]!.cells
  expect(cells.supervisingEngineer.status).toBe("warning")
  expect(changedCell(cells.supervisingEngineer)).toBe(true)
  expect(changedCell(cells.chiefEngineer)).toBe(false)
  expect(changedCell(cells.workName)).toBe(false)
})

describe("直す行と顧客に聞く行", () => {
  const k = (cells: Record<string, string>, key: number) => kojiRow(cells, key)
  const view = finalizeAll([k({ workName: "倉庫改修工事", client: "株式会社テスト" }, 1), k({ workName: "倉庫改修工事", client: "株式会社テスト", prefecture: "", place: "" }, 2)], { replacements: {}, edits: new Map() }).rows

  test("問い合わせに回るセル（書類に要るのにデータに無い）は顧客に聞く（直さなくてよい）。問い合わせを外すと、空のままで片付く", () => {
    const asked = rowFix(view[1]!, () => true)
    expect(asked.ask).toEqual(expect.arrayContaining(["prefecture", "place"]))
    expect(asked.fixes.filter((f) => f.field === "prefecture" || f.field === "place")).toEqual([])
    const dismissed = rowFix(view[1]!, () => false)
    expect(dismissed.ask).toEqual([])
  })
  test("値のあるエラーは顧客に聞いても CSV に載らないので職員が直す。空の必須は問い合わせを外すと「必須が空」", () => {
    expect(cellFix({ ...ok, status: "error", value: "abc" }, "workName", true)).toBe("error")
    expect(cellFix({ ...ok, status: "error", value: "" }, "workName", true)).toBe("ask")
    expect(cellFix({ ...ok, status: "error", value: "" }, "workName", false)).toBe("empty")
    expect(cellFix({ ...ok, status: "error", value: "" }, "gyoshu", true)).toBe("empty")
    expect(cellFix({ ...ok, guessed: true }, "gyoshu", true)).toBe("guess")
    expect(cellFix({ ...ok, status: "warning", message: "x" }, "gyoshu", true)).toBe("review")
    expect(cellFix(ok, "gyoshu", true)).toBeUndefined()
  })
  test("AI の推定は、AI が自信がないと答えた値と AI が補った値", () => {
    expect(cellFix({ ...ok, guessed: true }, "a", true)).toBe("guess")
    expect(cellFix({ ...ok, status: "ai", message: "補った" }, "a", true)).toBe("guess")
    expect(cellFix({ ...ok, status: "ai" }, "a", true)).toBeUndefined()
  })
  test("値のある推定のエラーは、直すにだけ数え、問い合わせには入れない（1つのセルは片方だけ）", () => {
    const c = { ...ok, status: "error" as const, value: "東京", guessed: true as const }
    expect(cellFix(c, "prefecture", true)).toBe("error")
    expect(askReasonOf("prefecture", c)).toBeUndefined()
  })
  test("直す行は、エラー・要確認・AI の推定のどれかがある行（項目 a・b は問い合わせに回らない）", () => {
    expect(checked).toEqual(["error", "warning", "aiFilled", "guessedFill", "ruleThenWarning", "staffError"])
  })
})

describe("直し方", () => {
  test("理由ごとの直し方は1か所の表で、行ける先と同じ判定: 業種は一覧で決める、調べる行は工事場所、問い合わせに載るセルは顧客に聞く。ほかはセルで直す", () => {
    const blank = kojiRow({}).cells
    const of = (field: string) => fixActionOf(field, blank)
    expect(["gyoshu", "prefecture", "place", "client", "workName", "startYm", "endYm", "engineer", "motoukeShitauke", "amount", "jv"].map(of)).toEqual([
      "decideGyoshu", "findLocation", "findLocation", "askCustomer", "askCustomer", "askCustomer", "askCustomer", "askCustomer", undefined, undefined, undefined,
    ])
    // 問い合わせに載らないセル（値のあるエラー・職員が空にした欄）には「顧客に聞く」を出さない
    const err = { ...blank, endYm: { value: "2023", status: "error" as const, source: "", original: "2023", message: "年月として読めません" } }
    expect(fixActionOf("endYm", err)).toBeUndefined()
    const staffEmptied = { ...blank, client: { value: "", status: "changed" as const, source: "手入力", original: "", by: "staff" as const } }
    expect(fixActionOf("client", staffEmptied)).toBeUndefined()
    // 職員が決めた工事場所は調べないので、工事場所の操作も出さない
    const decided = { ...blank, prefecture: { value: "", status: "error" as const, source: "手入力", original: "", by: "staff" as const } }
    expect(fixActionOf("prefecture", decided)).toBeUndefined()
  })

  test("まとめて頼む操作は、載せる行の同じ直し方を1つにまとめ、表・次にやること・書き出すの確認で同じ言葉にする", () => {
    const empty = kojiRow({ gyoshu: "" }, 1)
    const guessed = { ...kojiRow({}, 2), cells: { ...kojiRow({}, 2).cells, gyoshu: { value: "8", status: "warning" as const, source: "AI", original: "電工", guessed: true as const } } }
    const notIncluded = kojiRow({ gyoshu: "" }, 3)
    const noPlace = kojiRow({ gyoshu: "8", prefecture: "", place: "" }, 4)
    const shown = finalizeAll([empty, guessed, notIncluded, noPlace])
    const fixes = new Map(shown.rows.map((r) => [r.key, rowFix(r, () => false)]))
    const inclusion = new Map(shown.rows.map((r) => [r.key, { included: r.key !== notIncluded.key }]))
    const groups = fixActionGroups(shown.rows, inclusion, fixes)
    // 業種は直すに入れず、業種のタブでまとめて決める（直すと「業種を決める」で二重に数えない）
    expect(groups.some((g) => g.action === "decideGyoshu")).toBe(false)
    expect(fixes.get(empty.key)!.gyoshu).toBe("empty")
    expect(fixes.get(guessed.key)!.gyoshu).toBe("guess")
    expect(fixes.get(empty.key)!.fixes.some((f) => f.field === "gyoshu")).toBe(false)
    expect(fixes.get(guessed.key)!.fixes.some((f) => f.field === "gyoshu")).toBe(false)
    expect(fixActionText(groups.find((g) => g.action === "findLocation")!)).toContain("に AI で案を出す")
    // 都道府県と場所名は1つの現場として1つにまとめる
    expect(groups.filter((g) => g.action === "findLocation").map((g) => g.keys.includes(noPlace.key))).toEqual([true])
    expect(fixText({ field: "gyoshu", kind: "empty" })).toBe("業種が空")
  })
})

describe("業種を先に決める", () => {
  test("業種を決める行は、業種が決まっていない行のうち7割で載りうる行（載せる行と選ばれていない行）。除外・手動で外した行と業種の決まった行は入れない", () => {
    const shown = finalizeAll([kojiRow({ gyoshu: "" }, 1), kojiRow({ gyoshu: "" }, 2), kojiRow({ gyoshu: "" }, 3), kojiRow({ gyoshu: "" }, 4), kojiRow({ gyoshu: "8" }, 5)])
    const [inc, unselected, excluded, manualOut, decided] = shown.rows.map((r) => r.key)
    const inclusion = new Map<string, Inclusion>([
      [inc!, { included: true, reason: "rule7" }],
      [unselected!, { included: false, reason: "unselected" }],
      [excluded!, { included: false, reason: "excluded" }],
      [manualOut!, { included: false, reason: "manual" }],
      [decided!, { included: true, reason: "rule7" }],
    ])
    const fixes = new Map(shown.rows.map((r) => [r.key, rowFix(r, () => true)]))
    expect(gyoshuTodo(shown.rows, inclusion, fixes).map((r) => r.key)).toEqual([inc, unselected])
  })

  test("「これでよい」は要確認・AI の推定の値があり、手で入れても検査の警告が残らないときだけ", () => {
    const base = kojiRow({}).cells
    const guess = { ...base, workName: { value: "倉庫改修工事", status: "ai" as const, source: "AI", original: "倉庫", guessed: true as const, message: "補った" } }
    expect(rowFix({ ...kojiRow({}), cells: guess }, () => false).fixes.find((f) => f.field === "workName")).toEqual({ field: "workName", kind: "guess", action: "askCustomer", confirm: true })
    // 姓と名の間の空白の警告は手で同じ値を入れても残るので、「これでよい」を出さない
    const name = { ...base, engineer: { value: "見本花子", status: "warning" as const, source: "A列", original: "見本花子", message: "姓と名の間に全角スペースを1つ入れてください" } }
    expect(rowFix({ ...kojiRow({}), cells: name }, () => false).fixes.find((f) => f.field === "engineer")?.confirm).toBeUndefined()
    // 空のエラーは「これでよい」で片付かない
    const empty = { ...base, gyoshu: { value: "", status: "error" as const, source: "", original: "" } }
    expect(rowFix({ ...kojiRow({}), cells: empty }, () => true).fixes.find((f) => f.field === "gyoshu")?.confirm).toBeUndefined()
  })

  test("顧客に聞く印は、どの欄を聞くのかを書く", () => {
    expect(askText(["engineer"])).toBe("配置技術者は顧客に聞く")
    expect(askText(["client", "endYm"])).toBe("注文者・完成年月は顧客に聞く")
  })
})

test("「これでよい」の手直し（印の入った本当の値）は、手直しのあとの検査（記号にした画面の値）でも片付く", () => {
  const raw = kojiRow({ workName: `${personToken("見本花子")}邸新築工事` }, 1)
  const guessed = { ...raw, cells: { ...raw.cells, workName: { ...raw.cells.workName, status: "ai" as const, guessed: true as const, message: "推定" } } }
  const [shown] = finalizeAll([guessed]).rows
  const letters = finalizeAll([guessed]).letters
  expect(shown!.cells.workName.value).toBe("Ａ邸新築工事")
  expect(rowFix(shown!, () => false).fixes.find((f) => f.field === "workName")?.confirm).toBe(true)
  const session = editSession(shown!.cells.workName, letters)
  const [after] = finalizeAll([guessed], { edits: new Map([[editKey(raw.key, "workName"), session.read(session.text)]]) }).rows
  expect(after!.cells.workName.value).toBe("Ａ邸新築工事")
  expect(rowFix(after!, () => false).fixes.find((f) => f.field === "workName")).toBeUndefined()
})

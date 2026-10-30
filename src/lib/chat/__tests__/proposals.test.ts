import { describe, expect, test } from "bun:test"
import { kojiRow } from "../../convert/__tests__/helpers"
import { personToken } from "../../convert/persons"
import { fromSaved, MAX_STATE_BYTES, newWork, savedWorkSchema, toSavedWork } from "../../cases/state"
import { deriveTable } from "../../cases/view"
import { collectInquiries } from "../../inquiry/inquiry"
import { addedCountAfter, answer, applyChanges, decide, decisionOf, discard, newProposal, proposalRecordSchema, withRecorded, type ChatChange } from "../proposals"
import { MAX_ADDED_ROWS } from "../../cases/added"

const yamada = personToken("山田太郎")
const rows = [
  kojiRow({ gyoshu: "8", motoukeShitauke: "1", client: "株式会社テスト", workName: "テストビル電気工事", prefecture: "東京都", place: "千代田区", amount: "5000", engineer: "試験　太郎", startYm: "202404", endYm: "202409" }, 1),
  kojiRow({ gyoshu: "8", motoukeShitauke: "1", client: yamada, workName: `${yamada}邸新築工事`, prefecture: "東京都", place: "港区", amount: "3000", engineer: "試験　太郎", startYm: "202404", endYm: "202409" }, 2),
]
const table = { rows, added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded" as const, basis: {}, selection: "all" as const, sorted: false }

describe("変更案を表に重ねる", () => {
  test("セル・問い合わせ・入れ外し・7割の設定を、手直し・手動の入れ外し・設定として重ねる（ルールの追記は表を変えない）", () => {
    const changes: ChatChange[] = [
      { kind: "cell", rowKey: "s!1", field: "client", edit: { value: "㈱テスト", by: "chat" } },
      { kind: "ask", rowKey: "s!1", field: "place", reason: "現場の市区町村が元データと違う" },
      { kind: "include", rowKey: "s!2", include: false },
      { kind: "settings", tax: "included", basis: { "8": { total: 9000 } } },
      { kind: "rule", scope: "customer", text: "注文者の株式会社は㈱にする" },
    ]
    const next = applyChanges(table, deriveTable(table).edited, changes)
    const view = deriveTable(next)
    expect(view.shown[0]!.cells.client).toMatchObject({ value: "㈱テスト", source: "チャット（承認）" })
    expect(view.shown[0]!.cells.place).toMatchObject({ value: "千代田区", guessed: true, message: expect.stringContaining("顧客に確認: 現場の市区町村が元データと違う") })
    expect(view.output.map((r) => r.key)).toEqual(["s!1"])
    expect([next.tax, next.basis]).toEqual(["included", { "8": { total: 9000 } }])
    expect(collectInquiries(view.output, { tax: "included" }).flatMap((q) => (q.kind === "cell" ? [`${q.field}:${q.reason}`] : []))).toEqual(["place:needsReview"])
  })

  test("空のセルを顧客に聞く変更案は「データに無い」で聞く（推定ではない）。値のあるセルは「推定に自信がない」で聞く", () => {
    const empty = { ...table, rows: [kojiRow({ ...Object.fromEntries(Object.entries(rows[0]!.cells).map(([f, c]) => [f, c.value])), engineer: "" }, 1), rows[1]!] }
    const next = applyChanges(empty, deriveTable(empty).edited, [
      { kind: "ask", rowKey: "s!1", field: "engineer", reason: "配置技術者がいない" },
      { kind: "ask", rowKey: "s!2", field: "place", reason: "港区で正しいか" },
    ])
    const view = deriveTable(next)
    expect(view.shown.find((r) => r.key === "s!1")!.cells.engineer.guessed).toBeUndefined()
    const asked = collectInquiries(view.output, { tax: "included" }).flatMap((q) => (q.kind === "cell" ? [`${q.rowKey}:${q.field}:${q.reason}`] : []))
    expect(asked).toEqual(expect.arrayContaining(["s!1:engineer:missing", "s!2:place:needsReview"]))
  })

  test("基準額は業種ごと・項目ごとに重ねる（元請だけ変えても合計は残す）", () => {
    const withBasis = { ...table, basis: { "8": { total: 9000, motouke: 7000 }, "9": { total: 100 } } }
    const next = applyChanges(withBasis, deriveTable(withBasis).edited, [{ kind: "settings", basis: { "8": { motouke: 6000 } } }])
    expect(next.basis).toEqual({ "8": { total: 9000, motouke: 6000 }, "9": { total: 100 } })
  })

  test("個人名は印のまま持つので、承認する前に記号が付け直されても同じ人になる", () => {
    const edit = { value: `${yamada}様邸新築工事`, by: "chat" as const }
    const reordered = { ...table, manual: new Map([["s!1", false]]) }
    const next = applyChanges(reordered, deriveTable(reordered).edited, [{ kind: "cell", rowKey: "s!2", field: "workName", edit }])
    expect(deriveTable(next).output[0]!.cells.workName.value).toBe("Ａ様邸新築工事")
  })
})

describe("承認と聞き返し", () => {
  const changes: ChatChange[] = [
    { kind: "include", rowKey: "s!1", include: false },
    { kind: "include", rowKey: "s!2", include: false },
  ]

  test("項目ごとに承認・却下し、未決が無くなったら件数だけを残して閉じる", () => {
    const p = newProposal("p1", { kind: "chat", messageId: "m1" }, changes, null)
    const one = decide(p, [0], "applied")
    expect(one.state === "open" && [decisionOf(one, 0), decisionOf(one, 1)]).toEqual(["applied", "pending"])
    expect(decide(one, [1], "rejected")).toEqual({ id: "p1", origin: { kind: "chat", messageId: "m1" }, question: null, state: "closed", applied: 1, rejected: 1 })
  })

  test("聞き返しに答えるまで承認できない。「いいえ」なら全部を却下する", () => {
    const p = newProposal("p2", { kind: "chat", messageId: "m2" }, changes, "工事名の「(仮称)」も取ってよいですか")
    expect(decide(p, [0, 1], "applied")).toBe(p)
    const yes = answer(p, "yes")
    expect(decide(yes, [0, 1], "applied")).toMatchObject({ state: "closed", applied: 2, rejected: 0 })
    expect(answer(p, "no")).toMatchObject({ state: "closed", applied: 0, rejected: 2, question: { answer: "no" } })
  })

  test("変更案の無い聞き返しは、答えたら閉じる（未決として残らない）", () => {
    const only = newProposal("p4", { kind: "chat", messageId: "m4" }, [], "どちらにしますか")
    expect(answer(only, "yes")).toMatchObject({ state: "closed", applied: 0, rejected: 0, question: { answer: "yes" } })
    expect(answer(only, "no")).toMatchObject({ state: "closed", applied: 0, rejected: 0, question: { answer: "no" } })
  })

  test("案件の作業に保存して読み戻せる", () => {
    const open = newProposal("p3", { kind: "excel", fileId: "f1" }, [{ kind: "cell", rowKey: "s!2", field: "client", edit: { value: yamada, by: "chat" } }], null)
    const work = { ...newWork(), proposals: [open, decide(open, [0], "rejected")] }
    const saved = savedWorkSchema.parse(JSON.parse(JSON.stringify(toSavedWork(work))))
    expect(fromSaved(saved, []).proposals).toEqual(work.proposals)
    const { proposals: _, ...older } = toSavedWork(newWork())
    expect(savedWorkSchema.parse(older).proposals).toEqual([])
  })

  test("大きな変更案でも、案件の作業に入るのは件数と決めた番号だけ（中身は別に置く）なので、作業は保存の上限に近づかない", () => {
    const many: ChatChange[] = Array.from({ length: 50_000 }, (_, i) => ({ kind: "cell", rowKey: `s!${i}`, field: "workName", edit: { value: "工".repeat(50), by: "chat" } }))
    const open = decide(newProposal("big", { kind: "chat", messageId: "m" }, many, null), [3, 7], "applied")
    const bytes = new TextEncoder().encode(JSON.stringify(toSavedWork({ ...newWork(), proposals: [open, newProposal("big2", { kind: "chat", messageId: "m2" }, many, null)] }))).byteLength
    expect(bytes).toBeLessThan(2_000)
    expect(bytes).toBeLessThan(MAX_STATE_BYTES)
    expect(decide(open, Array.from({ length: 50_000 }, (_, i) => i), "rejected")).toMatchObject({ state: "closed", applied: 2, rejected: 49_998 })
  })
})

describe("サーバーが記録した変更案", () => {
  const changes: ChatChange[] = [{ kind: "include", rowKey: "s!1", include: false }, { kind: "include", rowKey: "s!2", include: false }]
  const p1 = newProposal("r1", { kind: "chat", messageId: "m1" }, changes, null)
  const p2 = newProposal("r2", { kind: "chat", messageId: "m2" }, changes, null)

  test("画面が受け取り損ねた変更案は足し、作業にあるものは作業の状態のまま", () => {
    const decided = decide(p1, [0], "applied")
    expect(withRecorded([decided], [{ proposal: p1, changes }, { proposal: p2, changes }])).toEqual([decided, p2])
  })

  test("変換の元を変えたら開いている変更案は閉じる（未決は却下）。閉じたものはそのまま", () => {
    expect(discard(decide(p1, [0], "applied"))).toMatchObject({ state: "closed", applied: 1, rejected: 1 })
    const closed = decide(p2, [0, 1], "rejected")
    expect(discard(closed)).toBe(closed)
  })
})

describe("工事を足す変更案の記録", () => {
  const record = (rowKey: string) => ({ proposal: newProposal("p", { kind: "excel", fileId: "f" }, [{ kind: "add", rowKey, by: "excel", cells: {} }], null), changes: [{ kind: "add", rowKey, by: "excel", cells: {} }] })
  test("足す行の key は add- で始まるものだけを読む（今の行の key を足す行として読まない）", () => {
    expect(proposalRecordSchema.safeParse(record("add-1")).success).toBe(true)
    expect(proposalRecordSchema.safeParse(record("s!1")).success).toBe(false)
  })
})

describe("足した行の上限", () => {
  test("承認したあとの足した行の数（同じ key は1回）。上限を超えるかを承認の前に確かめる", () => {
    const add = (rowKey: string): ChatChange => ({ kind: "add", rowKey, by: "excel", cells: {} })
    expect(addedCountAfter([{ key: "add-1", by: "excel" }], [add("add-1"), add("add-2"), add("add-2")])).toBe(2)
    expect(MAX_ADDED_ROWS).toBe(5_000)
  })
})

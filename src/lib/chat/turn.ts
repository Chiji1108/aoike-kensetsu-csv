import { createAnthropic, forwardAnthropicContainerIdFromLastStep } from "@ai-sdk/anthropic"
import { isStepCount, streamText, tool, type LanguageModelUsage, type ModelMessage } from "ai"
import { z } from "zod"
import { MAX_ADDED_ROWS, newAddedKey } from "../cases/added"
import { baseRows, deriveTable, type CaseTable, type TableView } from "../cases/view"
import { MAX_ITEMS_PER_REQUEST, parseAiResponse, type AiBatchRequest } from "../convert/ai-tasks"
import { editText, staffEdit, type CellEdit } from "../convert/convert"
import { withNames, type PersonLetters } from "../convert/persons"
import { getTransform, transformsFor, type TransformId } from "../convert/transforms"
import type { MappingPlan } from "../convert/plan"
import { applyPlanPatch, beforeOf, describePlanPatch, patchFromInput, planPatchInputSchema, type PlanPatchInput, type SheetShape } from "../convert/plan-patch"
import { CODE_SETS } from "../spec/code-sets"
import type { Basis, SelectionMode, TaxMode } from "../convert/koji-selection"
import { basisSchema, fieldIdSchema, selectionSchema, taxSchema } from "../schemas"
import { KOJI_ANONYMIZE, KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import { applyChanges, type ChatChange } from "./proposals"
import { charCount, MAX_RULE_ITEM_LENGTH, RULE7_TAX_LABELS, ruleScopeSchema, type Rule7Tax, type RuleScope } from "./rules"
import { CHAT_ACTIONS, type ChatAction } from "./messages"
import { outcomeChanges } from "../location/changes"
import { askReason, estimateUsd, MAX_SITES_PER_RUN, runSitesOf, siteOfRow, SOURCE_LABELS, type Outcome, type Site } from "../location/sites"

/**
 * チャットの1回の指示。AI はコード実行（Anthropic のコンテナ）で元のファイルと今の表を読み、表の変更はコードから呼ぶ道具
 * （programmatic tool calling）で送る。変更はすぐ表に入れず、変更案（pending）に溜めて職員の承認を待つ
 */

export const MODEL = "claude-opus-5-5"
/** 1回の指示で道具（コード実行を除く）を呼べる回数 */
export const MAX_TOOL_CALLS = 20
/** 1回の指示の往復の上限（安全装置。道具の回数の上限で先に止まる） */
const MAX_STEPS = 40
/** 1回の propose_rule で出せる項目の数 */
const MAX_RULE_PROPOSALS = 10

const FIELD_IDS = fieldIdSchema.options
/**
 * 道具の引数は strictObject にする（知らない引数を黙って捨てない。前の形の引数〔set_selection の already_applied など〕を履歴からまねたときに、
 * 空の変更案にせず形の誤りとして AI に返す）
 */
/** コードからだけ呼ぶ道具 */
const FROM_CODE = { anthropic: { allowedCallers: ["code_execution_20260120" as const] } }

/** global・customer は箇条書きにしたルールの文章（lib/chat/rules.ts の rulesText）、rule7Tax は事務所の7割の計算（税抜・税込） */
export type ChatRules = { global: string; customerName: string; customer: string; rule7Tax: Rule7Tax }
/** コンテナに置いたファイル（name はコンテナの中の名前） */
export type ContainerFile = { name: string; original: string; isSource: boolean }

function fieldsDoc() {
  return KOJI_KEIREKI.fields
    .map((f) => {
      const vt = f.valueType
      const type = vt.type === "code" ? CODE_SETS[vt.set].map((c) => `${c.code}=${c.label}`).join(" ") : vt.type
      return `- ${f.id}（${f.letter}列 ${f.label}${f.required ? "・必須" : ""}）: ${type}。${f.description}`
    })
    .join("\n")
}

/** caseRule7Tax はこの案件の7割の計算（事務所の設定と違えば「この案件」に書く） */
export function systemPrompt(rules: ChatRules, caseContext: string, files: readonly ContainerFile[], caseRule7Tax: Rule7Tax = rules.rule7Tax) {
  const caseRule7 = caseRule7Tax === rules.rule7Tax ? "" : `- この案件の7割の計算は${RULE7_TAX_LABELS[caseRule7Tax]}（決算書の完成工事高＝基準額も${RULE7_TAX_LABELS[caseRule7Tax]}）。\n`
  const fileLines = files.map((f) => `- $INPUT_DIR/${f.name}: ${f.original}${f.isSource ? "（変換の元）" : ""}`).join("\n")
  return `あなたは行政書士事務所の職員と一緒に、顧客から受け取った工事経歴の Excel を、建設業.NET に取り込む工事経歴書CSV（14列）にする。
職員はチャットで指示する。表は画面に常に見えていて、あなたの変更は変更案として職員に見せ、職員が承認したものだけが表に入る。

## 進め方
- 案件のファイルはコード実行のコンテナにある（pandas・openpyxl で読める。日付はシリアル値のことがある）:
${fileLines || "（なし）"}
- 今の表は、事務所の変換（列の対応＋決まった変換＋AI の整形）で作ったもの。コードから await get_table({}) で読む（JSON 文字列。行は key・source・included・cells・issues を持つ）。
- 表を直すのは必ずコードから: await set_cells({"changes":[{"key","field","value"}]})、await set_include({"rows":[{"key","include"}]})、await ask_customer({"items":[{"key","field","reason"}]})。
- 元のファイルの表に無い工事は await add_rows({"rows":[{"cells":{"field":"value"}}]}) で足す（変換の元の表が無い PDF だけの案件は、これで一から表を作る）。足した行はすべて要確認になる。返る keys で、続けて set_cells などに使える。
- 変換の元のほかのファイル（技術者の一覧・別の年の表など）も読んで使ってよい（例: 技術者の一覧から配置技術者を埋める）。
- 個人名は表では「〔Ａ〕」「〔未掲載１〕」の形の記号で出る。値に個人名を入れるときはこの形のまま書く（例:「〔Ａ〕邸新築工事」）。個人名をそのまま書かない。
- 注文者・工事名に書いた値は、事務所の変換と同じ匿名化で確かめる（個人名は記号にする）。確かめられない値は受け取られない。
- 7割の設定（税込/税抜・基準額・載せる工事の選び方＝7割ルールか全件か）は set_selection を直接呼ぶ。
- 列の対応（どの列からどの項目を作るか・見出しの行・データの開始・飛ばす行・金額の単位）を変えるときは set_plan を直接呼ぶ（例:「金額は税込の列で」「工事名は B 列と C 列をつなげて」）。全行に同じ直しをセルの変更で当てるより、列の対応で直せるものは set_plan にする。承認すると変換し直す（この指示の get_table の表は変わらない）。使うシートは変えられないので、変えたいときは職員に画面のファイルの欄で選び直してもらう。職員にどの列を使っているか聞かれたら「この案件」の列の対応で答える。
- 職員が CSV・取り込み用の Excel を出したい、問い合わせの Excel・編集用の Excel が欲しいと言ったら offer_action でボタンを出す（書き出す前の確認は画面が出す。あなたはファイルを作らない）。
- 直したら await check_table({}) で決まった検査（エラー・警告・字数の上限・個人名らしい値・7割）を確かめ、直せるものは直す。
- 分からないこと・データに無いこと（配置技術者・分からない工事場所など）は推測で埋めず、ask_customer で顧客への問い合わせに回す。住所の分割・工事名の補い・調べられる工事場所は問い合わせに回さず事務所でやる。
- 指示があいまいで、どちらにも取れるときや、決める前に職員の答えが要るときは、ask_staff で聞き返す（答えるまで変更案は反映されない）。
- 職員が「顧客ルールに追加して」「全体ルールに追加して」と言ったら propose_rule で足す項目の案を出す（1つの決まりを1項目に。今のルールと同じ項目は出さない。保存は職員の承認後）。
- 工事場所（都道府県・場所名）を調べるときは find_location を直接呼ぶ（コードからは呼ばない）。「この現場ってどこ？」のように1件なら key を渡す。「場所が空いている行を調べて」のようにまとめてなら key を省き、返った件数と費用の目安を職員に伝える（一括の検索は職員が画面のボタンで始める）。自分で Web の知識から場所を書き込まない。
- CSV は書かない（CSV の形式・7割の計算・字数・個人名の検査は決まった処理がやる）。
- 最後に、何を何件変えたか、残った問題、職員に確かめたいことを短い日本語で返す。コードや JSON は返事に貼らない。
- 道具を呼べるのは1回の指示で${MAX_TOOL_CALLS}回まで（コード実行は数えない）。表は get_table でまとめて読み、変更はまとめて送る。

## 14列
${fieldsDoc()}

## 公式の記載ルール
${KOJI_KEIREKI.writingRules.map((r) => `- ${r}`).join("\n")}

## 全体ルール（事務所のやり方）
${[`- 事務所の7割の計算は${RULE7_TAX_LABELS[rules.rule7Tax]}。`, rules.global].filter(Boolean).join("\n")}

## 顧客ルール（${rules.customerName}）
${rules.customer || "（なし）"}

## この案件
${caseRule7}${caseContext}`
}

export type TurnLog = { tool: string; summary: string }

/** 1回の指示で「この現場ってどこ？」を調べてよい現場の数（1件の検索は数十秒・数セントかかる。まとめて調べるのは一括調査） */
export const MAX_LOOKUPS_PER_TURN = 3

/**
 * 工事場所を調べる道具（server/location-run.ts の locateOne と、顧客の覚えた結果）。spent に費用を足す。
 * 無ければ（API キーが無い・照合スクリプト）道具は「使えない」と返す
 */
export type LocationCaller = {
  locate: (site: Site, spent: { usd: number; searches: number }) => Promise<Outcome>
  memorized: (keys: string[]) => Promise<ReadonlySet<string>>
  /** サーバーでの個人名の確かめ（server/location-guard.ts）。個人名を含む現場は調べない現場にして返す */
  guard: (sites: Site[]) => Promise<Site[]>
}

/** 一括調査を始めるボタンを職員に見せる（返事の部品 data-location-offer。検索は職員が押してから） */
export type LocationOffer = { sites: number; memorized: number; usd: number }

/** 1回の指示の間の状態。letters は指示を受けたときの記号の表で、指示の間は変えない（AI に見せた「〔Ａ〕」が途中で別の人にならない） */
export type TurnState = {
  start: CaseTable
  current: CaseTable
  letters: PersonLetters
  pending: ChatChange[]
  question: string | null
  log: TurnLog[]
  toolCalls: number
  /** 注文者・工事名の匿名化に呼ぶ AI（変換の値の判断と同じ。無ければ、個人名かもしれない値は受け取らない） */
  anonymize?: AnonymizeCaller
  /** 匿名化の AI の費用 */
  anonymizeUsd: number
  location?: LocationCaller
  /** 工事場所を調べた費用・回数 */
  locationSpent: { usd: number; searches: number }
  lookups: number
  locationOffer: LocationOffer | null
  /** 今の列の対応と計画の元のシートの大きさ（set_plan の確かめ。変換の元の表が無い案件は null）。set_plan のたびに重ねた計画にする */
  plan: { plan: MappingPlan<KojiFieldId>; shape: SheetShape } | null
  /** 返事に付けるボタン（offer_action） */
  actions: ChatAction[]
}


/** 値の判断の AI（server/claude.ts の batchWithClaude と同じ形。usd はその呼び出しの費用） */
export type AnonymizeCaller = (req: AiBatchRequest) => Promise<({ ok: true; json: unknown } | { ok: false; message: string }) & { usd: number }>

export function newTurnState(table: CaseTable, anonymize?: AnonymizeCaller, location?: LocationCaller, plan: TurnState["plan"] = null): TurnState {
  return {
    start: table,
    current: table,
    letters: deriveTable(table).letters,
    pending: [],
    question: null,
    log: [],
    toolCalls: 0,
    anonymize,
    anonymizeUsd: 0,
    location,
    locationSpent: { usd: 0, searches: 0 },
    lookups: 0,
    locationOffer: null,
    plan,
    actions: [],
  }
}

/** set_plan に書ける変換（項目ごと） */
function planToolDoc() {
  return KOJI_KEIREKI.fields.map((f) => `${f.id}: ${transformsFor(f.valueType).map((t) => t.id).join(", ")}`).join("\n")
}

type CellChange = { key: string; field: KojiFieldId; edit: CellEdit }

/**
 * AI が注文者・工事名に書いた値を、変換と同じ匿名化に通す（個人名を CSV に出さない決まりは柔軟さと引き換えにしない）。
 * 今の値と同じ（記号の人のまま）値と、変換の見分け方で個人名を含まないと決まる値はそのまま。それ以外は匿名化の AI に聞いて検算し、
 * 印にした値にする。検算に落ちた・AI を使えなかった値は受け取らない（refused）
 */
async function anonymizeChanges(state: TurnState, edited: TableView["edited"], changes: readonly CellChange[]) {
  const rowOf = new Map(edited.map((r) => [r.key, r]))
  const out = [...changes]
  const refused: { key: string; field: KojiFieldId; message: string }[] = []
  const asks = new Map<TransformId, { index: number; input: string }[]>()
  changes.forEach((c, index) => {
    const rule = KOJI_ANONYMIZE[c.field]
    if (!rule) return
    const text = withNames(c.edit.value, (name) => name)
    const now = rowOf.get(c.key)?.cells[c.field].value
    if ((now !== undefined && withNames(now, (name) => name) === text) || !rule.mayHavePersons(text)) return
    const input = getTransform(rule.transform).ai!.input?.([text]) ?? text
    asks.set(rule.transform, [...(asks.get(rule.transform) ?? []), { index, input }])
  })
  for (const [transform, items] of asks) {
    const step = getTransform(transform).ai!
    for (let i = 0; i < items.length; i += MAX_ITEMS_PER_REQUEST) {
      const chunk = items.slice(i, i + MAX_ITEMS_PER_REQUEST)
      const request: AiBatchRequest = { task: step.task, items: chunk.map((it, id) => ({ id, input: it.input })) }
      const res = state.anonymize ? await state.anonymize(request) : { ok: false as const, message: "個人名の判定に使う AI がありません", usd: 0 }
      state.anonymizeUsd += res.usd
      const parsed = res.ok ? parseAiResponse(step.task, request, res.json) : res
      chunk.forEach((it, id) => {
        const c = changes[it.index]!
        const result = parsed.ok ? parsed.results.get(id) : undefined
        const applied = result && step.apply(it.input, result)
        if (!applied || applied.withheld) {
          refused.push({ key: c.key, field: c.field, message: applied?.message ?? `個人名の判定ができませんでした（${parsed.ok ? "AI の結果がありません" : parsed.message}）` })
          return
        }
        const { value, status, message, guessed } = applied
        out[it.index] = { ...c, edit: { value, by: "chat", status, byAi: true, ...(message ? { message } : {}), ...(guessed ? { guessed } : {}) } }
      })
    }
  }
  return { changes: out, refused }
}

const json = (v: unknown) => JSON.stringify(v)

/** AI が足した行のセルに添える（PDF などから作った値なので、全部を要確認にする） */
export const AI_ADDED_NOTE = "AI がファイルから作った行です。元のファイルと照らして確かめてください"


/** AI のコードに渡す表（画面の順）。issues は検証のエラー・警告 */
export function tableForAi(view: TableView, letters: PersonLetters, onlyIncluded = false) {
  return view.shown
    .filter((r) => !onlyIncluded || view.inclusion.get(r.key)?.included)
    .map((r) => {
      const inc = view.inclusion.get(r.key)!
      const issues: Partial<Record<KojiFieldId, string>> = {}
      for (const f of FIELD_IDS) {
        const c = r.cells[f]
        if ((c.status === "error" || c.status === "warning") && c.message) issues[f] = `${c.status}: ${c.message}`
      }
      return {
        key: r.key,
        source: `${r.sheet}!${r.row + 1}行`,
        included: inc.included,
        why: inc.reason,
        ...(r.excluded ? { excluded: r.excluded } : {}),
        cells: Object.fromEntries(FIELD_IDS.map((f) => [f, editText(r.cells[f], letters)])),
        ...(Object.keys(issues).length ? { issues } : {}),
      }
    })
}

/** 決まった処理の検査（CSV に載せる行が対象） */
export function checkReport(view: TableView, letters: PersonLetters) {
  const counts = { error: 0, warning: 0 }
  const byIssue = new Map<string, number>()
  const errors: { key: string; field: KojiFieldId; value: string; message: string }[] = []
  for (const r of view.output) {
    for (const f of FIELD_IDS) {
      const c = r.cells[f]
      if (c.status !== "error" && c.status !== "warning") continue
      counts[c.status]++
      const k = `${f}: ${c.status}: ${(c.message ?? "").split(" / ").at(-1)}`
      byIssue.set(k, (byIssue.get(k) ?? 0) + 1)
      if (c.status === "error" && errors.length < 50) errors.push({ key: r.key, field: f, value: editText(c, letters), message: c.message ?? "" })
    }
  }
  return {
    includedRows: view.output.length,
    allRows: view.shown.length,
    errors: counts.error,
    warnings: counts.warning,
    issues: Object.fromEntries([...byIssue].sort((a, b) => b[1] - a[1]).slice(0, 30)),
    firstErrors: errors,
  }
}

/** 道具の定義。execute は TurnState に変更案を溜める（表には入れない） */
export function chatTools(state: TurnState) {
  /** 表は変更案を足したときだけ作り直す（行の多い表では作り直しに時間がかかるので、道具のたびには作らない） */
  let cached: { table: CaseTable; view: TableView } | null = null
  const view = () => {
    if (cached?.table !== state.current) cached = { table: state.current, view: deriveTable(state.current) }
    return cached.view
  }
  const keys = () => new Set(baseRows(state.current).map((r) => r.key))
  /** 指示を受けたときの表（画面とサーバーが工事場所の調査で数える表と同じ） */
  let started: TableView | null = null
  const startView = () => (started ??= deriveTable(state.start))
  /** 回数の上限を数える。超えたら道具を動かさず、ここまでで返すよう伝える */
  const counted =
    <A,>(run: (args: A) => string | Promise<string>) =>
    async (args: A) => {
      if (++state.toolCalls > MAX_TOOL_CALLS)
        return json({ ok: false, error: `この指示で道具を呼べる回数（${MAX_TOOL_CALLS}回）を使い切りました。ここまでの変更案と残りを職員に返してください。` })
      return run(args)
    }
  const push = (tool: string, changes: ChatChange[], summary: string, extra: object = {}) => {
    state.pending.push(...changes)
    state.current = applyChanges(state.current, view().edited, changes)
    state.log.push({ tool, summary })
    return json({ ok: true, applied: changes.length, ...extra, report: checkReport(view(), state.letters) })
  }

  return {
    get_table: tool({
      description:
        "今の表（この指示で出した変更案を重ねたもの）を JSON 文字列で返す: [{key, source, included, why, excluded?, cells:{field:value}, issues?:{field:message}}]。only_included=true なら CSV に載せる行だけ。",
      inputSchema: z.strictObject({ only_included: z.boolean().optional() }),
      execute: counted<{ only_included?: boolean }>(({ only_included }) => {
        state.log.push({ tool: "get_table", summary: only_included ? "載せる行" : "全行" })
        return json(tableForAi(view(), state.letters, only_included))
      }),
      providerOptions: FROM_CODE,
    }),
    check_table: tool({
      description: "決まった処理の検査の結果を JSON 文字列で返す: {includedRows, allRows, errors, warnings, issues:{'field: 内容': 件数}, firstErrors:[{key, field, value, message}]}",
      inputSchema: z.strictObject({}),
      execute: counted<object>(() => {
        state.log.push({ tool: "check_table", summary: "" })
        return json(checkReport(view(), state.letters))
      }),
      providerOptions: FROM_CODE,
    }),
    set_cells: tool({
      description: "セルの値を変える案を出す。changes: [{key, field, value}]。値の個人名は「〔Ａ〕」の形のまま。JSON 文字列 {ok, applied, report} を返す（読めない key・記号があれば ok:false で何も変えない）。",
      inputSchema: z.strictObject({ changes: z.array(z.object({ key: z.string(), field: fieldIdSchema, value: z.string().max(500) })).max(5000) }),
      execute: counted<{ changes: { key: string; field: KojiFieldId; value: string }[] }>(async ({ changes }) => {
        const known = keys()
        const unknownKeys = changes.filter((c) => !known.has(c.key)).map((c) => c.key)
        const read = changes.map((c) => ({ c, edit: staffEdit(c.value.trim(), state.letters) }))
        const unreadable = read.filter((r) => r.edit.status === "error").map((r) => ({ key: r.c.key, field: r.c.field, message: r.edit.message }))
        if (unknownKeys.length || unreadable.length) return json({ ok: false, unknownKeys: unknownKeys.slice(0, 20), unreadable: unreadable.slice(0, 20) })
        const anonymized = await anonymizeChanges(
          state,
          view().edited,
          read.map(({ c, edit }) => ({ key: c.key, field: c.field, edit: { ...edit, by: "chat" } })),
        )
        if (anonymized.refused.length)
          return json({
            ok: false,
            error: "個人名かもしれないのに匿名化を確かめられない値があります。何も変えていません。個人名は「〔Ａ〕」の形で書くか、その値は変えずに ask_customer か ask_staff で聞いてください。",
            refused: anonymized.refused.slice(0, 20),
          })
        return push(
          "set_cells",
          anonymized.changes.map((c) => ({ kind: "cell", rowKey: c.key, field: c.field, edit: c.edit })),
          `${changes.length}セル`,
        )
      }),
      providerOptions: FROM_CODE,
    }),
    add_rows: tool({
      description:
        "元のファイルの表に無い工事（行）を足す案を出す。rows: [{cells:{field:value}}]（空の項目は書かない）。値の個人名は「〔Ａ〕」の形。足した行は要確認になる。JSON 文字列 {ok, keys, report} を返す（keys は足した行の key、rows と同じ順）。",
      inputSchema: z.strictObject({ rows: z.array(z.object({ cells: z.partialRecord(fieldIdSchema, z.string().max(500)) })).min(1).max(2000) }),
      execute: counted<{ rows: { cells: Partial<Record<KojiFieldId, string>> }[] }>(async ({ rows }) => {
        if (state.current.added.length + rows.length > MAX_ADDED_ROWS)
          return json({ ok: false, error: `足せる行は案件で ${MAX_ADDED_ROWS} 行までです（今 ${state.current.added.length} 行）。何も足していません。` })
        const planned = rows.map((r) => ({ key: newAddedKey(), cells: Object.entries(r.cells).flatMap(([f, v]) => (v?.trim() ? [{ field: f as KojiFieldId, value: v.trim() }] : [])) }))
        const read = planned.flatMap((r) => r.cells.map((c) => ({ key: r.key, field: c.field, edit: staffEdit(c.value, state.letters) })))
        const unreadable = read.filter((r) => r.edit.status === "error").map((r) => ({ key: r.key, field: r.field, message: r.edit.message }))
        if (unreadable.length) return json({ ok: false, unreadable: unreadable.slice(0, 20) })
        const anonymized = await anonymizeChanges(state, view().edited, read.map((r) => ({ ...r, edit: { ...r.edit, by: "chat" as const } })))
        if (anonymized.refused.length)
          return json({
            ok: false,
            error: "個人名かもしれないのに匿名化を確かめられない値があります。何も足していません。個人名は「〔Ａ〕」の形で書くか、その項目は空にして ask_customer で聞いてください。",
            refused: anonymized.refused.slice(0, 20),
          })
        const byRow = new Map<string, Partial<Record<KojiFieldId, CellEdit>>>()
        for (const c of anonymized.changes) {
          const { status: _, ...edit } = c.edit
          byRow.set(c.key, { ...byRow.get(c.key), [c.field]: { ...edit, status: "warning", message: [AI_ADDED_NOTE, edit.message].filter(Boolean).join(" / ") } })
        }
        return push(
          "add_rows",
          planned.map((r) => ({ kind: "add", rowKey: r.key, by: "chat", cells: byRow.get(r.key) ?? {} })),
          `${rows.length}行`,
          { keys: planned.map((r) => r.key) },
        )
      }),
      providerOptions: FROM_CODE,
    }),
    set_include: tool({
      description: "行を CSV に載せるか（手動の入れ外し）の案を出す。rows: [{key, include}]。JSON 文字列を返す。",
      inputSchema: z.strictObject({ rows: z.array(z.object({ key: z.string(), include: z.boolean() })).max(5000) }),
      execute: counted<{ rows: { key: string; include: boolean }[] }>(({ rows }) => {
        const known = keys()
        const unknownKeys = rows.filter((r) => !known.has(r.key)).map((r) => r.key)
        if (unknownKeys.length) return json({ ok: false, unknownKeys: unknownKeys.slice(0, 20) })
        return push("set_include", rows.map((r) => ({ kind: "include", rowKey: r.key, include: r.include })), `${rows.length}行`)
      }),
      providerOptions: FROM_CODE,
    }),
    ask_customer: tool({
      description: "顧客への問い合わせに回す案を出す（値は残し、要確認の印を付ける）。items: [{key, field, reason}]。",
      inputSchema: z.strictObject({ items: z.array(z.object({ key: z.string(), field: fieldIdSchema, reason: z.string().max(200) })).max(2000) }),
      execute: counted<{ items: { key: string; field: KojiFieldId; reason: string }[] }>(({ items }) => {
        const known = keys()
        const unknownKeys = items.filter((i) => !known.has(i.key)).map((i) => i.key)
        if (unknownKeys.length) return json({ ok: false, unknownKeys: unknownKeys.slice(0, 20) })
        return push("ask_customer", items.map((i) => ({ kind: "ask", rowKey: i.key, field: i.field, reason: i.reason })), `${items.length}件`)
      }),
      providerOptions: FROM_CODE,
    }),
    set_selection: tool({
      description:
        "7割の設定を変える案を出す。tax: 元データの金額が税込(included)・税抜(excluded)・不明(unknown)。selection: 載せる工事の選び方。rule7＝記入例どおり（業種ごとに元請→全体の順に金額の大きい順で7割を超えるまで。軽微な工事は10件まで）、all＝全件を載せる（除外と手動で外した行のほか。7割以上なら件数は自由なので、7割を超えて多く載せてよいときや、顧客がすでに7割で絞ったデータのとき）。basis: 業種コード→{total, motouke}（千円、決算書の完成工事高。税抜・税込はこの案件の7割の計算に合わせる）。",
      inputSchema: z.strictObject({
        tax: taxSchema.optional(),
        selection: selectionSchema.optional(),
        basis: basisSchema.optional(),
      }),
      execute: counted<{ tax?: TaxMode; selection?: SelectionMode; basis?: Basis }>(({ tax, selection, basis }) =>
        push("set_selection", [{ kind: "settings", tax, selection, basis }], json({ tax, selection, basis })),
      ),
    }),
    ask_staff: tool({
      description: "職員に聞き返す（例:「工事名の(仮称)も取ってよいですか」）。question は1〜2文。職員が答えるまで、この指示の変更案は反映されない。",
      inputSchema: z.strictObject({ question: z.string().min(1).max(500) }),
      execute: counted<{ question: string }>(({ question }) => {
        state.question = question
        state.log.push({ tool: "ask_staff", summary: question })
        return "職員に聞き返しました（答えは次の発言で届きます）。"
      }),
    }),
    find_location: tool({
      description:
        "工事場所（都道府県・場所名）を調べる。key を渡すと、その行の現場（工事名・注文者）を1件だけ調べる（顧客の覚えた結果 → AI の知識 → Web 検索。数十秒かかる）。見つかれば同じ現場の行の都道府県・場所名を変える案を出し、{ok, found, prefecture, place, source, urls, confident} を返す。" +
        `1回の指示で${MAX_LOOKUPS_PER_TURN}件まで。key を省くと、場所が空いている・推定に自信の無い行の現場の数と費用の目安を返し、職員に一括調査を始めるボタンを見せる（一括の検索は職員が押してから裏で動く。あなたは始めない）。個人名のある現場は調べない。`,
      inputSchema: z.strictObject({ key: z.string().optional() }),
      execute: counted<{ key?: string }>(async ({ key }) => {
        const loc = state.location
        if (!loc) return json({ ok: false, error: "工事場所を調べる道具は今使えません" })
        if (key === undefined) {
          // 一括調査の1回分。画面の「調べ始める」とサーバーと同じく、指示を受けたときの表（この指示の変更案を重ねる前）で数える
          const run = runSitesOf(startView())
          const over = run.over
          const sites = await loc.guard(run.sites)
          const memorized = await loc.memorized(sites.map((s) => s.key))
          const usd = estimateUsd(sites, memorized)
          const known = sites.filter((s) => memorized.has(s.key)).length
          state.locationOffer = { sites: sites.length, memorized: known, usd }
          state.log.push({ tool: "find_location", summary: `一括: ${sites.length}現場` })
          return json({
            ok: true,
            sites: sites.length,
            memorized: known,
            skipped: sites.filter((s) => s.skip).length,
            estimateUsd: Math.round(usd * 100) / 100,
            maxPerRun: MAX_SITES_PER_RUN,
            ...(over ? { nextRuns: over } : {}),
            note: "職員に件数と費用の目安を伝え、画面のボタンで始めてもらってください（あなたは始めません）。",
          })
        }
        const asked = siteOfRow(startView(), key)
        if (!asked) return json({ ok: false, unknownKeys: [key] })
        const [site] = await loc.guard([asked])
        if (!site) return json({ ok: false, unknownKeys: [key] })
        if (site.skip) return json({ ok: true, found: false, reason: askReason({ kind: "skipped", skip: site.skip }) })
        if (++state.lookups > MAX_LOOKUPS_PER_TURN)
          return json({ ok: false, error: `1回の指示で調べられるのは${MAX_LOOKUPS_PER_TURN}現場までです。まとめて調べるときは key を省いて一括調査のボタンを見せてください。` })
        const outcome = await loc.locate(site, state.locationSpent)
        if (outcome.kind !== "found") {
          state.log.push({ tool: "find_location", summary: `${site.workName} / ${site.client}: 見つからない` })
          return json({ ok: true, found: false, reason: askReason(outcome) })
        }
        const { kind: _, ...found } = outcome
        return push("find_location", outcomeChanges([site], new Map([[site.key, outcome]])), `${site.rowKeys.length}行`, {
          found: true,
          ...found,
          source: SOURCE_LABELS[found.source],
          rows: site.rowKeys.length,
        })
      }),
    }),
    set_plan: tool({
      description:
        "列の対応（計画）を変える案を出す。変える項目だけを書く（差分）。fields: {項目: {kind:'column', column:'J', transform} | {kind:'columns', columns:['B','C'], transform} | {kind:'flagColumns', columns:[{column:'F', code:'8'}]} | {kind:'constant', value, reason} | {kind:'missing'}}。" +
        "列は Excel の列記号、行（headerRow・dataStart・dataEnd・skipRows）は Excel の行番号。excludeHidden は隠れた行を出さないか。skipRows・excludeColumns は送ると今のものと入れ替える。reason に職員向けの理由。ai.freeform のときだけ instruction に指示文。" +
        "個人名の項目（注文者・工事名・配置技術者）は匿名化する変換しか使えず、注文者・工事名に定数は書けない。項目ごとに使える変換:\n" +
        planToolDoc() +
        "\nJSON 文字列 {ok, changes} を返す（合わない項目があれば ok:false と problems で、何も変えない）。承認すると変換し直す。",
      inputSchema: planPatchInputSchema,
      execute: counted<PlanPatchInput>((input) => {
        if (!state.plan) return json({ ok: false, error: "この案件には列の対応がありません（変換の元の表が無い）" })
        const patch = patchFromInput(input)
        const applied = applyPlanPatch(KOJI_KEIREKI, state.plan.plan, patch, state.plan.shape)
        if (!applied.ok) return json({ ok: false, problems: applied.problems })
        const before = beforeOf(state.plan.plan, patch)
        const changes = describePlanPatch(patch, before)
        state.pending.push({ kind: "plan", patch, before })
        state.plan = { ...state.plan, plan: applied.plan }
        state.log.push({ tool: "set_plan", summary: changes.join(" / ") })
        return json({ ok: true, changes, note: "承認すると変換し直します。この指示の表（get_table）は変わりません。" })
      }),
    }),
    offer_action: tool({
      description:
        "返事にボタンを付ける。action: export（CSV・取り込み用の Excel を書き出す前の確認を開く）| inquiry_excel（顧客への問い合わせの Excel を落とす）| edit_excel（編集用の Excel を落とす）。ファイルは職員がボタンを押して画面が作る。",
      inputSchema: z.strictObject({ action: z.enum(CHAT_ACTIONS) }),
      execute: counted<{ action: ChatAction }>(({ action }) => {
        if (!state.actions.includes(action)) state.actions.push(action)
        state.log.push({ tool: "offer_action", summary: action })
        return "職員にボタンを見せました。"
      }),
    }),
    propose_rule: tool({
      description: `全体ルール（global）か顧客ルール（customer）に足す項目の案を出す。ルールは箇条書きで、1つの決まりを1項目（1〜2文、${MAX_RULE_ITEM_LENGTH}字まで）にする。職員が項目ごとに承認すると保存される。`,
      inputSchema: z.strictObject({
        scope: ruleScopeSchema,
        items: z.array(z.string().min(1).refine((s) => charCount(s) <= MAX_RULE_ITEM_LENGTH, `1項目は${MAX_RULE_ITEM_LENGTH}字まで`)).min(1).max(MAX_RULE_PROPOSALS),
      }),
      execute: counted<{ scope: RuleScope; items: string[] }>(({ scope, items }) => {
        for (const text of items) state.pending.push({ kind: "rule", scope, text })
        state.log.push({ tool: "propose_rule", summary: `${scope}: ${items.join(" / ")}` })
        return `職員に${items.length}項目の案を見せました（承認待ち）。`
      }),
    }),
  }
}

export type TurnArgs = {
  apiKey: string
  system: string
  messages: ModelMessage[]
  state: TurnState
  containerId?: string
  effort?: "low" | "medium" | "high" | "xhigh"
  abortSignal?: AbortSignal
  fetch?: typeof fetch
  /** 往復が1つ終わるたびに呼ぶ（止めた・失敗した回でも、それまでの費用と作ったファイルを数えられるように） */
  onStep?: (step: TurnStep) => void
}

/** 終わった往復1つ。messages はその往復までの返事のメッセージ */
export type TurnStep = { usage: LanguageModelUsage; messages: ModelMessage[]; container: { id: string; expiresAt: string } | null }

/** 1回の指示の streamText。呼び出し側（API ルート・照合スクリプト）が stream を読む */
export function startTurn(args: TurnArgs) {
  const anthropic = createAnthropic({ apiKey: args.apiKey, ...(args.fetch ? { fetch: args.fetch } : {}) })
  return streamText({
    model: anthropic(MODEL),
    system: args.system,
    messages: args.messages,
    tools: { code_execution: anthropic.tools.codeExecution_20260120(), ...chatTools(args.state) },
    stopWhen: isStepCount(MAX_STEPS),
    maxOutputTokens: 64_000,
    abortSignal: args.abortSignal,
    onStepFinish: (step) => {
      const meta = step.providerMetadata?.anthropic as { container?: { id: string; expiresAt: string } | null } | undefined
      args.onStep?.({ usage: step.usage, messages: step.response.messages, container: meta?.container ?? null })
    },
    providerOptions: {
      anthropic: {
        effort: args.effort ?? "high",
        thinking: { type: "adaptive", display: "summarized" },
        fallbacks: "default",
        ...(args.containerId ? { container: { id: args.containerId } } : {}),
      },
    },
    // コードの往復ごとに履歴を送り直すので、毎回キャッシュの区切りを1つ付け直す（元の履歴＋この回の応答から作るので区切りは溜まらず、保存する履歴も変えない）
    prepareStep: ({ steps, initialMessages, responseMessages }) => ({
      ...forwardAnthropicContainerIdFromLastStep({ steps }),
      messages: withCacheBreakpoint([...initialMessages, ...responseMessages]),
    }),
  })
}

const replaceAt = <T,>(xs: readonly T[], i: number, x: T) => xs.map((y, k) => (k === i ? x : y))
const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } }

/**
 * 最後の文章かコード実行のブロックにキャッシュの区切りを付ける。コードから呼んだ道具の呼び出しと結果には付けられない
 * （Claude の文脈に入らないブロックなので 400 になる）
 */
export function withCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "user" && typeof m.content === "string") return replaceAt(messages, i, { ...m, content: [{ type: "text", text: m.content, providerOptions: CACHE }] })
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content === "string") continue
    const parts = m.content as { type: string; toolName?: string; providerOptions?: unknown }[]
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]!
      const ok = p.type === "text" || ((p.type === "tool-call" || p.type === "tool-result") && p.toolName === "code_execution")
      if (ok) return replaceAt(messages, i, { ...m, content: replaceAt(parts, j, { ...p, providerOptions: CACHE }) } as ModelMessage)
    }
  }
  return messages
}


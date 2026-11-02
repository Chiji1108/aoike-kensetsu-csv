import { createAnthropic, forwardAnthropicContainerIdFromLastStep } from "@ai-sdk/anthropic"
import { isStepCount, streamText, tool, type LanguageModelUsage, type ModelMessage } from "ai"
import { z } from "zod"
import { MAX_ADDED_ROWS, newAddedKey } from "../cases/added"
import { baseRows, deriveTable, type CaseTable, type TableView } from "../cases/view"
import { MAX_ITEMS_PER_REQUEST, parseAiResponse, type AiBatchRequest } from "../convert/ai-tasks"
import { editText, staffEdit, type CellEdit } from "../convert/convert"
import { showPersons, withNames, type PersonLetters } from "../convert/persons"
import { getTransform, transformsFor, type TransformId } from "../convert/transforms"
import type { MappingPlan } from "../convert/plan"
import { applyPlanPatch, beforeOf, describePlanPatch, patchFromInput, planPatchInputSchema, type PlanPatchInput, type SheetShape } from "../convert/plan-patch"
import { CODE_SETS } from "../spec/code-sets"
import { GYOSHU_GUESS_RULE } from "../convert/gyoshu-guess"
import type { Basis, SelectionMode, TaxMode } from "../convert/koji-selection"
import { basisSchema, fieldIdSchema, roundingSchema, selectionSchema, taxSchema } from "../schemas"
import { MODEL } from "../constants"
import { fieldLabel, KOJI_ANONYMIZE, KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import { applyChanges, type ChatChange } from "./proposals"
import { charCount, MAX_RULE_ITEM_LENGTH, RULE7_TAX_LABELS, ruleScopeSchema, type Rule7Tax, type RuleScope } from "./rules"
import { MAX_REVIEW_NOTES, MAX_REVIEW_RULES, reviewGuard, reviewMaterial, sameRuleText, UNKNOWN_RESULT, type ReviewGuard, type ReviewTurn } from "./review"
import { CHAT_ACTIONS, type ChatAction } from "./messages"
import { outcomeChanges } from "../location/changes"
import { FEEDBACK_KIND_LABELS, feedbackInputSchema, feedbackNameCheck, feedbackTexts, MASKED_FEEDBACK, MAX_FEEDBACK_PER_TURN, type FeedbackDeps, type FeedbackInput } from "../feedback/feedback"
import { askReason, estimateUsd, MAX_SITES_PER_RUN, runSitesOf, siteOfRow, SOURCE_LABELS, type Outcome, type Site } from "../location/sites"
import { ANSWER_FIELDS, collectInquiries, inquiryKey, readAiAnswers, REASONS, type AiAnswerReport } from "../inquiry/inquiry"
import { introSchema, otherCustomerTest, subjectSchema } from "../inquiry/text"
import type { AddressLookup } from "../convert/address"
import type { AiCache, AiCaller } from "../convert/pipeline"
import type { Rounding } from "../convert/transforms"
import { MAX_VIEW_CALLS, MAX_VIEW_PAGES, MAX_VIEW_PAGES_PER_CHAT, newViewState, viewFile, viewStepFinished, viewFileInputSchema, viewResultOutput, type FileViewer, type ViewFileInput, type ViewResult, type ViewState } from "./view-file"

/**
 * チャットの1回の指示。AI はコード実行（Anthropic のコンテナ）で元のファイルと今の表を読み、表の変更はコードから呼ぶ道具
 * （programmatic tool calling）で送る。変更はすぐ表に入れず、変更案（pending）に溜めて職員の承認を待つ
 */

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
/** コンテナに置いたファイル（name はコンテナの中の名前）。answer は返ってきた顧客の回答の Excel（印付きの Excel・記入用Excel） */
export type ContainerFile = { name: string; original: string; isSource: boolean; answer?: true }

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
  const fileLines = files.map((f) => `- $INPUT_DIR/${f.name}: ${f.original}${f.isSource ? "（変換の元）" : f.answer ? "（返ってきた顧客の回答の Excel: 印付きの Excel か記入用Excel）" : ""}`).join("\n")
  return `あなたは行政書士事務所の職員と一緒に、顧客から受け取った工事経歴の Excel を、建設業.NET に取り込む工事経歴書CSV（14列）にする。
職員はチャットで指示する。表は画面に常に見えていて、あなたの変更は変更案として職員に見せ、職員が承認したものだけが表に入る。

## 進め方
- 案件のファイルはコード実行のコンテナにある（pandas・openpyxl で読める。日付はシリアル値のことがある）:
${fileLines || "（なし）"}
- 今の表は、事務所の変換（列の対応＋決まった変換＋AI の整形）で作ったもの。コードから await get_table({}) で読む（JSON 文字列。行は key・source・included・cells・issues を持つ）。
- 表を直すのは必ずコードから: await set_cells({"changes":[{"key","field","value"}]})、await set_include({"rows":[{"key","include"}]})、await ask_customer({"items":[{"key","field","reason"}]})。
- 文字の層の無い PDF（スキャン・手書き。pypdf で文字が取れない）と画像（JPEG・PNG など）は、view_file を直接呼んでファイルそのものを見て読む（コードからは呼ばない）。PDF は pages でページを指定する（1回${MAX_VIEW_PAGES}ページ・1つの会話で${MAX_VIEW_PAGES_PER_CHAT}ページまで。見たページは以後の往復でも読み直すので、要るページだけを見る）。文字の層のある PDF は pypdf で読む方が安い。上限で見られなかったページは、返事で職員に伝える。
  - 見て読んだ値は add_rows・set_cells・record_answers に read_from:"image" を付けて送る（道具がセルのメモに印を付ける）。読めない・自信の無い字は推測で埋めず空にする（空の欄は顧客への問い合わせに回る）。
- 元のファイルの表に無い工事は await add_rows({"rows":[{"cells":{"field":"value"}}]}) で足す（変換の元の表が無い PDF だけの案件は、これで一から表を作る）。足した行はすべて要確認になる。返る keys で、続けて set_cells などに使える。
- 変換の元のほかのファイル（技術者の一覧・別の年の表など）も読んで使ってよい（例: 技術者の一覧から配置技術者を埋める）。
- 個人名は表では「〔Ａ〕」「〔未掲載１〕」の形の記号で出る。値に個人名を入れるときはこの形のまま書く（例:「〔Ａ〕邸新築工事」）。個人名をそのまま書かない。
- 注文者・工事名に書いた値は、事務所の変換と同じ匿名化で確かめる（個人名は記号にする）。確かめられない値は受け取られない。
- 7割と金額の設定（税込/税抜・基準額・載せる工事の選び方＝7割ルールか全件か・金額の千円未満の切り捨て/四捨五入）は set_selection を直接呼ぶ。千円未満の扱いは承認すると変換し直す（この指示の get_table の金額は変わらない）。
- 列の対応（どの列からどの項目を作るか・見出しの行・データの開始・飛ばす行・金額の単位）を変えるときは set_plan を直接呼ぶ（例:「金額は税込の列で」「工事名は B 列と C 列をつなげて」）。全行に同じ直しをセルの変更で当てるより、列の対応で直せるものは set_plan にする。承認すると変換し直す（この指示の get_table の表は変わらない）。使うシートは変えられないので、変えたいときは職員に作業の画面の上のシートの欄で選び直してもらう。職員にどの列を使っているか聞かれたら「この案件」の列の対応で答える。
- 職員が CSV・Excel を出したい、問い合わせの Excel が欲しい、Excel で直したいと言ったら offer_action でボタンを出す（Excel で直すときも export。書き出した Excel を直してアップロードし直すと表に戻る。書き出す前の確認は画面が出す。あなたはファイルを作らない）。
- 直したら await check_table({}) で決まった検査（エラー・警告・字数の上限・個人名らしい値・7割）を確かめ、直せるものは直す。
- 業種コードを決める・直すときの決まり（工事名に業種の言葉を補う決まりとは別）: ${GYOSHU_GUESS_RULE} ほかの工事の傾向はコードで数える。業種は事務所が決めるので ask_customer にしない（推し量ったときは、返事で根拠を伝える）。
- 業種が決まっていない行（空・要確認・AI の推定）が数件より多いときは、業種を決めるたびに7割で載せる行が入れ替わるので、職員に1行ずつ業種を指定させる返事や、入れ替わりの説明を長く書かない。作業の画面の「業種」のタブ（7割で載りうる行もまとめて決める一覧）へ短く案内する。
- 分からないこと・データに無いこと（配置技術者・分からない工事場所など）は推測で埋めず、ask_customer で顧客への問い合わせに回す。住所の分割・工事名の補い・調べられる工事場所は問い合わせに回さず事務所でやる。
- 指示があいまいで、どちらにも取れるときや、決める前に職員の答えが要るときは、ask_staff で聞き返す（答えるまで変更案は反映されない）。
- 職員が計画の聞き返し（「この案件」の計画の聞き返し）がどういうことかを聞いたら、元の Excel で対象の行と聞き返しの列の注記を読む（注記がほかの工事を指すなら、その工事の行があるかも見る）。注記ごとの意味の読み方、重複・対象外のおそれ、答え（載せない・載せる）で何が変わるか、迷うときに確かめること（表で見る・顧客に聞く）を、短い箇条書き（10行ほどまで）で返す。決めるのは事務所なので、どちらがよいかの勧めと変更案は、頼まれるまで出さない。
- 顧客の回答（職員がチャットに貼ったメールの本文、返ってきた印付きの Excel・記入用Excel・別の Excel・PDF などのファイル）は、まず await get_inquiries({}) で今顧客に聞いていることを読み、答えごとにどの工事（key）のどの項目への答えかを決めて await record_answers({"items":[{"key","field","answer"}]}) で送る（set_cells は使わない）。
  - answer は顧客の答えを項目の値として読める形で書く: 年月は「2024年4月」、工事場所は field を place にして都道府県から市区町村まで（例「東京都千代田区」）、注文者・工事名・配置技術者は顧客の書いたまま（個人名も記号にせずそのまま。匿名化・字数などの検査は道具が変換と同じ決まりでやる）。今の値（推定）のとおりという答えは {"key","field","confirm":true}。
  - 聞いていない項目でも、顧客がはっきり訂正していれば送ってよい。答えの無い項目は送らない（推測で埋めない）。どの工事への答えか決めきれない答え（工事名が似ている・番号が無い・2つの工事に当てはまる）は送らず、ask_staff で職員に聞く。税込・税抜の答えは set_selection の tax。
  - 印付きの Excel は、変換の元の Excel に、聞くセルの色・推定の確かめのメモ・右端に足した「〇〇（ご記入ください）」の列・「追加の確認」のシート（元の表に無い工事）を付けて顧客に返したもの。記入用Excelはこちらの形の表（管理番号の列）。どちらも色付きのセルは画面がもう読んで顧客の回答の変更案にしている。読むのはその外（印の無いセルの書き換え・メモ・別のシート。印付きの Excel は変換の元と比べて変わったセル）と、読めなかった記入だけ。
- 職員が顧客への問い合わせのメールの下書きを頼んだら、await get_inquiries({}) で今の問い合わせを読み、propose_inquiry を直接呼ぶ。表は変えない。
  - 聞くことは添付の Excel の色付きのセルとメモで顧客に伝わり、メールの本文には項目ごとの件数・記入のしかた・宛名・挨拶・結びを画面が付ける。あなたが書くのは件名（subject）と本文の前置き（intro。1〜3文）だけ。
  - 何についての確認か（今年度の工事経歴書の作成のため、資料で分からない点がある、など）が顧客に伝わるように書く。事務所の中の言葉（項目の id・列記号・変換・AI・CSV）は使わない。
  - 個人名・表の記号（〔Ａ〕など）・ほかの顧客の名前は書かない（入っていれば受け取らない）。
- 職員が「顧客ルールに追加して」「全体ルールに追加して」と言ったら propose_rule で足す項目の案を出す（1つの決まりを1項目に。今のルールと同じ項目は出さない。保存は職員の承認後）。
- 職員が案件を終えるときの振り返り（「振り返って顧客ルールの案を出して」）を頼んだら、get_review を直接呼んで今年の作業（職員の指示と承認の結果・聞き返しと答え・列の対応の変更・手直しと置換の例・7割の設定）を読み、propose_review で来年のための顧客ルールの案を出す。表は変えない。
  - yearly（毎年の決まり）: 来年もこの顧客のデータに同じように当てはまるやり方だけ。職員が承認した指示・手直し・列の対応の変更・答えた聞き返しから決め、evidence に元にした指示の番号や手直しを書く。却下した・承認を取り消した・まだ決めていない・状態不明の変更案は決まりにしない。全体ルールと今の顧客ルール、まだ決めていない前の振り返りの案（pendingReview）にすでにある決まりは出さない。
  - one_off（今年だけ）: 特定の工事・行だけの直し、顧客の回答で埋めた値、今年のファイルだけの事情など、来年は当てはまらないもの。ルールにはしない。
  - 決まりは来年のファイルでも読めるように書く: 列記号・行番号・シート名でなく見出しの名前や中身で書く（例「完成年月は引渡日の列」）。特定の工事名・注文者名を挙げず、決まりとして一般化する。個人名と表の記号（〔Ａ〕〔個人名〕）は書かない。1つの決まりを1項目（1〜2文）。
  - 返事では、足す案の数と、今年だけの事情（ルールにしないもの）を短く箇条書きで分けて伝える。
- 工事場所（都道府県・場所名）を調べるときは find_location を直接呼ぶ（コードからは呼ばない）。「この現場ってどこ？」のように1件なら key を渡す。「場所が空いている行を調べて」のようにまとめてなら key を省き、返った件数と費用の目安を職員に伝える（一括の検索は職員が画面のボタンで始める）。自分で Web の知識から場所を書き込まない。
- 職員の頼みが今の道具ではできなかった（missing）・コード実行で遠回りしないとできなかった（detour）・同じ手直しを何度も頼まれた（repeat）ときは、開発者への要望として残す。list_feedback で今の要望を読み、同じ要望があればその id を same_as に書いて record_feedback を呼ぶ（どちらも直接呼ぶ。1回の指示で${MAX_FEEDBACK_PER_TURN}件まで）。
  - 細かいこと・この案件だけの事情・今の道具でそのままできたこと・職員の好みは残さない。
  - want（何をしたかったか）・did（今どうしたか）・idea（あると良い機能）はそれぞれ短い1文。顧客名・注文者・工事名・個人名・表の記号・金額は書かず、一般化して書く（入っていれば受け取らない）。
  - 要望を残しても職員への返事と作業は続ける。できないことはその場で職員に伝える（残したことは画面が知らせる）。
- CSV は書かない（CSV の形式・7割の計算・字数・個人名の検査は決まった処理がやる）。
- 最後に、何を何件変えたか、残った問題、職員に確かめたいことを短い日本語で返す。コードや JSON は返事に貼らない。
- 道具を呼べるのは1回の指示で${MAX_TOOL_CALLS}回まで（コード実行と view_file は数えない。view_file は別に${MAX_VIEW_CALLS}回まで）。表は get_table でまとめて読み、変更はまとめて送る。

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
  /** 顧客の回答を値にするもの（record_answers。住所の分け方と、記入を整える計画の変換・端数。無ければ道具は使えない） */
  answers: AnswerDeps | null
  /** record_answers の匿名化の AI の結果（指示の間で持ち、同じ答えを送り直しても聞き直さない） */
  answerCache: AiCache
  /** 振り返りの材料（get_review）と、ルールの案に入れない個人名（propose_rule・propose_review）。無ければ get_review は使えず、名前は表の人だけで確かめる */
  review: ReviewDeps | null
  /** propose_review の今年だけの事情（ルールにしない。照合の記録に残す） */
  oneOff: string[]
  /** 問い合わせのメールの下書きの確かめに使うもの（propose_inquiry）。無ければほかの顧客の名前は確かめない */
  inquiry: InquiryDeps | null
  /** 要望を読み書きするもの（list_feedback・record_feedback）。無ければ道具は使えない */
  feedback: FeedbackDeps | null
  /** この指示で list_feedback が見せた要望の id（読む前は null。record_feedback の same_as はここにあるものだけ） */
  feedbackListed: Set<string> | null
  /** この指示で残した要望（新しい要望と、件数を足した要望） */
  feedbackRecorded: { id: string; kind: FeedbackInput["kind"]; added: boolean }[]
  /** 案件のファイルを AI に見せる状態（view_file。見せた数・範囲・上げたファイル）。無ければ道具は使えない */
  view: ViewState | null
  /** view_file を呼んだ回数（ほかの道具の toolCalls とは別に数える） */
  viewCalls: number
}

export type { FeedbackDeps }

/** 問い合わせのメールの下書きの確かめ。otherCustomers はほかの顧客の名前（文に入れない）、customerName はこの案件の顧客の名前（件名などに書いてよい） */
export type InquiryDeps = { customerName: string; otherCustomers: () => Promise<readonly string[]> }

/**
 * 振り返りに使うもの。turns はこの案件の会話の指示（サーバーは画面の会話と、保存した作業の変更案の状態・取り消しの記録から作る。作れなければ理由）、
 * names は表の人のほかに分かっている個人名（サーバーは保存した作業と AI の結果から。去年のコードと同じ集め方。保存が無ければ空、読めなければ投げる）、
 * taken は重ねて案にしない項目（今の顧客ルールと、まだ決めていない振り返りの案）
 */
export type ReviewDeps = {
  turns: () => Promise<readonly ReviewTurn[] | string>
  names: () => Promise<Iterable<string>>
  taken: () => Promise<{ rules: string[]; pending: string[] }>
}

/** record_answers が顧客の回答を値にするのに使うもの（返ってきた Excel の取り込みと同じ。AI は匿名化の AI を使う。千円未満の扱いは今の表の rounding） */
export type AnswerDeps = { lookup: AddressLookup }


/** 値の判断の AI（server/claude.ts の batchWithClaude と同じ形。usd はその呼び出しの費用） */
export type AnonymizeCaller = (req: AiBatchRequest) => Promise<({ ok: true; json: unknown } | { ok: false; message: string }) & { usd: number }>

export function newTurnState(
  table: CaseTable,
  anonymize?: AnonymizeCaller,
  location?: LocationCaller,
  plan: TurnState["plan"] = null,
  answers: AnswerDeps | null = null,
  review: ReviewDeps | null = null,
  inquiry: InquiryDeps | null = null,
  feedback: FeedbackDeps | null = null,
  viewer: FileViewer | null = null,
  /** 今の会話の履歴（view_file が見せた数・範囲を数える） */
  history: readonly ModelMessage[] = [],
): TurnState {
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
    answers,
    answerCache: new Map(),
    review,
    oneOff: [],
    inquiry,
    feedback,
    feedbackListed: null,
    feedbackRecorded: [],
    view: viewer ? newViewState(viewer, history) : null,
    viewCalls: 0,
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
/** 手書き・画像（文字の層の無い PDF・写真）から AI が読んだ値のセルに添える（道具の read_from:"image" で道具が付ける） */
export const IMAGE_READ_NOTE = "手書き・画像から AI が読んだ値です。読み違いがないか元のファイルで確かめてください"

/** 値をどこから読んだか（image は view_file で見た手書き・画像。セルのメモに IMAGE_READ_NOTE を付ける） */
const valueSourceSchema = z.enum(["text", "image"]).optional()
type ValueSource = z.infer<typeof valueSourceSchema>
/** 手書き・画像から読んだ値のメモ（ほかのメモの前に付ける） */
const withImageNote = (source: ValueSource, message: string | undefined) => (source === "image" ? [IMAGE_READ_NOTE, message].filter(Boolean).join(" / ") : message)
const SOURCE_DOC = 'read_from: 値を読んだもと（"image"＝view_file で見た手書き・画像の文字。省くと text）。'


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
  const limited =
    <A, R>(key: "toolCalls" | "viewCalls", max: number, refuse: (error: string) => R, run: (args: A, options: { abortSignal?: AbortSignal }) => R | Promise<R>) =>
    async (args: A, options: { abortSignal?: AbortSignal } = {}): Promise<R> => {
      if (++state[key] > max)
        return refuse(
          key === "viewCalls"
            ? `この指示でファイルを見られる回数（${max}回）を使い切りました。見られなかったファイル・ページを職員に伝え、ここまでの変更案を返してください。`
            : `この指示で道具を呼べる回数（${max}回）を使い切りました。ここまでの変更案と残りを職員に返してください。`,
        )
      return run(args, options)
    }
  const counted = <A,>(run: (args: A) => string | Promise<string>) => limited<A, string>("toolCalls", MAX_TOOL_CALLS, (error) => json({ ok: false, error }), run)
  /** ルールの案・振り返りの材料の個人名（表の人と、分かっている個人名。指示の間で1回だけ作る。集められなければ道具は理由を返す） */
  // 名前は確かめるときの表（この指示で AI が入れた手直しも）から集める。分かっている個人名は指示の間で1回だけ読む
  let knownNames: Promise<Iterable<string>> | null = null
  let guarded_: { table: CaseTable; guard: Promise<ReviewGuard> } | null = null
  const guard = () => {
    if (guarded_?.table !== state.current) {
      const table = state.current
      knownNames ??= state.review ? state.review.names() : Promise.resolve([])
      guarded_ = { table, guard: knownNames.then((names) => reviewGuard(table, names)) }
    }
    return guarded_.guard
  }
  /** 個人名の入った項目の番号（0 から） */
  const personal = async (texts: readonly string[]) => {
    const g = await guard()
    return texts.flatMap((t, i) => (g.has(t) ? [i] : []))
  }
  /** 名前を確かめられないとき（保存した作業を読めない）は、何も出さずに理由を返す */
  const guarded = async (run: () => Promise<string>) => {
    try {
      await guard()
    } catch (e) {
      return json({ ok: false, error: `個人名を確かめられないので、何も出していません: ${e instanceof Error ? e.message : String(e)}` })
    }
    return run()
  }
  /**
   * 要望の文の確かめ（入っていた語を返す）: 個人名・表の記号（ルールの案と同じ）と、顧客名・この案件の注文者と工事名（lib/feedback の feedbackNameCheck）。
   * 名前を確かめられないとき（保存した作業を読めない）は投げる（guarded の中で使う）
   */
  const feedbackCheck = async (deps: FeedbackDeps) => {
    const g = await guard()
    const names = feedbackNameCheck({ names: [...(await deps.names()), ...view().shown.map((r) => r.cells.client.value)], works: caseWorks(view()), known: deps.known })
    return (text: string) => [...(g.has(text) ? ["個人名・表の記号"] : []), ...names(text)]
  }
  /** 今の問い合わせ（職員が外したものは除く。画面の問い合わせの欄と同じ） */
  const inquiriesOf = (v: TableView) => collectInquiries(v.output, { tax: state.current.tax }).filter((q) => !state.current.dismissed.has(inquiryKey(q)))
  const ruleItem = z.string().min(1).refine((s) => charCount(s) <= MAX_RULE_ITEM_LENGTH, `1項目は${MAX_RULE_ITEM_LENGTH}字まで`)
  const NAME_REFUSAL = "個人名か表の記号（〔Ａ〕〔個人名〕など）が入っている項目があります。何も出していません。名前を挙げずに決まりとして書き直してください。"
  /** shown はこの指示の表に重ねる変更（既定は changes。表に重ねない変更〔千円未満の扱い〕を除くときに渡す） */
  const push = (tool: string, changes: ChatChange[], summary: string, extra: object = {}, shown: ChatChange[] = changes) => {
    state.pending.push(...changes)
    state.current = applyChanges(state.current, view().edited, shown)
    state.log.push({ tool, summary })
    return json({ ok: true, applied: changes.length, ...extra, report: checkReport(view(), state.letters) })
  }

  return {
    view_file: tool({
      description:
        `案件のファイル（PDF・JPEG・PNG・GIF・WebP の画像）をそのまま見る。文字の層の無い PDF（スキャン・手書き）や画像を読むときに使う。file はコンテナの中の名前（例 file-2.pdf）、` +
        `pages は PDF のページ（1 から。例「1-5」。省くと全部。1回${MAX_VIEW_PAGES}ページ・1つの会話で${MAX_VIEW_PAGES_PER_CHAT}ページまで）。` +
        "見せたファイルは以後の往復でも読み直すので、要るページだけを見る。{ok, file, pages?:{from, to, total}} とファイルを返す（見られなければ ok:false と error）。",
      inputSchema: viewFileInputSchema,
      execute: limited<ViewFileInput, ViewResult>("viewCalls", MAX_VIEW_CALLS, (error) => ({ ok: false, error }), async (input, { abortSignal }) => {
        if (!state.view) return { ok: false, error: "ファイルを見る道具は今使えません" }
        const result = await viewFile(state.view, input, abortSignal)
        const pages = result.ok && result.pages ? ` ${result.pages.from}-${result.pages.to}/${result.pages.total}ページ` : ""
        state.log.push({ tool: "view_file", summary: result.ok ? `${result.file}${pages}${"repeated" in result ? "（もう見せた）" : ""}` : `${input.file}: ${result.error}` })
        return result
      }),
      toModelOutput: ({ output }) => viewResultOutput(output),
    }),
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
      description: `セルの値を変える案を出す。changes: [{key, field, value}]。値の個人名は「〔Ａ〕」の形のまま。${SOURCE_DOC}JSON 文字列 {ok, applied, report} を返す（読めない key・記号があれば ok:false で何も変えない）。`,
      inputSchema: z.strictObject({ changes: z.array(z.object({ key: z.string(), field: fieldIdSchema, value: z.string().max(500) })).max(5000), read_from: valueSourceSchema }),
      execute: counted<{ changes: { key: string; field: KojiFieldId; value: string }[]; read_from?: ValueSource }>(async ({ changes, read_from: source }) => {
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
          anonymized.changes.map((c) => ({ kind: "cell", rowKey: c.key, field: c.field, edit: source === "image" ? imageEdit(c.edit) : c.edit })),
          `${changes.length}セル`,
        )
      }),
      providerOptions: FROM_CODE,
    }),
    add_rows: tool({
      description:
        `元のファイルの表に無い工事（行）を足す案を出す。rows: [{cells:{field:value}}]（空の項目は書かない）。値の個人名は「〔Ａ〕」の形。足した行は要確認になる。${SOURCE_DOC}JSON 文字列 {ok, keys, report} を返す（keys は足した行の key、rows と同じ順）。`,
      inputSchema: z.strictObject({ rows: z.array(z.object({ cells: z.partialRecord(fieldIdSchema, z.string().max(500)) })).min(1).max(2000), read_from: valueSourceSchema }),
      execute: counted<{ rows: { cells: Partial<Record<KojiFieldId, string>> }[]; read_from?: ValueSource }>(async ({ rows, read_from: source }) => {
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
          byRow.set(c.key, { ...byRow.get(c.key), [c.field]: { ...edit, status: "warning", message: [AI_ADDED_NOTE, withImageNote(source, edit.message)].filter(Boolean).join(" / ") } })
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
        "7割と金額の設定を変える案を出す。tax: 元データの金額が税込(included)・税抜(excluded)・不明(unknown)。selection: 載せる工事の選び方。rule7＝記入例どおり（業種ごとに元請→全体の順に金額の大きい順で7割を超えるまで。軽微な工事は10件まで）、all＝全件を載せる（除外と手動で外した行のほか。7割以上なら件数は自由なので、7割を超えて多く載せてよいときや、顧客がすでに7割で絞ったデータのとき）。basis: 業種コード→{total, motouke}（千円、決算書の完成工事高。税抜・税込はこの案件の7割の計算に合わせる）。rounding: 円の金額を千円にするときの千円未満の扱い（floor＝切り捨て・round＝四捨五入）。",
      inputSchema: z.strictObject({
        tax: taxSchema.optional(),
        selection: selectionSchema.optional(),
        basis: basisSchema.optional(),
        rounding: roundingSchema.optional(),
      }),
      execute: counted<{ tax?: TaxMode; selection?: SelectionMode; basis?: Basis; rounding?: Rounding }>((input) => {
        const now = state.current
        // 今と同じ値は変更案にしない（基準額は重ねたあとが今と同じなら）
        const basisChanged = !!input.basis && JSON.stringify(applyChanges(now, [], [{ kind: "settings", basis: input.basis }]).basis) !== JSON.stringify(now.basis)
        const change: Extract<ChatChange, { kind: "settings" }> = {
          kind: "settings",
          ...(input.tax && input.tax !== now.tax ? { tax: input.tax } : {}),
          ...(input.selection && input.selection !== now.selection ? { selection: input.selection } : {}),
          ...(basisChanged ? { basis: input.basis } : {}),
          ...(input.rounding && input.rounding !== now.rounding ? { rounding: input.rounding } : {}),
        }
        const { kind: _, ...changed } = change
        if (!Object.keys(changed).length) {
          state.log.push({ tool: "set_selection", summary: "今と同じ" })
          return json({ ok: true, applied: 0, same: true, message: "今と同じ設定なので変更案にしていません" })
        }
        // 千円未満の扱いは承認するまで案件の扱いを変えない（この指示の表は今の扱いのまま。承認すると画面が変換し直す）
        const { rounding, ...shown } = change
        return push(
          "set_selection",
          [change],
          json(changed),
          rounding ? { note: "千円未満の扱いは承認すると変換し直します（この指示の get_table の表は変わりません）" } : {},
          Object.keys(shown).length > 1 ? [shown] : [],
        )
      }),
    }),
    get_inquiries: tool({
      description:
        "顧客に今聞いていること（問い合わせ。CSV に載せる行のうち、書類に要る項目が空か推定に自信がないセル。職員が外したものは除く）を JSON 文字列で返す: {tax: 税込・税抜を聞いているか, cells:[{key, field, label, reason, reasonId（missing＝空・needsReview＝推定）, note?（推定の根拠などセルのメモ）, value, workName, client, amount, source}]}。顧客の回答を読む前・問い合わせのメールの下書きを作る前に呼ぶ。",
      inputSchema: z.strictObject({}),
      execute: counted<object>(async () => {
        const v = view()
        const rowOf = new Map(v.output.map((r) => [r.key, r]))
        const qs = inquiriesOf(v)
        state.log.push({ tool: "get_inquiries", summary: `${qs.length}件` })
        const text = (key: string, f: KojiFieldId) => editText(rowOf.get(key)!.cells[f], state.letters)
        // セルのメモは値と同じ記号で出し、分かっている個人名も伏せる（名前を確かめられないときはメモを出さない）
        const hide = await guard().then(
          (g) => g.hide,
          () => null,
        )
        const note = (key: string, f: KojiFieldId) => {
          const m = rowOf.get(key)!.cells[f].message
          return m && hide ? { note: hide(showPersons(m, state.letters, true)) } : {}
        }
        return json({
          tax: qs.some((q) => q.kind === "case"),
          cells: qs.flatMap((q) =>
            q.kind === "cell"
              ? [
                  {
                    key: q.rowKey,
                    field: q.field,
                    label: fieldLabel(q.field),
                    reason: REASONS[q.reason].label,
                    reasonId: q.reason,
                    ...note(q.rowKey, q.field),
                    value: text(q.rowKey, q.field),
                    workName: text(q.rowKey, "workName"),
                    client: text(q.rowKey, "client"),
                    amount: text(q.rowKey, "amount"),
                    source: `${rowOf.get(q.rowKey)!.sheet}!${rowOf.get(q.rowKey)!.row + 1}行`,
                  },
                ]
              : [],
          ),
        })
      }),
      providerOptions: FROM_CODE,
    }),
    record_answers: tool({
      description:
        "顧客の回答を表に入れる案を出す。items: [{key, field, answer} | {key, field, confirm:true}]。answer は顧客の答え（年月は「2024年4月」、工事場所は field=place で都道府県から市区町村まで、注文者・工事名・配置技術者は書いたまま）。" +
        `${SOURCE_DOC}返ってきた Excel（印付き・記入用Excel）の取り込みと同じ決まりで値にし（注文者・工事名は匿名化する）、JSON 文字列 {ok, applied, answered（問い合わせへの答え）, confirmed, corrected（聞いていない項目の訂正。送った項目だけ変える）, same, invalid:[{key, field, answer, message}], needsCheck, report} を返す（読めない答えは入れず invalid で返す）。返事では問い合わせへの答えと訂正を分けて職員に伝える。`,
      inputSchema: z.strictObject({
        read_from: valueSourceSchema,
        items: z
          .array(
            z
              .strictObject({ key: z.string(), field: z.enum(ANSWER_FIELDS), answer: z.string().trim().min(1).max(500).optional(), confirm: z.literal(true).optional() })
              .refine((i) => (i.answer === undefined) !== (i.confirm === undefined), "answer か confirm:true のどちらか1つを書く"),
          )
          .min(1)
          .max(2000),
      }),
      execute: counted<{ items: { key: string; field: KojiFieldId; answer?: string; confirm?: true }[]; read_from?: ValueSource }>(async ({ items, read_from: source }) => {
        const deps = state.answers
        if (!deps) return json({ ok: false, error: "顧客の回答を読む道具は今使えません" })
        const known = keys()
        const unknownKeys = items.filter((i) => !known.has(i.key)).map((i) => i.key)
        if (unknownKeys.length) return json({ ok: false, unknownKeys: [...new Set(unknownKeys)].slice(0, 20) })
        const callAi: AiCaller = async (req) => {
          const res = state.anonymize ? await state.anonymize(req) : { ok: false as const, message: "個人名の判定に使う AI がありません", usd: 0 }
          state.anonymizeUsd += res.usd
          return res.ok ? { ok: true, json: res.json } : { ok: false, message: res.message }
        }
        const report = await readAiAnswers(
          items.map((i) => ({ rowKey: i.key, field: i.field, ...(i.confirm ? { confirm: true as const } : { answer: i.answer! }) })),
          view().shown,
          { ctx: { rounding: state.current.rounding }, lookup: deps.lookup, cache: state.answerCache, callAi, fields: state.plan?.plan.fields ?? {} },
        )
        const confirmed = new Set(items.flatMap((i) => (i.confirm ? [`${i.key}:${i.field}`] : [])))
        const changes = report.edits.map(([key, edit]): ChatChange => {
          const at = key.lastIndexOf(":")
          const field = key.slice(at + 1) as KojiFieldId
          // 印を付けるのは顧客が答えた値だけ（今の値のとおりという確認 confirm:true は、読んだ値ではない）
          return { kind: "cell", rowKey: key.slice(0, at), field, edit: source === "image" && !confirmed.has(key) ? imageEdit(edit) : edit }
        })
        const result = answerResult(report)
        if (!changes.length) {
          state.log.push({ tool: "record_answers", summary: "0セル" })
          return json({ ok: true, applied: 0, ...result })
        }
        return push("record_answers", changes, `${changes.length}セル`, result)
      }),
      providerOptions: FROM_CODE,
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
        "列は Excel の列記号、行（headerRow・dataStart・dataEnd・skipRows）は Excel の行番号。excludeHidden は隠れた行を出さないか。skipRows は送ると今のものと入れ替える。出さない行は excludeRows で今のものに足す・外す（add・remove。{column:'S', values:[]} は S 列に値がある行、values があればその値の行。外すときは今あるものと同じ列・値を書く）。reason に職員向けの理由。ai.freeform のときだけ instruction に指示文。" +
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
        "返事にボタンを付ける。action: export（CSV・最後の Excel を書き出す前の確認を開く。Excel で直したいときもこれ）| inquiry_excel（顧客への問い合わせの Excel をダウンロードする）。ファイルは職員がボタンを押して画面が作る。",
      inputSchema: z.strictObject({ action: z.enum(CHAT_ACTIONS) }),
      execute: counted<{ action: ChatAction }>(({ action }) => {
        if (!state.actions.includes(action)) state.actions.push(action)
        state.log.push({ tool: "offer_action", summary: action })
        return "職員にボタンを見せました。"
      }),
    }),
    propose_rule: tool({
      description: `全体ルール（global）か顧客ルール（customer）に足す項目の案を出す。ルールは箇条書きで、1つの決まりを1項目（1〜2文、${MAX_RULE_ITEM_LENGTH}字まで）にする。個人名・表の記号は書かない（入っていれば受け取らない）。職員が項目ごとに承認すると保存される。`,
      inputSchema: z.strictObject({
        scope: ruleScopeSchema,
        items: z.array(ruleItem).min(1).max(MAX_RULE_PROPOSALS),
      }),
      execute: counted<{ scope: RuleScope; items: string[] }>(({ scope, items }) =>
        guarded(async () => {
          const named = await personal(items)
          if (named.length) return json({ ok: false, error: NAME_REFUSAL, items: named })
          for (const text of items) state.pending.push({ kind: "rule", scope, text, source: "chat" })
          state.log.push({ tool: "propose_rule", summary: `${scope}: ${items.join(" / ")}` })
          return `職員に${items.length}項目の案を見せました（承認待ち）。`
        }),
      ),
    }),
    list_feedback: tool({
      description: "今の未対応の要望（開発者への「あると良い機能」）を件数の多い順に返す: {ok, items:[{id, kind, want, idea, count}]}。record_feedback の前に読む。",
      inputSchema: z.strictObject({}),
      execute: counted<object>(async () => {
        const deps = state.feedback
        if (!deps) return json({ ok: false, error: "要望の道具は今使えません" })
        return guarded(async () => {
          const items = await deps.list()
          // 残すときに確かめているが、ほかの案件で残した要望・職員が書いた要望もあるので、この案件の名前で確かめ直す（当たれば中身を見せない）
          const check = await feedbackCheck(deps)
          const shown = items.map((i) => (check(i.want).length || check(i.idea).length ? { ...i, want: MASKED_FEEDBACK, idea: MASKED_FEEDBACK } : i))
          state.feedbackListed = new Set(items.map((i) => i.id))
          state.log.push({ tool: "list_feedback", summary: `${items.length}件` })
          return json({ ok: true, items: shown })
        })
      }),
    }),
    record_feedback: tool({
      description:
        `開発者への要望を残す（変更案ではなく承認は要らない。表は変えない）。items: [{kind: missing（今の道具ではできない）| detour（コード実行で遠回りした）| repeat（同じ手直しを何度も頼まれた）| other, want, did, idea, same_as?}]。` +
        `want・did・idea は短い1文（それぞれ200字まで）。list_feedback の要望と同じなら same_as にその id を書く（件数を足す。文は残さない）。1回の指示で${MAX_FEEDBACK_PER_TURN}件まで。` +
        "顧客名・注文者・工事名・個人名・表の記号が入っていれば何も残さず理由を返す。",
      inputSchema: z.strictObject({
        items: z
          .array(feedbackInputSchema.extend({ same_as: z.string().max(64).optional() }))
          .min(1)
          .max(MAX_FEEDBACK_PER_TURN),
      }),
      execute: counted<{ items: (FeedbackInput & { same_as?: string })[] }>(async ({ items }) => {
        const deps = state.feedback
        if (!deps) return json({ ok: false, error: "要望の道具は今使えません" })
        const listed = state.feedbackListed
        if (!listed) return json({ ok: false, error: "先に list_feedback で今の要望を読んでください（同じ要望なら same_as で件数を足す）。" })
        const left = MAX_FEEDBACK_PER_TURN - state.feedbackRecorded.length
        if (items.length > left) return json({ ok: false, error: `要望は1回の指示で${MAX_FEEDBACK_PER_TURN}件までです（あと${left}件）。` })
        const ids = items.flatMap((i) => (i.same_as === undefined ? [] : [i.same_as]))
        const unknown = ids.filter((id) => !listed.has(id) || state.feedbackRecorded.some((r) => r.id === id))
        if (unknown.length || new Set(ids).size !== ids.length) return json({ ok: false, error: "same_as は list_feedback の要望の id を1回ずつ（この指示でまだ残していないもの）にしてください。", same_as: unknown })
        return guarded(async () => {
          const check = await feedbackCheck(deps)
          const words = [...new Set(items.flatMap(feedbackTexts).flatMap(check))]
          if (words.length)
            return json({ ok: false, error: "個人名・表の記号か、顧客名・注文者・工事名の語が入っています。何も残していません。名前を挙げずに一般化して書き直してください。", words })
          const done: { kind: FeedbackInput["kind"]; want: string; added: boolean }[] = []
          const closed: string[] = []
          for (const { same_as, ...input } of items) {
            if (same_as !== undefined) {
              // 閉じた（対応した・しない）要望には足さない。仮の文のまま新しい行にもしない（AI に書き直してもらう）
              if (!(await deps.bump(same_as))) {
                closed.push(same_as)
                continue
              }
              state.feedbackRecorded.push({ id: same_as, kind: input.kind, added: false })
            } else state.feedbackRecorded.push({ id: await deps.add(input), kind: input.kind, added: true })
            done.push({ kind: input.kind, want: input.want, added: same_as === undefined })
          }
          if (done.length) state.log.push({ tool: "record_feedback", summary: done.map((r) => `${FEEDBACK_KIND_LABELS[r.kind]}${r.added ? "" : "（件数を足す）"}: ${r.want}`).join(" / ") })
          return json({
            ok: closed.length === 0,
            added: done.filter((r) => r.added).length,
            counted: done.filter((r) => !r.added).length,
            ...(closed.length
              ? { closed, error: "same_as の要望はもう閉じています（対応した・しない）。新しい要望として残すなら、same_as を外して want・did・idea を書いて送り直してください。" }
              : { note: "要望として残しました。職員への返事を続けてください。" }),
          })
        })
      }),
    }),
    propose_inquiry: tool({
      description:
        "顧客への問い合わせメールの件名と前置きの案を出す（表は変えない）。subject: メールの件名、intro: 本文の前置き（1〜3文）。聞くことは添付の Excel の色付きのセルとメモで伝わり、項目ごとの件数・記入のしかた・宛名・挨拶・結びは画面が付ける。" +
        "個人名・表の記号・ほかの顧客の名前は書かない（入っていれば受け取らない）。JSON 文字列 {ok} を返す。職員が承認するとメールの件名と前置きに使う。",
      inputSchema: z.strictObject({ subject: subjectSchema, intro: introSchema }),
      execute: counted<{ subject: string; intro: string }>(({ subject, intro }) =>
        guarded(async () => {
          const texts = [subject, intro]
          const named = await personal(texts)
          if (named.length) return json({ ok: false, error: "個人名か表の記号（〔Ａ〕〔個人名〕など）が入っている文があります。何も出していません。名前を書かずに書き直してください。", items: named.map(textName) })
          const others = otherCustomerTest(state.inquiry ? await state.inquiry.otherCustomers() : [], state.inquiry?.customerName)
          const leaked = texts.flatMap((t, i) => (others(t) ? [i] : []))
          if (leaked.length) return json({ ok: false, error: "ほかの顧客の名前が入っている文があります。何も出していません。", items: leaked.map(textName) })
          // 件名と前置きは1つ（2回目は前の案を置き換える）
          state.pending = state.pending.filter((c) => c.kind !== "inquiryMail")
          state.pending.push({ kind: "inquiryMail", subject, intro })
          state.log.push({ tool: "propose_inquiry", summary: "メールの件名と前置き" })
          return json({ ok: true })
        }),
      ),
    }),
    get_review: tool({
      description:
        "案件を終えるときの振り返りの材料を JSON 文字列で返す: {instructions:[{n, text, result（承認の結果）, question?, answer?, plan?（承認の対象になった列の対応の変更）, selection?, tools?}], edits:[{field, label, counts（出どころごとの数）, examples:[{by, before（変換の値）, after（今の値）}]}], replacements, manual, addedRows, settings, rows, pendingReview（まだ決めていない前の振り返りの案。重ねて出さない）}。" +
        `個人名は〔個人名〕に伏せてある。result が「${UNKNOWN_RESULT}」の指示は決まりの根拠にしない。`,
      inputSchema: z.strictObject({}),
      execute: counted<object>(async () => {
        const review = state.review
        const turns = review ? await review.turns() : "振り返りの材料は今使えません"
        if (typeof turns === "string") return json({ ok: false, error: turns })
        return guarded(async () => {
          state.log.push({ tool: "get_review", summary: `${turns.length}回の指示` })
          const { pending } = await review!.taken()
          return json({ ...reviewMaterial({ turns, table: state.current, view: view(), hide: (await guard()).hide }), pendingReview: pending })
        })
      }),
    }),
    propose_review: tool({
      description:
        `振り返りの結果を出す。yearly: 来年もこの顧客に毎年当てはまる決まり（顧客ルールに足す案。1つの決まりを1項目、${MAX_RULE_ITEM_LENGTH}字まで。evidence は元にした指示の番号・手直し）。` +
        "one_off: 今年だけの事情・一度きりの直し（ルールにしない。返事で職員に伝える）。個人名・表の記号は書かない（入っていれば何も受け取らない）。職員が項目ごとに承認すると顧客ルールに足す。",
      inputSchema: z.strictObject({
        yearly: z.array(z.strictObject({ text: ruleItem, evidence: z.string().max(500) })).max(MAX_REVIEW_RULES),
        one_off: z.array(z.string().min(1).max(500)).max(MAX_REVIEW_NOTES),
      }),
      execute: counted<{ yearly: { text: string; evidence: string }[]; one_off: string[] }>(({ yearly, one_off }) =>
        guarded(async () => {
          const named = await personal(yearly.map((y) => y.text))
          if (named.length) return json({ ok: false, error: NAME_REFUSAL, yearly: named })
          // 今の顧客ルール・まだ決めていない振り返りの案（ほかのタブで出したものも）・この指示で出した案と同じ項目は重ねない
          const taken = state.review ? await state.review.taken() : { rules: [], pending: [] }
          const seen = [...taken.rules, ...taken.pending, ...state.pending.flatMap((c) => (c.kind === "rule" && c.scope === "customer" ? [c.text] : []))]
          const added: typeof yearly = []
          const skipped: string[] = []
          for (const y of yearly) {
            if (seen.some((t) => sameRuleText(t, y.text))) skipped.push(y.text)
            else {
              added.push(y)
              seen.push(y.text)
            }
          }
          for (const y of added) state.pending.push({ kind: "rule", scope: "customer", text: y.text, source: "review" })
          state.oneOff.push(...one_off)
          state.log.push({ tool: "propose_review", summary: [...added.map((y) => `毎年: ${y.text}（${y.evidence}）`), ...skipped.map((t) => `重ねない: ${t}`), ...one_off.map((o) => `今年だけ: ${o}`)].join(" / ") })
          return json({
            ok: true,
            yearly: added.length,
            ...(skipped.length ? { skipped, skippedNote: "今の顧客ルールか、まだ決めていない振り返りの案と同じなので出していません" } : {}),
            oneOff: one_off.length,
            note: "返事で、足す案の数と今年だけの事情（ルールにしないもの）を分けて伝えてください。",
          })
        }),
      ),
    }),
  }
}

/**
 * 手書き・画像から読んだ値の手直し（set_cells・record_answers）: セルのメモの前に IMAGE_READ_NOTE を付け、要確認（warning）にする。
 * 要確認は「直す」に出て、職員が元のファイルと見比べて「これでよい」で片付ける（読み違いを確かめないまま CSV に出さない）。
 * 推定（guessed）にはしないので、顧客への問い合わせには回らない（読み違いは事務所で確かめる）。エラーの値はエラーのまま
 */
function imageEdit(edit: CellEdit): CellEdit {
  const message = withImageNote("image", edit.message)
  return { ...edit, ...(edit.status === "error" ? {} : { status: "warning" as const }), message }
}

/** 要望に入れない、案件の工事名とその注文者 */
const caseWorks = (view: TableView) => view.shown.map((r) => ({ client: r.cells.client.value, workName: r.cells.workName.value }))

/** propose_inquiry の文の番号（0 は件名、1 は前置き）を AI に返す名前にする */
const textName = (i: number) => (i === 0 ? "subject" : "intro")

/**
 * record_answers の結果（AI に返す）。answered は問い合わせへの答え、corrected は聞いていない項目の訂正（職員にも分けて伝える）。
 * 顧客の答えはそのまま返さず、読めなかった答えだけを返す（AI が送ったもの）
 */
function answerResult(r: AiAnswerReport) {
  const at = (q: { rowKey: string; field: KojiFieldId }) => ({ key: q.rowKey, field: q.field })
  return {
    answered: r.applied.map(at),
    confirmed: r.confirmed.map(at),
    corrected: r.alsoChanged.map(at),
    same: r.alreadyApplied.length,
    invalid: [...r.invalid.map((i) => ({ ...at(i.inquiry), answer: i.answer, message: i.message })), ...r.uncorrected.map((u) => ({ ...at(u), answer: u.answer, message: u.message }))].slice(0, 50),
    needsCheck: r.needsCheck.slice(0, 50).map((c) => ({ ...at(c), message: c.message })),
    heldBack: r.heldBack.map(at),
    unknownKeys: r.unknownKeys,
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
      // この往復で見せたファイルは、次の API の呼び出しで初めて送る（API が断ったら、そのファイルを見られないと覚える）
      if (args.state.view) viewStepFinished(args.state.view)
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
 * キャッシュの区切りを付けられる道具の呼び出しと結果: コード実行と、直接呼ぶ view_file（見せたファイルは大きいので、
 * 結果の直後に区切りを置き、以後の往復でキャッシュから読む）
 */
const CACHEABLE_TOOLS: ReadonlySet<string> = new Set(["code_execution", "view_file"])

/**
 * 最後の文章かコード実行・view_file のブロックにキャッシュの区切りを付ける。コードから呼んだ道具の呼び出しと結果には付けられない
 * （Claude の文脈に入らないブロックなので 400 になる）
 */
export function withCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "user" && typeof m.content === "string") return replaceAt(messages, i, { ...m, content: [{ type: "text", text: m.content, providerOptions: CACHE }] })
    // tool は直接呼んだ道具の結果（view_file の結果に区切りを付ける。コードから呼んだ道具の結果は CACHEABLE_TOOLS に無いので付けない）
    if ((m.role !== "user" && m.role !== "assistant" && m.role !== "tool") || typeof m.content === "string") continue
    const parts = m.content as { type: string; toolName?: string; providerOptions?: unknown }[]
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]!
      const ok = p.type === "text" || ((p.type === "tool-call" || p.type === "tool-result") && CACHEABLE_TOOLS.has(p.toolName ?? ""))
      if (ok) return replaceAt(messages, i, { ...m, content: replaceAt(parts, j, { ...p, providerOptions: CACHE }) } as ModelMessage)
    }
  }
  return messages
}


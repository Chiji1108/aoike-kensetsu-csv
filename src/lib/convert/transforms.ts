import { GYOSHU } from "../spec/code-sets"
import { isPrefecture, leadingPrefecture, prefectureFromShortName } from "../spec/prefectures"
import { valueTypeKey, type ValueType, type ValueTypeKey } from "../spec/types"
import { addressKey, type AddressBook } from "./address"
import type { AiItemResult, AiTaskId } from "./ai-tasks"
import { formatYearMonth, parsePeriod, parseYearMonth } from "./dates"
import { placePersons } from "./persons"
import { collapseSpaces, matchKey, nfkc, removeSpaces, toFullWidth } from "./text"

export type Rounding = "floor" | "round"
export type TransformContext = {
  rounding: Rounding
  /** 住所の値を引いた結果（address.ts の lookupAddresses）。引いていない値の住所の変換は AI に回す */
  addresses: AddressBook
  /** 案件の中で空白で区切って書かれた氏名（空白を除いた氏名 → 「姓　名」）。区切りの無い同じ氏名をこれに合わせる */
  knownNames?: ReadonlyMap<string, string>
}

export type RuleOutcome =
  | { kind: "value"; value: string; message?: string; warning?: boolean }
  /** ルールで決まらない。transform.ai の判断に回す */
  | { kind: "ai"; reason: string }
  | { kind: "error"; message: string }

/** 個人名は value の中に印（persons.ts の personToken）で入れる。記号への置き換えは finalizeRows */
export type AiApplied = { value: string; status: "ai" | "warning" | "error"; message?: string; guessed?: true; withheld?: true }

/**
 * AI の結果が無い（未実行・失敗した）ときのセル。
 * raw: 元の値を要確認で残す。empty: 空を要確認で残す（元データには値があるので withheld。顧客には聞かず、職員が変換をやり直すか直す）。
 * unknown: 空を要確認で残す（元データに無い値を推定する変換。推定できなければデータに無いのと同じなので、顧客に聞く）。
 * guessed: 元の値を推定として残す（顧客に確かめる）。withheld: 個人名が CSV に出ないよう空にしてエラー（検算に落ちたときと同じく職員が直す）
 */
export type WithoutAi = "raw" | "empty" | "unknown" | "guessed" | "withheld"

export const WITHOUT_AI: Record<WithoutAi, (raw: string, why: { reason: string; error: string }) => AiApplied> = {
  raw: (raw, why) => ({ value: raw, status: "warning", message: `${why.reason}ため要確認（AI 変換できず: ${why.error}）` }),
  empty: (_raw, why) => ({ value: "", status: "warning", message: `${why.reason}ため要確認（AI 変換できず: ${why.error}）`, withheld: true }),
  unknown: (_raw, why) => ({ value: "", status: "warning", message: `${why.reason}ため要確認（AI 変換できず: ${why.error}）` }),
  guessed: (raw, why) => ({ value: raw, status: "warning", message: `${why.reason}ため要確認（AI 変換できず: ${why.error}）`, guessed: true }),
  withheld: (_raw, why) => ({ value: "", status: "error", message: `個人名の判定ができませんでした。手で入力してください（AI 変換できず: ${why.error}）`, withheld: true }),
}

type AiStep = {
  task: AiTaskId
  /** AI の結果を検算してセルの値にする */
  apply: (raw: string, result: AiItemResult) => AiApplied
  withoutAi: WithoutAi
  /** AI に送る値（既定は列の値を空白でつないだもの）。AI が使えなかったときに残す値にもなる */
  input?: (inputs: string[]) => string
}

export type Transform = {
  id: string
  label: string
  kind: "rule" | "ai"
  accepts: readonly ValueTypeKey[]
  /** accepts の型のうち、さらに使える項目を絞る（無ければ accepts の型の項目すべて） */
  fits?: (vt: ValueType) => boolean
  /**
   * 個人名を印にする変換か（name: 値そのものが氏名かもしれない、residence: 「〇〇様邸」の形）。
   * 個人名を含みうる項目（valueType の person）には、その形を匿名化する変換しか使えない（transformFits）
   */
  anonymizes?: "name" | "residence"
  /** 複数の列（例: 姓列+名列、区分列+注文者列）を受け取れる */
  multiColumn?: boolean
  /** 最初の列の値を住所として引いた結果（ctx.addresses）を読む。変換の前にその値を引いておく（pipeline.ts の addressBookFor） */
  readsAddress?: true
  run: (inputs: string[], ctx: TransformContext) => RuleOutcome
  ai?: AiStep
  /**
   * この変換のうち、値だけを見て整える部分（元データの列の形・指示文に頼らない）。
   * 顧客の記入には、計画がこの変換を使っていればこれを当ててから欄の変換（匿名化など）に通す。無い変換は記入に当てない
   */
  cleanAnswer?: (answer: string) => string
}

function aiStep<T extends AiTaskId>(
  task: T,
  apply: (raw: string, result: AiItemResult<T>) => AiApplied,
  withoutAi: WithoutAi = "raw",
  input?: AiStep["input"],
): AiStep {
  // AI_TASKS[task].item で検証済みの結果だけが渡されるので、task ごとの型に戻してよい
  return { task, apply: apply as AiStep["apply"], withoutAi, input }
}

const value = (v: string, message?: string): RuleOutcome => ({ kind: "value", value: v, message })
const toAi = (reason: string): RuleOutcome => ({ kind: "ai", reason })
const fail = (message: string): RuleOutcome => ({ kind: "error", message })

function reviewed(r: { needsReview: boolean; note: string }, v: string, message?: string): AiApplied {
  if (r.needsReview) return { value: v, status: "warning", message: ["AIの判断に要確認", r.note].filter(Boolean).join(": ") }
  return { value: v, status: "ai", message }
}

const join = (inputs: string[]) => inputs.map((s) => s.trim()).filter(Boolean).join(" ")

const FLAG_ON_RE = /^(1|有|有り|あり|アリ|○|〇|◯|●|◎|✓|✔|レ|済|YES|Y|JV)$/i
const FLAG_OFF_RE = /^(0|無|無し|なし|ナシ|-|ー|×|✕|否|NO|N)$/i

/** 「○」「✓」「1」など、有りを表す記号か */
export function isFlagOn(raw: string) {
  return FLAG_ON_RE.test(nfkc(raw))
}

/** 全角にそろえる（前の版の保存済みの計画の rule.fullWidthText だけが使う） */
function fullWidthText(raw: string) {
  return toFullWidth(collapseSpaces(raw))
}

/** 空白で区切られた氏名を「姓　名」に（区切りが無ければそのまま） */
export function normalizePersonName(raw: string) {
  return collapseSpaces(raw).split(" ").filter(Boolean).join("　")
}

/** 氏名の候補から、空白1つで区切られたものの区切りを集める。同じ氏名に違う区切りがあれば決められないので入れない */
export function knownNameSplits(names: Iterable<string>): Map<string, string> {
  const splits = new Map<string, string | null>()
  for (const name of names) {
    const parts = collapseSpaces(name).split(" ").filter(Boolean)
    if (parts.length !== 2) continue
    const key = parts.join("")
    const split = parts.join("　")
    splits.set(key, splits.has(key) && splits.get(key) !== split ? null : split)
  }
  return new Map([...splits].filter((e): e is [string, string] => e[1] !== null))
}

/** 複数の列を区切りなしでつなぎ、空白と先頭の「(仮称)」を除く */
export function joinWorkName(inputs: string[]) {
  return removeSpaces(inputs.join("")).replace(/^[(（]仮称[)）]/, "")
}

/** 個人名を含むかもしれない工事名（「模様替」「住宅」などは除く） */
export const PERSONAL_WORK_NAME_RE = /邸|(?<!模)様|(?<![住社])宅/

// ---- 判定に使う語彙 ----

const ORGANIZATION_RE =
  /株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|㈱|㈲|法人|組合|協会|協同|公社|機構|事業団|財団|社団|学校|学園|大学|病院|医院|クリニック|銀行|信用金庫|工業|建設|工務|産業|商事|商会|商店|興業|製作所|研究所|工場|不動産|電気|設備|開発|企画|ホールディングス|コーポレーション|ハウス|ホーム|ビル|店$|組$|支社|支店|営業所|事務所|センター|ホテル|マンション/
const PUBLIC_RE = /国土交通|防衛|省|庁|役所|役場|自衛隊|国立|[都道府県市区町村]立|公立|機構|公社|事業団/
/** 自治体の名（「千代田区」「北海道」）。2字の市区町村名（「北区」）は自治体として扱う（官公庁元請の見分け） */
const MUNICIPALITY_RE = /^.{1,4}[都道府県]$|^.{1,6}[市区町村]$|^.{2,4}[都道府県].{1,6}[市区町村]$/
/** 個人ではないと決めてよい自治体の名。2字の市区町村名は「中村」「町田」のような姓と区別できないので入れない（個人かもしれないものとして扱う） */
const SURELY_MUNICIPALITY_RE = /^.{1,4}[都道府県]$|^.{2,6}[市区町村]$|^.{2,4}[都道府県].{1,6}[市区町村]$/

/** 法人・団体・官公庁の名らしいか（変換の匿名化と、個人名らしい値の検査の両方がこれで見分ける） */
export function looksLikeOrganization(name: string) {
  const s = removeSpaces(nfkc(name)).replace(/様$/, "")
  return ORGANIZATION_RE.test(s) || PUBLIC_RE.test(s) || SURELY_MUNICIPALITY_RE.test(s)
}

function looksPublic(name: string) {
  const s = nfkc(name)
  return (PUBLIC_RE.test(s) || MUNICIPALITY_RE.test(s)) && !/株式会社|有限会社|合同会社|\(株\)|㈱/.test(s)
}

/** 「官庁物件」「民間物件」のような官民の区分だけの値 */
const KANMIN_RE = /^(官公庁|官庁|公共|官|民間|民)(物件|工事|発注)?$/

// ---- 業種 ----

const GYOSHU_INDEX = new Map<string, string>()
for (const g of GYOSHU) {
  for (const name of [g.label, ...g.aliases]) GYOSHU_INDEX.set(matchKey(name), g.code)
}

export function gyoshuCode(raw: string): string | undefined {
  const s = nfkc(raw)
  if (/^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 30) return String(Number(s))
  const key = matchKey(s).replace(/(工事業|工事|業)$/, "")
  return GYOSHU_INDEX.get(key) ?? GYOSHU_INDEX.get(key.replace(/一式$/, ""))
}

// ---- 金額 ----

/** 金額の表記 → 数値（円単位なら円、千円単位なら千円のまま）。「千円」「万円」の接尾辞は単位として読む */
function parseAmount(raw: string): { amount: number; unit: "yen" | "thousandYen" | "unknown" } | undefined {
  let s = nfkc(raw).replace(/[,\s¥\\]/g, "")
  let unit: "yen" | "thousandYen" | "unknown" = "unknown"
  let factor = 1
  if (/千円$/.test(s)) [unit, s] = ["thousandYen", s.replace(/千円$/, "")]
  else if (/万円?$/.test(s)) [unit, factor, s] = ["yen", 10_000, s.replace(/万円?$/, "")]
  else if (/円$/.test(s)) [unit, s] = ["yen", s.replace(/円$/, "")]
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined
  return { amount: Number(s) * factor, unit }
}

function roundThousand(yen: number, rounding: Rounding) {
  const t = yen / 1000
  return rounding === "floor" ? Math.floor(t + 1e-9) : Math.round(t)
}

function yenToThousand(yen: number, ctx: TransformContext): RuleOutcome {
  const thousand = roundThousand(yen, ctx.rounding)
  const remainder = Math.round(yen % 1000)
  const message =
    remainder === 0
      ? undefined
      : `千円未満（${remainder}円）を${ctx.rounding === "floor" ? "切り捨て" : "四捨五入"}`
  return value(String(thousand), message)
}

// ---- 登録表 ----

export const TRANSFORMS = {
  "rule.text": {
    id: "rule.text",
    label: "そのまま（空白を整える）",
    kind: "rule",
    accepts: ["text", "personName"],
    multiColumn: true,
    run: (inputs) => value(collapseSpaces(join(inputs))),
    cleanAnswer: collapseSpaces,
  },
  "rule.fullWidthText": {
    id: "rule.fullWidthText",
    label: "全角にする（使わない）",
    kind: "rule",
    accepts: ["text"],
    // どの項目にも使わない（元データの表記〔半角カナ・半角スペース・㈱など〕は変えない）。前の版で保存した計画を読めるようにだけ残す。
    // 保存済みの計画に残っていれば reviewPlanTransforms がその項目の決まった変換に替える
    fits: () => false,
    multiColumn: true,
    run: (inputs) => value(fullWidthText(join(inputs))),
    cleanAnswer: fullWidthText,
  },
  "rule.gyoshu": {
    id: "rule.gyoshu",
    label: "業種名 → 業種コード",
    kind: "rule",
    accepts: ["code:gyoshu"],
    run: ([raw = ""]) => {
      const code = gyoshuCode(raw)
      return code ? value(code) : toAi("業種名が表に無い")
    },
    ai: aiStep("gyoshu", (_raw, r) => {
      const code = gyoshuCode(r.value)
      if (!code || code !== nfkc(r.value)) return { value: "", status: "error", message: `AIの業種コード「${r.value}」が1〜30ではありません` }
      return reviewed(r, code)
    }),
  },
  "rule.motoukeShitauke": {
    id: "rule.motoukeShitauke",
    label: "元請/下請（＋官民の区分か注文者で官公庁か判定）",
    kind: "rule",
    accepts: ["code:motoukeShitauke"],
    multiColumn: true,
    run: ([kubun = "", ...rest]) => {
      const s = nfkc(kubun)
      if (/^[012]$/.test(s)) return value(s)
      if (/下請|二次|2次|孫請/.test(s)) return value("2")
      if (/官公庁|公共|官庁/.test(s)) return value("0")
      if (/民間/.test(s)) return value("1")
      const sector = rest.map((r) => removeSpaces(nfkc(r))).find((r) => KANMIN_RE.test(r))
      const client = rest.filter((r) => !KANMIN_RE.test(removeSpaces(nfkc(r)))).join(" ")
      if (/元請|元受|直/.test(s) && sector) return value(/^民/.test(sector) ? "1" : "0")
      if (/元請|元受|直/.test(s)) {
        if (!client.trim()) return { kind: "value", value: "1", warning: true, message: "注文者が無いため民間元請(1)としました" }
        if (looksPublic(client)) return value("0", "注文者が官公庁のため官公庁元請")
        return value("1", looksLikeOrganization(client) ? undefined : "注文者が官公庁ではないため民間元請")
      }
      return fail(`「${kubun}」を元請/下請に読み替えられません`)
    },
  },
  "rule.flag01": {
    id: "rule.flag01",
    label: "有無 → 0/1",
    kind: "rule",
    accepts: ["flag"],
    run: ([raw = ""]) => {
      const s = nfkc(raw)
      if (FLAG_OFF_RE.test(s)) return value("0")
      if (FLAG_ON_RE.test(s)) return value("1")
      return fail(`「${raw}」を 0/1 に読み替えられません`)
    },
  },
  "rule.yenToThousand": {
    id: "rule.yenToThousand",
    label: "円 → 千円",
    kind: "rule",
    accepts: ["thousandYen"],
    run: ([raw = ""], ctx) => {
      const a = parseAmount(raw)
      if (!a) return fail(`「${raw}」を金額として読めません`)
      if (a.unit === "thousandYen") return yenToThousand(a.amount * 1000, ctx)
      return yenToThousand(a.amount, ctx)
    },
  },
  "rule.thousandYen": {
    id: "rule.thousandYen",
    label: "千円のまま",
    kind: "rule",
    accepts: ["thousandYen"],
    run: ([raw = ""], ctx) => {
      const a = parseAmount(raw)
      if (!a) return fail(`「${raw}」を金額として読めません`)
      return yenToThousand(a.unit === "yen" ? a.amount : a.amount * 1000, ctx)
    },
  },
  "rule.yearMonth": {
    id: "rule.yearMonth",
    label: "日付 → 年月（YYYYMM）",
    kind: "rule",
    accepts: ["yearMonth"],
    run: ([raw = ""]) => {
      const ym = parseYearMonth(raw)
      return ym ? value(formatYearMonth(ym)) : toAi("日付の表記を読めない")
    },
    ai: aiStep("yearMonth", (_raw, r) => {
      const ym = parseYearMonth(r.value)
      if (r.value && (!ym || formatYearMonth(ym) !== r.value)) return { value: "", status: "error", message: `AIの年月「${r.value}」が YYYYMM ではありません` }
      return reviewed(r, r.value)
    }, "empty"),
  },
  "rule.periodStart": {
    id: "rule.periodStart",
    label: "工期 → 着工年月",
    kind: "rule",
    accepts: ["yearMonth"],
    run: ([raw = ""]) => {
      const p = parsePeriod(raw)
      if (p?.start) return value(formatYearMonth(p.start))
      const single = parseYearMonth(raw)
      return single && !p ? value(formatYearMonth(single)) : toAi("工期の表記を読めない")
    },
    ai: aiStep("period", (_raw, r) => periodSide(r, r.start), "empty"),
  },
  "rule.periodEnd": {
    id: "rule.periodEnd",
    label: "工期 → 完成年月",
    kind: "rule",
    accepts: ["yearMonth"],
    run: ([raw = ""]) => {
      const p = parsePeriod(raw)
      if (p?.end) return value(formatYearMonth(p.end))
      return toAi("工期の表記を読めない")
    },
    ai: aiStep("period", (_raw, r) => periodSide(r, r.end), "empty"),
  },
  "rule.prefecture": {
    id: "rule.prefecture",
    label: "都道府県名を正式名に",
    kind: "rule",
    accepts: ["prefecture"],
    run: ([raw = ""]) => {
      const s = removeSpaces(nfkc(raw))
      const p = prefectureFromShortName(s) ?? leadingPrefecture(s)
      return p ? value(p) : fail(`「${raw}」は都道府県名ではありません`)
    },
  },
  "rule.addressPrefecture": {
    id: "rule.addressPrefecture",
    label: "住所 → 都道府県",
    kind: "rule",
    accepts: ["prefecture"],
    readsAddress: true,
    run: ([raw = ""], ctx) => {
      const prefecture = ctx.addresses.get(addressKey(raw))?.prefecture
      return prefecture ? value(prefecture) : toAi("住所に都道府県が無い")
    },
    ai: aiStep("splitAddress", (raw, r) => {
      const check = verifyAddress(raw, r)
      return check.ok ? reviewed(r, r.prefecture, check.message) : { value: "", status: "error", message: check.message }
    }, "empty"),
  },
  "rule.addressCity": {
    id: "rule.addressCity",
    label: "住所 → 市区町村",
    kind: "rule",
    accepts: ["text"],
    readsAddress: true,
    run: ([raw = ""], ctx) => {
      const city = ctx.addresses.get(addressKey(raw))?.city
      return city ? value(city) : toAi("住所から市区町村を切り出せない")
    },
    ai: aiStep("splitAddress", (raw, r) => {
      const check = verifyAddress(raw, r)
      return check.ok ? reviewed(r, r.city, check.message) : { value: raw, status: "error", message: check.message }
    }),
  },
  "rule.personNameSpace": {
    id: "rule.personNameSpace",
    label: "氏名（姓と名の間を全角スペースに）",
    kind: "rule",
    accepts: ["personName"],
    multiColumn: true,
    run: (inputs, ctx) => {
      const parts = inputs.flatMap((s) => collapseSpaces(s).split(" ")).filter(Boolean)
      if (parts.length === 2) return value(parts.join("　"))
      if (parts.length > 2) return { kind: "value", value: parts.join("　"), warning: true, message: "区切りが3つ以上あります" }
      const known = ctx.knownNames?.get(parts.join(""))
      return known ? value(known, "同じファイル内の表記に合わせた") : toAi("姓と名の区切りが無い")
    },
    ai: aiStep("personName", (raw, r) => {
      if (removeSpaces(r.value) !== removeSpaces(raw))
        return { value: raw, status: "error", message: `検算エラー: AIの結果「${r.value}」が元の氏名と一致しません` }
      if (!/^[^\s　]+　[^\s　]+$/.test(r.value))
        return { value: raw, status: "error", message: `検算エラー: 「${r.value}」は姓と名の間に全角スペース1つの形ではありません` }
      return { ...reviewed(r, r.value), ...(r.needsReview ? { guessed: true as const } : {}) }
    }, "guessed"),
  },
  "ai.anonymizeClient": {
    id: "ai.anonymizeClient",
    label: "注文者（個人なら「Ａ」等に）",
    kind: "ai",
    accepts: ["text"],
    anonymizes: "name",
    run: ([raw = ""]) => {
      const name = collapseSpaces(raw)
      return looksLikeOrganization(name) ? value(name) : toAi("個人か法人か判定が必要")
    },
    ai: aiStep("anonymizeClient", (raw, r) => anonymized(raw, r, collapseSpaces), "withheld"),
  },
  "ai.anonymizeWorkName": {
    id: "ai.anonymizeWorkName",
    label: "工事名（個人名を「Ａ」等に）",
    kind: "ai",
    accepts: ["text"],
    anonymizes: "residence",
    run: ([raw = ""]) => {
      const name = collapseSpaces(raw)
      return PERSONAL_WORK_NAME_RE.test(name) ? toAi("個人名を含むかもしれない") : value(name)
    },
    ai: anonymizeWorkNameStep(),
  },
  "rule.joinWorkName": {
    id: "rule.joinWorkName",
    label: "工事名（列をつなぎ、空白と「(仮称)」を除く）",
    kind: "rule",
    accepts: ["text"],
    anonymizes: "residence",
    multiColumn: true,
    run: (inputs) => {
      const name = joinWorkName(inputs)
      return PERSONAL_WORK_NAME_RE.test(name) ? toAi("個人名を含むかもしれない") : value(name)
    },
    ai: anonymizeWorkNameStep(joinWorkName),
    cleanAnswer: (answer) => joinWorkName([answer]),
  },
  "ai.inferPrefecture": {
    id: "ai.inferPrefecture",
    label: "現場名・注文者から都道府県を推定",
    kind: "ai",
    accepts: ["prefecture"],
    multiColumn: true,
    run: () => toAi("所在地が元データに無い"),
    ai: aiStep(
      "inferLocation",
      (_raw, r) =>
        isPrefecture(r.prefecture)
          ? inferred(r, r.prefecture)
          : {
              value: "",
              status: "error",
              message: r.prefecture ? `AIの都道府県「${r.prefecture}」が47都道府県名と一致しません` : "現場名から都道府県を推定できませんでした",
            },
      "unknown",
      locationInput,
    ),
  },
  "ai.inferPlace": {
    id: "ai.inferPlace",
    label: "現場名・注文者から場所名を推定",
    kind: "ai",
    accepts: ["text"],
    multiColumn: true,
    run: () => toAi("所在地が元データに無い"),
    ai: aiStep("inferLocation", (_raw, r) => inferred(r, isPrefecture(r.prefecture) && r.place.startsWith(r.prefecture) ? r.place.slice(r.prefecture.length) : r.place), "unknown", locationInput),
  },
  "ai.freeform": {
    id: "ai.freeform",
    label: "AI（指示文で変換）",
    kind: "ai",
    accepts: ["code:gyoshu", "code:motoukeShitauke", "text", "prefecture", "thousandYen", "yearMonth", "flag", "personName"],
    multiColumn: true,
    run: () => toAi("指示文で変換"),
    ai: aiStep("freeform", (_raw, r) => reviewed(r, r.value)),
  },
} as const satisfies Record<string, Transform>

export type TransformId = keyof typeof TRANSFORMS
export const TRANSFORM_IDS = Object.keys(TRANSFORMS) as [TransformId, ...TransformId[]]

export function getTransform(id: TransformId): Transform {
  return TRANSFORMS[id]
}

/** 変換がその型の項目に使えるか。個人名を含みうる項目（person）には、その形を匿名化する変換だけ（柔軟さと引き換えにしない） */
export function transformFits(t: Transform, vt: ValueType) {
  if (!t.accepts.includes(valueTypeKey(vt)) || !(t.fits?.(vt) ?? true)) return false
  return vt.type !== "text" || !vt.person || t.anonymizes === vt.person
}

/**
 * 項目に使える変換のうち、最初に選ぶもの（計画の表で取り込み元を変えたとき・保存済みの計画の使えない変換を替えるとき）。
 * 個人名を含みうる項目は匿名化する変換（登録表の順）、ほかはルールの変換を先に。multi なら複数の列を受け取れるものだけ
 */
export function preferredTransform(vt: ValueType, multi: boolean): TransformId {
  const usable = transformsFor(vt).filter((t) => !multi || t.multiColumn)
  const pick = vt.type === "text" && vt.person ? usable[0] : (usable.find((t) => t.kind === "rule") ?? usable[0])
  return (pick?.id ?? "ai.freeform") as TransformId
}

export function transformsFor(vt: ValueType): Transform[] {
  return Object.values(TRANSFORMS).filter((t: Transform) => transformFits(t, vt))
}

function anonymizeWorkNameStep(input?: AiStep["input"]) {
  return aiStep(
    "anonymizeWorkName",
    (raw, r) => anonymized(raw, r, collapseSpaces),
    "withheld",
    input,
  )
}

/**
 * 匿名化の結果の検算（placePersons）。通れば個人名を印にした値を format で整える。
 * 通らなければ個人名が CSV に出ないよう値は空にし、元データにある値なので withheld（職員が直す）にする
 */
function anonymized(raw: string, r: AiItemResult<"anonymizeClient" | "anonymizeWorkName">, format: (v: string) => string): AiApplied {
  const withheld = (message: string): AiApplied => ({ value: "", status: "error", message: `${message}。元データの値を見て手で入力してください`, withheld: true })
  if (!r.value.trim()) return withheld("AIの結果が空です")
  const placed = placePersons(r.value, r.persons, raw)
  if (!placed.ok) return withheld(placed.message)
  return reviewed(r, format(placed.value))
}

function locationInput(inputs: string[]) {
  return collapseSpaces(join(inputs))
}

/** 所在地の推定のセルの文（AI が自信ありと答えたときは、この文だけになる。lib/location/sites.ts が自信のある推定を見分けるのに使う） */
export const INFERRED_NOTE = "現場名から推定"

/** 所在地の推定は検算できないので、AI が自信ありとしても要確認にする */
function inferred(r: AiItemResult<"inferLocation">, v: string): AiApplied {
  const message = [INFERRED_NOTE, r.needsReview ? r.note || "AIも要確認としています" : ""].filter(Boolean).join(": ")
  return { value: v.trim(), status: "warning", message, ...(r.needsReview ? { guessed: true as const } : {}) }
}

function periodSide(r: AiItemResult<"period">, side: string): AiApplied {
  const ym = side ? parseYearMonth(side) : undefined
  if (side && (!ym || formatYearMonth(ym) !== side)) return { value: "", status: "error", message: `AIの年月「${side}」が YYYYMM ではありません` }
  return reviewed(r, side)
}

/** 住所分割の検算: 都道府県+市区町村+残り = 元の住所（都道府県を補ったときは 市区町村+残り = 元の住所） */
export function verifyAddress(raw: string, r: AiItemResult<"splitAddress">): { ok: true; message?: string } | { ok: false; message: string } {
  const original = removeSpaces(raw)
  if (!isPrefecture(r.prefecture)) return { ok: false, message: `検算エラー: 「${r.prefecture}」は都道府県名ではありません` }
  const hadPrefecture = original.startsWith(r.prefecture)
  const joined = hadPrefecture ? r.prefecture + r.city + r.rest : r.city + r.rest
  if (joined !== original) return { ok: false, message: "検算エラー: AIの住所分割が元の住所と一致しません" }
  if (!r.city) return { ok: false, message: "検算エラー: 市区町村が空です" }
  return { ok: true, message: hadPrefecture ? undefined : `都道府県「${r.prefecture}」を補完` }
}

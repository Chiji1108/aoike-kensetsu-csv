import type { ModelMessage } from "ai"
import { z } from "zod"
import { editKey, type CellEdit } from "../convert/convert"
import { withNames } from "../convert/persons"
import { nfkc, removeSpaces } from "../convert/text"
import { tryParseJson } from "../json"
import { CODE_SETS } from "../spec/code-sets"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import type { ChatMessage } from "./messages"
import type { Proposal } from "./proposals"

/**
 * 2年目以降の最初の指示に添える、去年の案件のコード。去年のチャットで AI が書き、職員が承認した変更案（1項目でも）につながった
 * コード実行のコードを、去年の会話（画面の会話。会話を終えても残る）から取り出す。去年の案件を消すと一緒に無くなる（別には残さない）。
 * コードはそのまま実行せず、参考として AI に渡す。個人名は去年の案件で分かっている名前を〔個人名〕に置き換える。
 */

/** 表を変える道具（これを呼ぶコードだけを残す。表を読むだけのコードは今年の表で読み直せばよい） */
const CHANGE_TOOLS = ["set_cells", "set_include", "add_rows", "ask_customer"] as const
const CHANGE_CALL_RE = new RegExp(`\\b(${CHANGE_TOOLS.join("|")})\\s*\\(`)

/** AI に添えるコードの合計の文字数の上限（指示ごとに履歴に入るので抑える） */
export const MAX_CARRYOVER_CHARS = 30_000

/** コード実行の入力のうち、道具を呼べるコード（programmatic tool calling） */
const programmaticInput = z.object({ type: z.literal("programmatic-tool-call"), code: z.string() })

const changeCode = (input: unknown) => {
  const parsed = programmaticInput.safeParse(input)
  return parsed.success && CHANGE_CALL_RE.test(parsed.data.code) ? parsed.data.code.trim() : null
}

const unique = (codes: readonly string[]) => [...new Set(codes)]

/** 職員が1項目でも承認したチャットの変更案 */
export function approvedChatProposals(proposals: readonly Proposal[]): Set<string> {
  return new Set(proposals.filter((p) => p.origin.kind === "chat" && (p.state === "closed" ? p.applied > 0 : p.applied.length > 0)).map((p) => p.id))
}

/** 画面の会話から、承認した変更案の付いた返事のコード（表を変える道具を呼ぶもの）を、会話の順に */
export function codesFromUi(ui: readonly ChatMessage[], approved: ReadonlySet<string>): string[] {
  const codes: string[] = []
  for (const m of ui) {
    if (m.role !== "assistant" || !m.parts.some((p) => p.type === "data-proposal" && approved.has(p.data.id))) continue
    for (const p of m.parts) {
      if (p.type !== "tool-code_execution") continue
      const code = changeCode((p as { input?: unknown }).input)
      if (code) codes.push(code)
    }
  }
  return unique(codes)
}

/** AI に送った履歴から、表を変える道具を呼ぶコードを（照合のスクリプト用。照合では変更案をすべて承認したものとして扱う） */
export function codesFromModel(messages: readonly ModelMessage[]): string[] {
  const codes: string[] = []
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue
    for (const p of m.content) {
      if (p.type !== "tool-call" || p.toolName !== "code_execution") continue
      const code = changeCode(p.input)
      if (code) codes.push(code)
    }
  }
  return unique(codes)
}

/** 置き換える個人名の最短の長さ（1文字の姓などは地名・言葉と区別できないので置き換えない） */
const MIN_NAME_LENGTH = 2
/** これより長い値は氏名とみなさない（備考などが個人名の項目に入っていたとき） */
const MAX_NAME_LENGTH = 40
/** これ以下の長さの名前（姓だけなど）は、前後が文字でないときだけ置き換える（「山田町」「青池工務店」を壊さない） */
const SHORT_NAME_LENGTH = 2

/** 個人名の項目に入る、氏名でない値（置き換えると関係ないコードまで変わる） */
const NOT_NAMES = new Set(["なし", "無し", "未定", "不明", "未記入", "該当なし", "同上", "空欄"])

/**
 * 値の中の個人名（印の人）と、個人名の項目（配置技術者）の値を集める。names に足していく
 */
export function collectNames(names: Set<string>, value: string, isPersonField = false) {
  withNames(value, (name) => {
    names.add(name)
    return name
  })
  const plain = withNames(value, (name) => name).trim()
  if (isPersonField && plain && plain.length <= MAX_NAME_LENGTH && !NOT_NAMES.has(removeSpaces(nfkc(plain)))) names.add(plain)
}

/** 手直しの key（行の key:項目）が個人名の項目か */
const isPersonEditKey = (key: string) => [...PERSON_FIELDS].some((f) => key.endsWith(editKey("", f)))

type Edits = readonly (readonly [string, CellEdit])[]

/** 表（変換した行と手直し）の人: 印の人と配置技術者 */
function collectTableNames(names: Set<string>, table: { rows: readonly { cells: Partial<Record<KojiFieldId, { value: string }>> }[]; edits: Edits }) {
  for (const r of table.rows) for (const [f, c] of Object.entries(r.cells)) if (c) collectNames(names, c.value, PERSON_FIELDS.has(f as KojiFieldId))
  for (const [key, e] of table.edits) collectNames(names, e.value, isPersonEditKey(key))
}

/**
 * 去年のコードから消す個人名を集める（ここ1つで集める）。去年の作業と AI の結果（namesOfCase）、画面が去年の元の Excel から読んだ配置技術者の列の値、
 * 今年の表の人（同じ技術者が毎年いる）。氏名でない値（「なし」「同上」など）・長すぎる値は名前にしない
 */
export function namesForCarryover(from: {
  previous?: { work: Parameters<typeof namesOfCase>[0]; aiCache: Parameters<typeof namesOfCase>[1] }
  previousEngineers?: readonly string[]
  current?: Parameters<typeof collectTableNames>[1]
}): Set<string> {
  const names = from.previous ? namesOfCase(from.previous.work, from.previous.aiCache) : new Set<string>()
  for (const v of from.previousEngineers ?? []) collectNames(names, v, true)
  if (from.current) collectTableNames(names, from.current)
  return names
}

/**
 * 「去年のやり方で直す」を押せるか: 去年との違いを文脈に入れられるようになった（決め終えた）か。去年の元の Excel が無い・今年の元の表が無い（PDF だけ）・
 * 去年の Excel を読めなかった・比べるシートが無いときは、違いを作れないので待たない
 */
export function carryoverReady(s: {
  previousSource: boolean
  currentSource: boolean
  previousSheets: "loading" | "loaded" | "error" | "noSheet"
  /** true＝違いを作った、"unavailable"＝今年の比べるシートが無く作れない、false＝作っている途中 */
  formatDiff: boolean | "unavailable"
}) {
  if (!s.previousSource || !s.currentSource) return true
  if (s.previousSheets === "error" || s.previousSheets === "noSheet") return true
  return s.previousSheets === "loaded" && s.formatDiff !== false
}

/** 個人名の項目（値そのものが氏名） */
export const PERSON_FIELDS: ReadonlySet<KojiFieldId> = new Set(["engineer"])

/** 去年の案件の作業（手直し・置換）と AI の結果（匿名化の persons、氏名の区切り）から、分かっている個人名を集める */
export function namesOfCase(work: { edits: Edits; replacements: Partial<Record<KojiFieldId, Readonly<Record<string, CellEdit>>>> }, aiCache: readonly (readonly [string, unknown])[]) {
  const names = new Set<string>()
  for (const [key, edit] of work.edits) collectNames(names, edit.value, isPersonEditKey(key))
  for (const [field, table] of Object.entries(work.replacements) as [KojiFieldId, Readonly<Record<string, CellEdit>>][]) {
    for (const [from, to] of Object.entries(table ?? {})) {
      collectNames(names, from, PERSON_FIELDS.has(field))
      collectNames(names, to.value, PERSON_FIELDS.has(field))
    }
  }
  for (const [key, result] of aiCache) {
    const persons = z.object({ persons: z.array(z.string()) }).safeParse(result)
    if (persons.success) for (const p of persons.data.persons) collectNames(names, p, true)
    const task = z.tuple([z.literal("personName"), z.string(), z.string()]).safeParse(tryParseJson(key))
    const value = z.object({ value: z.string() }).safeParse(result)
    if (task.success) {
      collectNames(names, task.data[2], true)
      if (value.success) collectNames(names, value.data.value, true)
    }
  }
  return names
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const NAME_MARK = "〔個人名〕"

/**
 * コードを NFKC にした文字列と、その文字ごとの元の位置（[始まり, 終わり)）。半角カナの濁点・半濁点は前の文字と一緒に直す（ﾀﾞ → ダ）。
 * 空白は消さない（全角の空白は半角になる。空白の数は名前の正規表現の側で問わない）
 */
function normalizedWithOffsets(code: string) {
  let text = ""
  const from: number[] = []
  const to: number[] = []
  const chars = [...code]
  let at = 0
  for (let i = 0; i < chars.length; i++) {
    let unit = chars[i]!
    while (i + 1 < chars.length && /[ﾞﾟ]/.test(chars[i + 1]!)) unit += chars[++i]!
    for (const c of unit.normalize("NFKC")) {
      text += c
      for (let k = 0; k < c.length; k++) {
        from.push(at)
        to.push(at + unit.length)
      }
    }
    at += unit.length
  }
  return { text, from, to }
}

const LETTER_RE = /[\p{L}\p{N}]/u

/**
 * 個人名を〔個人名〕にする関数を作る（名前の正規表現は1回だけ作り、去年のコードのすべてに使う）。氏名ごと（空白の有無・数、全角半角の違いも同じ名前）に
 * 置き換え、姓・名だけでは置き換えない。2文字以下の名前（姓だけの値など）は、前後が文字でないときだけ置き換える（「山田町」「青池工務店」を壊さない）
 */
export function nameScrubber(names: Iterable<string>): (code: string) => string {
  const variants = new Set<string>()
  for (const raw of names) {
    const name = nfkc(raw).replace(/\s+/g, " ")
    for (const v of [name, removeSpaces(name)]) if ([...v].length >= MIN_NAME_LENGTH) variants.add(v)
  }
  if (!variants.size) return (code) => code
  const re = new RegExp(
    [...variants]
      .sort((a, b) => b.length - a.length)
      .map((v) => v.split(" ").map(escapeRe).join("\\s+"))
      .join("|"),
    "g",
  )
  return (code) => {
    const { text, from, to } = normalizedWithOffsets(code)
    const hits: [number, number][] = []
    for (const m of text.matchAll(re)) {
      const start = m.index
      const end = start + m[0].length
      const short = [...removeSpaces(m[0])].length <= SHORT_NAME_LENGTH
      if (short && (LETTER_RE.test(text[start - 1] ?? "") || LETTER_RE.test(text[end] ?? ""))) continue
      hits.push([from[start]!, to[end - 1]!])
    }
    let out = ""
    let last = 0
    for (const [a, b] of hits) {
      out += code.slice(last, a) + NAME_MARK
      last = b
    }
    return out + code.slice(last)
  }
}

export const scrubNames = (code: string, names: Iterable<string>) => nameScrubber(names)(code)

/** 伏せた文字列・コメントの印 */
export const MASKED = "〔伏せた語〕"

/** 固有名になりうる語: 漢字の続き・カタカナの続き（ひらがなは区切りとみなす） */
const PROPER_RE = /[\p{Script=Han}々〆ヵヶ]+|[\p{Script=Katakana}ー]+/gu

/** 書式の決まり（14列の名前・説明・公式の記載ルール・コードの名前）。ルールと一緒に、知っている語に入れる */
const SPEC_TEXT = [
  ...KOJI_KEIREKI.fields.flatMap((f) => [f.label, f.description]),
  ...KOJI_KEIREKI.writingRules,
  ...Object.values(CODE_SETS).flatMap((set) => set.map((c) => c.label)),
].join("\n")

const norm = (s: string) => removeSpaces(s.normalize("NFKC"))

/**
 * 去年のコードに残してよい語（知っている語）: 今年の表の値（個人名の項目と印の人は除く）・手直し、全体ルールと顧客ルール、去年と今年の見出し、書式の決まり
 */
export function knownWords(table: Parameters<typeof collectTableNames>[1], rules: readonly string[], headers: readonly string[]): string {
  const values: string[] = []
  const strip = (v: string) => withNames(v, () => " ")
  for (const r of table.rows) for (const [f, c] of Object.entries(r.cells)) if (c && !PERSON_FIELDS.has(f as KojiFieldId)) values.push(strip(c.value))
  for (const [key, e] of table.edits) if (!isPersonEditKey(key)) values.push(strip(e.value))
  return [...values, ...rules, ...headers, SPEC_TEXT].map(norm).join("\n")
}

/** 文字列・コメントの中身を残してよいか: 固有名になりうる語がすべて知っている語にある（〔個人名〕と伏せた印は除いて見る） */
function allKnown(body: string, words: string) {
  const text = norm(body.replaceAll(NAME_MARK, " ").replaceAll(MASKED, " "))
  return (text.match(PROPER_RE) ?? []).every((t) => words.includes(t))
}

const STRING_START_RE = /^([rRbBuUfF]{0,2})('''|"""|'|")/

/**
 * 去年のコード（Python）の文字列とコメントのうち、知っている語に無い固有名らしい語を含むものを伏せる。集めた名前に無い個人名
 * （AI が読んだ技術者の一覧の氏名など）を AI に渡さないための安全側の扱い。コードの形（引用符・#）は残す
 */
export function maskUnknownText(code: string, words: string): string {
  let out = ""
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]!
    if (c === "#") {
      const nl = code.indexOf("\n", i)
      const end = nl < 0 ? n : nl
      const body = code.slice(i + 1, end)
      out += allKnown(body, words) ? `#${body}` : `# ${MASKED}`
      i = end
      continue
    }
    const m = /[A-Za-z0-9_]/.test(code[i - 1] ?? "") ? null : STRING_START_RE.exec(code.slice(i, i + 5))
    if (!m) {
      out += c
      i++
      continue
    }
    const head = m[0]
    const quote = m[2]!
    const start = i + head.length
    let end = start
    if (quote.length === 3) {
      const close = code.indexOf(quote, start)
      end = close < 0 ? n : close
    } else {
      while (end < n && code[end] !== quote && code[end] !== "\n") end += code[end] === "\\" ? 2 : 1
      end = Math.min(end, n)
    }
    const body = code.slice(start, end)
    const closeLen = code.startsWith(quote, end) ? quote.length : 0
    out += head + (allKnown(body, words) ? body : MASKED) + code.slice(end, end + closeLen)
    i = end + closeLen
  }
  return out
}

/**
 * 去年のコードを AI に渡せる形にする: 集めた個人名を〔個人名〕にし（nameScrubber）、そのうえで知っている語に無い固有名らしい語を含む文字列・コメントを伏せる
 * （maskUnknownText。集め切れない名前への安全側の扱い）
 */
export function cleanCarryoverCodes(codes: readonly string[], names: Iterable<string>, words: string): string[] {
  const scrub = nameScrubber(names)
  return codes.map((c) => maskUnknownText(scrub(c), words))
}

/** skipped は去年のコードを読めなかった理由（コードは添えず、顧客ルールだけで直す） */
export type Carryover = { fiscalYear: number; codes: string[]; skipped?: string }

/**
 * 最初の指示に添える文（AI に送る指示の前に置く。画面の会話には出さない）と、添えたコードの数。コードは合わせて MAX_CARRYOVER_CHARS 字まで
 * （1つ目が長すぎるときは途中で切る）
 */
export function carryoverPrompt({ fiscalYear, codes, skipped }: Carryover): { text: string; included: number } {
  const head = `## 去年（${fiscalYear}年度）の参考\n`
  if (skipped) return { text: `${head}${skipped}（去年の案件の作業を読めなかった。去年のコードが無いのではない）。顧客ルールに従って、今年の表を直す。`, included: 0 }
  if (!codes.length) return { text: `${head}去年のこの顧客の案件の会話に、承認につながったコードはありません。顧客ルールに従って、今年の表を直す。`, included: 0 }
  const blocks: string[] = []
  let size = 0
  for (const [i, code] of codes.entries()) {
    const cut = code.length > MAX_CARRYOVER_CHARS ? `${code.slice(0, MAX_CARRYOVER_CHARS)}\n# …（長いので、ここから先は省いた）` : code
    const block = `### コード${i + 1}\n\`\`\`python\n${cut}\n\`\`\``
    if (blocks.length && size + block.length > MAX_CARRYOVER_CHARS) break
    blocks.push(block)
    size += block.length
  }
  const omitted = codes.length - blocks.length
  const text = [
    head.trim(),
    `去年のこの顧客の案件で、AI が書き、職員が承認した変更につながったコード（${codes.length}件${omitted ? `。長いので後ろの ${omitted} 件は省いた` : ""}）。`,
    "そのまま実行しない。今年のファイルと表をコードで読み直し、同じやり方が今年も当てはまるかを確かめてから、今年の形（シート・列の名前と位置）に合わせて書き直す。",
    `key・行番号・セルの位置は去年のものなので使わない。個人名は〔個人名〕に、今年の表やルールに無い固有名らしい語を含む文字列・コメントは${MASKED}に置き換えてある（今年のファイルと表から読み直す）。`,
    ...blocks,
  ].join("\n")
  return { text, included: blocks.length }
}

import { z } from "zod"
import type { TableView } from "../cases/view"
import type { RowResult } from "../convert/convert"
import { personKey, showPersons, type PersonLetters } from "../convert/persons"
import { fieldIdSchema } from "../schemas"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"

/**
 * 最後の Excel（職員が確かめ、Excel の「CSV で保存」で建設業.NET に取り込む形）。職員がこれまで作っていた Excel に合わせる:
 * 1枚目のシートに A〜N の14列・見出しの行なし・1行目からデータ。業種・元請下請・JV・請負代金・PC等の額・主任・監理は数値、ほかは文字列。
 * 値は CSV に出す値と同じ（匿名化のあと）。
 *
 * 直して上げ直すと表に戻せるよう、照合用の隠しシートを足す（列は足さない。「CSV で保存」は開いているシートだけを書き、隠しシートは
 * 開いているシートにならないので CSV に入らない）。隠しシートには、落とした時点の識別（案件・変換の元）・行ごとの key と落としたときの14列の値・
 * 記号（Ａ・Ｂ…）がどの人だったかの照合用の値を持つ。個人名は書かない（記号の人は、サーバーが案件ごとに決める鍵の HMAC で見分ける。鍵は Excel に
 * 書かないので、Excel だけからは名前の辞書で当てられない）
 */

export const FINAL_SHEET_NAME = "工事経歴"
/** 照合用の隠しシート。名前と1行目の印で、この画面で落とした最後の Excel だと見分ける */
export const CHECK_SHEET_NAME = "照合用（最後の Excel）"
export const CHECK_MARK = "aoike-final-check"
export const CHECK_VERSION = 1

/** 数値で書く項目（A・C・D・I・J・M・N） */
export const NUMERIC_FIELDS: ReadonlySet<KojiFieldId> = new Set(["gyoshu", "motoukeShitauke", "jv", "amount", "specialAmount", "chiefEngineer", "supervisingEngineer"])

/** 数値にしてよい値（先頭の 0 が無い整数。「CSV で保存」で同じ文字に戻る） */
const NUMBER_RE = /^(0|[1-9]\d{0,14})$/

export type FinalCell = string | number | null

/** 落とした時点の識別。上げ直したとき、別の案件・変換の元を変えたあとの Excel を取り違えない */
export const checkMetaSchema = z.object({
  caseId: z.string().min(1).max(64),
  sourceFileId: z.string().max(64).nullable(),
  exportedAt: z.string().max(40),
  /** 案件の照合用の鍵の印（keyMark）。鍵が違えば記号の人を見つけられないので読まない */
  keyMark: z.string().regex(/^[0-9a-f]{16}$/),
})
export type CheckMeta = z.infer<typeof checkMetaSchema>

/** 照合用の行。marked は落としたときの値で、記号の人を「〔Ａ〕」の形にしたもの（CSV の値は記号を外したもの） */
export type CheckRow = { key: string; marked: Record<KojiFieldId, string> }

export type FinalCheck = {
  meta: CheckMeta
  /** 記号 → 人のハッシュ（personHash） */
  persons: { letter: string; hash: string }[]
  rows: CheckRow[]
}

export type FinalSheet = { rows: FinalCell[][]; check: FinalCheck }

/** CSV に出す行（output）を、最後の Excel の行にする。空の値は空のセル。数値の項目でも数値にできない値は文字列のまま（値を変えない） */
export function finalSheetRows(rows: readonly RowResult<KojiFieldId>[]): FinalCell[][] {
  return rows.map((r) =>
    KOJI_KEIREKI.fields.map((f): FinalCell => {
      const v = r.cells[f.id].value
      if (v === "") return null
      return NUMERIC_FIELDS.has(f.id) && NUMBER_RE.test(v) ? Number(v) : v
    }),
  )
}

/** バイト列を16進の文字列にする */
export const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")

/** 案件の照合用の鍵（16進。サーバーが案件の id から決める。server/excel-key.ts）での HMAC-SHA-256 の先頭 n バイト */
async function hmac(key: string, text: string, n: number) {
  const raw = Uint8Array.from(key.match(/../g)!.map((h) => parseInt(h, 16)))
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text))).slice(0, n))
}

/** 記号の人のハッシュ（空白を除いた氏名の HMAC の先頭12バイト）。上げ直したとき、記号が付け直されていても同じ人を見つける */
export const personHash = (key: string, name: string) => hmac(key, `person\n${personKey(name)}`, 12)

/** 鍵の印（案件の id の HMAC の先頭8バイト）。上げ直したとき、同じ鍵で書いた Excel かを確かめる */
export const keyMark = (key: string, caseId: string) => hmac(key, `case\n${caseId}`, 8)

/** 落とした値の「〔Ａ〕」の形（記号の人が無い値はそのまま） */
const markedOf = (cell: RowResult<KojiFieldId>["cells"][KojiFieldId], letters: PersonLetters) => (cell.stored ? showPersons(cell.stored, letters, true) : cell.value)

/** 案件の今の表から最後の Excel を作る（値は CSV と同じ。照合用の隠しシートの中身も）。excelKey は案件の照合用の鍵 */
export async function finalSheet(
  view: Pick<TableView, "output" | "letters">,
  id: { caseId: string; sourceFileId: string | null; excelKey: string },
  now = new Date(),
): Promise<FinalSheet> {
  const rows = view.output.map((r) => ({ key: r.key, marked: Object.fromEntries(KOJI_KEIREKI.fields.map((f) => [f.id, markedOf(r.cells[f.id], view.letters)])) as Record<KojiFieldId, string> }))
  // CSV に出てくる記号だけ（CSV の記号は Ａ から欠けなく付く。未掲載の人は CSV に出ない）
  const used = new Set(rows.flatMap((r) => Object.values(r.marked).flatMap((v) => [...v.matchAll(MARK_RE)].map((m) => m[1]!))))
  const persons = await Promise.all([...used].map(async (letter) => ({ letter, hash: await personHash(id.excelKey, view.letters.personOf.get(letter)!) })))
  return { rows: finalSheetRows(view.output), check: { meta: { caseId: id.caseId, sourceFileId: id.sourceFileId, exportedAt: now.toISOString(), keyMark: await keyMark(id.excelKey, id.caseId) }, persons, rows } }
}

/** 「〔Ａ〕」の形の記号（CSV の記号。未掲載の人は最後の Excel に出ない） */
export const MARK_RE = /〔([Ａ-Ｚ][０-９]*)〕/g

/** 照合用の隠しシートのセル（1行目は印、2行目は識別、そのあと人・行）。全セル文字列 */
export function checkSheetRows(check: FinalCheck): string[][] {
  return [
    [CHECK_MARK, String(CHECK_VERSION)],
    ["meta", JSON.stringify(check.meta)],
    ...check.persons.map((p) => ["person", p.letter, p.hash]),
    ...check.rows.map((r) => ["row", r.key, ...KOJI_KEIREKI.fields.map((f) => r.marked[f.id])]),
  ]
}

const personRowSchema = z.object({ letter: z.string().regex(/^[Ａ-Ｚ][０-９]*$/), hash: z.string().regex(/^[0-9a-f]{24}$/) })

/** 照合用の隠しシートを読む。この画面で落とした最後の Excel でなければ null、壊れていれば error */
export function readCheckSheet(rows: readonly (readonly string[])[]): FinalCheck | { error: string } | null {
  if ((rows[0]?.[0] ?? "").trim() !== CHECK_MARK) return null
  const version = Number((rows[0]?.[1] ?? "").trim())
  if (!Number.isInteger(version)) return { error: "照合用のシートが書き換えられていて読めません" }
  if (version > CHECK_VERSION) return { error: "この画面より新しい形の Excel です。画面を読み込み直してから上げてください" }
  if (version < CHECK_VERSION) return { error: "前の形の Excel なので表に戻せません。書き出し直してから直してください" }
  let meta: CheckMeta | undefined
  const persons: FinalCheck["persons"] = []
  const out: CheckRow[] = []
  for (const r of rows.slice(1)) {
    const kind = (r[0] ?? "").trim()
    if (!kind) continue
    if (kind === "meta") {
      const parsed = checkMetaSchema.safeParse(safeJson(r[1] ?? ""))
      if (!parsed.success) return { error: "照合用のシートが書き換えられていて読めません" }
      meta = parsed.data
    } else if (kind === "person") {
      const parsed = personRowSchema.safeParse({ letter: r[1], hash: r[2] })
      if (!parsed.success) return { error: "照合用のシートが書き換えられていて読めません" }
      persons.push(parsed.data)
    } else if (kind === "row") {
      const key = z.string().min(1).max(200).safeParse(r[1])
      if (!key.success) return { error: "照合用のシートが書き換えられていて読めません" }
      const marked = Object.fromEntries(KOJI_KEIREKI.fields.map((f, i) => [fieldIdSchema.parse(f.id), r[i + 2] ?? ""])) as Record<KojiFieldId, string>
      out.push({ key: key.data, marked })
    } else return { error: "照合用のシートが書き換えられていて読めません" }
  }
  if (!meta) return { error: "照合用のシートが書き換えられていて読めません" }
  return { meta, persons, rows: out }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

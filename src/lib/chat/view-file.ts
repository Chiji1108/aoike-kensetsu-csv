import { APICallError, RetryError, type ModelMessage } from "ai"
import { PDFDocument } from "pdf-lib"
import { z } from "zod"
import { tryParseJson } from "../json"
import { viewKindOf } from "./view-kind"

/**
 * チャットの AI が案件のファイル（PDF・画像）をそのまま見る道具（view_file）の決まり。
 * 文字の層の無い PDF（スキャン・手書き）と画像は、コンテナの pypdf では読めないので、Claude にファイルそのもの（document / image のブロック）を見せる。
 * 見せるのは AI が view_file を呼んだときだけ（呼ぶと会話の履歴に入り、以後の往復はプロンプトキャッシュで読む）
 */

/** 1回の view_file で見せられる PDF のページ数（1ページはおよそ 1,500〜3,000 トークン） */
export const MAX_VIEW_PAGES = 20
/** 1つの会話で見せられる PDF のページ数の合計（見たページは履歴に残り、以後の往復で毎回読むので費用と文脈を抑える。会話を終えるとまた見られる） */
export const MAX_VIEW_PAGES_PER_CHAT = 100
/** 1つの会話で見せられる画像の数（1回の呼び出しで 20 枚を超えると、Claude は1枚の縦横の上限を厳しくする） */
export const MAX_VIEW_IMAGES_PER_CHAT = 20
/** 1回の指示で view_file を呼べる回数（ほかの道具の回数〔MAX_TOOL_CALLS〕とは別に数える。ページの多い PDF を分けて見ても、表を直す道具まで届く） */
export const MAX_VIEW_CALLS = 10
/**
 * 見せられる画像の大きさ。Claude API の1枚の上限は base64 で 10MB（vision の docs の Request limits）で、元の大きさで 7.5MB。
 * Files API の file_id で渡すときの1枚の上限は docs に別に書かれていない（Files API の上限は1ファイル 500MB）ので、同じ上限にする
 */
export const MAX_VIEW_IMAGE_BYTES = 7_500_000
/** 見せられる画像の縦横（Claude API の上限。超えると次の往復が 400 で落ち続けるので、見せる前に断る） */
export const MAX_VIEW_IMAGE_PX = 8000
/**
 * ページを数える・切り出す PDF の大きさ。Worker のメモリは 128MB で、PDF は R2 から読んだ中身（1倍）と pdf-lib が開いたもの（測ると約1倍）を
 * 同時に持ち、切り出すとコピーと save の出力（どちらも切り出した分。最悪で元と同じ）が足される。20MB なら最悪でおよそ 4倍の 80MB に収まる
 * （32MB だと 128MB を超えうる）。開いた PDF は指示の間で1つだけ持つ
 */
export const MAX_VIEW_PDF_BYTES = 20 * 1024 * 1024

/** 道具の引数。pages は PDF のページ（1 から。例 "1-5"、"3"） */
export const viewFileInputSchema = z.strictObject({
  file: z.string().min(1).max(200),
  pages: z
    .string()
    .trim()
    .regex(/^\d+(\s*-\s*\d+)?$/, "pages は「3」か「1-5」の形")
    .optional(),
})
export type ViewFileInput = z.infer<typeof viewFileInputSchema>

/** pages を範囲にする（1 から、両端を含む）。total を超える・逆順は理由を返す */
export function parsePages(pages: string | undefined, total: number): { from: number; to: number } | string {
  if (pages === undefined) return { from: 1, to: total }
  const [a, b = a] = pages.split("-").map((s) => Number(s.trim()))
  if (!a || !b || a > b) return `pages「${pages}」が読めません（1 から数えて「3」か「1-5」）`
  if (b > total) return `この PDF は ${total} ページです（pages「${pages}」は範囲の外）`
  return { from: a, to: b }
}

/**
 * 案件のファイルを見せるのに要るもの（サーバーは R2 と Files API、照合スクリプトは手元のファイル）。
 * files はコンテナに置いたファイル（name はコンテナの中の名前、id は Files API の id、size は大きさ。大きすぎるファイルは読まずに断る）。read は元のファイルの中身、
 * upload はファイルを Files API に上げて id を返す（切り出したページの PDF と、拡張子と中身の形式が違う画像。上げたものは ViewState.uploads に溜め、会話を終えるときに消す）
 */
export type FileViewer = {
  /** unviewable は前の指示で API が断ったファイルの理由（この会話ではもう見せない。unviewableAfter） */
  files: readonly { name: string; original: string; id: string; size: number; unviewable?: string }[]
  read: (name: string) => Promise<Uint8Array | null>
  upload: (bytes: Uint8Array, name: string, mediaType: string) => Promise<string>
}

/**
 * 見せた状態（1つの指示の間）。pages・images・shown はこの会話で見せた数と範囲（履歴の分から始めて足していく）、
 * uploads はこの指示で上げた Files API の id、pdf は最後に開いた PDF（メモリのため1つだけ）、totals は PDF のページ数
 */
export type ViewState = {
  viewer: FileViewer
  pages: number
  images: number
  shown: Set<string>
  uploads: string[]
  pdf: { name: string; doc: PDFDocument } | null
  totals: Map<string, number>
  /**
   * view_file を1つずつ順に動かす列（AI SDK は1回の返事の道具の呼び出しを並べて動かすので、同じ PDF を同時に開くとメモリを超え、
   * 上限と「もう見せた」の確かめもすり抜ける）。最後に入れた呼び出しが終わると決まる。止めた回は、これを待ってから上げたファイルを記録する
   */
  queue: Promise<void>
  /** この往復で見せたファイル（attached）と、次の API の呼び出しで初めて送るファイル（sending。API が断ったら見られないと覚える） */
  attached: string[]
  sending: string[]
}

export function newViewState(viewer: FileViewer, history: readonly ModelMessage[]): ViewState {
  return { viewer, ...viewedInHistory(history), uploads: [], pdf: null, totals: new Map(), queue: Promise.resolve(), attached: [], sending: [] }
}

/** view_file の呼び出しを全部終えるまで待つ（止めた回に、上げている途中のファイルを記録し損ねない） */
export const viewIdle = (state: ViewState) => state.queue

/** 往復が1つ終わった: その往復で見せたファイルは、次の API の呼び出しで初めて送る（前に送ったものは受け取られた） */
export function viewStepFinished(state: ViewState) {
  state.sending = state.attached
  state.attached = []
}

/**
 * 指示が失敗したとき、API が断ったとみなすファイル: 失敗が API の 400（リクエストの誤り）で、失敗した呼び出しで初めて送ったファイルがあれば、それ。
 * 失敗した回は履歴に入らないので、覚えないと次の指示でも同じファイルを見て失敗し続ける（会話を終えると忘れる）
 */
export function unviewableAfter(state: ViewState, error: unknown): { name: string; reason: string }[] {
  const rejected = badRequest(error)
  if (!rejected || !state.sending.length) return []
  const reason = `API がこのファイルを受け取りませんでした（${rejected.message.slice(0, 200)}）`
  return [...new Set(state.sending)].map((name) => ({ name, reason }))
}

function badRequest(e: unknown): APICallError | null {
  if (RetryError.isInstance(e)) return badRequest(e.lastError)
  return APICallError.isInstance(e) && e.statusCode === 400 ? e : null
}

/** 見せた範囲の印（画像はファイル名、PDF はファイル名とページ） */
const shownKey = (file: string, pages?: { from: number; to: number }) => (pages ? `${file}:${pages.from}-${pages.to}` : file)

type Pages = { from: number; to: number; total: number }
/** 道具の結果。ok なら AI にファイルを見せる（toModelOutput がブロックにする）。repeated はこの会話でもう見せた範囲（ファイルは添えない） */
export type ViewResult =
  | { ok: true; file: string; original: string; mediaType: string; fileId: string; pages?: Pages; note: string }
  | { ok: true; repeated: true; file: string; pages?: Pages; note: string }
  | { ok: false; error: string; file?: string; totalPages?: number }

const REPEATED_NOTE = "この会話でもう見せた範囲です（会話の上の結果にあります）。見直すときはそれを読んでください"

/**
 * 見せる。見せた数・範囲・上げたファイルは state に足す。呼び出しは state.queue で1つずつ順に動かす。
 * signal は止めた印（止めたあとに列で待っていた呼び出しは何もしない）
 */
export function viewFile(state: ViewState, input: ViewFileInput, signal?: AbortSignal): Promise<ViewResult> {
  const run = state.queue.then(() => (signal?.aborted ? ({ ok: false, error: "止めました" } as const) : viewOne(state, input)))
  state.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function viewOne(state: ViewState, input: ViewFileInput): Promise<ViewResult> {
  const result = await viewNow(state, input)
  if (result.ok && !("repeated" in result)) state.attached.push(result.file)
  return result
}

async function viewNow(state: ViewState, input: ViewFileInput): Promise<ViewResult> {
  const { viewer } = state
  const name = input.file.replace(/^.*\//, "")
  const f = viewer.files.find((x) => x.name === name)
  if (!f) return { ok: false, error: `「${input.file}」は案件のファイルにありません（${viewer.files.map((x) => x.name).join("、") || "ファイルなし"}）` }
  if (f.unviewable) return { ok: false, file: f.name, error: `${f.unviewable}。この会話ではもう見せません。職員に伝え、作り直したファイルを付け直してもらってください` }
  const kind = viewKindOf(f.original)
  if (!kind) return { ok: false, file: f.name, error: "このファイルはそのまま見られません（見られるのは PDF と JPEG・PNG・GIF・WebP の画像）。コード実行で読んでください" }
  if (kind.kind === "heic") return { ok: false, file: f.name, error: HEIC_ERROR }
  if (kind.kind === "image") {
    if (input.pages !== undefined) return { ok: false, file: f.name, error: "pages は PDF のときだけ書けます" }
    if (state.shown.has(shownKey(f.name))) return { ok: true, repeated: true, file: f.name, note: REPEATED_NOTE }
    if (state.images >= MAX_VIEW_IMAGES_PER_CHAT)
      return { ok: false, file: f.name, error: `この会話で見られる画像は ${MAX_VIEW_IMAGES_PER_CHAT} 枚までです。職員に、会話を終えてから続きを頼んでもらうよう伝えてください` }
    if (f.size > MAX_VIEW_IMAGE_BYTES)
      return { ok: false, file: f.name, error: `画像が大きすぎます（${mb(f.size)}。見られるのは ${mb(MAX_VIEW_IMAGE_BYTES)} まで）。職員に、小さくして付け直してもらうよう伝えてください` }
    // 中身で形式と縦横を確かめる（拡張子と違う形式・大きすぎる縦横をそのまま渡すと、次の往復から 400 で落ち続ける）
    const bytes = await viewer.read(f.name)
    if (!bytes) return { ok: false, file: f.name, error: "ファイルを読めませんでした" }
    const info = imageInfo(bytes)
    if (info === "heic") return { ok: false, file: f.name, error: HEIC_ERROR }
    if (!info) return { ok: false, file: f.name, error: "画像として読めませんでした（壊れているか、JPEG・PNG・GIF・WebP ではない）。職員に伝えてください" }
    if (info.width > MAX_VIEW_IMAGE_PX || info.height > MAX_VIEW_IMAGE_PX)
      return { ok: false, file: f.name, error: `画像の縦横が大きすぎます（${info.width}×${info.height}。見られるのは縦横 ${MAX_VIEW_IMAGE_PX} までの画像）。職員に、縮めて付け直してもらうよう伝えてください` }
    // 拡張子と中身の形式が違う（.jpg の PNG など）ときは、中身の形式で上げ直して見せる（上げてあるファイルは拡張子の形式）
    let fileId = f.id
    if (info.mediaType !== kind.mediaType) {
      fileId = await viewer.upload(bytes, f.name, info.mediaType)
      state.uploads.push(fileId)
    }
    state.images++
    state.shown.add(shownKey(f.name))
    return { ok: true, file: f.name, original: f.original, mediaType: info.mediaType, fileId, note: IMAGE_NOTE }
  }
  if (f.size > MAX_VIEW_PDF_BYTES)
    return { ok: false, file: f.name, error: `PDF が大きすぎます（${mb(f.size)}。見られるのは ${mb(MAX_VIEW_PDF_BYTES)} まで）。職員に、ページを分けて付け直してもらうよう伝えてください` }
  const open = async () => {
    if (state.pdf?.name === f.name) return state.pdf.doc
    state.pdf = null
    const bytes = await viewer.read(f.name)
    if (!bytes) return "ファイルを読めませんでした"
    if (!isPdf(bytes)) return "PDF として読めませんでした（中身が PDF ではない）。職員に伝えてください"
    try {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false })
      state.pdf = { name: f.name, doc }
      state.totals.set(f.name, doc.getPageCount())
      return doc
    } catch {
      return "PDF を開けませんでした（パスワード付き・壊れている）。職員に伝えてください"
    }
  }
  let total = state.totals.get(f.name)
  if (total === undefined) {
    const doc = await open()
    if (typeof doc === "string") return { ok: false, file: f.name, error: doc }
    total = doc.getPageCount()
  }
  const range = parsePages(input.pages, total)
  if (typeof range === "string") return { ok: false, file: f.name, totalPages: total, error: range }
  const pages = { ...range, total }
  if (state.shown.has(shownKey(f.name, range))) return { ok: true, repeated: true, file: f.name, pages, note: REPEATED_NOTE }
  const count = range.to - range.from + 1
  if (count > MAX_VIEW_PAGES)
    return { ok: false, file: f.name, totalPages: total, error: `1回に見られるのは ${MAX_VIEW_PAGES} ページまでです（この PDF は ${total} ページ）。pages で分けて見てください（例「1-${MAX_VIEW_PAGES}」）` }
  const left = MAX_VIEW_PAGES_PER_CHAT - state.pages
  if (count > left)
    return {
      ok: false,
      file: f.name,
      totalPages: total,
      error: `この会話で見られるページは合わせて ${MAX_VIEW_PAGES_PER_CHAT} ページまでで、あと ${Math.max(left, 0)} ページです。見られなかったページ（${range.from}〜${range.to}ページ）を職員に伝え、会話を終えてから続きを頼んでもらってください`,
    }
  // 全部のページなら上げてあるファイルをそのまま見せる。一部なら切り出して上げる
  let fileId = f.id
  if (count < total) {
    const doc = await open()
    if (typeof doc === "string") return { ok: false, file: f.name, error: doc }
    const part = await PDFDocument.create()
    const copied = await part.copyPages(doc, Array.from({ length: count }, (_, i) => range.from - 1 + i))
    for (const p of copied) part.addPage(p)
    fileId = await viewer.upload(await part.save(), `${f.name.replace(/\.pdf$/i, "")}-p${range.from}-${range.to}.pdf`, "application/pdf")
    state.uploads.push(fileId)
  }
  state.pages += count
  state.shown.add(shownKey(f.name, range))
  return { ok: true, file: f.name, original: f.original, mediaType: "application/pdf", fileId, pages, note: IMAGE_NOTE }
}

const HEIC_ERROR = "HEIC の画像はそのまま見られません。職員に、JPEG で保存し直して付け直してもらうよう伝えてください"

/** 中身が PDF か（先頭の 1KB に %PDF- がある） */
const isPdf = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

/** 画像の中身の形式と縦横（JPEG・PNG・GIF・WebP。HEIC は "heic"、読めなければ null） */
export function imageInfo(b: Uint8Array): { mediaType: string; width: number; height: number } | "heic" | null {
  const info = readImageHeader(b)
  // 縦横が 0 の画像は API が受け取らない（壊れている）
  return info && info !== "heic" && (info.width === 0 || info.height === 0) ? null : info
}

function readImageHeader(b: Uint8Array): { mediaType: string; width: number; height: number } | "heic" | null {
  if (b.length < 30) return null
  if (u32be(b, 0) === 0x89504e47 && ascii(b, 12, 4) === "IHDR") return { mediaType: "image/png", width: u32be(b, 16), height: u32be(b, 20) }
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mediaType: "image/gif", width: u16le(b, 6), height: u16le(b, 8) }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4)
    if (chunk === "VP8 ") return { mediaType: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    if (chunk === "VP8L") return { mediaType: "image/webp", width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) }
    if (chunk === "VP8X") return { mediaType: "image/webp", width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
    return null
  }
  if (ascii(b, 4, 4) === "ftyp" && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(ascii(b, 8, 4))) return "heic"
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: マーカーを順にたどり、SOF（C0〜CF のうち C4・C8・CC を除く）の縦横を読む
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      if (marker === 0xff) {
        i++
        continue
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mediaType: "image/jpeg", width: u16be(b, i + 7), height: u16be(b, i + 5) }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      i += 2 + u16be(b, i + 2)
    }
  }
  return null
}

const IMAGE_NOTE = "ファイルを見せました。手書き・画像の文字から読んだ値は、add_rows・set_cells・record_answers に read_from:\"image\" を付けて送ってください。読めない・自信の無い値は空のままにします"

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`

/** 道具の結果を AI に見せる形にする（ok ならファイルの document / image のブロックを添える。先頭の文は viewedInHistory が数える） */
export function viewResultOutput(result: ViewResult) {
  if (!result.ok || "repeated" in result) return { type: "content" as const, value: [{ type: "text" as const, text: JSON.stringify(result) }] }
  const { fileId, mediaType, ...shown } = result
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: JSON.stringify(shown) },
      { type: "file" as const, mediaType, data: { type: "reference" as const, reference: { anthropic: fileId } } },
    ],
  }
}

/** 会話の履歴で view_file がもう見せたページ数・画像の数と、見せた範囲（上限を会話の全体で数え、同じ範囲は見せ直さない） */
export function viewedInHistory(messages: readonly ModelMessage[]): { pages: number; images: number; shown: Set<string> } {
  let pages = 0
  let images = 0
  const shown = new Set<string>()
  for (const m of messages) {
    if (m.role !== "tool") continue
    for (const p of m.content) {
      if (p.type !== "tool-result" || p.toolName !== "view_file" || p.output.type !== "content") continue
      const head = p.output.value[0]
      if (head?.type !== "text") continue
      const parsed = viewedSchema.safeParse(tryParseJson(head.text))
      // ファイルを添えた結果だけを数える（見られなかった・もう見せた範囲の結果には添えていない）
      if (!parsed.success || !parsed.data.ok || parsed.data.repeated || !parsed.data.file) continue
      const { file, pages: range } = parsed.data
      if (range) pages += range.to - range.from + 1
      else images++
      shown.add(shownKey(file, range))
    }
  }
  return { pages, images, shown }
}

const viewedSchema = z.object({ ok: z.boolean(), repeated: z.literal(true).optional(), file: z.string().optional(), pages: z.object({ from: z.number(), to: z.number() }).optional() })

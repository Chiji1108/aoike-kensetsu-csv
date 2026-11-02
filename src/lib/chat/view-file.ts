import type { ModelMessage } from "ai"
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
/** 見せられる画像の大きさ（Claude API の上限は base64 で 10MB = 元の大きさで 7.5MB） */
export const MAX_VIEW_IMAGE_BYTES = 7_500_000
/** ページを切り出す PDF の大きさ（Worker のメモリで開ける大きさ） */
export const MAX_VIEW_PDF_BYTES = 32 * 1024 * 1024

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
 * upload は切り出したページの PDF を Files API に上げて id を返す（上げたものは呼び出し側が記録し、会話を終えるときに消す）
 */
export type FileViewer = {
  files: readonly { name: string; original: string; id: string; size: number }[]
  read: (name: string) => Promise<Uint8Array | null>
  upload: (bytes: Uint8Array, name: string) => Promise<string>
  /** この会話でもう見せたページ数と画像の数（履歴から数える。viewedInHistory） */
  viewed: { pages: number; images: number }
}

/** 道具の結果。ok なら AI にファイルを見せる（toModelOutput がブロックにする） */
export type ViewResult =
  | { ok: true; file: string; original: string; mediaType: string; fileId: string; pages?: { from: number; to: number; total: number }; note: string }
  | { ok: false; error: string; file?: string; totalPages?: number }

/** 1つの指示の間の見せた数（履歴の分に足していく） */
export type ViewCounter = { pages: number; images: number }

/** 見せる。counter はこの指示で見せた数（呼ぶたびに足す）、uploaded は切り出して上げた Files API の id（呼ぶたびに足す） */
export async function viewFile(viewer: FileViewer, input: ViewFileInput, counter: ViewCounter, uploaded: string[]): Promise<ViewResult> {
  const name = input.file.replace(/^.*\//, "")
  const f = viewer.files.find((x) => x.name === name)
  if (!f) return { ok: false, error: `「${input.file}」は案件のファイルにありません（${viewer.files.map((x) => x.name).join("、") || "ファイルなし"}）` }
  const kind = viewKindOf(f.original)
  if (!kind) return { ok: false, file: f.name, error: "このファイルはそのまま見られません（見られるのは PDF と JPEG・PNG・GIF・WebP の画像）。コード実行で読んでください" }
  if (kind.kind === "heic") return { ok: false, file: f.name, error: "HEIC の画像はそのまま見られません。職員に、JPEG で保存し直して付け直してもらうよう伝えてください" }
  if (kind.kind === "image") {
    if (input.pages !== undefined) return { ok: false, file: f.name, error: "pages は PDF のときだけ書けます" }
    if (viewer.viewed.images + counter.images >= MAX_VIEW_IMAGES_PER_CHAT)
      return { ok: false, file: f.name, error: `この会話で見られる画像は ${MAX_VIEW_IMAGES_PER_CHAT} 枚までです。職員に、会話を終えてから続きを頼んでもらうよう伝えてください` }
    // 画像は上げてあるファイルをそのまま見せるので、中身は読まない
    if (f.size > MAX_VIEW_IMAGE_BYTES)
      return { ok: false, file: f.name, error: `画像が大きすぎます（${mb(f.size)}。見られるのは ${mb(MAX_VIEW_IMAGE_BYTES)} まで）。職員に、小さくして付け直してもらうよう伝えてください` }
    counter.images++
    return { ok: true, file: f.name, original: f.original, mediaType: kind.mediaType, fileId: f.id, note: IMAGE_NOTE }
  }
  // ページ数を数える・切り出すのに PDF を開く（Worker のメモリに載せるので、大きすぎる PDF は読まずに断る）
  if (f.size > MAX_VIEW_PDF_BYTES)
    return { ok: false, file: f.name, error: `PDF が大きすぎます（${mb(f.size)}。見られるのは ${mb(MAX_VIEW_PDF_BYTES)} まで）。職員に、ページを分けて付け直してもらうよう伝えてください` }
  const bytes = await viewer.read(f.name)
  if (!bytes) return { ok: false, file: f.name, error: "ファイルを読めませんでした" }
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch {
    return { ok: false, file: f.name, error: "PDF を開けませんでした（パスワード付き・壊れている）。職員に伝えてください" }
  }
  const total = doc.getPageCount()
  const range = parsePages(input.pages, total)
  if (typeof range === "string") return { ok: false, file: f.name, totalPages: total, error: range }
  const count = range.to - range.from + 1
  if (count > MAX_VIEW_PAGES)
    return { ok: false, file: f.name, totalPages: total, error: `1回に見られるのは ${MAX_VIEW_PAGES} ページまでです（この PDF は ${total} ページ）。pages で分けて見てください（例「1-${MAX_VIEW_PAGES}」）` }
  const left = MAX_VIEW_PAGES_PER_CHAT - viewer.viewed.pages - counter.pages
  if (count > left)
    return {
      ok: false,
      file: f.name,
      totalPages: total,
      error: `この会話で見られるページは合わせて ${MAX_VIEW_PAGES_PER_CHAT} ページまでで、あと ${Math.max(left, 0)} ページです。見られなかったページ（${range.from}〜${range.to}ページ）を職員に伝え、会話を終えてから続きを頼んでもらってください`,
    }
  let fileId = f.id
  if (count < total) {
    const part = await PDFDocument.create()
    const copied = await part.copyPages(doc, Array.from({ length: count }, (_, i) => range.from - 1 + i))
    for (const p of copied) part.addPage(p)
    fileId = await viewer.upload(await part.save(), `${f.name.replace(/\.pdf$/i, "")}-p${range.from}-${range.to}.pdf`)
    uploaded.push(fileId)
  }
  counter.pages += count
  return { ok: true, file: f.name, original: f.original, mediaType: "application/pdf", fileId, pages: { ...range, total }, note: IMAGE_NOTE }
}

const IMAGE_NOTE = "ファイルを見せました。手書き・画像の文字から読んだ値は、add_rows・set_cells・record_answers に read_from:\"image\" を付けて送ってください。読めない・自信の無い値は空のままにします"

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`

/** 道具の結果を AI に見せる形にする（ok ならファイルの document / image のブロックを添える。先頭の文は viewedInHistory が数える） */
export function viewResultOutput(result: ViewResult) {
  if (!result.ok) return { type: "content" as const, value: [{ type: "text" as const, text: JSON.stringify(result) }] }
  const { fileId, mediaType, ...shown } = result
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: JSON.stringify(shown) },
      { type: "file" as const, mediaType, data: { type: "reference" as const, reference: { anthropic: fileId } } },
    ],
  }
}

/** 会話の履歴で view_file がもう見せたページ数と画像の数（上限を会話の全体で数える） */
export function viewedInHistory(messages: readonly ModelMessage[]): { pages: number; images: number } {
  let pages = 0
  let images = 0
  for (const m of messages) {
    if (m.role !== "tool") continue
    for (const p of m.content) {
      if (p.type !== "tool-result" || p.toolName !== "view_file" || p.output.type !== "content") continue
      const head = p.output.value[0]
      if (head?.type !== "text") continue
      const parsed = viewedSchema.safeParse(tryParseJson(head.text))
      if (!parsed.success || !parsed.data.ok) continue
      if (parsed.data.pages) pages += parsed.data.pages.to - parsed.data.pages.from + 1
      else images++
    }
  }
  return { pages, images }
}

const viewedSchema = z.object({ ok: z.boolean(), pages: z.object({ from: z.number(), to: z.number() }).optional() })


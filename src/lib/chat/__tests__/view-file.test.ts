import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { PDFDocument } from "pdf-lib"
import { kojiRow } from "../../convert/__tests__/helpers"
import { fileAddressLookup } from "../../convert/address-file"
import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import type { ChatChange } from "../proposals"
import { chatTools, IMAGE_READ_NOTE, MAX_TOOL_CALLS, newTurnState, withCacheBreakpoint } from "../turn"
import { MAX_VIEW_IMAGE_BYTES, MAX_VIEW_IMAGES_PER_CHAT, MAX_VIEW_PAGES, MAX_VIEW_PAGES_PER_CHAT, parsePages, viewedInHistory, viewFile, viewResultOutput, type FileViewer, type ViewResult } from "../view-file"
import { viewKindOf } from "../view-kind"

async function pdfOf(pages: number) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([100, 100])
  return doc.save()
}

/** 決まったファイルの viewer。上げた PDF の中身（ページ数）を uploads に残す */
function viewerOf(files: Record<string, Uint8Array>, viewed = { pages: 0, images: 0 }) {
  const uploads: { name: string; pages: number }[] = []
  const viewer: FileViewer = {
    files: Object.entries(files).map(([name, bytes], i) => ({ name, original: `元の名前${i}${/\.[^.]+$/.exec(name)![0]}`, id: `file_${i}`, size: bytes.byteLength })),
    read: async (name) => files[name] ?? null,
    upload: async (bytes, name) => {
      uploads.push({ name, pages: (await PDFDocument.load(bytes)).getPageCount() })
      return `file_up${uploads.length}`
    },
    viewed,
  }
  return { viewer, uploads }
}

const jpg = new Uint8Array(1000)

describe("ファイルの種類ごとの見せ方", () => {
  test("PDF は document、JPEG・PNG・GIF・WebP は image、HEIC は見られない、ほかは見せない", () => {
    expect(viewKindOf("a.PDF")).toEqual({ kind: "pdf", mediaType: "application/pdf" })
    expect(viewKindOf("写真.jpeg")).toEqual({ kind: "image", mediaType: "image/jpeg" })
    expect(viewKindOf("x.png")?.kind).toBe("image")
    expect(viewKindOf("x.webp")?.kind).toBe("image")
    expect(viewKindOf("IMG_0001.HEIC")).toEqual({ kind: "heic" })
    expect(viewKindOf("台帳.xlsx")).toBeNull()
  })

  test("ページ数の少ない PDF は、上げてあるファイルをそのまま見せる（切り出さない）", async () => {
    const { viewer, uploads } = viewerOf({ "file-1.pdf": await pdfOf(3) })
    const counter = { pages: 0, images: 0 }
    const r = await viewFile(viewer, { file: "file-1.pdf" }, counter, [])
    expect(r).toMatchObject({ ok: true, fileId: "file_0", mediaType: "application/pdf", pages: { from: 1, to: 3, total: 3 } })
    expect(uploads).toEqual([])
    expect(counter.pages).toBe(3)
    const out = viewResultOutput(r)
    expect(out.value[1]).toEqual({ type: "file", mediaType: "application/pdf", data: { type: "reference", reference: { anthropic: "file_0" } } })
    expect(out.value[0]!.type === "text" && out.value[0]!.text).not.toContain("file_0")
  })

  test("pages を指定すると、そのページだけを切り出して上げ、上げた id を記録する", async () => {
    const { viewer, uploads } = viewerOf({ "file-1.pdf": await pdfOf(30) })
    const uploaded: string[] = []
    const r = await viewFile(viewer, { file: "$INPUT_DIR/file-1.pdf", pages: "11-15" }, { pages: 0, images: 0 }, uploaded)
    expect(r).toMatchObject({ ok: true, fileId: "file_up1", pages: { from: 11, to: 15, total: 30 } })
    expect(uploads).toEqual([{ name: "file-1-p11-15.pdf", pages: 5 }])
    expect(uploaded).toEqual(["file_up1"])
  })

  test("画像は上げてあるファイルを image で見せる。大きすぎる画像・HEIC・pages 付きは理由を返す", async () => {
    const { viewer } = viewerOf({ "file-1.jpg": jpg, "file-2.png": new Uint8Array(MAX_VIEW_IMAGE_BYTES + 1), "file-3.heic": jpg })
    const counter = { pages: 0, images: 0 }
    const r = await viewFile(viewer, { file: "file-1.jpg" }, counter, [])
    expect(r).toMatchObject({ ok: true, mediaType: "image/jpeg", fileId: "file_0" })
    expect(r.ok && r.pages).toBeUndefined()
    expect(viewResultOutput(r).value[1]).toMatchObject({ type: "file", mediaType: "image/jpeg" })
    expect(counter.images).toBe(1)
    expect(await viewFile(viewer, { file: "file-2.png" }, counter, [])).toMatchObject({ ok: false, error: expect.stringContaining("大きすぎます") })
    expect(await viewFile(viewer, { file: "file-3.heic" }, counter, [])).toMatchObject({ ok: false, error: expect.stringContaining("JPEG で保存し直して") })
    expect(await viewFile(viewer, { file: "file-1.jpg", pages: "1" }, counter, [])).toMatchObject({ ok: false })
    expect(await viewFile(viewer, { file: "file-9.jpg" }, counter, [])).toMatchObject({ ok: false, error: expect.stringContaining("案件のファイルにありません") })
  })
})

describe("ページの上限", () => {
  test("pages の読み方", () => {
    expect(parsePages(undefined, 4)).toEqual({ from: 1, to: 4 })
    expect(parsePages("3", 4)).toEqual({ from: 3, to: 3 })
    expect(parsePages("2 - 4", 4)).toEqual({ from: 2, to: 4 })
    expect(parsePages("3-2", 4)).toContain("読めません")
    expect(parsePages("0", 4)).toContain("読めません")
    expect(parsePages("2-5", 4)).toContain("4 ページです")
  })

  test(`1回に見られるのは ${MAX_VIEW_PAGES} ページまで。ページの多い PDF を pages なしで見ようとすると、総ページ数と分け方を返す`, async () => {
    const { viewer, uploads } = viewerOf({ "file-1.pdf": await pdfOf(MAX_VIEW_PAGES + 5) })
    const r = await viewFile(viewer, { file: "file-1.pdf" }, { pages: 0, images: 0 }, [])
    expect(r).toMatchObject({ ok: false, totalPages: MAX_VIEW_PAGES + 5, error: expect.stringContaining(`1-${MAX_VIEW_PAGES}`) })
    expect(uploads).toEqual([])
  })

  test(`1つの会話で見られるのは ${MAX_VIEW_PAGES_PER_CHAT} ページ・画像 ${MAX_VIEW_IMAGES_PER_CHAT} 枚まで（履歴で見た分と合わせる）。超えたら職員に伝えるよう返す`, async () => {
    const { viewer } = viewerOf({ "file-1.pdf": await pdfOf(10), "file-2.jpg": jpg }, { pages: MAX_VIEW_PAGES_PER_CHAT - 12, images: MAX_VIEW_IMAGES_PER_CHAT })
    const counter = { pages: 0, images: 0 }
    expect(await viewFile(viewer, { file: "file-1.pdf" }, counter, [])).toMatchObject({ ok: true })
    const over = await viewFile(viewer, { file: "file-1.pdf", pages: "1-3" }, counter, [])
    expect(over.ok).toBe(false)
    expect(!over.ok && over.error).toContain("あと 2 ページ")
    expect(!over.ok && over.error).toContain("職員に伝え")
    expect(await viewFile(viewer, { file: "file-2.jpg" }, counter, [])).toMatchObject({ ok: false, error: expect.stringContaining(`${MAX_VIEW_IMAGES_PER_CHAT} 枚まで`) })
  })

  test("履歴で見たページ数と画像の数を数える（見られなかった回は数えない）", () => {
    const result = (r: ViewResult): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "v", toolName: "view_file", output: viewResultOutput(r) }] })
    const history = [
      result({ ok: true, file: "file-1.pdf", original: "a.pdf", mediaType: "application/pdf", fileId: "f1", pages: { from: 3, to: 7, total: 9 }, note: "" }),
      result({ ok: true, file: "file-2.jpg", original: "b.jpg", mediaType: "image/jpeg", fileId: "f2", note: "" }),
      result({ ok: false, error: "x" }),
    ]
    expect(viewedInHistory(history)).toEqual({ pages: 5, images: 1 })
  })
})

describe("view_file の道具と手書きの印", () => {
  const table = { rows: [kojiRow({ gyoshu: "8", client: "株式会社テスト", workName: "テスト工事", amount: "1000", endYm: "" }, 2)], added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded" as const, basis: {}, rule7Tax: "excluded" as const, selection: "all" as const, rounding: "floor" as const, dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT }
  const call = async (state: ReturnType<typeof newTurnState>, name: string, input: unknown) => {
    const t = (chatTools(state) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>)[name]!
    const out = await t.execute(input, { toolCallId: "t", messages: [] })
    return typeof out === "string" ? JSON.parse(out) : out
  }

  test("view_file は直接呼ぶ道具で、道具の回数に数える。viewer が無ければ使えない", async () => {
    const tools = chatTools(newTurnState(table))
    expect((tools.view_file as { providerOptions?: unknown }).providerOptions).toBeUndefined()
    expect(await call(newTurnState(table), "view_file", { file: "file-1.pdf" })).toMatchObject({ ok: false, error: expect.stringContaining("使えません") })
    const state = newTurnState(table, undefined, undefined, null, null, null, null, null, viewerOf({ "file-1.jpg": jpg }).viewer)
    state.toolCalls = MAX_TOOL_CALLS
    expect(await call(state, "view_file", { file: "file-1.jpg" })).toMatchObject({ ok: false, error: expect.stringContaining("使い切りました") })
  })

  test('read_from:"image" で足した行・直したセル・顧客の回答のメモに、手書き・画像から読んだ印を付ける（省くと付けない）', async () => {
    const state = newTurnState(table, undefined, undefined, null, { lookup: fileAddressLookup })
    await call(state, "add_rows", { rows: [{ cells: { gyoshu: "8", amount: "500" } }], read_from: "image" })
    await call(state, "set_cells", { changes: [{ key: "s!2", field: "amount", value: "1200" }], read_from: "image" })
    await call(state, "record_answers", { items: [{ key: "s!2", field: "endYm", answer: "2024年9月" }], read_from: "image" })
    await call(state, "set_cells", { changes: [{ key: "s!2", field: "gyoshu", value: "9" }] })
    const [add, cell, answer, plain] = state.pending as ChatChange[]
    expect(add!.kind === "add" && Object.values(add!.cells).every((e) => e!.message!.includes(IMAGE_READ_NOTE))).toBe(true)
    expect(cell!.kind === "cell" && cell!.edit.message).toBe(IMAGE_READ_NOTE)
    expect(answer!.kind === "cell" && answer!.edit).toMatchObject({ value: "202409", by: "customer", message: IMAGE_READ_NOTE })
    expect(plain!.kind === "cell" && plain!.edit.message).toBeUndefined()
  })

  test("view_file の結果の直後にキャッシュの区切りを置く（見せたファイルを以後の往復でキャッシュから読む）", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "PDF から表を作って" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "v1", toolName: "view_file", input: { file: "file-1.pdf" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "v1", toolName: "view_file", output: { type: "content", value: [{ type: "text", text: "{}" }] } }] },
    ]
    const out = withCacheBreakpoint(messages)
    expect((out[2]!.content as { providerOptions?: unknown }[])[0]!.providerOptions).toBeDefined()
  })
})

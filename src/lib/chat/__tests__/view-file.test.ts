import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { PDFDocument } from "pdf-lib"
import { kojiRow } from "../../convert/__tests__/helpers"
import { fileAddressLookup } from "../../convert/address-file"
import { EMPTY_INQUIRY_TEXT } from "../../inquiry/text"
import type { ChatChange } from "../proposals"
import { chatTools, IMAGE_READ_NOTE, MAX_TOOL_CALLS, newTurnState, withCacheBreakpoint } from "../turn"
import { APICallError } from "ai"
import { imageInfo, unviewableAfter, viewIdle, viewStepFinished, MAX_VIEW_CALLS, MAX_VIEW_IMAGE_BYTES, MAX_VIEW_IMAGE_PX, MAX_VIEW_IMAGES_PER_CHAT, MAX_VIEW_PAGES, MAX_VIEW_PAGES_PER_CHAT, newViewState, parsePages, viewedInHistory, viewFile, viewResultOutput, type FileViewer, type ViewResult } from "../view-file"
import { deriveTable } from "../../cases/view"
import { cellFix } from "../../../components/convert/status"
import { viewKindOf } from "../view-kind"

async function pdfOf(pages: number) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([100, 100])
  return doc.save()
}

/** 決まったファイルの viewer と見せた状態。上げたファイル（名前・形式・PDF ならページ数）を uploads に残す */
function viewerOf(files: Record<string, Uint8Array>, history: ModelMessage[] = []) {
  const uploads: { name: string; type: string; pages?: number }[] = []
  let reads = 0
  const viewer: FileViewer = {
    files: Object.entries(files).map(([name, bytes], i) => ({ name, original: `元の名前${i}${/\.[^.]+$/.exec(name)![0]}`, id: `file_${i}`, size: bytes.byteLength })),
    read: async (name) => {
      reads++
      return files[name] ?? null
    },
    upload: async (bytes, name, type) => {
      uploads.push({ name, type, ...(type === "application/pdf" ? { pages: (await PDFDocument.load(bytes)).getPageCount() } : {}) })
      return `file_up${uploads.length}`
    },
  }
  return { viewer, uploads, state: newViewState(viewer, history), reads: () => reads }
}

/** 縦横を持つ最小の PNG・JPEG の先頭（imageInfo が読むところだけ） */
function png(width: number, height: number) {
  const b = new Uint8Array(40)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}
function jpeg(width: number, height: number) {
  const b = new Uint8Array(60)
  // SOI、APP0（長さ 16）、SOF0（長さ 17: 精度・縦・横）
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16], 0)
  b.set([0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff], 20)
  return b
}
const heic = () => {
  const b = new Uint8Array(40)
  b.set([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic")])
  return b
}
const jpg = jpeg(1200, 900)

describe("ファイルの種類ごとの見せ方", () => {
  test("PDF は document、JPEG・PNG・GIF・WebP は image、HEIC は見られない、ほかは見せない", () => {
    expect(viewKindOf("a.PDF")).toEqual({ kind: "pdf", mediaType: "application/pdf" })
    expect(viewKindOf("写真.jpeg")).toEqual({ kind: "image", mediaType: "image/jpeg" })
    expect(viewKindOf("x.png")?.kind).toBe("image")
    expect(viewKindOf("x.webp")?.kind).toBe("image")
    expect(viewKindOf("IMG_0001.HEIC")).toEqual({ kind: "heic" })
    expect(viewKindOf("台帳.xlsx")).toBeNull()
  })

  test("画像の中身の形式と縦横を読む", () => {
    expect(imageInfo(png(3000, 2000))).toEqual({ mediaType: "image/png", width: 3000, height: 2000 })
    expect(imageInfo(jpeg(4032, 3024))).toEqual({ mediaType: "image/jpeg", width: 4032, height: 3024 })
    expect(imageInfo(heic())).toBe("heic")
    expect(imageInfo(new Uint8Array(40))).toBeNull()
  })

  test("ページ数の少ない PDF は、上げてあるファイルをそのまま見せる（切り出さない）", async () => {
    const { uploads, state } = viewerOf({ "file-1.pdf": await pdfOf(3) })
    const r = await viewFile(state, { file: "file-1.pdf" })
    expect(r).toMatchObject({ ok: true, fileId: "file_0", mediaType: "application/pdf", pages: { from: 1, to: 3, total: 3 } })
    expect(uploads).toEqual([])
    expect(state.pages).toBe(3)
    const out = viewResultOutput(r)
    expect(out.value[1]).toEqual({ type: "file", mediaType: "application/pdf", data: { type: "reference", reference: { anthropic: "file_0" } } })
    expect(out.value[0]!.type === "text" && out.value[0]!.text).not.toContain("file_0")
  })

  test("pages を指定すると、そのページだけを切り出して上げ、上げた id を記録する。同じ PDF は指示の間で読み直さない", async () => {
    const { uploads, state, reads } = viewerOf({ "file-1.pdf": await pdfOf(30) })
    expect(await viewFile(state, { file: "$INPUT_DIR/file-1.pdf", pages: "11-15" })).toMatchObject({ ok: true, fileId: "file_up1", pages: { from: 11, to: 15, total: 30 } })
    expect(await viewFile(state, { file: "file-1.pdf", pages: "16-17" })).toMatchObject({ ok: true, fileId: "file_up2" })
    expect(uploads).toEqual([
      { name: "file-1-p11-15.pdf", type: "application/pdf", pages: 5 },
      { name: "file-1-p16-17.pdf", type: "application/pdf", pages: 2 },
    ])
    expect(state.uploads).toEqual(["file_up1", "file_up2"])
    expect(reads()).toBe(1)
  })

  test("この会話でもう見せた範囲は、ファイルを添えず・上げず・数えずに、上の結果を見るよう返す（履歴の分も）", async () => {
    const { state, uploads } = viewerOf({ "file-1.pdf": await pdfOf(30), "file-2.jpg": jpg })
    await viewFile(state, { file: "file-1.pdf", pages: "1-5" })
    await viewFile(state, { file: "file-2.jpg" })
    const again = await viewFile(state, { file: "file-1.pdf", pages: "1-5" })
    expect(again).toMatchObject({ ok: true, repeated: true, pages: { from: 1, to: 5, total: 30 } })
    expect(viewResultOutput(again).value).toHaveLength(1)
    expect(await viewFile(state, { file: "file-2.jpg" })).toMatchObject({ ok: true, repeated: true })
    expect({ pages: state.pages, images: state.images, uploads: uploads.length }).toEqual({ pages: 5, images: 1, uploads: 1 })
    // 次の指示: 履歴から見せた範囲を読む
    const history: ModelMessage[] = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "v", toolName: "view_file", output: viewResultOutput((await viewFile(viewerOf({ "file-1.pdf": await pdfOf(30) }).state, { file: "file-1.pdf", pages: "1-5" })) as ViewResult) }] }]
    expect(await viewFile(viewerOf({ "file-1.pdf": await pdfOf(30) }, history).state, { file: "file-1.pdf", pages: "1-5" })).toMatchObject({ repeated: true })
  })

  test("画像は中身で形式と縦横を確かめる。拡張子と形式が違えば中身の形式で上げ直す。大きすぎる画像・縦横・HEIC・pages 付きは理由を返す", async () => {
    const { state, uploads } = viewerOf({
      "file-1.jpg": jpg,
      "file-2.png": new Uint8Array(MAX_VIEW_IMAGE_BYTES + 1),
      "file-3.heic": jpg,
      "file-4.jpg": png(800, 600),
      "file-5.png": png(MAX_VIEW_IMAGE_PX + 1, 100),
      "file-6.jpg": heic(),
      "file-7.png": new Uint8Array(40),
    })
    const r = await viewFile(state, { file: "file-1.jpg" })
    expect(r).toMatchObject({ ok: true, mediaType: "image/jpeg", fileId: "file_0" })
    expect(r.ok && "pages" in r && r.pages).toBeFalsy()
    expect(viewResultOutput(r).value[1]).toMatchObject({ type: "file", mediaType: "image/jpeg" })
    expect(state.images).toBe(1)
    const error = async (file: string, pages?: string) => {
      const res = await viewFile(state, { file, ...(pages ? { pages } : {}) })
      return res.ok ? "" : res.error
    }
    expect(await error("file-2.png")).toContain("大きすぎます")
    expect(await error("file-3.heic")).toContain("JPEG で保存し直して")
    expect(await viewFile(state, { file: "file-4.jpg" })).toMatchObject({ ok: true, mediaType: "image/png", fileId: "file_up1" })
    expect(uploads).toEqual([{ name: "file-4.jpg", type: "image/png" }])
    expect(await error("file-5.png")).toContain("縦横が大きすぎます")
    expect(await error("file-6.jpg")).toContain("HEIC")
    expect(await error("file-7.png")).toContain("画像として読めません")
    expect(await error("file-1.jpg", "1")).toContain("PDF のときだけ")
    expect(await error("file-9.jpg")).toContain("案件のファイルにありません")
    expect(state.images).toBe(2)
  })

  test("縦横が 0 の画像は読めない画像として断る", () => {
    expect(imageInfo(jpeg(0, 100))).toBeNull()
    expect(imageInfo(png(100, 0))).toBeNull()
  })

  test("中身が PDF でないファイルは開かずに断る", async () => {
    const { state } = viewerOf({ "file-1.pdf": jpg })
    expect(await viewFile(state, { file: "file-1.pdf" })).toMatchObject({ ok: false })
  })
})

describe("同時の呼び出し・止めた回・API が断ったファイル", () => {
  test("同時に呼んでも1つずつ順に動く: 同じ PDF は1回だけ開き、同じ範囲は1回だけ見せ、上限もすり抜けない", async () => {
    const { state, uploads, reads } = viewerOf({ "file-1.pdf": await pdfOf(30), "file-2.pdf": await pdfOf(30) })
    let open = 0
    let most = 0
    const read = state.viewer.read
    state.viewer = {
      ...state.viewer,
      read: async (name) => {
        most = Math.max(most, ++open)
        await new Promise((r) => setTimeout(r, 5))
        open--
        return read(name)
      },
    }
    const same = await Promise.all([viewFile(state, { file: "file-1.pdf", pages: "1-5" }), viewFile(state, { file: "file-1.pdf", pages: "1-5" }), viewFile(state, { file: "file-2.pdf", pages: "1-5" })])
    expect(same.map((r) => r.ok && "repeated" in r)).toEqual([false, true, false])
    expect(most).toBe(1)
    expect(reads()).toBe(2)
    expect(uploads).toHaveLength(2)
    // 会話の上限: 残り 10 ページのところへ 10 ページを2つ同時に頼むと、1つだけ通る
    state.pages = MAX_VIEW_PAGES_PER_CHAT - 10
    const over = await Promise.all([viewFile(state, { file: "file-1.pdf", pages: "11-20" }), viewFile(state, { file: "file-2.pdf", pages: "11-20" })])
    expect(over.map((r) => r.ok)).toEqual([true, false])
    expect(state.pages).toBe(MAX_VIEW_PAGES_PER_CHAT)
  })

  test("止めたあとに列で待っていた呼び出しは何もしない。上げている途中のファイルは、待ってから記録できる", async () => {
    const { state, uploads } = viewerOf({ "file-1.pdf": await pdfOf(30) })
    // 1つ目が上げている途中で止める（上げ終わるのは止めたあと）
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const upload = state.viewer.upload
    state.viewer = {
      ...state.viewer,
      upload: async (...args) => {
        started.resolve()
        await gate.promise
        return upload(...args)
      },
    }
    const abort = new AbortController()
    const first = viewFile(state, { file: "file-1.pdf", pages: "1-2" }, abort.signal)
    const second = viewFile(state, { file: "file-1.pdf", pages: "3-4" }, abort.signal)
    await started.promise
    abort.abort()
    gate.resolve()
    await viewIdle(state)
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: false, error: "止めました" })
    expect(state.uploads).toEqual(["file_up1"])
    expect(uploads).toHaveLength(1)
  })

  test("API が 400 で断ったら、その呼び出しで初めて送ったファイルを見られないと覚える。覚えたファイルは理由を返す", async () => {
    const { state } = viewerOf({ "file-1.jpg": jpg, "file-2.jpg": jpg })
    await viewFile(state, { file: "file-1.jpg" })
    viewStepFinished(state)
    // file-1 を送った呼び出しは通った。次の往復で file-2 を見せた
    await viewFile(state, { file: "file-2.jpg" })
    viewStepFinished(state)
    const error = new APICallError({ message: "Could not process image", url: "x", requestBodyValues: {}, statusCode: 400, isRetryable: false })
    expect(unviewableAfter(state, error)).toEqual([{ name: "file-2.jpg", reason: expect.stringContaining("Could not process image") }])
    expect(unviewableAfter(state, new APICallError({ message: "overloaded", url: "x", requestBodyValues: {}, statusCode: 529, isRetryable: true }))).toEqual([])
    expect(unviewableAfter(state, new Error("止めました"))).toEqual([])
    const next = viewerOf({ "file-2.jpg": jpg })
    const viewer = { ...next.viewer, files: next.viewer.files.map((f) => ({ ...f, unviewable: "API がこのファイルを受け取りませんでした" })) }
    const r = await viewFile(newViewState(viewer, []), { file: "file-2.jpg" })
    expect(!r.ok && r.error).toContain("もう見せません")
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
    const { uploads, state } = viewerOf({ "file-1.pdf": await pdfOf(MAX_VIEW_PAGES + 5) })
    const r = await viewFile(state, { file: "file-1.pdf" })
    expect(r).toMatchObject({ ok: false, totalPages: MAX_VIEW_PAGES + 5, error: expect.stringContaining(`1-${MAX_VIEW_PAGES}`) })
    expect(uploads).toEqual([])
  })

  test(`1つの会話で見られるのは ${MAX_VIEW_PAGES_PER_CHAT} ページ・画像 ${MAX_VIEW_IMAGES_PER_CHAT} 枚まで（履歴で見た分と合わせる）。超えたら職員に伝えるよう返す`, async () => {
    const { state } = viewerOf({ "file-1.pdf": await pdfOf(10), "file-2.jpg": jpg })
    state.pages = MAX_VIEW_PAGES_PER_CHAT - 12
    state.images = MAX_VIEW_IMAGES_PER_CHAT
    expect(await viewFile(state, { file: "file-1.pdf" })).toMatchObject({ ok: true })
    const over = await viewFile(state, { file: "file-1.pdf", pages: "1-3" })
    expect(over.ok).toBe(false)
    expect(!over.ok && over.error).toContain("あと 2 ページ")
    expect(!over.ok && over.error).toContain("職員に伝え")
    expect(await viewFile(state, { file: "file-2.jpg" })).toMatchObject({ ok: false, error: expect.stringContaining(`${MAX_VIEW_IMAGES_PER_CHAT} 枚まで`) })
  })

  test("履歴で見たページ数と画像の数を数える（見られなかった回は数えない）", () => {
    const result = (r: ViewResult): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "v", toolName: "view_file", output: viewResultOutput(r) }] })
    const history = [
      result({ ok: true, file: "file-1.pdf", original: "a.pdf", mediaType: "application/pdf", fileId: "f1", pages: { from: 3, to: 7, total: 9 }, note: "" }),
      result({ ok: true, file: "file-2.jpg", original: "b.jpg", mediaType: "image/jpeg", fileId: "f2", note: "" }),
      result({ ok: true, repeated: true, file: "file-1.pdf", pages: { from: 3, to: 7, total: 9 }, note: "" }),
      result({ ok: false, error: "x" }),
    ]
    expect(viewedInHistory(history)).toEqual({ pages: 5, images: 1, shown: new Set(["file-1.pdf:3-7", "file-2.jpg"]) })
  })
})

describe("view_file の道具と手書きの印", () => {
  const table = { rows: [kojiRow({ gyoshu: "8", client: "株式会社テスト", workName: "テスト工事", amount: "1000", endYm: "" }, 2)], added: [], edits: new Map(), replacements: {}, manual: new Map(), tax: "excluded" as const, basis: {}, rule7Tax: "excluded" as const, selection: "all" as const, rounding: "floor" as const, dismissed: new Set<string>(), inquiryText: EMPTY_INQUIRY_TEXT }
  const call = async (state: ReturnType<typeof newTurnState>, name: string, input: unknown) => {
    const t = (chatTools(state) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>)[name]!
    const out = await t.execute(input, { toolCallId: "t", messages: [] })
    return typeof out === "string" ? JSON.parse(out) : out
  }

  test(`view_file は直接呼ぶ道具で、ほかの道具とは別に1回の指示で ${MAX_VIEW_CALLS} 回まで。viewer が無ければ使えない`, async () => {
    const tools = chatTools(newTurnState(table))
    expect((tools.view_file as { providerOptions?: unknown }).providerOptions).toBeUndefined()
    expect((await call(newTurnState(table), "view_file", { file: "file-1.pdf" })).error).toContain("使えません")
    const state = newTurnState(table, undefined, undefined, null, null, null, null, null, viewerOf({ "file-1.jpg": jpg }).viewer)
    state.toolCalls = MAX_TOOL_CALLS
    expect(await call(state, "view_file", { file: "file-1.jpg" })).toMatchObject({ ok: true })
    expect(state.toolCalls).toBe(MAX_TOOL_CALLS)
    state.viewCalls = MAX_VIEW_CALLS
    expect((await call(state, "view_file", { file: "file-1.jpg" })).error).toContain("ファイルを見られる回数")
  })

  test('read_from:"image" で足した行・直したセル・顧客の回答のメモに、手書き・画像から読んだ印を付けて要確認にする（問い合わせには回さない。確認 confirm と省いたときは付けない）', async () => {
    const state = newTurnState(table, undefined, undefined, null, { lookup: fileAddressLookup })
    await call(state, "add_rows", { rows: [{ cells: { gyoshu: "8", amount: "500" } }], read_from: "image" })
    await call(state, "set_cells", { changes: [{ key: "s!2", field: "amount", value: "1200" }], read_from: "image" })
    await call(state, "record_answers", { items: [{ key: "s!2", field: "endYm", answer: "2024年9月" }, { key: "s!2", field: "client", confirm: true }], read_from: "image" })
    await call(state, "set_cells", { changes: [{ key: "s!2", field: "gyoshu", value: "9" }] })
    const changes = state.pending as ChatChange[]
    const [add, cell, answer] = changes
    expect(add!.kind === "add" && Object.values(add!.cells).every((e) => e!.message!.includes(IMAGE_READ_NOTE))).toBe(true)
    expect(cell!.kind === "cell" && cell!.edit).toMatchObject({ value: "1200", status: "warning", message: IMAGE_READ_NOTE })
    expect(answer!.kind === "cell" && answer!.edit).toMatchObject({ value: "202409", by: "customer", status: "warning", message: IMAGE_READ_NOTE })
    const rest = changes.slice(3).flatMap((c) => (c.kind === "cell" ? [c] : []))
    expect(rest.every((c) => !c.edit.message?.includes(IMAGE_READ_NOTE))).toBe(true)
    expect(rest.find((c) => c.field === "gyoshu")!.edit.status).not.toBe("warning")
    // 要確認は「直す」に出る（職員が「これでよい」で片付ける）が、推定ではないので問い合わせには回らない
    const row = deriveTable(state.current).shown.find((r) => r.key === "s!2")!
    expect(cellFix(row.cells.amount, "amount", true)).toBe("review")
    expect(row.cells.amount.guessed).toBeFalsy()
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

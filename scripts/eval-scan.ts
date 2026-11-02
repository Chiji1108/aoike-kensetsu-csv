/**
 * 文字の層の無い PDF・手書きの写真の照合: 変換の元の表が無い案件（届いたファイルが PDF・画像だけ）で、画面の「PDF から表を作って」と同じ1回の指示を
 * 本物の AI に送り、足した行（変更案を全部承認したもの）を期待の値と比べる。合成の例は scripts/make-sample-scan.ts（fixtures/eval/synth-scan/）。
 *
 *   EVAL_OUT=<結果を書くフォルダ> bun scripts/eval-scan.ts [<指示>]
 *
 * 結果は EVAL_OUT の scan.json（行ごとの値と一致・道具の記録・費用）。費用は costs.jsonl にも足す。
 */
import Anthropic, { toFile } from "@anthropic-ai/sdk"
import type { ModelMessage } from "ai"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { newWork } from "../src/lib/cases/state"
import { deriveTable, type CaseTable } from "../src/lib/cases/view"
import { containerName, contentTypeOf } from "../src/lib/cases/types"
import { NO_SOURCE_CONTEXT } from "../src/lib/chat/context"
import { applyChanges } from "../src/lib/chat/proposals"
import { DEFAULT_GLOBAL_RULE_ITEMS, rulesText } from "../src/lib/chat/rules"
import { IMAGE_READ_NOTE, newTurnState, startTurn, systemPrompt } from "../src/lib/chat/turn"
import { fileAddressLookup } from "../src/lib/convert/address-file"
import { tokensOfAiSdk, usdOf } from "../src/lib/cost"
import { recordCost } from "../src/lib/eval/report"
import { batchWithClaude } from "../src/server/claude"
import { localViewer } from "./view-local"
import { viewIdle } from "../src/lib/chat/view-file"

const ROOT = new URL("..", import.meta.url).pathname
const apiKey = process.env.ANTHROPIC_API_KEY ?? readFileSync(join(ROOT, ".dev.vars"), "utf8").match(/ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)/)?.[1]
if (!apiKey) throw new Error("ANTHROPIC_API_KEY が無い（環境変数か .dev.vars）")
const OUT = process.env.EVAL_OUT
if (!OUT) throw new Error("EVAL_OUT（結果のフォルダ）を指定")
mkdirSync(OUT, { recursive: true })
const DIR = join(ROOT, "fixtures/eval/synth-scan")
const FILES = ["工事経歴_スキャン.pdf", "手書きメモ.jpg"]
const TEXT = process.argv[2] ?? "PDF と写真から工事経歴の表を作って"
const FIELDS = ["client", "workName", "motoukeShitauke", "prefecture", "place", "engineer", "amount", "startYm", "endYm"] as const
type Truth = Record<(typeof FIELDS)[number], string> & { file: string }
const truth = JSON.parse(readFileSync(join(DIR, "期待.json"), "utf8")) as Truth[]

const anthropic = new Anthropic({ apiKey })
const spend = (kind: string, usd: number) => recordCost(OUT, { case: "synth-scan", variant: "scan", kind, usd })
const w = newWork()
let table: CaseTable = { rows: [], added: w.added, edits: w.edits, replacements: w.replacements, manual: w.manual, tax: w.tax, basis: w.basis, rule7Tax: w.rule7Tax, selection: w.selection, rounding: w.rounding, dismissed: w.dismissed, inquiryText: w.inquiryText }

const uploads: { id: string; name: string; original: string; path: string }[] = []
let state: ReturnType<typeof newTurnState> | null = null
const t0 = Date.now()
try {
  for (const [i, original] of FILES.entries()) {
    const name = containerName(i, original)
    const up = await anthropic.files.upload({ file: await toFile(readFileSync(join(DIR, original)), name, { type: contentTypeOf(original) }) })
    uploads.push({ id: up.id, name, original, path: join(DIR, original) })
  }
  const system = systemPrompt({ global: rulesText(DEFAULT_GLOBAL_RULE_ITEMS.map((text) => ({ text }))), customerName: "合成サンプル電設", customer: "", rule7Tax: "excluded" }, NO_SOURCE_CONTEXT, uploads.map((u) => ({ name: u.name, original: u.original, isSource: false })))
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        ...uploads.map((u) => ({ type: "file" as const, mediaType: contentTypeOf(u.original), data: { type: "reference" as const, reference: { anthropic: u.id } }, providerOptions: { anthropic: { containerUpload: true } } })),
        { type: "text" as const, text: TEXT },
      ],
    },
  ]
  state = newTurnState(
    table,
    async (req) => {
      const r = await batchWithClaude(anthropic, req)
      spend("anonymize", r.usd)
      return r
    },
    undefined,
    null,
    { lookup: fileAddressLookup },
    null,
    null,
    null,
    localViewer(anthropic, uploads),
  )
  const result = startTurn({ apiKey, system, messages, state })
  let reply = ""
  const calls: string[] = []
  const usages: { input: number; cacheRead: number; cacheWrite: number; output: number }[] = []
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") reply += part.text
    else if (part.type === "finish-step") {
      spend("chat", usdOf(tokensOfAiSdk(part.usage)))
      usages.push({ input: part.usage.inputTokens ?? 0, cacheRead: part.usage.inputTokenDetails?.cacheReadTokens ?? 0, cacheWrite: part.usage.inputTokenDetails?.cacheWriteTokens ?? 0, output: part.usage.outputTokens ?? 0 })
    } else if (part.type === "tool-call") calls.push(part.toolName === "code_execution" ? "code" : part.toolName)
    else if (part.type === "error") throw new Error(`stream error: ${String((part.error as { responseBody?: string }).responseBody ?? part.error)}`.slice(0, 600))
  }
  const usage = await result.totalUsage
  const usd = usdOf(tokensOfAiSdk(usage)) + state.anonymizeUsd
  table = applyChanges(table, deriveTable(table).edited, state.pending)
  const shown = deriveTable(table).shown
  /** 期待の行ごとに、工事名の一番近い行と比べる（工事名の空白と記号は除く） */
  const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "")
  const rows = truth.map((t) => {
    const r = shown.find((x) => norm(x.cells.workName.value) === norm(t.workName)) ?? shown.find((x) => x.cells.amount.value === t.amount)
    const cells = Object.fromEntries(FIELDS.map((f) => [f, { want: t[f], got: r?.cells[f].value ?? null, ok: !!r && norm(r.cells[f].value) === norm(t[f]) }]))
    const marked = !!r && FIELDS.some((f) => r.cells[f].message?.includes(IMAGE_READ_NOTE))
    return { file: t.file, found: !!r, marked, cells }
  })
  const per = (pick: (r: (typeof rows)[number]) => boolean) => {
    const xs = rows.filter(pick)
    const n = xs.length * FIELDS.length
    const ok = xs.reduce((k, r) => k + FIELDS.filter((f) => r.cells[f]!.ok).length, 0)
    return { rows: xs.length, found: xs.filter((r) => r.found).length, marked: xs.filter((r) => r.marked).length, cells: `${ok}/${n}` }
  }
  const byFile = Object.fromEntries([...new Set(truth.map((t) => t.file))].map((f) => [f, per((r) => r.file === f)]))
  const summary = { text: TEXT, ms: Date.now() - t0, usd, calls, toolLog: state.log, extraRows: shown.length - rows.filter((r) => r.found).length, byFile, all: per(() => true), usages, reply }
  writeFileSync(join(OUT, "scan.json"), JSON.stringify({ ...summary, rows }, null, 1))
  console.log(JSON.stringify({ ...summary, usages: undefined, reply: reply.slice(0, 500) }, null, 1))
  for (const r of rows) for (const f of FIELDS) if (!r.cells[f]!.ok) console.log(`  ✗ ${r.file} ${f}: want「${r.cells[f]!.want}」 got「${r.cells[f]!.got}」`)
} finally {
  if (state?.view) await viewIdle(state.view)
  for (const id of [...uploads.map((u) => u.id), ...(state?.view?.uploads ?? [])]) await anthropic.files.delete(id).catch((e) => console.log("delete failed", id, String(e).slice(0, 120)))
}

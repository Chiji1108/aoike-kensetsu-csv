import { env, waitUntil } from "cloudflare:workers"
import Anthropic, { toFile } from "@anthropic-ai/sdk"
import { createUIMessageStream, createUIMessageStreamResponse, generateId, toUIMessageStream, type ModelMessage, type UserModelMessage } from "ai"
import { z } from "zod"
import { getDb } from "@/db"
import { containerName, contentTypeOf, type Case } from "@/lib/cases/types"
import { fromWire, caseTableWireSchema } from "@/lib/chat/wire"
import { ENDED_TEXT, type ChatHistory, type ChatMessage, type ChatMetadata } from "@/lib/chat/messages"
import { approvedChatProposals, carryoverPrompt, cleanCarryoverCodes, codesFromUi, knownWords, namesForCarryover, type Carryover } from "@/lib/chat/carryover"
import { tryParseJson } from "@/lib/json"
import { savedAiCacheSchema, savedWorkSchema } from "@/lib/cases/state"
import { mappingPlanSchema } from "@/lib/convert/plan-schema"
import { sheetShapeSchema } from "@/lib/convert/plan-patch"
import { newProposal, proposalKey, proposalPrefix, proposalRecordSchema, type ProposalRecord } from "@/lib/chat/proposals"
import { newTurnState, startTurn, systemPrompt, type ContainerFile, type TurnStep } from "@/lib/chat/turn"
import { tokensOfAiSdk, usdOf } from "@/lib/cost"
import { errorMessage } from "@/lib/errors"
import * as store from "./case-store"
import { batchWithClaude } from "./claude"
import {
  abandonTurn,
  beginTurn,
  ChatBusyError,
  ChatConflictError,
  endSession,
  loadChat,
  saveChat,
  settleSession,
  type ChatBucket,
  type ChatDoc,
  type ChatSession,
  type Loaded,
  type TurnOutcome,
} from "./chat-store"
import { signedIn, text } from "./http"
import { finishTurn, watchStop } from "./turn-close"
import { searchLocation } from "./location"
import { locateOne } from "./location-run"
import * as loc from "./location-store"
import { serverPlaceIndex } from "./place-index"
import { personalChecker } from "./location-guard"
import { guardPersonal, type Site } from "@/lib/location/sites"


const requestSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(10_000),
  table: caseTableWireSchema,
  context: z.string().max(50_000),
  sourceFileId: z.string().max(64).nullable(),
  /** 今の列の対応と計画の元のシートの大きさ（チャットの set_plan の確かめ。変換の元の表が無い案件は null） */
  plan: z.object({ plan: mappingPlanSchema, shape: sheetShapeSchema }).nullable().default(null),
  carryover: z.boolean().optional(),
  /** 去年の元の Excel の配置技術者の列の値（画面が去年の Excel から読む。去年のコードの個人名を消すのに使う） */
  // 値の長さでは断らない（長い値は名前にしないだけ。lib/chat/carryover.ts の collectNames）
  carryoverNames: z.array(z.string()).max(20_000).optional(),
  /** 去年と今年の元の Excel の見出し（去年のコードの文字列のうち、見出しの名前は伏せずに残す） */
  carryoverHeaders: z.array(z.string()).max(2_000).optional(),
})

/** 止める印を見に行く間隔 */
const STOP_POLL_MS = 1_000

/** 指示を止める印（R2。案件のキーの頭の下に置くので、案件を消すと一緒に消える） */
const stopKey = (caseId: string, turnId: string) => `cases/${caseId}/chat-stop/${encodeURIComponent(turnId)}`

/** 指示を止める（画面の「止める」）。処理している Worker が印を見て AI の呼び出しを止め、それまでの費用と作ったファイルを記録する */
export async function stopChat(caseId: string, turnId: string) {
  const { doc } = await loadChat(bucket(), caseId)
  if (doc.turn?.id === turnId) await env.FILES.put(stopKey(caseId, turnId), "")
}

/** コンテナがこれより早く切れるなら、新しいコンテナにする（指示の途中で切れないように） */
const CONTAINER_MARGIN_MS = 5 * 60_000

const bucket = () => env.FILES as unknown as ChatBucket

function anthropic() {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
}

/** コンテナの中の名前（顧客名などを Files API の名前に出さない。拡張子だけ残す） */

/**
 * チャットの1回の指示（POST /api/cases/<caseId>/chat）。本文は JSON（ChatRequest）。JSON の本文は CORS の許可が無いと
 * ほかのサイトから送れないので、Content-Type を確かめる（サーバー関数の CSRF の確かめの代わり）。返事は AI SDK の UI メッセージのストリーム
 */
export const chatTurn = (request: Request, caseId: string) => signedIn(request, () => runTurn(request, caseId))

async function runTurn(request: Request, caseId: string): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return text("本文は JSON で送ってください", 415)
  if (!env.ANTHROPIC_API_KEY) return text("APIキー未設定（ANTHROPIC_API_KEY）のため、チャットは使えません", 503)
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return text("本文の JSON が読めません", 400)
  }
  const parsed = requestSchema.safeParse(json)
  if (!parsed.success) return text("指示の形が正しくありません", 400)
  const body = parsed.data

  const db = getDb()
  const kase = await store.getCase(db, caseId)
  if (!kase || kase.deleting) return text("案件が見つかりません", 404)
  const [customer, files, rules] = await Promise.all([store.getCustomer(db, kase.customerId), store.listFiles(db, caseId), store.rulesForAi(db, kase.customerId)])
  // 「去年のやり方で直す」: 前の年度の案件があるかだけ先に見る（去年の会話・作業は、印を取ってこの会話でまだ添えていないと分かってから読む）
  const previous = body.carryover ? await store.previousCase(db, kase) : undefined
  if (body.carryover && !previous) return text("前の年度の案件が見つかりません", 404)

  // 指示を処理している印を立てる。ここから下ろすまで、この案件の会話を書くのはこの指示だけ
  const turn = { id: body.id, startedAt: Date.now() }
  let loaded: Loaded
  try {
    const held = await beginTurn(bucket(), caseId, turn)
    // 印を取る前に削除が始まっていたら何もしない（削除は会話を終えてから R2 を消すので、そのあとに会話を作り直さない）
    const now = await store.getCase(db, caseId)
    if (!now || now.deleting) {
      await abandonTurn(bucket(), caseId, held)
      return text("案件が見つかりません", 404)
    }
    loaded = held
  } catch (e) {
    if (e instanceof ChatBusyError || e instanceof ChatConflictError) return text(e.message, 409)
    throw e
  }
  const startSession: ChatSession = loaded.doc.session ?? { model: [], container: null, files: [], generated: [] }
  let carryover: Carryover | null = null
  if (previous) {
    if (startSession.carryover) {
      await endTurn(caseId, loaded, { ...loaded.doc, turn: null })
      return text("この会話にはもう去年のコードを添えています（会話を終えると、もう一度添えられます）", 409)
    }
    try {
      const words = knownWords(body.table, [rules.global, rules.customer], body.carryoverHeaders ?? [])
      carryover = await carryoverOf(db, previous, { previousEngineers: body.carryoverNames, current: body.table }, words)
    } catch (e) {
      await endTurn(caseId, loaded, { ...loaded.doc, turn: null })
      return text(errorMessage(e, "去年の案件の会話を読めませんでした"), 502)
    }
  }
  const carryText = carryover && carryoverPrompt(carryover)
  const containerLive = startSession.container !== null && Date.parse(startSession.container.expiresAt) > Date.now() + CONTAINER_MARGIN_MS

  // 案件の届いたファイルをコンテナに渡す。まだ上げていないものは Files API に上げ、上げるたびに記録する（途中で失敗しても、会話を終えるときに消せる）。
  // コンテナが新しくなるときは全部を付け直す
  let session = startSession
  const added: ChatSession["files"] = []
  try {
    for (const f of files.filter((f) => f.kind === "source")) {
      if (session.files.some((s) => s.caseFileId === f.id)) continue
      const row = await store.getFileRow(db, f.id)
      const object = row && (await env.FILES.get(row.r2Key))
      if (!object) continue
      const name = containerName(session.files.length, f.name)
      const up = await anthropic().files.upload({ file: await toFile(await object.arrayBuffer(), name, { type: contentTypeOf(f.name) }) })
      const file = { anthropicId: up.id, caseFileId: f.id, name, original: f.name }
      added.push(file)
      session = { ...session, files: [...session.files, file] }
      loaded = await saveChat(bucket(), caseId, loaded, { ...loaded.doc, session })
    }
  } catch (e) {
    // 上げたのに記録できなかったファイルは、あとで消せないので今消す。消せなくても印は下ろし、渡せなかったことを知らせる
    const known = new Set(loaded.doc.session?.files.map((f) => f.anthropicId))
    const unrecorded = added.filter((f) => !known.has(f.anthropicId)).map((f) => f.anthropicId)
    const leftover = await deleteAnthropicFiles(unrecorded).then(
      () => null,
      (err: unknown) => err,
    )
    await endTurn(caseId, loaded, { ...loaded.doc, turn: null })
    if (leftover) console.error("記録できなかった Files API のファイルを消せませんでした", unrecorded, leftover)
    return text(errorMessage(e, "AI にファイルを渡せませんでした"), 502)
  }
  const attach = containerLive ? added : session.files

  const userModel: UserModelMessage = {
    role: "user",
    content: [
      ...attach.map((f) => ({
        type: "file" as const,
        mediaType: contentTypeOf(f.original),
        data: { type: "reference" as const, reference: { anthropic: f.anthropicId } },
        providerOptions: { anthropic: { containerUpload: true } },
      })),
      // 去年のコードは AI への指示の前に添える（画面の会話には出さない。印だけを返事に付ける）
      ...(carryText ? [{ type: "text" as const, text: carryText.text }] : []),
      { type: "text" as const, text: body.text },
    ],
  }
  const userUi: ChatMessage = { id: body.id, role: "user", parts: [{ type: "text", text: body.text }] }
  const containerFiles: ContainerFile[] = session.files.map((f) => ({ name: f.name, original: f.original, isSource: f.caseFileId === body.sourceFileId }))
  const system = systemPrompt({ ...rules, customerName: customer?.name ?? "" }, body.context, containerFiles)
  // 止める: 画面の「止める」（止める印を R2 に置く）か、タブを閉じた（request.signal。本番の enable_request_signal）で AI の呼び出しを止める（工事場所の検索も）
  const abort = new AbortController()
  request.signal.addEventListener("abort", () => abort.abort(request.signal.reason), { once: true })
  // 工事場所の「この現場ってどこ？」はチャットとは別のやり取りで調べる（コード実行と同じやり取りに Web 検索を入れない。検索の結果は履歴に積まず、答えだけを道具の結果にする）
  // 住所データの索引と個人名の確かめは、工事場所を調べるときだけ作る
  let checker: Promise<(text: string) => boolean> | undefined
  const guard = async (sites: Site[]) => guardPersonal(sites, await (checker ??= personalChecker(db, caseId, body.table)))
  // 注文者・工事名に AI が書いた値は、変換と同じ匿名化の AI に通す（lib/chat/turn.ts の anonymizeChanges）
  const state = newTurnState(
    fromWire(body.table),
    (req) => batchWithClaude(anthropic(), req),
    {
      locate: (site, spent) =>
        locateOne(
          {
            index: serverPlaceIndex(),
            knowledge: (req) => batchWithClaude(anthropic(), req),
            search: (s, sp) => searchLocation(anthropic(), serverPlaceIndex(), s, sp, abort.signal),
            memorized: (keys) => loc.memorized(db, kase.customerId, keys),
          },
          site,
          spent,
        ),
      memorized: async (keys) => new Set((await loc.memorized(db, kase.customerId, keys)).keys()),
      guard,
    },
    body.plan,
  )
  /** 履歴・作ったファイル・費用を書き終えたら resolve する。印がまだ自分のもの（画面の会話を書いて下ろしてよい）なら true */
  const recorded = Promise.withResolvers<boolean>()

  const stream = createUIMessageStream<ChatMessage>({
    originalMessages: [...loaded.doc.ui, userUi],
    execute: async ({ writer }) => {
      const steps: TurnStep[] = []
      let completed: ModelMessage[] | null = null
      let failure: unknown = null
      const unwatch = watchStop(
        async () => (await env.FILES.head(stopKey(caseId, turn.id))) !== null,
        () => abort.abort(new Error("職員が止めました")),
        STOP_POLL_MS,
      )
      try {
        const result = startTurn({
          apiKey: env.ANTHROPIC_API_KEY,
          system,
          messages: [...session.model, userModel],
          state,
          containerId: containerLive ? session.container!.id : undefined,
          abortSignal: abort.signal,
          onStep: (step) => steps.push(step),
        })
        writer.merge(toUIMessageStream({ stream: result.stream, sendFinish: false }))
        // 画面が流れを読むのをやめても AI の呼び出しを最後まで（止めたならそこまで）進め、結果を待てるようにする
        void result.consumeStream()
        // 止めた回の responseMessages は途中までの内容で resolve せず reject する（lib/chat/__tests__/abort.test.ts で確かめている）ので、
        // ここに来たのは終わった回だけ
        completed = [userModel, ...(await result.responseMessages)]
      } catch (e) {
        failure = e
      } finally {
        unwatch()
      }
      // 止めた・失敗した回でも、終わった往復の費用と作ったファイルは記録する（後始末のため）
      const usd = steps.reduce((n, s) => n + usdOf(tokensOfAiSdk(s.usage)), 0) + state.anonymizeUsd + state.locationSpent.usd
      const outcome: TurnOutcome = { completed, steps: steps.flatMap((s) => s.messages), container: steps.at(-1)?.container ?? (containerLive ? session.container : null) }
      const proposal = !failure && (state.pending.length || state.question) ? newProposal(generateId(), { kind: "chat", messageId: body.id }, state.pending, state.question) : null
      let ours = true
      let shown = false
      try {
        const closed = await finishTurn({
          putProposal: proposal && (() => putProposal(caseId, { proposal, changes: state.pending })),
          deleteProposal: () => env.FILES.delete(proposalKey(caseId, proposal!.id)),
          cleanup: () => env.FILES.delete(stopKey(caseId, turn.id)),
          record: (ok) => {
            const settled = settleSession(session, ok ? outcome : { ...outcome, completed: null }, added.length > 0)
            // 去年のコードを添えた回が履歴に入ったら、この会話ではもう添えない
            return record(caseId, loaded, ok && outcome.completed && carryText ? { ...settled, carryover: true } : settled)
          },
          addCost: async () => {
            if (usd > 0) await store.addCaseCost(db, caseId, usd)
          },
        })
        if (closed.recorded) loaded = closed.recorded
        ours = closed.ours
        shown = closed.proposal
        failure ??= closed.error
      } finally {
        recorded.resolve(ours)
      }
      // この会話で去年のコードを添えたか（会話の記録の印。添えた回が履歴に入ったときだけ立つ）。画面はこれでボタンを出すかを決める
      const carried = loaded.doc.session?.carryover === true
      if (carryover && carryText && carried)
        writer.write({ type: "data-carryover", data: { fiscalYear: carryover.fiscalYear, codes: carryText.included, ...(carryover.skipped ? { skipped: carryover.skipped } : {}) } })
      // 一括調査を始めるボタン（検索は職員が押してから。件数と費用の目安を添える）
      if (state.locationOffer) writer.write({ type: "data-location-offer", data: state.locationOffer })
      // 画面の決まった処理を始めるボタン（書き出す前の確認・問い合わせの Excel・編集用の Excel）。止めた・失敗した回は出さない
      if (!failure) for (const action of state.actions) writer.write({ type: "data-action", data: { action } })
      // 置いた変更案は、後始末のほかの失敗があっても画面に出す（開き直したときと同じに見せる）
      if (proposal && shown) {
        writer.write({ type: "data-proposal", data: { id: proposal.id } })
        writer.write({ type: "data-proposal-content", data: { proposal, changes: state.pending }, transient: true })
      }
      // 費用は止めた・失敗した回でも画面に届ける（サーバーは足したので、画面の案件の合計と食い違わないように）
      const caseUsd = (await store.getCase(db, caseId).catch(() => undefined))?.costUsd ?? kase.costUsd + usd
      const total = steps.reduce((t, s) => ({ input: t.input + (s.usage.inputTokens ?? 0), output: t.output + (s.usage.outputTokens ?? 0) }), { input: 0, output: 0 })
      const metadata: ChatMetadata = { usd, caseUsd, ms: Date.now() - turn.startedAt, inputTokens: total.input, outputTokens: total.output, toolCalls: state.toolCalls, carryover: carried }
      writer.write({ type: "message-metadata", messageMetadata: metadata })
      if (failure) throw failure
      if (!ours) throw new ChatConflictError()
      writer.write({ type: "finish" })
    },
    // 画面の会話を書き、印を下ろす。タブを閉じた（流れを読むのをやめた）ときも呼ばれる。止めた・失敗した回は、指示と途中までの返事を残す
    onFinish: ({ messages }) => {
      waitUntil(
        recorded.promise.then(async (ok) => {
          if (ok) await endTurn(caseId, loaded, { ...loaded.doc, ui: messages, turn: null })
        }),
      )
    },
    onError: (e) => (e instanceof ChatConflictError ? e.message : errorMessage(e, "AI の呼び出しに失敗しました")),
  })
  return createUIMessageStreamResponse({ stream })
}

/**
 * 去年の案件の、職員が承認した変更案につながったコード（lib/chat/carryover.ts）。去年の作業の変更案の状態と画面の会話から取り出し、
 * 集めた個人名を〔個人名〕にし、知っている語（words）に無い固有名らしい語を含む文字列・コメントを伏せる。作業が無ければ（変換していない）コードも無い
 */
async function carryoverOf(db: store.Db, prev: Case, from: Omit<Parameters<typeof namesForCarryover>[0], "previous">, words: string): Promise<Carryover> {
  const row = await store.getCaseState(db, prev.id)
  if (!row) return { fiscalYear: prev.fiscalYear, codes: [] }
  // 去年の作業か AI の結果が今の形で読めなければ、個人名を消し切れないのでコードは添えない（顧客ルールだけで直す）
  const work = savedWorkSchema.safeParse(tryParseJson(row.json))
  const aiCache = savedAiCacheSchema.safeParse(tryParseJson(row.aiCache))
  if (!work.success || !aiCache.success) return { fiscalYear: prev.fiscalYear, codes: [], skipped: "去年の案件の作業を読めなかったので、コードは添えません" }
  const { ui } = (await loadChat(bucket(), prev.id)).doc
  const names = namesForCarryover({ ...from, previous: { work: work.data, aiCache: aiCache.data } })
  return { fiscalYear: prev.fiscalYear, codes: cleanCarryoverCodes(codesFromUi(ui, approvedChatProposals(work.data.proposals, work.data.undo)), names, words) }
}

/**
 * 会話の履歴・作ったファイルを書く（印は立てたまま）。書けなければ（印を引き継がれた）、この回で作ったファイルは記録できないので今消し、null を返す
 */
async function record(caseId: string, loaded: Loaded, session: ChatSession): Promise<Loaded | null> {
  try {
    return await saveChat(bucket(), caseId, loaded, { ...loaded.doc, session })
  } catch (e) {
    if (!(e instanceof ChatConflictError)) throw e
    const known = new Set([...(loaded.doc.session?.generated ?? [])])
    await deleteAnthropicFiles(session.generated.filter((id) => !known.has(id)))
    return null
  }
}

/** 印を下ろす（書けなければ、印はもう別の指示のもの。会話はその指示が書く） */
async function endTurn(caseId: string, loaded: Loaded, doc: ChatDoc) {
  try {
    await saveChat(bucket(), caseId, loaded, doc)
  } catch (e) {
    if (!(e instanceof ChatConflictError)) throw e
  }
}

/** Files API のファイルを消す（もう無いものは消えたとみなす）。消すものが無ければ APIキーが無くてもよい */
async function deleteAnthropicFiles(ids: readonly string[]) {
  if (!ids.length) return
  if (!env.ANTHROPIC_API_KEY) throw new Error("APIキー未設定のため、AI に渡したファイルを消せません")
  const client = anthropic()
  for (const id of ids) {
    try {
      await client.files.delete(id)
    } catch (e) {
      if (!(e instanceof Anthropic.NotFoundError)) throw e
    }
  }
}

/**
 * 会話を終える: Files API に上げたファイルとコード実行が作ったファイルを消し、AI に送る履歴を捨てる（画面の会話は残す）。
 * ファイルを消すと前の履歴は送れなくなる（履歴がファイルを指している）ので、次の指示から新しい会話になる。何度実行しても同じ結果
 */
export async function endChat(caseId: string): Promise<{ id: string; text: string } | null> {
  const ended: ChatMessage = { id: generateId(), role: "system", parts: [{ type: "text", text: ENDED_TEXT }] }
  return (await endSession(bucket(), caseId, deleteAnthropicFiles, ended)) ? { id: ended.id, text: ENDED_TEXT } : null
}

/**
 * 返ってきた編集用の Excel の変更案を置く（画面が差分を作る。lib/excel/edit-sheet.ts）。中身は表の変更（セル・載せる・足す）だけで、
 * 元の Excel は案件のファイル。同じ id の変更案は上書きしない。削除と重なったら置いたものを消して断る（削除のあとに R2 に残さない）
 */
export async function recordExcelProposal(caseId: string, record: ProposalRecord) {
  const p = record.proposal
  const fresh = p.state === "open" && p.count === record.changes.length && !p.applied.length && !p.rejected.length && p.question === null
  if (p.origin.kind !== "excel" || !fresh || record.changes.some((c) => c.kind !== "cell" && c.kind !== "include" && c.kind !== "add"))
    throw new Error("Excel の変更案の形が正しくありません")
  const db = getDb()
  const kase = await store.getCase(db, caseId)
  if (!kase || kase.deleting) throw new Error("案件が見つかりません")
  const file = await store.getFileRow(db, p.origin.fileId)
  if (file?.caseId !== caseId) throw new Error("変更案の元の Excel が案件にありません")
  const key = proposalKey(caseId, p.id)
  if (await env.FILES.head(key)) throw new Error("同じ変更案がもうあります")
  await putProposal(caseId, record)
  const after = await store.getCase(db, caseId)
  if (!after || after.deleting) {
    await env.FILES.delete(key)
    throw new Error("案件が見つかりません")
  }
}

async function putProposal(caseId: string, record: ProposalRecord) {
  await env.FILES.put(proposalKey(caseId, record.proposal.id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } })
}

/** 工事場所の一括調査が出した変更案を置く・消す（server/location-workflow.ts） */
export const putProposalRecord = putProposal
export const deleteProposalRecord = (caseId: string, proposalId: string) => env.FILES.delete(proposalKey(caseId, proposalId))

/** 変更案の記録（R2）を1つ読む。読めないものは無いのと同じに扱う（その変更案は出さない。ページ全体は開ける） */
export async function readProposal(caseId: string, proposalId: string): Promise<ProposalRecord | undefined> {
  const object = await env.FILES.get(proposalKey(caseId, proposalId))
  if (!object) return undefined
  const parsed = proposalRecordSchema.safeParse(tryParseJson(await object.text()))
  return parsed.success ? parsed.data : undefined
}

/**
 * 案件の画面に渡す変更案の記録: 案件の作業で開いているものと、作業にまだ無いもの（返事を受け取り損ねたもの）だけを読む。
 * 作業で決め終わった変更案の記録はもう要らないので消す（読むたびに溜まらない。消し損ねても次に開いたときにまた消す）
 */
export async function readOpenProposals(caseId: string, closed: ReadonlySet<string>): Promise<ProposalRecord[]> {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.FILES.list({ prefix: proposalPrefix(caseId), cursor })
    ids.push(...page.objects.map((o) => o.key.slice(proposalPrefix(caseId).length).replace(/\.json$/, "")))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  const done = ids.filter((id) => closed.has(id))
  if (done.length) await env.FILES.delete(done.map((id) => proposalKey(caseId, id)))
  const read = await Promise.all(ids.filter((id) => !closed.has(id)).map((id) => readProposal(caseId, id)))
  return read.filter((r) => r !== undefined)
}

/** 画面に出す会話（GET /api/cases/<caseId>/chat。チャット欄を開いたときに読む。画面は validateUIMessages で形を確かめる） */
export const chatHistory = (request: Request, caseId: string) =>
  signedIn(request, async () => {
    const { ui, session } = (await loadChat(bucket(), caseId)).doc
    // carryover はこの会話で去年のコードを添えたか（会話の記録の印。画面は「去年のやり方で直す」を出すかをこれで決める）
    const history: ChatHistory = { messages: ui, carryover: session?.carryover === true }
    return Response.json(history, { headers: { "cache-control": "private, no-store" } })
  })


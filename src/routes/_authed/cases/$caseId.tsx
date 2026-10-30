import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router"
import { Download, FileText, FileUp, Loader2, MessageSquare, Sparkles, TriangleAlert, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { AppShell, PageHeader } from "@/components/app-shell"
import { DeleteButton } from "@/components/cases/delete-dialog"
import { useCaseAutosave, type SaveStatus } from "@/components/cases/use-case-autosave"
import { InquiryPanel } from "@/components/convert/inquiry-panel"
import { PlanTable } from "@/components/convert/plan-table"
import { PreviewTable, StatusLegend } from "@/components/convert/preview-table"
import { ReplacePanel } from "@/components/convert/replace-panel"
import { GyoshuSummaryTable, RoundingNote } from "@/components/convert/summary-panel"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { fetchCaseFile, uploadCaseFile } from "@/lib/cases/files-client"
import { fromSaved, newWork, type CaseWork, type SavedPlan } from "@/lib/cases/state"
import { baseRows, editRows, orderAndFinalize, selectRows } from "@/lib/cases/view"
import { caseContext, NO_SOURCE_CONTEXT } from "@/lib/chat/context"
import { carryoverReady } from "@/lib/chat/carryover"
import { addedCountAfter, answer, applyChanges, decide, decisionOf, discard, isAnswered, newProposal, withRecorded, type Proposal, type ProposalRecord } from "@/lib/chat/proposals"
import { MAX_ADDED_ROWS } from "@/lib/cases/added"
import { editSheet, readEditSheet } from "@/lib/excel/edit-sheet"
import { EditExcelPanel } from "@/components/convert/edit-excel-panel"
import { LocationPanel, useLocationSearch } from "@/components/convert/location-panel"
import { approveLocationsFn } from "@/server/location-fns"
import { toWire } from "@/lib/chat/wire"
import { CASE_STATUSES, CASE_STATUS_LABELS, contentTypeOf, FILE_KIND_LABELS, fileUrl, isSheetFile, onlyNonSheetSources, type CaseFile, type CaseStatus, type FileKind } from "@/lib/cases/types"
import { convertRows, countByStatus, editKey, editSession, resolveRows, staffEdit, type CellEdit, type RowResult } from "@/lib/convert/convert"
import { csvFileName, datedFileName, toCsvBytes } from "@/lib/convert/csv"
import { personLetters } from "@/lib/convert/persons"
import { heuristicPlan, primarySheet } from "@/lib/convert/heuristic-plan"
import { SELECTION_LABELS, SELECTION_MODES, summarizeKoji, TAX_LABELS, type Inclusion, type TaxMode } from "@/lib/convert/koji-selection"
import { addressInputs, fillAiCache, type AiCache, type AiCaller } from "@/lib/convert/pipeline"
import { ADDRESS_API_PATH, addressCache, addressKey, lookupAddresses, NO_ADDRESSES, type AddressBook, type AddressLookup } from "@/lib/convert/address"
import { acceptAiPlan, reviewPlanTransforms, type MappingPlan, type SheetGrid } from "@/lib/convert/plan"
import { planExcerpt, previousPlanContext } from "@/lib/convert/prompt"
import { collectSourceRows, sameHeader, sourceKey } from "@/lib/convert/sources"
import { compareFormats, describeFormatDiff } from "@/lib/convert/format-diff"
import { parseInputNumber } from "@/lib/convert/text"
import type { Rounding } from "@/lib/convert/transforms"
import { Cost, useUsdJpy } from "@/components/cost"
import { CASE_COST_NOTICE_USD } from "@/lib/cost"
import type { UsdJpy } from "@/lib/fx"
import { errorMessage } from "@/lib/errors"
import { saveFile } from "@/lib/save-file"
import { collectInquiries, mergeAnswers, readAnswers } from "@/lib/inquiry/inquiry"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS, type KojiFieldId } from "@/lib/spec/koji-keireki"
import { planWithAi, runAiBatch } from "@/server/ai"
import { getCasePageFn, updateCaseStatusFn } from "@/server/cases"
import { approveRuleFn, recordExcelProposalFn } from "@/server/chat-fns"
import { createClientOnlyFn } from "@tanstack/react-start"

export const Route = createFileRoute("/_authed/cases/$caseId")({
  loader: async ({ params }) => {
    const page = await getCasePageFn({ data: { id: params.caseId } })
    if (!page) throw notFound()
    return page
  },
  component: CasePage,
})

/** 編集用の Excel を書く ExcelJS は、落とすときにブラウザで読み込む */
const loadEditXlsx = createClientOnlyFn(() => import("@/lib/excel/edit-xlsx"))

/** チャット（Markdown の描画・AI SDK）は開いたときに読み込む */
const ChatPanel = lazy(() => import("@/components/chat/chat-panel").then((m) => ({ default: m.ChatPanel })))

const SPEC = KOJI_KEIREKI
const NO_LETTERS = personLetters([])
const NO_INCLUSION: ReadonlyMap<string, Inclusion> = new Map()
const NO_ROWS: RowResult<KojiFieldId>[] = []
type Plan = MappingPlan<KojiFieldId>
type Source = { fileId: string; name: string; sheets: SheetGrid[] }

/** 列の計画の前に、去年の Excel を読み終えるのを待つ長さ */
const PREVIOUS_WAIT_MS = 3_000

type PreviousCase = NonNullable<NonNullable<Awaited<ReturnType<typeof getCasePageFn>>>["previous"]>

/** 去年と今年の Excel を比べるシート: その名前のシート（計画のシート）があればそれ、無ければ見出しから選んだシート */
const previousComparisonSheet = (sheets: readonly SheetGrid[], name: string | undefined) => sheets.find((s) => s.name === name) ?? primarySheet(SPEC, KOJI_PLAN_HINTS, sheets)

/** 去年の比べるシートと見出しの行（去年の計画のもの。計画が無い・シートが無ければ見出しから推定する）。比べるシートが無ければ null */
function previousSideOf(previous: PreviousCase, sheets: SheetGrid[]) {
  const prevGrid = previousComparisonSheet(sheets, previous.sheet ?? undefined)
  if (!prevGrid) return null
  const headerRow = prevGrid.name === previous.sheet && previous.headerRow !== null ? previous.headerRow : heuristicPlan(SPEC, KOJI_PLAN_HINTS, prevGrid).headerRow
  return { sheets, sheet: prevGrid.name, headerRow }
}

/**
 * 計画をやり直すとき（元のファイルの変更）: 行の作業と AI の結果は捨て、ファイル全体の設定は残す。開いている変更案は閉じる。
 * 計画は考え終わるまで null（この形をすぐ保存するので、考えている途中で閉じても、開き直すと新しい元で考え直す）
 */
const replanWork = (w: CaseWork, sourceFileId: string): CaseWork => ({
  ...newWork(sourceFileId),
  tax: w.tax,
  basis: w.basis,
  selection: w.selection,
  rounding: w.rounding,
  sorted: w.sorted,
  threshold: w.threshold,
  // 変更案は前の元の行を指すので閉じる（消さずに残す。消すと、サーバーの記録から開き直したときにまた足される）
  proposals: w.proposals.map(discard),
})

/**
 * 保存済みの計画を今の変換の決まりで確かめる（AI の計画の取り込みと同じ）。使えなくなった変換（個人名を匿名化しない変換など）は替え、
 * 変換し直してもらう（替えた変換の AI の結果はまだ無い）
 */
function reviewSavedPlan(w: CaseWork): CaseWork {
  if (!w.plan) return w
  const { plan, changed } = reviewPlanTransforms(SPEC, w.plan.plan)
  if (!changed.length) return w
  const notice = `保存した計画の ${changed.join("・")} の変換を、個人名を匿名化する変換に替えました。もう一度「変換する」を押してください。`
  return { ...w, plan: { ...w.plan, plan, notice: [w.plan.notice, notice].filter(Boolean).join(" ") }, converted: false }
}

/** 変換の結果（手直し・置換の前）。元のファイル・計画・端数・AI の結果・引いた住所から作る（AI は呼ばない） */
function convertedRows(sheets: SheetGrid[], w: CaseWork, addresses: AddressBook) {
  if (!w.converted || !w.plan) return null
  const { plan } = w.plan
  return resolveRows(convertRows(SPEC, collectSourceRows(sheets, plan).rows, plan, { rounding: w.rounding, addresses }), w.aiCache)
}

/** 同梱の住所データを読んで住所を引く（lib/convert/address.ts） */
const lookupAddressesHere: AddressLookup = (raws) => lookupAddresses(raws, new URL(ADDRESS_API_PATH, window.location.origin).href)

/** サーバー関数で AI を呼ぶ（費用は案件の合計に足し、onCost にも渡す）。失敗の理由は failures に集める */
function serverAi(caseId: string, failures: Set<string>, onCost: (usd: number) => void): AiCaller {
  return async (req) => {
    try {
      const res = await runAiBatch({ data: { caseId, ...req } })
      onCost(res.usd)
      if (!res.ok) failures.add(res.message)
      return res.ok ? { ok: true, json: res.json } : res
    } catch (e) {
      const message = errorMessage(e, "AI の呼び出しに失敗しました")
      failures.add(message)
      return { ok: false, message }
    }
  }
}

function CasePage() {
  const page = Route.useLoaderData()
  return <CaseWorkspace key={page.kase.id} {...page} />
}

function CaseWorkspace({ kase, customer, files: initialFiles, state, chatEnabled, proposals: recordedProposals, previous }: NonNullable<Awaited<ReturnType<typeof getCasePageFn>>>) {
  const router = useRouter()
  const [files, setFiles] = useState(initialFiles)
  const [status, setStatus] = useState(kase.status)
  /** 案件の費用の合計（変換・チャットの AI の分。サーバーの合計に足したものを画面でも足す） */
  const [costUsd, setCostUsd] = useState(kase.costUsd)
  const addCost = (usd: number) => setCostUsd((c) => c + usd)
  // サーバーが記録した変更案のうち、作業にまだ無いもの（返事を受け取り損ねたもの）も作業に入れる
  const [work, setWork] = useState(() => {
    const w = state ? fromSaved(state.work, state.aiCache) : newWork()
    return { ...reviewSavedPlan(w), proposals: withRecorded(w.proposals, recordedProposals) }
  })
  const { edits, replacements, manual, dismissed, answers, tax, basis, selection: selectionMode, rounding, sorted, threshold: thresholdInput, aiNotice } = work
  const update = <K extends keyof CaseWork>(key: K, next: (prev: CaseWork[K]) => CaseWork[K]) => setWork((w) => ({ ...w, [key]: next(w[key]) }))
  /** 値をその場で読んでから入れる（イベントの値を updater の中で読まない） */
  const set = <K extends keyof CaseWork>(key: K, value: CaseWork[K]) => update(key, () => value)
  const [source, setSource] = useState<Source | null>(null)
  const [loadingSource, setLoadingSource] = useState(false)
  /** AI が列の対応を考えている間に見せる、見出しからの推定（保存しない） */
  const [planDraft, setPlanDraft] = useState<SavedPlan | null>(null)
  const planning = planDraft !== null
  const [converting, setConverting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingSource, setPendingSource] = useState<CaseFile | null>(null)
  /** 案件の元（ファイルとシートの計画）の世代。待っている間に元が変わった計画・回答の結果は捨てる */
  const caseGeneration = useRef(0)
  /** 変換の世代。元・計画が変わったら上げ、待っている間の古い変換の結果を捨てる */
  const conversionGeneration = useRef(0)
  function supersedeConversion() {
    setConverting(false)
    return ++conversionGeneration.current
  }

  /** 最新の作業（待っている間に変わったかを確かめる） */
  const workRef = useRef(work)
  workRef.current = work

  const saveStatus = useCaseAutosave(kase.id, { version: state?.version ?? 0, saved: state ? work : null }, work)

  const shownPlan = work.plan ?? planDraft
  const plan = shownPlan?.plan ?? null
  const grid = source && plan ? (source.sheets.find((s) => s.name === plan.sheets[0]) ?? null) : null

  /** 去年の案件の元の Excel（形を比べる・列の計画の参考。読めなければ理由） */
  const [previousSheets, setPreviousSheets] = useState<SheetGrid[] | { error: string } | null>(null)
  const previousLoad = useRef<Promise<SheetGrid[] | null> | null>(null)
  /** 去年の Excel を1回だけ読む（読めなければ null。理由は previousSheets に） */
  function loadPreviousSheets(): Promise<SheetGrid[] | null> {
    const file = previous?.source
    if (!file) return Promise.resolve(null)
    // 読めた結果だけを持つ（失敗は持たず、次に要るときに読み直す）
    previousLoad.current ??= (async () => {
      try {
        const { readWorkbook } = await import("@/lib/convert/workbook")
        const sheets = readWorkbook(file.name, await fetchCaseFile(file.id))
        setPreviousSheets(sheets)
        return sheets
      } catch (e) {
        previousLoad.current = null
        setPreviousSheets({ error: errorMessage(e, "去年の Excel を読めませんでした") })
        return null
      }
    })()
    return previousLoad.current
  }

  /**
   * 列の計画の AI に渡す去年の文脈: 去年の列の対応と、去年の Excel との違い。計画の前なので、今年のどのシートと比べるかは
   * 職員が指定したシート → 去年と同じ名前のシート → 見出しから選んだシート（previousComparisonSheet）、見出しの行は見出しからの推定。
   * 比べたシートは違いの文に出る。去年の計画が無い・去年の Excel を読めなければ無し
   */
  async function previousPlanFor(src: Source, requiredSheet: string | undefined) {
    const prevPlan = previous?.plan
    if (!previous || !prevPlan) return undefined
    // 去年の Excel は開いたときから読んでいる。計画をそれ以上待たせない（読み終わらなければ去年の文脈なしで計画する）
    const sheets = await Promise.race([loadPreviousSheets(), new Promise<null>((resolve) => setTimeout(() => resolve(null), PREVIOUS_WAIT_MS))])
    const side = sheets && previousSideOf(previous, sheets)
    const prevGrid = side && sheets.find((s) => s.name === prevPlan.sheets[0])
    const g = previousComparisonSheet(src.sheets, requiredSheet ?? prevPlan.sheets[0]!)
    if (!side || !prevGrid || !g) return undefined
    const diff = describeFormatDiff(compareFormats(side, { sheets: src.sheets, sheet: g.name, headerRow: heuristicPlan(SPEC, KOJI_PLAN_HINTS, g).headerRow }))
    return previousPlanContext(SPEC, { fiscalYear: previous.fiscalYear, grid: prevGrid, plan: prevPlan, diff })
  }

  /**
   * 列の計画を立てる。どのシートを使うか・見出しの行・列の対応は計画の AI が決める（requiredSheet は職員が指定した計画の元のシート）。
   * AI を待つ間と AI が使えないときは、見出しから選んだシートの推定を使う
   */
  async function startPlanning(src: Source, requiredSheet?: string) {
    const fallbackFor = (g: SheetGrid) => heuristicPlan(SPEC, KOJI_PLAN_HINTS, g)
    const g = requiredSheet !== undefined ? src.sheets.find((s) => s.name === requiredSheet) : primarySheet(SPEC, KOJI_PLAN_HINTS, src.sheets)
    if (!g) throw new Error("シートが空です")
    const fallback = fallbackFor(g)
    const id = ++caseGeneration.current
    supersedeConversion()
    setPlanDraft({ plan: fallback, source: "rule" })
    setWork((w) => replanWork(w, src.fileId))
    let next: SavedPlan
    try {
      const previousContext = await previousPlanFor(src, requiredSheet)
      if (id !== caseGeneration.current) return
      const res = await planWithAi({ data: { caseId: kase.id, ...planExcerpt(src.sheets, requiredSheet), ...(previousContext ? { previous: previousContext } : {}) } })
      addCost(res.usd)
      if (res.ok) {
        const accepted = acceptAiPlan(SPEC, src.sheets, res.json, fallbackFor, requiredSheet)
        next = accepted.ok ? { plan: accepted.plan, source: "ai" } : { plan: fallback, source: "rule", notice: `${accepted.message}。見出しから列を推定しました。` }
      } else {
        next = {
          plan: fallback,
          source: "rule",
          notice: res.reason === "noKey" ? "APIキー未設定（ANTHROPIC_API_KEY）のため AI は使えません。見出しから列を推定しました。" : `${res.message}。見出しから列を推定しました。`,
        }
      }
    } catch (e) {
      next = { plan: fallback, source: "rule", notice: `${errorMessage(e, "AI の計画に失敗しました")}。見出しから列を推定しました。` }
    }
    if (id !== caseGeneration.current) return
    set("plan", next)
    setPlanDraft(null)
  }

  /** 変換の元のファイルを読む。計画がまだ無ければ（初めて選んだ・計画の途中で閉じた）計画を立てる */
  async function openSource(file: CaseFile, replan: boolean) {
    setLoadingSource(true)
    try {
      const { readWorkbook } = await import("@/lib/convert/workbook")
      const sheets = readWorkbook(file.name, await fetchCaseFile(file.id))
      if (!primarySheet(SPEC, KOJI_PLAN_HINTS, sheets)) throw new Error("シートが空です")
      const src = { fileId: file.id, name: file.name, sheets }
      setSource(src)
      if (replan) await startPlanning(src)
    } catch (e) {
      toast.error(errorMessage(e, "ファイルを読み込めませんでした"))
    } finally {
      setLoadingSource(false)
    }
  }

  useEffect(() => {
    const file = initialFiles.find((f) => f.id === work.sourceFileId)
    if (file) void openSource(file, !work.plan)
  }, [])

  async function keepFile(kind: FileKind, blob: Blob, name: string) {
    try {
      const saved = await uploadCaseFile(kase.id, kind, blob, name)
      setFiles((fs) => [...fs, saved])
      return saved
    } catch (e) {
      toast.error(errorMessage(e, `${name} を案件に保存できませんでした`))
      return undefined
    }
  }

  /** 届いたファイルを付ける。変換の元がまだ無ければ、最初の表のファイルを変換の元にする */
  async function attach(list: FileList) {
    let hasSource = !!work.sourceFileId
    for (const f of [...list]) {
      const saved = await keepFile("source", f, f.name)
      if (saved && !hasSource && isSheetFile(saved.name)) {
        hasSource = true
        // PDF から足した行があれば、変換の元にすると消えるので確かめる
        if (work.added.length) setPendingSource(saved)
        else await openSource(saved, true)
      }
    }
  }

  function chooseSource(f: CaseFile) {
    if (work.converted || work.edits.size || work.added.length) setPendingSource(f)
    else void openSource(f, true)
  }

  /** 状態の変更の世代。失敗したら、その後に変えていなければ元に戻す */
  const statusChange = useRef(0)
  async function changeStatus(next: CaseStatus) {
    const previous = status
    const id = ++statusChange.current
    setStatus(next)
    try {
      await updateCaseStatusFn({ data: { id: kase.id, status: next } })
    } catch (e) {
      if (id === statusChange.current) setStatus(previous)
      toast.error(errorMessage(e, "状態を変えられませんでした"))
    }
  }

  function changePlan(p: Plan) {
    supersedeConversion()
    setWork((w) => ({ ...w, plan: w.plan && { ...w.plan, plan: p }, converted: false }))
  }

  const sources = useMemo(() => (source && plan ? collectSourceRows(source.sheets, plan) : null), [source, plan])

  /** 去年の比べるシートと見出しの行。去年の Excel を読んだときに1回だけ決める */
  const previousSide = useMemo(() => (previous && Array.isArray(previousSheets) ? previousSideOf(previous, previousSheets) : null), [previousSheets])
  // 去年の Excel は開いたときから読み始める（計画の AI に添えるのと、去年との違いに使う）
  useEffect(() => {
    void loadPreviousSheets()
  }, [])
  /** 去年と今年の元の Excel の見出し（「去年のやり方で直す」で、去年のコードの文字列のうち見出しの名前は伏せない） */
  const carryoverHeaders = () => {
    const prevHeader = previousSide?.sheets.find((s) => s.name === previousSide.sheet)?.rows[previousSide.headerRow] ?? []
    const curHeader = grid && plan ? (grid.rows[plan.headerRow] ?? []) : []
    return [...new Set([...prevHeader, ...curHeader].map((h) => h.trim()).filter(Boolean))]
  }
  /** 去年の元の Excel の配置技術者の列の値（「去年のやり方で直す」で去年のコードから個人名を消す。去年の計画のシートと列があるときだけ） */
  const previousEngineerNames = () => {
    if (!previous || !previousSide || previousSide.sheet !== previous.sheet || previous.headerRow === null) return []
    const rows = previousSide.sheets.find((s) => s.name === previousSide.sheet)?.rows.slice(previous.headerRow + 1) ?? []
    return [...new Set(rows.flatMap((r) => previous.engineerColumns.map((c) => (r[c] ?? "").trim()).filter(Boolean)))].slice(0, 20_000)
  }
  /** 去年の元の Excel と今年の元の Excel の形の違い（lib/convert/format-diff.ts）。画面とチャットの文脈に出す。今年のシートか見出しの行が変わったときだけ比べ直す */
  const currentSheet = grid?.name ?? null
  const currentHeaderRow = plan?.headerRow ?? null
  const formatDiff = useMemo(() => {
    if (!previousSide || !source || currentSheet === null || currentHeaderRow === null) return null
    const diff = compareFormats(previousSide, { sheets: source.sheets, sheet: currentSheet, headerRow: currentHeaderRow })
    return { diff, lines: describeFormatDiff(diff) }
  }, [previousSide, source, currentSheet, currentHeaderRow])

  /**
   * 計画が住所として読む列の値を引いた結果（変換の前に引く）。引いた住所は持ち続け、住所の列の値が変わったときだけ新しい値を引く
   * （住所と関係ない計画の変更では引き直さない）。今の住所をすべて引き終わるまで表は作らない
   */
  const addressStore = useRef<ReturnType<typeof addressCache> | null>(null)
  addressStore.current ??= addressCache(lookupAddressesHere)
  const addressValues = useMemo(() => (sources && plan ? addressInputs(SPEC, sources.rows, plan) : null), [sources, plan])
  const addressSig = useMemo(() => (addressValues ? [...new Set(addressValues.map(addressKey))].sort().join("\n") : null), [addressValues])
  const [addressBook, setAddressBook] = useState<AddressBook>(NO_ADDRESSES)
  async function ensureAddresses(values: readonly string[]) {
    try {
      return await addressStore.current!.ensure(values)
    } catch (e) {
      // 住所データを読めなければ、その住所の分割は AI に回す（知らせる）
      toast.error(`${errorMessage(e, "住所データを読めませんでした")}。住所の分割は AI に回します`)
      return addressStore.current!.covering(values)!
    } finally {
      setAddressBook(addressStore.current!.covering([])!)
    }
  }
  useEffect(() => {
    if (addressValues) void ensureAddresses(addressValues)
    // 住所の値の集まり（addressSig）が変わったときだけ引く
  }, [addressSig])
  const addresses = useMemo(() => (addressValues ? (addressStore.current!.covering(addressValues) ?? null) : null), [addressSig, addressBook])
  /** 変換の決まり（端数・引いた住所）。住所を引き終わるまで null */
  const ctx = useMemo(() => (addresses ? { rounding, addresses } : null), [addresses, rounding])

  async function convert() {
    if (!sources || !plan || !addressValues) return
    const generation = supersedeConversion()
    setConverting(true)
    const failures = new Set<string>()
    const cache: AiCache = new Map(work.aiCache)
    try {
      // 住所をまだ引き終わっていなければ待つ（黙って何もしないことはしない）
      const book = await ensureAddresses(addressValues)
      if (generation !== conversionGeneration.current) return
      await fillAiCache(convertRows(SPEC, sources.rows, plan, { rounding, addresses: book }), cache, serverAi(kase.id, failures, addCost))
      if (generation !== conversionGeneration.current) return
      setWork((w) => ({ ...w, aiCache: cache, converted: true, aiNotice: failures.size ? [...failures].join(" / ") : null }))
    } finally {
      if (generation === conversionGeneration.current) setConverting(false)
    }
  }

  function edit(rowKey: string, field: KojiFieldId, e: CellEdit) {
    update("edits", (prev) => new Map(prev).set(editKey(rowKey, field), e))
  }

  function replace(field: KojiFieldId, from: string, text: string) {
    const to = text.trim() ? staffEdit(text, letters) : undefined
    update("replacements", (prev) => {
      const { [from]: _, ...rest } = prev[field] ?? {}
      return { ...prev, [field]: to ? { ...rest, [from]: to } : rest }
    })
  }

  const drafts = useMemo(() => (sources && plan && ctx ? convertRows(SPEC, sources.rows, plan, ctx) : []), [sources, plan, ctx])
  /**
   * 変換した行（手直し・置換の前）。変換の元の表が無い案件（PDF だけ）は空の表にして、足した行（work.added）だけで表を作る
   */
  const rows = useMemo(() => {
    if (!work.sourceFileId) return NO_ROWS
    return work.converted && sources && ctx ? resolveRows(drafts, work.aiCache) : null
  }, [work.sourceFileId, work.converted, sources, ctx, drafts, work.aiCache])
  const added = work.added
  /** 表を見せるか（変換した、または足した行がある） */
  const hasTable = work.converted || added.length > 0
  const samples = useMemo(() => drafts.filter((d) => !d.excluded).slice(0, 2), [drafts])
  /** ○ の列で業種を決める計画のとき、どの列にも記号が無く出力しない元の行の数 */
  // 住所を引いている間（drafts がまだ無い）は数えない（全行を「記号が無い」と出さない）
  const unmarked = useMemo(() => (sources && ctx ? sources.rows.length - new Set(drafts.map((d) => sourceKey(d))).size : 0), [sources, ctx, drafts])

  const roundingTotals = useMemo(() => {
    if (!sources || !plan || !addresses) return null
    const total = (r: Rounding) =>
      convertRows(SPEC, sources.rows, plan, { rounding: r, addresses }).reduce((s, d) => {
        const c = d.cells.amount
        return s + (!d.excluded && c.kind === "done" && /^\d+$/.test(c.cell.value) ? Number(c.cell.value) : 0)
      }, 0)
    return { floor: total("floor"), round: total("round") }
  }, [sources, plan, addresses])

  const threshold = thresholdInput.on ? parseInputNumber(thresholdInput.yen) : undefined
  /** 画面と CSV の表。個人名の記号（letters）は CSV に書く行からこの順に付け、手直し・置換先の「〔Ａ〕」をその人に戻すのにも使う */
  const edited = useMemo(() => (rows ? editRows({ rows, added, edits, replacements }) : null), [rows, added, edits, replacements])
  /** 選び直しは入れ外し・7割の設定が変わったときだけ（並べ替えでは選び直さない） */
  const selected = useMemo(
    () => (edited ? selectRows({ manual, tax, basis, selection: selectionMode, includeAtLeastYen: threshold }, edited) : null),
    [edited, manual, tax, basis, selectionMode, threshold],
  )
  const view = useMemo(
    () => (rows && edited && selected ? orderAndFinalize({ rows, added, replacements, sorted }, edited, selected) : null),
    [rows, added, edited, selected, replacements, sorted],
  )
  const shown = view?.shown ?? null
  const inclusion = view?.inclusion ?? NO_INCLUSION
  const letters = view?.letters ?? NO_LETTERS
  const output = view?.output ?? null
  const openProposals = work.proposals.filter((p) => p.state === "open" && p.origin.kind === "chat").length
  const excelProposals = work.proposals.filter((p) => p.state === "open" && p.origin.kind === "excel")
  const locationProposals = work.proposals.filter((p) => p.state === "open" && p.origin.kind === "location")
  const counts = useMemo(() => (output ? countByStatus(output) : null), [output])
  const inquiries = useMemo(() => (output ? collectInquiries(output, { tax }) : []), [output, tax])
  const summary = useMemo(() => (edited && selected ? summarizeKoji(edited, selected, { tax, basis }) : []), [edited, selected, tax, basis])

  const fx = useUsdJpy()
  /**
   * チャット欄。一度開いたら閉じても消さずに隠すだけにする（消すと進めていた指示が止まり、会話の状態も消える）。
   * 会話はチャット欄が初めて開いたときに読む
   */
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMounted, setChatMounted] = useState(false)
  const openChat = () => {
    setChatMounted(true)
    setChatOpen(true)
  }
  /** 開いている変更案の中身（サーバーが R2 から読んだもの。指示の返事で届いたものを足す。保存はサーバーが済ませている） */
  const [proposalChanges, setProposalChanges] = useState(() => new Map(recordedProposals.map((r) => [r.proposal.id, r.changes])))
  /** ルールの追記を保存している間（変更案の承認を止める） */
  const [savingRule, setSavingRule] = useState(false)

  /** サーバーが置いた変更案の記録を足す（もう作業にあれば足さない。決め終わったものを開き直さない） */
  function addRecorded(r: ProposalRecord) {
    if (workRef.current.proposals.some((p) => p.id === r.proposal.id)) return
    setProposalChanges((m) => new Map(m).set(r.proposal.id, r.changes))
    update("proposals", (ps) => (ps.some((p) => p.id === r.proposal.id) ? ps : [...ps, r.proposal]))
  }
  // 未決の工事場所の項目がある変更案（一括調査のものも、チャットの「この現場ってどこ？」のものも）を決めるまで、次の一括調査を始めさせない
  const undecidedLocation = work.proposals.some((p) => p.state === "open" && (proposalChanges.get(p.id) ?? []).some((c, i) => c.kind === "location" && decisionOf(p, i) === "pending"))
  const locationSearch = useLocationSearch({ caseId: kase.id, view, table: tableWire, undecided: undecidedLocation, onRecord: addRecorded, onCaseCost: setCostUsd })

  /** 変換の元の表が無く（PDF だけ）、AI に一から表を作らせる案件か */
  const noSheetSource = !work.sourceFileId && onlyNonSheetSources(files)
  /** チャットに送れるか（変換した、または変換の元の表が無い） */
  const chatReady = !!rows && (noSheetSource || (work.converted && !!source && !!grid && !!plan))

  /** チャットに送る今の表と文脈。変換する前は送れない */
  /** 今の表（チャットと工事場所の調査に送る。大きいので送るときだけ作る） */
  function tableWire() {
    return rows ? toWire({ rows, added, edits, replacements, manual, tax, basis, selection: selectionMode, includeAtLeastYen: threshold, sorted }) : null
  }

  function chatRequest() {
    if (!rows || !chatReady) return null
    return {
      table: tableWire()!,
      context: source && grid && plan ? caseContext(source.sheets, grid, plan, previous && formatDiff ? { fiscalYear: previous.fiscalYear, lines: formatDiff.lines } : undefined) : NO_SOURCE_CONTEXT,
      sourceFileId: work.sourceFileId,
    }
  }

  const updateProposal = (id: string, next: (p: Proposal) => Proposal) => update("proposals", (ps) => ps.map((p) => (p.id === id ? next(p) : p)))

  /**
   * 変更案を承認・却下する。承認した表の変更は手直し・入れ外し・設定に重ねる。ルールの追記は1件ずつ保存し、保存できたものから承認の印を付ける
   * （途中で失敗しても、保存した追記は承認済みになり、もう一度承認しても二重に足さない）
   */
  async function decideProposal(id: string, indices: number[], decision: "applied" | "rejected") {
    const p = work.proposals.find((x) => x.id === id)
    const changes = proposalChanges.get(id)
    if (!p || p.state !== "open" || !changes) return
    const chosen = indices.filter((i) => decisionOf(p, i) === "pending")
    if (decision === "rejected") return updateProposal(id, (x) => decide(x, chosen, "rejected"))
    if (!isAnswered(p)) return
    // 工事場所は、サーバーが顧客の覚えた結果に書けてから承認する（ルールの追記と同じく、承認と覚えることを食い違わせない）
    const located = chosen.filter((i) => changes[i]!.kind === "location")
    const table = chosen.filter((i) => changes[i]!.kind !== "rule" && changes[i]!.kind !== "location")
    // 足した行の上限を超える承認はしない（超えるとチャットに表を送れなくなる）
    const after = addedCountAfter(work.added, table.map((i) => changes[i]!))
    if (after > MAX_ADDED_ROWS) {
      toast.error(`承認すると足した行が ${after} 行になります。案件に足せる行は ${MAX_ADDED_ROWS} 行までです（承認していません）`)
      return
    }
    const apply = (indices: number[]) => {
      if (!indices.length) return
      const edited = view?.edited ?? []
      setWork((w) => ({
        ...applyChanges(w, edited, indices.map((i) => changes[i]!)),
        proposals: w.proposals.map((x) => (x.id === id ? decide(x, indices, "applied") : x)),
      }))
    }
    apply(table)
    if (located.length) {
      setSavingRule(true)
      try {
        await approveLocationsFn({ data: { caseId: kase.id, proposalId: id, items: located } })
        apply(located)
      } catch (e) {
        toast.error(errorMessage(e, "工事場所を承認できませんでした（顧客の覚えた結果に書けませんでした）"))
      } finally {
        setSavingRule(false)
      }
    }
    const rules = chosen.filter((i) => changes[i]!.kind === "rule")
    if (!rules.length) return
    setSavingRule(true)
    try {
      for (const i of rules) {
        // サーバーが変更案の記録から追記し、足した印も一緒に書く（開き直して同じ項目をもう一度承認しても二度足さない）
        await approveRuleFn({ data: { caseId: kase.id, proposalId: id, item: i } })
        updateProposal(id, (x) => decide(x, [i], "applied"))
      }
      toast.success("ルールに追記しました")
    } catch (e) {
      toast.error(errorMessage(e, "ルールに追記できませんでした（保存できたものは承認済みにしました）"))
    } finally {
      setSavingRule(false)
    }
  }

  /** 編集用の Excel を落とす（今の表のすべての行。lib/excel/edit-sheet.ts） */
  async function downloadEditSheet() {
    if (!view) return
    const { editXlsx } = await loadEditXlsx()
    const name = datedFileName("工事経歴_編集用", customer.name, new Date(), "xlsx")
    saveFile(await editXlsx(editSheet(view)), name, contentTypeOf(name))
  }

  /**
   * 直した Excel を取り込む: 案件のファイルに残し、落としたときの値との差分を変更案にしてサーバーに置く（チャットの変更案と同じく、開き直しても残る）。
   * 差分は取り込み始めたときの表と比べる。待っている間に変換の元が変わったら捨てる
   */
  async function readEditFile(f: File) {
    const against = view
    if (!against) return undefined
    const generation = caseGeneration.current
    const { readWorkbook } = await import("@/lib/convert/workbook")
    const sheets = readWorkbook(f.name, new Uint8Array(await f.arrayBuffer()))
    const failures = new Set<string>()
    const cache: AiCache = new Map(work.aiCache)
    // 件数の上限は readEditSheet が AI を呼ぶ前に確かめる。案件のファイルに残すのは読めたあと
    const result = await readEditSheet(sheets, against, { rounding, cache, callAi: serverAi(kase.id, failures, addCost), lookup: (raws) => ensureAddresses([...raws]) })
    if (generation !== caseGeneration.current) return undefined
    if ("error" in result) return result
    if (failures.size) toast.warning(`AI を使えなかった値があります: ${[...failures].join(" / ")}`)
    setWork((w) => ({ ...w, aiCache: new Map([...cache, ...w.aiCache]) }))
    const saved = await keepFile("edit_sheet", f, f.name)
    if (!saved) return undefined
    if (!result.changes.length) return { report: result.report }
    const proposal = newProposal(crypto.randomUUID(), { kind: "excel", fileId: saved.id }, result.changes, null)
    await recordExcelProposalFn({ data: { caseId: kase.id, record: { proposal, changes: result.changes } } })
    setProposalChanges((m) => new Map(m).set(proposal.id, result.changes))
    update("proposals", (ps) => [...ps, proposal])
    return { report: result.report }
  }

  const proposalActions = { decide: (id: string, indices: number[], d: "applied" | "rejected") => void decideProposal(id, indices, d), answer: (id: string, a: "yes" | "no") => updateProposal(id, (p) => answer(p, a)) }

  function download() {
    if (!output) return
    const bytes = toCsvBytes(SPEC, output)
    const name = csvFileName(SPEC, customer.name, new Date())
    saveFile(bytes, name, "text/csv")
    void keepFile("csv", new Blob([bytes as BlobPart], { type: "text/csv" }), name)
  }

  const chatPanel = chatMounted && (
    <Suspense fallback={chatOpen && <aside className="fixed inset-y-0 right-0 z-40 w-[460px] border-l bg-background" />}>
      <ChatPanel
        caseId={kase.id}
        open={chatOpen}
        ready={chatReady}
        request={chatRequest}
        proposals={work.proposals}
        changes={proposalChanges}
        view={view}
        actions={proposalActions}
        busy={savingRule}
        fx={fx}
        carryover={
          previous && {
            fiscalYear: previous.fiscalYear,
            // 去年の Excel があれば、読み終えて違いを文脈に入れられるまで待つ（読めなかった・無いときは待たない）
            ready: carryoverReady({
              previousSource: !!previous.source,
              currentSource: !!work.sourceFileId,
              previousSheets: previousSheets === null ? "loading" : "error" in previousSheets ? "error" : previousSide ? "loaded" : "noSheet",
              // 今年の元と計画はあるのに比べるシートが無いときは、違いを作れないので待たない
              formatDiff: formatDiff !== null ? true : source && plan && !grid ? "unavailable" : false,
            }),
            names: previousEngineerNames,
            headers: carryoverHeaders,
          }
        }
        onProposal={({ proposal, changes }) => {
          setProposalChanges((m) => new Map(m).set(proposal.id, changes))
          update("proposals", (ps) => [...ps.filter((x) => x.id !== proposal.id), proposal])
        }}
        onCaseCost={setCostUsd}
        location={locationSearch}
        onClose={() => setChatOpen(false)}
      />
    </Suspense>
  )

  return (
    <AppShell aside={chatPanel} asideOpen={chatOpen}>
      <nav className="mb-2 flex gap-1 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">
          顧客
        </Link>
        <span>/</span>
        <Link to="/customers/$customerId" params={{ customerId: customer.id }} className="hover:underline">
          {customer.name}
        </Link>
      </nav>
      <PageHeader
        title={`${customer.name} ${kase.fiscalYear}年度`}
        description="顧客の工事経歴の Excel を、建設業.NET の「CSV形式データインポート → 工事経歴データ」で取り込めるCSVに変換します。作業は自動で保存します。"
        actions={
          <div className="flex items-center gap-3">
            <SaveIndicator status={saveStatus} />
            <CaseCost usd={costUsd} fx={fx} />
            <NativeSelect aria-label="案件の状態" value={status} onChange={(e) => void changeStatus(e.target.value as CaseStatus)} data-testid="case-status">
              {CASE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CASE_STATUS_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
            <DeleteButton
              target={{ caseId: kase.id }}
              title={`${kase.fiscalYear}年度の案件`}
              customerName={customer.name}
              onDeleted={() => router.navigate({ to: "/customers/$customerId", params: { customerId: customer.id } })}
            />
          </div>
        }
      />

      <section className="grid gap-5 rounded-2xl border bg-card p-5 sm:grid-cols-[1.4fr_1fr]">
        <div className="grid content-start gap-3">
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 px-4 py-6 text-center text-sm transition-colors hover:bg-muted/60"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void attach(e.dataTransfer.files)
            }}
          >
            <FileUp className="size-6 text-muted-foreground" />
            <span className="font-medium">届いたファイルを付ける</span>
            <span className="text-xs text-muted-foreground">.xlsx・.xls・.csv・.pdf（複数可・ドラッグ＆ドロップ可）。ファイルは案件に保存します</span>
            <input
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.pdf"
              className="sr-only"
              data-testid="file-input"
              onChange={(e) => {
                if (e.target.files?.length) void attach(e.target.files)
                e.target.value = ""
              }}
            />
          </label>
          <FileList files={files} sourceFileId={work.sourceFileId} loading={loadingSource || planning} onChoose={chooseSource} />
        </div>

        <div className="grid content-start gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rounding">千円未満の端数</Label>
              <NativeSelect id="rounding" value={rounding} onChange={(e) => set("rounding", e.target.value as Rounding)}>
                <option value="floor">切り捨て</option>
                <option value="round">四捨五入</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tax">元データの金額</Label>
              <NativeSelect id="tax" value={tax} onChange={(e) => set("tax", e.target.value as TaxMode)}>
                {Object.entries(TAX_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          {source && grid && plan && source.sheets.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor="sheet">計画の元にするシート</Label>
              <NativeSelect
                id="sheet"
                value={grid.name}
                onChange={(e) => {
                  void startPlanning(source, e.target.value)
                }}
              >
                {source.sheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}（{s.rows.length}行）
                  </option>
                ))}
              </NativeSelect>
              <SheetPicker sheets={source.sheets} primary={grid} plan={plan} onChange={changePlan} />
            </div>
          )}
        </div>
      </section>

      {grid && shownPlan && (
        <section className="mt-8 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">1. 列の対応を確認</h2>
              <p className="mt-0.5 text-sm text-muted-foreground" data-testid="plan-source">
                {planning ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin" /> AI が列の対応を考えています…（見出しからの推定を表示中）
                  </span>
                ) : shownPlan.source === "ai" ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="size-3.5 text-violet-500" /> AI が列の対応を提案しました。違っていれば直してください。
                  </span>
                ) : (
                  "見出しの語から列の対応を推定しました。違っていれば直してください。"
                )}
              </p>
            </div>
            <Button onClick={convert} disabled={converting || planning} data-testid="convert-button">
              {converting ? <Loader2 className="animate-spin" /> : <Wand2 />}
              変換する
            </Button>
          </div>

          {shownPlan.notice && <Notice tone="warning">{shownPlan.notice}</Notice>}
          {previous && (formatDiff || (previousSheets && "error" in previousSheets) || !previous.source) && (
            <Notice tone={formatDiff && !formatDiff.diff.same ? "warning" : "info"} testId="format-diff">
              <div className="font-medium">去年（{previous.fiscalYear}年度）の元の Excel との違い</div>
              {formatDiff ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {formatDiff.lines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1">{previous.source ? (previousSheets as { error: string }).error : "去年の案件に表のファイルが無いので比べられません。"}</p>
              )}
              <p className="mt-1 text-xs">違いはチャットの AI にも伝えます。変換したあと、チャットの「去年のやり方で直す」で顧客ルールと去年のコードを添えて直せます。</p>
            </Notice>
          )}
          {sources && sources.duplicates > 0 && (
            <Notice tone="warning" testId="duplicate-notice">
              選んだシートをまたいで同じ内容の行が {sources.duplicates} 件あったため、1件にまとめました（業種ごとのシートが全件のシートにフィルタをかけたものなら、全件のシートだけを選んでください）。
            </Notice>
          )}
          {unmarked > 0 && (
            <Notice tone="info" testId="unmarked-notice">
              業種の記号（○）がどの列にも無い {unmarked} 行は出力しません。
            </Notice>
          )}
          {plan!.notes.length > 0 && (
            <Notice tone="info">
              <ul className="list-disc space-y-0.5 pl-4">
                {plan!.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Notice>
          )}

          <PlanTable spec={SPEC} grid={grid} plan={plan!} samples={samples} onChange={changePlan} />
          {roundingTotals && <RoundingNote floor={roundingTotals.floor} round={roundingTotals.round} current={rounding} />}
        </section>
      )}

      {noSheetSource && !hasTable && (
        <section className="mt-8 space-y-3" data-testid="no-sheet-source">
          <h2 className="text-lg font-semibold tracking-tight">表になるファイルがありません</h2>
          <p className="text-sm text-muted-foreground">
            届いたファイルが PDF だけのときは、チャットで AI に表を作らせます（例:「PDF から工事経歴の表を作って」）。AI が作った行は変更案として出し、承認するとすべて要確認（黄）で表に入ります。
          </p>
          <Button variant="outline" onClick={openChat} disabled={chatOpen || !chatEnabled} data-testid="chat-open-pdf">
            <MessageSquare /> チャットで表を作る
          </Button>
        </section>
      )}

      {output && counts && hasTable && (
        <section className="mt-10 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">2. プレビューと手直し</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                セルをクリックすると直接直せます（Enter で確定、Esc で取り消し）。左のチェックで CSV に載せる行を入れ外しできます。
                個人名の記号（Ａ・Ｂ…）は直すときに「〔Ａ〕」の形で出ます。その形のまま残すと同じ人として扱います。
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                onClick={openChat}
                disabled={chatOpen || !chatEnabled}
                title={chatEnabled ? undefined : "APIキー未設定（ANTHROPIC_API_KEY）のため、チャットは使えません"}
                data-testid="chat-open"
              >
                <MessageSquare /> チャットで直す
                {openProposals > 0 && <span className="rounded-full bg-violet-600 px-1.5 text-xs text-white">{openProposals}</span>}
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={sorted} onCheckedChange={(v) => set("sorted", v)} aria-label="記載順に並べ替え" />
                業種ごとに元請→下請、金額の大きい順
              </label>
              {output.length === 0 && (
                <span className="text-sm text-muted-foreground" data-testid="no-rows-note">
                  CSV に載せる行がありません。左のチェックで行を選んでください
                </span>
              )}
              <Button
                onClick={() => (counts.error ? setConfirmOpen(true) : download())}
                variant={counts.error ? "outline" : "default"}
                disabled={output.length === 0}
                data-testid="download-button"
              >
                {counts.error ? <TriangleAlert className="text-red-600" /> : <Download />}
                {counts.error ? `CSVをダウンロード（${output.length}件・エラー ${counts.error} 件）` : `CSVをダウンロード（${output.length}件）`}
              </Button>
            </div>
          </div>

          {aiNotice && (
            <Notice tone="warning" testId="ai-notice">
              AI 変換できなかった値があります: {aiNotice}。黄色のセルを確認し、必要なら直接入力してください。
            </Notice>
          )}
          <div className="grid gap-3">
            <h3 className="text-sm font-semibold">業種ごとの件数と7割</h3>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <div className="flex items-center gap-2" role="radiogroup" aria-label="載せる工事の選び方" data-testid="selection-mode">
                載せる工事:
                {SELECTION_MODES.map((m) => (
                  <label key={m} className="flex items-center gap-1">
                    <input type="radio" name="selection-mode" value={m} checked={selectionMode === m} onChange={() => set("selection", m)} data-testid={`selection-${m}`} />
                    {SELECTION_LABELS[m]}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={thresholdInput.on} onChange={(e) => set("threshold", { ...thresholdInput, on: e.target.checked })} data-testid="threshold-on" />
                金額が
                <Input
                  className="h-8 w-36"
                  inputMode="numeric"
                  aria-label="追加で含める金額（円）"
                  value={thresholdInput.yen}
                  onChange={(e) => set("threshold", { ...thresholdInput, yen: e.target.value })}
                  placeholder="例: 3000000"
                />
                円以上の行もすべて含める
              </label>
              {manual.size > 0 && (
                <Button variant="outline" size="sm" onClick={() => set("manual", new Map())}>
                  手動の入れ外し（{manual.size}件）を戻す
                </Button>
              )}
            </div>
            <GyoshuSummaryTable
              summary={summary}
              basis={basis}
              onBasisChange={(code, side, v) => update("basis", (prev) => ({ ...prev, [code]: { ...prev[code], [side]: v } }))}
            />
            <p className="text-xs text-muted-foreground">
              7割ルール: 業種ごとに、元請を金額の大きい順に元請の基準額の7割を超えるまで、続いて残りの元請と下請を合計の基準額の7割を超えるまで載せます。
              基準額は損益計算書の完成工事高のうち当該業種の額（<strong>税抜</strong>）です。空欄なら行の合計を使います。7割の判定と比率は税抜で出します（行の合計も税抜）。
              軽微な工事（税込500万円未満、建築一式は1,500万円未満）は10件まで。
              <span data-testid="selection-note">
                「全件を載せる」は除外した行と手動で外した行のほかをすべて載せます（7割以上なら件数は自由で、軽微の10件は「それより多くは載せなくてよい」上限なので軽微な工事も全部載せます。顧客がすでに7割で絞ったデータもこちら）。比率で7割を超えたかを確かめてください。
              </span>
              元データの金額は「{TAX_LABELS[tax]}」として判定します（金額そのものは変換しません）。
              {tax === "unknown" && <strong data-testid="tax-unknown-note">税込・税抜が不明なので、税込とみなして行の金額を1.1で割り、7割を判定しています。</strong>}
            </p>
          </div>

          {view && (
            <EditExcelPanel
              view={view}
              proposals={excelProposals}
              changes={proposalChanges}
              actions={proposalActions}
              busy={savingRule}
              download={downloadEditSheet}
              upload={readEditFile}
            />
          )}

          {view && (
            <LocationPanel search={locationSearch} view={view} proposals={locationProposals} changes={proposalChanges} actions={proposalActions} busy={savingRule} fx={fx} />
          )}

          <StatusLegend counts={counts} />
          <PreviewTable
            spec={SPEC}
            rows={shown!}
            order={sorted ? "gyoshu" : "source"}
            inclusion={inclusion}
            openEditor={(cell) => editSession(cell, letters)}
            onEdit={edit}
            onToggle={(key, included) => update("manual", (prev) => new Map(prev).set(key, included))}
          />

          <details className="rounded-xl border bg-muted/20 p-3" data-testid="replace-details">
            <summary className="cursor-pointer text-sm font-semibold">値の一括置換（配置技術者の差し替えなど）</summary>
            <div className="mt-3">
              <ReplacePanel spec={SPEC} rows={rows!} letters={letters} replacements={replacements} onChange={replace} />
            </div>
          </details>

          <Notice tone="info">
            建設業.NET の取込は<strong>追加</strong>です（上書きされません）。同じCSVを2回取り込むと工事が重複するので、取り込みは1回だけにしてください。
            CSV には見出し行がないので、取込画面の「1行目が項目行」の<strong>チェックを外して</strong>ください。
          </Notice>
        </section>
      )}

      {output && shown && hasTable && (
        <InquiryPanel
          inquiries={inquiries}
          outputRows={output}
          allRows={shown}
          customer={customer.name}
          dismissed={dismissed}
          answers={answers}
          keepFile={(name, bytes, type) => void keepFile("inquiry_sheet", new Blob([bytes as BlobPart], { type }), name)}
          onToggle={(key, ask) =>
            update("dismissed", (prev) => {
              const next = new Set(prev)
              if (ask) next.delete(key)
              else next.add(key)
              return next
            })
          }
          readAnswerFile={async (f, against) => {
            const generation = caseGeneration.current
            // 照合に使う計画・元のファイル・引いた住所は、取り込み始めたときのものにそろえる（against と同じ時点）
            const planAtStart = work.plan
            const sourceAtStart = source
            const addressesAtStart = addresses
            if (work.converted && !addressesAtStart) return { error: "住所を読み込んでいます。少し待ってから取り込んでください" }
            void keepFile("answer", f, f.name)
            const { readWorkbook } = await import("@/lib/convert/workbook")
            const sheets = readWorkbook(f.name, new Uint8Array(await f.arrayBuffer()))
            const failures = new Set<string>()
            const cache: AiCache = new Map(work.aiCache)
            // 住所は変換と同じ仕組みで引く（住所データを読めなければ、その値は読めない記入として出す。取り込み全体は止めない）
            const report = await readAnswers(sheets, against, { ctx: { rounding }, lookup: (raws) => ensureAddresses([...raws]), cache, callAi: serverAi(kase.id, failures, addCost), fields: plan?.fields ?? {} })
            if (generation !== caseGeneration.current) return undefined
            if ("error" in report) return report
            if (workRef.current.plan !== planAtStart) return { error: "取り込んでいる間に列の対応が変わりました。もう一度取り込んでください" }
            setWork((w) => {
              if (w.plan !== planAtStart) return w
              const converted = sourceAtStart && addressesAtStart ? (convertedRows(sourceAtStart.sheets, w, addressesAtStart) ?? []) : []
              const merged = mergeAnswers(report, against, { rows: baseRows({ rows: converted, added: w.added }), replacements: w.replacements, edits: w.edits })
              return { ...w, aiCache: new Map([...cache, ...w.aiCache]), edits: merged.edits, answers: merged.report }
            })
            return { aiFailures: [...failures] }
          }}
        />
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>エラーが {counts?.error ?? 0} 件あります</AlertDialogTitle>
            <AlertDialogDescription>
              赤いセルのままだと、建設業.NET の取込でエラーになるか、誤った内容で取り込まれます。このままダウンロードしますか？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>戻って直す</AlertDialogCancel>
            <AlertDialogAction onClick={download}>このままダウンロード</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingSource} onOpenChange={(open) => !open && setPendingSource(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>変換の元を「{pendingSource?.name}」にしますか</AlertDialogTitle>
            <AlertDialogDescription>今の変換の結果・足した行・手直し・行の入れ外し・取り込んだ回答は消えます（端数・税込税抜・基準額の設定は残します）。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingSource) void openSource(pendingSource, true)
                setPendingSource(null)
              }}
            >
              変換の元にする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  )
}

/** 案件の AI の費用の合計。10ドルを超えたら注意を出す（止めない） */
function CaseCost({ usd, fx }: { usd: number; fx: UsdJpy | null }) {
  const over = usd > CASE_COST_NOTICE_USD
  return (
    <span
      className={over ? "text-xs font-medium text-amber-700" : "text-xs text-muted-foreground"}
      title={over ? `この案件の AI の費用が ${CASE_COST_NOTICE_USD} ドルを超えました（止めません）` : undefined}
      data-testid="case-cost"
      data-over={over || undefined}
    >
      {over && <TriangleAlert className="mr-1 inline size-3.5" />}
      AI の費用 <Cost usd={usd} fx={fx} />
    </span>
  )
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const text = {
    saved: "保存しました",
    pending: "保存しています…",
    failed: status.kind === "failed" ? `保存できませんでした（${status.message}）。少し待って送り直します` : "",
    conflict: "別の画面でこの案件が保存されました。再読み込みしてください（この画面の変更は保存しません）",
    tooLarge: "案件の状態が大きすぎて保存できません（次の変更で送り直します）",
    gone: "この案件は削除されたか、削除の途中です（この画面の変更は保存しません）",
  }[status.kind]
  return (
    <span className={status.kind === "saved" || status.kind === "pending" ? "text-xs text-muted-foreground" : "text-xs font-medium text-red-700"} data-testid="save-status" data-status={status.kind}>
      {text}
    </span>
  )
}

/** 案件に付けたファイル。表になるファイル（Excel・CSV）は変換の元に選べる（PDF は保存と一覧だけ） */
function FileList({ files, sourceFileId, loading, onChoose }: { files: CaseFile[]; sourceFileId: string | null; loading: boolean; onChoose: (f: CaseFile) => void }) {
  if (!files.length) return null
  return (
    <ul className="divide-y rounded-xl border text-sm" data-testid="file-list">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 px-3 py-2" data-file={f.name} data-kind={f.kind}>
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <a href={fileUrl(f.id)} className="truncate hover:underline" download={f.name}>
            {f.name}
          </a>
          <span className="shrink-0 text-xs text-muted-foreground">
            {FILE_KIND_LABELS[f.kind]}・{formatSize(f.size)}
          </span>
          <span className="ml-auto shrink-0">
            {f.id === sourceFileId ? (
              <span className="text-xs font-medium text-violet-700" data-testid="current-source">
                変換の元
              </span>
            ) : (
              f.kind === "source" &&
              isSheetFile(f.name) && (
                <Button variant="ghost" size="xs" disabled={loading} onClick={() => onChoose(f)}>
                  変換の元にする
                </Button>
              )
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** 計画の元のシートと見出しが同じシートを、変換に使うか選ぶ */
function SheetPicker({ sheets, primary, plan, onChange }: { sheets: SheetGrid[]; primary: SheetGrid; plan: Plan; onChange: (p: Plan) => void }) {
  const others = sheets.filter((s) => s !== primary && sameHeader(s, primary, plan.headerRow))
  if (!others.length) return null
  return (
    <div className="grid gap-1 text-sm" data-testid="sheet-picker">
      <span className="text-xs text-muted-foreground">見出しが同じシート（選ぶと行を結合します）</span>
      {others.map((s) => (
        <label key={s.name} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={plan.sheets.includes(s.name)}
            onChange={(e) =>
              onChange({ ...plan, sheets: e.target.checked ? [...plan.sheets, s.name] : plan.sheets.filter((n) => n !== s.name) })
            }
          />
          {s.name}（{s.rows.length}行）
        </label>
      ))}
    </div>
  )
}

function Notice({ tone, children, testId }: { tone: "info" | "warning"; children: React.ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={
        tone === "warning"
          ? "rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          : "rounded-xl border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      }
    >
      {children}
    </div>
  )
}

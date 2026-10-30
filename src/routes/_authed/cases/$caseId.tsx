import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router"
import { FileSpreadsheet, FileText, FileUp, Loader2, MessageSquare, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { AppShell, PageHeader } from "@/components/app-shell"
import { CaseReport, type ReportPhase, type ReportProps, type ReportQuestion } from "@/components/cases/case-report"
import { DeleteButton } from "@/components/cases/delete-dialog"
import { useCaseAutosave, type SaveStatus } from "@/components/cases/use-case-autosave"
import { EditExcelPanel, type EditImport } from "@/components/convert/edit-excel-panel"
import { ExportDialog } from "@/components/convert/export-dialog"
import { InquiryPanel } from "@/components/convert/inquiry-panel"
import { LocationPanel, useLocationSearch } from "@/components/convert/location-panel"
import { PreviewTable, StatusLegend } from "@/components/convert/preview-table"
import { ReplacePanel } from "@/components/convert/replace-panel"
import { countRowFilters, type RowFilter } from "@/components/convert/status"
import { GyoshuSummaryTable, RoundingNote } from "@/components/convert/summary-panel"
import type { ProposalActions, UndoState } from "@/components/chat/proposal-card"
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
import { MAX_ADDED_ROWS } from "@/lib/cases/added"
import { fetchCaseFile, uploadCaseFile } from "@/lib/cases/files-client"
import { fromSaved, newWork, type CaseWork, type SavedPlan } from "@/lib/cases/state"
import { CASE_STATUSES, CASE_STATUS_LABELS, contentTypeOf, FILE_KIND_LABELS, fileUrl, isSheetFile, onlyNonSheetSources, type CaseFile, type CaseStatus, type FileKind } from "@/lib/cases/types"
import { canUndo, pushUndo, undo, undoEntry, type UndoEntry } from "@/lib/cases/undo"
import { uploadKind } from "@/lib/cases/upload-kind"
import { baseRows, editRows, orderAndFinalize, selectRows } from "@/lib/cases/view"
import { carryoverReady } from "@/lib/chat/carryover"
import { caseContext, NO_SOURCE_CONTEXT } from "@/lib/chat/context"
import type { ChatAction } from "@/lib/chat/messages"
import { addedCountAfter, answer, applyChanges, decide, decisionOf, discard, isAnswered, newProposal, withRecorded, type Proposal, type ProposalRecord } from "@/lib/chat/proposals"
import { toWire } from "@/lib/chat/wire"
import { ADDRESS_API_PATH, addressCache, addressKey, lookupAddresses, NO_ADDRESSES, type AddressBook, type AddressLookup } from "@/lib/convert/address"
import { convertRows, countByStatus, editKey, editSession, resolveRows, staffEdit, type CellEdit, type RowResult } from "@/lib/convert/convert"
import { csvFileName, datedFileName, toCsvBytes } from "@/lib/convert/csv"
import { compareFormats, describeFormatDiff } from "@/lib/convert/format-diff"
import { heuristicPlan, planSheets, primarySheet, sheetByNames } from "@/lib/convert/heuristic-plan"
import { SELECTION_LABELS, SELECTION_MODES, summarizeKoji, TAX_LABELS, type Inclusion, type TaxMode } from "@/lib/convert/koji-selection"
import { personLetters } from "@/lib/convert/persons"
import { addressInputs, fillAiCache, type AiCache, type AiCaller } from "@/lib/convert/pipeline"
import { acceptAiPlan, reviewPlanTransforms, type MappingPlan, type SheetGrid } from "@/lib/convert/plan"
import { applyPlanPatch, sheetShapeOf } from "@/lib/convert/plan-patch"
import { planExcerpt, previousPlanContext } from "@/lib/convert/prompt"
import { collectSourceRows, sameHeader, sourceKey } from "@/lib/convert/sources"
import { parseInputNumber } from "@/lib/convert/text"
import type { Rounding } from "@/lib/convert/transforms"
import { editSheet, readEditSheet } from "@/lib/excel/edit-sheet"
import { finalSheetRows } from "@/lib/excel/final-sheet"
import { Cost, useUsdJpy } from "@/components/cost"
import { CASE_COST_NOTICE_USD } from "@/lib/cost"
import type { UsdJpy } from "@/lib/fx"
import { errorMessage } from "@/lib/errors"
import { saveFile } from "@/lib/save-file"
import { collectInquiries, mergeAnswers, readAnswers } from "@/lib/inquiry/inquiry"
import { KOJI_KEIREKI, KOJI_PLAN_HINTS, type KojiFieldId } from "@/lib/spec/koji-keireki"
import { cn } from "@/lib/utils"
import { planWithAi, runAiBatch } from "@/server/ai"
import { getCasePageFn, updateCaseStatusFn } from "@/server/cases"
import { approveRuleFn, recordExcelProposalFn } from "@/server/chat-fns"
import { approveLocationsFn } from "@/server/location-fns"
import { createClientOnlyFn } from "@tanstack/react-start"

export const Route = createFileRoute("/_authed/cases/$caseId")({
  loader: async ({ params }) => {
    const page = await getCasePageFn({ data: { id: params.caseId } })
    if (!page) throw notFound()
    return page
  },
  component: CasePage,
})

/** 編集用の Excel・取り込み用の Excel を書く ExcelJS は、落とすときにブラウザで読み込む */
const loadEditXlsx = createClientOnlyFn(() => import("@/lib/excel/edit-xlsx"))
const loadFinalXlsx = createClientOnlyFn(() => import("@/lib/excel/final-xlsx"))

/** チャット（Markdown の描画・AI SDK）は画面を開いたあとに読み込む */
const ChatPanel = lazy(() => import("@/components/chat/chat-panel").then((m) => ({ default: m.ChatPanel })))

const SPEC = KOJI_KEIREKI
const NO_LETTERS = personLetters([])
const NO_INCLUSION: ReadonlyMap<string, Inclusion> = new Map()
const NO_ROWS: RowResult<KojiFieldId>[] = []
type Plan = MappingPlan<KojiFieldId>
type Source = { fileId: string; name: string; sheets: SheetGrid[] }

/** 列の計画の前に、去年の Excel を読み終えるのを待つ長さ */
const PREVIOUS_WAIT_MS = 3_000

/** チャットを表の横に並べる画面の幅（これより狭い画面ではチャットを表の上に重ねて開く） */
const WIDE_QUERY = "(min-width: 1280px)"

type PreviousCase = NonNullable<NonNullable<Awaited<ReturnType<typeof getCasePageFn>>>["previous"]>

/** 表の下の欄 */
const TABS = [
  { id: "selection", label: "7割と金額" },
  { id: "inquiry", label: "問い合わせ" },
  { id: "excel", label: "Excel で直す" },
  { id: "location", label: "工事場所" },
  { id: "replace", label: "一括置換" },
] as const
type Tab = (typeof TABS)[number]["id"]

/** 去年の比べるシートと見出しの行（去年の計画のもの。計画が無い・シートが無ければ見出しから推定する）。比べるシートが無ければ null */
function previousSideOf(previous: PreviousCase, sheets: SheetGrid[]) {
  const prevGrid = sheetByNames(SPEC, KOJI_PLAN_HINTS, sheets, previous.sheet)
  if (!prevGrid) return null
  const headerRow = prevGrid.name === previous.sheet && previous.headerRow !== null ? previous.headerRow : heuristicPlan(SPEC, KOJI_PLAN_HINTS, prevGrid).headerRow
  return { sheets, sheet: prevGrid.name, headerRow }
}

/**
 * 計画をやり直すとき（元のファイルの変更）: 行の作業と AI の結果は捨て、ファイル全体の設定は残す。開いている変更案は閉じる。
 * 計画は考え終わるまで null（この形をすぐ保存するので、考えている途中で閉じても、開き直すと新しい元で考え直す）。
 * 取り消しの記録は前の元の行を指すので捨てる
 */
const replanWork = (w: CaseWork, sourceFileId: string): CaseWork => ({
  ...newWork(sourceFileId),
  tax: w.tax,
  basis: w.basis,
  selection: w.selection,
  rounding: w.rounding,
  sorted: w.sorted,
  threshold: w.threshold,
  reportAnswers: w.reportAnswers,
  // 変更案は前の元の行を指すので閉じる（消さずに残す。消すと、サーバーの記録から開き直したときにまた足される）
  proposals: w.proposals.map(discard),
})

/**
 * 保存済みの計画を今の変換の決まりで確かめる（AI の計画の取り込みと同じ）。使えなくなった変換（個人名を匿名化しない変換など）は替え、
 * 変換し直す（替えた変換の AI の結果はまだ無い。開くと自動で変換する）
 */
function reviewSavedPlan(w: CaseWork): CaseWork {
  if (!w.plan) return w
  const { plan, changed } = reviewPlanTransforms(SPEC, w.plan.plan)
  if (!changed.length) return w
  const notice = `保存した計画の ${changed.join("・")} の変換を、個人名を匿名化する変換に替えて変換し直しました。`
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

/** 画面の幅がクエリに合うか（サーバーで描くときは false） */
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const m = window.matchMedia(query)
    setMatches(m.matches)
    const on = (e: MediaQueryListEvent) => setMatches(e.matches)
    m.addEventListener("change", on)
    return () => m.removeEventListener("change", on)
  }, [query])
  return matches
}

/** 変換の元に読み込めるか（PDF などは保存と一覧だけ） */
const isPdf = (name: string) => /\.pdf$/i.test(name)

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
  const [loadingSource, setLoadingSource] = useState<string | null>(null)
  /** AI が列の対応を考えている間の、見出しからの推定（保存しない） */
  const [planDraft, setPlanDraft] = useState<SavedPlan | null>(null)
  const planning = planDraft !== null
  const [converting, setConverting] = useState(false)
  /** 自動の変換が失敗したときの理由と、その計画（同じ計画で何度も変換し直さない） */
  const [convertError, setConvertError] = useState<{ message: string; plan: SavedPlan | null } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [pendingSource, setPendingSource] = useState<CaseFile | null>(null)
  const [filter, setFilter] = useState<RowFilter | null>(null)
  const [tab, setTab] = useState<Tab>("selection")
  const [editResult, setEditResult] = useState<EditImport | null>(null)
  const wide = useMediaQuery(WIDE_QUERY)
  /** 狭い画面でチャットを開いているか（広い画面ではいつも開いている） */
  const [chatShown, setChatShown] = useState(false)
  const chatOpen = wide || chatShown
  const tabsRef = useRef<HTMLDivElement>(null)
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
   * 職員が指定したシート → 去年と同じ名前のシート → 見出しから選んだシート（sheetByNames）、見出しの行は見出しからの推定。
   * 比べたシートは違いの文に出る。去年の計画が無い・去年の Excel を読めなければ無し
   */
  async function previousPlanFor(src: Source, requiredSheet: string | undefined) {
    const prevPlan = previous?.plan
    if (!previous || !prevPlan) return undefined
    // 去年の Excel は開いたときから読んでいる。計画をそれ以上待たせない（読み終わらなければ去年の文脈なしで計画する）
    const sheets = await Promise.race([loadPreviousSheets(), new Promise<null>((resolve) => setTimeout(() => resolve(null), PREVIOUS_WAIT_MS))])
    const side = sheets && previousSideOf(previous, sheets)
    const prevGrid = side && sheets.find((s) => s.name === prevPlan.sheets[0])
    const g = sheetByNames(SPEC, KOJI_PLAN_HINTS, src.sheets, requiredSheet, prevPlan.sheets[0])
    if (!side || !prevGrid || !g) return undefined
    const diff = describeFormatDiff(compareFormats(side, { sheets: src.sheets, sheet: g.name, headerRow: heuristicPlan(SPEC, KOJI_PLAN_HINTS, g).headerRow }))
    return previousPlanContext(SPEC, { fiscalYear: previous.fiscalYear, grid: prevGrid, plan: prevPlan, diff })
  }

  /**
   * 列の計画を立てる。どのシートを使うか・見出しの行・列の対応は計画の AI が決める（requiredSheet は職員が指定した計画の元のシート）。
   * AI を待つ間と AI が使えないときは、見出しから選んだシートの推定を使う。立て終わると自動で変換する（下の useEffect）
   */
  async function startPlanning(src: Source, requiredSheet?: string) {
    const fallbackFor = (g: SheetGrid) => heuristicPlan(SPEC, KOJI_PLAN_HINTS, g)
    const g = sheetByNames(SPEC, KOJI_PLAN_HINTS, src.sheets, requiredSheet)
    if (!g) throw new Error("シートが空です")
    const fallback = fallbackFor(g)
    const id = ++caseGeneration.current
    supersedeConversion()
    setConvertError(null)
    setPlanDraft({ plan: fallback, source: "rule" })
    setWork((w) => replanWork(w, src.fileId))
    let next: SavedPlan
    try {
      const previousContext = await previousPlanFor(src, requiredSheet)
      if (id !== caseGeneration.current) return
      const targets = planSheets(SPEC, KOJI_PLAN_HINTS, src.sheets, requiredSheet)
      const excerpt = planExcerpt(src.sheets.length, targets.sheets, targets.required)
      const res = await planWithAi({ data: { caseId: kase.id, ...excerpt, ...(previousContext ? { previous: previousContext } : {}) } })
      addCost(res.usd)
      if (res.ok) {
        const accepted = acceptAiPlan(SPEC, src.sheets, excerpt, res.json, fallbackFor)
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
    setLoadingSource(file.name)
    try {
      const { readWorkbook } = await import("@/lib/convert/workbook")
      const sheets = readWorkbook(file.name, await fetchCaseFile(file.id))
      if (!primarySheet(SPEC, KOJI_PLAN_HINTS, sheets)) throw new Error("シートが空です")
      const src = { fileId: file.id, name: file.name, sheets }
      setSource(src)
      setLoadingSource(null)
      if (replan) await startPlanning(src)
    } catch (e) {
      toast.error(errorMessage(e, "ファイルを読み込めませんでした"))
    } finally {
      setLoadingSource(null)
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

  /**
   * 届いたファイルを付ける（表の欄・チャット欄に落としたファイル、付けるボタン）。種類は決まった印で見分ける（lib/cases/upload-kind.ts）:
   * この画面で落とした編集用の Excel は差分を変更案に、記入用Excel は回答として取り込み、ほかの表は届いたファイルとして保存する。
   * 変換の元がまだ無ければ最初の表を変換の元にし、もう元があれば変換の元にするか聞く
   */
  async function attach(list: readonly File[]) {
    let hasSource = !!workRef.current.sourceFileId
    for (const f of list) {
      let kind = uploadKind(null)
      if (isSheetFile(f.name)) {
        try {
          const { readWorkbook } = await import("@/lib/convert/workbook")
          kind = uploadKind(readWorkbook(f.name, new Uint8Array(await f.arrayBuffer())))
        } catch (e) {
          toast.error(errorMessage(e, `${f.name} を読めませんでした`))
          continue
        }
      }
      if (kind === "edit") {
        setTab("excel")
        const result = await importEditFile(f)
        if (result) setEditResult(result)
        continue
      }
      if (kind === "answer") {
        setTab("inquiry")
        await importAnswers(f)
        continue
      }
      const saved = await keepFile("source", f, f.name)
      if (!saved || isPdf(saved.name) || !isSheetFile(saved.name)) continue
      if (!hasSource) {
        hasSource = true
        // PDF から足した行があれば、変換の元にすると消えるので確かめる
        if (workRef.current.added.length) setPendingSource(saved)
        else await openSource(saved, true)
      } else setPendingSource(saved)
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
  /** 去年の元の Excel と今年の元の Excel の形の違い（lib/convert/format-diff.ts）。報告とチャットの文脈に出す。今年のシートか見出しの行が変わったときだけ比べ直す */
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

  /** 変換する（ルール → AI の値の判断）。計画を立て終えたとき・計画を変えたときに自動で呼ぶ */
  async function convert() {
    if (!sources || !plan || !addressValues || !work.plan) return
    const planAtStart = work.plan
    const generation = supersedeConversion()
    setConverting(true)
    setConvertError(null)
    const failures = new Set<string>()
    const cache: AiCache = new Map(work.aiCache)
    try {
      // 住所をまだ引き終わっていなければ待つ（黙って何もしないことはしない）
      const book = await ensureAddresses(addressValues)
      if (generation !== conversionGeneration.current) return
      await fillAiCache(convertRows(SPEC, sources.rows, plan, { rounding, addresses: book }), cache, serverAi(kase.id, failures, addCost))
      if (generation !== conversionGeneration.current) return
      // 変換している間に計画が変わっていたら、その計画で変換し直す（この結果は使わない。AI の結果だけ残す）
      setWork((w) => (w.plan === planAtStart ? { ...w, aiCache: cache, converted: true, aiNotice: failures.size ? [...failures].join(" / ") : null } : { ...w, aiCache: new Map([...cache, ...w.aiCache]) }))
    } catch (e) {
      if (generation === conversionGeneration.current) setConvertError({ message: errorMessage(e, "変換に失敗しました"), plan: planAtStart })
    } finally {
      if (generation === conversionGeneration.current) setConverting(false)
    }
  }
  // 計画が決まって変換していなければ、自動で変換する（「変換する」のボタンは無い）。失敗した計画では繰り返さない（報告の「もう一度変換する」で）
  const needsConversion = !!work.plan && !work.converted && !!sources && !!addressValues && !converting && convertError?.plan !== work.plan
  useEffect(() => {
    if (needsConversion) void convert()
  }, [needsConversion, work.plan])

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
  const freshRows = useMemo(() => {
    if (!work.sourceFileId) return NO_ROWS
    return work.converted && sources && ctx ? resolveRows(drafts, work.aiCache) : null
  }, [work.sourceFileId, work.converted, sources, ctx, drafts, work.aiCache])
  /** 変換し直している間は、前の変換の行を見せたままにする（表が消えない。触れないように覆う） */
  const lastRows = useRef<RowResult<KojiFieldId>[] | null>(null)
  if (freshRows) lastRows.current = freshRows
  else if (!work.plan || !work.sourceFileId) lastRows.current = null
  const rows = freshRows ?? lastRows.current
  const reconverting = !freshRows && !!rows
  const added = work.added
  /** 表を見せるか（変換した、または足した行がある） */
  const hasTable = (work.converted || added.length > 0 || reconverting) && !!rows
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
  /** 欄に出す変更案: 開いているものと、承認を取り消せるもの（決め終わっても、取り消すまで欄に残す） */
  const shownInPanel = (p: Proposal) => p.state === "open" || work.undo.some((e) => e.proposalId === p.id && canUndo(e))
  const excelProposals = work.proposals.filter((p) => p.origin.kind === "excel" && shownInPanel(p))
  const locationProposals = work.proposals.filter((p) => p.origin.kind === "location" && shownInPanel(p))
  const counts = useMemo(() => (output ? countByStatus(output) : null), [output])
  const filterCounts = useMemo(() => (shown ? countRowFilters(shown, inclusion) : null), [shown, inclusion])
  const inquiries = useMemo(() => (output ? collectInquiries(output, { tax }) : []), [output, tax])
  const summary = useMemo(() => (edited && selected ? summarizeKoji(edited, selected, { tax, basis }) : []), [edited, selected, tax, basis])
  /** 表の絞り込み。職員が選ぶまでは、確かめる行があればその行だけ（無ければすべて） */
  const tableFilter: RowFilter = filter ?? (filterCounts && filterCounts.check.all > 0 ? "check" : "all")

  const fx = useUsdJpy()
  /** 開いている変更案の中身（サーバーが R2 から読んだもの。指示の返事で届いたものを足す。保存はサーバーが済ませている） */
  const [proposalChanges, setProposalChanges] = useState(() => new Map(recordedProposals.map((r) => [r.proposal.id, r.changes])))
  /** ルールの追記・工事場所を保存している間（変更案の承認を止める） */
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
  const chatReady = !!rows && !reconverting && (noSheetSource || (work.converted && !!source && !!grid && !!plan))

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
      plan: grid && work.plan ? { plan: work.plan.plan, shape: sheetShapeOf(grid) } : null,
    }
  }

  const updateProposal = (id: string, next: (p: Proposal) => Proposal) => update("proposals", (ps) => ps.map((p) => (p.id === id ? next(p) : p)))

  /** 承認の記録を作って作業に足す（cases/undo.ts）。before と after は承認の前後の作業 */
  function withUndo(before: CaseWork, after: CaseWork, proposalId: string, external: UndoEntry["external"] = []): CaseWork {
    const entry = undoEntry(before, after, { id: crypto.randomUUID(), proposalId, label: proposalId, at: Date.now(), external })
    return entry ? { ...after, undo: pushUndo(after.undo, entry) } : after
  }

  /**
   * 変更案を承認・却下する。承認した表の変更は手直し・入れ外し・設定に重ね、列の対応の変更は今の計画に重ねて変換し直す。
   * 承認するたびに取り消しの記録を残す。ルールの追記は1件ずつ保存し、保存できたものから承認の印を付ける
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
    const planned = chosen.filter((i) => changes[i]!.kind === "plan")
    const table = chosen.filter((i) => changes[i]!.kind !== "rule" && changes[i]!.kind !== "location" && changes[i]!.kind !== "plan")
    // 足した行の上限を超える承認はしない（超えるとチャットに表を送れなくなる）
    const after = addedCountAfter(work.added, table.map((i) => changes[i]!))
    if (after > MAX_ADDED_ROWS) {
      toast.error(`承認すると足した行が ${after} 行になります。案件に足せる行は ${MAX_ADDED_ROWS} 行までです（承認していません）`)
      return
    }
    // 列の対応の変更は、今の計画と計画の元のシートで確かめ直す（AI の計画の取り込みと同じ決まり）。合わなければ承認しない
    let nextPlan: Plan | null = null
    if (planned.length) {
      if (!work.plan || !grid) {
        toast.error("変換の元のファイルを読んでいます。読み終えてから承認してください")
        return
      }
      let p0 = work.plan.plan
      for (const i of planned) {
        const c = changes[i]!
        if (c.kind !== "plan") continue
        const r = applyPlanPatch(SPEC, p0, c.patch, sheetShapeOf(grid))
        if (!r.ok) {
          toast.error(`列の対応を変えられません（承認していません）: ${r.problems.join(" / ")}`)
          return
        }
        p0 = r.plan
      }
      nextPlan = p0
    }
    const apply = (indices: number[], external: UndoEntry["external"] = []) => {
      if (!indices.length) return
      const edited = view?.edited ?? []
      setWork((w) => {
        const overlaid = applyChanges(w, edited, indices.map((i) => changes[i]!))
        const replanned = nextPlan && indices.some((i) => changes[i]!.kind === "plan") && w.plan ? { ...overlaid, plan: { ...w.plan, plan: nextPlan }, converted: false } : overlaid
        const decided = { ...replanned, proposals: w.proposals.map((x) => (x.id === id ? decide(x, indices, "applied") : x)) }
        return withUndo(w, decided, id, external)
      })
    }
    if (nextPlan) supersedeConversion()
    apply([...table, ...planned])
    if (located.length) {
      setSavingRule(true)
      try {
        await approveLocationsFn({ data: { caseId: kase.id, proposalId: id, items: located } })
        apply(located, ["location"])
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
        setWork((w) => withUndo(w, { ...w, proposals: w.proposals.map((x) => (x.id === id ? decide(x, [i], "applied") : x)) }, id, ["rule"]))
      }
      toast.success("ルールに追記しました")
    } catch (e) {
      toast.error(errorMessage(e, "ルールに追記できませんでした（保存できたものは承認済みにしました）"))
    } finally {
      setSavingRule(false)
    }
  }

  /** 変更案の承認を取り消す（その変更案の、まだ取り消していない記録を新しい順に）。承認のあとに変えた値は残して知らせる */
  function undoProposal(proposalId: string) {
    let next = workRef.current
    let reverted = 0
    let kept = 0
    let planChanged = false
    for (const e of [...next.undo].reverse()) {
      if (e.proposalId !== proposalId || !canUndo(e)) continue
      const r = undo(next, e.id)
      if (!r) continue
      next = r.work
      reverted += r.reverted
      kept += r.kept
      planChanged ||= r.planChanged
    }
    if (planChanged) {
      supersedeConversion()
      next = { ...next, converted: false }
    }
    setWork(next)
    if (kept) toast.warning(`承認を取り消しました（${reverted} 件を戻し、承認のあとに変えた ${kept} 件はそのままにしました）`)
    else toast.success(`承認を取り消しました（${reverted} 件を戻しました）`)
  }

  function undoState(proposalId: string): UndoState | null {
    const entries = work.undo.filter((e) => e.proposalId === proposalId)
    if (!entries.length) return null
    return {
      can: entries.some(canUndo),
      undone: entries.some((e) => e.undone),
      tooLarge: entries.some((e) => e.tooLarge),
      external: [...new Set(entries.flatMap((e) => e.external))],
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
    if (!against) return { error: "表がまだありません。変換が済んでから上げてください" }
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

  /** チャット欄・表の欄に落とした編集用の Excel（結果は「Excel で直す」の欄に出す） */
  async function importEditFile(f: File): Promise<EditImport | undefined> {
    try {
      const r = await readEditFile(f)
      if (r && "report" in r) toast.success(`直した Excel を読みました（${f.name}）。変更案は「Excel で直す」の欄にあります`)
      return r
    } catch (e) {
      return { error: errorMessage(e, "Excel を取り込めませんでした") }
    }
  }

  /**
   * 記入された Excel を取り込む: 照合して手直しに反映する（注文者・工事名の記入は元データと同じ変換・AI に通す）。
   * 結果は answers に入る。読んでいる間に値が変わったセル（手直し・置換・変換のやり直し）の回答は反映せず、結果の changed に入る
   */
  async function readAnswerFile(f: File, against: RowResult<KojiFieldId>[]) {
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
  }

  async function importAnswers(f: File) {
    if (!shown) {
      toast.error("表がまだありません。変換が済んでから取り込んでください")
      return
    }
    try {
      const read = await readAnswerFile(f, shown)
      if (!read) return
      if ("error" in read) {
        toast.error(read.error)
        return
      }
      toast.success("顧客の回答を取り込みました。反映した件数は「問い合わせ」の欄に出ています")
      if (read.aiFailures.length) toast.warning(`AI を使えず反映していない記入があります（${read.aiFailures.join(" / ")}）。一覧を確認してください`)
    } catch (e) {
      toast.error(errorMessage(e, "回答のファイルを読み込めませんでした"))
    }
  }

  const proposalActions: Omit<ProposalActions, "canSend"> = {
    decide: (id, indices, d) => void decideProposal(id, indices, d),
    answer: (id, a) => updateProposal(id, (p) => answer(p, a)),
    undo: undoProposal,
    undoState,
  }

  /** CSV（控え）を落とす。CP932 の検査を通した値をそのまま書き、案件のファイルに残す */
  function downloadCsv() {
    if (!output) return
    const bytes = toCsvBytes(SPEC, output)
    const name = csvFileName(SPEC, customer.name, new Date())
    saveFile(bytes, name, "text/csv")
    void keepFile("csv", new Blob([bytes as BlobPart], { type: "text/csv" }), name)
  }

  /** 取り込み用の Excel を落とす（lib/excel/final-sheet.ts。値は CSV と同じ）。案件のファイルに残す */
  async function downloadFinalExcel() {
    if (!output) return
    try {
      const { finalXlsx } = await loadFinalXlsx()
      const bytes = await finalXlsx(finalSheetRows(output))
      const name = datedFileName(SPEC.fileNamePrefix, customer.name, new Date(), "xlsx")
      saveFile(bytes, name, contentTypeOf(name))
      void keepFile("final_sheet", new Blob([bytes as BlobPart], { type: contentTypeOf(name) }), name)
    } catch (e) {
      toast.error(errorMessage(e, "Excel を作れませんでした"))
    }
  }

  /** 表の下の欄を開いて見せる */
  function showTab(t: Tab) {
    setTab(t)
    if (!wide) setChatShown(false)
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }

  function onChatAction(a: ChatAction) {
    if (a === "export") setExportOpen(true)
    else if (a === "inquiry_excel") showTab("inquiry")
    else void downloadEditSheet()
  }

  // ---- 変換の報告（チャットの最初の返事） ----
  const sourceFile = files.find((f) => f.id === work.sourceFileId)
  const phase: ReportPhase = loadingSource
    ? { kind: "reading", name: loadingSource }
    : planning
      ? { kind: "planning", name: sourceFile?.name ?? "" }
      : convertError && convertError.plan === work.plan
        ? { kind: "failed", message: convertError.message }
        : work.plan && (!work.converted || reconverting)
          ? { kind: "converting", name: sourceFile?.name ?? "" }
          : hasTable
            ? { kind: "done" }
            : noSheetSource
              ? { kind: "noSheet" }
              : work.sourceFileId
                ? { kind: "reading", name: sourceFile?.name ?? "" }
                : { kind: "empty" }
  const sourceSheets = work.plan?.plan.sheets ?? []
  const reportNotes: ReportProps["notes"] = [
    ...(work.plan?.notice ? [{ text: work.plan.notice, tone: "warning" as const }] : []),
    ...(work.plan?.plan.notes ?? []).map((text) => ({ text })),
    ...(sources && sources.duplicates > 0
      ? [{ text: `選んだシートをまたいで同じ内容の行が ${sources.duplicates} 件あったため、1件にまとめました（業種ごとのシートが全件のシートにフィルタをかけたものなら、全件のシートだけを使ってください）。`, tone: "warning" as const, testId: "duplicate-notice" }]
      : []),
    ...(unmarked > 0 ? [{ text: `業種の記号（○）がどの列にも無い ${unmarked} 行は出力しません。`, testId: "unmarked-notice" }] : []),
    ...(aiNotice ? [{ text: `AI 変換できなかった値があります: ${aiNotice}。黄色のセルを確認し、必要なら直接入力してください。`, tone: "warning" as const, testId: "ai-notice" }] : []),
  ]
  const questions: ReportQuestion[] =
    hasTable && (tax === "unknown" || work.reportAnswers.tax)
      ? [
          {
            id: "tax",
            text: "元データの金額は税込ですか、税抜ですか？（7割の判定と、軽微な工事の線引きに使います。金額そのものは変えません）",
            options: [
              { value: "included", label: "税込" },
              { value: "excluded", label: "税抜" },
              { value: "ask", label: "分からない（顧客に聞く）" },
            ],
            answered: tax !== "unknown" ? TAX_LABELS[tax] : work.reportAnswers.tax === "ask" ? "分からない（顧客に聞く）" : null,
          },
        ]
      : []
  function answerReport(id: string, value: string) {
    if (id !== "tax") return
    if (value === "included" || value === "excluded") setWork((w) => ({ ...w, tax: value, reportAnswers: { ...w.reportAnswers, tax: value } }))
    else setWork((w) => ({ ...w, reportAnswers: { ...w.reportAnswers, tax: "ask" } }))
  }
  const locationSites = locationSearch.sites
  const report = (
    <CaseReport
      phase={phase}
      source={sourceFile ? `「${sourceFile.name}」${sourceSheets.length ? `のシート「${sourceSheets.join("」「")}」` : ""}` : null}
      planByAi={work.plan?.source === "ai"}
      notes={reportNotes}
      counts={
        filterCounts && shown && output
          ? { rows: shown.length, csv: output.length, ask: filterCounts.ask.csv, guessed: filterCounts.guessed.csv, error: filterCounts.error.csv, review: filterCounts.review.csv }
          : null
      }
      onFilter={(f) => {
        setFilter(f)
        if (!wide) setChatShown(false)
      }}
      questions={questions}
      onAnswer={answerReport}
      previous={
        previous && hasTable && (formatDiff || (previousSheets && "error" in previousSheets) || !previous.source)
          ? {
              fiscalYear: previous.fiscalYear,
              lines: formatDiff?.lines ?? null,
              error: formatDiff ? null : previous.source ? (previousSheets as { error: string } | null)?.error ?? null : "去年の案件に表のファイルが無いので比べられません。",
              changed: !!formatDiff && !formatDiff.diff.same,
            }
          : null
      }
      next={{
        export: () => setExportOpen(true),
        inquiry: inquiries.length ? () => showTab("inquiry") : null,
        location: locationSites > 0 ? () => showTab("location") : null,
        locationSites,
      }}
      onRetry={() => {
        setConvertError(null)
        void convert()
      }}
    />
  )

  const chatPanel = chatEnabled ? (
    <Suspense fallback={chatOpen && <aside className="fixed inset-y-0 right-0 z-40 w-[var(--aside-width)] border-l bg-background xl:top-14" />}>
      <ChatPanel
        caseId={kase.id}
        open={chatOpen}
        closable={!wide}
        ready={chatReady}
        request={chatRequest}
        proposals={work.proposals}
        changes={proposalChanges}
        view={view}
        actions={proposalActions}
        busy={savingRule}
        fx={fx}
        report={report}
        onFiles={(fs) => void attach(fs)}
        onAction={onChatAction}
        plan={work.plan?.plan ?? null}
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
        onClose={() => setChatShown(false)}
      />
    </Suspense>
  ) : null

  const dropFiles = {
    onDragOver: (e: React.DragEvent) => {
      if ([...e.dataTransfer.types].includes("Files")) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer.files.length) void attach([...e.dataTransfer.files])
    },
  }

  return (
    <AppShell aside={chatPanel} asideOpen={chatOpen && !!chatPanel} wide>
      <div {...dropFiles}>
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
          description="顧客の Excel を落とすと、AI が列の対応を考えて変換します。直したいことはチャットで頼み、変更案を承認すると表に入ります。作業は自動で保存します。"
          actions={
            <div className="flex flex-wrap items-center gap-3">
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

        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="case-toolbar">
          <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border bg-background px-3 text-sm font-medium hover:bg-muted" htmlFor="case-file-input">
            <FileUp className="size-4" /> ファイルを付ける
          </label>
          <input
            id="case-file-input"
            type="file"
            multiple
            accept=".xlsx,.xls,.csv,.pdf"
            className="sr-only"
            data-testid="file-input"
            onChange={(e) => {
              if (e.target.files?.length) void attach([...e.target.files])
              e.target.value = ""
            }}
          />
          <FileChips files={files} sourceFileId={work.sourceFileId} loading={!!loadingSource || planning} onChoose={chooseSource} />
          {source && grid && plan && source.sheets.length > 1 && (
            <SheetChooser sheets={source.sheets} primary={grid} plan={plan} onPrimary={(name) => void startPlanning(source, name)} onChange={changePlan} />
          )}
          <div className="ml-auto flex items-center gap-2">
            {hasTable && output && (
              <Button onClick={() => setExportOpen(true)} disabled={reconverting} data-testid="export-button">
                {counts?.error ? <TriangleAlert className="text-amber-200" /> : <FileSpreadsheet />}
                書き出す（{output.length}件）
              </Button>
            )}
            {!wide && chatPanel && (
              <Button variant="outline" onClick={() => setChatShown(true)} data-testid="chat-open">
                <MessageSquare /> チャット
                {openProposals > 0 && <span className="rounded-full bg-violet-600 px-1.5 text-xs text-white">{openProposals}</span>}
                {questions.some((q) => q.answered === null) && (
                  <span className="rounded-full bg-amber-500 px-1.5 text-xs text-white" title="変換の報告に、答えてほしいことがあります" data-testid="chat-open-question">
                    ?
                  </span>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* チャットが使えない（APIキーが無い）ときは、変換の報告を表の上に出す */}
        {!chatPanel && <div className="mb-3 rounded-xl border bg-card p-3">{report}</div>}

        {!hasTable && (
          <label
            htmlFor="case-file-input"
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-muted/30 px-4 py-16 text-center text-sm transition-colors hover:bg-muted/60"
            data-testid="drop-zone"
          >
            {phase.kind === "empty" || phase.kind === "noSheet" ? (
              <>
                <FileUp className="size-7 text-muted-foreground" />
                <span className="text-base font-medium">顧客から届いたファイルを落とす</span>
                <span className="text-xs text-muted-foreground">.xlsx・.xls・.csv・.pdf（複数可）。ファイルは案件に保存し、表は AI が列の対応を考えて自動で変換します</span>
                {noSheetSource && (
                  <span className="text-xs text-muted-foreground" data-testid="no-sheet-source">
                    PDF だけのときは、チャットで「PDF から工事経歴の表を作って」と頼むと AI が表を作ります。
                  </span>
                )}
              </>
            ) : (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {phase.kind === "reading" ? "ファイルを読んでいます…" : phase.kind === "planning" ? "AI が列の対応を考えています…" : phase.kind === "failed" ? "変換できませんでした（チャットの報告をご覧ください）" : "変換しています…"}
              </span>
            )}
          </label>
        )}

        {hasTable && output && shown && counts && (
          <section className="relative space-y-3" data-testid="table-section">
            {reconverting && (
              <div className="absolute inset-0 z-30 flex items-start justify-center rounded-xl bg-background/60 pt-24 backdrop-blur-[1px]" data-testid="reconverting">
                <span className="flex items-center gap-2 rounded-full border bg-background px-4 py-2 text-sm shadow-sm">
                  <Loader2 className="size-4 animate-spin text-violet-600" /> 列の対応を変えたので変換し直しています…
                </span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <StatusLegend counts={counts} />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={sorted} onCheckedChange={(v) => set("sorted", v)} aria-label="記載順に並べ替え" />
                業種ごとに元請→下請、金額の大きい順
              </label>
              {output.length === 0 && (
                <span className="text-sm text-muted-foreground" data-testid="no-rows-note">
                  CSV に載せる行がありません。左のチェックで行を選んでください
                </span>
              )}
            </div>
            <PreviewTable
              spec={SPEC}
              rows={shown}
              order={sorted ? "gyoshu" : "source"}
              inclusion={inclusion}
              openEditor={(cell) => editSession(cell, letters)}
              onEdit={edit}
              onToggle={(key, included) => update("manual", (prev) => new Map(prev).set(key, included))}
              filter={tableFilter}
              onFilterChange={setFilter}
            />
            <p className="text-xs text-muted-foreground">
              セルをクリックすると直接直せます（Enter で確定、Esc で取り消し）。左のチェックで CSV に載せる行を入れ外しできます。個人名の記号（Ａ・Ｂ…）は直すときに「〔Ａ〕」の形で出ます。その形のまま残すと同じ人として扱います。
            </p>

            <div ref={tabsRef} className="scroll-mt-20 pt-4">
              <div className="flex flex-wrap gap-1 border-b" role="tablist" aria-label="表のほかの作業">
                {TABS.map((t) => {
                  const badge = t.id === "inquiry" ? inquiries.length : t.id === "excel" ? excelProposals.filter((p) => p.state === "open").length : t.id === "location" ? locationProposals.filter((p) => p.state === "open").length : 0
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === t.id ? "border-violet-600 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                      onClick={() => setTab(t.id)}
                      data-testid={`tab-${t.id}`}
                    >
                      {t.label}
                      {badge > 0 && <span className="num ml-1.5 rounded-full bg-muted px-1.5 text-xs">{badge}</span>}
                    </button>
                  )
                })}
              </div>
              <div className="pt-4" hidden={tab !== "selection"} role="tabpanel">
                <SelectionPanel
                  rounding={rounding}
                  onRounding={(r) => set("rounding", r)}
                  tax={tax}
                  onTax={(t) => set("tax", t)}
                  selection={selectionMode}
                  onSelection={(m) => set("selection", m)}
                  threshold={thresholdInput}
                  onThreshold={(t) => set("threshold", t)}
                  manualCount={manual.size}
                  onClearManual={() => set("manual", new Map())}
                  roundingTotals={roundingTotals}
                >
                  <GyoshuSummaryTable summary={summary} basis={basis} onBasisChange={(code, side, v) => update("basis", (prev) => ({ ...prev, [code]: { ...prev[code], [side]: v } }))} />
                </SelectionPanel>
              </div>
              <div className="pt-2" hidden={tab !== "inquiry"} role="tabpanel">
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
                  importAnswers={importAnswers}
                />
              </div>
              <div className="pt-4" hidden={tab !== "excel"} role="tabpanel">
                {view && (
                  <EditExcelPanel
                    view={view}
                    proposals={excelProposals}
                    changes={proposalChanges}
                    actions={proposalActions}
                    busy={savingRule}
                    download={downloadEditSheet}
                    upload={readEditFile}
                    result={editResult}
                    onResult={setEditResult}
                  />
                )}
              </div>
              <div className="pt-4" hidden={tab !== "location"} role="tabpanel">
                {view && <LocationPanel search={locationSearch} view={view} proposals={locationProposals} changes={proposalChanges} actions={proposalActions} busy={savingRule} fx={fx} />}
              </div>
              <div className="pt-4" hidden={tab !== "replace"} role="tabpanel" data-testid="replace-details">
                <p className="mb-3 text-sm text-muted-foreground">値の一括置換（配置技術者の差し替えなど）。</p>
                <ReplacePanel spec={SPEC} rows={rows!} letters={letters} replacements={replacements} onChange={replace} />
              </div>
            </div>
          </section>
        )}
      </div>

      {output && (
        <ExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          output={output}
          summary={summary}
          basis={basis}
          onBasisChange={(code, side, v) => update("basis", (prev) => ({ ...prev, [code]: { ...prev[code], [side]: v } }))}
          onExcel={() => void downloadFinalExcel()}
          onCsv={downloadCsv}
        />
      )}

      <AlertDialog open={!!pendingSource} onOpenChange={(open) => !open && setPendingSource(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>変換の元を「{pendingSource?.name}」にしますか</AlertDialogTitle>
            <AlertDialogDescription>
              ファイルは案件に保存しました。変換の元にすると、今の変換の結果・足した行・手直し・行の入れ外し・取り込んだ回答・承認の取り消しの記録は消えます（端数・税込税抜・基準額の設定は残します）。参考のファイルとして付けるだけなら「付けるだけ」を押してください（チャットの AI は読めます）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="source-keep">付けるだけ</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingSource) void openSource(pendingSource, true)
                setPendingSource(null)
              }}
              data-testid="source-replace"
            >
              変換の元にする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  )
}

/** 7割と金額の設定（載せる工事の選び方・金額で追加・税込税抜・端数）と業種ごとの件数と7割 */
function SelectionPanel(p: {
  rounding: Rounding
  onRounding: (r: Rounding) => void
  tax: TaxMode
  onTax: (t: TaxMode) => void
  selection: CaseWork["selection"]
  onSelection: (m: CaseWork["selection"]) => void
  threshold: CaseWork["threshold"]
  onThreshold: (t: CaseWork["threshold"]) => void
  manualCount: number
  onClearManual: () => void
  roundingTotals: { floor: number; round: number } | null
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="tax">元データの金額</Label>
          <NativeSelect id="tax" value={p.tax} onChange={(e) => p.onTax(e.target.value as TaxMode)}>
            {Object.entries(TAX_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="rounding">千円未満の端数</Label>
          <NativeSelect id="rounding" value={p.rounding} onChange={(e) => p.onRounding(e.target.value as Rounding)}>
            <option value="floor">切り捨て</option>
            <option value="round">四捨五入</option>
          </NativeSelect>
        </div>
        {p.roundingTotals && <RoundingNote floor={p.roundingTotals.floor} round={p.roundingTotals.round} current={p.rounding} />}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="載せる工事の選び方" data-testid="selection-mode">
          載せる工事:
          {SELECTION_MODES.map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="radio" name="selection-mode" value={m} checked={p.selection === m} onChange={() => p.onSelection(m)} data-testid={`selection-${m}`} />
              {SELECTION_LABELS[m]}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={p.threshold.on} onChange={(e) => p.onThreshold({ ...p.threshold, on: e.target.checked })} data-testid="threshold-on" />
          金額が
          <Input
            className="h-8 w-36"
            inputMode="numeric"
            aria-label="追加で含める金額（円）"
            value={p.threshold.yen}
            onChange={(e) => p.onThreshold({ ...p.threshold, yen: e.target.value })}
            placeholder="例: 3000000"
          />
          円以上の行もすべて含める
        </label>
        {p.manualCount > 0 && (
          <Button variant="outline" size="sm" onClick={p.onClearManual}>
            手動の入れ外し（{p.manualCount}件）を戻す
          </Button>
        )}
      </div>
      {p.children}
      <p className="text-xs text-muted-foreground">
        7割ルール: 業種ごとに、元請を金額の大きい順に元請の基準額の7割を超えるまで、続いて残りの元請と下請を合計の基準額の7割を超えるまで載せます。
        基準額は損益計算書の完成工事高のうち当該業種の額（<strong>税抜</strong>）です。空欄なら行の合計を使います。7割の判定と比率は税抜で出します（行の合計も税抜）。
        軽微な工事（税込500万円未満、建築一式は1,500万円未満）は10件まで。
        <span data-testid="selection-note">
          「全件を載せる」は除外した行と手動で外した行のほかをすべて載せます（7割以上なら件数は自由で、軽微の10件は「それより多くは載せなくてよい」上限なので軽微な工事も全部載せます。顧客がすでに7割で絞ったデータもこちら）。比率で7割を超えたかを確かめてください。
        </span>
        元データの金額は「{TAX_LABELS[p.tax]}」として判定します（金額そのものは変換しません）。
        {p.tax === "unknown" && <strong data-testid="tax-unknown-note">税込・税抜が不明なので、税込とみなして行の金額を1.1で割り、7割を判定しています。</strong>}
      </p>
      <p className="rounded-xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        建設業.NET の取込は<strong>追加</strong>です（上書きされません）。同じ内容を2回取り込むと工事が重複するので、取り込みは1回だけにしてください。
        見出し行がないので、取込画面の「1行目が項目行」の<strong>チェックを外して</strong>ください。
      </p>
    </div>
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

/** 案件に付けたファイル（小さく並べる）。表になる届いたファイル（Excel・CSV）は変換の元に選べる（PDF は保存と一覧だけ） */
function FileChips({ files, sourceFileId, loading, onChoose }: { files: CaseFile[]; sourceFileId: string | null; loading: boolean; onChoose: (f: CaseFile) => void }) {
  if (!files.length) return null
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs" data-testid="file-list">
      {files.map((f) => (
        <li
          key={f.id}
          className={cn("flex max-w-72 items-center gap-1.5 rounded-lg border px-2 py-1", f.id === sourceFileId && "border-violet-300 bg-violet-50 dark:bg-violet-950/30")}
          data-file={f.name}
          data-kind={f.kind}
          title={`${FILE_KIND_LABELS[f.kind]}・${formatSize(f.size)}`}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <a href={fileUrl(f.id)} className="truncate hover:underline" download={f.name}>
            {f.name}
          </a>
          {f.id === sourceFileId ? (
            <span className="shrink-0 font-medium text-violet-700" data-testid="current-source">
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
        </li>
      ))}
    </ul>
  )
}

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** 計画の元にするシートを選び直す（計画を立て直す）と、見出しが同じシートを変換に足す */
function SheetChooser({ sheets, primary, plan, onPrimary, onChange }: { sheets: SheetGrid[]; primary: SheetGrid; plan: Plan; onPrimary: (name: string) => void; onChange: (p: Plan) => void }) {
  const others = sheets.filter((s) => s !== primary && sameHeader(s, primary, plan.headerRow))
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="sheet-picker">
      <NativeSelect id="sheet" aria-label="計画の元にするシート" className="h-8 text-xs" value={primary.name} onChange={(e) => onPrimary(e.target.value)}>
        {sheets.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}（{s.rows.length}行）
          </option>
        ))}
      </NativeSelect>
      {others.map((s) => (
        <label key={s.name} className="flex items-center gap-1" title="見出しが同じシート（選ぶと行を結合します）">
          <input
            type="checkbox"
            checked={plan.sheets.includes(s.name)}
            onChange={(e) => onChange({ ...plan, sheets: e.target.checked ? [...plan.sheets, s.name] : plan.sheets.filter((n) => n !== s.name) })}
          />
          ＋{s.name}
        </label>
      ))}
    </div>
  )
}

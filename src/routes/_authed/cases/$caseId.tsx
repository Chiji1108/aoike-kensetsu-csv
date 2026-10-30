import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router"
import { Ellipsis, FileSpreadsheet, FileText, FileUp, Loader2, MessageSquare, PanelRightClose, Paperclip, Trash2, TriangleAlert, X } from "lucide-react"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import { CaseReport, type ReportProps, type ReportQuestion, type UploadNote } from "@/components/cases/case-report"
import { reportPhase } from "@/lib/cases/phase"
import { WORK_TABS, type WorkTab } from "@/components/cases/work-tabs"
import { DeleteDialog } from "@/components/cases/delete-dialog"
import { useCaseAutosave, type SaveStatus } from "@/components/cases/use-case-autosave"
import { FinalImportPanel, type FinalImport } from "@/components/convert/final-import-panel"
import { ExportDialog } from "@/components/convert/export-dialog"
import { InquiryPanel } from "@/components/convert/inquiry-panel"
import { LocationPanel, useLocationSearch } from "@/components/convert/location-panel"
import { PreviewTable } from "@/components/convert/preview-table"
import { ReplacePanel } from "@/components/convert/replace-panel"
import { countRowFilters, rowNeedsCheck, type RowFilter } from "@/components/convert/status"
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
import { NativeSelect } from "@/components/ui/native-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Segmented } from "@/components/segmented"
import { MAX_ADDED_ROWS } from "@/lib/cases/added"
import { fetchCaseFile, uploadCaseFile } from "@/lib/cases/files-client"
import { fromSaved, MAX_REJECTED_EXCEL, newWork, type CaseWork, type SavedPlan } from "@/lib/cases/state"
import { setTax, withPlanTax } from "@/lib/cases/tax"
import { ATTACH_ACCEPT, CASE_STATUSES, CASE_STATUS_LABELS, contentTypeOf, FILE_KIND_LABELS, fileUrl, isSheetFile, onlyNonSheetSources, type CaseFile, type CaseStatus, type FileKind } from "@/lib/cases/types"
import { canUndo, pushUndo, undo, undoEntry, type UndoEntry } from "@/lib/cases/undo"
import { uploadKind, warnsUnlinked } from "@/lib/cases/upload-kind"
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
import { RULE7_TAX_LABELS, SELECTION_LABELS, SELECTION_MODES, summarizeKoji, TAX_LABELS, type Inclusion, type Rule7Tax, type TaxMode } from "@/lib/convert/koji-selection"
import { personLetters } from "@/lib/convert/persons"
import { addressInputs, fillAiCache, type AiCache, type AiCaller } from "@/lib/convert/pipeline"
import { acceptAiPlan, reviewPlanTransforms, type MappingPlan, type SheetGrid } from "@/lib/convert/plan"
import { applyPlanPatch, sheetShapeOf } from "@/lib/convert/plan-patch"
import { planExcerpt, previousPlanContext } from "@/lib/convert/prompt"
import { collectSourceRows, sameHeader, sourceKey } from "@/lib/convert/sources"
import type { Rounding } from "@/lib/convert/transforms"
import { changeSignature, readFinalSheet, recount, withoutKnown, type FinalReport } from "@/lib/excel/final-import"
import { finalSheet } from "@/lib/excel/final-sheet"
import { Cost, useUsdJpy } from "@/components/cost"
import { CASE_COST_NOTICE_USD } from "@/lib/cost"
import type { UsdJpy } from "@/lib/fx"
import { errorMessage } from "@/lib/errors"
import { saveFile } from "@/lib/save-file"
import { aiAnswerPrompt, collectInquiries, inquiryKey, mergeAnswers, outsideCells, readAnswers } from "@/lib/inquiry/inquiry"
import { carryInquiryText, INQUIRY_TEXT_PROMPT } from "@/lib/inquiry/text"
import { REVIEW_PROMPT } from "@/lib/chat/review"
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

/** 最後の Excel を書く ExcelJS は、ダウンロードするときにブラウザで読み込む */
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

/** 作業の画面をチャットの横に並べる画面の幅（これより狭い画面ではチャットを画面いっぱいにし、作業の画面は上に重ねて開く） */
const WIDE_QUERY = "(min-width: 1280px)"
/** チャットの案内のうち、案件を終えるときの振り返り（返ってきた記入用Excelの案内はファイルの id） */
const REVIEW_SUGGESTION = "review"
const INQUIRY_SUGGESTION = "inquiry-text"

type PreviousCase = NonNullable<NonNullable<Awaited<ReturnType<typeof getCasePageFn>>>["previous"]>

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
  taxBy: w.taxBy,
  basis: w.basis,
  rule7Tax: w.rule7Tax,
  selection: w.selection,
  rounding: w.rounding,
  reportAnswers: w.reportAnswers,
  // 件名・前置きと項目と理由で選んだ質問は行に依らないので引き継ぐ（行の key で選んだものは前の元の行を指すので外す）
  inquiryText: carryInquiryText(w.inquiryText),
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
  const notice = `保存した計画の ${changed.join("・")} を今の決まり（個人名の項目は匿名化する変換だけ）に合わせて直し、変換し直しました。`
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

function CaseWorkspace({ kase, customer, files: initialFiles, state, chatEnabled, proposals: recordedProposals, previous, settings, excelKey }: NonNullable<Awaited<ReturnType<typeof getCasePageFn>>>) {
  const router = useRouter()
  const [files, setFiles] = useState(initialFiles)
  const [status, setStatus] = useState(kase.status)
  /** 案件の費用の合計（変換・チャットの AI の分。サーバーの合計に足したものを画面でも足す） */
  const [costUsd, setCostUsd] = useState(kase.costUsd)
  const addCost = (usd: number) => setCostUsd((c) => c + usd)
  // サーバーが記録した変更案のうち、作業にまだ無いもの（返事を受け取り損ねたもの）も作業に入れる
  const [work, setWork] = useState(() => {
    // 新しい案件の7割の計算は事務所の設定（全体ルールの画面）
    const w = state ? fromSaved(state.work, state.aiCache) : newWork(null, settings.rule7Tax)
    return { ...reviewSavedPlan(w), proposals: withRecorded(w.proposals, recordedProposals) }
  })
  const { edits, replacements, manual, dismissed, answers, tax, basis, rule7Tax, selection: selectionMode, rounding, aiNotice } = work
  const update = <K extends keyof CaseWork>(key: K, next: (prev: CaseWork[K]) => CaseWork[K]) => setWork((w) => ({ ...w, [key]: next(w[key]) }))
  /** 値をその場で読んでから入れる（イベントの値を updater の中で読まない） */
  const set = <K extends keyof CaseWork>(key: K, value: CaseWork[K]) => update(key, () => value)
  const [source, setSource] = useState<Source | null>(null)
  const [loadingSource, setLoadingSource] = useState<string | null>(null)
  /** 変換の元を読めなかった（報告に理由とやり直しを出す） */
  const [sourceError, setSourceError] = useState<{ file: CaseFile; message: string } | null>(null)
  /** アップロードしたファイルをどう扱ったか（報告に出す。保存しない） */
  const [uploadNotes, setUploadNotes] = useState<UploadNote[]>([])
  const note = (n: UploadNote) => setUploadNotes((ns) => [...ns.slice(-9), n])
  /** AI が列の対応を考えている間の、見出しからの推定（保存しない） */
  const [planDraft, setPlanDraft] = useState<SavedPlan | null>(null)
  const planning = planDraft !== null
  const [converting, setConverting] = useState(false)
  /** 自動の変換が失敗したときの理由と、その計画（同じ計画で何度も変換し直さない） */
  const [convertError, setConvertError] = useState<{ message: string; plan: SavedPlan | null } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pendingSource, setPendingSource] = useState<CaseFile | null>(null)
  const [filter, setFilter] = useState<RowFilter | null>(null)
  /** 作業の画面のタブ */
  const [tab, setTab] = useState<WorkTab>("table")
  /** 最後に上げ直した最後の Excel の結果（チャット欄の報告の下に出す。保存しない） */
  const [finalResult, setFinalResult] = useState<FinalImport | null>(null)
  /** 決まった欄で読めなかった記入のある、返ってきた記入用Excel（ファイルごとに AI に読ませるかをチャットに出す。保存しない） */
  const [answerHints, setAnswerHints] = useState<{ fileId: string; name: string }[]>([])
  /** 案件を「完了」にしたので、チャットに振り返り（来年のための顧客ルールの案）を出せると案内するか（保存しない。完了から戻すか、送ったら消す） */
  const [reviewHint, setReviewHint] = useState(false)
  /** 問い合わせの欄を開いた（チャットに「AI で文面を作る」を出す。一度送ったら、この画面では出さない） */
  const [inquiryHint, setInquiryHint] = useState(false)
  const inquiryHintSent = useRef(false)
  const wide = useMediaQuery(WIDE_QUERY)
  /**
   * 職員が作業の画面を開いた（true）・閉じた（false）か。決めるまで（null）は、表があれば広い画面では開き、狭い画面では閉じておく
   * （狭い画面で開くとチャットを覆うので、チャットの「表を開く」で開く）
   */
  const [workChoice, setWorkChoice] = useState<boolean | null>(null)
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

  const { status: saveStatus, settle: settleSave } = useCaseAutosave(kase.id, { version: state?.version ?? 0, saved: state ? work : null }, work)

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
    // 返ってきた記入用Excelの案内は前の元の行の問い合わせへのもの
    setAnswerHints([])
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
    // 計画が見出し・注記から税込・税抜を決めたら、案件の税の設定に入れる（職員が決めた値は上書きしない）
    setWork((w) => withPlanTax({ ...w, plan: next }, next.plan))
    setPlanDraft(null)
  }

  /**
   * 変換の元のファイルを読む。計画がまだ無ければ（初めて選んだ・計画の途中で閉じた）計画を立てる。
   * AI が使えない（APIキーが無い）ときは計画を立てない（このツールは AI で列の対応を決める。見出しの推定で黙って進めない）
   */
  async function openSource(file: CaseFile, replan: boolean) {
    setLoadingSource(file.name)
    setSourceError(null)
    try {
      const { readWorkbook } = await import("@/lib/convert/workbook")
      const sheets = readWorkbook(file.name, await fetchCaseFile(file.id))
      if (!primarySheet(SPEC, KOJI_PLAN_HINTS, sheets)) throw new Error("シートが空です")
      const src = { fileId: file.id, name: file.name, sheets }
      setSource(src)
      setLoadingSource(null)
      if (replan && chatEnabled) await startPlanning(src)
    } catch (e) {
      setSourceError({ file, message: errorMessage(e, "ファイルを読み込めませんでした") })
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
   * 届いたファイルを付ける（チャットの📎でアップロードしたファイル、画面にドラッグしたファイル）。種類は決まった印で見分ける（lib/cases/upload-kind.ts）:
   * この画面でダウンロードした最後の Excel は差分を変更案に、記入用Excel は回答として取り込み、ほかの表は届いたファイルとして保存する。
   * 変換の元がまだ無ければ最初の表を変換の元にし、もう元があれば変換の元にするか聞く。照合用のシートの無い最後の Excel の形の表は、
   * 変換の元があれば直した Excel と取り違えないよう、表に戻せないと伝えて聞く（前の編集用の Excel も同じ。lib/cases/upload-kind.ts の warnsUnlinked）
   */
  async function attach(list: readonly File[]) {
    let hasSource = !!workRef.current.sourceFileId
    for (const f of list) {
      let sheets: SheetGrid[] | null = null
      if (isSheetFile(f.name)) {
        try {
          const { readWorkbook } = await import("@/lib/convert/workbook")
          sheets = readWorkbook(f.name, new Uint8Array(await f.arrayBuffer()))
        } catch (e) {
          const text = errorMessage(e, "読めませんでした")
          toast.error(`${f.name}: ${text}`)
          note({ name: f.name, text, tone: "error" })
          continue
        }
      }
      const kind = uploadKind(sheets)
      if (kind === "final" && sheets) {
        await importFinalFile(f, sheets)
        continue
      }
      if (kind === "answer") {
        setTab("inquiry")
        await importAnswers(f)
        continue
      }
      const saved = await keepFile("source", f, f.name)
      if (!saved) continue
      if (isPdf(saved.name) || !isSheetFile(saved.name)) {
        note({ name: f.name, text: "届いたファイルとして保存しました（チャットの AI は読めます）" })
        continue
      }
      if (warnsUnlinked(kind, hasSource)) {
        note({ name: f.name, text: "書き出した Excel の形ですが照合用のシートが無いので、直した Excel としては表に戻せません。変換の元にするかを選んでください" })
        hasSource = true
        setPendingSource(saved)
        continue
      }
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
      if (id === statusChange.current) setReviewHint(next === "done")
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

  /** 画面と CSV の表。個人名の記号（letters）は CSV に書く行からこの順に付け、手直し・置換先の「〔Ａ〕」をその人に戻すのにも使う */
  const edited = useMemo(() => (rows ? editRows({ rows, added, edits, replacements }) : null), [rows, added, edits, replacements])
  /** 選び直しは入れ外し・7割の設定が変わったときだけ（並べ替えでは選び直さない） */
  const selected = useMemo(
    () => (edited ? selectRows({ manual, tax, basis, rule7Tax, selection: selectionMode }, edited) : null),
    [edited, manual, tax, basis, rule7Tax, selectionMode],
  )
  const view = useMemo(
    () => (rows && edited && selected ? orderAndFinalize({ rows, added, replacements }, edited, selected) : null),
    [rows, added, edited, selected, replacements],
  )
  const shown = view?.shown ?? null
  const inclusion = view?.inclusion ?? NO_INCLUSION
  const letters = view?.letters ?? NO_LETTERS
  const output = view?.output ?? null
  /** 待っている間・続けて処理するファイルの間で読む、最新の表と元（古い描画の値で取り込まない） */
  const live = useRef({ view, shown, source, addresses, plan, hasTable })
  live.current = { view, shown, source, addresses, plan, hasTable }
  /** 欄に出す変更案: 開いているものと、承認を取り消せるもの（決め終わっても、取り消すまで欄に残す） */
  const shownInPanel = (p: Proposal) => p.state === "open" || work.undo.some((e) => e.proposalId === p.id && canUndo(e))
  const excelProposals = work.proposals.filter((p) => p.origin.kind === "excel" && shownInPanel(p))
  const locationProposals = work.proposals.filter((p) => p.origin.kind === "location" && shownInPanel(p))
  /** CSV に載せる行のエラーのセルの数（書き出すボタンに印を出す） */
  const errorCells = useMemo(() => (output ? countByStatus(output).error : 0), [output])
  /** 行に確かめるセルがあるか（表の絞り込みと件数で使う。行が変わったときだけ1回数える） */
  const rowChecks = useMemo(() => new Map((shown ?? []).map((r) => [r.key, rowNeedsCheck(r)])), [shown])
  const filterCounts = useMemo(() => (shown ? countRowFilters(shown, inclusion, rowChecks) : null), [shown, inclusion, rowChecks])
  const inquiries = useMemo(() => (output ? collectInquiries(output, { tax }) : []), [output, tax])
  /** まだ答えの無いセルの問い合わせ（外したものは数えない）。「AI で読む」に出す */
  const leftInquiries = inquiries.filter((q) => q.kind === "cell" && !dismissed.has(inquiryKey(q))).length
  /** 外していない問い合わせ（セル・案件全体）の数。「AI で文面を作る」に出す */
  const activeInquiries = inquiries.filter((q) => !dismissed.has(inquiryKey(q))).length
  const summary = useMemo(() => (edited && selected ? summarizeKoji(edited, selected, { tax, basis, rule7Tax }) : []), [edited, selected, tax, basis, rule7Tax])
  /** 表の絞り込み。職員が選ぶまでは、確かめる行があればその行だけ（無ければすべて） */
  const tableFilter: RowFilter = filter ?? (filterCounts && filterCounts.check > 0 ? "check" : "all")

  const fx = useUsdJpy()
  /** 開いている変更案の中身（サーバーが R2 から読んだもの。指示の返事で届いたものを足す。保存はサーバーが済ませている） */
  const [proposalChanges, setProposalChanges] = useState(() => new Map(recordedProposals.map((r) => [r.proposal.id, r.changes])))
  /** 待っている間に読む、最新の変更案の中身（同じ Excel を2回上げたかを見る） */
  const proposalChangesRef = useRef(proposalChanges)
  proposalChangesRef.current = proposalChanges
  /** ルールの追記・工事場所を保存している間（変更案の承認を止める） */
  const [savingRule, setSavingRule] = useState(false)

  /** サーバーが置いた変更案の記録を足す（もう作業にあれば足さない。決め終わったものを開き直さない） */
  function addRecorded(r: ProposalRecord) {
    if (workRef.current.proposals.some((p) => p.id === r.proposal.id)) return
    setProposalChanges((m) => new Map(m).set(r.proposal.id, r.changes))
    update("proposals", (ps) => (ps.some((p) => p.id === r.proposal.id) ? ps : [...ps, r.proposal]))
  }
  /** まだ決めていない振り返りの案がある（決めるまで振り返りの案内を重ねて出さない） */
  const pendingReview = work.proposals.some((p) => p.state === "open" && (proposalChanges.get(p.id) ?? []).some((c, i) => c.kind === "rule" && c.source === "review" && decisionOf(p, i) === "pending"))
  /** まだ決めていない問い合わせの文面の案がある（決めるまで「AI で文面を作る」を出さない） */
  const pendingInquiryText = work.proposals.some(
    (p) => p.state === "open" && (proposalChanges.get(p.id) ?? []).some((c, i) => (c.kind === "inquiry" || c.kind === "inquiryMail") && decisionOf(p, i) === "pending"),
  )
  // 未決の工事場所の項目がある変更案（一括調査のものも、チャットの「この現場ってどこ？」のものも）を決めるまで、次の一括調査を始めさせない
  const undecidedLocation = work.proposals.some((p) => p.state === "open" && (proposalChanges.get(p.id) ?? []).some((c, i) => c.kind === "location" && decisionOf(p, i) === "pending"))
  const locationSearch = useLocationSearch({ caseId: kase.id, view, table: tableWire, undecided: undecidedLocation, onRecord: addRecorded, onCaseCost: setCostUsd })

  /** 変換の元の表が無く（PDF だけ）、AI に一から表を作らせる案件か */
  const noSheetSource = !work.sourceFileId && onlyNonSheetSources(files)
  /** チャットに送れるか（変換した、または変換の元の表が無い） */
  const chatReady = !!rows && !reconverting && (noSheetSource || (work.converted && !!source && !!grid && !!plan))

  /** 今の表（チャットと工事場所の調査に送る。大きいので送るときだけ作る） */
  function tableWire() {
    return rows ? toWire({ rows, added, edits, replacements, manual, tax, basis, rule7Tax, selection: selectionMode, dismissed, inquiryText: work.inquiryText }) : null
  }

  function chatRequest() {
    if (!rows || !chatReady) return null
    return {
      table: tableWire()!,
      context: source && grid && plan ? caseContext(source.sheets, grid, plan, previous && formatDiff ? { fiscalYear: previous.fiscalYear, lines: formatDiff.lines } : undefined) : NO_SOURCE_CONTEXT,
      sourceFileId: work.sourceFileId,
      plan: grid && work.plan ? { plan: work.plan.plan, shape: sheetShapeOf(grid) } : null,
      rounding: work.rounding,
    }
  }

  const updateProposal = (id: string, next: (p: Proposal) => Proposal) => update("proposals", (ps) => ps.map((p) => (p.id === id ? next(p) : p)))

  /** 承認の記録を作って作業に足す（cases/undo.ts）。before と after は承認の前後の作業、items は承認した項目の番号 */
  function withUndo(before: CaseWork, after: CaseWork, proposalId: string, items: number[], external: UndoEntry["external"] = []): CaseWork {
    const entry = undoEntry(before, after, { id: crypto.randomUUID(), proposalId, items, label: proposalId, at: Date.now(), external })
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
    if (decision === "rejected") {
      // 直した Excel の却下した項目は覚え、同じ Excel を上げ直しても出し直さない
      if (p.origin.kind === "excel" && chosen.length)
        setWork((w) => ({ ...w, rejectedExcel: [...w.rejectedExcel, ...chosen.map((i) => changeSignature(changes[i]!))].slice(-MAX_REJECTED_EXCEL) }))
      return updateProposal(id, (x) => decide(x, chosen, "rejected"))
    }
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
      if (!work.plan || !grid || !source) {
        toast.error("変換の元のファイルを読んでいます。読み終えてから承認してください")
        return
      }
      let p0 = work.plan.plan
      for (const i of planned) {
        const c = changes[i]!
        if (c.kind !== "plan") continue
        const r = applyPlanPatch(SPEC, p0, c.patch, sheetShapeOf(grid), source.sheets)
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
        return withUndo(w, decided, id, indices, external)
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
        setWork((w) => withUndo(w, { ...w, proposals: w.proposals.map((x) => (x.id === id ? decide(x, [i], "applied") : x)) }, id, [i], ["rule"]))
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

  /**
   * 直した最後の Excel を取り込む: 照合用のシートのダウンロードしたときの値との差分を変更案にしてサーバーに置き（チャットの変更案と同じく、開き直しても残る）、
   * 上げたファイルを案件に残す。差分は取り込み始めたときの表と比べる。待っている間に変換の元が変わったら捨てる
   */
  async function readFinalFile(f: File, sheets: readonly SheetGrid[]): Promise<{ report: FinalReport } | { error: string } | undefined> {
    const against = live.current.hasTable ? live.current.view : null
    if (!against) return { error: "表がまだありません。変換が済んでからアップロードしてください" }
    const generation = caseGeneration.current
    const failures = new Set<string>()
    const cache: AiCache = new Map(workRef.current.aiCache)
    // 件数の上限は readFinalSheet が AI を呼ぶ前に確かめる。案件のファイルに残すのは読めたあと
    const result = await readFinalSheet(
      sheets,
      against,
      { caseId: kase.id, sourceFileId: workRef.current.sourceFileId, excelKey },
      { rounding: workRef.current.rounding, cache, callAi: serverAi(kase.id, failures, addCost), lookup: (raws) => ensureAddresses([...raws]) },
    )
    if (generation !== caseGeneration.current) return undefined
    if ("error" in result) return result
    if (failures.size) toast.warning(`AI を使えなかった値があります: ${[...failures].join(" / ")}`)
    setWork((w) => ({ ...w, aiCache: new Map([...cache, ...w.aiCache]) }))
    // 開いている（未決の）・却下した直した Excel の変更案と同じ項目は除く（同じ Excel をもう一度上げても二重にせず、却下したものを出し直さない。
    // 承認した項目は、表がもうその値なので readFinalSheet が出さない）
    const known = new Set(workRef.current.rejectedExcel)
    for (const p of workRef.current.proposals) {
      if (p.origin.kind !== "excel" || p.state !== "open") continue
      proposalChangesRef.current.get(p.id)?.forEach((c, i) => {
        if (decisionOf(p, i) !== "applied") known.add(changeSignature(c))
      })
    }
    const { changes, skipped } = withoutKnown(result.changes, known)
    const report = recount(result.report, changes, skipped)
    if (!changes.length) return { report }
    const saved = await keepFile("edit_sheet", f, f.name)
    if (!saved) return undefined
    const proposal = newProposal(crypto.randomUUID(), { kind: "excel", fileId: saved.id }, changes, null)
    await recordExcelProposalFn({ data: { caseId: kase.id, record: { proposal, changes } } })
    setProposalChanges((m) => new Map(m).set(proposal.id, changes))
    update("proposals", (ps) => [...ps, proposal])
    return { report }
  }

  /** チャット欄・画面にアップロードした直した Excel。結果はチャット欄の報告の下と通知に出す */
  async function importFinalFile(f: File, sheets: readonly SheetGrid[]) {
    let r: { report: FinalReport } | { error: string } | undefined
    try {
      r = await readFinalFile(f, sheets)
    } catch (e) {
      r = { error: errorMessage(e, "Excel を取り込めませんでした") }
    }
    if (!r) return
    if ("error" in r) {
      toast.error(r.error)
      note({ name: f.name, text: r.error, tone: "error" })
      return
    }
    setFinalResult({ name: f.name, report: r.report })
    const { report } = r
    const n = report.cells + report.added + report.excluded
    const left = report.conflicts.length + report.ambiguous.length + report.invalid.length + report.refused.length + report.extraColumns.length
    if (!n && report.skipped) toast.info("前に出した・却下した変更と同じなので、変更案にしていません（チャット欄）")
    else if (n) toast.success(`直した Excel の変更 ${n} 件を変更案にしました${left ? `（取り込めなかったもの ${left} 件はチャット欄）` : ""}`)
    else if (left) toast.warning(`直した Excel の変更を取り込めませんでした（${left} 件。理由はチャット欄）`)
    else toast.success("直した Excel に変わったところはありませんでした")
  }

  /**
   * 記入された Excel を取り込む: 照合して手直しに反映する（注文者・工事名の記入は元データと同じ変換・AI に通す）。
   * 結果は answers に入る。読んでいる間に値が変わったセル（手直し・置換・変換のやり直し）の回答は反映せず、結果の changed に入る
   */
  async function readAnswerFile(f: File, against: RowResult<KojiFieldId>[]) {
    const generation = caseGeneration.current
    // 照合に使う計画・元のファイル・引いた住所は、取り込み始めたときのものにそろえる（against と同じ時点）
    const planAtStart = workRef.current.plan
    const sourceAtStart = live.current.source
    const addressesAtStart = live.current.addresses
    if (workRef.current.converted && !addressesAtStart) return { error: "住所を読み込んでいます。少し待ってから取り込んでください" }
    // 決まった欄で読めなかった記入を AI に読ませるときは、保存したファイルを AI に渡す（保存を待ってから頼めるようにする）
    const saving = keepFile("answer", f, f.name)
    const { readWorkbook } = await import("@/lib/convert/workbook")
    const sheets = readWorkbook(f.name, new Uint8Array(await f.arrayBuffer()))
    const failures = new Set<string>()
    const cache: AiCache = new Map(workRef.current.aiCache)
    // 住所は変換と同じ仕組みで引く（住所データを読めなければ、その値は読めない記入として出す。取り込み全体は止めない）
    const report = await readAnswers(sheets, against, { ctx: { rounding: workRef.current.rounding }, lookup: (raws) => ensureAddresses([...raws]), cache, callAi: serverAi(kase.id, failures, addCost), fields: planAtStart?.plan.fields ?? {} })
    if (generation !== caseGeneration.current) return undefined
    if ("error" in report) return report
    if (workRef.current.plan !== planAtStart) return { error: "取り込んでいる間に列の対応が変わりました。もう一度取り込んでください" }
    setWork((w) => {
      if (w.plan !== planAtStart) return w
      const converted = sourceAtStart && addressesAtStart ? (convertedRows(sourceAtStart.sheets, w, addressesAtStart) ?? []) : []
      const merged = mergeAnswers(report, against, { rows: baseRows({ rows: converted, added: w.added }), replacements: w.replacements, edits: w.edits })
      return { ...w, aiCache: new Map([...cache, ...w.aiCache]), edits: merged.edits, answers: merged.report }
    })
    // 決まった欄の外（別の列・メモ・別のシート）に記入があるか、読めなかった記入があれば、このファイルを AI に読ませられる（残りの問い合わせは画面が今の表で数える）
    const readable = outsideCells(sheets, against) > 0 || report.invalid.length > 0 || report.unreadable.length > 0
    const saved = await saving
    return { aiFailures: [...failures], forAi: readable && saved ? saved : null }
  }

  /** 記入された Excel を取り込む（チャットの📎・画面にドラッグしたファイル）。結果は報告と「問い合わせ」のタブと通知に出す */
  async function importAnswers(f: File) {
    const fail = (text: string) => {
      toast.error(text)
      note({ name: f.name, text, tone: "error" })
    }
    const against = live.current.hasTable ? live.current.shown : null
    if (!against) return fail("表がまだありません。変換が済んでから取り込んでください")
    try {
      const read = await readAnswerFile(f, against)
      if (!read) return
      if ("error" in read) return fail(read.error)
      const forAi = chatEnabled ? read.forAi : null
      const text = `顧客の回答を取り込みました（結果は「問い合わせ」の欄）${forAi ? "。色付きの欄の外の記入は、チャットの「AI で読む」で読めます" : ""}`
      toast.success(text)
      note({ name: f.name, text })
      if (forAi) setAnswerHints((hs) => [...hs.filter((h) => h.fileId !== forAi.id), { fileId: forAi.id, name: forAi.name }])
      if (read.aiFailures.length) toast.warning(`AI を使えず反映していない記入があります（${read.aiFailures.join(" / ")}）`)
    } catch (e) {
      fail(errorMessage(e, "回答のファイルを読み込めませんでした"))
    }
  }

  const proposalActions: Omit<ProposalActions, "canSend"> = {
    decide: (id, indices, d) => void decideProposal(id, indices, d),
    answer: (id, a) => updateProposal(id, (p) => answer(p, a)),
    undo: undoProposal,
    undoState,
  }

  /** CSV（控え）をダウンロードする。CP932 の検査を通した値をそのまま書き、案件のファイルに残す */
  function downloadCsv() {
    if (!output) return
    const bytes = toCsvBytes(SPEC, output)
    const name = csvFileName(SPEC, customer.name, new Date())
    saveFile(bytes, name, "text/csv")
    void keepFile("csv", new Blob([bytes as BlobPart], { type: "text/csv" }), name)
  }

  /** 最後の Excel をダウンロードする（lib/excel/final-sheet.ts。値は CSV と同じ。直して上げ直せる照合用の隠しシート付き）。案件のファイルに残す */
  async function downloadFinalExcel() {
    if (!view || !output) return
    try {
      const { finalXlsx } = await loadFinalXlsx()
      // 照合用の鍵はサーバーが案件ごとに決めたもの（Excel には書かない）
      const bytes = await finalXlsx(await finalSheet(view, { caseId: kase.id, sourceFileId: workRef.current.sourceFileId, excelKey }))
      const name = datedFileName(SPEC.fileNamePrefix, customer.name, new Date(), "xlsx")
      saveFile(bytes, name, contentTypeOf(name))
      void keepFile("final_sheet", new Blob([bytes as BlobPart], { type: contentTypeOf(name) }), name)
    } catch (e) {
      toast.error(errorMessage(e, "Excel を作れませんでした"))
    }
  }

  /** 作業の画面を開いているか（表ができてから） */
  const workShown = hasTable && (workChoice ?? wide)
  useEffect(() => {
    if (workShown && tab === "inquiry" && !inquiryHintSent.current) setInquiryHint(true)
  }, [workShown, tab])

  /** 作業の画面をそのタブで開く */
  function showTab(t: WorkTab) {
    setTab(t)
    setWorkChoice(true)
  }

  /**
   * チャットから作業のタブを開く。押したとき（click）は開く。道具の結果が届いたとき（auto）は、広い画面で職員が閉じていなければ開き、
   * 職員が閉じた・狭い画面ではタブだけ切り替える（勝手に開き直さない。返事の途中でチャットを覆わない。「表を開く」で開くとそのタブ）
   */
  function openTab(t: WorkTab, how: "auto" | "click") {
    if (how === "click" || (wide && workChoice !== false)) showTab(t)
    else setTab(t)
  }

  function onChatAction(a: ChatAction) {
    if (a === "export") setExportOpen(true)
    else showTab("inquiry")
  }

  // ---- 変換の報告（チャットの最初の返事） ----
  const sourceFile = files.find((f) => f.id === work.sourceFileId)
  const phase = reportPhase({
    aiEnabled: chatEnabled,
    loading: loadingSource,
    sourceError: sourceError?.message ?? null,
    planning,
    convertError: convertError && convertError.plan === work.plan ? convertError.message : null,
    converting: !!work.plan && (!work.converted || reconverting),
    hasTable,
    noSheetSource,
    sourceName: work.sourceFileId ? (sourceFile?.name ?? "") : null,
  })
  const sourceSheets = work.plan?.plan.sheets ?? []
  const reportNotes: ReportProps["notes"] = [
    ...(work.plan?.notice ? [{ text: work.plan.notice, tone: "warning" as const }] : []),
    // 計画が税込・税抜を決めたら聞き返さない。決めたことと直し方だけ伝える
    ...(work.taxBy === "plan" && tax !== "unknown"
      ? [{ text: `Excel の見出し・注記から、金額は${TAX_LABELS[tax]}とみなしました。違えば「7割と金額」で直してください。`, testId: "plan-tax-note" }]
      : []),
    // 使うシートのメモは報告の最初の行（どのファイルのどのシートか）と重なるので出さない
    ...(work.plan?.plan.notes ?? []).filter((n) => !n.startsWith("使うシート「")).map((text) => ({ text })),
    ...(sources && sources.duplicates > 0
      ? [{ text: `シートをまたいで同じ行が ${sources.duplicates} 件あったので、1件にまとめました。`, tone: "warning" as const, testId: "duplicate-notice" }]
      : []),
    ...(unmarked > 0 ? [{ text: `業種の記号（○）が無い ${unmarked} 行は出しません。`, testId: "unmarked-notice" }] : []),
    ...(aiNotice ? [{ text: `AI で変換できなかった値があります（${aiNotice}）。黄色のセルを確かめてください。`, tone: "warning" as const, testId: "ai-notice" }] : []),
  ]
  const questions: ReportQuestion[] =
    // まだ誰も決めていなければ聞く（計画が決めた・職員が決めたら聞かない。答えたものは答えを出す）
    hasTable && ((tax === "unknown" && work.taxBy === null) || work.reportAnswers.tax)
      ? [
          {
            id: "tax",
            text: "Excel の金額は税込ですか、税抜ですか？",
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
    // 「分からない（顧客に聞く）」も職員が決めた値（計画のし直しで上書きしない）
    const next = value === "included" || value === "excluded" ? value : "unknown"
    setWork((w) => ({ ...setTax(w, next, "staff"), reportAnswers: { ...w.reportAnswers, tax: value === "ask" ? "ask" : next } }))
  }
  const locationSites = locationSearch.sites
  const caseReport = (
    <CaseReport
      phase={phase}
      source={sourceFile ? `「${sourceFile.name}」${sourceSheets.length ? `のシート「${sourceSheets.join("」「")}」` : ""}` : null}
      planByAi={work.plan?.source === "ai"}
      notes={reportNotes}
      counts={shown && output ? { rows: shown.length, csv: output.length } : null}
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
      location={locationSites > 0 ? { open: () => showTab("location"), sites: locationSites } : null}
      onRetry={() => {
        if (phase.kind === "failed" && phase.retry === "source" && sourceError) return void openSource(sourceError.file, !work.plan)
        setConvertError(null)
        void convert()
      }}
      uploads={uploadNotes}
    />
  )
  const report = (
    <>
      {caseReport}
      <FinalImportPanel result={finalResult} view={view} proposals={excelProposals} changes={proposalChanges} actions={proposalActions} busy={savingRule} />
    </>
  )

  const chatPanel = chatEnabled ? (
    <Suspense fallback={<div className="h-full" />}>
      <ChatPanel
        caseId={kase.id}
        ready={chatReady}
        empty={files.length === 0}
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
        onOpenTab={openTab}
        work={hasTable ? { shown: workShown, open: () => setWorkChoice(true) } : null}
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
        suggestions={[
          ...(leftInquiries > 0
            ? answerHints.map((h) => ({
                id: h.fileId,
                fileName: h.name,
                text: `返ってきた記入用Excel「${h.name}」に、色付きの欄の外（別の列・メモ・別のシート）の記入や読めなかった記入があり、まだ答えの無い問い合わせが ${leftInquiries} 件あります。`,
                label: "AI で読む",
                prompt: aiAnswerPrompt(h.name),
              }))
            : []),
          ...(inquiryHint && activeInquiries > 0 && !pendingInquiryText && !work.inquiryText.questions.some((q) => q.by === "ai")
            ? [
                {
                  id: INQUIRY_SUGGESTION,
                  text: `問い合わせ ${activeInquiries} 件を、AI が顧客に伝わる質問の文とメールの下書きにできます（似た質問はまとめます）。承認した文を記入用Excelの「ご質問」の欄とメールに使います。`,
                  label: "AI で文面を作る",
                  prompt: INQUIRY_TEXT_PROMPT,
                  // 会話にもう送っていれば出さない（開き直しても）
                  once: true as const,
                },
              ]
            : []),
          ...(reviewHint && !pendingReview
            ? [
                {
                  id: REVIEW_SUGGESTION,
                  text: "案件を完了にしました。今年の指示・手直し・聞き返しの答えを AI が振り返り、来年のための顧客ルールの案（毎年の決まり）を出せます。今年だけの事情は分けて伝え、ルールには足しません。承認した項目だけ顧客ルールに足します。",
                  label: "振り返って顧客ルールの案を出す",
                  prompt: REVIEW_PROMPT,
                  // サーバーは保存した作業の変更案の状態から振り返る。会話に一度送ったら案内しない
                  needsSaved: true as const,
                  once: true as const,
                },
              ]
            : []),
        ]}
        beforeSend={settleSave}
        onSuggestionSent={(id) => {
          if (id === REVIEW_SUGGESTION) setReviewHint(false)
          else if (id === INQUIRY_SUGGESTION) {
            inquiryHintSent.current = true
            setInquiryHint(false)
          } else setAnswerHints((hs) => hs.filter((h) => h.fileId !== id))
        }}
      />
    </Suspense>
  ) : null

  /**
   * 画面のどこにドラッグしたファイルも、📎と同じくアップロードする（重ねて開いた作業の画面も同じ要素の中）。
   * 印は、画面の外へ出た（relatedTarget が画面の中でない）・離した・ドラッグをやめた（窓の外を含む）ときに必ず消す
   */
  const [dragging, setDragging] = useState(false)
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files")
  useEffect(() => {
    if (!dragging) return
    const stop = () => setDragging(false)
    const leaveWindow = (e: DragEvent) => {
      if (!e.relatedTarget) stop()
    }
    window.addEventListener("drop", stop)
    window.addEventListener("dragend", stop)
    window.addEventListener("dragleave", leaveWindow)
    return () => {
      window.removeEventListener("drop", stop)
      window.removeEventListener("dragend", stop)
      window.removeEventListener("dragleave", leaveWindow)
    }
  }, [dragging])
  const dropFiles = {
    onDragEnter: (e: React.DragEvent) => {
      if (hasFiles(e)) setDragging(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
    },
    onDragOver: (e: React.DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      if (e.dataTransfer.files.length) void attach([...e.dataTransfer.files])
    },
  }

  /** チャットに職員の答えを待つもの（承認待ちの変更案・聞き返し）。狭い画面で作業の画面を重ねて開いている間、閉じるボタンの横に出す */
  const chatPending =
    work.proposals.filter((p) => p.state === "open" && (p.origin.kind === "chat" || p.origin.kind === "excel")).length + questions.filter((q) => q.answered === null).length

  const tabBadge = (t: WorkTab) => (t === "inquiry" ? inquiries.length : t === "location" ? locationProposals.filter((p) => p.state === "open").length : 0)

  /** 作業の画面（表と、7割・問い合わせ・工事場所・一括置換のタブ）。広い画面ではチャットの右、狭い画面では上に重ねて開く */
  const workPanel =
    hasTable && output && shown ? (
      <section className="flex h-full min-h-0 flex-col bg-background" aria-label="作業の画面" data-testid="work-panel">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-xs" data-testid="case-toolbar">
          <FileChips files={files} sourceFileId={work.sourceFileId} loading={!!loadingSource || planning} onChoose={chooseSource} />
          {source && grid && plan && source.sheets.length > 1 && (
            <SheetChooser sheets={source.sheets} primary={grid} plan={plan} onPrimary={(name) => void startPlanning(source, name)} onChange={changePlan} />
          )}
          <div className="ml-auto flex items-center gap-1">
            {!wide && chatPending > 0 && (
              <Button size="sm" variant="outline" onClick={() => setWorkChoice(false)} title="チャットに答えを待つものがあります（閉じてチャットへ）" data-testid="work-chat-pending">
                <MessageSquare /> チャット
                <span className="num rounded-full bg-violet-600 px-1.5 text-xs text-white">{chatPending}</span>
              </Button>
            )}
            <Button size="sm" onClick={() => setExportOpen(true)} disabled={reconverting} data-testid="export-button">
              {errorCells ? <TriangleAlert className="text-amber-200" /> : <FileSpreadsheet />}
              書き出す（{output.length}件）
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setWorkChoice(false)} aria-label="作業の画面を閉じる" title="作業の画面を閉じる（チャットの「表を開く」で開き直せます）" data-testid="work-close">
              {wide ? <PanelRightClose /> : <X />}
            </Button>
          </div>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as WorkTab)} className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="h-10 w-full shrink-0 justify-start overflow-x-auto rounded-none border-b px-3" aria-label="作業">
            {WORK_TABS.map((t) => {
              const badge = tabBadge(t.id)
              return (
                <TabsTrigger key={t.id} value={t.id} className="flex-none px-2.5" data-testid={`tab-${t.id}`}>
                  {t.label}
                  {badge > 0 && <span className="num rounded-full bg-muted px-1.5 text-xs">{badge}</span>}
                </TabsTrigger>
              )
            })}
          </TabsList>
          <TabsContent value="table" keepMounted className="relative flex min-h-0 flex-col p-4" data-testid="table-section">
            {reconverting && (
              <div className="absolute inset-0 z-30 flex items-start justify-center bg-background/60 pt-24 backdrop-blur-[1px]" data-testid="reconverting">
                <span className="flex items-center gap-2 rounded-full border bg-background px-4 py-2 text-sm shadow-sm">
                  <Loader2 className="size-4 animate-spin text-violet-600" /> 列の対応を変えたので変換し直しています…
                </span>
              </div>
            )}
            {output.length === 0 && (
              <p className="mb-3 text-sm text-muted-foreground" data-testid="no-rows-note">
                載せる行がありません
              </p>
            )}
            <PreviewTable
              spec={SPEC}
              rows={shown}
              inclusion={inclusion}
              openEditor={(cell) => editSession(cell, letters)}
              onEdit={edit}
              onToggle={(key, included) => update("manual", (prev) => new Map(prev).set(key, included))}
              filter={tableFilter}
              onFilterChange={setFilter}
              checks={rowChecks}
              counts={filterCounts!}
            />
          </TabsContent>
          <TabsContent value="selection" keepMounted className="min-h-0 overflow-auto p-4">
            <SelectionPanel
              rounding={rounding}
              onRounding={(r) => set("rounding", r)}
              tax={tax}
              onTax={(t) => setWork((w) => setTax(w, t, "staff"))}
              rule7Tax={rule7Tax}
              onRule7Tax={(t) => set("rule7Tax", t)}
              selection={selectionMode}
              onSelection={(m) => set("selection", m)}
              manualCount={manual.size}
              onClearManual={() => set("manual", new Map())}
              roundingTotals={roundingTotals}
            >
              <GyoshuSummaryTable summary={summary} basis={basis} rule7Tax={rule7Tax} onBasisChange={(code, side, v) => update("basis", (prev) => ({ ...prev, [code]: { ...prev[code], [side]: v } }))} />
            </SelectionPanel>
          </TabsContent>
          <TabsContent value="inquiry" keepMounted className="min-h-0 overflow-auto px-4 pt-2 pb-4">
            <InquiryPanel
              inquiries={inquiries}
              outputRows={output}
              allRows={shown}
              customer={customer.name}
              dismissed={dismissed}
              answers={answers}
              text={work.inquiryText}
              onText={(next) => update("inquiryText", next)}
              keepFile={(name, bytes, type) => void keepFile("inquiry_sheet", new Blob([bytes as BlobPart], { type }), name)}
              onToggle={(key, ask) =>
                update("dismissed", (prev) => {
                  const next = new Set(prev)
                  if (ask) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
            />
          </TabsContent>
          <TabsContent value="location" keepMounted className="min-h-0 overflow-auto p-4">
            {view && <LocationPanel search={locationSearch} view={view} proposals={locationProposals} changes={proposalChanges} actions={proposalActions} busy={savingRule} fx={fx} />}
          </TabsContent>
          <TabsContent value="replace" keepMounted className="min-h-0 overflow-auto p-4" data-testid="replace-details">
            <ReplacePanel spec={SPEC} rows={rows!} letters={letters} replacements={replacements} onChange={replace} />
          </TabsContent>
        </Tabs>
      </section>
    ) : null
  /** 作業の画面をチャットの横に並べるか（狭い画面では重ねて開く） */
  const workInline = wide && workShown && !!workPanel
  /** 狭い画面で作業の画面を重ねて開いているか（開いている間はうしろのチャットと見出しを触れなくする） */
  const workOverlay = !wide && workShown && !!workPanel
  /** 重ねて開いたときは作業の画面へ、閉じたら開く前の場所へフォーカスを戻す */
  const workFrame = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!workOverlay) return
    const before = document.activeElement as HTMLElement | null
    workFrame.current?.focus()
    return () => before?.focus()
  }, [workOverlay])
  const noChatInput = useRef<HTMLInputElement>(null)

  return (
    <AppShell fill>
      <div className="relative flex min-h-0 flex-1 flex-col" {...dropFiles}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 sm:px-6" inert={workOverlay}>
          <div className="min-w-0">
            <nav className="flex gap-1 text-xs text-muted-foreground">
              <Link to="/" className="hover:underline">
                顧客
              </Link>
              <span>/</span>
              <Link to="/customers/$customerId" params={{ customerId: customer.id }} className="truncate hover:underline">
                {customer.name}
              </Link>
            </nav>
            <h1 className="truncate text-lg font-semibold tracking-tight">{`${customer.name} ${kase.fiscalYear}年度`}</h1>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <SaveIndicator status={saveStatus} />
            <Segmented label="案件の状態" value={status} options={CASE_STATUSES.map((s) => ({ value: s, label: CASE_STATUS_LABELS[s] }))} onChange={(s) => void changeStatus(s)} testId="case-status" />
            <CaseMenu usd={costUsd} fx={fx} onDelete={() => setDeleteOpen(true)} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className={cn("min-h-0 min-w-0", workInline ? "w-[400px] shrink-0 border-r 2xl:w-[440px]" : "mx-auto w-full max-w-3xl xl:border-x")} inert={workOverlay} data-testid="chat-column">
            {chatPanel ?? (
              // チャットが使えない（APIキーが無い）ときは、報告と📎と同じアップロードの入口をチャットの代わりに出す
              <div className="grid h-full content-start gap-3 overflow-auto p-4">
                {report}
                <Button size="sm" className="w-fit" onClick={() => noChatInput.current?.click()} data-testid="chat-attach">
                  <Paperclip /> アップロード
                </Button>
                <input
                  ref={noChatInput}
                  type="file"
                  multiple
                  accept={ATTACH_ACCEPT}
                  className="sr-only"
                  data-testid="chat-file-input"
                  onChange={(e) => {
                    if (e.target.files?.length) void attach([...e.target.files])
                    e.target.value = ""
                  }}
                />
              </div>
            )}
          </div>
          {/*
            作業の画面は表がある間ずっと置いたまま、閉じても隠すだけにする（表の検索・並べ替え・表示する列・工事場所の調査・置換の欄を消さない）。
            広い画面ではチャットの右、狭い画面では画面の上に重ねる。幅が変わっても同じ要素のまま
          */}
          {workPanel && (
            <div
              ref={workFrame}
              hidden={!workShown}
              tabIndex={-1}
              className={cn("min-h-0 min-w-0 outline-none", wide ? "flex-1" : "fixed inset-0 z-50 bg-background shadow-xl")}
              {...(wide ? {} : { role: "dialog", "aria-modal": true, "aria-label": "作業の画面" })}
              onKeyDown={(e) => {
                // 重ねて開いたときの Escape で閉じる。中の欄が済ませた Escape（セルの手直しをやめるなど。preventDefault の印）と、
                // 画面の外に開いたメニューの Escape は見送る
                if (wide || e.key !== "Escape" || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return
                setWorkChoice(false)
              }}
              data-testid="work-frame"
            >
              {workPanel}
            </div>
          )}
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400 bg-violet-50/70 text-sm font-medium text-violet-800 dark:bg-violet-950/60 dark:text-violet-200" data-testid="drop-overlay">
            <FileUp className="mr-2 size-5" /> 離すとアップロードします
          </div>
        )}
      </div>

      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={{ caseId: kase.id }}
        title={`${kase.fiscalYear}年度の案件`}
        customerName={customer.name}
        onDeleted={() => router.navigate({ to: "/customers/$customerId", params: { customerId: customer.id } })}
      />

      {output && (
        <ExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          output={output}
          summary={summary}
          basis={basis}
          rule7Tax={rule7Tax}
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
              今の変換の結果と手直しは消えます（設定は残ります）。参考に付けるだけなら「付けるだけ」。
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

/** 7割と金額の設定（Excel の金額が税込か・端数・載せる工事）と業種ごとの件数と7割 */
function SelectionPanel(p: {
  rounding: Rounding
  onRounding: (r: Rounding) => void
  tax: TaxMode
  onTax: (t: TaxMode) => void
  rule7Tax: Rule7Tax
  onRule7Tax: (t: Rule7Tax) => void
  selection: CaseWork["selection"]
  onSelection: (m: CaseWork["selection"]) => void
  manualCount: number
  onClearManual: () => void
  roundingTotals: { floor: number; round: number } | null
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Excel の金額" hint="顧客の Excel の金額が税込か税抜か。7割の計算と違えば 1.1 で掛け割りして比べます（金額は変えません）">
          <Segmented label="Excel の金額" value={p.tax} options={(Object.keys(TAX_LABELS) as TaxMode[]).map((v) => ({ value: v, label: TAX_LABELS[v] }))} onChange={p.onTax} testId="tax" />
        </Field>
        <Field label="7割の計算" hint="決算書の完成工事高（基準額）が税抜か税込か。初期値は全体ルールの画面の設定">
          <Segmented label="7割の計算" value={p.rule7Tax} options={(Object.keys(RULE7_TAX_LABELS) as Rule7Tax[]).map((v) => ({ value: v, label: RULE7_TAX_LABELS[v] }))} onChange={p.onRule7Tax} testId="rule7-tax" />
        </Field>
        <Field label="千円未満">
          <Segmented label="千円未満の端数" value={p.rounding} options={[{ value: "floor", label: "切り捨て" }, { value: "round", label: "四捨五入" }]} onChange={p.onRounding} testId="rounding" />
        </Field>
        <Field label="載せる工事" hint="全件: 7割以上なら件数は自由。顧客が絞ったデータもこちら">
          <Segmented label="載せる工事" value={p.selection} options={SELECTION_MODES.map((m) => ({ value: m, label: SELECTION_LABELS[m] }))} onChange={p.onSelection} testId="selection" />
        </Field>
        {p.manualCount > 0 && (
          <Button variant="outline" size="sm" onClick={p.onClearManual}>
            手動の入れ外し（{p.manualCount}件）を戻す
          </Button>
        )}
      </div>
      {p.roundingTotals && <RoundingNote floor={p.roundingTotals.floor} round={p.roundingTotals.round} current={p.rounding} />}
      {p.children}
      <p className="text-xs text-muted-foreground" title="業種ごとに、元請を金額の大きい順に元請の基準額の7割を超えるまで、続いて残りを合計の基準額の7割を超えるまで載せます。軽微な工事（税込500万円未満、建築一式は1,500万円未満）は10件まで">
        基準額は決算書の業種ごとの完成工事高（{RULE7_TAX_LABELS[p.rule7Tax]}・千円）。空欄なら行の合計。
        {p.tax === "unknown" && <strong data-testid="tax-unknown-note"> Excel の金額が分からないので、税込とみなして判定しています。</strong>}
      </p>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5" title={hint}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/**
 * 見出しの「…」: 案件の AI の費用の合計と削除。費用が10ドルを超えたら、ボタンにも注意を出す（止めない）
 */
function CaseMenu({ usd, fx, onDelete }: { usd: number; fx: UsdJpy | null; onDelete: () => void }) {
  const over = usd > CASE_COST_NOTICE_USD
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label="案件のメニュー" title={over ? `この案件の AI の費用が ${CASE_COST_NOTICE_USD} ドルを超えました` : "案件のメニュー"} data-testid="case-menu" data-over={over || undefined} />}
      >
        {over ? <TriangleAlert className="text-amber-600" /> : <Ellipsis />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className={over ? "font-medium text-amber-700" : undefined} data-testid="case-cost" data-over={over || undefined}>
            この案件の AI の費用 <Cost usd={usd} fx={fx} />
            {over && <span className="block">{CASE_COST_NOTICE_USD} ドルを超えました（止めません）</span>}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete} data-testid="delete-button">
          <Trash2 /> 案件を削除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  // 保存できているあいだは目立たせない（読み上げには伝える）。保存できないときだけ目立たせる
  const quiet = status.kind === "saved" || status.kind === "pending"
  return (
    <span role="status" className={quiet ? "sr-only" : "basis-full text-xs font-medium text-red-700"} data-testid="save-status" data-status={status.kind}>
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

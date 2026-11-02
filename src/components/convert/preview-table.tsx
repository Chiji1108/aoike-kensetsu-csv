import { useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  columnVisibilityFeature,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Columns3, ListChecks, MapPin, MessageCircleQuestion, RefreshCw, Search, Undo2, X } from "lucide-react"
import { Segmented } from "@/components/segmented"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { CellEdit, CellResult, EditSession, RowResult } from "@/lib/convert/convert"
import { INCLUSION_LABELS, type Inclusion } from "@/lib/convert/koji-selection"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import type { CsvSpec } from "@/lib/spec/types"
import { cn } from "@/lib/utils"
import { choiceLabel, choicesOf } from "@/lib/spec/choices"
import { CellPicker } from "./cell-picker"
import {
  CONFIRM_LABEL,
  FIX_ACTIONS,
  FIX_KINDS,
  FIX_LABELS,
  NO_FIX,
  ROW_FILTERS,
  STATUS,
  askText,
  cellClass,
  changedCell,
  fixActionGroups,
  fixActionText,
  fixText,
  inFilter,
  type FixActionId,
  type FixCounts,
  type RowFix,
  type TableFilter,
} from "./status"

type Row = RowResult<KojiFieldId>

const features = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
})
const columnHelper = createColumnHelper<typeof features, Row>()

/**
 * 列の幅（px）。表に出す行だけで列の幅が決まると、スクロールで幅が揺れるので固定する。
 * 「載せる」と「元の行」の列もここで持つ
 */
const WIDTH: Record<KojiFieldId | "include" | "origin", number> = {
  include: 156,
  origin: 84,
  gyoshu: 100,
  client: 170,
  motoukeShitauke: 92,
  jv: 44,
  workName: 240,
  prefecture: 80,
  place: 140,
  engineer: 104,
  amount: 92,
  specialAmount: 108,
  startYm: 80,
  endYm: 80,
  chiefEngineer: 104,
  supervisingEngineer: 104,
}

/** 手直し中のセル。下書きは行の外に持つ（仮想スクロールで行が消えても残る） */
type Editing = { row: string; field: KojiFieldId; session: EditSession; draft: string }

/** 注意書きを出すセル（選んだ・マウスを乗せたセル）。via は選んだ（フォーカス・手直し）かマウスを乗せただけか */
type Active = { row: string; field: KojiFieldId; via: "focus" | "hover" }

const NOTE_ID = "preview-cell-note"

/**
 * 注意書きを出すセルの小さな store。表の state に持つとマウスを動かすたびに表全体を描き直すので、
 * 注意書きの1行と、選んだかが変わったセルだけが読む
 */
function activeStore() {
  let active: Active | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => active,
    set(next: Active) {
      if (active && active.row === next.row && active.field === next.field && active.via === next.via) return
      active = next
      for (const l of listeners) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}
type ActiveStore = ReturnType<typeof activeStore>

/** 絞り込みを比べる鍵（止めた並びがどの絞り込みのものか） */
const filterKey = (f: TableFilter) => `${f.kind}|${f.reason ?? ""}|${f.ask ?? ""}`

const originText = (r: Row) => `${r.sheet}!${r.row + 1}`

/** 行の理由として見せる数（残りは「他 N」。全部はツールチップ） */
const SHOWN_FIXES = 2

/** 計画の聞き返しの対象の行（表で見る） */
export type AskRows = { id: string; label: string; keys: ReadonlySet<string> }

export const ACTION_ICONS: Record<FixActionId, React.ReactNode> = { decideGyoshu: <ListChecks />, findLocation: <MapPin />, askCustomer: <MessageCircleQuestion /> }

export function PreviewTable({
  spec,
  rows,
  inclusion,
  openEditor,
  onEdit,
  onToggle,
  filter,
  onFilterChange,
  fixes,
  counts,
  asks,
  onOpenInquiry,
  onFixAction,
  onConfirm,
  confirmUndo,
}: {
  spec: CsvSpec<KojiFieldId>
  rows: Row[]
  inclusion: ReadonlyMap<string, Inclusion>
  /** 手直しを始める（直す元の文字列は個人名の記号を「〔Ａ〕」の形で出し、確定した文字列は同じ記号の表で読む） */
  openEditor: (cell: CellResult) => EditSession
  /** 手直し（主任技術者・監理技術者の欄は2列を一緒に決める） */
  onEdit: (rowKey: string, edits: readonly [KojiFieldId, CellEdit][]) => void
  onToggle: (rowKey: string, included: boolean) => void
  /** 絞り込み（案件の画面が持つ。次にやること・報告の聞き返しの「表で見る」を押しても変わる） */
  filter: TableFilter
  onFilterChange: (f: TableFilter) => void
  /** 行の片付けること（rowFix）と、直す行の数（countFixes）。案件の画面が1回だけ数えて渡す */
  fixes: ReadonlyMap<string, RowFix<KojiFieldId>>
  counts: FixCounts
  /** 計画の聞き返しの対象の行（filter.ask で絞る） */
  asks: readonly AskRows[]
  /** 問い合わせのタブを開く（顧客に聞く行から） */
  onOpenInquiry: () => void
  /** 直し方の操作を押したとき（keys はその行） */
  onFixAction: (action: FixActionId, keys: readonly string[]) => void
  /** 「これでよい」: 要確認・AI の推定の値を、職員が確かめた値にする（取り消せる） */
  onConfirm: (rowKey: string, field: KojiFieldId) => void
  /** 直前の「これでよい」を取り消す（取り消せるときだけ） */
  confirmUndo: (() => void) | null
}) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const setFilter = onFilterChange
  const [query, setQuery] = useState("")
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({})
  /**
   * 手直しを始めたときの表示の行（キーの並び）。手直しで行が絞り込みから外れたり並べ替えで動いたりしても、
   * 絞り込み・並べ替え・検索を変えるか「更新」を押すまではこの並びのまま出す
   */
  const [pinned, setPinned] = useState<readonly string[] | null>(null)
  const unpin = () => setPinned(null)
  // 絞り込みが変わったら（表の上でも、次にやること・「表で見る」など外からでも）止めた並びを捨てる（描くときに1か所で）
  const [pinnedFilter, setPinnedFilter] = useState(filterKey(filter))
  if (pinnedFilter !== filterKey(filter)) {
    setPinnedFilter(filterKey(filter))
    setPinned(null)
  }

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({ id: "include", header: "載せる", enableHiding: false }),
        columnHelper.accessor(originText, { id: "origin", header: "元の行", sortFn: "alphanumeric" }),
        ...spec.fields.map((f) =>
          // CSV の列（A〜N）との対応は見出しのツールチップに出す
          columnHelper.accessor((r) => r.cells[f.id].value, { id: f.id, header: f.label, sortFn: "alphanumeric" }),
        ),
      ]),
    [spec],
  )
  const store = useRef<ActiveStore | null>(null)
  store.current ??= activeStore()

  const needle = query.trim().toLowerCase()
  const data = useMemo(() => {
    const visible = (id: string) => columnVisibility[id] !== false
    const searched = spec.fields.filter((f) => visible(f.id))
    // 決まった値の項目は表に出す名前（「電気」など）でも探せる
    const hasText = (r: Row) =>
      (visible("origin") && originText(r).toLowerCase().includes(needle)) ||
      searched.some((f) => r.cells[f.id].value.toLowerCase().includes(needle) || (choiceLabel(f, r.cells[f.id].value)?.toLowerCase().includes(needle) ?? false))
    const ask = asks.find((a) => a.id === filter.ask)
    const asked = (key: string) => ask?.keys.has(key) ?? false
    return rows.filter((r) => inFilter(filter, fixes.get(r.key) ?? NO_FIX, inclusion.get(r.key)?.included ?? false, asked, r.key) && (!needle || hasText(r)))
  }, [rows, fixes, inclusion, filter, asks, needle, columnVisibility, spec])
  const activeAsk = asks.find((a) => a.id === filter.ask)
  /** まとめて頼める直し方: 今の絞り込み（理由・検索）で見えている行だけ（件数もその行で） */
  const fixGroups = useMemo(() => (filter.kind === "fix" && !filter.ask ? fixActionGroups(data, inclusion, fixes, filter.reason) : []), [data, inclusion, fixes, filter])

  const table = useTable({
    features,
    data,
    columns,
    getRowId: (r) => r.key,
    onSortingChange: (updater) => {
      unpin()
      setSorting(updater)
    },
    onColumnVisibilityChange: setColumnVisibility,
    state: { sorting, columnVisibility },
  })
  const live = table.getRowModel().rows.map((r) => r.original)
  const liveKeys = new Set(live.map((r) => r.key))
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])
  const shown = pinned ? pinned.flatMap((k) => byKey.get(k) ?? []) : live
  const outdated = pinned !== null && (shown.length !== live.length || shown.some((r, i) => r.key !== live[i]!.key))
  const visibleColumns = table.getVisibleLeafColumns()

  function startEdit(r: Row, field: KojiFieldId) {
    if (editing) finishEdit(true)
    setPinned((p) => p ?? live.map((r) => r.key))
    store.current!.set({ row: r.key, field, via: "focus" })
    const session = openEditor(r.cells[field])
    setEditing({ row: r.key, field, session, draft: session.text })
  }
  function finishEdit(commit: boolean) {
    if (!editing) return
    setEditing(null)
    if (commit && editing.draft !== editing.session.text) onEdit(editing.row, [[editing.field, editing.session.read(editing.draft)]])
  }
  /** 選ぶ欄で選んだ値を入れる（変わった項目だけ）。閉じたらセルに戻る（キーボードで続けて動ける） */
  /** restoreFocus は選んだ・Escape で閉じたとき（外を押して閉じたときは、押した先のフォーカスを奪わない） */
  function finishPick(r: Row, picked: Partial<Record<KojiFieldId, string>> | undefined, restoreFocus: boolean) {
    if (!editing) return
    const { row, field, session } = editing
    setEditing(null)
    const changed = Object.entries(picked ?? {}).filter(([f, v]) => r.cells[f as KojiFieldId].value !== v) as [KojiFieldId, string][]
    if (changed.length) onEdit(row, changed.map(([f, v]) => [f, session.read(v)]))
    if (restoreFocus) requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`tr[data-row-key="${CSS.escape(row)}"] td[data-field="${field}"] button`)?.focus())
  }
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  /** 項目ごとの定義と選ぶ欄（描くたびに作らない） */
  const fieldInfo = useMemo(() => new Map(spec.fields.map((f) => [f.id, { spec: f, choices: choicesOf(f) }])), [spec])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 12,
    getItemKey: (i) => shown[i]!.key,
  })
  const items = virtualizer.getVirtualItems()
  const padTop = items[0]?.start ?? 0
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)

  function renderCell(r: Row, columnId: string) {
    if (columnId === "include") {
      const inc = inclusion.get(r.key)
      return (
        <TableCell key={columnId} className="sticky left-0 z-10 border-b bg-card px-2 py-1.5">
          <label className="flex items-center gap-1.5 whitespace-nowrap" title={r.excluded}>
            <Checkbox aria-label="CSVに載せる" checked={inc?.included ?? false} onCheckedChange={(checked) => onToggle(r.key, checked)} />
            <span className="text-[11px] text-muted-foreground">{inc ? INCLUSION_LABELS[inc.reason] : ""}</span>
          </label>
          {inc?.included && <RowReasons fix={fixes.get(r.key) ?? NO_FIX} onOpenInquiry={onOpenInquiry} onFixAction={(a) => onFixAction(a, [r.key])} onConfirm={(f) => onConfirm(r.key, f)} />}
          {!liveKeys.has(r.key) && (
            <span className="mt-0.5 block text-[11px] text-amber-700" data-testid="row-unmatched" title="手直しで、今の絞り込み・検索に合わなくなりました。「更新」で表から外れます">
              条件に合いません
            </span>
          )}
        </TableCell>
      )
    }
    if (columnId === "origin") {
      return (
        <TableCell key={columnId} className="num border-b px-2 py-1.5 text-muted-foreground">
          {originText(r)}
        </TableCell>
      )
    }
    const field = columnId as KojiFieldId
    const cell = r.cells[field]
    const isEditing = editing?.row === r.key && editing.field === field
    const { spec: spec_, choices } = fieldInfo.get(field)!
    const named = choiceLabel(spec_, cell.value)
    return (
      <TableCell
        key={columnId}
        className={cn("border-b border-l p-0 align-top whitespace-normal", cellClass(cell))}
        data-field={field}
        data-status={cell.status}
        data-changed={changedCell(cell) ? "1" : undefined}
      >
        {isEditing && choices ? (
          <>
            <div ref={setAnchor} className="min-h-8 px-2 py-1.5 ring-2 ring-ring ring-inset">
              <CellValue value={cell.value} named={named} code={choices.kind === "codes" && choices.set !== "flag"} />
            </div>
            <CellPicker
              anchor={anchor}
              field={field}
              label={choices.kind === "engineerRole" ? "配置技術者の立場" : spec_.label}
              choices={choices}
              values={Object.fromEntries(spec.fields.map((f) => [f.id, r.cells[f.id].value])) as Record<KojiFieldId, string>}
              onPick={(picked) => finishPick(r, picked, true)}
              onCancel={(restore) => finishPick(r, undefined, restore)}
            />
          </>
        ) : isEditing ? (
          <CellEditor value={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} onDone={finishEdit} />
        ) : (
          // 注意書きはセルの下に出さない（色で状態は分かる）。選んだ・マウスを乗せたセルのものを表の上の1行に出す（キーボードで選んでも出る）
          <CellButton store={store.current!} row={r.key} field={field} message={cell.message} onClick={() => startEdit(r, field)} hasPopup={!!choices}>
            <CellValue value={cell.value} named={named} code={choices?.kind === "codes" && choices.set !== "flag"} />
          </CellButton>
        )}
      </TableCell>
    )
  }

  const tableWidth = visibleColumns.reduce((s, c) => s + WIDTH[c.id as keyof typeof WIDTH], 0)

  // 置かれた欄の高さに合わせ、表の中だけをスクロールする（作業の画面の「表」のタブ）
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="表の絞り込み"
          value={filter.kind}
          options={(["fix", "all"] as const).map((f) => ({ value: f, label: `${ROW_FILTERS[f].label} ${f === "fix" ? counts.rows : counts.all}` }))}
          onChange={(kind) => setFilter({ kind })}
          testId="row-filters"
        />
        {activeAsk ? (
          <span className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 py-0.5 pr-1 pl-2.5 text-xs text-amber-900" data-testid="ask-filter" data-ask={activeAsk.id}>
            {activeAsk.label}（{activeAsk.keys.size}行）
            <Button size="icon-xs" variant="ghost" className="size-5" aria-label="聞き返しの絞り込みを外す" onClick={() => setFilter({ kind: "all" })}>
              <X />
            </Button>
          </span>
        ) : (
          filter.kind === "fix" &&
          counts.rows > 0 && (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="直す理由" data-testid="fix-reasons">
              {FIX_KINDS.filter((k) => counts.byKind[k] > 0).map((k) => (
                <Button
                  key={k}
                  size="xs"
                  variant={filter.reason === k ? "default" : "outline"}
                  aria-pressed={filter.reason === k}
                  onClick={() => setFilter(filter.reason === k ? { kind: "fix" } : { kind: "fix", reason: k })}
                  data-testid={`fix-reason-${k}`}
                >
                  {FIX_LABELS[k]} <span className="num">{counts.byKind[k]}</span>
                </Button>
              ))}
            </div>
          )
        )}
        <div className="relative w-44 sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="表の中を検索"
            placeholder="表の中を検索"
            className="pl-7"
            value={query}
            onChange={(e) => {
              unpin()
              setQuery(e.target.value)
            }}
          />
        </div>
        {sorting.length > 0 && <span className="text-xs text-muted-foreground">並べ替えは表示だけ</span>}
        {outdated && (
          <span className="flex items-center gap-1.5 text-xs text-amber-700" data-testid="outdated">
            手直しのあと止めています
            <Button size="sm" variant="outline" onClick={unpin}>
              <RefreshCw />
              更新
            </Button>
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="表示する列" title="表示する列" />}>
            <Columns3 />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel>表示する列</DropdownMenuLabel>
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(v)}>
                    {columnLabel(spec, c.id)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {filter.kind === "fix" && !activeAsk && (fixGroups.length > 0 || confirmUndo) && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="まとめて直す" data-testid="fix-actions">
          {fixGroups.map((g) => (
            <Button
              key={`${g.action}:${g.field}`}
              size="xs"
              variant="outline"
              className="bg-background"
              title={FIX_ACTIONS[g.action].title}
              onClick={() => onFixAction(g.action, g.keys)}
              data-testid="fix-action"
              data-action={g.action}
            >
              {ACTION_ICONS[g.action]}
              {fixActionText(g)}
            </Button>
          ))}
          {confirmUndo && (
            <Button size="xs" variant="ghost" onClick={confirmUndo} data-testid="confirm-undo">
              <Undo2 />「{CONFIRM_LABEL}」を取り消す
            </Button>
          )}
        </div>
      )}

      <CellNote spec={spec} store={store.current!} byKey={byKey} />

      <div ref={scrollRef} className="min-h-0 overflow-auto rounded-xl border bg-card">
        <table
          data-slot="table"
          data-testid="preview-table"
          className="w-full table-fixed border-separate border-spacing-0 text-xs"
          style={{ minWidth: tableWidth }}
        >
          <colgroup>
            {visibleColumns.map((c) => (
              <col key={c.id} style={{ width: WIDTH[c.id as keyof typeof WIDTH] }} />
            ))}
          </colgroup>
          <TableHeader className="sticky top-0 z-20 bg-muted">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted()
                  return (
                    <TableHead
                      key={h.id}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className={cn(
                        "h-auto border-b bg-muted px-2 py-2 align-bottom text-xs whitespace-normal text-muted-foreground",
                        h.column.id === "include" && "sticky left-0 z-30",
                      )}
                    >
                      {h.column.getCanSort() ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={<button type="button" className="inline-flex items-end gap-1 text-left font-medium hover:text-foreground" onClick={h.column.getToggleSortingHandler()} />}
                          >
                            <span>
                              <table.FlexRender header={h} />
                            </span>
                            {sorted === "asc" ? <ArrowUp className="size-3 shrink-0" /> : sorted === "desc" ? <ArrowDown className="size-3 shrink-0" /> : <ArrowUpDown className="size-3 shrink-0 opacity-40" />}
                          </TooltipTrigger>
                          <TooltipContent>{columnTip(spec, h.column.id)}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <table.FlexRender header={h} />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
            {items.map((vi) => {
              const r = shown[vi.index]!
              const included = inclusion.get(r.key)?.included ?? false
              return (
                <TableRow
                  key={r.key}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  data-row-key={r.key}
                  data-included={included ? "1" : "0"}
                  className={cn("border-0", !included && "opacity-45")}
                >
                  {visibleColumns.map((c) => renderCell(r, c.id))}
                </TableRow>
              )
            })}
            {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={visibleColumns.length} className="h-20 text-center text-muted-foreground" data-testid="no-match">
                  {needle ? `「${query.trim()}」を含む${ROW_FILTERS[filter.kind].empty}` : ROW_FILTERS[filter.kind].empty}はありません
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </table>
      </div>
    </div>
  )
}

/**
 * 載せる行の、片付けることの理由（例:「業種が空」「工事名: AI の推定」）と、その理由の直し方（status.ts の FIX_ACTIONS）。業種は「業種を決める」（業種のタブ）。
 * 要確認・AI の推定の値は「これでよい」でそのまま確かめた値にできる。顧客に聞くセルは直さなくてよいので、どの欄を聞くのかと問い合わせのタブへの道だけ出す
 */
function RowReasons({ fix, onOpenInquiry, onFixAction, onConfirm }: { fix: RowFix<KojiFieldId>; onOpenInquiry: () => void; onFixAction: (a: FixActionId) => void; onConfirm: (field: KojiFieldId) => void }) {
  if (!fix.fixes.length && !fix.ask.length && !fix.gyoshu) return null
  const shown = fix.fixes.slice(0, SHOWN_FIXES)
  const rest = fix.fixes.length - shown.length
  // 同じ直し方は1つだけ出す（例: 都道府県と場所名が空でも「AI で案を出す」は1つ）
  const actions = [...new Set(fix.fixes.flatMap((f) => f.action ?? []))]
  const link = "inline-flex items-center gap-0.5 underline-offset-2 hover:underline [&_svg]:size-3"
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 whitespace-normal" data-testid="row-reasons">
      {/* 業種は直すに数えず、業種のタブでまとめて決める（決めるたびに7割で載せる行が入れ替わる） */}
      {fix.gyoshu && (
        <span className="inline-flex flex-wrap items-center gap-x-1">
          <span className="text-amber-800" data-testid="row-fix" data-field="gyoshu">
            {fixText({ field: "gyoshu", kind: fix.gyoshu })}
          </span>
          <button type="button" className={cn(link, "text-violet-700")} title={FIX_ACTIONS.decideGyoshu.title} onClick={() => onFixAction("decideGyoshu")} data-testid="row-fix-action" data-action="decideGyoshu">
            {ACTION_ICONS.decideGyoshu}
            {FIX_ACTIONS.decideGyoshu.label}
          </button>
        </span>
      )}
      {shown.map((f) => (
        <span key={f.field} className="inline-flex flex-wrap items-center gap-x-1">
          <span className="text-amber-800" title={fix.fixes.map(fixText).join("\n")} data-testid="row-fix" data-field={f.field}>
            {fixText(f)}
          </span>
          {f.confirm && (
            <button type="button" className={cn(link, "text-emerald-700")} title="この値のまま、職員が確かめた値にします" onClick={() => onConfirm(f.field)} data-testid="row-confirm" data-field={f.field}>
              <Check />
              {CONFIRM_LABEL}
            </button>
          )}
        </span>
      ))}
      {rest > 0 && (
        <span className="text-amber-800" title={fix.fixes.map(fixText).join("\n")}>
          他{rest}
        </span>
      )}
      {actions.map((a) => (
        <button key={a} type="button" className={cn(link, "text-violet-700")} title={FIX_ACTIONS[a].title} onClick={() => onFixAction(a)} data-testid="row-fix-action" data-action={a}>
          {ACTION_ICONS[a]}
          {FIX_ACTIONS[a].label}
        </button>
      ))}
      {fix.ask.length > 0 && (
        <button type="button" className={cn(link, "text-muted-foreground")} title="顧客への問い合わせに入っています（直さなくてよい）。問い合わせのタブを開きます" onClick={onOpenInquiry} data-testid="row-ask">
          <MessageCircleQuestion />
          {askText(fix.ask)}
        </button>
      )}
    </div>
  )
}

/** セルの値。決まった値の項目は名前で出す（業種・元請下請はコードも小さく添える。CSV にはコードが入る） */
function CellValue({ value, named, code }: { value: string; named: string | undefined; code: boolean }) {
  if (!value) return <span className="text-muted-foreground/50">—</span>
  if (!named) return <span className="whitespace-pre-wrap">{value}</span>
  return (
    <span data-code={value}>
      {code && <span className="num mr-1 text-[10px] text-muted-foreground">{value}</span>}
      {named}
    </span>
  )
}

function columnLabel(spec: CsvSpec<KojiFieldId>, id: string) {
  const f = spec.fields.find((f) => f.id === id)
  return f ? f.label : "元の行"
}

function columnTip(spec: CsvSpec<KojiFieldId>, id: string) {
  const f = spec.fields.find((f) => f.id === id)
  return f ? `CSV の ${f.letter} 列` : "元の Excel のシートと行"
}

/**
 * セルのボタン。選んだ（フォーカスした）ときだけ注意書きの1行を説明につなぐ（読み上げはフォーカスのときだけ。マウスを乗せただけでは読み上げない）。
 * store を読むのはこのボタンだけなので、選んだセルが変わっても表全体は描き直さない
 */
function CellButton({ store, row, field, message, onClick, hasPopup, children }: { store: ActiveStore; row: string; field: KojiFieldId; message?: string; onClick: () => void; hasPopup?: boolean; children: React.ReactNode }) {
  const focused = useSyncExternalStore(store.subscribe, () => {
    const a = store.get()
    return a?.row === row && a.field === field && a.via === "focus"
  }, () => false)
  return (
    <button
      type="button"
      className="block min-h-8 w-full px-2 py-1.5 text-left break-words hover:ring-1 hover:ring-ring/40 hover:ring-inset"
      title={message}
      aria-describedby={focused ? NOTE_ID : undefined}
      aria-haspopup={hasPopup ? "dialog" : undefined}
      onFocus={() => store.set({ row, field, via: "focus" })}
      onMouseEnter={() => store.set({ row, field, via: "hover" })}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** 選んだ・マウスを乗せたセルの状態と注意書き（高さは1行に決めて、出し入れで表が動かないようにする。読み上げは選んだセルの説明として） */
function CellNote({ spec, store, byKey }: { spec: CsvSpec<KojiFieldId>; store: ActiveStore; byKey: ReadonlyMap<string, Row> }) {
  const active = useSyncExternalStore(store.subscribe, store.get, () => null)
  const row = active ? byKey.get(active.row) : undefined
  const field = active?.field
  const cell = row && field ? row.cells[field] : undefined
  const label = field ? spec.fields.find((f) => f.id === field)?.label : undefined
  return (
    <p id={NOTE_ID} className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="cell-note" data-status={cell?.status}>
      {cell ? (
        <>
          <span className={cn("size-2 shrink-0 rounded-full", STATUS[cell.status].dot)} />
          <span className="shrink-0 font-medium text-foreground">
            {label}（{originText(row!)}）
          </span>
          <span className="truncate" title={[cell.message, `元: ${cell.source}`].filter(Boolean).join("\n")}>
            {STATUS[cell.status].label}
            {cell.message ? `: ${cell.message}` : `（元: ${cell.source || "空"}）`}
          </span>
        </>
      ) : (
        "色のセルを選ぶと、理由をここに出します"
      )}
    </p>
  )
}

/** 下書き（value）は PreviewTable が持つ。onDone(true) で確定、onDone(false) で取り消し */
function CellEditor({ value, onChange, onDone }: { value: string; onChange: (v: string) => void; onDone: (commit: boolean) => void }) {
  const finished = useRef(false)
  const finish = (commit: boolean) => {
    if (finished.current) return
    finished.current = true
    onDone(commit)
  }
  return (
    <input
      autoFocus
      aria-label="セルの値"
      className="h-8 w-full min-w-24 bg-background px-2 outline-none ring-2 ring-ring ring-inset"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true)
        // Escape はこの欄の手直しをやめるだけ。済んだ印（preventDefault）を付け、重ねて開いた作業の画面は閉じない（作業の画面は印のある Escape を見送る）
        if (e.key === "Escape") {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}

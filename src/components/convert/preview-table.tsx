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
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, RefreshCw, Search } from "lucide-react"
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
import { ROW_FILTERS, STATUS, cellClass, changedCell, inFilter, type RowFilter } from "./status"

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
  include: 112,
  origin: 84,
  gyoshu: 64,
  client: 170,
  motoukeShitauke: 64,
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

const originText = (r: Row) => `${r.sheet}!${r.row + 1}`

export function PreviewTable({
  spec,
  rows,
  inclusion,
  openEditor,
  onEdit,
  onToggle,
  filter,
  onFilterChange,
  checks,
  counts,
}: {
  spec: CsvSpec<KojiFieldId>
  rows: Row[]
  inclusion: ReadonlyMap<string, Inclusion>
  /** 手直しを始める（直す元の文字列は個人名の記号を「〔Ａ〕」の形で出し、確定した文字列は同じ記号の表で読む） */
  openEditor: (cell: CellResult) => EditSession
  onEdit: (rowKey: string, field: KojiFieldId, edit: CellEdit) => void
  onToggle: (rowKey: string, included: boolean) => void
  /** 絞り込み（案件の画面が持つ。チャットの報告の件数を押しても変わる） */
  filter: RowFilter
  onFilterChange: (f: RowFilter) => void
  /** 行に確かめるセルがあるか（rowNeedsCheck）と、絞り込みごとの行数（countRowFilters）。案件の画面が1回だけ数えて渡す */
  checks: ReadonlyMap<string, boolean>
  counts: Record<RowFilter, number>
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
    const hasText = (r: Row) =>
      (visible("origin") && originText(r).toLowerCase().includes(needle)) || searched.some((f) => r.cells[f.id].value.toLowerCase().includes(needle))
    return rows.filter((r) => inFilter(filter, r, inclusion.get(r.key)?.included ?? false, checks.get(r.key)) && (!needle || hasText(r)))
  }, [rows, checks, inclusion, filter, needle, columnVisibility, spec])

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
    if (commit && editing.draft !== editing.session.text) onEdit(editing.row, editing.field, editing.session.read(editing.draft))
  }

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
    return (
      <TableCell
        key={columnId}
        className={cn("border-b border-l p-0 align-top whitespace-normal", cellClass(cell))}
        data-field={field}
        data-status={cell.status}
        data-changed={changedCell(cell) ? "1" : undefined}
      >
        {isEditing ? (
          <CellEditor value={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} onDone={finishEdit} />
        ) : (
          // 注意書きはセルの下に出さない（色で状態は分かる）。選んだ・マウスを乗せたセルのものを表の上の1行に出す（キーボードで選んでも出る）
          <CellButton store={store.current!} row={r.key} field={field} message={cell.message} onClick={() => startEdit(r, field)}>
            <span className="whitespace-pre-wrap">{cell.value || <span className="text-muted-foreground/50">—</span>}</span>
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
          value={filter}
          options={(["check", "all"] as const).map((f) => ({ value: f, label: `${ROW_FILTERS[f].label} ${counts[f]}` }))}
          onChange={(f) => {
            unpin()
            setFilter(f)
          }}
          testId="row-filters"
        />
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
                  {needle ? `「${query.trim()}」を含む${ROW_FILTERS[filter].empty}` : ROW_FILTERS[filter].empty}はありません
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </table>
      </div>
    </div>
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
function CellButton({ store, row, field, message, onClick, children }: { store: ActiveStore; row: string; field: KojiFieldId; message?: string; onClick: () => void; children: React.ReactNode }) {
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

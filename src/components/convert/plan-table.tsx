import { Plus, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import type { RowDraft } from "@/lib/convert/convert"
import { columnCount, columnLetter, type FieldPlan, type MappingPlan, type SheetGrid } from "@/lib/convert/plan"
import { gyoshuCode, preferredTransform, transformsFor, type TransformId } from "@/lib/convert/transforms"
import { CODE_SETS } from "@/lib/spec/code-sets"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import type { CsvSpec, FieldSpec } from "@/lib/spec/types"
import { autoFillOf } from "@/lib/spec/types"
import { cn } from "@/lib/utils"

type Plan = MappingPlan<KojiFieldId>

const KIND_LABELS: Record<FieldPlan["kind"], string> = {
  column: "列",
  columns: "複数の列",
  flagColumns: "記号（○）の列",
  constant: "全行同じ値",
  missing: "なし",
}

function defaultTransform(field: FieldSpec, multi: boolean): TransformId {
  return preferredTransform(field.valueType, multi)
}

/** 見出しが業種名の列（記号の列の候補） */
function flagCandidates(headers: string[]) {
  return headers.flatMap((h, column) => {
    const code = gyoshuCode(h)
    return code && !/^\d+$/.test(h.trim()) ? [{ column, code }] : []
  })
}

function switchKind(field: FieldSpec, prev: FieldPlan, kind: FieldPlan["kind"], headers: string[]): FieldPlan {
  const col = prev.kind === "column" ? prev.column : prev.kind === "columns" ? prev.columns[0]! : 0
  switch (kind) {
    case "flagColumns":
      return { kind, columns: field.valueType.type === "code" && field.valueType.set === "gyoshu" ? flagCandidates(headers) : [] }
    case "column":
      return { kind, column: col, transform: prev.kind === "columns" ? prev.transform : defaultTransform(field, false) }
    case "columns":
      return { kind, columns: [col, col], transform: defaultTransform(field, true) }
    case "constant":
      return { kind, value: field.whenMissing?.value ?? "", reason: "職員が指定" }
    case "missing":
      return { kind }
  }
}

export function PlanTable({
  spec,
  grid,
  plan,
  samples,
  onChange,
}: {
  spec: CsvSpec<KojiFieldId>
  grid: SheetGrid
  plan: Plan
  samples: RowDraft<KojiFieldId>[]
  onChange: (plan: Plan) => void
}) {
  const nCols = columnCount(grid)
  const headers = grid.rows[plan.headerRow] ?? []
  const columnOptions = Array.from({ length: nCols }, (_, c) => (
    <option key={c} value={c}>
      {columnLetter(c)}: {headers[c]?.trim() || "（見出しなし）"}
    </option>
  ))
  const setField = (id: KojiFieldId, p: FieldPlan) => onChange({ ...plan, fields: { ...plan.fields, [id]: p } })
  const setRows = (patch: Partial<Pick<Plan, "headerRow" | "dataRows">>) => onChange({ ...plan, ...patch })
  const hiddenCount = grid.hidden.filter(Boolean).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <RowNumber label="見出し行" value={plan.headerRow} max={grid.rows.length} onChange={(headerRow) => setRows({ headerRow })} />
        <RowNumber label="データ（開始行）" value={plan.dataRows.start} max={grid.rows.length} onChange={(start) => setRows({ dataRows: { ...plan.dataRows, start } })} />
        <RowNumber label="データ（終了行）" value={plan.dataRows.end} max={grid.rows.length} onChange={(end) => setRows({ dataRows: { ...plan.dataRows, end } })} />
        <p className="pb-1.5 text-muted-foreground">
          飛ばす行: {plan.skipRows.length ? plan.skipRows.map((r) => r + 1).join("・") : "なし"}
        </p>
        <label className="flex items-center gap-2 pb-1.5">
          <input
            type="checkbox"
            data-testid="exclude-hidden"
            checked={plan.rowFilter.excludeHidden}
            onChange={(e) => onChange({ ...plan, rowFilter: { ...plan.rowFilter, excludeHidden: e.target.checked } })}
          />
          非表示の行を除外（このシートは {hiddenCount} 行が非表示）
        </label>
        <label className="flex items-center gap-2 pb-1.5">
          <span>除外の印の列</span>
          <NativeSelect
            aria-label="除外の印の列"
            value={plan.rowFilter.excludeColumns[0] ?? -1}
            onChange={(e) => {
              const c = Number(e.target.value)
              onChange({ ...plan, rowFilter: { ...plan.rowFilter, excludeColumns: c < 0 ? [] : [c] } })
            }}
          >
            <option value={-1}>なし</option>
            {columnOptions}
          </NativeSelect>
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[920px] text-sm" data-testid="plan-table">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2">列</th>
              <th className="w-40 px-3 py-2">項目</th>
              <th className="w-[300px] px-3 py-2">取り込み元</th>
              <th className="w-56 px-3 py-2">変換</th>
              <th className="px-3 py-2">例（元の値 → 変換後）</th>
            </tr>
          </thead>
          <tbody>
            {spec.fields.map((f) => {
              const p = plan.fields[f.id]
              const autoFill = autoFillOf(spec, f)
              const missingTone = p.kind === "missing" ? (f.required && !autoFill ? "bg-red-50" : "bg-amber-50") : ""
              const codes: readonly { code: string; label: string }[] = f.valueType.type === "code" ? CODE_SETS[f.valueType.set] : []
              const transforms = transformsFor(f.valueType).filter((t) => p.kind !== "columns" || t.multiColumn)
              return (
                <tr key={f.id} className={cn("border-t align-top", missingTone)} data-field={f.id}>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{f.letter}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{f.label}</div>
                    <div className="mt-1">
                      {f.required ? <Badge variant="outline" className="border-red-200 text-red-700">必須</Badge> : <Badge variant="outline">任意</Badge>}
                    </div>
                  </td>
                  <td className="space-y-1.5 px-3 py-2">
                    <NativeSelect aria-label={`${f.label}の取り込み元`} value={p.kind} onChange={(e) => setField(f.id, switchKind(f, p, e.target.value as FieldPlan["kind"], headers))}>
                      {Object.entries(KIND_LABELS).filter(([k]) => k !== "flagColumns" || f.valueType.type === "code").map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </NativeSelect>
                    {p.kind === "column" && (
                      <NativeSelect aria-label={`${f.label}の列`} value={p.column} onChange={(e) => setField(f.id, { ...p, column: Number(e.target.value) })}>
                        {columnOptions}
                      </NativeSelect>
                    )}
                    {p.kind === "columns" && (
                      <div className="space-y-1.5">
                        {p.columns.map((c, i) => (
                          <div key={i} className="flex gap-1.5">
                            <NativeSelect
                              className="flex-1"
                              aria-label={`${f.label}の列${i + 1}`}
                              value={c}
                              onChange={(e) => setField(f.id, { ...p, columns: p.columns.map((x, j) => (j === i ? Number(e.target.value) : x)) })}
                            >
                              {columnOptions}
                            </NativeSelect>
                            {p.columns.length > 1 && (
                              <Button variant="ghost" size="icon" aria-label="列を外す" onClick={() => setField(f.id, { ...p, columns: p.columns.filter((_, j) => j !== i) })}>
                                <X />
                              </Button>
                            )}
                          </div>
                        ))}
                        {p.columns.length < 3 && (
                          <Button variant="outline" size="xs" onClick={() => setField(f.id, { ...p, columns: [...p.columns, 0] })}>
                            <Plus /> 列を追加
                          </Button>
                        )}
                      </div>
                    )}
                    {p.kind === "flagColumns" && (
                      <div className="space-y-1.5" data-testid={`flag-columns-${f.id}`}>
                        {p.columns.map((c, i) => (
                          <div key={i} className="flex gap-1.5">
                            <NativeSelect
                              className="flex-1"
                              aria-label={`${f.label}の記号の列${i + 1}`}
                              value={c.column}
                              onChange={(e) => setField(f.id, { ...p, columns: p.columns.map((x, j) => (j === i ? { ...x, column: Number(e.target.value) } : x)) })}
                            >
                              {columnOptions}
                            </NativeSelect>
                            <NativeSelect
                              className="w-32"
                              aria-label={`${f.label}の記号の列${i + 1}のコード`}
                              value={c.code}
                              onChange={(e) => setField(f.id, { ...p, columns: p.columns.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) })}
                            >
                              {codes.map((o) => (
                                <option key={o.code} value={o.code}>
                                  {o.code} {o.label}
                                </option>
                              ))}
                            </NativeSelect>
                            <Button variant="ghost" size="icon" aria-label="列を外す" onClick={() => setField(f.id, { ...p, columns: p.columns.filter((_, j) => j !== i) })}>
                              <X />
                            </Button>
                          </div>
                        ))}
                        <Button variant="outline" size="xs" onClick={() => setField(f.id, { ...p, columns: [...p.columns, { column: 0, code: codes[0]?.code ?? "" }] })}>
                          <Plus /> 列を追加
                        </Button>
                        <p className="text-xs text-muted-foreground">記号のある列ごとに行を作ります（1行に2つあれば2行）。記号の無い行は出力しません。</p>
                      </div>
                    )}
                    {p.kind === "constant" && (
                      <div className="space-y-1">
                        <Input aria-label={`${f.label}の値`} className="h-8" value={p.value} onChange={(e) => setField(f.id, { ...p, value: e.target.value })} />
                        <p className="text-xs text-muted-foreground">{p.reason}</p>
                      </div>
                    )}
                    {p.kind === "missing" && (
                      <p className={cn("text-xs", f.required && !autoFill ? "text-red-700" : "text-amber-700")}>
                        {autoFill
                          ? `元データにありません。自動で埋めます: ${autoFill}`
                          : f.required
                            ? "必須の項目が元データにありません（プレビューで入力）"
                            : "元データにありません（空欄で出力）"}
                      </p>
                    )}
                  </td>
                  <td className="space-y-1.5 px-3 py-2">
                    {(p.kind === "column" || p.kind === "columns") && (
                      <>
                        <NativeSelect aria-label={`${f.label}の変換`} value={p.transform} onChange={(e) => setField(f.id, { ...p, transform: e.target.value as TransformId })}>
                          {transforms.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.kind === "ai" ? "AI: " : ""}
                              {t.label}
                            </option>
                          ))}
                        </NativeSelect>
                        {p.transform === "ai.freeform" && (
                          <Input
                            className="h-8"
                            aria-label={`${f.label}のAIへの指示`}
                            placeholder="AI への指示（例: 西暦の年月に）"
                            value={p.instruction ?? ""}
                            onChange={(e) => setField(f.id, { ...p, instruction: e.target.value })}
                          />
                        )}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <Samples field={f.id} samples={samples} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {plan.unusedColumns.length > 0 && (
        <div className="rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="unused-columns">
          <p className="mb-1 font-medium text-foreground/70">使わない列</p>
          <ul className="space-y-0.5">
            {plan.unusedColumns.map((c) => (
              <li key={c.column}>
                {columnLetter(c.column)}列「{c.header}」… {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Samples({ field, samples }: { field: KojiFieldId; samples: RowDraft<KojiFieldId>[] }) {
  return (
    <ul className="space-y-1">
      {samples.map((s) => {
        const c = s.cells[field]
        const [from, to] = c.kind === "done" ? [c.cell.source.replace(/^[A-Z+]+列: /, ""), c.cell.value] : [c.raw, "（AIで変換）"]
        return (
          <li key={s.key} className="truncate">
            <span className="text-muted-foreground">{from || "（空欄）"}</span>
            <span className="mx-1 text-muted-foreground/60">→</span>
            <span className={cn(c.kind === "done" && c.cell.status === "error" && "text-red-700")}>{to || "（空欄）"}</span>
          </li>
        )
      })}
    </ul>
  )
}

function RowNumber({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={1}
        max={max}
        className="h-8 w-24"
        value={value + 1}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= 1 && n <= max) onChange(n - 1)
        }}
      />
    </label>
  )
}

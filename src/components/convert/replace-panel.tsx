import { useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import type { Replacements, RowResult } from "@/lib/convert/convert"
import { showPersons, type PersonLetters } from "@/lib/convert/persons"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import type { CsvSpec } from "@/lib/spec/types"

/** 列の値の一覧（件数つき）と、値ごとの置換先 */
export function ReplacePanel({
  spec,
  rows,
  letters,
  replacements,
  onChange,
}: {
  spec: CsvSpec<KojiFieldId>
  rows: RowResult<KojiFieldId>[]
  /** 値の個人名の印を記号で見せる。置換先の欄と候補は手直しと同じ「〔Ａ〕」の形 */
  letters: PersonLetters
  replacements: Replacements<KojiFieldId>
  onChange: (field: KojiFieldId, from: string, to: string) => void
}) {
  const [field, setField] = useState<KojiFieldId>("engineer")
  const values = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) {
      const v = r.cells[field].value
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
  }, [rows, field])
  const table = replacements[field] ?? {}
  const listId = `replace-values-${field}`

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4" data-testid="replace-panel">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="replace-field">列</Label>
          <NativeSelect id="replace-field" value={field} onChange={(e) => setField(e.target.value as KojiFieldId)}>
            {spec.fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.letter} {f.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <p className="pb-2 text-xs text-muted-foreground">
          値ごとに置換先を入れると、その値のセルをすべて置き換えます（変換の後・手直しの前）。{values.length} 種類の値。
        </p>
      </div>
      <datalist id={listId}>
        {values.map(([v]) => (
          <option key={v} value={showPersons(v, letters, true)} />
        ))}
      </datalist>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">値</th>
              <th className="py-1 pr-3 text-right">件数</th>
              <th className="py-1">置換先</th>
            </tr>
          </thead>
          <tbody>
            {values.map(([v, n]) => (
              <tr key={v} className="border-t" data-value={v}>
                <td className="py-1 pr-3">{showPersons(v, letters)}</td>
                <td className="num py-1 pr-3 text-right">{n}</td>
                <td className="py-1">
                  <Input
                    className="h-8"
                    list={listId}
                    aria-label={`${showPersons(v, letters)} の置換先`}
                    value={table[v] ? showPersons(table[v].value, letters, true) : ""}
                    onChange={(e) => onChange(field, v, e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

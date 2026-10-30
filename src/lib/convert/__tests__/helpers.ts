import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { KOJI_KEIREKI, type KojiFieldId } from "../../spec/koji-keireki"
import { applyEdits, finalizeRows, type CellEdits, type CellResult, type Replacements, type RowResult } from "../convert"

export const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url))))

export function kojiRow(values: Partial<Record<KojiFieldId, string>>, row = 0, extra: { excluded?: string } = {}): RowResult<KojiFieldId> {
  const cells = {} as Record<KojiFieldId, CellResult>
  for (const f of KOJI_KEIREKI.fields) {
    const value = values[f.id] ?? ""
    cells[f.id] = { value, status: "ok", source: "テスト", original: value }
  }
  return { key: `s!${row}`, sheet: "s", row, ...extra, cells }
}

export const valuesOf = (row: RowResult<KojiFieldId>) =>
  Object.fromEntries(KOJI_KEIREKI.fields.map((f) => [f.id, row.cells[f.id].value])) as Record<KojiFieldId, string>

/** 一括置換・手直しを当て、全行を CSV に書く行として（渡した順に）記号を付けて検証する */
export function finalizeAll(rows: readonly RowResult<KojiFieldId>[], { replacements = {}, edits = new Map() }: { replacements?: Replacements<KojiFieldId>; edits?: CellEdits } = {}) {
  return finalizeRows(KOJI_KEIREKI, applyEdits(KOJI_KEIREKI, rows, { replacements, edits }), { exported: () => true, original: rows, replacements })
}

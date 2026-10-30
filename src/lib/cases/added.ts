import { z } from "zod"
import type { CellResult, RowResult } from "../convert/convert"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"

/**
 * 元のファイルに無い工事（返ってきた Excel で足した行、PDF から AI が作った行）。行は空のセルだけを持ち、値は手直し（edits）として重ねる
 * （手直し・検証・7割・問い合わせ・CSV は変換した行と同じ仕組みを通る）。by は足した出どころ
 */
export type AddedRow = { key: string; by: "excel" | "chat" }

export const addedRowSchema = z.object({ key: z.string().regex(/^add-/), by: z.enum(["excel", "chat"]) })

/**
 * 案件に足せる行の数。案件の作業・チャットに送る表・Excel の取り込み・チャットの add_rows・変更案の承認のすべてがこの上限で確かめる
 * （どこかで超えると、チャットに表を送れなくなる）
 */
export const MAX_ADDED_ROWS = 5_000

/** 足す行の key（変換した行の key「シート!行」と重ならない） */
export const newAddedKey = () => `add-${crypto.randomUUID()}`

const SHEET: Record<AddedRow["by"], string> = { excel: "Excelで追加", chat: "AIが追加" }

/** 足した行の、手直しを重ねる前の行（空のセル）。row は足した順の番号 */
export function addedRowResults(added: readonly AddedRow[]): RowResult<KojiFieldId>[] {
  return added.map((a, i) => {
    const cells = {} as Record<KojiFieldId, CellResult>
    for (const f of KOJI_KEIREKI.fields) cells[f.id] = { value: "", status: "ok", source: SHEET[a.by], original: "" }
    return { key: a.key, sheet: SHEET[a.by], row: i, cells }
  })
}

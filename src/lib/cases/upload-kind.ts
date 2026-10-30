import type { SheetGrid } from "../convert/plan"
import { KEYS_SHEET_NAME, META_HEADER } from "../excel/edit-sheet"
import { ASKED_HEADER, MANAGEMENT_HEADER } from "../inquiry/inquiry"

/**
 * 上げたファイルの種類を、決まった印で見分ける（チャット欄・画面に落としたファイル）。
 * edit: この画面で落とした編集用の Excel（照合用の列と隠しシート）。answer: 記入用Excel（管理番号と照合用の列）。
 * sheet: そのほかの表（元データの候補）。document: 表として読まないファイル（PDF）
 */
export type UploadKind = "edit" | "answer" | "sheet" | "document"

export function uploadKind(sheets: readonly SheetGrid[] | null): UploadKind {
  if (!sheets) return "document"
  const hasKeys = sheets.some((s) => s.name === KEYS_SHEET_NAME)
  if (hasKeys && sheets.some((s) => s.name !== KEYS_SHEET_NAME && s.rows[0]?.some((c) => c.trim() === META_HEADER))) return "edit"
  const answer = sheets.some((s) => s.rows.some((r) => r.some((c) => c.trim() === MANAGEMENT_HEADER) && r.some((c) => c.trim() === ASKED_HEADER)))
  return answer ? "answer" : "sheet"
}

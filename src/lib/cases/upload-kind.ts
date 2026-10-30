import type { SheetGrid } from "../convert/plan"
import { finalCheckOf } from "../excel/final-import"
import { CHECK_SHEET_NAME } from "../excel/final-sheet"
import { ASKED_HEADER, MANAGEMENT_HEADER } from "../inquiry/inquiry"

/**
 * 上げたファイルの種類を、決まった印で見分ける（チャット欄・画面に落としたファイル）。
 * final: この画面で落とした最後の Excel（照合用の隠しシート）。answer: 記入用Excel（管理番号と照合用の列）。
 * unlinked: 表に戻せない Excel（照合用の隠しシートの無い、最後の Excel の形の表・前の編集用の Excel）。元データと取り違えないよう、何として読むかを職員に聞く。
 * sheet: そのほかの表（元データの候補）。document: 表として読まないファイル（PDF）
 */
export type UploadKind = "final" | "answer" | "unlinked" | "sheet" | "document"

/** 前の「Excel で直す」の編集用の Excel の印（隠しシートの名前と、見出しの照合用の列） */
const OLD_EDIT_SHEET = "照合用"

export function uploadKind(sheets: readonly SheetGrid[] | null): UploadKind {
  if (!sheets) return "document"
  if (finalCheckOf(sheets)) return "final"
  if (sheets.some((s) => s.rows.some((r) => r.some((c) => c.trim() === MANAGEMENT_HEADER) && r.some((c) => c.trim() === ASKED_HEADER)))) return "answer"
  if (sheets.some((s) => s.name === OLD_EDIT_SHEET) && sheets.some((s) => s.rows[0]?.some((c) => c.trim() === OLD_EDIT_SHEET))) return "unlinked"
  const first = sheets.find((s) => s.name !== CHECK_SHEET_NAME)
  return first && looksLikeFinal(first) ? "unlinked" : "sheet"
}

/**
 * 建設業.NET に取り込む形（見出しの行なし・A〜N の14列）の表か。1行目が業種のコード・元請下請・JV の数字で、N列より右に値が無い。
 * 職員が自分で作った最後の Excel や、照合用のシートを消した Excel
 */
function looksLikeFinal(sheet: SheetGrid) {
  const rows = sheet.rows.filter((r) => r.some(Boolean))
  if (!rows.length || rows.some((r) => r.slice(14).some(Boolean))) return false
  const [gyoshu, , motouke, jv] = rows[0]!
  return /^\d{1,2}$/.test(gyoshu ?? "") && /^[12]$/.test(motouke ?? "") && /^[01]$/.test(jv ?? "")
}

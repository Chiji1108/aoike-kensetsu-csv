/**
 * 変換の報告（チャットの最初の返事）の段階。ファイルを読む → 列の対応を考える → 変換する のどこにいるか、失敗して止まっているかを、
 * 案件の画面の状態から決める（失敗したまま「変換しています」のスピナーを出し続けない）
 */
export type ReportPhase =
  | { kind: "empty" }
  | { kind: "noSheet" }
  /** AI が使えない（APIキーが無い）。このツールは AI で列の対応を決めるので、推定の計画で進めずに止める */
  | { kind: "noAi" }
  | { kind: "reading"; name: string }
  | { kind: "planning"; name: string }
  | { kind: "converting"; name: string }
  /** retry はやり直す段階（source: ファイルを読み直す、convert: 変換し直す） */
  | { kind: "failed"; message: string; retry: "source" | "convert" }
  | { kind: "done" }

export type PhaseInput = {
  aiEnabled: boolean
  /** 読んでいる変換の元のファイル名 */
  loading: string | null
  /** 変換の元を読めなかった理由 */
  sourceError: string | null
  planning: boolean
  /** 今の計画で変換できなかった理由 */
  convertError: string | null
  /** 計画があって、変換が済んでいない（変換し直している） */
  converting: boolean
  hasTable: boolean
  noSheetSource: boolean
  /** 変換の元のファイルの名前（無ければ null） */
  sourceName: string | null
}

export function reportPhase(i: PhaseInput): ReportPhase {
  if (i.hasTable && !i.converting) return { kind: "done" }
  if (!i.aiEnabled) return { kind: "noAi" }
  if (i.sourceError) return { kind: "failed", message: i.sourceError, retry: "source" }
  if (i.loading) return { kind: "reading", name: i.loading }
  if (i.planning) return { kind: "planning", name: i.sourceName ?? "" }
  if (i.convertError) return { kind: "failed", message: i.convertError, retry: "convert" }
  if (i.converting) return { kind: "converting", name: i.sourceName ?? "" }
  if (i.hasTable) return { kind: "done" }
  if (i.noSheetSource) return { kind: "noSheet" }
  if (i.sourceName !== null) return { kind: "reading", name: i.sourceName }
  return { kind: "empty" }
}

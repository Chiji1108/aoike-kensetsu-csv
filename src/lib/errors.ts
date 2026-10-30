/** サーバー関数のエラーを画面表示用のメッセージに変換する */
export function errorMessage(e: unknown, fallback = "エラーが発生しました。もう一度お試しください。") {
  if (e instanceof Error && e.message) {
    // Zod のバリデーションエラー（JSON 配列）の場合は最初のメッセージを使う
    try {
      const parsed = JSON.parse(e.message)
      if (Array.isArray(parsed) && parsed[0]?.message) return String(parsed[0].message)
    } catch {
      /* not JSON */
    }
    if (/[ぁ-んァ-ン一-龥]/.test(e.message)) return e.message
  }
  return fallback
}

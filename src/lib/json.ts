/** JSON を読む。読めなければ undefined（形は呼ぶ側が zod で確かめる） */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

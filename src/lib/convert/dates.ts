import { nfkc } from "./text"

export type YearMonth = { year: number; month: number }

const ERAS: Record<string, number> = {
  令和: 2018, R: 2018,
  平成: 1988, H: 1988,
  昭和: 1925, S: 1925,
}

export function formatYearMonth({ year, month }: YearMonth) {
  return `${year}${String(month).padStart(2, "0")}`
}

function eraBase(era: string) {
  return ERAS[era] ?? ERAS[era.toUpperCase()]!
}

function valid(year: number, month: number): YearMonth | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return undefined
  if (year < 1950 || year > 2100 || month < 1 || month > 12) return undefined
  return { year, month }
}

/** Excel のシリアル値（1900年基準）→ 年月 */
function fromExcelSerial(n: number) {
  const d = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000)
  return valid(d.getUTCFullYear(), d.getUTCMonth() + 1)
}

/**
 * 和暦・西暦・Excel日付などの1つの日付表記 → 年月。
 * `base` を渡すと「9月」「6.3.31」のように年や元号を省いた表記を base の年・元号で補う。
 */
export function parseYearMonth(raw: string, base?: { year: number; era?: string }): YearMonth | undefined {
  const s = nfkc(raw).replace(/\s/g, "").replace(/元年/g, "1年")
  if (!s) return undefined

  let m = s.match(/^(令和|平成|昭和|R|H|S)(\d{1,2})[年.\/\-](\d{1,2})/i)
  if (m) return valid(eraBase(m[1]!) + Number(m[2]), Number(m[3]))
  m = s.match(/^(令和|平成|昭和|R|H|S)(\d{1,2})(\d{2})$/i)
  if (m) return valid(eraBase(m[1]!) + Number(m[2]), Number(m[3]))

  m = s.match(/^(\d{4})[年.\/\-](\d{1,2})/)
  if (m) return valid(Number(m[1]), Number(m[2]))
  m = s.match(/^(\d{4})(\d{2})(\d{2})?$/)
  if (m) return valid(Number(m[1]), Number(m[2]))
  m = s.match(/^(\d{5})(\.\d+)?$/)
  if (m) return fromExcelSerial(Number(m[1]))

  if (base) {
    m = s.match(/^(\d{1,2})[年.\/\-](\d{1,2})/)
    if (m && base.era) return valid(eraBase(base.era) + Number(m[1]), Number(m[2]))
    m = s.match(/^(\d{1,2})月/)
    if (m) return valid(base.year, Number(m[1]))
  }
  return undefined
}

function eraOf(raw: string) {
  return nfkc(raw).match(/^(令和|平成|昭和|R|H|S)/i)?.[1]
}

/** 「R5.4.1～R6.3.31」「令和5年4月～9月」のような工期 → 開始・終了 */
export function parsePeriod(raw: string): { start?: YearMonth; end?: YearMonth } | undefined {
  const s = nfkc(raw)
  const parts = s.split(/\s*(?:~|〜|～|―|から|至)\s*/)
  if (parts.length !== 2) return undefined
  const [a, b] = parts as [string, string]
  const start = parseYearMonth(a)
  const end = start ? parseYearMonth(b, { year: start.year, era: eraOf(a) }) : parseYearMonth(b)
  if (!start && !end) return undefined
  return { start, end }
}

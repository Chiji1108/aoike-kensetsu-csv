export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const

export type Prefecture = (typeof PREFECTURES)[number]

const SET: ReadonlySet<string> = new Set(PREFECTURES)

export function isPrefecture(s: string): s is Prefecture {
  return SET.has(s)
}

/** 「東京」「大阪」のように都府県を省いた表記を正式名に（北海道はそのまま） */
export function prefectureFromShortName(s: string): Prefecture | undefined {
  if (isPrefecture(s)) return s
  return PREFECTURES.find((p) => p !== "北海道" && p.slice(0, -1) === s)
}

/** 住所の先頭にある都道府県名 */
export function leadingPrefecture(address: string): Prefecture | undefined {
  return PREFECTURES.find((p) => address.startsWith(p))
}

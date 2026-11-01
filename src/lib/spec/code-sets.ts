/**
 * コード表。
 *
 * 業種コード 1〜30 は 2026-10-29 に最新の建設業.NET で docs/業種コード確認.csv を取り込んで確認済み
 * （1〜28 は建設業法別表第一の順、29=解体、30=その他。雛形の見出しは旧版の文言のまま）。
 * 建設業.NET の更新後は同じ CSV（scripts/make-gyoshu-check-csv.ts）で取り込み直して確かめる。
 */
export const GYOSHU = [
  { code: "1", label: "土木一式", aliases: ["土木"] },
  { code: "2", label: "建築一式", aliases: ["建築"] },
  { code: "3", label: "大工", aliases: [] },
  { code: "4", label: "左官", aliases: [] },
  { code: "5", label: "とび・土工・コンクリート", aliases: ["とび土工", "とび", "鳶", "土工", "とび土工コンクリート"] },
  { code: "6", label: "石", aliases: [] },
  { code: "7", label: "屋根", aliases: [] },
  { code: "8", label: "電気", aliases: [] },
  // 「菅工事」は顧客の表でよく見る誤字
  { code: "9", label: "管", aliases: ["菅"] },
  { code: "10", label: "タイル・れんが・ブロック", aliases: ["タイル", "タイルれんがブロック"] },
  { code: "11", label: "鋼構造物", aliases: [] },
  { code: "12", label: "鉄筋", aliases: [] },
  { code: "13", label: "舗装", aliases: [] },
  { code: "14", label: "しゅんせつ", aliases: ["浚渫"] },
  { code: "15", label: "板金", aliases: [] },
  { code: "16", label: "ガラス", aliases: [] },
  { code: "17", label: "塗装", aliases: [] },
  { code: "18", label: "防水", aliases: [] },
  { code: "19", label: "内装仕上", aliases: ["内装", "内装仕上げ"] },
  { code: "20", label: "機械器具設置", aliases: ["機械器具"] },
  { code: "21", label: "熱絶縁", aliases: [] },
  { code: "22", label: "電気通信", aliases: [] },
  { code: "23", label: "造園", aliases: [] },
  { code: "24", label: "さく井", aliases: ["鑿井"] },
  { code: "25", label: "建具", aliases: [] },
  { code: "26", label: "水道施設", aliases: [] },
  { code: "27", label: "消防施設", aliases: [] },
  { code: "28", label: "清掃施設", aliases: [] },
  { code: "29", label: "解体", aliases: [] },
  { code: "30", label: "その他", aliases: [] },
] as const

export const MOTOUKE_SHITAUKE = [
  { code: "0", label: "官公庁元請" },
  { code: "1", label: "民間元請" },
  { code: "2", label: "下請" },
] as const

/** 0/1 の項目（JV・主任技術者・監理技術者）。画面では数字でなくこの名前で出し、選ぶ */
export const FLAG = [
  { code: "0", label: "なし" },
  { code: "1", label: "あり" },
] as const

export const CODE_SETS = {
  gyoshu: GYOSHU,
  motoukeShitauke: MOTOUKE_SHITAUKE,
  flag: FLAG,
} as const satisfies Record<string, readonly { code: string; label: string }[]>

export type CodeSetId = keyof typeof CODE_SETS

export function codeLabel(set: CodeSetId, code: string) {
  return CODE_SETS[set].find((c) => c.code === code)?.label
}

/**
 * 配置技術者の立場。主任技術者・監理技術者の2列は「どちらか一方だけが 1」の決まりがあるので、画面では1つの選ぶ欄にまとめ、
 * 選ぶと2列を一緒に決める（片方だけ 1 にできない組み合わせを作らせない）
 */
export const ENGINEER_ROLES = [
  { code: "chief", label: "主任技術者", values: { chiefEngineer: "1", supervisingEngineer: "0" } },
  { code: "supervising", label: "監理技術者", values: { chiefEngineer: "0", supervisingEngineer: "1" } },
] as const
export type EngineerRole = (typeof ENGINEER_ROLES)[number]["code"]

/** 2列の値から立場（決まりに合わない組み合わせ・空なら undefined） */
export function engineerRoleOf(chief: string, supervising: string): EngineerRole | undefined {
  return ENGINEER_ROLES.find((r) => r.values.chiefEngineer === chief && r.values.supervisingEngineer === supervising)?.code
}

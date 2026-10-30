import type { PlanHints } from "../convert/heuristic-plan"
import { parseYearMonth } from "../convert/dates"
import { collapseSpaces, nfkc, removeSpaces } from "../convert/text"
import { gyoshuCode, looksLikeOrganization, PERSONAL_WORK_NAME_RE, type TransformId } from "../convert/transforms"
import { prefectureFromShortName } from "./prefectures"
import type { CsvSpec, FieldSpec } from "./types"

/**
 * 建設業.NET「CSV形式データインポート → 工事経歴データ」の14列。
 * header は公式雛形（fixtures/工事経歴書(LF).csv）の見出しセルの文言（CSV には出さない。見出し行は取込で読み飛ばしきれないため）。
 */
const FIELDS = [
  {
    id: "gyoshu",
    letter: "A",
    header: "業種\n【必須】\n1から30を入力。\nその他の工事は29\n解体工事は30",
    label: "業種",
    required: true,
    valueType: { type: "code", set: "gyoshu" },
    description: "業種コード 1〜30 の整数",
  },
  {
    id: "client",
    letter: "B",
    header: "注文者",
    label: "注文者",
    required: false,
    filing: true,
    valueType: { type: "text", maxWidth: 27, person: "name" },
    description: "27文字（9文字×3行。半角英数・半角カナは0.5文字で数える）まで。元データの表記（半角カナ・半角スペース・㈱などの記号）はそのまま残す（全角にそろえない）。注文者が個人の場合は個人名を出さず「Ａ」等に置き換える。法人・官公庁・店舗名はそのまま",
  },
  {
    id: "motoukeShitauke",
    letter: "C",
    header: "元請下請\n【必須】\n0：官公庁元請\n1：民間元請\n2：下請",
    label: "元請下請",
    required: true,
    valueType: { type: "code", set: "motoukeShitauke" },
    description: "0=官公庁元請 1=民間元請 2=下請",
  },
  {
    id: "jv",
    letter: "D",
    header: "JV\n【必須】\n0：無\n1：有",
    label: "JV",
    required: true,
    valueType: { type: "flag" },
    description: "共同企業体（JV）の工事か。0=無 1=有",
    whenMissing: { value: "0", reason: "JVの記載が無いため 0（無）" },
  },
  {
    id: "workName",
    letter: "E",
    header: "工事名",
    label: "工事名",
    required: false,
    filing: true,
    valueType: { type: "text", maxWidth: 51, person: "residence" },
    description: "51文字（17文字×3行。半角英数・半角カナは0.5文字で数える）まで。元データの表記（半角カナ・全角・㈱などの記号）はそのまま残す（全角にそろえない）。個人名を含む場合は「Ａ邸新築工事」のように置き換える",
  },
  {
    id: "prefecture",
    letter: "F",
    header: "都道府県名\n【必須】",
    label: "都道府県名",
    required: true,
    valueType: { type: "prefecture" },
    description: "工事場所の都道府県。47都道府県名と完全一致（「東京」は不可、「東京都」）",
  },
  {
    id: "place",
    letter: "G",
    header: "場所名",
    label: "場所名",
    required: false,
    filing: true,
    valueType: { type: "text" },
    description: "工事場所の市区町村名。都道府県名は含めない",
  },
  {
    id: "engineer",
    letter: "H",
    header: "配置技術者",
    label: "配置技術者",
    required: false,
    filing: true,
    valueType: { type: "personName" },
    description: "配置技術者の氏名。姓と名の間に全角スペース（例「世界　次郎」）",
  },
  {
    id: "amount",
    letter: "I",
    header: "請負代金\n【必須】\n単位(千円)（カンマ入力不要）（9桁）",
    label: "請負代金（千円）",
    required: true,
    valueType: { type: "thousandYen", maxDigits: 9 },
    description: "請負代金。千円単位の整数、カンマなし、9桁まで",
  },
  {
    id: "specialAmount",
    letter: "J",
    header:
      "請負代金のうち（　）\n【必須】\n単位(千円)（カンマ入力不要）（9桁）PC工事、法面工事、鋼橋上部工事の金額を入力。",
    label: "うちPC・法面・鋼橋上部（千円）",
    required: true,
    valueType: { type: "thousandYen", maxDigits: 9 },
    description: "請負代金のうち PC工事・法面処理工事・鋼橋上部工事の金額。千円単位、9桁まで。請負代金以下",
    whenMissing: { value: "0", reason: "該当なしとして 0" },
  },
  {
    id: "startYm",
    letter: "K",
    header: "着工年月\n入力例：平成13年8月→200108",
    label: "着工年月",
    required: false,
    filing: true,
    valueType: { type: "yearMonth" },
    description: "西暦の YYYYMM",
  },
  {
    id: "endYm",
    letter: "L",
    header: "完成年月\n入力例：平成30年8月→201808",
    label: "完成年月",
    required: false,
    filing: true,
    valueType: { type: "yearMonth" },
    description: "西暦の YYYYMM。着工年月以降",
  },
  {
    id: "chiefEngineer",
    letter: "M",
    header: "主任技術者\n0：無\n1：有",
    label: "主任技術者",
    required: true,
    valueType: { type: "flag" },
    description: "配置技術者が主任技術者か。0=無 1=有",
  },
  {
    id: "supervisingEngineer",
    letter: "N",
    header: "監理技術者\n0：無\n1：有",
    label: "監理技術者",
    required: true,
    valueType: { type: "flag" },
    description: "配置技術者が監理技術者か。0=無 1=有",
  },
] as const satisfies readonly FieldSpec[]

export type KojiFieldId = (typeof FIELDS)[number]["id"]

export const KOJI_KEIREKI: CsvSpec<KojiFieldId> = {
  id: "koji-keireki",
  title: "工事経歴書",
  fileNamePrefix: "工事経歴書",
  fields: FIELDS,
  rowRules: [
    {
      id: "specialAmountWithinAmount",
      field: "specialAmount",
      message: "請負代金のうち（PC・法面・鋼橋上部）が請負代金を超えています",
      holds: (c) => !/^\d+$/.test(c.amount) || !/^\d+$/.test(c.specialAmount) || Number(c.specialAmount) <= Number(c.amount),
    },
    {
      id: "oneEngineerRole",
      field: "chiefEngineer",
      severity: "warning",
      message: "主任技術者と監理技術者は、どちらか一方だけを 1 にしてください",
      holds: (c) => !/^[01]$/.test(c.chiefEngineer) || !/^[01]$/.test(c.supervisingEngineer) || (c.chiefEngineer === "1") !== (c.supervisingEngineer === "1"),
    },
    {
      id: "endAfterStart",
      field: "endYm",
      message: "完成年月が着工年月より前です",
      holds: (c) => !c.startYm || !c.endYm || c.startYm <= c.endYm,
    },
  ],
  fillRules: [
    {
      id: "oneEngineerRole",
      fields: ["chiefEngineer", "supervisingEngineer"],
      description:
        "主任技術者・監理技術者のどちらか一方だけを 1 にする（両方無ければ主任技術者を 1。片方だけあればもう片方はその逆。ただし主任技術者 0 から監理技術者 1 を決めたときは推定として要確認）",
      fill: ({ chiefEngineer: chief, supervisingEngineer: supervising }, open) => {
        const other = (v: string) => (v === "1" ? "0" : "1")
        if (open.has("chiefEngineer") && open.has("supervisingEngineer"))
          return { values: { chiefEngineer: "1", supervisingEngineer: "0" }, reason: "主任技術者・監理技術者の記載が無いため主任技術者とする。建設業.NET では空欄にできない" }
        if (open.has("chiefEngineer") && /^[01]$/.test(supervising)) return { values: { chiefEngineer: other(supervising) }, reason: "監理技術者の値から、どちらか一方だけが 1 になるように決めた" }
        if (open.has("supervisingEngineer") && chief === "1") return { values: { supervisingEngineer: "0" }, reason: "主任技術者の値から、どちらか一方だけが 1 になるように決めた" }
        if (open.has("supervisingEngineer") && chief === "0")
          return { values: { supervisingEngineer: "1" }, reason: "主任技術者が 0 のため監理技術者を 1 と推定（監理技術者を置いた工事か要確認）", review: true }
        return undefined
      },
    },
  ],
  writingRules: [
    "注文者が個人のときは個人名を出さない（「Ａ」等）。工事名に個人名があれば「Ａ邸新築工事」のように置き換える。法人・官公庁・店舗名はそのまま。",
    "請負代金は千円単位。千円未満は案件ごとに切り捨て（初期値）か四捨五入。",
    "記載順は業種ごとに、元請工事を金額の大きい順（元請合計の7割を超えるまで）、続いて残りの元請と下請。下請は必ず元請より下。",
    "取込は追加（上書きではない）。同じCSVを2回取り込むと工事が重複する。",
  ],
}

/** 都道府県名の列に「東京都文京区」のような住所が入っていないか */
const onlyPrefectureNames = (values: string[]) => values.every((v) => prefectureFromShortName(removeSpaces(nfkc(v))))

/** 着工・完成の列の値が日付か（「ＳＲ完了フラグ」のような状態の列を除く） */
const mostlyDates = (values: string[]) => values.filter((v) => parseYearMonth(v)).length >= values.length / 2

const ADDRESS_HEADERS = ["都道府県", "施工場所", "工事場所", "現場住所", "住所", "所在地", "場所", "現場"]

/**
 * 見出しから列を推定するときの手がかり（APIキーが無いときの計画、AIの計画の初期値）。
 * 見出しが業種名で値が「○」だけの列は、記号の列として業種にする（1行に複数あれば行を分ける）。
 * 都道府県が元データに無ければ、工事名と注文者から AI で推定する。
 */
/**
 * 注文者・工事名に元データ以外から入る値（チャットの AI が書いた値）の匿名化。変換と同じ変換を使い、AI に聞くかの見分け方も変換の run と同じ
 * （法人らしい注文者・個人名らしい語の無い工事名は聞かない）。聞いたら変換の ai.apply で検算する
 */
export const KOJI_ANONYMIZE: Partial<Record<KojiFieldId, { transform: TransformId; mayHavePersons: (text: string) => boolean }>> = {
  client: { transform: "ai.anonymizeClient", mayHavePersons: (t) => !looksLikeOrganization(collapseSpaces(t)) },
  workName: { transform: "ai.anonymizeWorkName", mayHavePersons: (t) => PERSONAL_WORK_NAME_RE.test(collapseSpaces(t)) },
}

export const KOJI_PLAN_HINTS: PlanHints<KojiFieldId> = {
  columns: {
    gyoshu: [{ match: ["業種", "工種", "工事種別", "種別"], transform: "rule.gyoshu" }, { flags: gyoshuCode }],
    client: [{ match: ["注文者", "発注者", "注文主", "発注元", "施主", "元請会社", "客先", "顧客"], transform: "ai.anonymizeClient" }],
    motoukeShitauke: [
      {
        match: ["元請下請", "元請/下請", "元下", "請負区分", "受注形態", "元請", "区分"],
        transform: "rule.motoukeShitauke",
        pairWith: { headers: ["官民", "官公庁/民間", "発注区分"], field: "client" },
      },
    ],
    jv: [{ match: ["JV", "共同企業体"], transform: "rule.flag01" }],
    workName: [
      { match: ["工事名", "工事件名", "件名", "工事名称", "案件名"], transform: "ai.anonymizeWorkName" },
      { match: ["現場名"], transform: "rule.joinWorkName", all: true },
    ],
    prefecture: [
      { match: ["都道府県"], transform: "rule.prefecture", when: onlyPrefectureNames },
      { match: ADDRESS_HEADERS, transform: "rule.addressPrefecture", shared: true },
      { derive: ["workName", "client"], transform: "ai.inferPrefecture" },
      { derive: ["workName"], transform: "ai.inferPrefecture" },
    ],
    place: [
      { match: ["市区町村", "場所名"], transform: "rule.text" },
      { match: ADDRESS_HEADERS, transform: "rule.addressCity", shared: true },
      { derive: ["workName", "client"], transform: "ai.inferPlace" },
      { derive: ["workName"], transform: "ai.inferPlace" },
    ],
    engineer: [
      { match: ["配置技術者", "技術者名", "技術者氏名", "現場代理人", "担当技術者", "技術者", "担当者"], transform: "rule.personNameSpace" },
    ],
    amount: [
      { match: ["請負代金(千円)", "契約金額(千円)", "請負金額(千円)", "金額(千円)"], transform: "rule.thousandYen" },
      { match: ["請負代金", "契約金額", "請負金額", "受注金額", "工事金額", "金額"], transform: "rule.yenToThousand" },
    ],
    specialAmount: [{ match: ["PC", "法面", "鋼橋"], transform: "rule.yenToThousand" }],
    startYm: [
      { match: ["着工", "着手", "工期(自)", "工期自", "納期From", "開始"], transform: "rule.yearMonth", when: mostlyDates },
      { match: ["工期"], transform: "rule.periodStart", shared: true },
    ],
    endYm: [
      { match: ["完成", "竣工", "完了", "工期(至)", "工期至", "納期To", "終了"], transform: "rule.yearMonth", when: mostlyDates },
      { match: ["工期"], transform: "rule.periodEnd", shared: true },
    ],
    chiefEngineer: [{ match: ["主任技術者"], transform: "rule.flag01" }],
    supervisingEngineer: [{ match: ["監理技術者"], transform: "rule.flag01" }],
  },
  order: [
    "specialAmount", "chiefEngineer", "supervisingEngineer", "engineer", "jv", "gyoshu", "client",
    "motoukeShitauke", "workName", "prefecture", "place", "startYm", "endYm", "amount",
  ],
  excludeHeaders: ["除外", "対象外", "実績外"],
}

/** 項目の名前（画面・チャット・問い合わせで出す） */
export const fieldLabel = (f: KojiFieldId) => KOJI_KEIREKI.fields.find((x) => x.id === f)!.label

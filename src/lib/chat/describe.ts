import type { TableView } from "../cases/view"
import { INCLUSION_LABELS, SELECTION_LABELS, TAX_LABELS, type Basis, type SelectionMode, type TaxMode } from "../convert/koji-selection"
import { personKey, withNames, type PersonLetters } from "../convert/persons"
import { fieldLabel, KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import type { MappingPlan } from "../convert/plan"
import { beforeOf, describePlanPatch } from "../convert/plan-patch"
import { SOURCE_LABELS } from "../location/sites"
import type { ChatChange } from "./proposals"
import { CORRECTION_MESSAGE } from "../inquiry/inquiry"
import { choiceLabel } from "../spec/choices"
import { ROUNDING_LABELS, type Rounding } from "../convert/transforms"


/** 印の人を今の記号で見せる。今の表にいない人（承認すると現れる人）は名前を出さない */
function shownValue(stored: string, letters: PersonLetters) {
  return withNames(stored, (name) => {
    const letter = letters.letterOf.get(personKey(name))
    return letter === undefined ? "〔個人名〕" : letter.startsWith("未掲載") ? `〔${letter}〕` : letter
  })
}

/** 変更案の1項目を画面に出す形。where はどこを、from・to は今と承認したあと。values なら from・to はセルの値（文字の差分を色分けする） */
/** note は値に添える根拠（AI の案）、guess は推定の値か（編集の guessed） */
/**
 * parts は1項目で2つ以上のセルを変えるとき（工事場所の都道府県・場所名）のセルごとの「今 → 承認したあと」。from・to はそれをつないだ文。
 * source は値の出どころ（工事場所の調査の、前の年度に承認した結果・AI の知識・Web 検索）
 */
export type ChangePart = { label: string; from: string; to: string }
export type ChangeLine = {
  where: string
  /** where を短くしたときの元の文（ツールチップ） */
  whereTitle?: string
  what: string
  from: string
  to: string
  values?: true
  parts?: ChangePart[]
  source?: string
  links?: string[]
  note?: string
  guess?: boolean
}

/** 工事名を見出しに使う長さ（承認の前の一覧は狭い画面でも1行に収める） */
const SHORT_NAME = 20
const short = (s: string) => ([...s].length > SHORT_NAME ? `${[...s].slice(0, SHORT_NAME - 1).join("")}…` : s)

/** 顧客の回答から読んだ変更（record_answers）は、項目の名前に添えて分かるようにする（聞いていない項目の訂正は「顧客の訂正」） */
const BY_NOTE: Partial<Record<Extract<ChatChange, { kind: "cell" }>["edit"]["by"], string>> = { customer: "（顧客の回答）", confirmed: "（顧客が確認）" }

/** 7割と金額の設定の変更（変更案の settings・チャットの set_selection の入力）を言葉にする。振り返りの材料も同じ言葉で出す */
export function describeSettings(c: { tax?: TaxMode; selection?: SelectionMode; basis?: Basis; rounding?: Rounding }): string[] {
  return [
    c.tax && `Excel の金額: ${TAX_LABELS[c.tax]}`,
    c.selection && `載せる工事: ${SELECTION_LABELS[c.selection]}`,
    c.rounding && `千円未満: ${ROUNDING_LABELS[c.rounding]}`,
    c.basis && `基準額: ${Object.entries(c.basis).map(([code, b]) => `業種${code} 合計${b?.total ?? "-"}・元請${b?.motouke ?? "-"}千円`).join("、")}`,
  ].filter((x): x is string => !!x)
}

/** plan は今の計画（列の対応の変更案を「今 → 案」で出す） */
export function describeChange(c: ChatChange, view: TableView, byKey: ReadonlyMap<string, TableView["shown"][number]>, plan?: MappingPlan<KojiFieldId> | null): ChangeLine {
  const rowName = (key: string) => {
    const r = byKey.get(key)
    return r ? `${r.sheet}!${r.row + 1}行` : `${key}（今の表に無い行）`
  }
  switch (c.kind) {
    case "cell": {
      const field = KOJI_KEIREKI.fields.find((f) => f.id === c.field)!
      // 決まった値の項目は名前も添える（例「8 電気」）
      const named = (v: string) => (choiceLabel(field, v) ? `${v} ${choiceLabel(field, v)}` : v)
      return {
        where: rowName(c.rowKey),
        what: `${fieldLabel(c.field)}${c.edit.by === "customer" && c.edit.message?.startsWith(CORRECTION_MESSAGE) ? "（顧客の訂正）" : (BY_NOTE[c.edit.by] ?? "")}`,
        from: named(byKey.get(c.rowKey)?.cells[c.field].value ?? ""),
        to: named(shownValue(c.edit.value, view.letters)),
        values: true,
        // AI の案の根拠（「AI で案を出す」。推定ならそう書いてある）
        ...(c.edit.by === "chat" && c.edit.message ? { note: c.edit.message } : {}),
        // 推定（AI の推定の印）は、チャットの set_cells の値も「AI で案を出す」の値も同じ見た目
        ...(c.edit.guessed ? { guess: true } : {}),
      }
    }
    case "ask":
      return { where: rowName(c.rowKey), what: fieldLabel(c.field), from: byKey.get(c.rowKey)?.cells[c.field].value ?? "", to: `顧客に確認: ${c.reason}` }
    case "add": {
      const values = KOJI_KEIREKI.fields.flatMap((f) => (c.cells[f.id]?.value ? [`${f.label}: ${shownValue(c.cells[f.id]!.value, view.letters)}`] : []))
      return { where: c.by === "excel" ? "Excelで追加" : "AIが追加", what: "工事を足す", from: "", to: values.join(" / ") }
    }
    case "include": {
      const now = view.inclusion.get(c.rowKey)
      return { where: rowName(c.rowKey), what: "CSV に載せる", from: now ? `${now.included ? "載せる" : "載せない"}${INCLUSION_LABELS[now.reason] ? `（${INCLUSION_LABELS[now.reason]}）` : ""}` : "", to: c.include ? "載せる（手動）" : "載せない（手動）" }
    }
    case "settings":
      return { where: "案件", what: "7割と金額の設定", from: "", to: describeSettings(c).join(" / ") }
    case "rule":
      return { where: c.scope === "global" ? "全体ルール" : "顧客ルール", what: c.source === "review" ? "項目を足す（振り返り）" : "項目を足す", from: "", to: c.text }
    case "plan":
      return { where: "列の対応", what: "変換し直す", from: "", to: [...describePlanPatch(c.patch, c.before ?? (plan ? beforeOf(plan, c.patch) : undefined)), `理由: ${c.patch.reason}`].join(" / ") }
    case "inquiry":
      return { where: "問い合わせ", what: "質問の文（今は使いません）", from: "", to: c.text }
    case "inquiryMail":
      return { where: "問い合わせ", what: "メールの件名・前置き", from: "", to: `件名: ${c.subject} / ${c.intro}` }
    case "location": {
      // 値（都道府県・場所名）と、出どころ・AI の文（根拠や迷った点）は分けて出す（値の欄に文を混ぜない）
      const first = byKey.get(c.rowKeys[0]!)?.cells
      const parts: ChangePart[] = [
        { label: fieldLabel("prefecture"), from: first?.prefecture.value ?? "", to: c.prefecture },
        // 場所名が分からなかった（都道府県だけ）ときは今の場所名を残す（applyChanges と同じ）
        { label: fieldLabel("place"), from: first?.place.value ?? "", to: c.place || (first?.place.value ?? "") },
      ]
      const name = c.site.workName || c.site.client
      return {
        where: `${short(name)}${c.rowKeys.length > 1 ? `（${c.rowKeys.length}行）` : ""}`,
        whereTitle: [c.site.workName, c.site.client].filter(Boolean).join(" / "),
        what: "工事場所",
        from: parts.map((p) => p.from).filter(Boolean).join(" "),
        to: parts.map((p) => p.to).filter(Boolean).join(" "),
        values: true,
        parts,
        source: [SOURCE_LABELS[c.source], c.urls.length ? "" : "根拠の URL なし"].filter(Boolean).join("・"),
        ...(c.note ? { note: c.note } : {}),
        ...(c.confident ? {} : { guess: true }),
        links: c.urls,
      }
    }
  }
}


import type { TableView } from "../cases/view"
import { INCLUSION_LABELS, SELECTION_LABELS, TAX_LABELS } from "../convert/koji-selection"
import { personKey, withNames, type PersonLetters } from "../convert/persons"
import { KOJI_KEIREKI, type KojiFieldId } from "../spec/koji-keireki"
import type { MappingPlan } from "../convert/plan"
import { beforeOf, describePlanPatch } from "../convert/plan-patch"
import { SOURCE_LABELS } from "../location/sites"
import type { ChatChange } from "./proposals"
import { CORRECTION_MESSAGE } from "../inquiry/inquiry"

const fieldLabel = new Map(KOJI_KEIREKI.fields.map((f) => [f.id, f.label]))

/** 印の人を今の記号で見せる。今の表にいない人（承認すると現れる人）は名前を出さない */
function shownValue(stored: string, letters: PersonLetters) {
  return withNames(stored, (name) => {
    const letter = letters.letterOf.get(personKey(name))
    return letter === undefined ? "〔個人名〕" : letter.startsWith("未掲載") ? `〔${letter}〕` : letter
  })
}

/** 変更案の1項目を画面に出す形。where はどこを、from・to は今と承認したあと。values なら from・to はセルの値（文字の差分を色分けする） */
export type ChangeLine = { where: string; what: string; from: string; to: string; values?: true; links?: string[] }

/** 顧客の回答から読んだ変更（record_answers）は、項目の名前に添えて分かるようにする（聞いていない項目の訂正は「顧客の訂正」） */
const BY_NOTE: Partial<Record<Extract<ChatChange, { kind: "cell" }>["edit"]["by"], string>> = { customer: "（顧客の回答）", confirmed: "（顧客が確認）" }

/** plan は今の計画（列の対応の変更案を「今 → 案」で出す） */
export function describeChange(c: ChatChange, view: TableView, byKey: ReadonlyMap<string, TableView["shown"][number]>, plan?: MappingPlan<KojiFieldId> | null): ChangeLine {
  const rowName = (key: string) => {
    const r = byKey.get(key)
    return r ? `${r.sheet}!${r.row + 1}行` : `${key}（今の表に無い行）`
  }
  switch (c.kind) {
    case "cell":
      return { where: rowName(c.rowKey), what: `${fieldLabel.get(c.field) ?? c.field}${c.edit.by === "customer" && c.edit.message?.startsWith(CORRECTION_MESSAGE) ? "（顧客の訂正）" : (BY_NOTE[c.edit.by] ?? "")}`, from: byKey.get(c.rowKey)?.cells[c.field].value ?? "", to: shownValue(c.edit.value, view.letters), values: true }
    case "ask":
      return { where: rowName(c.rowKey), what: fieldLabel.get(c.field) ?? c.field, from: byKey.get(c.rowKey)?.cells[c.field].value ?? "", to: `顧客に確認: ${c.reason}` }
    case "add": {
      const values = KOJI_KEIREKI.fields.flatMap((f) => (c.cells[f.id]?.value ? [`${f.label}: ${shownValue(c.cells[f.id]!.value, view.letters)}`] : []))
      return { where: c.by === "excel" ? "Excelで追加" : "AIが追加", what: "工事を足す", from: "", to: values.join(" / ") }
    }
    case "include": {
      const now = view.inclusion.get(c.rowKey)
      return { where: rowName(c.rowKey), what: "CSV に載せる", from: now ? `${now.included ? "載せる" : "載せない"}${INCLUSION_LABELS[now.reason] ? `（${INCLUSION_LABELS[now.reason]}）` : ""}` : "", to: c.include ? "載せる（手動）" : "載せない（手動）" }
    }
    case "settings": {
      const parts = [
        c.tax && `Excel の金額: ${TAX_LABELS[c.tax]}`,
        c.selection && `載せる工事: ${SELECTION_LABELS[c.selection]}`,
        c.basis && `基準額: ${Object.entries(c.basis).map(([code, b]) => `業種${code} 合計${b?.total ?? "-"}・元請${b?.motouke ?? "-"}千円`).join("、")}`,
      ].filter(Boolean)
      return { where: "案件", what: "7割の設定", from: "", to: parts.join(" / ") }
    }
    case "rule":
      return { where: c.scope === "global" ? "全体ルール" : "顧客ルール", what: c.source === "review" ? "項目を足す（振り返り）" : "項目を足す", from: "", to: c.text }
    case "plan":
      return { where: "列の対応", what: "変換し直す", from: "", to: [...describePlanPatch(c.patch, c.before ?? (plan ? beforeOf(plan, c.patch) : undefined)), `理由: ${c.patch.reason}`].join(" / ") }
    case "location": {
      const first = byKey.get(c.rowKeys[0]!)
      const now = first ? [first.cells.prefecture.value, first.cells.place.value].filter(Boolean).join(" ") : ""
      const site = [c.site.workName, c.site.client].filter(Boolean).join(" / ")
      return {
        where: `${site}${c.rowKeys.length > 1 ? `（${c.rowKeys.length}行）` : ""}`,
        what: "工事場所",
        from: now,
        to: `${[c.prefecture, c.place].filter(Boolean).join(" ")}（${[SOURCE_LABELS[c.source], c.urls.length ? "" : "根拠の URL なし", c.note].filter(Boolean).join(" / ")}）`,
        links: c.urls,
      }
    }
  }
}


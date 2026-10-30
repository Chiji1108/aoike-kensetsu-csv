import type { TableView } from "../cases/view"
import { INCLUSION_LABELS, SELECTION_LABELS, TAX_LABELS } from "../convert/koji-selection"
import { personKey, withNames, type PersonLetters } from "../convert/persons"
import { KOJI_KEIREKI } from "../spec/koji-keireki"
import { SOURCE_LABELS } from "../location/sites"
import type { ChatChange } from "./proposals"

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

export function describeChange(c: ChatChange, view: TableView, byKey: ReadonlyMap<string, TableView["shown"][number]>): ChangeLine {
  const rowName = (key: string) => {
    const r = byKey.get(key)
    return r ? `${r.sheet}!${r.row + 1}行` : `${key}（今の表に無い行）`
  }
  switch (c.kind) {
    case "cell":
      return { where: rowName(c.rowKey), what: fieldLabel.get(c.field) ?? c.field, from: byKey.get(c.rowKey)?.cells[c.field].value ?? "", to: shownValue(c.edit.value, view.letters), values: true }
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
        c.tax && `元データの金額: ${TAX_LABELS[c.tax]}`,
        c.selection && SELECTION_LABELS[c.selection],
        c.basis && `基準額: ${Object.entries(c.basis).map(([code, b]) => `業種${code} 合計${b?.total ?? "-"}・元請${b?.motouke ?? "-"}千円`).join("、")}`,
      ].filter(Boolean)
      return { where: "案件", what: "7割の設定", from: "", to: parts.join(" / ") }
    }
    case "rule":
      return { where: c.scope === "global" ? "全体ルール" : "顧客ルール", what: "追記", from: "", to: c.text }
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


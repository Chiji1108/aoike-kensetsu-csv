/**
 * 案件の画面の作業の画面（チャットの右）のタブ。チャットの道具の結果から、その道具の作業のタブを開く（TOOL_TABS）
 */
export const WORK_TABS = [
  { id: "table", label: "表" },
  { id: "selection", label: "7割と金額" },
  { id: "inquiry", label: "問い合わせ" },
  { id: "location", label: "工事場所" },
  { id: "replace", label: "一括置換" },
] as const
export type WorkTab = (typeof WORK_TABS)[number]["id"]

/** チャットの道具 → 結果を見るタブ（表を読むだけの道具・ルールの案などは開かない） */
export const TOOL_TABS: Readonly<Record<string, WorkTab>> = {
  set_cells: "table",
  set_include: "table",
  add_rows: "table",
  set_plan: "table",
  set_selection: "selection",
  ask_customer: "inquiry",
  record_answers: "inquiry",
  propose_inquiry: "inquiry",
  find_location: "location",
}

export const workTabLabel = (t: WorkTab) => WORK_TABS.find((x) => x.id === t)!.label

import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { toast } from "sonner"
import { AppShell, PageHeader } from "@/components/app-shell"
import { RuleList } from "@/components/rules/rule-list"
import { Segmented } from "@/components/segmented"
import { Label } from "@/components/ui/label"
import { RULE7_TAX_LABELS, type Rule7Tax } from "@/lib/chat/rules"
import { errorMessage } from "@/lib/errors"
import { getGlobalRulesFn, saveSettingsFn } from "@/server/rules-fns"

export const Route = createFileRoute("/_authed/rules")({
  loader: () => getGlobalRulesFn(),
  component: RulesPage,
})

function RulesPage() {
  const { items, settings } = Route.useLoaderData()
  const [rule7Tax, setRule7Tax] = useState(settings.rule7Tax)

  async function saveRule7Tax(next: Rule7Tax) {
    const before = rule7Tax
    setRule7Tax(next)
    try {
      await saveSettingsFn({ data: { rule7Tax: next } })
    } catch (e) {
      setRule7Tax(before)
      toast.error(errorMessage(e, "設定を保存できませんでした"))
    }
  }

  return (
    <AppShell>
      <PageHeader title="全体ルール" description="すべての顧客に共通する事務所のやり方。チャットの AI への指示に入ります。" />
      <div className="grid max-w-3xl gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <Label title="決算書の完成工事高と比べる金額。新しい案件の初期値になり、案件ごとに変えられます">7割の計算</Label>
          <Segmented
            label="7割の計算"
            value={rule7Tax}
            options={(Object.keys(RULE7_TAX_LABELS) as Rule7Tax[]).map((v) => ({ value: v, label: RULE7_TAX_LABELS[v] }))}
            onChange={saveRule7Tax}
            testId="rule7-tax"
          />
        </div>
        <RuleList target={{ scope: "global" }} initial={items} testId="global-rules" />
      </div>
    </AppShell>
  )
}

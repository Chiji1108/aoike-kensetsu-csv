import { createFileRoute } from "@tanstack/react-router"
import { AppShell, PageHeader } from "@/components/app-shell"
import { TextSetting } from "@/components/cases/text-setting"
import { getRulesFn, saveRulesFn } from "@/server/cases"

export const Route = createFileRoute("/_authed/rules")({
  loader: () => getRulesFn(),
  component: RulesPage,
})

function RulesPage() {
  const { rules } = Route.useLoaderData()
  return (
    <AppShell>
      <PageHeader
        title="全体ルール"
        description="すべての顧客に共通する変換の決まりを文章で書きます。チャットの AI への指示に入ります。顧客ごとの決まりは顧客の画面の顧客ルールに書きます。"
      />
      <div className="max-w-3xl">
        <TextSetting id="global-rules" label="全体ルール" initial={rules} onSave={(text, previous) => saveRulesFn({ data: { rules: text, previous } })} />
      </div>
    </AppShell>
  )
}

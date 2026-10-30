import { useState } from "react"
import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { toast } from "sonner"
import { AppShell, PageHeader } from "@/components/app-shell"
import { DeleteButton } from "@/components/cases/delete-dialog"
import { RuleList } from "@/components/rules/rule-list"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CASE_STATUS_LABELS } from "@/lib/cases/types"
import { Cost, useUsdJpy } from "@/components/cost"
import { formatUsd } from "@/lib/cost"
import { errorMessage } from "@/lib/errors"
import { groupBy } from "@/lib/group-by"
import { createCaseFn, getCustomerPageFn } from "@/server/cases"

export const Route = createFileRoute("/_authed/customers/$customerId")({
  loader: async ({ params }) => {
    const page = await getCustomerPageFn({ data: { id: params.customerId } })
    if (!page) throw notFound()
    return page
  },
  component: CustomerPage,
})

function CustomerPage() {
  const { customer, cases, rules } = Route.useLoaderData()
  const fx = useUsdJpy()
  /** 年度ごとの AI の費用（その年度の案件の合計） */
  const costByYear = [...groupBy(cases, (c) => c.fiscalYear)].map(([fiscalYear, cs]) => ({ fiscalYear, usd: cs.reduce((n, c) => n + c.costUsd, 0) }))
  const router = useRouter()
  const [year, setYear] = useState(String(new Date().getFullYear()))

  async function createCase(e: React.FormEvent) {
    e.preventDefault()
    try {
      const c = await createCaseFn({ data: { customerId: customer.id, fiscalYear: Number(year) } })
      await router.navigate({ to: "/cases/$caseId", params: { caseId: c.id } })
    } catch (err) {
      toast.error(errorMessage(err, "案件を作れませんでした"))
    }
  }

  return (
    <AppShell>
      <nav className="mb-2 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">
          顧客
        </Link>
      </nav>
      <PageHeader
        title={customer.name}
        actions={<DeleteButton target={{ customerId: customer.id }} title={`顧客「${customer.name}」`} customerName={customer.name} onDeleted={() => router.navigate({ to: "/" })} />}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">案件</h2>
        <form onSubmit={createCase} className="flex items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="fiscal-year">年度</Label>
            <Input id="fiscal-year" className="h-9 w-28" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <Button type="submit" size="lg" disabled={!/^\d{4}$/.test(year)} data-testid="create-case">
            <Plus />
            案件を作る
          </Button>
        </form>
        {cases.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだ案件がありません。</p>
        ) : (
          <ul className="divide-y rounded-2xl border bg-card" data-testid="case-list">
            {cases.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3" data-case={c.id}>
                <Link to="/cases/$caseId" params={{ caseId: c.id }} className="font-medium hover:underline">
                  {c.fiscalYear}年度
                </Link>
                <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs">{c.deleting ? "削除の途中" : CASE_STATUS_LABELS[c.status]}</span>
                {/* 時刻はサーバー（UTC）と画面で同じに描くため、事務所の時間帯を決めて書く */}
                <span className="ml-auto text-sm text-muted-foreground">
                  ファイル {c.fileCount} 件・AI の費用 {formatUsd(c.costUsd)}・更新 {new Date(c.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                </span>
                <DeleteButton target={{ caseId: c.id }} title={`${c.fiscalYear}年度の案件`} customerName={customer.name} onDeleted={() => router.invalidate()} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {costByYear.length > 0 && (
        <section className="mt-6 space-y-2">
          <h2 className="text-sm font-semibold">AI の費用（年度ごとの合計）</h2>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="cost-by-year">
            {costByYear.map((y) => (
              <li key={y.fiscalYear}>
                {y.fiscalYear}年度 <span className="num font-medium"><Cost usd={y.usd} fx={fx} /></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10 grid max-w-3xl gap-1.5">
        <h2 className="text-sm font-medium" title="この顧客のデータに当てる決まり。チャットの AI への指示に入ります">
          顧客ルール
        </h2>
        <RuleList target={{ scope: "customer", customerId: customer.id }} initial={rules} testId="customer-rules" />
      </section>
    </AppShell>
  )
}

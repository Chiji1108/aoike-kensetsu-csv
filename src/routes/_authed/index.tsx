import { useState } from "react"
import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { Check, Pencil, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { AppShell, PageHeader } from "@/components/app-shell"
import { DeleteButton } from "@/components/cases/delete-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { CustomerSummary } from "@/lib/cases/types"
import { errorMessage } from "@/lib/errors"
import { createCustomerFn, listCustomersFn, updateCustomerFn } from "@/server/cases"

export const Route = createFileRoute("/_authed/")({
  loader: () => listCustomersFn(),
  component: CustomersPage,
})

function CustomersPage() {
  const customers = Route.useLoaderData()
  const router = useRouter()
  const [name, setName] = useState("")

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    try {
      const c = await createCustomerFn({ data: { name } })
      setName("")
      await router.navigate({ to: "/customers/$customerId", params: { customerId: c.id } })
    } catch (err) {
      toast.error(errorMessage(err, "顧客を作れませんでした"))
    }
  }

  return (
    <AppShell>
      <PageHeader title="顧客" description="顧客ごとに、顧客ルールと年度ごとの案件（届いたファイル・変換・問い合わせ・CSV）を保存します。" />
      <form onSubmit={create} className="mb-6 flex max-w-md gap-2">
        <Input className="h-9" placeholder="新しい顧客の名前" aria-label="新しい顧客の名前" value={name} onChange={(e) => setName(e.target.value)} data-testid="new-customer-name" />
        <Button type="submit" size="lg" disabled={!name.trim()} data-testid="create-customer">
          <Plus />
          顧客を作る
        </Button>
      </form>
      {customers.length === 0 ? (
        <p className="text-sm text-muted-foreground">まだ顧客がありません。</p>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card" data-testid="customer-list">
          {customers.map((c) => (
            <CustomerRow key={c.id} customer={c} onChanged={() => router.invalidate()} />
          ))}
        </ul>
      )}
    </AppShell>
  )
}

function CustomerRow({ customer, onChanged }: { customer: CustomerSummary; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(customer.name)

  async function rename() {
    try {
      await updateCustomerFn({ data: { id: customer.id, name } })
      setEditing(false)
      onChanged()
    } catch (e) {
      toast.error(errorMessage(e, "名前を変えられませんでした"))
    }
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3" data-customer={customer.name}>
      {editing ? (
        <>
          <Input className="h-8 max-w-xs" value={name} onChange={(e) => setName(e.target.value)} aria-label="顧客の名前" autoFocus />
          <Button size="icon-sm" variant="ghost" onClick={rename} disabled={!name.trim()} aria-label="名前を保存">
            <Check />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => (setEditing(false), setName(customer.name))} aria-label="やめる">
            <X />
          </Button>
        </>
      ) : (
        <>
          <Link to="/customers/$customerId" params={{ customerId: customer.id }} className="font-medium hover:underline">
            {customer.name}
          </Link>
          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} aria-label="名前を変える">
            <Pencil />
          </Button>
        </>
      )}
      <span className="ml-auto text-sm text-muted-foreground">案件 {customer.caseCount} 件</span>
      <DeleteButton target={{ customerId: customer.id }} title={`顧客「${customer.name}」`} customerName={customer.name} onDeleted={onChanged} />
    </li>
  )
}

import { useState } from "react"
import { Link, useRouter } from "@tanstack/react-router"
import { KeyRound, LogOut, Menu } from "lucide-react"
import { BrandMark } from "@/components/brand"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { authClient } from "@/lib/auth-client"
import { OFFICE_NAME } from "@/lib/constants"
import { cn } from "@/lib/utils"

/**
 * fill は本文を見出しの下の画面いっぱい（幅も高さも）にし、本文の中でスクロールさせる（案件の画面のチャットと作業の画面）
 */
export function AppShell({ children, fill = false }: { children: React.ReactNode; fill?: boolean }) {
  const router = useRouter()
  const [pwOpen, setPwOpen] = useState(false)

  async function logout() {
    await authClient.signOut()
    await router.invalidate()
    await router.navigate({ to: "/login" })
  }

  return (
    <div className="min-h-dvh">
      <header className="no-print sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandMark className="size-7" />
            <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">{OFFICE_NAME}</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/" className="text-muted-foreground hover:text-foreground" activeProps={{ className: "text-foreground font-medium" }} activeOptions={{ exact: true }}>
              顧客
            </Link>
            <Link to="/rules" className="text-muted-foreground hover:text-foreground" activeProps={{ className: "text-foreground font-medium" }}>
              全体ルール
            </Link>
          </nav>

          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label="メニュー" />}>
                <Menu />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setPwOpen(true)}>
                  <KeyRound />
                  パスワード変更
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout}>
                  <LogOut />
                  ログアウト
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className={cn(fill ? "flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col" : "mx-auto max-w-7xl px-4 pt-6 pb-16 sm:px-6 sm:pt-8")}>{children}</main>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  )
}

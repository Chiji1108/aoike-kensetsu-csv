import { useState } from "react"
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { BrandMark } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"
import { OFFICE_ACCOUNT_EMAIL, OFFICE_NAME } from "@/lib/constants"
import { getSessionFn } from "@/server/session"

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if ((await getSessionFn()).userId) throw redirect({ to: "/" })
  },
  head: () => ({ meta: [{ title: "ログイン | 青池事務所 工事経歴CSV" }] }),
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!password) return
    setPending(true)
    setError(null)
    const { error } = await authClient.signIn.email({
      email: OFFICE_ACCOUNT_EMAIL,
      password,
      rememberMe: true,
    })
    if (error) {
      setPending(false)
      setError(
        error.status === 429
          ? "ログインの試行回数が多すぎます。1分ほど待ってからお試しください。"
          : "パスワードが正しくありません。",
      )
      return
    }
    await router.invalidate()
    await router.navigate({ to: "/" })
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[radial-gradient(ellipse_at_top,var(--brand-soft),transparent_60%)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandMark className="size-12 rounded-xl" />
          <h1 className="mt-5 text-xl font-semibold tracking-tight">工事経歴CSV変換</h1>
          <p className="mt-1 text-sm text-muted-foreground">{OFFICE_NAME}</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border bg-card p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)]"
        >
          {/* パスワードマネージャー向け（画面には表示しない） */}
          <input
            type="email"
            name="username"
            autoComplete="username"
            value={OFFICE_ACCOUNT_EMAIL}
            readOnly
            hidden
          />
          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm">
              パスワード
            </Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                className="h-11 pr-11 text-base"
                placeholder="事務所共通のパスワード"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={show ? "パスワードを隠す" : "パスワードを表示"}
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <Button type="submit" className="mt-5 h-11 w-full text-base" disabled={pending || !password}>
            {pending && <Loader2 className="animate-spin" />}
            ログイン
          </Button>
          <p className="mt-4 text-center text-xs leading-relaxed text-balance text-muted-foreground">
            一度ログインすると、この端末ではログインしたままになります。
          </p>
        </form>
      </div>
    </main>
  )
}

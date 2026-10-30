import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { authClient } from "@/lib/auth-client"

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [revoke, setRevoke] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  function reset() {
    setCurrent("")
    setNext("")
    setConfirm("")
    setRevoke(false)
    setError(null)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (next.length < 8) return setError("新しいパスワードは8文字以上にしてください。")
    if (next !== confirm) return setError("確認用のパスワードが一致しません。")
    setPending(true)
    setError(null)
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: revoke,
    })
    setPending(false)
    if (error) {
      setError(
        error.status === 429
          ? "試行回数が多すぎます。しばらく待ってからお試しください。"
          : "現在のパスワードが正しくありません。",
      )
      return
    }
    toast.success("パスワードを変更しました")
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>パスワード変更</DialogTitle>
            <DialogDescription>事務所共通のパスワードを変更します。変更後はスタッフ全員に新しいパスワードを伝えてください。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pw-current">現在のパスワード</Label>
              <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="h-10" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pw-next">新しいパスワード（8文字以上）</Label>
              <Input id="pw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="h-10" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pw-confirm">新しいパスワード（確認）</Label>
              <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-10" required />
            </div>
            <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <span className="text-sm">
                他の端末をログアウトさせる
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  オンにすると、この端末以外は新しいパスワードで再ログインが必要になります。
                </span>
              </span>
              <Switch checked={revoke} onCheckedChange={setRevoke} />
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              キャンセル
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              変更する
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

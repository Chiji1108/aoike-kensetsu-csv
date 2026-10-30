import { useEffect, useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { DeletionCounts } from "@/lib/cases/types"
import { errorMessage } from "@/lib/errors"
import { deleteFn, deletionCountsFn } from "@/server/cases"

type Target = { customerId: string } | { caseId: string }

/**
 * 顧客か案件を消す。開いたときに消える件数を読み、顧客名を入力したら消せる。
 * 失敗してももう一度押せば続きから消し切れる（サーバーの削除は何度実行しても同じ結果）
 */
export function DeleteButton({ target, title, customerName, onDeleted }: { target: Target; title: string; customerName: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState<DeletionCounts | null>(null)
  const [typed, setTyped] = useState("")
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    setTyped("")
    setCounts(null)
    let live = true
    deletionCountsFn({ data: target })
      .then((c) => live && setCounts(c))
      .catch((e) => toast.error(errorMessage(e, "件数を読めませんでした")))
    return () => {
      live = false
    }
  }, [open])

  async function remove() {
    setPending(true)
    try {
      await deleteFn({ data: { ...target, confirmName: typed } })
      setOpen(false)
      toast.success(`${title}を削除しました`)
      onDeleted()
    } catch (e) {
      toast.error(`${errorMessage(e, "削除できませんでした")}。もう一度押すと続きから消します`)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="delete-button">
        <Trash2 />
        削除
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}を削除しますか</AlertDialogTitle>
            <AlertDialogDescription data-testid="delete-counts">
              {counts
                ? `案件 ${counts.cases} 件と、付けたファイル ${counts.files} 件をすべて消します。元に戻せません。`
                : "消える件数を読んでいます…"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-name">確かめるため、顧客名「{customerName}」を入力してください</Label>
            <Input id="confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="delete-confirm-name" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <Button variant="destructive" onClick={remove} disabled={!counts || pending || typed.trim() !== customerName} data-testid="delete-confirm">
              {pending && <Loader2 className="animate-spin" />}
              削除する
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

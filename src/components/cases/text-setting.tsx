import { useState } from "react"
import { Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"

/**
 * 文章で持つ設定（元データの形式のメモ）。保存ボタンで保存する。
 * 保存した文章がほかで変わったら（読み直したとき）、直している途中でなければ入れ直す
 */
export function TextSetting({
  id,
  label,
  hint,
  initial,
  onSave,
}: {
  id: string
  label: string
  hint?: string
  initial: string
  /** previous は最後に読んだ・保存した文章（書く側がそのままか確かめる） */
  onSave: (text: string, previous: string) => Promise<void>
}) {
  const [text, setText] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [loaded, setLoaded] = useState(initial)
  if (initial !== loaded) {
    setLoaded(initial)
    setSaved(initial)
    if (text === saved) setText(initial)
  }
  const [pending, setPending] = useState(false)

  async function save() {
    setPending(true)
    try {
      await onSave(text, saved)
      setSaved(text)
      toast.success(`${label}を保存しました`)
    } catch (e) {
      toast.error(errorMessage(e, `${label}を保存できませんでした`))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Textarea id={id} className="min-h-32" value={text} onChange={(e) => setText(e.target.value)} data-testid={`${id}-text`} />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={pending || text === saved} data-testid={`${id}-save`}>
          {pending ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>
        {text !== saved && <span className="text-xs text-muted-foreground">保存していない変更があります</span>}
      </div>
    </div>
  )
}

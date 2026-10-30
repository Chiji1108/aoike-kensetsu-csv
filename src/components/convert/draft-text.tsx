import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

/**
 * 下書きを持つ文の欄（問い合わせの質問の文・件名・前置き）。value は今の値で、外から変わることがある（承認・取り消し・ほかのタブ）。
 * 書いていない間は value に合わせる。書いている間に value が変わったら、下書きを黙って消さずに知らせ、どちらにするかを選べる。
 * 欄を離れたら、変わっていれば onCommit（空にしたときの扱いは呼ぶ側。決まった文に戻すなど）。そのあとは今の value に合わせる
 */
export function DraftText({
  value,
  onCommit,
  multiline = false,
  label,
  maxLength,
  testId,
}: {
  value: string
  onCommit: (next: string) => void
  multiline?: boolean
  label: string
  maxLength: number
  testId?: string
}) {
  const [draft, setDraft] = useState(value)
  /** 書き始めたときの値（value がこれから変わったら、外で変わった） */
  const [base, setBase] = useState(value)
  // 書いていない間は今の値に合わせる（描画の間に合わせる。effect で後から書き換えない）
  if (value !== base && draft === base) {
    setBase(value)
    setDraft(value)
  }
  const changedOutside = value !== base
  const commit = () => {
    if (draft.trim() !== base.trim() || changedOutside) onCommit(draft.trim())
    // 確定した値（onCommit で変わった今の値）は次の描画で入る
    setDraft(base)
  }
  const common = {
    "aria-label": label,
    title: label,
    maxLength,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    "data-testid": testId,
  }
  return (
    <div className="grid w-full gap-1">
      {multiline ? <Textarea className="min-h-0 text-sm" rows={2} {...common} /> : <Input {...common} />}
      {changedOutside && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900" data-testid="draft-conflict">
          <span>書いている間に「{value}」に変わりました。欄を離れると書いた文にします。</span>
          <Button
            size="xs"
            variant="outline"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setBase(value)
              setDraft(value)
            }}
          >
            変わった文にする
          </Button>
        </div>
      )}
    </div>
  )
}

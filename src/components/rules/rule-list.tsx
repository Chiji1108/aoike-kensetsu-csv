import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MAX_RULE_ITEM_LENGTH, originLabel, type RuleItem } from "@/lib/chat/rules"
import { errorMessage } from "@/lib/errors"
import { addRuleItemFn, deleteRuleItemFn, moveRuleItemFn, updateRuleItemFn, type RulesResult } from "@/server/rules-fns"

type Target = { scope: "global" } | { scope: "customer"; customerId: string }

/**
 * 全体ルール・顧客ルールの箇条書き。項目ごとに直す・消す・並べ替える・足す（サーバーの操作も項目ごとなので、2つの画面で別の項目を直しても消し合わない）。
 * 同じ項目がほかの画面で直されていたら保存を断り、入力を残したまま今の文章を見せる（もう一度保存すると、その文章を直したことになる）
 */
export function RuleList({ target, initial, testId }: { target: Target; initial: RuleItem[]; testId: string }) {
  const [items, setItems] = useState(initial)
  const [loaded, setLoaded] = useState(initial)
  if (initial !== loaded) {
    setLoaded(initial)
    setItems(initial)
  }
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string; conflict: string | null } | null>(null)
  const [draft, setDraft] = useState("")

  /** 操作をして今の一覧に入れ替える。断られたら（ほかの画面と食い違った・上限）知らせて false */
  async function run(op: () => Promise<RulesResult>, onStale?: (r: RuleItem[]) => void) {
    setBusy(true)
    try {
      const r = await op()
      setItems(r.items)
      if (r.ok) return true
      if (r.stale && onStale) onStale(r.items)
      else toast.error(r.message)
      return false
    } catch (e) {
      toast.error(errorMessage(e, "ルールを保存できませんでした"))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (await run(() => addRuleItemFn({ data: { target, text: draft } }))) setDraft("")
  }

  async function save(item: RuleItem) {
    if (!editing) return
    const text = editing.text
    const ok = await run(
      () => updateRuleItemFn({ data: { target, id: item.id, version: item.version, text } }),
      (now) => {
        const current = now.find((i) => i.id === item.id)
        if (current) setEditing({ id: item.id, text, conflict: current.text })
        else {
          setEditing(null)
          toast.error("この項目はほかの画面で消されました")
        }
      },
    )
    if (ok) setEditing(null)
  }

  const remove = (item: RuleItem) =>
    run(
      () => deleteRuleItemFn({ data: { target, id: item.id, version: item.version } }),
      () => toast.error("この項目はほかの画面で直されたので、消していません。今の文章を確かめてください"),
    )

  const move = (item: RuleItem, direction: "up" | "down") =>
    run(
      () => moveRuleItemFn({ data: { target, id: item.id, direction } }),
      () => toast.error("ほかの画面で並びが変わりました。今の並びを確かめてください"),
    )

  return (
    <div className="grid gap-2" data-testid={testId}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">まだ項目がありません。</p>
      ) : (
        <ol className="divide-y rounded-2xl border bg-card">
          {items.map((item, i) => {
            const edit = editing?.id === item.id ? editing : null
            return (
              <li key={item.id} className="flex items-start gap-3 px-4 py-2.5" data-testid="rule-item" data-rule-id={item.id}>
                <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-muted-foreground num">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  {edit ? (
                    <div className="grid gap-1.5">
                      <Textarea
                        className="min-h-16"
                        value={edit.text}
                        maxLength={MAX_RULE_ITEM_LENGTH}
                        onChange={(e) => setEditing({ ...edit, text: e.target.value })}
                        aria-label={`${i + 1}番目の項目`}
                        data-testid="rule-item-input"
                      />
                      {edit.conflict !== null && (
                        <p className="text-xs text-destructive" data-testid="rule-item-conflict">
                          ほかの画面で「{edit.conflict}」に直されました。この入力で保存し直すと置き換わります。
                        </p>
                      )}
                      <div className="flex gap-1.5">
                        <Button size="xs" onClick={() => save(item)} disabled={busy || !edit.text.trim()} data-testid="rule-item-save">
                          {busy ? <Loader2 className="animate-spin" /> : <Check />}
                          保存
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                          <X />
                          やめる
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm whitespace-pre-wrap" data-testid="rule-item-text">
                        {item.text}
                      </p>
                      <Origin item={item} withCustomer={target.scope === "global"} />
                    </>
                  )}
                </div>
                {!edit && (
                  <div className="flex shrink-0 gap-0.5">
                    <IconButton label="上へ" onClick={() => move(item, "up")} disabled={busy || i === 0} testId="rule-item-up">
                      <ArrowUp />
                    </IconButton>
                    <IconButton label="下へ" onClick={() => move(item, "down")} disabled={busy || i === items.length - 1} testId="rule-item-down">
                      <ArrowDown />
                    </IconButton>
                    <IconButton label="直す" onClick={() => setEditing({ id: item.id, text: item.text, conflict: null })} disabled={busy} testId="rule-item-edit">
                      <Pencil />
                    </IconButton>
                    <IconButton label="消す" onClick={() => remove(item)} disabled={busy} testId="rule-item-delete">
                      <Trash2 />
                    </IconButton>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <form onSubmit={add} className="flex items-start gap-2">
        <Textarea
          className="min-h-9 flex-1"
          rows={1}
          value={draft}
          maxLength={MAX_RULE_ITEM_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder="項目を足す"
          aria-label="足す項目"
          data-testid="rule-add-input"
        />
        <Button type="submit" size="lg" disabled={busy || !draft.trim()} data-testid="rule-add">
          <Plus />
          足す
        </Button>
      </form>
    </div>
  )
}

function Origin({ item, withCustomer }: { item: RuleItem; withCustomer: boolean }) {
  const label = originLabel(item, withCustomer)
  return (
    <p className="mt-0.5 text-xs text-muted-foreground" data-testid="rule-item-origin" data-source={item.source}>
      {item.origin ? (
        <Link to="/cases/$caseId" params={{ caseId: item.origin.caseId }} className="hover:underline">
          {label}
        </Link>
      ) : (
        label
      )}
    </p>
  )
}

function IconButton({ label, onClick, disabled, testId, children }: { label: string; onClick: () => void; disabled: boolean; testId: string; children: React.ReactNode }) {
  return (
    <Button size="icon-xs" variant="ghost" aria-label={label} title={label} onClick={onClick} disabled={disabled} data-testid={testId}>
      {children}
    </Button>
  )
}

import { useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Loader2, Sparkles, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { codeLabel } from "@/lib/spec/code-sets"
import type { FieldChoices } from "@/lib/spec/choices"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import { cn } from "@/lib/utils"
import { CellPicker } from "./cell-picker"
import { summaryText, type FixRun } from "./fix-suggestion"
import { FIX_LABELS, type FixKind } from "./status"

/**
 * 業種を決める一覧（作業の画面の「業種」のタブ）。業種が決まっていない行（空・エラー・要確認・AI の推定）のうち、
 * 載せる行と7割の選び直しで載りうる行（status.ts の gyoshuTodo）を1つの一覧にし、案のまままとめて決めるか、違う行だけ選ぶ欄で直す。
 * 業種がそろってから7割を選ぶので、決めたあとに載せる行が入れ替わっても、業種の決まっていない行は入ってこない。
 * 決めた行は一覧から消える（決めたことは取り消しの記録に残り、「取り消す」で戻る）
 */

/** 一覧の1行。plan は案（AI の案の変更案の未決の項目か、今の値〔AI の推定・要確認〕）と根拠 */
export type GyoshuItem = {
  key: string
  workName: string
  amount: string
  included: boolean
  kind: FixKind
  plan: { value: string; note: string } | null
  /** 行の今の値（選ぶ欄に渡す） */
  values: Readonly<Record<KojiFieldId, string>>
}

export type GyoshuDecision = { key: string; value: string }

export function GyoshuPanel({
  items,
  choices,
  onDecide,
  suggest,
  undo,
}: {
  items: readonly GyoshuItem[]
  choices: FieldChoices
  /** 決める（plan: 案のまま、pick: 選ぶ欄で選んだ値） */
  onDecide: (decisions: readonly GyoshuDecision[], how: "plan" | "pick") => void
  /** AI の案を頼む（案の無い行に）。blocked は押せない理由 */
  suggest: { run: (keys: readonly string[]) => void; blocked?: string; running: number | null; last: FixRun | null }
  /** 直前にこの一覧で決めたものを取り消す（取り消せるときだけ） */
  undo: { count: number; onUndo: () => void } | null
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [picking, setPicking] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // 一覧から消えた行（決めた行・載りえなくなった行）の選択は外す（取り消しで一覧に戻っても選ばれたままにしない）
  const live = useMemo(() => new Set(items.map((i) => i.key)), [items])
  if ([...checked].some((k) => !live.has(k))) setChecked(new Set([...checked].filter((k) => live.has(k))))
  const selected = [...checked].filter((k) => live.has(k))
  const withPlan = items.filter((i) => i.plan)
  const noPlan = items.filter((i) => !i.plan)
  const selectedWithPlan = withPlan.filter((i) => checked.has(i.key))
  const included = items.filter((i) => i.included).length

  const decidePlans = (list: readonly GyoshuItem[]) => {
    onDecide(
      list.map((i) => ({ key: i.key, value: i.plan!.value })),
      "plan",
    )
    setChecked(new Set())
  }
  /** 選ぶ欄で選んだあと: その行は一覧から消えるので、次の行の選ぶ欄にフォーカスを移す */
  const focusAfter = (key: string) => {
    const index = items.findIndex((i) => i.key === key)
    const next = items[index + 1] ?? items[index - 1]
    requestAnimationFrame(() => {
      const target = next && listRef.current?.querySelector<HTMLElement>(`li[data-key="${CSS.escape(next.key)}"] [data-testid="gyoshu-pick"]`)
      ;(target ?? document.querySelector<HTMLElement>('[data-testid="gyoshu-panel"]'))?.focus()
    })
  }
  const allChecked = items.length > 0 && selected.length === items.length

  if (!items.length)
    return (
      <div className="grid gap-3" data-testid="gyoshu-panel" tabIndex={-1}>
        <p className="flex items-center gap-2 text-sm text-emerald-800" data-testid="gyoshu-done">
          <Check className="size-4 text-emerald-600" /> 7割で載りうる行の業種は決まっています
        </p>
        {undo && <UndoButton undo={undo} />}
      </div>
    )

  return (
    <div className="grid gap-3 outline-none" data-testid="gyoshu-panel" tabIndex={-1}>
      <div className="grid gap-1">
        <p className="text-sm">
          業種を決める <span className="num font-medium" data-testid="gyoshu-count">{items.length}</span> 行
          <span className="text-muted-foreground">
            （載せる {included} 行{items.length > included ? `と、7割の選び直しで載りうる ${items.length - included} 行` : ""}）
          </span>
        </p>
        <p className="text-xs text-muted-foreground">業種を決めると7割で載せる行が入れ替わるので、載りうる行も先に決めます。違う行だけ右の欄で選んでください。</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="まとめて決める">
        {selected.length > 0 ? (
          <Button size="sm" disabled={!selectedWithPlan.length} onClick={() => decidePlans(selectedWithPlan)} data-testid="gyoshu-decide-selected">
            <Check /> 選んだ {selectedWithPlan.length} 行を案のまま決める
          </Button>
        ) : (
          withPlan.length > 0 && (
            <Button size="sm" onClick={() => decidePlans(withPlan)} data-testid="gyoshu-decide-all">
              <Check /> 案のある {withPlan.length} 行を案のまま決める
            </Button>
          )
        )}
        {noPlan.length > 0 && (
          <Button size="sm" variant="outline" disabled={!!suggest.blocked} title={suggest.blocked ?? "AI が工事名・元の記載・ほかの工事の業種の傾向から案と根拠を出します"} onClick={() => suggest.run(noPlan.map((i) => i.key))} data-testid="gyoshu-suggest">
            {suggest.running !== null ? <Loader2 className="animate-spin" /> : <Sparkles />}案の無い {noPlan.length} 行に AI で案を出す
          </Button>
        )}
        {undo && <UndoButton undo={undo} />}
      </div>
      {suggest.running !== null && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="gyoshu-suggest-running">
          <Loader2 className="size-3.5 animate-spin" /> {suggest.running} 行の業種の案を考えています…
        </p>
      )}
      {suggest.running === null && suggest.last && (
        <p className={cn("text-xs", suggest.last.error ? "text-red-700" : "text-muted-foreground")} data-testid="gyoshu-suggest-summary">
          {summaryText(suggest.last, true)}
          {suggest.last.error && ` ${suggest.last.failed.length} 行は AI を呼べませんでした（${suggest.last.error}）。`}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          <Checkbox aria-label="すべて選ぶ" checked={allChecked} indeterminate={selected.length > 0 && !allChecked} onCheckedChange={(v) => setChecked(v ? new Set(items.map((i) => i.key)) : new Set())} data-testid="gyoshu-check-all" />
          <span className="flex-1">工事名・金額</span>
          <span className="hidden w-56 sm:block">案・根拠</span>
          <span className="w-36 text-right sm:text-left">業種</span>
        </div>
        <ul ref={listRef} className="divide-y" data-testid="gyoshu-list">
          {items.map((i) => (
            <li key={i.key} data-key={i.key} data-testid="gyoshu-row" data-plan={i.plan?.value ?? ""} className="flex flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2 text-xs sm:flex-nowrap">
              <Checkbox
                className="mt-0.5"
                aria-label={`${i.workName || "工事名なし"}を選ぶ`}
                checked={checked.has(i.key)}
                onCheckedChange={(v) =>
                  setChecked((prev) => {
                    const next = new Set(prev)
                    if (v) next.add(i.key)
                    else next.delete(i.key)
                    return next
                  })
                }
                data-testid="gyoshu-check"
              />
              <div className="min-w-0 flex-1 basis-40">
                <p className="break-words">{i.workName || <span className="text-muted-foreground">（工事名なし）</span>}</p>
                <p className="text-muted-foreground">
                  <span className="num">{i.amount ? `${Number(i.amount).toLocaleString("ja-JP")} 千円` : "金額なし"}</span>
                  {!i.included && <span className="ml-1.5">・今は載せない</span>}
                  <span className="ml-1.5 text-amber-800">・{i.kind === "empty" ? "空" : FIX_LABELS[i.kind]}</span>
                </p>
              </div>
              <div className="min-w-0 basis-full pl-6 sm:w-56 sm:basis-auto sm:pl-0" data-testid="gyoshu-plan">
                {i.plan ? (
                  <>
                    <p>
                      案: <span className="num text-muted-foreground">{i.plan.value}</span> {codeLabel("gyoshu", i.plan.value)}
                    </p>
                    {i.plan.note && <p className="break-words text-muted-foreground" data-testid="gyoshu-note">{i.plan.note}</p>}
                  </>
                ) : (
                  <p className="text-muted-foreground">案なし</p>
                )}
              </div>
              <div className="ml-auto w-36 shrink-0">
                <button
                  type="button"
                  ref={picking === i.key ? setAnchor : undefined}
                  aria-haspopup="dialog"
                  aria-label={`業種を選ぶ（${i.workName || "工事名なし"}）`}
                  className="flex h-7 w-full items-center justify-between gap-1 rounded-md border bg-background px-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => setPicking(i.key)}
                  data-testid="gyoshu-pick"
                >
                  <span className="truncate">{i.plan ? `${i.plan.value} ${codeLabel("gyoshu", i.plan.value) ?? ""}` : <span className="text-muted-foreground">選ぶ</span>}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
                {picking === i.key && (
                  <CellPicker
                    anchor={anchor}
                    field="gyoshu"
                    label="業種"
                    choices={choices}
                    values={i.values}
                    onPick={(picked) => {
                      setPicking(null)
                      if (picked.gyoshu === undefined) return
                      onDecide([{ key: i.key, value: picked.gyoshu }], "pick")
                      focusAfter(i.key)
                    }}
                    onCancel={(restore) => {
                      setPicking(null)
                      if (restore) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`li[data-key="${CSS.escape(i.key)}"] [data-testid="gyoshu-pick"]`)?.focus())
                    }}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function UndoButton({ undo }: { undo: { count: number; onUndo: () => void } }) {
  return (
    <Button size="sm" variant="ghost" onClick={undo.onUndo} data-testid="gyoshu-undo">
      <Undo2 /> 直前に決めた {undo.count} 行を取り消す
    </Button>
  )
}

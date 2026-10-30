import { useMemo, useState } from "react"
import { diffChars } from "diff"
import { Check, CircleHelp, ListChecks, Undo2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import type { TableView } from "@/lib/cases/view"
import { describeChange } from "@/lib/chat/describe"
import { decisionOf, isAnswered, pendingOf, type ChatChange, type OpenProposal, type Proposal } from "@/lib/chat/proposals"
import { cn } from "@/lib/utils"
import type { MappingPlan } from "@/lib/convert/plan"
import { beforeOf, describePlanPatch } from "@/lib/convert/plan-patch"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"

/** 変更案の承認を取り消せるか（cases/undo.ts の記録から）。can は戻せる記録がある、undone は取り消した、external は戻さない外への書き込み */
export type UndoState = { can: boolean; undone: boolean; tooLarge: boolean; external: ("rule" | "location")[] }

export type ProposalActions = {
  decide: (id: string, indices: number[], decision: "applied" | "rejected") => void
  answer: (id: string, a: "yes" | "no") => void
  /** 承認を取り消す（その変更案の、まだ取り消していない承認をすべて） */
  undo?: (id: string) => void
  undoState?: (id: string) => UndoState | null
  /** 指示を送れるか（変更案の無い聞き返しの答えは AI に送るので、送れない間は答えられない） */
  canSend: boolean
}

const DECISION_LABEL = { pending: "", applied: "反映済み", rejected: "却下" } as const

/**
 * 返事に付いた変更案。聞き返しがあれば先に目立たせ（Confirmation）、答えるまで承認できない。
 * 一覧（Dialog）で項目ごとに承認・却下でき、ここではまとめて承認・却下できる
 */
export function ProposalCard({
  proposal,
  changes,
  view,
  actions,
  busy,
  plan,
}: {
  proposal: Proposal | undefined
  /** 変更の中身（開いている変更案だけ手元にある） */
  changes: readonly ChatChange[] | undefined
  view: TableView | null
  actions: ProposalActions
  busy: boolean
  /** 今の列の対応（列の対応の変更案を「今 → 案」で出す） */
  plan?: MappingPlan<KojiFieldId> | null
}) {
  const [open, setOpen] = useState(false)
  if (!proposal) return <p className="text-xs text-muted-foreground">この変更案は今の案件にはありません（変換の元を変えたなど）。</p>
  const question = proposal.question
  const waiting = question !== null && question.answer === null

  if (proposal.state === "closed") {
    return (
      <div className="space-y-2">
        {question && <QuestionBox question={question.text} answered={question.answer} />}
        <p className="text-xs text-muted-foreground" data-testid="proposal-closed">
          変更案: 反映 {proposal.applied} 件・却下 {proposal.rejected} 件
        </p>
        <UndoLine id={proposal.id} actions={actions} busy={busy} />
      </div>
    )
  }

  if (!changes || changes.length !== proposal.count) return <p className="text-xs text-muted-foreground">この変更案の中身を読めませんでした。再読み込みしてください。</p>
  const pending = pendingOf(proposal)
  const counts = countKinds(changes)
  return (
    <div className="space-y-2" data-testid="proposal" data-proposal={proposal.id}>
      {question && (
        <QuestionBox
          question={question.text}
          answered={question.answer}
          onAnswer={waiting ? (a) => actions.answer(proposal.id, a) : undefined}
          hasChanges={proposal.count > 0}
          disabled={proposal.count === 0 && !actions.canSend}
        />
      )}
      {changes.some((c) => c.kind === "plan") && (
        <ul className="list-disc space-y-0.5 rounded-lg border bg-muted/20 py-1.5 pr-2 pl-6 text-xs" data-testid="proposal-plan">
          {changes.flatMap((c) => (c.kind === "plan" ? describePlanPatch(c.patch, c.before ?? (plan ? beforeOf(plan, c.patch) : undefined)) : [])).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
          <li className="list-none text-muted-foreground">承認すると変換し直します（手直しはそのまま重なります）。</li>
        </ul>
      )}
      {changes.length > 0 && (
        <Item variant="outline" size="sm" className="bg-violet-50/40">
          <ItemMedia variant="icon">
            <ListChecks className="text-violet-600" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>変更案（未決 {pending.length} 件）</ItemTitle>
            <ItemDescription>{counts}</ItemDescription>
          </ItemContent>
          <ItemActions className="w-full justify-end">
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="proposal-open">
              一覧で確かめる
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !pending.length} onClick={() => actions.decide(proposal.id, pending, "rejected")} data-testid="proposal-reject-all">
              <X /> まとめて却下
            </Button>
            <Button size="sm" disabled={busy || !pending.length || !isAnswered(proposal)} onClick={() => actions.decide(proposal.id, pending, "applied")} data-testid="proposal-apply-all">
              <Check /> まとめて承認
            </Button>
          </ItemActions>
        </Item>
      )}
      <UndoLine id={proposal.id} actions={actions} busy={busy} />
      {view && <ProposalDialog open={open} onOpenChange={setOpen} proposal={proposal} changes={changes} view={view} actions={actions} busy={busy} plan={plan} />}
    </div>
  )
}

const EXTERNAL_LABELS = { rule: "ルールの項目", location: "顧客の覚えた工事場所" } as const

/** 承認を取り消すボタンと、取り消しても戻らないもの */
function UndoLine({ id, actions, busy }: { id: string; actions: ProposalActions; busy: boolean }) {
  const u = actions.undoState?.(id)
  if (!u || !actions.undo) return null
  const external = u.external.map((e) => EXTERNAL_LABELS[e]).join("・")
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="proposal-undo-line">
      {u.can && (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => actions.undo!(id)} data-testid="proposal-undo">
          <Undo2 /> 承認を取り消す
        </Button>
      )}
      {u.undone && !u.can && <span data-testid="proposal-undone">承認を取り消しました</span>}
      {u.tooLarge && <span>変更が大きいので、この承認は取り消せません</span>}
      {external && <span>{external}は取り消しても残ります（全体ルール・顧客の画面で直してください）</span>}
    </div>
  )
}

function countKinds(changes: readonly ChatChange[]) {
  const n = { cell: 0, ask: 0, include: 0, add: 0, settings: 0, rule: 0, location: 0, plan: 0 }
  for (const c of changes) n[c.kind]++
  return [
    n.cell && `セル ${n.cell}`,
    n.ask && `問い合わせ ${n.ask}`,
    n.include && `載せる・外す ${n.include}`,
    n.add && `工事を足す ${n.add}`,
    n.settings && "7割の設定",
    n.rule && `ルールの項目 ${n.rule}`,
    n.location && `工事場所 ${n.location}現場`,
    n.plan && "列の対応",
  ]
    .filter(Boolean)
    .join("・")
}

/** AI の聞き返し。変更案があるなら「はい」で承認できるようになり、「いいえ」で全部を却下する */
function QuestionBox({
  question,
  answered,
  onAnswer,
  hasChanges,
  disabled = false,
}: {
  question: string
  answered: "yes" | "no" | null
  onAnswer?: (a: "yes" | "no") => void
  hasChanges?: boolean
  disabled?: boolean
}) {
  return (
    <Item variant="outline" size="sm" className={cn(answered === null ? "border-amber-300 bg-amber-50" : "bg-muted/30")} data-testid="confirmation" data-answered={answered ?? undefined}>
      <ItemMedia variant="icon">
        <CircleHelp className="text-amber-600" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="whitespace-pre-wrap">{question}</ItemTitle>
        <ItemDescription>
          {answered === null
            ? hasChanges
              ? "答えるまで、この変更案は承認できません。"
              : "答えると AI が続けます。"
            : answered === "yes"
              ? "「はい」と答えました。"
              : "「いいえ」と答えました。"}
        </ItemDescription>
      </ItemContent>
      {onAnswer && (
        <ItemActions>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAnswer("no")} data-testid="confirmation-no">
            いいえ
          </Button>
          <Button size="sm" disabled={disabled} onClick={() => onAnswer("yes")} data-testid="confirmation-yes">
            はい
          </Button>
        </ItemActions>
      )}
    </Item>
  )
}

/** 差分の一覧。項目ごとに承認・却下する */
function ProposalDialog({
  open,
  onOpenChange,
  proposal,
  changes,
  view,
  actions,
  busy,
  plan,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  proposal: OpenProposal
  changes: readonly ChatChange[]
  view: TableView
  actions: ProposalActions
  busy: boolean
  plan?: MappingPlan<KojiFieldId> | null
}) {
  const byKey = useMemo(() => new Map(view.shown.map((r) => [r.key, r])), [view])
  const lines = useMemo(() => (open ? changes.map((c) => describeChange(c, view, byKey, plan)) : []), [open, changes, view, byKey, plan])
  const answered = isAnswered(proposal)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-4xl" data-testid="proposal-dialog">
        <DialogHeader>
          <DialogTitle>変更案の一覧</DialogTitle>
          <DialogDescription>左が今の値、右が承認したあとの値です。承認したものだけが表に入ります。{!answered && "（聞き返しに答えるまで承認できません）"}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">場所</th>
                <th className="px-2 py-1.5 text-left font-medium">項目</th>
                <th className="px-2 py-1.5 text-left font-medium">今</th>
                <th className="px-2 py-1.5 text-left font-medium">承認したあと</th>
                <th className="w-40 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const decision = decisionOf(proposal, i)
                return (
                  <tr key={i} className={cn("border-t align-top", decision !== "pending" && "opacity-60")} data-testid="proposal-item" data-decision={decision}>
                    <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{l.where}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{l.what}</td>
                    {l.values ? (
                      <ValueDiff from={l.from} to={l.to} />
                    ) : (
                      <>
                        <td className="px-2 py-1 text-red-700 line-through decoration-red-300">{l.from}</td>
                        <td className="px-2 py-1 whitespace-pre-wrap text-emerald-700">
                          {l.to}
                          {l.links?.map((href) => (
                            <a key={href} href={href} target="_blank" rel="noreferrer noopener" className="block truncate text-blue-700 underline" data-testid="proposal-link">
                              {href}
                            </a>
                          ))}
                        </td>
                      </>
                    )}
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      {decision === "pending" ? (
                        <>
                          <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.decide(proposal.id, [i], "rejected")} data-testid="proposal-item-reject">
                            却下
                          </Button>
                          <Button size="xs" variant="outline" disabled={busy || !answered} onClick={() => actions.decide(proposal.id, [i], "applied")} data-testid="proposal-item-apply">
                            承認
                          </Button>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{DECISION_LABEL[decision]}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** セルの値の文字の差分（jsdiff）。今の値では消える文字を赤、承認したあとの値では増える文字を緑にする */
function ValueDiff({ from, to }: { from: string; to: string }) {
  const parts = diffChars(from, to)
  return (
    <>
      <td className="px-2 py-1 whitespace-pre-wrap" data-testid="diff-from">
        {parts.map((p, i) =>
          p.added ? null : (
            <span key={i} className={p.removed ? "rounded-sm bg-red-100 text-red-800 line-through decoration-red-400" : "text-muted-foreground"} data-diff={p.removed ? "removed" : undefined}>
              {p.value}
            </span>
          ),
        )}
      </td>
      <td className="px-2 py-1 whitespace-pre-wrap" data-testid="diff-to">
        {parts.map((p, i) =>
          p.removed ? null : (
            <span key={i} className={p.added ? "rounded-sm bg-emerald-100 text-emerald-800" : "text-muted-foreground"} data-diff={p.added ? "added" : undefined}>
              {p.value}
            </span>
          ),
        )}
      </td>
    </>
  )
}

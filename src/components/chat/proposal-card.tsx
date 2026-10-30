import { useMemo, useState } from "react"
import { diffChars } from "diff"
import { Check, CircleHelp, ListChecks, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import type { TableView } from "@/lib/cases/view"
import { describeChange } from "@/lib/chat/describe"
import { decisionOf, isAnswered, pendingOf, type ChatChange, type OpenProposal, type Proposal } from "@/lib/chat/proposals"
import { cn } from "@/lib/utils"

export type ProposalActions = {
  decide: (id: string, indices: number[], decision: "applied" | "rejected") => void
  answer: (id: string, a: "yes" | "no") => void
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
}: {
  proposal: Proposal | undefined
  /** 変更の中身（開いている変更案だけ手元にある） */
  changes: readonly ChatChange[] | undefined
  view: TableView | null
  actions: ProposalActions
  busy: boolean
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
      {view && <ProposalDialog open={open} onOpenChange={setOpen} proposal={proposal} changes={changes} view={view} actions={actions} busy={busy} />}
    </div>
  )
}

function countKinds(changes: readonly ChatChange[]) {
  const n = { cell: 0, ask: 0, include: 0, add: 0, settings: 0, rule: 0, location: 0 }
  for (const c of changes) n[c.kind]++
  return [
    n.cell && `セル ${n.cell}`,
    n.ask && `問い合わせ ${n.ask}`,
    n.include && `載せる・外す ${n.include}`,
    n.add && `工事を足す ${n.add}`,
    n.settings && "7割の設定",
    n.rule && `ルールの追記 ${n.rule}`,
    n.location && `工事場所 ${n.location}現場`,
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  proposal: OpenProposal
  changes: readonly ChatChange[]
  view: TableView
  actions: ProposalActions
  busy: boolean
}) {
  const byKey = useMemo(() => new Map(view.shown.map((r) => [r.key, r])), [view])
  const lines = useMemo(() => (open ? changes.map((c) => describeChange(c, view, byKey)) : []), [open, changes, view, byKey])
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

import { useRef, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { AppShell, PageHeader } from "@/components/app-shell"
import { Segmented } from "@/components/segmented"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUSES,
  MAX_FEEDBACK_TEXT,
  type FeedbackInput,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
} from "@/lib/feedback/feedback"
import { addFeedbackFn, listFeedbackFn, setFeedbackStatusFn, type FeedbackResult } from "@/server/feedback-fns"

export const Route = createFileRoute("/_authed/feedback")({
  loader: () => listFeedbackFn({ data: { status: "open" } }),
  component: FeedbackPage,
})

type Filter = FeedbackStatus | "all"
const FILTERS: readonly { value: Filter; label: string }[] = [...FEEDBACK_STATUSES.map((s) => ({ value: s, label: FEEDBACK_STATUS_LABELS[s] })), { value: "all", label: "すべて" }]
const statusOf = (f: Filter) => (f === "all" ? null : f)
const EMPTY = { kind: "missing" as FeedbackKind, want: "", did: "", idea: "" }
const FIELDS = [
  { key: "want", label: "したかったこと" },
  { key: "did", label: "今どうしたか" },
  { key: "idea", label: "あると良い機能" },
] as const satisfies readonly { key: keyof Omit<FeedbackInput, "kind">; label: string }[]

/** 要望の一覧（チャットの AI と職員が残した「あると良い機能」）。新しい順。状態で絞り、項目ごとに状態を変え、職員も書き足せる */
function FeedbackPage() {
  const initial = Route.useLoaderData()
  const [items, setItems] = useState(initial)
  const [loaded, setLoaded] = useState(initial)
  if (initial !== loaded) {
    setLoaded(initial)
    setItems(initial)
  }
  const [filter, setFilter] = useState<Filter>("open")
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [draft, setDraft] = useState(EMPTY)
  const [adding, setAdding] = useState(false)

  async function run(op: () => Promise<FeedbackResult | FeedbackItem[]>) {
    if (sending.current) return false
    sending.current = true
    setBusy(true)
    try {
      const r = await op()
      if (Array.isArray(r)) {
        setItems(r)
        return true
      }
      setItems(r.items)
      if (!r.ok) toast.error(r.message)
      return r.ok
    } catch (e) {
      toast.error(errorMessage(e, "要望を保存できませんでした"))
      return false
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  async function changeFilter(next: Filter) {
    if (await run(() => listFeedbackFn({ data: { status: statusOf(next) } }))) setFilter(next)
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (FIELDS.some((f) => !draft[f.key].trim())) return
    if (await run(() => addFeedbackFn({ data: { input: draft, status: statusOf(filter) } }))) {
      setDraft(EMPTY)
      setAdding(false)
    }
  }

  return (
    <AppShell>
      <PageHeader
        title="要望"
        description="チャットの AI と職員が残した「あると良い機能」。開発者が読んで機能を足します。"
        actions={
          !adding && (
            <Button variant="outline" onClick={() => setAdding(true)} data-testid="feedback-new">
              <Plus /> 書き足す
            </Button>
          )
        }
      />
      <div className="grid max-w-3xl gap-4">
        {adding && (
          <form onSubmit={add} className="grid gap-3 rounded-lg border p-4" data-testid="feedback-form">
            <div className="flex flex-wrap items-center gap-3">
              <Label>種類</Label>
              <Segmented
                label="種類"
                value={draft.kind}
                options={FEEDBACK_KINDS.map((k) => ({ value: k, label: FEEDBACK_KIND_LABELS[k] }))}
                onChange={(kind) => setDraft({ ...draft, kind })}
                testId="feedback-form-kind"
              />
            </div>
            {FIELDS.map((f) => (
              <div key={f.key} className="grid gap-1.5">
                <Label htmlFor={`feedback-${f.key}`}>{f.label}</Label>
                <Input id={`feedback-${f.key}`} value={draft[f.key]} maxLength={MAX_FEEDBACK_TEXT} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} data-testid={`feedback-form-${f.key}`} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">顧客名・工事名・個人名は書かないでください。</p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || FIELDS.some((f) => !draft[f.key].trim())} data-testid="feedback-form-submit">
                {busy && <Loader2 className="animate-spin" />}足す
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                やめる
              </Button>
            </div>
          </form>
        )}
        <Segmented label="状態で絞る" value={filter} options={FILTERS} onChange={changeFilter} testId="feedback-filter" />
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="feedback-empty">
            {filter === "all" ? "要望はまだありません。" : `${FILTERS.find((f) => f.value === filter)!.label}の要望はありません。`}
          </p>
        ) : (
          <ul className="grid gap-3" data-testid="feedback-list">
            {items.map((item) => (
              <FeedbackRow key={item.id} item={item} onStatus={(to) => run(() => setFeedbackStatusFn({ data: { id: item.id, to, status: statusOf(filter) } }))} />
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  )
}

function FeedbackRow({ item, onStatus }: { item: FeedbackItem; onStatus: (to: FeedbackStatus) => void }) {
  return (
    <li className="grid gap-2 rounded-lg border p-4" data-testid="feedback-item" data-id={item.id}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">{FEEDBACK_KIND_LABELS[item.kind]}</Badge>
        {item.count > 1 && (
          <span className="font-medium text-foreground" data-testid="feedback-count">
            {item.count}回
          </span>
        )}
        <span>{item.source === "ai" ? "AI" : "職員"}</span>
        <span>{new Date(item.createdAt).toLocaleDateString("ja-JP")}</span>
        {item.caseId && item.caseLabel && (
          <Link to="/cases/$caseId" params={{ caseId: item.caseId }} className="underline underline-offset-2 hover:text-foreground" data-testid="feedback-case">
            {item.caseLabel}
          </Link>
        )}
      </div>
      <p className="font-medium">{item.want}</p>
      <dl className="grid gap-1 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="text-muted-foreground">今</dt>
        <dd>{item.did}</dd>
        <dt className="text-muted-foreground">あると良い</dt>
        <dd>{item.idea}</dd>
      </dl>
      <Segmented
        label="状態"
        value={item.status}
        options={FEEDBACK_STATUSES.map((s) => ({ value: s, label: FEEDBACK_STATUS_LABELS[s] }))}
        onChange={onStatus}
        testId="feedback-status"
      />
    </li>
  )
}

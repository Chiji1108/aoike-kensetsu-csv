import { useRef, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { z } from "zod"
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

type Filter = FeedbackStatus | "all"
/** 絞り込みは URL に持つ（開き直しても・戻っても、表示と絞り込みが食い違わない）。はじめは未対応 */
const searchSchema = z.object({ status: z.enum([...FEEDBACK_STATUSES, "all"]).catch("open").default("open") })

export const Route = createFileRoute("/_authed/feedback")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ status: search.status }),
  loader: ({ deps }) => listFeedbackFn({ data: { status: statusOf(deps.status) } }),
  component: FeedbackPage,
})
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
  const filter: Filter = Route.useSearch().status
  const navigate = useNavigate({ from: Route.fullPath })
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

  /** 絞り込みを変える（URL を変え、loader が読み直す） */
  const changeFilter = (next: Filter) => navigate({ search: { status: next } })

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (FIELDS.some((f) => !draft[f.key].trim())) return
    // 足した要望は未対応なので、対応済み・しないで絞っているときは未対応に切り替えて見せる
    const shown: Filter = filter === "all" ? "all" : "open"
    if (await run(() => addFeedbackFn({ data: { input: draft, status: statusOf(shown) } }))) {
      setDraft(EMPTY)
      setAdding(false)
      if (shown !== filter) await navigate({ search: { status: shown } })
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

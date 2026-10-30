import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, MapPin, Square } from "lucide-react"
import { toast } from "sonner"
import { ProposalCard, type ProposalActions } from "@/components/chat/proposal-card"
import { Cost } from "@/components/cost"
import { Button } from "@/components/ui/button"
import type { TableView } from "@/lib/cases/view"
import type { ChatChange, Proposal, ProposalRecord } from "@/lib/chat/proposals"
import { errorMessage } from "@/lib/errors"
import type { UsdJpy } from "@/lib/fx"
import type { CaseTableWire } from "@/lib/chat/wire"
import { estimateUsd, MAX_SITES_PER_RUN, runSitesOf } from "@/lib/location/sites"
import { getLocationRunFn, memorizedSitesFn, startLocationSearchFn, stopLocationSearchFn } from "@/server/location-fns"

/** 走っている回の進み具合を読み直す間隔 */
const POLL_MS = 3_000

type RunProgress = NonNullable<Awaited<ReturnType<typeof getLocationRunFn>>["run"]>

/**
 * 工事場所の一括調査（案件の画面とチャットの「調べ始める」が共有する）。調べる現場は今の表から集め（lib/location/sites.ts）、
 * 覚えた結果のある現場を数えて件数と費用の目安を出す。職員が「調べ始める」を押すと裏の処理（Workflow）が始まり、数秒ごとに進み具合を読む。
 * 終わった回の変更案は onRecord で案件の作業に足す（開き直したときは案件の画面が R2 から読む）
 */
export function useLocationSearch({
  caseId,
  view,
  table,
  undecided,
  onRecord,
  onCaseCost,
}: {
  caseId: string
  view: TableView | null
  /** 始めるときに送る今の表（サーバーが同じ決め方で現場を作り直す。画面の現場の値は送らない） */
  table: () => CaseTableWire | null
  /** 前の調査の変更案がまだ決まっていない（決めるまで始めさせない。同じ現場を二重に調べない） */
  undecided: boolean
  onRecord: (r: ProposalRecord) => void
  /** 案件の費用の合計（D1）。チャットと同じく合計で置き換える */
  onCaseCost: (usd: number) => void
}) {
  const runOf = useMemo(() => (view ? runSitesOf(view) : { sites: [], over: 0 }), [view])
  const sites = runOf.sites
  const keysSig = sites.map((s) => s.key).join("\n")
  const [memorized, setMemorized] = useState<ReadonlySet<string> | null>(null)
  const [run, setRun] = useState<RunProgress | null>(null)
  /** 走っている回の裏の処理がもう動いていない（もう一度始められる。始めるときにサーバーが回を「失敗」にする） */
  const [lost, setLost] = useState(false)
  const [starting, setStarting] = useState(false)
  const live = useRef({ onRecord, onCaseCost, table })
  live.current = { onRecord, onCaseCost, table }

  useEffect(() => {
    let alive = true
    const keys = keysSig ? keysSig.split("\n") : []
    if (!keys.length) {
      setMemorized(new Set())
      return
    }
    setMemorized(null)
    // 表を直している間に何度も聞かないよう、少し待ってから聞く
    const timer = setTimeout(() => {
      void memorizedSitesFn({ data: { caseId, keys } }).then(
        (r) => alive && setMemorized(new Set(r.keys)),
        () => alive && setMemorized(new Set()),
      )
    }, 400)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [caseId, keysSig])

  async function refresh() {
    const r = await getLocationRunFn({ data: { caseId } })
    if (r.caseUsd !== null) live.current.onCaseCost(r.caseUsd)
    setLost(r.lost)
    setRun(r.run)
    if (r.record) live.current.onRecord(r.record)
    return r.run
  }

  const running = run?.status === "running" && !lost
  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [caseId])
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void refresh().catch(() => undefined), POLL_MS)
    return () => clearInterval(timer)
  }, [running, caseId])

  async function start() {
    if (!sites.length || starting || running || undecided) return
    setStarting(true)
    try {
      const t = live.current.table()
      if (!t) return
      await startLocationSearchFn({ data: { caseId, table: t } })
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e, "工事場所の調査を始められませんでした"))
      await refresh().catch(() => undefined)
    } finally {
      setStarting(false)
    }
  }

  async function stop() {
    if (!run) return
    try {
      await stopLocationSearchFn({ data: { caseId, runId: run.id } })
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e, "止められませんでした"))
    }
  }

  const known = memorized ? sites.filter((s) => memorized.has(s.key)).length : null
  return {
    sites: sites.length,
    over: runOf.over,
    skipped: sites.filter((s) => s.skip).length,
    memorized: known,
    usd: memorized ? estimateUsd(sites, memorized) : null,
    run,
    lost,
    running,
    starting,
    undecided,
    start,
    stop,
  }
}

export type LocationSearch = ReturnType<typeof useLocationSearch>

/** 件数・目安・始めるボタン、または進み具合（案件の画面とチャットの返事で同じものを出す） */
export function LocationSearchStatus({ search, fx, testId }: { search: LocationSearch; fx: UsdJpy | null; testId: string }) {
  const { run } = search
  if (search.running && run)
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid={`${testId}-progress`}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span>
          工事場所を調べています: {run.total}件中{run.done}件（Web 検索 {run.searches} 回・<Cost usd={run.usd} fx={fx} />）
          {run.stopRequested && "。止めています（調べている現場が終わるまで待ちます）"}
        </span>
        {!run.stopRequested && (
          <Button size="xs" variant="outline" onClick={() => void search.stop()} data-testid={`${testId}-stop`}>
            <Square /> 止める
          </Button>
        )}
      </div>
    )
  return (
    <div className="grid gap-1.5 text-sm">
      {search.lost && (
        <p className="text-red-700" data-testid={`${testId}-lost`}>
          前の調査の裏の処理が途中で止まりました。もう一度始めてください（調べ終えた現場の費用は案件に足してあります）。
        </p>
      )}
      {run && run.status !== "running" && (
        <p className={run.status === "failed" ? "text-red-700" : "text-muted-foreground"} data-testid={`${testId}-last`}>
          {run.status === "failed"
            ? `前の調査は途中で止まりました: ${run.error ?? ""}`
            : `前の調査: ${run.total}件中${run.done}件を調べました${run.status === "stopped" ? "（止めました）" : ""}（Web 検索 ${run.searches} 回・`}
          {run.status !== "failed" && (
            <>
              <Cost usd={run.usd} fx={fx} />）
            </>
          )}
        </p>
      )}
      {search.sites === 0 ? (
        <p className="text-muted-foreground" data-testid={`${testId}-none`}>
          場所が空いている・推定に自信の無い現場はありません。
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid={`${testId}-count`}>
            場所が空いている・推定に自信の無い現場 {search.sites} 件
            {search.memorized === null ? "" : `（前の年度に承認した結果 ${search.memorized} 件・個人名などで調べない ${search.skipped} 件）`}。費用の目安{" "}
            {search.usd === null ? "…" : <Cost usd={search.usd} fx={fx} />}
            {search.over > 0 && `。1回に ${MAX_SITES_PER_RUN} 件までなので、残り ${search.over} 件は次の回で`}
          </span>
          <Button size="sm" disabled={search.starting || search.usd === null || search.undecided} onClick={() => void search.start()} data-testid={`${testId}-start`}>
            {search.starting ? <Loader2 className="animate-spin" /> : <MapPin />} 調べ始める
          </Button>
          {search.undecided && <span className="text-xs text-muted-foreground">前の調査の変更案を決めると、残りを調べられます。</span>}
        </div>
      )}
    </div>
  )
}

/** 案件の画面の「工事場所を調べる」。結果の変更案（出どころが調査のもの）もここに出す */
export function LocationPanel({
  search,
  view,
  proposals,
  changes,
  actions,
  busy,
  fx,
}: {
  search: LocationSearch
  view: TableView
  proposals: readonly Proposal[]
  changes: ReadonlyMap<string, readonly ChatChange[]>
  actions: Omit<ProposalActions, "canSend">
  busy: boolean
  fx: UsdJpy | null
}) {
  return (
    <div className="grid gap-3 rounded-xl border bg-muted/20 p-3" data-testid="location-panel">
      <h3 className="text-sm font-semibold">工事場所を調べる</h3>
      <p className="text-xs text-muted-foreground">
        CSV に載せる行のうち、都道府県が空か、AI の推定に自信の無い行の現場を、工事名と注文者でまとめて調べます。前の年度に承認した結果 → AI の知識 → Web 検索の順で、検索は裏で進みます（画面を閉じても続きます）。
        外に送るのは CSV に出す工事名と注文者だけで、個人名のある現場は調べずに顧客への問い合わせに回します。結果は変更案になり、承認すると要確認（黄色）で根拠の URL を添えて入ります。
      </p>
      <LocationSearchStatus search={search} fx={fx} testId="location" />
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} changes={changes.get(p.id)} view={view} actions={{ ...actions, canSend: true }} busy={busy} />
      ))}
    </div>
  )
}

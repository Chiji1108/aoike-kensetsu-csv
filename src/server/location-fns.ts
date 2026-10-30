import { env } from "cloudflare:workers"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { getDb } from "@/db"
import { deriveTable } from "@/lib/cases/view"
import { fromWire, caseTableWireSchema } from "@/lib/chat/wire"
import { guardPersonal, runSitesOf } from "@/lib/location/sites"
import { personalChecker } from "./location-guard"
import { locationItems } from "@/lib/location/changes"
import { errorMessage } from "@/lib/errors"
import * as store from "./case-store"
import { readProposal } from "./chat"
import * as loc from "./location-store"
import { authMiddleware } from "./middleware"

const caseId = z.string().min(1).max(64)

/** 顧客の覚えた結果がある現場（始める前の件数と費用の目安に使う） */
export const memorizedSitesFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId, keys: z.array(z.string().min(1).max(1100)).max(5_000) }))
  .handler(async ({ data }) => {
    const db = getDb()
    const kase = await store.getCase(db, data.caseId)
    if (!kase || kase.deleting) throw new Error("案件が見つかりません")
    return { keys: [...(await loc.memorized(db, kase.customerId, data.keys)).keys()] }
  })

/**
 * 一括調査を始める（職員が件数と費用の目安を見て押す）。調べる現場は、画面が送った今の表からサーバーが作り直す
 * （画面と同じ決め方 runSitesOf。個人名の判定もここでやり直すので、画面の現場の値や「調べない」の印は信じない）。
 * 回と現場を D1 に書き、Workflow のインスタンスを回の id で作る。作れなければ回を「失敗」にして投げる（走っている印を残さない）
 */
export const startLocationSearchFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId, table: caseTableWireSchema }))
  .handler(async ({ data }) => {
    if (!env.ANTHROPIC_API_KEY) throw new Error("APIキー未設定（ANTHROPIC_API_KEY）のため、工事場所は調べられません")
    const db = getDb()
    const kase = await store.getCase(db, data.caseId)
    if (!kase || kase.deleting) throw new Error("案件が見つかりません")
    // 前の回が「走っている」ままで裏の処理がもう動いていなければ、ここで「失敗」にしてから始める（読むだけの呼び出しでは書かない）
    const last = await loc.latestRun(db, data.caseId)
    if (last?.status === "running" && (await lostStatus(last.id))) await loc.failRun(db, last.id, LOST_MESSAGE)
    // 個人名はサーバーに保存した作業からも確かめる（届いた表の印だけに頼らない。確かめられない現場は送らない）
    const has = await personalChecker(db, data.caseId, data.table)
    const sites = guardPersonal(runSitesOf(deriveTable(fromWire(data.table))).sites, has)
    if (!sites.length) throw new Error("場所が空いている・推定に自信の無い現場はありません")
    const created = await loc.createRun(db, data.caseId, sites)
    if (!created.ok)
      throw new Error(created.reason === "busy" ? "この案件はもう調べています（終わるか止めてから始めてください）" : created.reason === "gone" ? "案件が見つかりません" : "調べる現場の数が正しくありません")
    try {
      await env.LOCATION_SEARCH.create({ id: created.run.id, params: { runId: created.run.id, caseId: data.caseId } })
    } catch (e) {
      await loc.failRun(db, created.run.id, "裏の処理を始められませんでした")
      throw new Error(errorMessage(e, "裏の処理を始められませんでした"))
    }
    return { runId: created.run.id }
  })

const LOST_MESSAGE = "裏の処理が途中で止まりました。もう一度始めてください（調べ終えた現場の費用は案件に足してあります）"

/** 裏の処理がもう動いていないか（落ちた・止められた・終わったのに回が「走っている」まま）。状態を読めなかったときは決めない */
async function lostStatus(runId: string) {
  const status = await env.LOCATION_SEARCH.get(runId).then(
    (i) => i.status().then((s) => s.status),
    () => null,
  )
  return status === "errored" || status === "terminated" || status === "complete"
}

/**
 * 案件のいちばん新しい回の進み具合（画面が数秒ごとに読む。読むだけで書かない）。終わった回は置いた変更案の記録も返す（画面がまだ持っていなければ足す）。
 * 走っている回の裏の処理がもう動いていなければ lost（画面は「止まっています」と出し、もう一度始められる。始めるときに回を「失敗」にする）。
 * 案件が無いか削除中なら何も返さない
 */
export const getLocationRunFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId }))
  .handler(async ({ data }) => {
    const db = getDb()
    const kase = await store.getCase(db, data.caseId)
    if (!kase || kase.deleting) return { run: null, record: null, caseUsd: null, lost: false }
    const run = await loc.latestRun(db, data.caseId)
    // 案件の費用の合計も返す（画面は合計で置き換える。チャットの返事と同じ元）
    if (!run) return { run: null, record: null, caseUsd: kase.costUsd, lost: false }
    const lost = run.status === "running" && (await lostStatus(run.id))
    const record = run.status !== "running" && run.proposalId ? ((await readProposal(data.caseId, run.proposalId)) ?? null) : null
    return { run, record, caseUsd: kase.costUsd, lost }
  })

/** 止める（残りの現場は調べず、調べ終えた分で変更案を出す） */
export const stopLocationSearchFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId, runId: z.string().min(1).max(64) }))
  .handler(async ({ data }) => ({ stopped: await loc.requestStop(getDb(), data.caseId, data.runId) }))

/**
 * 工事場所の項目を承認する（ルールの追記の approveRuleFn と同じく、承認の処理そのもの）。中身はサーバーの変更案の記録（R2）から読み、
 * 工事場所の項目だけを顧客の覚えた結果に書く（画面の値は使わない）。書けたら画面がその項目を承認済みにして表に重ねる。
 * 書けなければ承認しない（承認したのに覚えていない、を作らない）。同じ項目を二度承認しても上書きするだけ
 */
export const approveLocationsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ caseId, proposalId: z.string().min(1).max(64), items: z.array(z.number().int().min(0)).min(1).max(20_000) }))
  .handler(async ({ data }) => {
    const db = getDb()
    const kase = await store.getCase(db, data.caseId)
    const record = await readProposal(data.caseId, data.proposalId)
    if (!kase || kase.deleting || !record || record.proposal.state !== "open") throw new Error("変更案が見つかりません")
    const items = locationItems(record, data.items)
    if (!items) throw new Error("変更案の工事場所の項目が見つかりません")
    return { remembered: await loc.remember(db, data.caseId, items) }
  })

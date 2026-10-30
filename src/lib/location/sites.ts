import { z } from "zod"
import type { TableView } from "../cases/view"
import type { CellResult } from "../convert/convert"
import { hasPersons } from "../convert/persons"
import { collapseSpaces, nfkc, removeSpaces } from "../convert/text"
import { INFERRED_NOTE } from "../convert/transforms"

/**
 * 工事場所を調べる（P5）。CSV に載せる行のうち、都道府県が空か、場所が AI の推定で自信の無い行の現場を、工事名と注文者でまとめて調べる。
 * 調べ方は 覚えた結果（顧客ごとの D1）→ AI の知識 → Web 検索 の順（server/location.ts）。ここは画面とサーバーの両方が使う決まった処理
 */

/** 1回の一括調査で調べる現場の数の上限（費用と時間の上限。超えた分は次の回に回す） */
export const MAX_SITES_PER_RUN = 100

/** 費用の目安（1現場あたり。照合の例A で測った値を丸めたもの。始める前に職員に見せる） */
export const ESTIMATE_USD = { knowledge: 0.003, search: 0.06 } as const

/** 調べない理由 */
export type SiteSkip = "personal" | "empty"
export const SKIP_REASONS: Record<SiteSkip, string> = {
  personal: "工事名・注文者に個人名があるため Web では調べません",
  empty: "工事名も注文者も無いため調べられません",
}

/**
 * 調べる現場（同じ工事名・注文者の行をまとめたもの）。workName・client は CSV に出す値（匿名化のあと）で、外の検索にはこれだけを送る。
 * knowledgeTried は、変換の AI の推定（現場名・注文者からの推定）でもう知識で答えようとした（自信が無かった・答えられなかった）か
 */
export type Site = { key: string; workName: string; client: string; rowKeys: string[]; knowledgeTried: boolean; skip?: SiteSkip }

/** 現場の key（工事名と注文者の空白を除き NFKC にしたものをタブでつなぐ。空白を除くので値にタブは残らない） */
/** 現場の key と値の長さの上限（現場の行・変更案の記録・チャットの変更案で同じ定義を使う） */
export const siteRefSchema = z.object({ key: z.string().min(1).max(1100), workName: z.string().max(500), client: z.string().max(500) })

export const siteKeyOf = (workName: string, client: string) => `${removeSpaces(nfkc(workName))}\t${removeSpaces(nfkc(client))}`

/** AI に送る値（変換の所在地の推定と同じ形: 工事名と注文者を空白でつなぐ） */
export const siteInput = (s: Pick<Site, "workName" | "client">) => collapseSpaces([s.workName, s.client].filter(Boolean).join(" "))

/** もう決まった値（手直し・顧客の回答・承認した変更案・顧客に聞くと決めた欄）は調べない */
const decided = (c: CellResult) => c.by !== undefined || c.ask === true

/**
 * 自信の無い AI の値: 所在地の推定で AI も自信が無いと答えた（guessed）か、AI の値が要確認（指示文の変換などで AI が迷った）。
 * 所在地の推定は自信ありでも要確認（黄色）にするので、その文だけのセル（INFERRED_NOTE）は自信ありとして調べない
 */
const unsure = (c: CellResult) => c.guessed === true || (c.byAi === true && c.status === "warning" && c.message !== INFERRED_NOTE)

/** 調べる行か: 都道府県が空か、都道府県・場所名が自信の無い AI の値で、どちらもまだ決まっていない */
function needsLookup(prefecture: CellResult, place: CellResult) {
  if (decided(prefecture) || decided(place)) return false
  return prefecture.value === "" || unsure(prefecture) || unsure(place)
}

type Row = TableView["output"][number]

/** 行の現場（1行分）。値に個人名の印があれば personal（外に送らない。記号の付け直しで別の人の現場とまとまらないよう、行ごとの key） */
function siteOf(r: Row): Site {
  const { prefecture, place, workName, client } = r.cells
  const knowledgeTried = prefecture.byAi === true || place.byAi === true
  if (hasPersons(workName.stored ?? "") || hasPersons(client.stored ?? "")) return { key: `personal\t${r.key}`, workName: "", client: "", rowKeys: [r.key], knowledgeTried, skip: "personal" }
  const w = collapseSpaces(workName.value)
  const c = collapseSpaces(client.value)
  return { key: siteKeyOf(w, c), workName: w, client: c, rowKeys: [r.key], knowledgeTried, ...(!w && !c ? { skip: "empty" as const } : {}) }
}

/** 行を現場ごとにまとめる（順は最初の行の順） */
function group(rows: readonly Row[]): Map<string, Site> {
  const sites = new Map<string, Site>()
  for (const r of rows) {
    const s = siteOf(r)
    const known = sites.get(s.key)
    if (!known) sites.set(s.key, s)
    else {
      known.rowKeys.push(r.key)
      known.knowledgeTried &&= s.knowledgeTried
    }
  }
  return sites
}

/** 調べる行: CSV に載せる行のうち needsLookup に当たる行（一括調査とチャットの1件で同じ） */
const lookupRows = (view: Pick<TableView, "output">) => view.output.filter((r) => needsLookup(r.cells.prefecture, r.cells.place))

/**
 * 調べる現場を集める（CSV に載せる行だけ、画面と CSV の順）。個人名の判定は CSV と同じ（匿名化で印にした人）。
 * 印の無い値は CSV にそのまま出る値なので、外の検索に送ってよい
 */
export const locationTargets = (view: Pick<TableView, "output">): Site[] => [...group(lookupRows(view)).values()]

/** 一括調査の1回分（先頭から MAX_SITES_PER_RUN 現場）と、次の回に回る現場の数。画面・チャット・サーバーが同じ数を使う */
export function runSitesOf(view: Pick<TableView, "output">) {
  const all = locationTargets(view)
  return { sites: all.slice(0, MAX_SITES_PER_RUN), over: Math.max(0, all.length - MAX_SITES_PER_RUN) }
}

/**
 * 1つの行の現場（チャットの「この現場ってどこ？」）。聞かれた行と、一括調査と同じく調べる行（needsLookup）のうち同じ現場の行をまとめる
 * （元データで決まっている同じ名前の行は変えない）。行が無ければ undefined
 */
export function siteOfRow(view: Pick<TableView, "shown" | "output">, rowKey: string): Site | undefined {
  const row = view.shown.find((r) => r.key === rowKey)
  if (!row) return undefined
  const site = siteOf(row)
  if (site.skip) return site
  const same = group(lookupRows(view)).get(site.key)
  return { ...site, rowKeys: [rowKey, ...(same?.rowKeys ?? []).filter((k) => k !== rowKey)], knowledgeTried: site.knowledgeTried && (same?.knowledgeTried ?? true) }
}

/** 費用の目安。memorized は覚えた結果がある現場の数（調べない） */
export function estimateUsd(sites: readonly Site[], memorized: ReadonlySet<string>) {
  let usd = 0
  for (const s of sites) {
    if (s.skip || memorized.has(s.key)) continue
    usd += (s.knowledgeTried ? 0 : ESTIMATE_USD.knowledge) + ESTIMATE_USD.search
  }
  return usd
}

// ---- 調べた結果 ----

export const LOCATION_SOURCES = ["memory", "knowledge", "search"] as const
export type LocationSource = (typeof LOCATION_SOURCES)[number]
export const SOURCE_LABELS: Record<LocationSource, string> = { memory: "前の年度に承認した結果", knowledge: "AI の知識で推定", search: "Web 検索で推定" }

/** 見つかった場所。confident は AI が自信ありと答えたか（無ければ顧客に確かめる）。urls は根拠のページ（検索の引用） */
export type Found = { prefecture: string; place: string; urls: string[]; source: LocationSource; confident: boolean; note: string }

/** 1つの現場を調べた結果 */
export type Outcome = ({ kind: "found" } & Found) | { kind: "notFound"; note: string } | { kind: "failed"; note: string } | { kind: "skipped"; skip: SiteSkip }

export const MAX_URLS = 3
const MAX_URL_LENGTH = 2000
const MAX_NOTE = 300
const url = z.string().max(MAX_URL_LENGTH).regex(/^https?:\/\//)
export const foundSchema = z.object({
  prefecture: z.string().max(10),
  place: z.string().max(100),
  urls: z.array(url).max(MAX_URLS),
  source: z.enum(LOCATION_SOURCES),
  confident: z.boolean(),
  note: z.string().max(MAX_NOTE),
})

export const outcomeSchema: z.ZodType<Outcome> = z.discriminatedUnion("kind", [
  foundSchema.extend({ kind: z.literal("found") }),
  z.object({ kind: z.literal("notFound"), note: z.string().max(MAX_NOTE) }),
  z.object({ kind: z.literal("failed"), note: z.string().max(MAX_NOTE) }),
  z.object({ kind: z.literal("skipped"), skip: z.enum(["personal", "empty"]) }),
])

/**
 * 結果を保存・変更案にできる形にそろえる（D1 に書く前・チャットの変更案にする前に1か所で）。AI の文（note）は切り、根拠の URL は形と数をそろえる。
 * 都道府県・場所名が長すぎる答えは切ると誤った場所になるので使わず、その現場だけ「調べられなかった」にする（ほかの現場は続ける）
 */
export function normalizeOutcome(o: Outcome): Outcome {
  const note = (s: string) => s.slice(0, MAX_NOTE)
  switch (o.kind) {
    case "found": {
      const fits = foundSchema.shape.prefecture.safeParse(o.prefecture).success && foundSchema.shape.place.safeParse(o.place).success
      if (!fits) return { kind: "failed", note: "AI の答えの都道府県・場所名が長すぎるため使えませんでした" }
      const urls = [...new Set(o.urls.filter((u) => url.safeParse(u).success))].slice(0, MAX_URLS)
      return { ...o, urls, note: note(o.note) }
    }
    case "notFound":
    case "failed":
      return { ...o, note: note(o.note) }
    case "skipped":
      return o
  }
}

/** 見つからなかった・調べなかった現場の、顧客への問い合わせの理由 */
export function askReason(o: Exclude<Outcome, { kind: "found" }>) {
  switch (o.kind) {
    case "notFound":
      return `工事場所を調べても分かりませんでした${o.note ? `（${o.note}）` : ""}`
    case "failed":
      return `工事場所を調べられませんでした（${o.note}）`
    case "skipped":
      return SKIP_REASONS[o.skip]
  }
}

/**
 * サーバーでの個人名の確かめ（画面から届いた表に頼らない）。案件の保存した作業と AI の結果から集めた個人名（names）が、
 * 送る文字列（工事名・注文者）に1つでも含まれる現場は、個人名の現場として値を持たせず調べない（安全側）
 */
export function guardPersonal(sites: readonly Site[], hasName: (text: string) => boolean): Site[] {
  return sites.map((s) => (s.skip || !hasName(`${s.workName}\n${s.client}`) ? s : { ...s, key: `personal\t${s.rowKeys[0]}`, workName: "", client: "", skip: "personal" }))
}

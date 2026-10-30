// 顧客・案件・案件のファイル（ファイルの中身は R2 の FILES、キーは r2_key）
// 削除は 案件に削除中の印 → R2 → ファイルの行 → 状態 → AI の結果 → 案件 → 顧客 の順に消す。外部キーに cascade を付けないのは、R2 を消す前に行が消えないようにするため
// ユーザーへの参照は持たない（アプリを統合するときに文字列ID で足す）
import { sql } from "drizzle-orm"
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CASE_STATUSES, FILE_KINDS, FILE_STATUSES } from "@/lib/cases/types"
import { RULE_SCOPES, RULE_SOURCES } from "@/lib/chat/rules"
import { RULE7_TAXES } from "@/lib/convert/koji-selection"
import { createdAt, updatedAt } from "./auth-schema"

export const csvCustomers = sqliteTable("csv_customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** @deprecated 顧客ルールの前の形（1つの文章）。0004 で csv_rule_items に移した。使わない（次のマイグレーションで消す） */
  rules: text("rules").notNull().default(""),
  formatNote: text("format_note").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** @deprecated 全体ルールの前の形（id "global" の1行の文章）。0004 で csv_rule_items に移した。使わない（次のマイグレーションで消す） */
export const csvRules = sqliteTable("csv_rules", {
  id: text("id").primaryKey(),
  rules: text("rules").notNull().default(""),
  updatedAt: updatedAt(),
})

/**
 * 全体ルール・顧客ルールの項目（1項目1行）。並びは position（同じ一覧の中で小さい順）。customer_id は顧客ルールのときだけ（全体ルールは null）。
 * source は誰が足したか（staff: 職員が画面で・移した前の文章、chat: チャットの変更案の承認）、case_id は由来の案件（無ければ null。案件を消すと null にする）。
 * version は文章を直すたびに1つ上げ、同じ項目を2つの画面で直したときに後の保存を断る（並べ替えでは上げない）。顧客を消すと顧客ルールの項目も消す
 */
export const csvRuleItems = sqliteTable(
  "csv_rule_items",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: RULE_SCOPES }).notNull(),
    customerId: text("customer_id").references(() => csvCustomers.id),
    text: text("text").notNull(),
    position: integer("position").notNull(),
    source: text("source", { enum: RULE_SOURCES }).notNull(),
    caseId: text("case_id"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("csv_rule_items_list_idx").on(t.scope, t.customerId, t.position), index("csv_rule_items_case_id_idx").on(t.caseId)],
)

/** 事務所の設定（id は "global" の1行だけ。マイグレーション 0004 が作る）。rule7_tax は7割の計算を税抜・税込のどちらでするか（新しい案件の初期値） */
export const csvSettings = sqliteTable("csv_settings", {
  id: text("id").primaryKey(),
  rule7Tax: text("rule7_tax", { enum: RULE7_TAXES }).notNull().default("excluded"),
  updatedAt: updatedAt(),
})

/**
 * チャットの変更案のルールの追記を足した印（変更案の id と項目の番号ごとに1行）。同じ項目を二度足さない。
 * token は足した処理の印（同じ処理で足した行だけルールに足す）。案件を消すと一緒に消す
 */
export const csvRuleAppends = sqliteTable(
  "csv_rule_appends",
  {
    proposalId: text("proposal_id").notNull(),
    item: integer("item").notNull(),
    caseId: text("case_id").notNull(),
    token: text("token").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.item] }), index("csv_rule_appends_case_id_idx").on(t.caseId)],
)

export const csvCases = sqliteTable(
  "csv_cases",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => csvCustomers.id),
    fiscalYear: integer("fiscal_year").notNull(),
    status: text("status", { enum: CASE_STATUSES }).notNull().default("converting"),
    costUsd: real("cost_usd").notNull().default(0),
    /** 削除を始めた印。立っている案件にはファイルも状態も足さない（削除と同時に届いた保存が R2 や行を残さないように） */
    deleting: integer("deleting", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("csv_cases_customer_id_idx").on(t.customerId)],
)

/**
 * 変換で AI が返した結果（lib/cases/state.ts の savedAiCacheSchema で検証した JSON）。大きく（〜2MB）、変換のときにしか変わらないので、
 * 手直しのたびに送る状態とは別の行に置く。新しい結果は新しい id の行で足し、状態の行が指す id を替えてから前の行を消す
 */
export const csvCaseAiCaches = sqliteTable(
  "csv_case_ai_caches",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => csvCases.id),
    json: text("json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("csv_case_ai_caches_case_id_idx").on(t.caseId)],
)

/**
 * 案件の画面の状態（lib/cases/state.ts の savedWorkSchema で検証した JSON）と、そのときの AI の結果の行。
 * version は保存のたびに1つ上げ、別の画面からの上書きを防ぐ（状態と AI の結果の両方を1つの版で守る）
 */
export const csvCaseStates = sqliteTable("csv_case_states", {
  caseId: text("case_id")
    .primaryKey()
    .references(() => csvCases.id),
  version: integer("version").notNull(),
  json: text("json").notNull(),
  aiCacheId: text("ai_cache_id")
    .notNull()
    .references(() => csvCaseAiCaches.id),
  updatedAt: updatedAt(),
})

export const csvCaseFiles = sqliteTable(
  "csv_case_files",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => csvCases.id),
    kind: text("kind", { enum: FILE_KINDS }).notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    /** pending: 行を足して R2 に置いている途中（一覧に出さない）。ready: 置き終わった */
    status: text("status", { enum: FILE_STATUSES }).notNull().default("pending"),
    r2Key: text("r2_key").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index("csv_case_files_case_id_idx").on(t.caseId)],
)

/**
 * 工事場所の一括調査の回（lib/location、server/location.ts）。裏の処理は Cloudflare Workflows のインスタンス（id はこの行の id）。
 * 案件ごとに走っている回は1つだけ（部分一意索引）。進み具合は現場の行の done から数える。usd・searches はこの回の費用と Web 検索の回数。
 * 案件を消すと、走っている回を止めてから行も消す（case-store.ts の deleteCase）
 */
export const LOCATION_RUN_STATUSES = ["running", "done", "failed", "stopped"] as const
export const csvLocationRuns = sqliteTable(
  "csv_location_runs",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    customerId: text("customer_id").notNull(),
    status: text("status", { enum: LOCATION_RUN_STATUSES }).notNull().default("running"),
    total: integer("total").notNull(),
    searches: integer("searches").notNull().default(0),
    usd: real("usd").notNull().default(0),
    /** 職員が止めた（残りの現場は調べず、調べ終えた分で変更案を出す） */
    stopRequested: integer("stop_requested", { mode: "boolean" }).notNull().default(false),
    /** 終わったときに置いた変更案（R2 の proposals/<id>.json） */
    proposalId: text("proposal_id"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("csv_location_runs_case_id_idx").on(t.caseId), uniqueIndex("csv_location_runs_one_running").on(t.caseId).where(sql`${t.status} = 'running'`)],
)

/**
 * 一括調査の現場（回ごとに番号 idx）。site は lib/location/sites.ts の Site の JSON（外に送ってよい値だけ）。
 * outcome は調べた結果（Outcome の JSON）。まだ調べていなければ null
 */
export const csvLocationSites = sqliteTable(
  "csv_location_sites",
  {
    runId: text("run_id").notNull(),
    idx: integer("idx").notNull(),
    site: text("site").notNull(),
    outcome: text("outcome"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.idx] })],
)

/**
 * 顧客ごとに覚えた工事場所（職員が承認した調査の結果）。site_key は工事名・注文者の空白を除いた値（lib/location/sites.ts の siteKeyOf）。
 * 個人名のある現場は調べないので、ここにも入らない。翌年はこれを先に使う（要確認のまま出し、自信なしの結果は自信なしのまま）。顧客を消すと消す（案件を消しても残す）
 */
export const csvLocationMemory = sqliteTable(
  "csv_location_memory",
  {
    customerId: text("customer_id").notNull(),
    siteKey: text("site_key").notNull(),
    workName: text("work_name").notNull(),
    client: text("client").notNull(),
    prefecture: text("prefecture").notNull(),
    place: text("place").notNull(),
    urls: text("urls").notNull(),
    /** 覚えたもとの調べ方（knowledge・search） */
    source: text("source").notNull(),
    /** AI が自信ありと答えたか（自信なしのまま承認した結果は、翌年も顧客に確かめる印を付けて出す）と、AI の迷った点 */
    confident: integer("confident", { mode: "boolean" }).notNull(),
    note: text("note").notNull().default(""),
    caseId: text("case_id").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.siteKey] })],
)

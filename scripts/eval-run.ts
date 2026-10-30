/**
 * 案件定義の variants を順に流す（1回分）。同じ条件で回を重ねるときは、回ごとに新しい EVAL_OUT にする（工事場所の覚えた結果も回ごとに初めから）。
 *
 *   EVAL_CASES=<案件定義の JSON> EVAL_OUT=<この回のフォルダ> bun scripts/eval-run.ts [<case>...]
 *
 * 案件を渡さなければ、variants のある案件をすべて。照合の出力は EVAL_OUT の log-<case>-<順番>-<variant>.log に流す。
 * variant が落ちたら、その案件の残りと、その案件を去年（editFrom）に使う案件は流さない（前の variant の結果を使うため）。
 * この回の費用（costs.jsonl。落ちた照合の分も含む）が EVAL_RUN_BUDGET_USD（既定 12）を超えたら、次の照合を始めずに止める。
 * 落ちた・止めた照合があれば 1 で終わる。
 */
import { spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readRun, runUsd } from "../src/lib/eval/report"

const CASES_FILE = process.env.EVAL_CASES
const OUT = process.env.EVAL_OUT
if (!CASES_FILE || !OUT) throw new Error("EVAL_CASES と EVAL_OUT を指定（scripts/eval.ts と同じ）")
mkdirSync(OUT, { recursive: true })
const budget = Number(process.env.EVAL_RUN_BUDGET_USD ?? 12)
const cases = JSON.parse(readFileSync(CASES_FILE, "utf8")) as Record<string, { variants?: string[]; editFrom?: string }>
const only = process.argv.slice(2)
if (only.some((id) => !cases[id])) throw new Error(`case: ${Object.keys(cases).join(" | ")}`)
const targets = Object.entries(cases).filter(([id, c]) => c.variants?.length && (!only.length || only.includes(id)))

const spent = () => runUsd(readRun(OUT))
const script = new URL("./eval.ts", import.meta.url).pathname
const failed = new Set<string>()
let problems = 0
for (const [id, c] of targets) {
  if (c.editFrom && failed.has(c.editFrom)) {
    console.log(`${id}: 流さない（去年として使う ${c.editFrom} が落ちた）`)
    failed.add(id)
    problems++
    continue
  }
  for (const [i, variant] of c.variants!.entries()) {
    if (spent() > budget) {
      console.log(`STOP: この回の費用が $${spent().toFixed(2)} で上限 $${budget} を超えた（${id} ${variant} から先は流していない）`)
      process.exit(1)
    }
    const t0 = Date.now()
    const log = join(OUT, `log-${id}-${i + 1}-${variant}.log`)
    const fd = openSync(log, "w")
    const r = spawnSync("bun", [script, id, variant], { env: process.env, stdio: ["ignore", fd, fd] })
    closeSync(fd)
    const ok = r.status === 0
    console.log(`${id} ${variant}: ${ok ? "ok" : `落ちた（${r.status ?? r.signal}）`} ${Math.round((Date.now() - t0) / 1000)}s  累計 $${spent().toFixed(2)}  ${log}`)
    if (!ok) {
      console.log(readFileSync(log, "utf8").split("\n").slice(-8).join("\n"))
      console.log(`${id}: 残りの variant は流さない`)
      failed.add(id)
      problems++
      break
    }
  }
}
process.exit(problems ? 1 : 0)

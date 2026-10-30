/**
 * 照合の結果を1つの表にする。回のフォルダ（scripts/eval.ts の EVAL_OUT）を並べると、案件・variant ごとに回をまたいだ揺れ（平均・最小〜最大）を出す。
 *
 *   bun scripts/eval-report.ts [--cases <案件定義の JSON>] [--out <フォルダ>] <回のフォルダ>...
 *
 * --out に report.md と report.json を書く（無ければ Markdown を出すだけ）。--cases を渡すと案件定義の順に並べる。
 * 結果は顧客の情報を含まない（案件の呼び名と数だけ）が、案件の呼び名は案件定義のキーなので、置き場所は案件定義と同じリポジトリの外にする。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildReport, readRun, reportMarkdown } from "../src/lib/eval/report"

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  if (!value) throw new Error(`${name} の値が無い`)
  return value
}
const casesFile = option("--cases")
const out = option("--out")
if (!args.length) throw new Error("回のフォルダ（scripts/eval.ts の EVAL_OUT）を1つ以上渡す")

const runs = args.map(readRun)
const caseOrder = casesFile ? Object.keys(JSON.parse(readFileSync(casesFile, "utf8")) as Record<string, unknown>) : []
const report = buildReport(runs, caseOrder)
const md = reportMarkdown(report)
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "report.md"), md)
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1))
}
console.log(md)

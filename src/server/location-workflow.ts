import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import Anthropic from "@anthropic-ai/sdk"
import { getDb } from "@/db"
import { putProposalRecord, deleteProposalRecord } from "./chat"
import { batchWithClaude } from "./claude"
import { searchLocation } from "./location"
import { runLocationSearch } from "./location-run"
import { failRun } from "./location-store"
import { serverPlaceIndex } from "./place-index"

export type LocationSearchParams = { runId: string; caseId: string }

/**
 * 工事場所の一括調査（Cloudflare Workflows）。手順は location-run.ts。思わぬ誤りで止まったら回を「失敗」にして、画面に知らせる
 * （現場ごとの検索の失敗は手順の中でやり直し、それでも駄目なら現場を問い合わせに回すので、ここには来ない）
 */
export class LocationSearchWorkflow extends WorkflowEntrypoint<Env, LocationSearchParams> {
  async run(event: Readonly<WorkflowEvent<LocationSearchParams>>, step: WorkflowStep) {
    const { runId, caseId } = event.payload
    const db = getDb()
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    const index = serverPlaceIndex()
    try {
      await runLocationSearch(
        {
          db,
          index,
          knowledge: (req) => batchWithClaude(anthropic, req),
          search: (site, spent) => searchLocation(anthropic, index, site, spent),
          putProposal: putProposalRecord,
          deleteProposal: deleteProposalRecord,
        },
        step,
        { runId, caseId },
      )
    } catch (e) {
      await step.do("fail", () => failRun(db, runId, e instanceof Error ? e.message : "調べる処理が止まりました"))
      throw e
    }
  }
}

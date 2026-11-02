/** 照合スクリプトの view_file（画面と同じ道具を、手元のファイルと Files API で動かす。切り出して上げたページは呼ぶ側が消す） */
import Anthropic, { toFile } from "@anthropic-ai/sdk"
import type { ModelMessage } from "ai"
import { readFileSync, statSync } from "node:fs"
import { viewedInHistory, type FileViewer } from "../src/lib/chat/view-file"

export function localViewer(anthropic: Anthropic, files: readonly { name: string; original: string; id: string; path: string }[], history: readonly ModelMessage[]): FileViewer {
  return {
    files: files.map((f) => ({ ...f, size: statSync(f.path).size })),
    read: async (name) => {
      const f = files.find((x) => x.name === name)
      return f ? new Uint8Array(readFileSync(f.path)) : null
    },
    upload: async (bytes, name) => (await anthropic.files.upload({ file: await toFile(bytes, name, { type: "application/pdf" }) })).id,
    viewed: viewedInHistory(history),
  }
}

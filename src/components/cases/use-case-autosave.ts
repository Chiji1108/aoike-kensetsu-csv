import { useEffect, useRef, useState } from "react"
import { createAutosave, type SaveStatus } from "@/lib/cases/autosave"
import type { CaseWork } from "@/lib/cases/state"
import { errorMessage } from "@/lib/errors"
import { saveCaseStateFn } from "@/server/cases"

export type { SaveStatus }

/** 案件の作業を変わるたびに保存する（lib/cases/autosave.ts）。saved は読んだときの作業（まだ保存が無ければ null） */
export function useCaseAutosave(caseId: string, initial: { version: number; saved: CaseWork | null }, work: CaseWork) {
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved" })
  const autosave = useRef<ReturnType<typeof createAutosave>>(null)
  autosave.current ??= createAutosave({
    ...initial,
    save: (req) => saveCaseStateFn({ data: { caseId, ...req } }),
    onStatus: setStatus,
    errorMessage: (e) => errorMessage(e, "保存できませんでした"),
  })
  const loaded = useRef(work)

  useEffect(() => {
    if (work !== loaded.current) autosave.current!.change(work)
  }, [work])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (autosave.current!.unsaved()) e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => {
      window.removeEventListener("beforeunload", warn)
      // 画面の中で別のページに移ったときは、待っている変更をすぐに送る（beforeunload は起きない）
      autosave.current!.flush()
    }
  }, [])

  return status
}

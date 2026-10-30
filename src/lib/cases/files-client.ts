import { fileUrl, type CaseFile, type FileKind } from "./types"

/** 案件にファイルを付ける（/api/cases/<caseId>/files。名前はヘッダーで送る。種類はサーバーが名前から決める） */
export async function uploadCaseFile(caseId: string, kind: FileKind, file: Blob, name: string): Promise<CaseFile> {
  const res = await fetch(`/api/cases/${caseId}/files`, {
    method: "POST",
    headers: { "x-file-kind": kind, "x-file-name": encodeURIComponent(name) },
    body: file,
  })
  if (!res.ok) throw new Error((await res.text()) || "ファイルを保存できませんでした")
  return res.json()
}

export async function fetchCaseFile(fileId: string): Promise<Uint8Array> {
  const res = await fetch(fileUrl(fileId))
  if (!res.ok) throw new Error((await res.text()) || "ファイルを読めませんでした")
  return new Uint8Array(await res.arrayBuffer())
}

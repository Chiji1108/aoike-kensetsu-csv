/** チャットの AI がそのまま見られるファイルの種類（画面でも使うので、PDF を開く pdf-lib を読み込まない。道具は lib/chat/view-file.ts） */

/** Claude がそのまま見られる画像（HEIC は見られない） */
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }

export type ViewKind = { kind: "pdf"; mediaType: "application/pdf" } | { kind: "image"; mediaType: string } | { kind: "heic" } | null

/** ファイルの名前から、見せられる種類（見せられないファイルは null） */
export function viewKindOf(name: string): ViewKind {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""
  if (ext === "pdf") return { kind: "pdf", mediaType: "application/pdf" }
  if (ext === "heic" || ext === "heif") return { kind: "heic" }
  const image = IMAGE_TYPES[ext]
  return image ? { kind: "image", mediaType: image } : null
}

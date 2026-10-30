import { createFileRoute } from "@tanstack/react-router"
import { uploadCaseFile } from "@/server/file-routes"

export const Route = createFileRoute("/api/cases/$caseId/files")({
  server: { handlers: { POST: ({ request, params }) => uploadCaseFile(request, params.caseId) } },
})

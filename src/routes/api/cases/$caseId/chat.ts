import { createFileRoute } from "@tanstack/react-router"
import { chatHistory, chatTurn } from "@/server/chat"

export const Route = createFileRoute("/api/cases/$caseId/chat")({
  server: { handlers: { GET: ({ request, params }) => chatHistory(request, params.caseId), POST: ({ request, params }) => chatTurn(request, params.caseId) } },
})

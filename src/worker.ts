import handler from "@tanstack/react-start/server-entry"

/** Worker の入口。画面とサーバー関数は TanStack Start のまま、工事場所の一括調査の Workflow のクラスを足す */
export { LocationSearchWorkflow } from "./server/location-workflow"

export default {
  fetch: (request) => handler.fetch(request),
} satisfies ExportedHandler<Env>

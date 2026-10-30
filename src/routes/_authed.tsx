import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { getSessionFn } from "@/server/session"

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const { userId } = await getSessionFn()
    if (!userId) throw redirect({ to: "/login" })
    return { userId }
  },
  component: Outlet,
})

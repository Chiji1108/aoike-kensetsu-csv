import { useEffect } from "react"
import { HeadContent, Scripts, createRootRoute, Link } from "@tanstack/react-router"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { APP_NAME } from "@/lib/constants"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#fbfbfc" },
      { name: "robots", content: "noindex, nofollow" },
      { title: APP_NAME },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&family=Noto+Serif+JP:wght@500;600&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  // React が画面につながった印（<html data-hydrated>）。つながる前の入力や押下は効かないので、E2E はこれを待ってから操作する
  useEffect(() => {
    document.documentElement.dataset.hydrated = ""
  }, [])
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-center" richColors closeButton />
        <Scripts />
      </body>
    </html>
  )
}

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-sm text-muted-foreground">ページが見つかりませんでした</p>
      <Button render={<Link to="/" />} nativeButton={false} variant="outline">
        トップへ戻る
      </Button>
    </div>
  )
}

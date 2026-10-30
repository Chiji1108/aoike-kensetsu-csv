import { useEffect, useState } from "react"
import { formatUsd } from "@/lib/cost"
import { yenOf, type UsdJpy } from "@/lib/fx"
import { getUsdJpyFn } from "@/server/fx-fns"

/** ドル円を表示のあとで読む（画面の表示を待たせない）。読めるまで・読めなければ null（円を出さない） */
export function useUsdJpy() {
  const [fx, setFx] = useState<UsdJpy | null>(null)
  useEffect(() => {
    let live = true
    // 円は表示だけの値なので、読めなかったらドルだけ出す（サーバー関数の失敗も同じ扱い）
    getUsdJpyFn().then((v) => live && setFx(v), () => live && setFx(null))
    return () => {
      live = false
    }
  }, [])
  return fx
}

/** 費用（ドル）。レートが取れていれば円と、そのレートの日付も出す */
export function Cost({ usd, fx }: { usd: number; fx: UsdJpy | null }) {
  return (
    <>
      {formatUsd(usd)}
      {fx && (
        <>
          （約{yenOf(usd, fx).toLocaleString("ja-JP")}円<span className="text-[10px] text-muted-foreground"> {fx.date.slice(5).replace("-", "/")} のレート</span>）
        </>
      )}
    </>
  )
}

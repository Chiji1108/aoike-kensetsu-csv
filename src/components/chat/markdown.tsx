import { Streamdown, type UrlTransform } from "streamdown"
import "streamdown/styles.css"

/** リンクと画像は http・https だけ（javascript: などは消す） */
const onlyHttp: UrlTransform = (url) => (/^https?:\/\//i.test(url) ? url : "")

/**
 * AI の返事の Markdown。流れてくる途中の閉じていない表・太字・リストも崩さずに描く（streaming）。
 * 数式・mermaid・コードの色付けの部品は読み込まない（バンドルを軽くする）
 */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      urlTransform={onlyHttp}
      linkSafety={{ enabled: false }}
      controls={{ table: false, code: { copy: true, download: false } }}
      className="text-sm leading-relaxed [&_table]:text-xs"
    >
      {text}
    </Streamdown>
  )
}

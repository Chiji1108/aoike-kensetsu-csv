import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/**
 * 選択肢の少ない欄（2〜4択）のセグメントコントロール（shadcn/ui の Toggle Group を単一選択で）。矢印キーで移り、Enter・Space で選ぶ。
 * 選んだものを押し直しても外さない（いつも1つを選んでいる）。testId-<値> で選択肢を指せる
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
  testId?: string
}) {
  return (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
      value={[value]}
      onValueChange={(v) => {
        const next = v[0] as T | undefined
        if (next !== undefined && next !== value) onChange(next)
      }}
      data-testid={testId}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-3 data-[pressed]:bg-foreground data-[pressed]:text-background" data-testid={testId ? `${testId}-${o.value}` : undefined}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

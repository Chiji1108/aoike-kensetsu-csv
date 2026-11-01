import { useRef, useState } from "react"
import { Combobox, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { engineerRoleOf } from "@/lib/spec/code-sets"
import { matchesChoice, type Choice, type FieldChoices } from "@/lib/spec/choices"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"

/**
 * 決まった値の項目の、表のセルの選ぶ欄（セルの下に重ねて開く）。数字を打たせず、名前で選ぶ。
 * 業種（30）は名前・コード・別名で絞り込める欄（↑↓ で選び Enter）、2〜4択はボタン（←→ で移り Enter・Space）、
 * 主任技術者・監理技術者は2列を1つの欄で決める（どちらか一方だけが 1 になる）。
 * 選ぶと onPick（決める値）、Escape・外を押すと onCancel（何も変えない。重ねて開いた作業の画面は閉じない）
 */
export function CellPicker({
  anchor,
  field,
  label,
  choices,
  values,
  onPick,
  onCancel,
}: {
  anchor: HTMLElement | null
  field: KojiFieldId
  /** 項目の名前（読み上げと見出し） */
  label: string
  choices: FieldChoices
  /** 行の今の値（立場は主任技術者・監理技術者の2列から決める） */
  values: Readonly<Record<KojiFieldId, string>>
  onPick: (values: Partial<Record<KojiFieldId, string>>) => void
  /** restoreFocus: Escape で閉じた（セルにフォーカスを戻す）。外を押して閉じたときは false */
  onCancel: (restoreFocus: boolean) => void
}) {
  // 選んだあとに閉じる知らせ（onOpenChange）でもう一度終えない
  const finished = useRef(false)
  const finish = (picked?: Partial<Record<KojiFieldId, string>>, restoreFocus = false) => {
    if (finished.current) return
    finished.current = true
    if (picked) onPick(picked)
    else onCancel(restoreFocus)
  }
  const initial = useRef<HTMLButtonElement | null>(null)
  return (
    <Popover open onOpenChange={(open, d) => !open && finish(undefined, d.reason === "escape-key")}>
      <PopoverContent anchor={anchor} align="start" sideOffset={2} className="w-auto max-w-[calc(100vw-2rem)] gap-1.5 p-1.5" initialFocus={choices.kind === "codes" && choices.search ? undefined : initial} data-testid="cell-picker" aria-label={`${label}を選ぶ`}>
        <p className="px-1 text-xs text-muted-foreground">{label}</p>
        {choices.kind === "engineerRole" ? (
          <Buttons
            label={label}
            options={choices.options.map((o) => ({ code: o.code, label: o.label }))}
            current={engineerRoleOf(values.chiefEngineer, values.supervisingEngineer)}
            initial={initial}
            onPick={(code) => finish(code === undefined ? undefined : { ...choices.options.find((o) => o.code === code)!.values }, true)}
          />
        ) : choices.search ? (
          <Search label={label} options={choices.options} onPick={(code) => finish({ [field]: code }, true)} onCancel={(restore) => finish(undefined, restore)} />
        ) : (
          <Buttons label={label} options={choices.options} current={values[field]} initial={initial} onPick={(code) => finish(code === undefined ? undefined : { [field]: code }, true)} />
        )}
      </PopoverContent>
    </Popover>
  )
}

/** 2〜4択のボタン（Toggle Group）。今の値を押し直したら変えずに閉じる */
function Buttons({
  label,
  options,
  current,
  initial,
  onPick,
}: {
  label: string
  options: readonly { code: string; label: string }[]
  current: string | undefined
  initial: React.RefObject<HTMLButtonElement | null>
  onPick: (code: string | undefined) => void
}) {
  const known = options.some((o) => o.code === current)
  return (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
      value={known ? [current!] : []}
      onValueChange={(v) => onPick(v[0] !== undefined && v[0] !== current ? v[0] : undefined)}
      data-testid="cell-picker-options"
    >
      {options.map((o, i) => (
        <ToggleGroupItem
          key={o.code}
          ref={(known ? o.code === current : i === 0) ? initial : undefined}
          value={o.code}
          className="px-3 whitespace-nowrap data-[pressed]:bg-foreground data-[pressed]:text-background"
          data-testid="cell-picker-option"
          data-value={o.code}
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** 選択肢の多い欄（業種）: 名前・コード・別名で絞り込み、↑↓ と Enter で選ぶ（選択肢は欄の中に並べる） */
function Search({ label, options, onPick, onCancel }: { label: string; options: readonly Choice[]; onPick: (code: string) => void; onCancel: (restoreFocus: boolean) => void }) {
  const [query, setQuery] = useState("")
  const shown = options.filter((o) => matchesChoice(o, query))
  return (
    <Combobox
      inline
      open
      items={shown}
      filter={null}
      autoHighlight
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(o: Choice) => `${o.code} ${o.label}`}
      onValueChange={(o: Choice | null) => o && onPick(o.code)}
      onOpenChange={(open, d) => !open && onCancel(d.reason === "escape-key")}
    >
      <ComboboxInput autoFocus showTrigger={false} placeholder="名前・コードで絞り込む" aria-label={`${label}を名前・コードで絞り込む`} className="w-60 max-w-full" data-testid="cell-picker-search" />
      {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">合うものがありません</p>}
      <ComboboxList className="max-h-64">
        {(o: Choice) => (
          <ComboboxItem key={o.code} value={o} data-testid="cell-picker-option" data-value={o.code}>
            <span className="num w-5 shrink-0 text-right text-xs text-muted-foreground">{o.code}</span>
            {o.label}
          </ComboboxItem>
        )}
      </ComboboxList>
    </Combobox>
  )
}

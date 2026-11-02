import { useState, type ReactNode } from "react"
import { CircleCheck, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { isUsableBasis, RULE7_TAX_LABELS, type Basis, type GyoshuSummary, type Rule7Tax } from "@/lib/convert/koji-selection"
import { parseInputNumber } from "@/lib/convert/text"
import { fromBookCount } from "@/lib/cases/export-check"
import { cn } from "@/lib/utils"

/** 千円の表示（整数・桁区切り） */
export const fmt = (n: number) => Math.round(n).toLocaleString("ja-JP")
/** 差の表示（+ を付ける） */
export const fmtSigned = (n: number) => `${Math.round(n) > 0 ? "+" : ""}${fmt(n)}`

export function RoundingNote({ floor, round, current }: { floor: number; round: number; current: "floor" | "round" }) {
  const diff = round - floor
  return (
    <p className="text-xs text-muted-foreground" data-testid="rounding-note">
      請負代金の合計: 切り捨て <span className={cn("num", current === "floor" && "font-semibold text-foreground")}>{fmt(floor)}</span> 千円 ／
      四捨五入 <span className={cn("num", current === "round" && "font-semibold text-foreground")}>{fmt(round)}</span> 千円
      {diff !== 0 && <>（差 {fmt(diff)} 千円）</>}
    </p>
  )
}

const pct = (r: number | undefined) => (r === undefined ? "—" : `${(r * 100).toFixed(1)}%`)

/** 千円の整数に。空や基準額に使えない値（0）なら undefined */
function parseThousand(s: string) {
  const v = parseInputNumber(s)
  return isUsableBasis(v) ? v : undefined
}

/**
 * 入力中の文字はそのまま持ち、確定（フォーカスを外す・Enter・Escape）したときに数値にする。読めなければ残して知らせる。
 * 外から値が変わったら（チャットの変更案・取り消し）入力中の文字は捨てて今の値を出す
 */
function BasisInput({ value, label, onChange }: { value: number | undefined; label: string; onChange: (v: number | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setDraft(null)
    setInvalid(false)
  }
  /** 確定できたか（読めなければ false） */
  function commit() {
    if (draft === null) return true
    const v = parseThousand(draft)
    if (draft.trim() && v === undefined) {
      setInvalid(true)
      return false
    }
    onChange(v)
    setDraft(null)
    return true
  }
  return (
    <>
      <Input
        className={cn("num h-8 w-full text-right", invalid && "border-red-500")}
        inputMode="numeric"
        aria-label={label}
        aria-invalid={invalid}
        placeholder="未入力"
        value={draft ?? (value === undefined ? "" : String(value))}
        onChange={(e) => {
          setDraft(e.target.value)
          setInvalid(false)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          // Escape で書き出すの確認が閉じる前に確定する（閉じると欄ごと消え、フォーカスを外したときの確定が走らない）。読めなければ閉じずに知らせる
          if (e.key === "Escape" && !commit()) {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
      />
      {invalid && <div className="text-[11px] text-red-600">1以上の数字（千円）で入力してください</div>}
    </>
  )
}

type Side = "total" | "motouke"
type BasisChange = (code: string, side: Side, value: number | undefined) => void

/** 1つの側（完成工事高・うち元請）の基準。n は決算書の額を入れた業種の数、of はその側のある業種の数 */
const sideBasis = (n: number, of: number) => (n === 0 ? "顧客の表の合計" : n >= of ? "決算書の額" : `決算書の額（${n} 業種）・ほかは顧客の表の合計`)

/** 7割の基準が何か（顧客の表の合計か、決算書の額か。完成工事高とうち元請で別に） */
export function basisText(summary: readonly GyoshuSummary[], rule7Tax: Rule7Tax) {
  const n = fromBookCount(summary)
  const head = `基準（${RULE7_TAX_LABELS[rule7Tax]}）`
  if (n.total === 0 && n.motouke === 0) return `${head}: 顧客の表の合計。決算書の額を入れると正確になります`
  const motoukeOf = summary.filter((g) => g.hasMotouke).length
  return `${head}: ${[`完成工事高は${sideBasis(n.total, summary.length)}`, ...(motoukeOf ? [`うち元請は${sideBasis(n.motouke, motoukeOf)}`] : [])].join("。")}`
}

/** 業種ごとの割合と7割を満たしているか（見るだけ）。載せる件数 / 7割の対象の件数と、載せる額 / 基準 */
export function GyoshuRatioTable({ summary }: { summary: readonly GyoshuSummary[] }) {
  const motouke = summary.some((g) => g.hasMotouke)
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm" data-testid="gyoshu-summary" data-motouke={motouke ? "1" : "0"}>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">業種</th>
            <th className="px-2 py-2 text-right font-medium whitespace-nowrap" title="載せる件数 / 7割の対象の件数">
              載せる
            </th>
            <th className="px-2 py-2 text-right font-medium whitespace-nowrap" title="載せる工事の額 ÷ 基準（千円）。7割を超えれば ✓">
              完成工事高
            </th>
            {motouke && (
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap" title="載せる元請の額 ÷ 元請の基準（千円）。7割を超えれば ✓" data-testid="motouke-head">
                うち元請
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {summary.map((g) => (
            <tr key={g.code} className={cn("border-t align-top", (g.short.total || g.short.motouke) && "bg-red-50/60")} data-gyoshu={g.code}>
              <td className="px-3 py-2">
                <span className="num mr-1.5 text-muted-foreground">{g.code || "—"}</span>
                {g.label}
              </td>
              <td className="num px-2 py-2 text-right whitespace-nowrap" data-testid="selected-count">
                {g.selected} / {g.count}
                {g.fromExcluded.count > 0 && (
                  <div className="text-[11px] whitespace-normal text-muted-foreground" data-testid="from-excluded">
                    ＋除外から {g.fromExcluded.count} 件・{fmt(g.fromExcluded.total)} 千円（割合に含めない）
                  </div>
                )}
              </td>
              <td className="px-2 py-2 text-right" data-testid="total-ratio" data-short={g.short.total ? "1" : "0"}>
                <Ratio ratio={g.totalRatio} short={g.short.total} fromBook={g.fromBook.total} selected={g.selectedTotal} basis={g.basis.total} />
              </td>
              {motouke && (
                <td className="px-3 py-2 text-right" data-testid="motouke-ratio" data-short={g.short.motouke ? "1" : "0"}>
                  {g.hasMotouke ? (
                    <Ratio ratio={g.motoukeRatio} short={g.short.motouke} fromBook={g.fromBook.motouke} selected={g.selectedMotoukeTotal} basis={g.basis.motouke} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 割合と ✓ / 届かない、その下に載せる額と基準（千円）。基準に決算書の額を使っていれば印を付ける */
function Ratio({ ratio, short, fromBook, selected, basis }: { ratio: number | undefined; short: boolean; fromBook: boolean; selected: number; basis: number }) {
  return (
    <div className="grid justify-items-end gap-0.5">
      <span className="inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5">
        <span className={cn("num", short && "font-semibold text-red-700")}>{pct(ratio)}</span>
        {ratio !== undefined &&
          (short ? (
            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-red-700">
              <TriangleAlert className="size-3.5" aria-hidden />
              届かない
            </span>
          ) : (
            <CircleCheck className="size-4 text-emerald-600" aria-label="満たしている" />
          ))}
        {fromBook && (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]" data-testid="from-book">
            決算書
          </Badge>
        )}
      </span>
      <span className="flex flex-wrap justify-end gap-x-1.5 text-[11px] text-muted-foreground" data-testid="ratio-amounts">
        <span className="whitespace-nowrap">
          載せる <span className="num">{fmt(selected)}</span>
        </span>
        <span className="whitespace-nowrap">
          / 基準 <span className="num">{fmt(basis)}</span>
        </span>
      </span>
    </div>
  )
}

/** 業種ごとの決算書の額（完成工事高・うち元請）の入力。元請は元請の側がある業種だけ */
function BasisEditor({ summary, basis, rule7Tax, onBasisChange }: { summary: readonly GyoshuSummary[]; basis: Basis; rule7Tax: Rule7Tax; onBasisChange: BasisChange }) {
  return (
    <div className="mt-2 rounded-xl border bg-muted/20 px-3 py-2" data-testid="basis-editor">
      <p className="text-xs text-muted-foreground">決算書の業種ごとの額（{RULE7_TAX_LABELS[rule7Tax]}・千円）。空にすると顧客の表の合計に戻ります。</p>
      {summary.map((g) => {
        const e = basis[g.code]
        return (
          <div key={g.code} className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 border-t py-2 first-of-type:mt-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]" data-basis-gyoshu={g.code}>
            <div className="col-span-2 text-sm sm:col-span-1 sm:pt-6">
              <span className="num mr-1.5 text-muted-foreground">{g.code || "—"}</span>
              {g.label}
            </div>
            <BasisField className="sm:col-start-2" caption="完成工事高" label={`${g.label} の完成工事高（千円）`} value={e?.total} rows={g.total} onChange={(v) => onBasisChange(g.code, "total", v)} />
            {g.hasMotouke && (
              <BasisField className="sm:col-start-3" caption="うち元請" label={`${g.label} のうち元請（千円）`} value={e?.motouke} rows={g.motoukeTotal} onChange={(v) => onBasisChange(g.code, "motouke", v)} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function BasisField({ className, caption, label, value, rows, onChange }: { className?: string; caption: string; label: string; value: number | undefined; rows: number; onChange: (v: number | undefined) => void }) {
  const diff = isUsableBasis(value) ? Math.round(value - rows) : 0
  return (
    <div className={cn("grid gap-1 text-xs", className)}>
      <span className="text-muted-foreground">{caption}</span>
      <BasisInput value={value} label={label} onChange={onChange} />
      <span className="text-[11px] text-muted-foreground">
        表の合計 <span className="num">{fmt(rows)}</span>
        {diff !== 0 && `（差 ${fmtSigned(diff)}）`}
      </span>
    </div>
  )
}

/** 「決算書の額を入れる」を押したときだけ入力を開く。children はボタンの左に並べる文（基準の説明など） */
export function BasisSection({
  summary,
  basis,
  rule7Tax,
  onBasisChange,
  children,
}: {
  summary: readonly GyoshuSummary[]
  basis: Basis
  rule7Tax: Rule7Tax
  onBasisChange: BasisChange
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {children}
        <CollapsibleTrigger render={<Button size="xs" variant="outline" data-testid="basis-open" />}>{open ? "閉じる" : "決算書の額を入れる"}</CollapsibleTrigger>
      </div>
      {/* 閉じても入力中の字と「読めない」の知らせを残す（開き直すと続きから） */}
      <CollapsibleContent keepMounted>
        <BasisEditor summary={summary} basis={basis} rule7Tax={rule7Tax} onBasisChange={onBasisChange} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** 7割と金額のタブの表: 基準が何かの1行・決算書の額の入力（押したときだけ）・業種ごとの割合 */
export function GyoshuSummaryTable({
  summary,
  basis,
  rule7Tax,
  onBasisChange,
}: {
  summary: GyoshuSummary[]
  basis: Basis
  /** 7割の計算（基準をどちらの税で見るか） */
  rule7Tax: Rule7Tax
  onBasisChange: BasisChange
}) {
  const n = fromBookCount(summary)
  return (
    <div className="grid max-w-3xl gap-2">
      <BasisSection summary={summary} basis={basis} rule7Tax={rule7Tax} onBasisChange={onBasisChange}>
        <p className="text-xs text-muted-foreground" data-testid="basis-note" data-entered={n.total + n.motouke}>
          {basisText(summary, rule7Tax)}
        </p>
      </BasisSection>
      <GyoshuRatioTable summary={summary} />
    </div>
  )
}

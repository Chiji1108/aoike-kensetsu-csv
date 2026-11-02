import { useState } from "react"
import { CircleCheck, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { isUsableBasis, RULE7_TAX_LABELS, type Basis, type GyoshuSummary, type Rule7Tax } from "@/lib/convert/koji-selection"
import { parseInputNumber } from "@/lib/convert/text"
import { cn } from "@/lib/utils"

const fmt = (n: number) => Math.round(n).toLocaleString("ja-JP")

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

/** 入力中の文字はそのまま持ち、確定（フォーカスを外す・Enter）したときに数値にする。読めなければ残して知らせる */
function BasisInput({ value, label, onChange }: { value: number | undefined; label: string; onChange: (v: number | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  function commit() {
    if (draft === null) return
    const v = parseThousand(draft)
    if (draft.trim() && v === undefined) {
      setInvalid(true)
      return
    }
    onChange(v)
    setDraft(null)
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
        }}
      />
      {invalid && <div className="text-[11px] text-red-600">1以上の数字（千円）で入力してください</div>}
    </>
  )
}

type Side = "total" | "motouke"
type BasisChange = (code: string, side: Side, value: number | undefined) => void

const entered = (basis: Basis, code: string, side: Side) => isUsableBasis(basis[code]?.[side])

/** 元請の側を出す業種か（元請の工事があるか、決算書のうち元請を入れた）。元請の割合はそのときだけある */
const hasMotouke = (g: GyoshuSummary, basis: Basis) => g.motoukeTotal > 0 || entered(basis, g.code, "motouke")

/** 決算書の額を入れた業種の数（表にある業種だけ） */
export const enteredGyoshuCount = (summary: readonly GyoshuSummary[], basis: Basis) =>
  summary.filter((g) => entered(basis, g.code, "total") || entered(basis, g.code, "motouke")).length

/** 7割の基準が何か（顧客の表の合計か、決算書の額か） */
export function basisText(summary: readonly GyoshuSummary[], basis: Basis, rule7Tax: Rule7Tax) {
  const n = enteredGyoshuCount(summary, basis)
  const tax = RULE7_TAX_LABELS[rule7Tax]
  if (n === 0) return `基準（${tax}）: 顧客の表の合計。決算書の額を入れると正確になります`
  if (n === summary.length) return `基準（${tax}）: 決算書の額`
  return `基準（${tax}）: 決算書の額（${n} 業種）・ほかは顧客の表の合計`
}

/** 業種ごとの割合と7割を満たしているか（見るだけ）。7割の対象の行・載せる行の数と、基準に対する載せる額の割合 */
function RatioTable({ summary, basis }: { summary: readonly GyoshuSummary[]; basis: Basis }) {
  const motouke = summary.some((g) => hasMotouke(g, basis))
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full text-sm" data-testid="gyoshu-summary" data-motouke={motouke ? "1" : "0"}>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">業種</th>
            <th className="px-2 py-2 text-right font-medium whitespace-nowrap" title="載せる件数 / 7割の対象の件数">
              載せる
            </th>
            <th className="px-2 py-2 text-right font-medium whitespace-nowrap" title="載せる工事の額 ÷ 基準。7割を超えれば ✓">
              完成工事高
            </th>
            {motouke && (
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap" title="載せる元請の額 ÷ 元請の基準。7割を超えれば ✓" data-testid="motouke-head">
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
                    ＋除外から {g.fromExcluded.count} 件（割合に含めない）
                  </div>
                )}
              </td>
              <td className="px-2 py-2 text-right" data-testid="total-ratio" data-short={g.short.total ? "1" : "0"}>
                <Ratio ratio={g.totalRatio} short={g.short.total} fromBook={entered(basis, g.code, "total")} />
              </td>
              {motouke && (
                <td className="px-3 py-2 text-right" data-testid="motouke-ratio" data-short={g.short.motouke ? "1" : "0"}>
                  {hasMotouke(g, basis) ? <Ratio ratio={g.motoukeRatio} short={g.short.motouke} fromBook={entered(basis, g.code, "motouke")} /> : <span className="text-muted-foreground">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 割合と ✓ / 届かない。基準に決算書の額を使っていれば印を付ける */
function Ratio({ ratio, short, fromBook }: { ratio: number | undefined; short: boolean; fromBook: boolean }) {
  return (
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
  )
}

/** 入れた額と表の合計の差（入れた額 − 表の合計）。同じなら出さない */
function diffText(value: number | undefined, rows: number) {
  const d = Math.round(value === undefined ? 0 : value - rows)
  return value === undefined || d === 0 ? "" : `（差 ${d > 0 ? "+" : ""}${fmt(d)}）`
}

/** 業種ごとの決算書の額（完成工事高・うち元請）の入力。元請はその業種に元請の工事がある（か入れてある）ときだけ */
function BasisEditor({ summary, basis, rule7Tax, onBasisChange }: { summary: readonly GyoshuSummary[]; basis: Basis; rule7Tax: Rule7Tax; onBasisChange: BasisChange }) {
  const tax = RULE7_TAX_LABELS[rule7Tax]
  return (
    <div className="mt-2 rounded-xl border bg-muted/20 px-3 py-2" data-testid="basis-editor">
      <p className="text-xs text-muted-foreground">決算書の業種ごとの額（{tax}・千円）。空にすると顧客の表の合計に戻ります。</p>
      {summary.map((g) => {
        const e = basis[g.code]
        return (
          <div key={g.code} className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 border-t py-2 first-of-type:mt-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]" data-basis-gyoshu={g.code}>
            <div className="col-span-2 text-sm sm:col-span-1 sm:pt-6">
              <span className="num mr-1.5 text-muted-foreground">{g.code || "—"}</span>
              {g.label}
            </div>
            <BasisField className="sm:col-start-2" caption="完成工事高" label={`${g.label} の完成工事高（千円）`} value={e?.total} rows={g.total} onChange={(v) => onBasisChange(g.code, "total", v)} />
            {hasMotouke(g, basis) && (
              <BasisField className="sm:col-start-3" caption="うち元請" label={`${g.label} のうち元請（千円）`} value={e?.motouke} rows={g.motoukeTotal} onChange={(v) => onBasisChange(g.code, "motouke", v)} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function BasisField({ className, caption, label, value, rows, onChange }: { className?: string; caption: string; label: string; value: number | undefined; rows: number; onChange: (v: number | undefined) => void }) {
  return (
    <div className={cn("grid gap-1 text-xs", className)}>
      <span className="text-muted-foreground">{caption}</span>
      <BasisInput value={value} label={label} onChange={onChange} />
      <span className="text-[11px] text-muted-foreground">
        表の合計 <span className="num">{fmt(rows)}</span>
        {diffText(value, rows)}
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
  children?: React.ReactNode
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
  return (
    <div className="grid max-w-3xl gap-2">
      <BasisSection summary={summary} basis={basis} rule7Tax={rule7Tax} onBasisChange={onBasisChange}>
        <p className="text-xs text-muted-foreground" data-testid="basis-note" data-entered={enteredGyoshuCount(summary, basis)}>
          {basisText(summary, basis, rule7Tax)}
        </p>
      </BasisSection>
      <RatioTable summary={summary} basis={basis} />
    </div>
  )
}

/** 7割に届かない業種だけの表（書き出す前の確認） */
export function ShortGyoshuTable({ summary, basis }: { summary: readonly GyoshuSummary[]; basis: Basis }) {
  const short = summary.filter((g) => g.short.total || g.short.motouke)
  return short.length ? <RatioTable summary={short} basis={basis} /> : null
}

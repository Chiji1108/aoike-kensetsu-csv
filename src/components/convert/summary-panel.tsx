import { useState } from "react"
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
        className={cn("num h-8 w-28 text-right", invalid && "border-red-500")}
        inputMode="numeric"
        aria-label={label}
        aria-invalid={invalid}
        placeholder="行の合計"
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

/** 入力した基準額と行の合計（7割の計算の税）の差（基準額 − 行の合計） */
function Diff({ entered, rows }: { entered: number | undefined; rows: number }) {
  const d = Math.round(entered === undefined ? 0 : entered - rows)
  if (entered === undefined || d === 0) return null
  return <div className="text-[11px] text-muted-foreground">差 {d > 0 ? "+" : ""}{fmt(d)}</div>
}

export function GyoshuSummaryTable({
  summary,
  basis,
  rule7Tax,
  onBasisChange,
}: {
  summary: GyoshuSummary[]
  basis: Basis
  /** 7割の計算（金額の列をどちらの税で出すか） */
  rule7Tax: Rule7Tax
  onBasisChange: (code: string, side: "total" | "motouke", value: number | undefined) => void
}) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm" data-testid="gyoshu-summary">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2">業種</th>
            <th className="px-3 py-2 text-right">7割の対象の件数</th>
            <th className="px-3 py-2 text-right">載せる件数</th>
            <th className="px-3 py-2 text-right">完成工事高の合計（千円）</th>
            <th className="px-3 py-2 text-right">行の合計（{RULE7_TAX_LABELS[rule7Tax]}・千円）</th>
            <th className="px-3 py-2 text-right">うち元請（千円）</th>
            <th className="px-3 py-2 text-right">元請の行の合計（{RULE7_TAX_LABELS[rule7Tax]}・千円）</th>
            <th className="px-3 py-2 text-right">載せる元請 / 元請の基準</th>
            <th className="px-3 py-2 text-right">載せる工事 / 合計の基準</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((g) => {
            const entered = basis[g.code]
            return (
              <tr key={g.code} className="border-t align-top" data-gyoshu={g.code}>
                <td className="px-3 py-2">
                  <span className="num mr-1.5 text-muted-foreground">{g.code || "—"}</span>
                  {g.label}
                </td>
                <td className="num px-3 py-2 text-right">{g.count}</td>
                <td className="num px-3 py-2 text-right font-medium">
                  {g.selected}
                  {g.fromExcluded.count > 0 && (
                    <div className="text-[11px] font-normal text-muted-foreground" data-testid="from-excluded">
                      ＋除外から手動 {g.fromExcluded.count} 件（{fmt(g.fromExcluded.total)} 千円・比率に含めない）
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <BasisInput value={entered?.total} label={`${g.label} の完成工事高の合計（千円）`} onChange={(v) => onBasisChange(g.code, "total", v)} />
                  <Diff entered={entered?.total} rows={g.total} />
                </td>
                <td className="num px-3 py-2 text-right">{fmt(g.total)}</td>
                <td className="px-3 py-1.5 text-right">
                  <BasisInput value={entered?.motouke} label={`${g.label} のうち元請（千円）`} onChange={(v) => onBasisChange(g.code, "motouke", v)} />
                  <Diff entered={entered?.motouke} rows={g.motoukeTotal} />
                </td>
                <td className="num px-3 py-2 text-right">{fmt(g.motoukeTotal)}</td>
                <td className={cn("num px-3 py-2 text-right", g.short.motouke && "text-amber-700")}>{pct(g.motoukeRatio)}</td>
                <td className={cn("num px-3 py-2 text-right", g.short.total && "text-amber-700")} data-testid="total-ratio">
                  {pct(g.totalRatio)}
                  {g.short.total && <div className="text-[11px]">基準額の7割に届いていません（{pct(g.totalRatio)}）</div>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

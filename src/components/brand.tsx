import { FileSpreadsheet } from "lucide-react"
import { cn } from "@/lib/utils"

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm",
        className,
      )}
    >
      <FileSpreadsheet className="size-[55%]" strokeWidth={2.25} />
    </span>
  )
}

# tooltip

2026-10-29, golden pair (three-way merge: user file / radix-nova / base-nova, via git merge-file) with one hand-resolved import conflict. Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/tooltip.tsx`: Portal > Positioner > Popup; Provider `delayDuration` -> `delay`.
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/tooltip.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes

TooltipContent default `sideOffset` 0 -> 4 (registry). No TooltipContent consumer exists; only TooltipProvider in `__root.tsx`.

## Verify by hand

n/a (no tooltip in the app).

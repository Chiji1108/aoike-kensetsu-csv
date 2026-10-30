# select

2026-10-29, golden pair (base-nova content, CLI icon transform replayed by script; user's only diffs were CLI transforms and Japanese labels). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/select.tsx`: Viewport -> List, ScrollButtons -> ScrollArrows, `position` -> `alignItemWithTrigger`. Registry marker classes removed.
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/select.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes

Unused in the app today (forms use NativeSelect).

## Verify by hand

n/a (no consumer).

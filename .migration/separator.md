# separator

2026-10-29, golden pair (three-way merge: user file / radix-nova / base-nova, via git merge-file) with one hand-resolved import conflict (kept the user's removal of "use client"). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/separator.tsx`: callable `SeparatorPrimitive`; `decorative` prop dropped.
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/separator.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes

Separator is always exposed to assistive tech as a separator (no `decorative`). Used inside the dropdown menu only.

## Verify by hand

Open the header menu: the line between items shows.

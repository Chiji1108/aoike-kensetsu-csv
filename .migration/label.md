# label

2026-10-29, golden pair (three-way merge: user file / radix-nova / base-nova, via git merge-file). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/label.tsx`: Radix Label -> native `<label>` (Base UI has no Label).
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/label.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes



## Verify by hand

Click a label: focus moves to its input.

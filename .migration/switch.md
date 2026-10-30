# switch

2026-10-29, golden pair (three-way merge: user file / radix-nova / base-nova, via git merge-file). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/switch.tsx`: `SwitchPrimitive.Root.Props`. Consumers keep `onCheckedChange(checked)`; the new event-details argument is ignored.
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/switch.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes



## Verify by hand

Toggle 「業種ごとに元請→下請…」 and the password-dialog switch with click and Space.

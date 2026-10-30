# button

2026-10-29, golden pair (three-way merge: user file / radix-nova / base-nova, via git merge-file). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/button.tsx`: Slot/asChild -> `@base-ui/react/button`. `src/routes/__root.tsx`: NotFound link uses `render={<Link to="/" />} nativeButton={false}`.
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/button.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes

`data-variant` / `data-size` attributes are no longer set on the button (base-nova registry). No consumer reads them.

## Verify by hand

Tab to a button and press Enter/Space. The 404 page's 「トップへ戻る」 navigates to /.

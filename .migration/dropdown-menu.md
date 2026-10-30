# dropdown-menu

2026-10-29, golden pair (base-nova content, CLI icon transform replayed by script; user's only diffs were CLI transforms and Japanese labels). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/dropdown-menu.tsx`: Menu primitives (Positioner/Popup, GroupLabel, CheckboxItemIndicator, Submenu*). Registry marker classes `cn-menu-*`/`cn-rtl-flip` removed as the CLI would. `src/components/app-shell.tsx`: Trigger `asChild` -> `render`, item `onSelect` -> `onClick`.
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/dropdown-menu.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes

CheckboxItem does not close the menu on click (Base UI `closeOnClick` default false). The new 「表示する列」 menu relies on this to toggle several columns.

## Verify by hand

Open the header menu with click and Enter; arrow keys move; Esc closes.

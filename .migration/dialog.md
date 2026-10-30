# dialog

2026-10-29, golden pair (base-nova content, CLI icon transform replayed by script; user's only diffs were CLI transforms and Japanese labels). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/dialog.tsx`: Overlay -> Backdrop, Content -> Popup, Close `render`. Kept the Japanese 「閉じる」 labels and "use client".
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/dialog.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes



## Verify by hand

Header menu -> パスワード変更: dialog opens, Esc closes, focus returns to the menu button. Covered by `e2e/preview-table.spec.ts`.

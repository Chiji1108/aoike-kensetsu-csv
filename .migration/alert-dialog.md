# alert-dialog

2026-10-29, golden pair (three-way merge: user file / radix-nova / base-nova, via git merge-file). Migrated; typecheck, unit tests, build and e2e pass.

## Changed

`src/components/ui/alert-dialog.tsx`: Overlay -> Backdrop, Content -> Popup, Cancel -> Close with `render`, Action is a plain Button. `src/routes/_authed/index.tsx`: the 「このままダウンロード」 action closes the dialog itself before downloading.
Leftover scan `grep -n "radix-ui\|@radix-ui" src/components/ui/alert-dialog.tsx` is clean.

## Left alone

`sonner.tsx` and `native-select.tsx` are not Radix. `card.tsx`, `table.tsx` and `textarea.tsx` are identical in radix-nova and base-nova.

## Behavior changes

AlertDialogAction no longer closes the dialog (Base UI has no Action part). The only consumer now calls `setConfirmOpen(false)` explicitly. Covered by `e2e/preview-table.spec.ts` when the CSV has errors.

## Verify by hand

Open the error-confirm dialog: Esc and 「戻って直す」 close it and return focus to the download button; 「このままダウンロード」 downloads and closes.

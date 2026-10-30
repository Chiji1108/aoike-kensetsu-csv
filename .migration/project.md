# project

2026-10-29, whole-project mode. `components.json` style `radix-nova` -> `base-nova`; `@base-ui/react` added, `radix-ui` removed.

## Changed

11 wrappers migrated (one commit each, button with alert-dialog). App-code sweep: `asChild` (2 call sites), `onSelect` on menu items (2), AlertDialogAction close (1).
`checkbox.tsx` added from base-nova for the preview table.

## Left alone

sonner, native-select (not Radix); card, table, textarea (no Radix and no base diff).

## Behavior changes

See alert-dialog (Action no longer closes) and dropdown-menu (checkbox items stay open).

## Verify by hand

`bun run typecheck`, `bun test`, `bun run build` pass. `E2E_PASSWORD=... bun run e2e` passes. 0 wrappers remain on Radix.

The shadcn CLI (`shadcn add <c> --overwrite`, both 4.21.5 and latest) currently writes `import { cn } from "cn"` and adds a `cn` npm dependency for base-nova items, so the registry content was merged directly instead.

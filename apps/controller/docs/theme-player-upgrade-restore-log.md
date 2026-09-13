# Theme + Active Player Upgrade Restore Log

## Restore ID
- pre-theme-player-upgrade-20260814-161445

## Baseline Context
- Workspace: C:\Users\Austi\Desktop\Overlays\BINGO - Public
- Git metadata: unavailable (`.git` not present), so restore is file-based.
- Restore artifacts root: `restore-artifacts/pre-theme-player-upgrade-20260814-161445`
- Manifest: `restore-artifacts/pre-theme-player-upgrade-20260814-161445/manifest.txt`

## Backed Up Files
- `apps/controller/src/index.ts`
- `apps/control/src/App.tsx`
- `apps/control/src/App.css`
- `apps/controller/test/mod-options-control.test.mjs`

## Baseline Anchors (Pre-Edit)
- Controller theme patch logic near `applyThemePatch` and `/api/mod/state` in `apps/controller/src/index.ts`.
- Session summary mapper near `toSessionSummary` in `apps/controller/src/index.ts`.
- Control theme draft and theme server-sync effect in `apps/control/src/App.tsx`.
- Control Theme panel render block in `apps/control/src/App.tsx`.
- Control theme styles and responsive rules in `apps/control/src/App.css`.
- Controller mod endpoint tests in `apps/controller/test/mod-options-control.test.mjs`.

## File Restore Steps
1. Stop local dev servers.
2. Copy each backup file from `restore-artifacts/pre-theme-player-upgrade-20260814-161445/backups/` over the workspace file with the same relative path.
3. Run:
   - `npm --workspace @bingo/controller test`
   - `npm --workspace @bingo/controller run build`
   - `npm --workspace @bingo/control run build`
4. Confirm behavior matches pre-upgrade baseline.

## Notes
- This restore point was created before applying active player list, random selector, respin, and theme live preview changes.

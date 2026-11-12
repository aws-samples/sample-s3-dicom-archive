# website-data-user: the data-user UI

The data-user site served at `/data-user/`, in the same design as the admin
UI in `website/`. It replaced the original Cloudscape data-user UI (removed
2026-10-13), keeping its pages, services and auth. As in `website/`, the
components keep their `@cloudscape-design/*` imports and `vite.config.ts`
points them at the UI kit in `src/ui/` (copied from `website/src/ui`), so
Cloudscape is not shipped.

- `src/ui/data-user-shell.tsx`: the app chrome. A collapsible sidebar lists the
  storages and virtual folders the user can browse; the top bar has the
  "Not for Diagnosis or Treatment" badge, theme toggle, version and user menu;
  a resizable bottom panel replaces the Cloudscape SplitPanel (study details).
- Color themes (`src/themes/palettes.ts`, `src/contexts/ThemeContext.tsx`) are
  the same as the admin UI and are chosen in Preferences.
- The "Navigation style" preference and the old Modern shell are removed.

Build: `npm ci && npm run build` (needs `public/config.json`, written by CodeBuild).

Deploy: CDK builds the data-user site from this folder
(`cdk-infrastructure/lib/data-user-ui/data-user-ui-stack.ts`).

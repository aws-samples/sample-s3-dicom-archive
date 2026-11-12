# website: the admin UI

The admin console served at `/admin/`. It replaced the original Cloudscape UI
(removed 2026-10-13); the pages, services, auth, privilege checks and API calls
were kept from it and only the presentation layer was rewritten.

## How it works

The pages were written against Cloudscape components (`Table`, `Modal`,
`Select`, `Header`, ...). The site keeps those imports and points them, in
`vite.config.ts`, at its own UI kit in `src/ui/`:

| Import in page code | Resolves to |
|---|---|
| `@cloudscape-design/components` | `src/ui/index.tsx` |
| `@cloudscape-design/components/theming` | `src/ui/theming.ts` (no-op; themes are CSS tokens) |
| `@cloudscape-design/global-styles` | `src/ui/global-styles.ts` (`applyMode` toggles `html.dark`) |
| `@cloudscape-design/global-styles/index.css` | `src/ui/styles.css` (Tailwind v4 + design tokens) |

The kit implements the props and event shapes the pages use (`({ detail })`
handlers, `preventDefault`, `selectedOption`, `columnDefinitions`, ...). It
covers about 50 components and is built on Radix primitives, Tailwind v4,
lucide icons and Recharts, in the shadcn/ui style. No Cloudscape code is
bundled. The Cloudscape packages stay in `package.json` only so that `tsc`
type-checks the pages against the original contracts.

`src/ui/layout.tsx` holds the new shell:

- a sidebar that collapses to an icon rail, with section headings, a marker on the active page and tooltips when collapsed;
- a top bar with a breadcrumb, the "Not for Diagnosis or Treatment" badge, search (⌘K opens the command palette), Data User View, docs, theme toggle, version and the user menu;
- a mobile drawer.

The navigation items still come from `App.tsx`, built from the user's
privileges.

## Tokens

All colours are semantic OKLCH variables in `src/ui/styles.css` (light and
`.dark`). The type scale is 11/12/14/16/17/22 px in Inter. Components never
use literal colours, so both themes stay consistent.

## Build

- Local: `npm ci && npm run build`; `npm run preview` serves `dist/` at `/admin/`.
  It needs a `dist/config.js` like the one CodeBuild writes.
- CDK builds the admin site from this folder
  (`cdk-infrastructure/lib/cicd/ci-cd-construct.ts`).

## Measured against the old Cloudscape UI (test deployment, 2026-10-04)

The audit opens all 22 routes, with headless Chromium and axe-core 4.

| | Old Cloudscape UI | This UI |
|---|---|---|
| Routes rendered without error | 22/22 | 22/22, light and dark |
| axe WCAG 2 A/AA violations | 85 critical (55 unnamed buttons, 30 unlabeled fields) | 0, light and dark |
| User-flow parity checks (12 flows) | 11/12 (one test locator does not match Cloudscape's markup) | 12/12 local, 12/12 on a test deployment |
| JS shipped | 2.97 MB | 1.89 MB |
| CSS shipped | 1.32 MB | 59 KB |
| Distinct font sizes per page (lower is more consistent) | 3.2 | 4.0 |

The user flows cover:

- the plugin register modal with live validation;
- the plugin editor;
- the run detail, with pipeline stage and write-back;
- the create-storage modal;
- user row selection and the Actions menu;
- audit-trail pagination and the user filter;
- command-palette navigation;
- the studies storage picker;
- import-center tabs;
- the index-attribute list;
- running an analytics query.

Known gaps:

- Page code that sets inline font sizes adds to the font-size count.
- The kit's `Table` sorts on the client when a page gives sortable columns but
  no `onSortingChange`. Cloudscape ignores the click in that case.

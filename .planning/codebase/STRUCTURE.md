# Codebase Structure

**Analysis Date:** 2026-08-23

## Directory Layout

```
hwp-editor/
├── packages/
│   ├── core/                  # @hwp-editor/core — framework-free contract + transports
│   │   ├── src/               # engine.ts, protocol.ts, ops.ts, segments.ts, state.ts, http-engine.ts, tauri.ts, spec.ts, index.ts
│   │   │   └── generated/     # TS types generated from schemas/ (do not hand-edit)
│   │   ├── schemas/           # Pinned hwp-cli JSON schemas (frozen contract)
│   │   ├── scripts/           # gen-spec-types.mjs (schema → TS codegen)
│   │   ├── test/              # Vitest unit tests + fixtures/
│   │   └── dist/              # Build output (tsup; committed? no — generated)
│   ├── react/                 # @hwp-editor/react — embeddable React editor UI
│   │   ├── src/               # HwpEditor.tsx + panels + helpers + theme.css/editor.css
│   │   ├── test/              # Vitest + Testing Library tests, mock-engine.ts
│   │   └── dist/              # Build output (tsup, includes index.css)
│   └── server/                # @hwp-editor/server — Node adapter spawning hwp-cli
│       ├── src/               # cli-engine.ts, routes.ts, session.ts, next.ts, index.ts
│       ├── test/              # Vitest tests, helpers.ts
│       └── dist/              # Build output (tsup)
├── apps/
│   └── playground/            # Next.js smoke harness + Playwright e2e (real binary)
│       ├── app/               # App Router: page.tsx, editor/page.tsx, api/hwp-editor/[...action]/route.ts
│       ├── e2e/               # editor.spec.ts (Playwright)
│       ├── fixtures/          # Source .hwpx fixtures (seeded by scripts/seed-fixtures.mjs)
│       ├── public/fixtures/   # Served fixtures + manifest.json
│       └── scripts/           # seed-fixtures.mjs
├── docs/                      # Host integration guides + theme contract
├── .planning/codebase/        # GSD codebase analysis docs (this directory)
├── package.json               # Root: private workspace, pnpm -r scripts
├── pnpm-workspace.yaml        # Workspace: packages/*, apps/*
├── tsconfig.base.json         # Shared TS config extended by each package
└── pnpm-lock.yaml
```

## Directory Purposes

**`packages/core/src`:**
- Purpose: The shared contract and framework-free logic — everything both the UI and the server need
- Contains: Interfaces, pure functions, reducer store, fetch/invoke engine clients, generated spec types
- Key files: `engine.ts` (HwpEngine interface), `protocol.ts` (HTTP wire shapes), `ops.ts` (EditOp union ↔ argv), `segments.ts` (segment envelope + coordinates), `state.ts` (editor store), `http-engine.ts`, `tauri.ts`, `index.ts` (barrel)

**`packages/core/src/generated`:**
- Purpose: TypeScript types generated from the pinned JSON schemas
- Contains: `document-spec-v2.ts`, `template-spec-v1.ts`, `template-data-v1.ts`
- Generated: Yes — by `scripts/gen-spec-types.mjs` (runs on `pnpm build`); never hand-edit; edit `schemas/*.json` instead

**`packages/react/src`:**
- Purpose: Embeddable editor UI, one file per panel/component, helpers as plain `.ts`
- Contains: `HwpEditor.tsx` (top level), `PageCanvas.tsx`, `SegmentInspector.tsx`, `TableGrid.tsx`, `FieldsPanel.tsx`, `ComposePanel.tsx`, `context.ts` (internal context), helpers (`geometry.ts`, `tables.ts`, `fields.ts`, `text.ts`, `sanitize.ts`, `presets.ts`, `errors.ts`), styles (`theme.css`, `editor.css`)
- Key files: `HwpEditor.tsx` (composition root), `context.ts` (`HwpEditorContext` shared by panels), `index.ts` (public barrel)

**`packages/server/src`:**
- Purpose: Node-side implementation of the protocol.ts contract over the hwp binary
- Contains: `cli-engine.ts` (subprocess engine), `routes.ts` (framework-agnostic Fetch handler), `session.ts` (server-internal sessions), `next.ts` (Next.js factory), `index.ts` (barrel)
- Key files: `routes.ts` (HTTP surface), `cli-engine.ts` (all hwp-cli invocation + hardening)

**`apps/playground`:**
- Purpose: Local smoke/e2e harness — NOT a shipped product; exercises the packages over the real binary
- Contains: Next.js App Router app, Playwright e2e, .hwpx fixtures
- Key files: `app/api/hwp-editor/[...action]/route.ts` (2-line route via `createHwpEditorRoutes`), `app/editor/page.tsx` (`<HwpEditor>` over `createHttpEngine`), `e2e/editor.spec.ts`

**`docs`:**
- Purpose: Host integration recipes and theming contract
- Contains: `integration-ax.md` (Next.js/Vercel, canonical), `integration-maru.md` (Tauri), `integration-web.md` (browser), `theme-contract.md` (`--hwped-*` variables)

## Key File Locations

**Entry Points:**
- `packages/core/src/index.ts`: `@hwp-editor/core` public API barrel
- `packages/react/src/index.ts`: `@hwp-editor/react` barrel; `./style.css` subpath export
- `packages/server/src/index.ts`: `@hwp-editor/server` barrel
- `packages/server/src/next.ts`: `@hwp-editor/server/next` subpath (`createHwpEditorRoutes`)
- `apps/playground/app/editor/page.tsx`: running editor demo

**Configuration:**
- `package.json` (root): workspace scripts (`pnpm -r build/test/typecheck`), Node >= 22 / pnpm 10 engines
- `pnpm-workspace.yaml`: workspace globs
- `tsconfig.base.json`: shared compiler options; each package extends it in `packages/*/tsconfig.json`
- `packages/*/tsup.config.ts`: per-package build (ESM+CJS+d.ts)
- `packages/*/vitest.config.ts`: per-package test config
- `apps/playground/next.config.ts`, `apps/playground/playwright.config.ts`: app configs

**Core Logic:**
- `packages/core/src/engine.ts`: the `HwpEngine` contract
- `packages/core/src/ops.ts`: edit-op grammar (pinned to hwp-cli v0.8.7)
- `packages/server/src/cli-engine.ts`: subprocess engine + hardening
- `packages/server/src/routes.ts`: HTTP contract implementation

**Testing:**
- `packages/core/test/`: `ops.test.ts`, `segments.test.ts`, `state.test.ts`, `tauri-engine.test.ts` + `fixtures/`
- `packages/react/test/`: `editor.test.tsx`, `utils.test.ts`, `mock-engine.ts` (canonical engine test double)
- `packages/server/test/`: `cli-engine.test.ts`, `routes.test.ts`, `session.test.ts`, `helpers.ts`
- `apps/playground/e2e/editor.spec.ts`: Playwright e2e against the real binary

## Naming Conventions

**Files:**
- Components: PascalCase `.tsx` — `HwpEditor.tsx`, `PageCanvas.tsx`, `SegmentInspector.tsx`
- Helpers/modules: kebab-case or single-word lowercase `.ts` — `http-engine.ts`, `cli-engine.ts`, `geometry.ts`, `state.ts`
- Tests: `<module>.test.ts(x)` co-located in a sibling `test/` directory (not next to source)
- Generated: schema name verbatim — `generated/document-spec-v2.ts` from `schemas/document-spec-v2.schema.json`

**Directories:**
- Workspace packages: `packages/<noun>` (`core`, `react`, `server`); apps: `apps/<name>`
- Tests always in `<pkg>/test/`, fixtures in `test/fixtures/` or app-level `fixtures/`

**Packages:**
- npm scope `@hwp-editor/<dir>` for libraries; playground is unscoped (`playground`)

**Identifiers/CSS:**
- Exports use `createX` factory naming — `createHttpEngine`, `createTauriEngine`, `createCliEngine`, `createHwpEditorHandler`, `createHwpEditorRoutes`, `createStore`, `createSessionStore`
- CSS classes `hwped-*` prefixed; theme variables `--hwped-*`; Tauri commands `hwped_*`

**Imports:**
- ESM with explicit `.js` extensions on relative imports (e.g. `from "./ops.js"`), even in `.tsx` files
- Cross-package imports use the workspace name (`@hwp-editor/core`), never relative paths

## Where to Add New Code

**New engine capability (new `hwp` subcommand):**
- Interface method: `packages/core/src/engine.ts`
- Wire shapes: `packages/core/src/protocol.ts`
- HTTP client: `packages/core/src/http-engine.ts`; Tauri client: `packages/core/src/tauri.ts`
- Server implementation: `packages/server/src/cli-engine.ts` (subprocess) + `packages/server/src/routes.ts` (action handler; add to `ACTIONS` set)
- Tests: `packages/core/test/`, `packages/server/test/routes.test.ts`

**New edit op kind:**
- Union member + argv mapping: `packages/core/src/ops.ts` (`EditOp`, `opsToArgv`, `argvToOps`)
- Tests: `packages/core/test/ops.test.ts`

**New UI panel/component:**
- Implementation: `packages/react/src/<Name>.tsx`; consume shared state via `useHwpEditorContext` (`context.ts`)
- Register: add a tab/composition in `packages/react/src/HwpEditor.tsx`, export from `packages/react/src/index.ts`
- Styles: `packages/react/src/editor.css` with `hwped-*` classes; themeable values as `--hwped-*` vars in `theme.css`
- Tests: `packages/react/test/` using `mock-engine.ts`

**New pure helper (geometry/tables/fields-like):**
- Implementation: `packages/react/src/<name>.ts` (UI-coupled) or `packages/core/src/<name>.ts` (host-agnostic, dependency-free)
- Tests: matching `<name>.test.ts` in the package's `test/` directory

**New shared/store state:**
- Reducer action + state field: `packages/core/src/state.ts`; tests in `packages/core/test/state.test.ts`

**New host integration:**
- Recipe doc: `docs/integration-<host>.md`; reuse an existing engine factory — do not fork the protocol

## Special Directories

**`packages/core/schemas/`:**
- Purpose: Frozen JSON schemas that pin the `hwp compose`/`hwp template` contract
- Generated: No — copied/pinned from hwp-cli
- Committed: Yes. Changes here require regenerating `src/generated/` via `pnpm --filter @hwp-editor/core gen:types`

**`packages/*/dist/`:**
- Purpose: tsup build output (ESM + CJS + d.ts; react also emits `index.css`)
- Generated: Yes (`pnpm -r build`)
- Committed: No

**`apps/playground/.next/`, `apps/playground/test-results/`:**
- Purpose: Next.js build/dev output, Playwright results
- Generated: Yes
- Committed: No

**`apps/playground/public/fixtures/`:**
- Purpose: .hwpx fixtures served to the browser + `manifest.json`
- Generated: Yes — seeded from `apps/playground/fixtures/` by `scripts/seed-fixtures.mjs` (`pnpm --filter playground seed`)
- Committed: Seeded copies are gitignored; source fixtures under `apps/playground/fixtures/` are committed

**`.planning/`:**
- Purpose: GSD planning/analysis artifacts (this document)
- Generated: By GSD commands
- Committed: Yes

---

*Structure analysis: 2026-08-23*

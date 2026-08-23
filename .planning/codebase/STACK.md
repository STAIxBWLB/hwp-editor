# Technology Stack

**Analysis Date:** 2026-08-23

## Languages

**Primary:**
- TypeScript ~5.9.2 — all packages (`packages/core`, `packages/react`, `packages/server`, `apps/playground`); strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (see `tsconfig.base.json`)

**Secondary:**
- JSON Schema — spec contracts in `packages/core/schemas/*.schema.json` (document-spec v1/v2, template-spec v1, template-data v1), compiled to TS types by `packages/core/scripts/gen-spec-types.mjs` into `packages/core/src/generated/`
- CSS — scoped editor styles `packages/react/src/editor.css`, theme contract `packages/react/src/theme.css` (`--hwped-*` variables only)
- Rust (external, not in this repo) — Tauri hosts implement `hwped_*` commands; hwp-cli itself is a Rust binary

## Runtime

**Environment:**
- Node.js >= 22 (enforced via `engines` in root `package.json`); required for native `fetch`, `FormData`, `Blob`, Web `Request`/`Response` used by the HTTP contract
- Browser + Tauri 2 webview targets for `packages/core` and `packages/react` (core is isomorphic: `http-engine.ts` and `tauri.ts` run in all three)

**Package Manager:**
- pnpm 10 (`packageManager: pnpm@10.0.0`, `engines.pnpm >= 10`)
- Lockfile: `pnpm-lock.yaml` present
- Workspace: `pnpm-workspace.yaml` — `packages/*` + `apps/*`; `onlyBuiltDependencies: [esbuild]`

## Frameworks

**Core:**
- None (framework-free by design) — `packages/core` has zero runtime dependencies; pure TypeScript engine interface (`packages/core/src/engine.ts`)

**UI:**
- React >= 19 (peer dependency) — `packages/react`; embeddable editor components (`HwpEditor.tsx`, `PageCanvas.tsx`, `SegmentInspector.tsx`, `TableGrid.tsx`, `FieldsPanel.tsx`, `ComposePanel.tsx`)

**Server:**
- None required — `packages/server` exposes a framework-agnostic Web `Request`/`Response` handler (`packages/server/src/routes.ts`) plus a Next.js App Router factory (`packages/server/src/next.ts`)

**Playground app:**
- Next.js ^16.3.2 — `apps/playground` (App Router; API route at `apps/playground/app/api/hwp-editor/[...action]/route.ts`)

**Testing:**
- Vitest ^3.2.4 — unit tests in all three packages (`test/**/*.test.ts(x)`)
- @testing-library/react ^16.3.0 + jsdom ^26.1.0 — React component tests
- @playwright/test ^1.55.0 — e2e against the real binary (`apps/playground/e2e`, config `apps/playground/playwright.config.ts`)

**Build/Dev:**
- tsup ^8.5.0 — bundler for all three packages (ESM + CJS dual output, `.d.ts`, sourcemaps; `target: esnext`)
- json-schema-to-typescript ^15.0.4 — spec type generation (`pnpm --filter @hwp-editor/core gen:types`)
- TypeScript `tsc --noEmit` — per-package `typecheck` script

## Key Dependencies

**Critical:**
- hwp-cli binary (external, >= 0.8.7, enforced at runtime by `ensureVersion()` in `packages/server/src/cli-engine.ts`) — ALL document work (cat/render/edit/compose/validate/fields/bookmarks/slots/info) is delegated to this binary; this repo contains no HWP parsing logic

**Workspace (internal):**
- `@hwp-editor/core` — engine interface, typed edit ops (`ops.ts`), segment parsing (`segments.ts`), HTTP/Tauri clients, generated spec types
- `@hwp-editor/react` — depends on `@hwp-editor/core` (`workspace:*`)
- `@hwp-editor/server` — depends on `@hwp-editor/core` (`workspace:*`)

**Infrastructure:**
- Node stdlib only in `packages/server`: `node:child_process` (execFile), `node:fs/promises`, `node:crypto` (sha256, randomUUID), `node:os`, `node:path` — no runtime npm dependencies
- All packages are `private: true`; distributed as tarballs/git deps, not published to npm

## Configuration

**Environment:**
- `HWP_EDITOR_BIN` — explicit path to the hwp binary (preferred override)
- `HWP_CLI` — secondary binary-path fallback
- `PATH` — final fallback for binary resolution (`hwp` on PATH)
- `HWP_*` vars (e.g. `HWP_LANG`, `HWP_FONT_DIR`) — passed through to the child process by `scrubbedEnv()` in `packages/server/src/cli-engine.ts`; everything else is stripped
- No `.env` files present in the repo; no secrets management needed (no external service credentials)

**Build:**
- `tsconfig.base.json` — shared strict compiler options; per-package `tsconfig.json` extends it
- `packages/*/tsup.config.ts` — build config per package
- `packages/*/vitest.config.ts` — test config (react package uses `environment: "jsdom"`)
- `apps/playground/next.config.ts` — `serverExternalPackages: ["@hwp-editor/server"]` (keeps the binary-spawning adapter out of the Next bundle)

## Platform Requirements

**Development:**
- Node >= 22, pnpm 10
- hwp-cli >= 0.8.7 binary for server tests and playground (default debug path referenced in `apps/playground/playwright.config.ts` and `packages/server/test/helpers.ts`; override with `HWP_EDITOR_BIN`)
- Chromium via `playwright install chromium` for e2e

**Production:**
- Any Node >= 22 host that can spawn child processes (serverless filesystem/timeout limits apply — the engine needs exec + temp dir + up to 60s per call; see `HWP_TIMEOUT_MS` in `packages/server/src/cli-engine.ts`)
- Canonical deploy target: Next.js on Vercel with the binary provisioned at build time (`docs/integration-ax.md`)
- Desktop: Tauri 2 host implementing `hwped_*` Rust commands (`docs/integration-maru.md`)
- Browser-only: hosted HTTP endpoint + `createHttpEngine` (`docs/integration-web.md`)

---

*Stack analysis: 2026-08-23*

# External Integrations

**Analysis Date:** 2026-08-23

This repo deliberately has **no SaaS integrations** — no databases, auth providers, payment APIs, or third-party SDKs. The single external dependency is the **hwp-cli binary**, reached via subprocess or behind host-provided transports. All integration surface area is the internal `protocol.ts` HTTP contract (`packages/core/src/protocol.ts`) and the Tauri command bridge.

## APIs & External Services

**Document engine (the only external dependency):**
- hwp-cli binary (>= 0.8.7) — all document reading, rendering, editing, composing, and validation
  - SDK/Client: none (subprocess via `execFile` in `packages/server/src/cli-engine.ts`)
  - Subcommands used: `cat --with-segments`, `render`, `edit`, `compose`, `validate`, `fields`, `bookmarks`, `slots`, `info`, `--version`
  - Auth: none; binary path configured via `HWP_EDITOR_BIN` / `HWP_CLI` env vars or `bin` option
  - Hardening: execFile only (no shell), 60s timeout (`HWP_TIMEOUT_MS`), 32MB maxBuffer, scrubbed child env (only `PATH`/`HOME`/`LANG`/`HWP_*`), per-call mkdtemp workspace removed on all paths, minimum-version check per process

**Internal HTTP contract (host-facing, not a third-party API):**
- `POST /read`, `POST /render`, `POST /edit`, `POST /compose`, `POST /validate`, `GET /capabilities` — defined in `packages/core/src/protocol.ts`
- Client: `createHttpEngine(baseUrl)` in `packages/core/src/http-engine.ts` (multipart FormData for documents, base64 for binary payloads, JSON for compose)
- Server: `createHwpEditorHandler` (`packages/server/src/routes.ts`) and `createHwpEditorRoutes` for Next.js (`packages/server/src/next.ts`)
- Auth: none built in — hosts inject it via the `fetch` option of `createHttpEngine` (`docs/integration-web.md`)

**Tauri command bridge (desktop hosts):**
- Rust commands `hwped_read`, `hwped_render`, `hwped_edit`, `hwped_compose`, `hwped_validate`, `hwped_capabilities`
- Client: `createTauriEngine(invoke)` in `packages/core/src/tauri.ts`; `invoke` is injected by the host (peer pattern — zero dependency on `@tauri-apps/api` in this repo)
- File transfer: workspace paths preferred (`pathOf` option), base64 fallback; `workspaceRoot` passed on every call

## Data Storage

**Databases:**
- None. Server-side document sessions (`packages/server/src/session.ts`) are ephemeral files in a private `mkdtemp` directory under `os.tmpdir()` with a 30-minute TTL (`DEFAULT_TTL_MS`) — never a persistent store

**File Storage:**
- Local filesystem only: per-call temp dirs (`hwp-editor-*` under `os.tmpdir()`) in `cli-engine.ts`; session store root in `session.ts`. Playground fixtures in `apps/playground/fixtures` (seeded by `apps/playground/scripts/seed-fixtures.mjs`)

**Caching:**
- In-process only: read-pipeline inspection cache keyed by document sha256 (64-entry LRU) and pre-edit undo snapshots (256-entry) in `packages/server/src/cli-engine.ts`. No external cache (no Redis/memcached)

## Authentication & Identity

**Auth Provider:**
- None in this repo. The wire contract is unauthenticated by design; hosts wrap the handler or inject an authorized `fetch`:
  - ax (Next.js/Vercel) — host-side route protection around `createHwpEditorRoutes` (`docs/integration-ax.md`)
  - maru-web / anchor.halla.ai — auth headers via the `fetch` injection option of `createHttpEngine` (`docs/integration-web.md`)

## Monitoring & Observability

**Error Tracking:**
- None

**Logs:**
- None — errors propagate as typed exceptions: `HwpCliError` with `reason` (`unavailable` | `version` | `timeout` | `failed` | `bad_request` | `unsupported_format`) in `packages/server/src/cli-engine.ts`; HTTP layer maps them to `ErrorResponse` JSON in `packages/core/src/protocol.ts`

## CI/CD & Deployment

**Hosting:**
- No deployment config in this repo (no Dockerfile, no CI workflows — `.github/` does not exist)
- Canonical consumer deploys: Next.js 16 on Vercel (ax), Tauri 2 desktop (maru), static browser hosts (maru-web) — see `docs/integration-*.md`

**CI Pipeline:**
- None configured. Local gates: `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`; e2e via `pnpm --filter playground test:e2e` (spawns `next dev -p 3100` with the real binary)

**Distribution:**
- Packages are `private: true` — consumed as `pnpm pack` tarballs (`file:./vendor/*.tgz`) or pinned git dependencies, per `docs/integration-ax.md`

## Environment Configuration

**Required env vars:**
- None strictly required. Optional:
  - `HWP_EDITOR_BIN` — path to the hwp binary (used by server adapter, playground route, server tests, Playwright config)
  - `HWP_CLI` — fallback binary path
  - `HWP_*` (e.g. `HWP_LANG`, `HWP_FONT_DIR`) — forwarded to the hwp-cli child process
  - `CI` — standard flag; disables dev-server reuse in `apps/playground/playwright.config.ts`

**Secrets location:**
- Not applicable — no secrets or credentials anywhere in the repo; the child-process env is explicitly scrubbed to prevent leaking host credentials to the binary (`scrubbedEnv()` in `packages/server/src/cli-engine.ts`)

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None

---

*Integration audit: 2026-08-23*

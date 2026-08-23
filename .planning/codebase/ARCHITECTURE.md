<!-- refreshed: 2026-08-23 -->
# Architecture

**Analysis Date:** 2026-08-23

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                     Hosts / Embeddable UI                            │
├───────────────────────┬───────────────────────┬──────────────────────┤
│  apps/playground      │  ax (Next.js), maru   │  maru-web / browser  │
│  (Next.js smoke/e2e)  │  (Tauri 2), other     │  hosts (external)    │
│  `apps/playground`    │  documented in docs/  │                      │
└──────────┬────────────┴──────────┬────────────┴──────────┬───────────┘
           │                       │                       │
           ▼                       ▼                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  @hwp-editor/react  — embeddable React editor UI                     │
│  `packages/react/src` (HwpEditor + panels, CSS-variable theming)     │
│  Depends on: @hwp-editor/core only                                   │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  @hwp-editor/core  — framework-free contract + transports            │
│  `packages/core/src`                                                 │
│  HwpEngine interface (`engine.ts`) + wire protocol (`protocol.ts`)   │
│  Implementations: createHttpEngine · createTauriEngine · (CliEngine) │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  @hwp-editor/server  — Node adapter for the HTTP transport           │
│  `packages/server/src`                                               │
│  routes.ts (Fetch-API handler) → cli-engine.ts (spawns hwp binary)   │
│  session.ts (server-internal snapshots/inspection cache)             │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ execFile (hardened)
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  hwp-cli binary (external, >= 0.8.7) — ALL document logic            │
│  `hwp cat | render | edit | compose | validate | fields | info ...`  │
└──────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `HwpEngine` interface | The single contract all document work flows through (`read/render/edit/compose/validate/capabilities`) | `packages/core/src/engine.ts` |
| Wire protocol | HTTP request/response shapes shared by client and server | `packages/core/src/protocol.ts` |
| HTTP engine | Reference client: `createHttpEngine(baseUrl)` — multipart uploads, base64 responses | `packages/core/src/http-engine.ts` |
| Tauri engine | `createTauriEngine(invoke)` — same payloads over `hwped_*` Rust commands | `packages/core/src/tauri.ts` |
| Edit ops | Typed `EditOp` union ↔ `hwp edit` argv mapping (`opsToArgv`/`argvToOps`) | `packages/core/src/ops.ts` |
| Segments | `hwp cat --with-segments` envelope types + offset/ref coordinate helpers | `packages/core/src/segments.ts` |
| Spec types | DocumentSpec v2 / TemplateSpec v1 / TemplateData v1 (generated from JSON schemas) | `packages/core/src/spec.ts`, `packages/core/src/generated/` |
| Editor store | Framework-free reducer store: pending ops, snapshots (undo), status | `packages/core/src/state.ts` |
| `HwpEditor` | Top-level embeddable React component: toolbar, canvas, side panels, compose flow | `packages/react/src/HwpEditor.tsx` |
| `PageCanvas` | Page image rendering + click→segment hit-testing | `packages/react/src/PageCanvas.tsx` |
| `SegmentInspector` | Paragraph edit panel (text/format/align ops) | `packages/react/src/SegmentInspector.tsx` |
| `TableGrid` | Table cell editor (set-cell/add-row ops) | `packages/react/src/TableGrid.tsx` |
| `FieldsPanel` | `{{field}}` placeholder slots → set-field ops | `packages/react/src/FieldsPanel.tsx` |
| `ComposePanel` | New-document flow: presets → DocumentSpec v2 → `engine.compose` | `packages/react/src/ComposePanel.tsx` |
| CLI engine | `CliEngine`: spawns `hwp` binary via execFile, hardened subprocess wrapper | `packages/server/src/cli-engine.ts` |
| HTTP routes | Framework-agnostic `(Request) => Response` handler for all 6 actions | `packages/server/src/routes.ts` |
| Next adapter | Thin Next.js App Router factory (`createHwpEditorRoutes`) | `packages/server/src/next.ts` |
| Session store | Server-internal per-document sessions: snapshots, inspection cache, confinement | `packages/server/src/session.ts` |
| Playground | Next.js smoke harness + Playwright e2e over the real binary | `apps/playground` |

## Pattern Overview

**Overall:** Hexagonal / ports-and-adapters, monorepo split by layer. One interface (`HwpEngine`) is the port; three transports (HTTP client, Tauri bridge, CLI subprocess) are adapters. The editor contains zero HWP parsing logic — every document operation delegates to the external `hwp-cli` binary.

**Key Characteristics:**
- **Single contract, swappable transports** — `createHttpEngine` ↔ `createTauriEngine` are interchangeable; response shapes are the same JSON (`protocol.ts`), so host code never changes.
- **Segment-based structured editing** — `hwp cat --with-segments` maps markdown offsets to source coordinates (`SegmentRef`); clicks select segments; edits are typed `EditOp`s; results verified by re-render (`hwp edit --verify`).
- **Framework-free core** — `packages/core` has zero runtime dependencies; React lives only in `packages/react`, Node APIs only in `packages/server`.
- **Stateless wire, stateful internals** — every HTTP request carries the full document; server-side sessions (`session.ts`) and CLI-engine caches are internal optimizations, not contract.
- **Pinned contracts** — op flags pinned to hwp-cli v0.8.7 (`ops.ts` header), spec types generated from frozen JSON schemas (`packages/core/schemas/`).

## Layers

**Core contract layer:**
- Purpose: Types, wire protocol, edit-op grammar, segment math, editor state store, engine transports
- Location: `packages/core/src`
- Contains: Interfaces, pure functions, reducer, fetch/invoke-based clients
- Depends on: Nothing (zero dependencies; `invoke`/`fetch` injected — peer pattern)
- Used by: `packages/react`, `packages/server`, hosts directly

**UI layer:**
- Purpose: Embeddable React editor
- Location: `packages/react/src`
- Contains: `HwpEditor` + panel components, geometry/table/field helpers, CSS
- Depends on: `@hwp-editor/core` (types + store + engine), React >= 19 (peer)
- Used by: `apps/playground`, external hosts (ax, maru, maru-web)

**Server adapter layer:**
- Purpose: Serve the `protocol.ts` HTTP contract by spawning the hwp binary
- Location: `packages/server/src`
- Contains: Fetch-API handler (`routes.ts`), subprocess engine (`cli-engine.ts`), sessions (`session.ts`), Next factory (`next.ts`)
- Depends on: `@hwp-editor/core`, Node builtins only
- Used by: `apps/playground/app/api/hwp-editor/[...action]/route.ts`, Next.js hosts

**Host app layer:**
- Purpose: Wire engine + editor together, provide documents
- Location: `apps/playground/app`
- Contains: Route handler (2 lines over `createHwpEditorRoutes`), editor page
- Depends on: all three packages

## Data Flow

### Primary Request Path (load a document)

1. Host passes `file: DocumentHandle` to `<HwpEditor>` (`apps/playground/app/editor/page.tsx:80`)
2. `HwpEditor` effect calls `engine.capabilities()`, `engine.read(file)`, `engine.render(file)`, `engine.validate(file)` in parallel (`packages/react/src/HwpEditor.tsx:94-125`)
3. HTTP engine: multipart POST to `{base}/read|render|validate` (`packages/core/src/http-engine.ts:78-136`)
4. Routes handler parses multipart, dispatches by action (`packages/server/src/routes.ts:252-294`)
5. `CliEngine` stages bytes into a private mkdtemp dir, `execFile`s `hwp cat/render/validate`, parses stdout (`packages/server/src/cli-engine.ts:301-353`)
6. Results return as base64-in-JSON; client decodes to `Uint8Array`; store dispatches `{type: "load"}` (`packages/react/src/HwpEditor.tsx:115`)

### Edit Cycle (queue → apply → verify)

1. Panel components build `EditOp`s and dispatch `{type: "queueOp"}` — status becomes `"dirty"` (`packages/core/src/state.ts:66-71`)
2. Toolbar "적용" button (or Cmd/Ctrl+Enter) calls `applyPendingOps` (`packages/react/src/HwpEditor.tsx:145-177`)
3. `applyStarted` pushes the pre-edit document onto `snapshots` (undo), then `engine.edit(document, pendingOps, {verify: true})`
4. Server snapshots the session, runs `hwp edit -o out.hwpx <argv...> --verify` (`packages/server/src/cli-engine.ts:447-470`)
5. On success: re-read + re-render + re-validate; `applySucceeded` clears pending ops and selection
6. On failure: `applyFailed` rolls back the snapshot, status becomes `"error"`, message classified by `classifyEngineError` (`packages/react/src/errors.ts`)

### Undo Flow

1. `undo` action pops the newest snapshot and restores document bytes (`packages/core/src/state.ts:110-122`)
2. `HwpEditor.revert` re-reads/re-renders the restored bytes (`packages/react/src/HwpEditor.tsx:179-193`)
3. Server side mirrors this: `CliEngine.undo(document)` returns pre-edit bytes keyed by content hash (`packages/server/src/cli-engine.ts:472-477`)

**State Management:**
- Client: framework-free reducer store (`packages/core/src/state.ts`) — `EditorState { document, pages, selection, pendingOps, snapshots, status, error }`. React binds via `useSyncExternalStore` (`packages/react/src/HwpEditor.tsx:84`); non-React hosts wrap `createStore` with their own reactivity.
- Ephemeral React state (envelope, capabilities, validation, active tab) lives in `HwpEditor` local state, not the store.
- Server: content-hash-keyed in-memory caches — `inspections` (64-entry FIFO) and `snapshots` (256-entry FIFO) in `cli-engine.ts:317-318`; session store with TTL sweep in `session.ts`.

## Key Abstractions

**`HwpEngine` (the port):**
- Purpose: All document capability behind 6 async methods; the editor never parses HWP itself
- Examples: `packages/core/src/engine.ts:71-88` (interface), `http-engine.ts` (HTTP), `tauri.ts` (Tauri), `packages/server/src/cli-engine.ts` (subprocess), `packages/react/test/mock-engine.ts` (test double)
- Pattern: Interface + factory functions (`createHttpEngine`, `createTauriEngine`, `createCliEngine`); dependencies injected (`fetch`, `invoke`, `bin`)

**`EditOp` union:**
- Purpose: Type-safe mirror of every `hwp edit` flag; serializes 1:1 to argv via `opsToArgv`
- Examples: `packages/core/src/ops.ts` (445 lines; ~25 op kinds)
- Pattern: Discriminated union on `kind`; flag spellings pinned to hwp-cli v0.8.7 `EditArgs`

**`SegmentRef` coordinates:**
- Purpose: Stable source coordinates `{section, para}` bridging rendered markdown offsets and `hwp edit` targets
- Examples: `packages/core/src/segments.ts` (`offsetToRef`, `segmentAtRef`, `segmentText`)
- Pattern: Pure functions over the `CatEnvelope`; UI hit-testing estimates geometry with a linear text-flow model (`packages/react/src/geometry.ts`)

**`protocol.ts` wire shapes:**
- Purpose: Single source of truth for the HTTP contract, imported by BOTH client and server
- Examples: `packages/core/src/protocol.ts` (`ReadResponse`, `RenderResponse`, `EditResponse`, `ComposeRequest/Response`, `ErrorResponse`)
- Pattern: Multipart uploads, base64-in-JSON downloads, `ErrorResponse` on every non-2xx

**`DocumentHandle`:**
- Purpose: Universal document representation — `{name, data: Uint8Array}` — no filesystem assumptions in core
- Examples: `packages/core/src/engine.ts:6-10`; Tauri transport adds `TauriDocumentRef` with optional `path` for on-disk files (`packages/core/src/tauri.ts:53-60`)

## Entry Points

**Library consumers:**
- `@hwp-editor/core` → `packages/core/src/index.ts` (barrel: engine, ops, segments, spec, state, http/tauri engines, protocol types)
- `@hwp-editor/react` → `packages/react/src/index.ts` (barrel: `HwpEditor` + panels + helpers); `./style.css` subpath for the extracted stylesheet (styles are NOT auto-injected)
- `@hwp-editor/server` → `packages/server/src/index.ts`; `@hwp-editor/server/next` → `packages/server/src/next.ts` (`createHwpEditorRoutes`)

**Playground app:**
- HTTP routes: `apps/playground/app/api/hwp-editor/[...action]/route.ts` — `export const { GET, POST } = createHwpEditorRoutes({ bin })`
- Editor page: `apps/playground/app/editor/page.tsx` — `createHttpEngine("/api/hwp-editor")` + `<HwpEditor engine file>`
- Index harness: `apps/playground/app/page.tsx`
- E2E: `apps/playground/e2e/editor.spec.ts` (Playwright, real binary; `HWP_EDITOR_BIN` overrides)

**Type generation:**
- `packages/core/scripts/gen-spec-types.mjs` — regenerates `src/generated/*.ts` from `schemas/*.json` (runs on `pnpm build` via `gen:types`)

## Architectural Constraints

- **Threading:** Single-threaded Node event loop throughout; each CLI invocation is a short-lived `execFile` child with a 60s timeout and 32MB maxBuffer (`packages/server/src/cli-engine.ts:38-39`). No worker threads.
- **Global state:** Module-level singletons are limited to per-instance closures — `inspections`/`snapshots` Maps inside `createCliEngine` (`cli-engine.ts:317-318`) and `hashToSession` inside `createHwpEditorHandler` (`routes.ts:143`). Each factory call gets fresh state; no cross-request globals beyond that.
- **Circular imports:** None. Dependency direction is strictly `react → core ← server`; `core` files import only within the package.
- **Binary coupling:** Op flags, segment envelope shape, spec schemas, and error message markers are all pinned to hwp-cli **v0.8.7**; bumping the binary requires reviewing `ops.ts`, `segments.ts`, `schemas/`, and `packages/react/src/errors.ts` markers.
- **Core purity:** `packages/core` must stay dependency-free — inject `fetch`/`invoke` rather than importing platform SDKs (see `tauri.ts` peer pattern).
- **Theming:** UI styling via `--hwped-*` CSS variables only; class names are `hwped-*` prefixed (`packages/react/src/theme.css`, `docs/theme-contract.md`).

## Anti-Patterns

### Parsing HWP/HWPX in TypeScript

**What happens:** Temptation to inspect document structure client-side (the repo deliberately has no HWP parser).
**Why it's wrong:** The project's core invariant is that all document logic lives in hwp-cli; duplicating parsing here forks the format logic and breaks the pinned-contract model.
**Do this instead:** Extend the `HwpEngine` interface + `protocol.ts` + `cli-engine.ts` to expose the new `hwp <subcommand>` output (see `describe()` in `packages/server/src/cli-engine.ts:320-353` for the read-pipeline pattern).

### Adding runtime state to the wire protocol

**What happens:** Passing session ids or server paths in protocol requests.
**Why it's wrong:** The wire contract is intentionally stateless (every request carries the document); sessions are server-internal confinement infrastructure (`packages/server/src/session.ts` header), and trusting client paths is a traversal risk.
**Do this instead:** Keep server state keyed by content hash server-side (the `hashToSession` pattern in `routes.ts:127-143`).

### Importing platform APIs into packages/core

**What happens:** `import { invoke } from "@tauri-apps/api/core"` or `node:*` imports in core.
**Why it's wrong:** Core must run in browser, Node, and Tauri unchanged; the README and `tauri.ts` enforce the dependency-free peer pattern.
**Do this instead:** Accept the platform function as an option (`TauriInvoke`, `HttpEngineOptions.fetch`) — see `packages/core/src/tauri.ts:42-47`.

## Error Handling

**Strategy:** Typed errors at the subprocess boundary, string messages across the wire, classification back into kinds at the UI edge.

**Patterns:**
- `HwpCliError` with a `reason` union (`unavailable | version | timeout | failed | bad_request | unsupported_format`) thrown by the CLI engine (`packages/server/src/cli-engine.ts:53-62`); `runCliOk` converts non-zero exits (`cli-engine.ts:165-175`)
- Routes map reasons to HTTP statuses via `statusFor` and always emit `ErrorResponse` JSON (`packages/server/src/routes.ts:62-76, 281-293`)
- HTTP/Tauri clients throw plain `Error`s with prefixed messages (`hwp-engine HTTP 504: ...`, `hwped_read failed: ...`)
- UI re-classifies message strings with `classifyEngineError` for distinct error badges (`packages/react/src/errors.ts`) — substring matching is deliberate and pinned
- Reducer-level failure handling: `applyFailed` rolls back the undo snapshot and sets `status: "error"` (`packages/core/src/state.ts:102-109`)
- Best-effort extras: read-pipeline extras (fields/bookmarks/slots/info) use `tryJson` and degrade to `null` rather than failing the read (`cli-engine.ts:212-219, 332-337`)

## Cross-Cutting Concerns

**Logging:** No logging framework. Failures surface as typed errors / `ErrorResponse`; the CLI engine captures `stderr` into `HwpCliError.stderr` for diagnosis.

**Validation:** Three tiers — wire-shape guards in routes (`formDocument`, ops JSON check; `routes.ts:87-119`), CLI-engine argument validation (dpi range, page-range regex, `sniffExtension`/`safeOutputName` path hardening; `cli-engine.ts:195-210, 372-379`), and semantic `hwp validate` exposed as `engine.validate`.

**Authentication:** None in-repo — the playground routes are unauthenticated. Hosts add auth by injecting a custom `fetch` into `createHttpEngine` (see `docs/integration-web.md`).

**Security posture:** Subprocess hardening in `cli-engine.ts` — execFile only (no shell), scrubbed child env (`scrubbedEnv`, PATH/HOME/LANG/HWP_* only), per-call mkdtemp workspaces removed on every path, basename+extension sanitization, 0o600 file modes. Session store confines all files under a private root with UUID ids and path-traversal checks (`session.ts` header).

---

*Architecture analysis: 2026-08-23*

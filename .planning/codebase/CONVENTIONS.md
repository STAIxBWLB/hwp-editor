# Coding Conventions

**Analysis Date:** 2026-08-23

## Naming Patterns

**Files:**
- Modules / non-component sources: `kebab-case.ts` — `http-engine.ts`, `cli-engine.ts`, `mock-engine.ts`, `segment-inspector.ts`-style helpers (`sanitize.ts`, `geometry.ts`, `fields.ts`)
- React components: `PascalCase.tsx` — `HwpEditor.tsx`, `PageCanvas.tsx`, `SegmentInspector.tsx`, `TableGrid.tsx`, `ComposePanel.tsx`, `FieldsPanel.tsx` (all in `packages/react/src/`)
- Tests mirror the module name: `ops.test.ts` tests `ops.ts`; `editor.test.tsx` tests the editor component
- Barrel entry point per package: `index.ts` (`packages/core/src/index.ts`, `packages/react/src/index.ts`, `packages/server/src/index.ts`)
- Generated code lives in `src/generated/` with versioned names: `document-spec-v2.ts`, `template-spec-v1.ts`, `template-data-v1.ts` (produced by `packages/core/scripts/gen-spec-types.mjs`)

**Functions:**
- `camelCase` — `opsToArgv`, `argvToOps`, `createStore`, `createSessionStore`, `classifyEngineError`
- Factory functions are named `createX` and return a plain object implementing an interface: `createStore(): EditorStore` (`packages/core/src/state.ts:133`), `createSessionStore(): SessionStore` (`packages/server/src/session.ts:98`), `createHttpEngine(): HwpEngine` (`packages/core/src/http-engine.ts:54`), `createCliEngine()` (`packages/server/src/cli-engine.ts`)
- React hooks follow `useX`: `useHwpEditorContext` (`packages/react/src/context.ts:38`)

**Variables:**
- `camelCase`; module-level constants in `UPPER_SNAKE_CASE` — `DEFAULT_TTL_MS`, `SESSION_ID_PATTERN` (`packages/server/src/session.ts:22-24`), `OP_FLAGS` (`packages/core/src/ops.ts:123`), `ENGINE_ERROR_LABELS` (`packages/react/src/errors.ts:41`)
- Test fixtures: `UPPER_SNAKE_CASE` byte constants — `BYTES_A`, `BYTES_B` (`packages/server/test/session.test.ts:14`), `DEBUG_BIN`, `HAS_BIN` (`packages/server/test/helpers.ts:9-13`)

**Types:**
- `PascalCase` for interfaces, type aliases, classes, and enums — `DocumentHandle`, `HwpEngine`, `EditOp`, `EngineErrorKind`
- Discriminated unions are the standard modeling tool: `EditOp` keyed on `kind` (`packages/core/src/ops.ts:40-120`), `EditorAction` keyed on `type` (`packages/core/src/state.ts:42-52`). String-literal unions for closed vocabularies: `EditorStatus = "clean" | "dirty" | "applying" | "error"`
- Custom error classes end in `Error`: `PathTraversalError`, `SessionNotFoundError` (`packages/server/src/session.ts:26-38`), `HwpCliError` (`packages/server/src/cli-engine.ts`)

## Code Style

**Formatting:**
- No ESLint / Prettier / Biome configuration exists. Style is enforced by convention and TypeScript strictness only.
- Observed style: 2-space indent, double quotes, trailing commas in multiline literals, semicolons, ~90-100 char line budget (soft)

**TypeScript strictness (all packages extend `tsconfig.base.json`):**
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`
- Consequences you must follow:
  - Index access yields `T | undefined` — handle with `??`, `!` (used in parsing code after validation, e.g. `packages/core/src/ops.ts:304`), or optional chaining
  - Never assign `undefined` to an optional property explicitly; use conditional spread instead: `...(x !== undefined ? { x } : {})` (see `packages/core/src/ops.ts:376-381`, `packages/react/test/mock-engine.ts:73`)
  - Type-only imports MUST use `import type` — `verbatimModuleSyntax` is on (`packages/core/src/http-engine.ts:6-25`)

**Linting:**
- None configured. `pnpm typecheck` (`tsc --noEmit` per package) is the only static gate.

## Import Organization

**Order (as seen in `packages/server/test/session.test.ts:1-12`, `packages/react/test/editor.test.tsx:1-5`):**
1. Node builtins (`node:fs`, `node:os`, `node:path`, `node:crypto`) — always with the `node:` prefix
2. External packages (`vitest`, `react`, `@testing-library/react`)
3. Workspace packages (`@hwp-editor/core`)
4. Relative imports — always with the explicit `.js` extension, even for `.ts`/`.tsx` sources: `../src/session.js`, `./mock-engine.js`, `../src/HwpEditor.js`

**Path Aliases:**
- None. No `paths` in any tsconfig; cross-package references use the workspace package name (`@hwp-editor/core`).

**Module system:**
- Pure ESM everywhere: every `package.json` has `"type": "module"`. tsup emits dual ESM/CJS from the ESM sources.

## Error Handling

**Patterns:**
- **Custom Error subclasses** for domain errors, with `name` set explicitly:
  ```ts
  export class PathTraversalError extends Error {
    constructor(rel: string) {
      super(`path escapes the session directory: ${rel}`);
      this.name = "PathTraversalError";
    }
  }
  ```
  (`packages/server/src/session.ts:26-31`)
- **Thrown `Error` with prefixed messages** for programmer/parse errors: `argvToOps: unknown flag ${flag}` (`packages/core/src/ops.ts:443`), `hwp-engine HTTP ${status}: ...` (`packages/core/src/http-engine.ts:48`). Message prefixes act as machine-greppable markers.
- **Substring-based error classification** at the UI boundary: `classifyEngineError` maps engine message strings to `EngineErrorKind` (`packages/react/src/errors.ts:12-38`). Deliberate and documented — do not add an error-kind field to the wire contract without updating this.
- **Result-ish returns over exceptions** for recoverable absence: `undo()` returns `DocumentHandle | null` instead of throwing (`packages/server/src/session.ts:75`, `packages/core/src/state.ts:110-122`); guards return `state` unchanged on no-op actions.
- **HTTP boundary:** handlers return a structured `ErrorResponse` JSON with `error.code` / `error.message` and a 4xx status (`packages/server/test/routes.test.ts:67-76` shows the asserted shape).
- Async rejections in tests are asserted with `await expect(...).rejects.toThrow(...)`; sync with `expect(() => ...).toThrow(CustomError)`.

## Logging

**Framework:** none. No logger dependency in any package.

**Patterns:**
- Library source (`packages/*/src`) contains no `console.*` calls — errors are thrown or surfaced through state (`EditorState.error`).
- Tests may `console.warn` for environment setup issues: the missing-binary warning in `packages/server/test/helpers.ts:16-19`.
- Do not add logging libraries; keep errors throwable/observable.

## Comments

**When to Comment:**
- Every non-trivial module opens with a block doc comment explaining purpose and contract context — see the headers of `packages/core/src/ops.ts:1-8`, `packages/server/src/session.ts:1-12`, `packages/react/src/errors.ts:1-8`.
- Comments frequently **pin behavior to the upstream hwp-cli contract**, citing exact file/line: "pinned to hwp-cli v0.8.7, crates/hwp-cli/src/cli.rs `EditArgs` (lines ~414-511)" (`packages/core/src/ops.ts:3-6`). When a value format or flag spelling mirrors the CLI, cite it.
- Inline comments explain *why*, especially non-obvious invariants: "// Snapshot the pre-edit bytes so the edit can be undone" (`packages/core/src/state.ts:84`), "// A lookalike prefix must not count as inside" (`packages/server/test/session.test.ts:73`).

**JSDoc/TSDoc:**
- `/** ... */` doc comments on all exported interfaces' fields and public functions — e.g. `HwpEngine` methods (`packages/core/src/engine.ts:71-88`), `SessionStore` methods (`packages/server/src/session.ts:65-91`). Document CLI flag spellings and units (`(mm)`, `0-based indices`) in the doc comment.

## Function Design

**Size:** Functions are small and single-purpose. Large dispatch logic uses a `switch` over a discriminated union rather than nested conditionals (`opValue`, `parseOp` in `packages/core/src/ops.ts:155-445`).

**Parameters:**
- Options objects with all-optional fields for anything beyond 1-2 params: `createSessionStore(opts: SessionStoreOptions = {})`, `createCliEngine({ bin })`, `RenderOptions`, `EditOptions`.
- Defaults applied via `opts.x ?? DEFAULT_X` at the top of the factory (`packages/server/src/session.ts:99-100`).

**Return Values:**
- Factories return interface-typed object literals (`createStore`, `createHttpEngine`).
- Explicit `| null` for absence, never bare `undefined` returns from public APIs (`undo(): Promise<DocumentHandle | null>`).
- Pure reducer pattern for state: `reducer(state, action): EditorState` with immutable spread updates (`packages/core/src/state.ts:54-124`).

## Module Design

**Exports:**
- Each package has a single barrel `index.ts` that re-exports the public API, grouping `export type { ... }` and value `export { ... }` separately (required by `verbatimModuleSyntax`) — see `packages/core/src/index.ts`.
- Keep internal helpers unexported within the module (e.g. `opValue`, `splitFirst`, `need` in `packages/core/src/ops.ts` are module-private).

**Barrel Files:**
- Yes, one per package; no nested barrels. New public symbols must be added to the package's `src/index.ts`.

**Framework layering:**
- `packages/core` is framework-free — no React, no Node-only APIs in shared paths (browser/Node/Tauri portable, see `packages/core/src/http-engine.ts:1-4`).
- Node-only code lives in `packages/server`; React code in `packages/react`. Keep this boundary.

---

*Convention analysis: 2026-08-23*

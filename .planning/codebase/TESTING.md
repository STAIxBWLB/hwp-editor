# Testing Patterns

**Analysis Date:** 2026-08-23

## Test Framework

**Runner:**
- Vitest 3.2 (`^3.2.4`) in every library package
- Configs: `packages/core/vitest.config.ts`, `packages/server/vitest.config.ts` (both `include: ["test/**/*.test.ts"]`), `packages/react/vitest.config.ts` (`environment: "jsdom"`, includes `test/**/*.test.tsx` too)
- E2E: Playwright 1.55 (`@playwright/test`) in `apps/playground/playwright.config.ts`

**Assertion Library:**
- Vitest's built-in `expect` (Chai-compatible): `toEqual`, `toMatchObject`, `toHaveLength`, `toThrow`, `rejects.toThrow`, `expect.objectContaining`, `expect.poll` (Playwright side)

**Run Commands:**
```bash
pnpm test                 # root: runs `pnpm -r test` → vitest run in each package
pnpm --filter @hwp-editor/core test    # single package
pnpm --filter @hwp-editor/core exec vitest        # watch mode
pnpm typecheck            # tsc --noEmit across packages (always run alongside tests)
cd apps/playground && pnpm test:e2e    # Playwright (spins up `next dev -p 3100` via webServer)
```
- No coverage tooling is configured (no `coverage` in any vitest config, no c8/v8 dep).

## Test File Organization

**Location:**
- Separate `test/` directory per package, NOT co-located with `src/`:
  - `packages/core/test/` — `ops.test.ts`, `segments.test.ts`, `state.test.ts`, `tauri-engine.test.ts`, `fixtures/`
  - `packages/server/test/` — `session.test.ts`, `routes.test.ts`, `cli-engine.test.ts`, `helpers.ts`
  - `packages/react/test/` — `utils.test.ts`, `editor.test.tsx`, `mock-engine.ts`
  - `apps/playground/e2e/` — `editor.spec.ts`

**Naming:**
- `<module>.test.ts` mirroring the source file name (`ops.test.ts` ↔ `src/ops.ts`)
- Shared test infrastructure is a plain `.ts` file in `test/` (excluded by the `*.test.ts` include glob): `helpers.ts`, `mock-engine.ts`
- JSON fixtures in `test/fixtures/`: `packages/core/test/fixtures/cat-segments-basic.json`, `cat-segments-table.json`

**Structure:**
```
packages/<pkg>/
├── src/            # implementation
└── test/
    ├── <module>.test.ts
    ├── helpers.ts | mock-engine.ts   # shared stubs/fixtures
    └── fixtures/*.json               # recorded engine envelopes
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it } from "vitest";
import { opsToArgv, argvToOps, type EditOp } from "../src/ops.js";

describe("opsToArgv", () => {
  it("serializes one --flag value pair per op, in order", () => {
    const ops: EditOp[] = [{ kind: "replace", find: "구교재", replace: "신교재" }];
    expect(opsToArgv(ops)).toEqual(["--replace", "구교재=>신교재"]);
  });
});
```
(from `packages/core/test/ops.test.ts:6-23`)

**Patterns:**
- Flat `describe` per unit under test; multiple `describe` blocks per file grouped by theme (`describe("opsToArgv")`, `describe("argvToOps round-trip")` in `packages/core/test/ops.test.ts:9,187`)
- Test names are full behavior sentences: `"resolvePath confines to the session directory"`, `"sweep removes sessions past their TTL and deletes their dirs"`
- **Parameterized round-trips via `it.each`** with the discriminant as the label:
  ```typescript
  it.each(roundTripCases.map((op) => [op.kind, op] as const))(
    "round-trips %s",
    (_kind, op) => { expect(argvToOps(opsToArgv([op]))).toEqual([op]); },
  );
  ```
  (`packages/core/test/ops.test.ts:220-225`)
- Tests cite the upstream contract they pin (hwp-cli flag spellings) in header and inline comments (`packages/core/test/ops.test.ts:1-5`)
- Reducer tests build state by **folding real actions**, not hand-writing state: `const loaded = reducer(initialState, { type: "load", ... })` (`packages/core/test/state.test.ts:15-18`)

**Setup/Teardown:**
- `afterEach` for resource cleanup: `afterEach(async () => { await store?.dispose(); })` (`packages/server/test/session.test.ts:20-22`); `afterEach(cleanup)` for Testing Library (`packages/react/test/editor.test.tsx:7`)
- `beforeAll` for jsdom environment patches: overriding `Element.prototype.getBoundingClientRect` to give `.hwped-page` a 595x842 rect (`packages/react/test/editor.test.tsx:14-35`)
- Fresh instances per test created inside the `it` body (`store = createSessionStore()`), not shared across tests

## Mocking

**Framework:**
- `vi.fn()` from Vitest for callback assertions (`onChange`, `onDirtyChange` — `packages/react/test/editor.test.tsx:40-41`)
- Hand-written stub/fake objects preferred over auto-mocking — there is no `vi.mock()` usage in the codebase

**Patterns:**

1. **Interface stub** — implement `HwpEngine` inline with `Partial<HwpEngine>` overrides:
   ```typescript
   function stubEngine(overrides: Partial<HwpEngine> = {}): HwpEngine {
     return {
       async read() { return { markdown: "# hi", segments: [] }; },
       // ...all interface members...
       ...overrides,
     };
   }
   ```
   (`packages/server/test/routes.test.ts:21-46`)

2. **Recording fake** — a mock that logs calls for later assertion:
   ```typescript
   const engine = createMockEngine();
   // ... drive UI ...
   expect(engine.calls.edit).toHaveLength(1);
   expect(engine.calls.edit[0]?.ops).toEqual([
     { kind: "replace", find: "1. 회의록", replace: "2. 회의록" },
   ]);
   ```
   (`packages/react/test/mock-engine.ts:58-103`, used in `packages/react/test/editor.test.tsx:69-72`)

3. **Function mock with response table** — for the Tauri bridge, a typed `invoke` fake keyed by command name that records `{ cmd, args }` and rejects unexpected commands (`packages/core/test/tauri-engine.test.ts:16-30`)

**What to Mock:**
- The `HwpEngine` interface (the single seam between the editor and the hwp-cli binary)
- Host-provided bridges: `TauriInvoke`, `fetch`
- Callback props (`onChange`, `onDirtyChange`)

**What NOT to Mock:**
- Pure logic: `reducer`, `opsToArgv`/`argvToOps`, `segments`, `geometry`, `tables`, `fields`, `sanitize` — all tested directly against real inputs
- The real hwp-cli binary in `cli-engine.test.ts` — these are real-binary integration tests, gated (see below)

## Fixtures and Factories

**Test Data:**
- Small inline factories at the top of test files:
  ```typescript
  const doc = (name: string, text: string): DocumentHandle => ({
    name,
    data: new TextEncoder().encode(text),
  });
  ```
  (`packages/core/test/state.test.ts:10-13`)
- Shared factories in `test/helpers.ts` / `test/mock-engine.ts`: `sampleSpec()` (DocumentSpec v2 with one paragraph + 2x2 table — `packages/server/test/helpers.ts:29-64`), `makeEnvelope()` / `makePage()` / `createMockEngine()` (`packages/react/test/mock-engine.ts`)
- `multipartRequest(url, fields)` helper builds real `Request` objects with `FormData` for route tests (`packages/server/test/helpers.ts:66-79`) — routes are tested through the fetch API surface, not internal functions
- Recorded engine output as JSON: `packages/core/test/fixtures/cat-segments-*.json`

**Location:**
- Factories live in `packages/<pkg>/test/helpers.ts` or `mock-engine.ts`; JSON fixtures in `packages/<pkg>/test/fixtures/`

## Conditional / Integration Tests

**Real-binary gating (`packages/server/test/helpers.ts:9-26`):**
- Integration tests against the real `hwp` binary are gated on its existence:
  ```typescript
  export const HAS_BIN = existsSync(BIN);
  export const describeBin = HAS_BIN
    ? describe
    : (name, fn) => describe.skip(`${name} [skipped: no hwp-cli 0.8.7 binary at ${BIN}]`, fn);
  ```
- Binary path: `process.env.HWP_EDITOR_BIN ?? <local debug build path>` — set `HWP_EDITOR_BIN` to run them on another machine
- Use `describeBin(...)` for any test that needs the real binary; version assertions check a floor (`>= 0.8.7`), never an exact release (`packages/server/test/cli-engine.test.ts:18-23`)

## Coverage

**Requirements:** None enforced — no coverage config, no thresholds, no CI gate.

**View Coverage:**
```bash
pnpm --filter @hwp-editor/core exec vitest run --coverage   # requires adding @vitest/coverage-v8
```

## Test Types

**Unit Tests:**
- Pure serialization/parsing: `packages/core/test/ops.test.ts` (argv round-trips)
- State machine: `packages/core/test/state.test.ts` (reducer transitions, undo, snapshot rollback)
- View-model utils: `packages/react/test/utils.test.ts` (sanitize, tables, fields, presets, geometry)
- Server internals: `packages/server/test/session.test.ts` (path traversal confinement, TTL sweep, history caps)

**Integration Tests:**
- Route shape with stub engine: `packages/server/test/routes.test.ts` — drives `createHwpEditorHandler` with real `Request`/`Response` objects, asserts status codes and `ErrorResponse` shape
- Real binary end-to-end: `packages/server/test/cli-engine.test.ts` — full compose → read → edit → render → validate → undo loop (gated by `describeBin`)

**E2E Tests:**
- Playwright, one spec: `apps/playground/e2e/editor.spec.ts` — drives the real editor UI against the real binary; `webServer` boots `next dev -p 3100` (`apps/playground/playwright.config.ts:17-27`), `workers: 1`, `retries: 0`, 60s test timeout
- Locators are **accessibility-first** with Korean accessible names: `page.getByRole("button", { name: "페이지 1" })`, `getByLabel("텍스트 교체")`, `getByRole("status", { name: "검증 결과" })`; CSS class selectors (`.hwped-page-svg`, `.hwped-quote`) only for rendered SVG internals
- Long waits use explicit `timeout: 30_000` on `expect(...)` or `expect.poll(...).not.toBe(...)` for re-render detection

**React Component Tests:**
- jsdom + `@testing-library/react` 16 (`packages/react/test/editor.test.tsx`, 325 lines covering the full edit flow)
- Pattern: `render(<HwpEditor engine={createMockEngine()} ... />)` → `screen.findByRole` / `fireEvent.click|change` → assert on mock-engine `calls` and `vi.fn()` callbacks
- Click coordinates come from `clientYForPara(envelope, para)` which maps a segment to a clientY through the flow geometry (`packages/react/test/mock-engine.ts:109-114`)

## Common Patterns

**Async Testing:**
```typescript
// Rejections
await expect(bad.capabilities()).rejects.toThrow(HwpCliError);   // class match
await expect(readFile(session.currentPath)).rejects.toThrow();   // any error

// Resolution
await expect(engine.read(doc)).resolves.toEqual(envelope);
```
(`packages/server/test/cli-engine.test.ts:38`, `packages/server/test/session.test.ts:92`, `packages/core/test/tauri-engine.test.ts:45`)

**Error Testing:**
```typescript
// Sync throw with custom error class
expect(() => store.resolvePath(session.id, "../../etc/passwd")).toThrow(PathTraversalError);

// Message regex
expect(() => argvToOps(["--replace"])).toThrow(/no value/);

// HTTP error body shape
expect(res.status).toBe(400);
expect(body.error.code).toBe("bad_request");
```
(`packages/server/test/session.test.ts:70`, `packages/core/test/ops.test.ts:228`, `packages/server/test/routes.test.ts:72-75`)

**Security-focused assertions** are part of the normal suite — the path traversal tests include the lookalike-prefix case (`../<dir>-evil/x`) (`packages/server/test/session.test.ts:65-77`), and SVG sanitization tests assert stripped `script`/`foreignObject`/`onclick` (`packages/react/test/utils.test.ts:10-30`).

---

*Testing analysis: 2026-08-23*

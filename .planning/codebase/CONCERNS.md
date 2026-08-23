# Codebase Concerns

**Analysis Date:** 2026-08-23

## Tech Debt

**Duplicated SVG→PNG render fallback:**
- Issue: The "SVG failed, retry as PNG" fallback exists in two layers — `packages/server/src/cli-engine.ts:435-443` (engine retries internally) and `packages/react/src/HwpEditor.tsx:61-70` (`renderPages` catches *any* error and re-renders as PNG). The React-layer retry fires even for non-format failures (network error, timeout, binary missing), doubling latency and spawning a second full CLI render.
- Files: `packages/react/src/HwpEditor.tsx`, `packages/server/src/cli-engine.ts`
- Impact: Doubled render cost on transient failures; confusing error semantics (a real error can be masked by a second, different failure).
- Fix approach: Keep the fallback only in `CliEngine.render`; have the React layer surface the engine error directly.

**Server-side undo is implemented but unreachable over HTTP:**
- Issue: `CliEngine.undo()` (`packages/server/src/cli-engine.ts:472-477`) and `SessionStore.undo()` (`packages/server/src/session.ts:199-207`) are fully implemented, and `handleEdit` snapshots pre-edit state into the session (`packages/server/src/routes.ts:207-211`), but the `ACTIONS` set (`packages/server/src/routes.ts:48`) exposes no `undo` action. The client (`packages/core/src/state.ts:110-122`) keeps its own snapshot stack instead, so the server-side snapshot/history machinery is dead weight on the wire path.
- Files: `packages/server/src/routes.ts`, `packages/server/src/session.ts`, `packages/server/src/cli-engine.ts`
- Impact: Wasted disk (history snapshots accumulate per session with no consumer); two divergent undo models to maintain.
- Fix approach: Either add an `undo` action to the protocol (`packages/core/src/protocol.ts`) + routes, or strip the server-side snapshot/history code.

**Op flag-grammar is brittle by construction:**
- Issue: `EditOp` serialization pins flag spellings to specific line numbers of `hwp-cli` `cli.rs` (`packages/core/src/ops.ts:1-8`), and free-text values (`find`/`anchor`/`text`/`value`) containing `=>`, `=`, or `:` are inherently ambiguous in the CLI grammar — documented at `packages/core/src/ops.ts:267-276`. A `replace` op whose find or replacement text contains `=>` will mis-parse CLI-side with no escaping mechanism.
- Files: `packages/core/src/ops.ts`
- Impact: Silent wrong-target edits for documents/user input containing separator characters; any hwp-cli flag rename breaks the editor at runtime (only the version floor `0.8.7` is checked, not the flag surface).
- Fix approach: Push hwp-cli toward a structured input mode (e.g. `--ops-json` on stdin) and deprecate flag serialization; until then, validate op fields in `opsToArgv` and reject values containing `=>`.

**Client base64 codec is naive:**
- Issue: `toBase64` in `packages/core/src/http-engine.ts:32-36` builds a binary string with per-byte `+=` concatenation. For multi-MB documents this is slow and allocates heavily. The same codec is re-exported as `base64` and used by `tauri.ts` and `PageCanvas.tsx`.
- Files: `packages/core/src/http-engine.ts`
- Impact: Noticeable UI stalls when loading/rendering large documents in the browser.
- Fix approach: Chunk the conversion (e.g. 0x8000-byte slices with `String.fromCharCode.apply`) or use `Uint8Array.prototype.toBase64` where available (Node 22+/modern browsers).

**Geometry model is a documented approximation:**
- Issue: Click hit-testing and highlight bands use a linear text-flow model — paragraphs are assumed to flow across pages proportionally to markdown length (`packages/react/src/geometry.ts:1-11`). Documents with tables, images, or multi-column layouts will have visibly misplaced selection bands and wrong click targets.
- Files: `packages/react/src/geometry.ts`, `packages/react/src/PageCanvas.tsx`
- Impact: Selection UX degrades exactly on the complex documents where the table editor matters most.
- Fix approach: Long-term, have hwp-cli's renderer emit per-paragraph anchors in SVG output and map clicks to real geometry; bands and hit-testing must switch together (they are deliberately inverse mappings today).

**Playground route hardcodes a developer-machine path:**
- Issue: `DEFAULT_BIN = "/Users/yj.lee/workspace/work/dev/hwp-cli/target/debug/hwp"` is committed in `apps/playground/app/api/hwp-editor/[...action]/route.ts:8` — an absolute path on one developer's machine, pointing at a *debug* build.
- Files: `apps/playground/app/api/hwp-editor/[...action]/route.ts`
- Impact: Playground silently breaks for anyone else; debug binary is unoptimized and may differ from release behavior.
- Fix approach: Require `HWP_EDITOR_BIN` with a repo-relative default or a clear startup error.

**No lint/format tooling or CI:**
- Issue: No ESLint/Prettier/Biome config anywhere in the repo; no `.github/` (or other CI) workflows. Quality gates are `typecheck` + `vitest` run manually. The repo also has zero git commits at analysis time (`git log` fails on `main`).
- Files: `package.json` (root), repo root
- Impact: Style drift, unenforced conventions, and no automated regression safety net; the Playwright e2e suite (`apps/playground/e2e/editor.spec.ts`) never runs automatically.
- Fix approach: Add a root lint config and a CI workflow running `pnpm -r typecheck && pnpm -r test`; gate e2e on a pinned hwp-cli binary.

## Known Bugs

**Session snapshot filename collision after undo:**
- Symptoms: `SessionStore.snapshot()` names history files `snap-${history.length}` (`packages/server/src/session.ts:188-189`). After `undo()` pops the newest snapshot, the next `snapshot()` reuses an existing seq number: `copyFile` silently overwrites a *middle* history entry that is still referenced, and the same path ends up twice in `session.history`.
- Files: `packages/server/src/session.ts:186-207`
- Trigger: Reach >0 snapshots, call `undo()`, then `snapshot()` again (e.g. history `snap-5..snap-24`, undo pops 24, next snapshot writes `snap-19`, clobbering the existing `snap-19`).
- Workaround: None in code; the HTTP layer never calls `undo()` today, so the bug is latent until a server-side undo route is added. Fix by using a monotonic counter instead of `history.length`.

**Stale validation badge after undo:**
- Symptoms: `revert()` in `packages/react/src/HwpEditor.tsx:179-193` re-reads and re-renders the restored document but never re-validates — the toolbar badge keeps the pre-undo `ValidationReport`.
- Files: `packages/react/src/HwpEditor.tsx`
- Trigger: Apply an edit that makes validation fail (or fix a failing doc), then click 되돌리기; the badge reflects the wrong document version.
- Workaround: Manual refresh. Fix by adding `engine.validate(previous).catch(() => null)` to the revert path, matching `applyPendingOps`.

## Security Considerations

**HTTP routes have no authentication or authorization:**
- Risk: `createHwpEditorHandler` (`packages/server/src/routes.ts:121`) serves read/render/edit/compose/validate to any client that can reach the endpoint. Any uploaded document is processed; there is no tenant isolation — sessions are keyed only by content hash (`routes.ts:127-143`).
- Files: `packages/server/src/routes.ts`, `packages/server/src/next.ts`
- Current mitigation: None in-package; the design assumes the host framework mounts the handler behind its own auth (as the playground does not).
- Recommendations: Document the trust boundary prominently in `packages/server` README; consider an optional `authorize?: (req) => boolean` hook in `RoutesOptions`.

**Unbounded request sizes (memory DoS):**
- Risk: `formDocument` buffers the entire upload with `blob.arrayBuffer()` (`packages/server/src/routes.ts:103`) with no size cap; `handleCompose` accepts an unbounded JSON spec (`routes.ts:224`). Responses base64-encode whole documents/pages in memory (`routes.ts:78-80`). Each edit also retains full document copies in the `snapshots` map (up to 256, `cli-engine.ts:464-468`) and session history (up to 20 × doc size per session).
- Files: `packages/server/src/routes.ts`, `packages/server/src/cli-engine.ts`, `packages/server/src/session.ts`
- Current mitigation: `execFile` maxBuffer (32MB) caps CLI stdout only, not inputs.
- Recommendations: Enforce a max upload bytes check before `arrayBuffer()`; cap compose spec size; make snapshot/inspection cache limits byte-based rather than entry-based.

**Internal error details leak to clients:**
- Risk: The catch-all handler returns raw `err.message` in the 500 response (`packages/server/src/routes.ts:291-292`), and `HwpCliError` messages embed absolute temp paths, the resolved binary path, and CLI stderr (`cli-engine.ts:149,170`).
- Files: `packages/server/src/routes.ts`, `packages/server/src/cli-engine.ts`
- Current mitigation: None.
- Recommendations: Return a generic message for non-`HwpCliError` exceptions and log the detail server-side; scrub filesystem paths from `failed` errors before serializing.

**`insert-image` / `seal` ops accept server-local file paths:**
- Risk: These ops pass `path` straight to `hwp edit --insert-image`/`--seal` argv (`packages/core/src/ops.ts:175-185`, `packages/server/src/cli-engine.ts:457`). Over the HTTP API, a client can name any path readable by the server process and have it embedded into the output document (local file inclusion for image-like files).
- Files: `packages/core/src/ops.ts`, `packages/server/src/routes.ts` (no restriction on op kinds), `packages/server/src/cli-engine.ts`
- Current mitigation: `execFile` without a shell prevents command injection, but not path resolution inside the CLI; temp working dirs do not confine the CLI's reads.
- Recommendations: For the HTTP surface, either reject `insert-image`/`seal` ops or require an upload-multipart image flow where the server stages the bytes into the work dir and passes only that path.

**Minimal SVG sanitizer:**
- Risk: `sanitizeSvg` (`packages/react/src/sanitize.ts`) removes `script`/`foreignObject`/`on*`/`javascript:` hrefs, then re-serializes via `outerHTML` into `dangerouslySetInnerHTML` (`packages/react/src/PageCanvas.tsx:155-160`). It does not strip `<a href>` navigation, external `<image href>`/`<use href>` resource loads, or `url(...)` references in `style` attributes, and the parse→serialize round-trip is a classic mutation-XSS surface.
- Files: `packages/react/src/sanitize.ts`, `packages/react/src/PageCanvas.tsx`
- Current mitigation: CLI output is treated as trusted (documented in the file header); removal of the highest-risk vectors.
- Recommendations: Acceptable while the SVG source is the local hwp-cli binary; if documents from untrusted parties are ever rendered through a shared server, switch to a vetted sanitizer (DOMPurify with an SVG profile) or render SVG via `<img src="data:...">` (no script execution) instead of inline.

**Version check is a floor, not a pin:**
- Risk: `ensureVersion` only enforces `>= 0.8.7` once per process (`packages/server/src/cli-engine.ts:269-299`). A newer CLI with changed flag semantics or changed `cat`/`render` JSON shapes is accepted silently.
- Files: `packages/server/src/cli-engine.ts`, `packages/core/src/ops.ts`
- Current mitigation: Minimum-version rejection.
- Recommendations: Pin a known-good major/minor range, or add a capabilities handshake that verifies the flags the op grammar depends on.

## Performance Bottlenecks

**Document open spawns ~7 CLI processes:**
- Problem: `HwpEditor` load fires `capabilities` + `read` + `render` + `validate` in parallel (`packages/react/src/HwpEditor.tsx:102-115`); `describe()` alone runs `cat` plus four more `hwp` invocations (`packages/server/src/cli-engine.ts:328-337`). `describe` caches by content hash (64 entries), but `render` and `validate` never cache — every apply/refresh/undo re-renders and re-validates from scratch.
- Files: `packages/server/src/cli-engine.ts`, `packages/react/src/HwpEditor.tsx`, `packages/server/src/routes.ts`
- Cause: Stateless wire contract — every request carries the full document and re-runs the pipeline.
- Improvement path: Add a server-side render cache keyed by `(hash, format, dpi, pages)`; consider a combined `read+render+validate` endpoint to amortize process spawns; add a concurrency limiter (semaphore) around `runCli` to protect the host under parallel load.

**No concurrency limiting on subprocess spawning:**
- Problem: Every HTTP request spawns one to five `hwp` processes with no upper bound; N concurrent editor sessions = ~7N processes.
- Files: `packages/server/src/cli-engine.ts:124-162`
- Cause: Direct `execFile` per operation.
- Improvement path: Wrap `runCli` in a small promise pool (e.g. max 4 concurrent); queue excess requests.

**Whole-document base64 round trips:**
- Problem: Every response carries full document/page bytes as base64 JSON (~33% size inflation, double-buffered in memory on both encode and decode), and pages are held in the React state as `Uint8Array` plus decoded SVG strings.
- Files: `packages/server/src/routes.ts:78-80`, `packages/core/src/http-engine.ts:32-43`, `packages/react/src/PageCanvas.tsx:127-138`
- Improvement path: Stream binary responses (`application/octet-stream` per page) or use multipart responses; keep pages as object URLs instead of decoded strings.

## Fragile Areas

**`CliEngine` (`packages/server/src/cli-engine.ts`, 540 lines):**
- Why fragile: Largest file in the repo; mixes binary resolution, version gating, temp-dir lifecycle, output sniffing (regex on SVG, fixed offsets in PNG without magic-byte validation at `cli-engine.ts:237-241`), render-report parsing, and two in-memory caches. Render page-number inference (`cli-engine.ts:411-431`) has three overlapping fallbacks (filename suffix → report `selected_pages` → single-page parse → positional guess) — a CLI output-layout change silently mislabels pages.
- Safe modification: Only change via the real-binary integration tests (`packages/server/test/cli-engine.test.ts`); they auto-skip without an hwp-cli >= 0.8.7 binary, so verify they actually ran (check for skip, not just green).
- Test coverage: Good for happy paths with a real binary; no tests for timeout/kill paths, render-report mismatch, or the SVG→PNG retry.

**`routes.ts` session bookkeeping:**
- Why fragile: `hashToSession` (`packages/server/src/routes.ts:143`) grows forever and can hold ids of expired sessions (guarded by `sessions.has`, but never pruned); concurrent edits to the same document race between `snapshot()` and `put()` with no serialization.
- Safe modification: Add per-session promise chaining before touching snapshot logic; prune `hashToSession` alongside session sweep.
- Test coverage: `packages/server/test/routes.test.ts` covers request shapes; no concurrency or expiry-eviction tests.

**SVG/PNG size sniffing:**
- Why fragile: `svgSize` regex-parses the `<svg>` tag and `pngSize` reads bytes 16–24 without checking the PNG signature — malformed CLI output yields `0×0` pages, and `PageCanvas` uses those for `aspectRatio` (`packages/react/src/PageCanvas.tsx:146`), which can collapse layout silently.
- Files: `packages/server/src/cli-engine.ts:237-250`
- Safe modification: Validate magic bytes and fail loudly (throw `failed`) instead of returning 0 dimensions.
- Test coverage: Not directly tested.

## Scaling Limits

**In-memory state per process:**
- Current capacity: `inspections` capped at 64 documents, `snapshots` at 256 edits, sessions unbounded in count (only idle-TTL swept), each holding up to 20 history copies of the document.
- Limit: Memory scales as ~(256 + sessions×21) × average document size; multi-megabyte HWP files make a few hundred concurrent documents exhaust a small container. Horizontal scaling doesn't share sessions — each instance re-verifies the binary and rebuilds caches.
- Scaling path: Move session storage to a shared, byte-budgeted store (or make sessions opt-out via `sessions: false`, already supported at `routes.ts:43`); make caches byte-budgeted LRU.

**Session expiry is traffic-driven:**
- Current capacity: `sweepExpired` runs only inside `create()` (`packages/server/src/session.ts:153`) — deliberately timer-free for serverless.
- Limit: A burst followed by silence leaves temp directories on disk indefinitely; a busy server with long-lived sessions never reclaims history disk.
- Scaling path: Hosts on long-lived servers should call `store.sweep()` on an interval (the method is public); document this or offer an optional `sweepIntervalMs`.

## Dependencies at Risk

**hwp-cli binary (external, not npm):**
- Risk: The entire engine layer delegates to a separately distributed binary resolved via option/env/PATH (`packages/server/src/cli-engine.ts:258-266`). Version floor 0.8.7; op grammar pinned to that version's flags. No npm/pnpm lock coverage, no checksum verification (deliberately — see `cli-engine.ts:8-11`), no bundled fallback.
- Impact: Missing/old binary → every endpoint 503s; wrong-version binary → silent behavioral drift in edit semantics.
- Migration plan: None needed short-term; if hwp-cli ships a structured ops API, adopt it in `ops.ts` and drop the flag grammar.

**Next.js 16 + React 19 (playground):**
- Risk: `next ^16.3.2` and `react ^19.2.0` are recent majors; `@hwp-editor/react` declares `react >= 19` peers, locking hosts out of React 18.
- Impact: Host apps on React 18 cannot embed the editor.
- Migration plan: Widen peer range only after verifying `useSyncExternalStore` usage and testing-library matrix against React 18.

## Missing Critical Features

**No undo over the wire:**
- Problem: Protocol (`packages/core/src/protocol.ts:6-15`) has no undo action despite server infrastructure existing; multi-client or page-reload scenarios lose undo history (client snapshots live in React state only).
- Blocks: Reliable undo in stateless/HTTP deployments.

**No download/export endpoint:**
- Problem: `SessionStore.exportBytes` (`packages/server/src/session.ts:209-213`) exists but no route exposes it; clients must keep the latest bytes from the edit response.
- Blocks: Server-side session continuity (reload the page, re-fetch current document by session id).

**No image upload flow:**
- Problem: `insert-image`/`seal` ops require a server-local path; the HTTP API offers no way to supply image bytes.
- Blocks: Browser-based image insertion (also a security fix — see above).

**No structured compose-spec validation before POST:**
- Problem: `handleCompose` checks only that `spec` is an object (`packages/server/src/routes.ts:228-230`); schema errors surface as a 422 CLI failure, not a field-level 400. Schemas exist in `packages/core/schemas/` but no validator is wired in.
- Blocks: Good compose error UX in `ComposePanel`.

## Test Coverage Gaps

**`packages/core/src/http-engine.ts` (reference HTTP client):**
- What's not tested: Base64 codec round-trip on large inputs, error parsing (`parseError`), FormData construction. The core test suite covers ops/segments/state/tauri-engine only.
- Files: `packages/core/src/http-engine.ts`, `packages/core/test/`
- Risk: Client/server wire drift goes unnoticed — the client is the reference implementation of the protocol.
- Priority: High

**Failure paths of the CLI subprocess layer:**
- What's not tested: Timeout kill (`HWP_TIMEOUT_MS`), ENOENT recovery, maxBuffer overflow, scrubbed-env behavior, temp-dir cleanup on crash.
- Files: `packages/server/src/cli-engine.ts:124-175,302-309`
- Risk: Resource leaks (orphan temp dirs, zombie processes) under exactly the conditions production hits.
- Priority: High

**React panel interactions:**
- What's not tested: `TableGrid.tsx` (merge/split/add-row flows) and `SegmentInspector.tsx` have no dedicated interaction tests; `packages/react/test/editor.test.tsx` (11 tests) covers the top-level load/apply loop, `utils.test.ts` covers pure helpers. No coverage thresholds are configured in any `vitest.config.ts`.
- Files: `packages/react/src/TableGrid.tsx`, `packages/react/src/SegmentInspector.tsx`, `packages/react/vitest.config.ts`
- Risk: Op-builder regressions (wrong `table:row:col` grammar emitted) slip through unit tests and only surface in the single e2e spec — which requires a local hwp-cli binary and never runs in CI.
- Priority: Medium

**E2E suite is a single spec with no CI:**
- What's not tested: Only the happy path "fixture → select → replace → apply" (`apps/playground/e2e/editor.spec.ts`); compose flow, read-only documents, error badges, and undo are uncovered.
- Files: `apps/playground/e2e/`, repo root (no CI config)
- Risk: Integration regressions between the three packages ship unnoticed.
- Priority: Medium

---

*Concerns audit: 2026-08-23*

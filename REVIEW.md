# Review instructions

Read by the required pre-merge reviewer (Claude Code, Codex or Kimi Code), additional
`/codex:review` or `/code-review` passes, and human reviewers alike.

## Passes

Run these passes and tag every finding with its pass:

- **Bugs**: logic errors, broken edge cases, regressions in reading, rendering, selection or editing.
  Error messages: a new or changed error, refusal or failure message a person or agent sees names the
  cause (what failed and why) and the next step (the command, setting or target that fixes it). A
  message missing either is a finding; Important when it is the only signal of a blocked action (a
  refused edit, a failed render), otherwise a nit.
- **Security**: path traversal or unchecked sizes on uploaded documents and assets, argv injection into
  the `hwp` binary, secrets in workflows or logs.
- **Compliance**: the change matches the issue spec and the approved plan, and respects the invariants
  below. Workflow changes are also checked for a timeout on every job and PR-only cancellation.
- **Instruction prose** (changes to REVIEW.md, agent instructions, skill files or prompts): each
  directive says what to do, when and where, and names the failure it prevents; rationale and history
  stay out of the agent-read text. Nits unless runtime behavior changes.

## Repo focus

- **Failure wrappers keep the engine cause.** When rewriting engine `failed` errors,
  retain the original cause or name only the specific command known to have failed
  (`packages/server/src/cli-engine.ts`, `rethrowUploadedImageFailure`); a mixed edit
  batch must not receive an image-only remedy just because it contains uploads.

- **hwp-cli is the only document engine.** The server drives the released `hwp` binary and gates its
  version (`packages/server/src/cli-engine.ts:54` minimum, `:72` exclusive maximum). Wire shapes come
  from hwp-cli contracts (`segment-envelope-v2`, `render-layout-v1`, `edit-ops-v1`, `edit-report-v1`);
  a field the engine does not publish is a finding, not a client-side guess.
- **Envelope projection is validated.** `packages/core/src/segments.ts:89` refuses unknown segment kinds.
  New engine artifacts the client relies on are validated the same way before they drive behavior.
- **Engine report schema versions.** When reviewing report parsers, require supported-major
  matching (`1.x`), never exact minor equality, and reject malformed consumed fields
  (`packages/core/src/templates.ts:reportSchemaVersion`,
  `packages/server/src/template-engine.ts:lint`).
- **Both locales ship together.** `ko` is typed as `MessageTable = typeof en`
  (`packages/react/src/messages.ts:153`, `:166`), so a missing Korean key fails typecheck. A new control
  without strings in both tables is a finding.
- **No stored credential on the release path.** REL-02 (`packages/server/test/repo-guards.test.ts:739`)
  rejects any `secrets.` reference except the one documented dist-tag step.
- **e2e never gates a publishing job.** PKG-10 (`packages/server/test/repo-guards.test.ts:647`) keeps
  the e2e job in its own workflow.
- **Transports stay in step.** A field added to `PageImage`, `RenderPageWire` or an engine method is
  carried by the HTTP client (`packages/core/src/http-engine.ts`), the Tauri client
  (`packages/core/src/tauri.ts`) and the server routes (`packages/server/src/routes.ts`) in the same
  change, with a fallback for hosts that do not send it.

## Findings

Each finding carries its pass, severity, evidence (`file:line` or a reproduction), and provenance:
introduced by this change, pre-existing, or indeterminate. Pre-existing findings go to a follow-up issue
instead of widening the change. Report what was reviewed and what was not reached.

## Re-review

Hand the reviewer the diff, the spec and this file, and let it read the rest of the repo. Do not hand it
fix-status claims, earlier dispositions or do-not-reflag notes. Judge recurrence by the violated
invariant, not by wording.

## What Important means here

Reserve Important for findings that break behavior, corrupt or lose document content, leak data, or
violate an invariant above. Style and naming are nits.

## Cap the nits

Report at most 5 nits per review; summarize the rest as a count.

## Do not report

- Generated paths: `pnpm-lock.yaml` (style only; a lockfile change without a matching manifest change
  stays in the Security pass), `packages/*/dist/`, `apps/playground/public/fixtures/` seeded files.
- Anything CI already enforces: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` on Node 22 and 24,
  the package tarball smoke test (`scripts/smoke-consumer.mjs`).

## Feedback into AGENTS.md

When the same finding appears twice, the correction goes into the repo's agent instructions in the same
PR.

---

Findings need an evidence-based disposition. Merges follow the owner's instruction or delegation.

# Host integration: maru (Tauri 2 desktop)

maru runs the `hwp` binary locally, so the engine crosses the Tauri bridge
instead of HTTP. `@hwp-editor/core` ships `createTauriEngine(invoke)`; maru's
Rust side (`src-tauri/src/hwped.rs`) implements the matching `hwped_*`
commands as a thin spawner.

```
webview                                 Rust (src-tauri)
@hwp-editor/react ──engine──▶ createTauriEngine(invoke)
                                     │ invoke("hwped_*", payload)
                                     ▼
                    hwped_read / render / edit / compose / validate / capabilities
                                     │ Command::new, fixed argv, no shell,
                                     │ 60s timeout, 32MB stdout cap
                                     ▼
                              hwp binary (MARU_HWP_BIN → PATH → ~/.maru/skills/hwpx/)
```

Fonts come from the desktop OS, which on macOS and Windows supplies CJK faces.
A Linux desktop without CJK fonts renders pages with no text. Install them, or
point `HWP_FONT_DIR` at a font directory ([ax recipe section
2b](./integration-ax.md#2b-provisioning-fonts) has the faces and the
family-name check).

## Commands

The Tauri client strips a host's `imageAssets` claim and refuses uploaded image bytes; an API caller can send an `insert-image` op with a local path, while a user working in the app inserts the picture in a word processor and reopens the document. The path reaches the engine unchanged on the JSON op channel; on the legacy argv channel it resolves only inside `workspaceRoot`, so that directory has to contain the file.

Payloads mirror `packages/core/src/protocol.ts`, with two Tauri deltas:

| Command | Payload | Returns |
|---|---|---|
| `hwped_read` | `{ document, workspaceRoot? }` | `CatEnvelope` |
| `hwped_render` | `{ document, options?, workspaceRoot? }` | `RenderResponse` |
| `hwped_edit` | `{ document, ops? / opsArgv?, verify?, allowPartial?, report?, structuredRefusal?, workspaceRoot? }` | `EditResponse` |
| `hwped_compose` | `{ spec, name }` | `ComposeResponse` |
| `hwped_validate` | `{ document, workspaceRoot? }` | `ValidationReport` |
| `hwped_capabilities` | `{}` | `Capabilities` |

- `document` is a `TauriDocumentRef`: `{ name, path? }` when the bytes are
  already on disk (relative paths resolve against `workspaceRoot`, with an
  escape guard), `{ name, dataBase64 }` otherwise. Paths are preferred —
  base64 only when the document is in-memory.
- The client queries `hwped_capabilities` before each edit. If `editOps` is
  `"v1"`, it serializes `EditOp[]` with `opsToJson`, parses that JSON into an
  array and sends it as `ops`. Other hosts receive only `opsArgv`, generated
  by `opsToArgv`. Exactly one of these fields is present, even for an empty
  edit list; both/neither is `hwped_bad_request` on the host.
- The JSON channel preserves addresses, WCHAR ranges and literal separator
  characters. Rust validates that `ops` is an array, writes it into the
  call's private work directory and invokes `hwp edit --ops <file>`. The
  engine validates the grammar. A JSON edit failure is never retried through
  argv, which could lose the target or repeat an edit.
- `Capabilities.editOps: "v1"` means this client and the host both support the
  JSON channel. Only that implemented capability is exposed; unknown future
  channel versions are omitted. Older hosts keep legacy argv controls, and
  addressed edits are refused before `hwped_edit` with an upgrade next step.
- `report` asks for `edit-report-v1` (`hwp edit --report <FILE>`, hwp-cli
  1.4.0+). Only that report names the segment ids an insert created, so the
  components palette sends `report: true` and reads `report` back from
  `EditResponse`; the client parses it with `parseEditReport` and leaves the
  field absent when the host answers without one or with an unreadable one. A
  host that ignores the flag therefore disables the palette's inserted-ids
  path instead of having ids guessed for it.

- `structuredRefusal: true` says the client can handle an object rejection with
  `report`; it does not request a report. The client sends it when
  `refusalCodesSupported(caps.version)` holds (agent-hwp >= 1.6.3), separately
  from `report`. An older engine does not receive it, even if a preset batch
  or caller asks for a successful report. A supporting host returns the
  sanitized `{ code, message, report, engineVersion }` object for refused edits
  only with this opt-in. The client classifies the validated report by refusal
  code. Without the opt-in the host keeps its prefixed string error; hosts
  without object support may also return strings, preserving string classification.

- Rust errors are prefixed strings: `cli_missing:`, `hwp_timeout:`,
  `hwp_failed:`, `hwp_parse_failed:`, `hwped_bad_request:`. The engine wraps
  them as `<cmd> failed: <detail>`.

## Wiring

```ts
import { invoke } from "@tauri-apps/api/core";
import { createTauriEngine } from "@hwp-editor/core";
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css";

const engine = createTauriEngine(invoke, {
  workspaceRoot,                       // maru's active workspace
  pathOf: (doc) => relPathByName.get(doc.name), // undefined → base64
});
```

Mount it as `<HwpEditor engine={engine} file={file} locale="ko" />`.
`locale="ko"` is required: the chrome defaults to English, so a maru build
without it ships English buttons to Korean users. This prop is the UI
language only and is unrelated to the server-side `createCliEngine({ locale })`.
Full prop reference: [packages/react/README.md](../packages/react/README.md).

`@hwp-editor/core` is published — `pnpm add @hwp-editor/core` gets the real
types. maru has not migrated yet: `maru/src/lib/hwped.ts` still provides typed
invoke wrappers over the same commands with mirrored copies of those types.
Replacing them with the published package is Phase 7 (EXT-04), not something to
do from this repository.

## Theming: maru tokens → `--hwped-*`

maru has no Tailwind; its palette lives in `src/styles.css`
(hanji-ink-seal tokens, light block + `[data-theme="dark"]` override) and
type/space/shape in `src/foundations.css`. Map them onto the editor contract
on the editor's mount element:

```css
.hwp-editor-host {
  --hwped-bg: var(--panel);
  --hwped-fg: var(--ink);
  --hwped-muted: var(--muted);
  --hwped-accent: var(--accent);
  --hwped-border: var(--line);
  --hwped-radius: var(--radius);
  --hwped-font: "Pretendard", "Pretendard Variable", "Malgun Gothic",
    "맑은 고딕", -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
}
```

Because the editor reads the variables with `var()` at use sites and maru's
dark theme swaps the token values on an ancestor, dark mode follows maru's
theme automatically — no second mapping block.

## Follow-up: resident MCP server

Each command spawns a fresh `hwp` process; a page re-render round-trip pays
process startup every time. If render latency becomes visible in the editor
loop, the upgrade path is a resident `hwp mcp --root <dir>` stdio server
(16 tools) owned by the Rust side for the app's lifetime, with the same
`hwped_*` command surface in front of it. Deliberately not implemented in
this pass — the CLI spawner keeps exact parity with the Node engine.

## Optional template commands

The template API requires hwp-cli 1.4.0 or newer. Existing hosts may omit all
new methods. Advertise only implemented commands through
`Capabilities.templateMethods`: `slots`, `fill`, `template`, `lint`,
`listTemplates`, `create`. Both clients treat a missing advertisement as an
empty list, so old hosts show disabled controls with upgrade guidance.

| Tauri command | Payload | Result |
| --- | --- | --- |
| `hwped_slots` | `{ document, workspaceRoot? }` | `TemplateInputs` |
| `hwped_fill` | `{ document, values, workspaceRoot? }` | `FillResponse` |
| `hwped_template` | `{ spec, data, name, workspaceRoot? }` | `ComposeResponse` |
| `hwped_lint` | `{ document, profile?, workspaceRoot? }` | `LintReport` |
| `hwped_list_templates` | `{ workspaceRoot? }` | `EmbeddedTemplate[]` |
| `hwped_create` | `{ templateId, name, workspaceRoot? }` | `EditResponse` |

The HTTP equivalents are POST `/slots`, `/fill`, `/lint` (multipart file,
with `values` JSON or `profile` where applicable), POST `/template` and
`/create` (JSON), and GET `/templates`. All routes pass through authorization;
POST routes retain the request-size gate. New reports are validated and
projected before use; native CLI output paths are not exposed.

The CLI adapter fills HWPX placeholders/form inputs and native fields together.
HWP placeholder fill is refused with an HWPX next step. TemplateSpec accepts
self-contained compose mode; host-file references and local asset paths are
refused. Template Preview changes no editor bytes; Apply replaces the document
as one undo step. Lint findings show severity, location and context without
segment links while column-to-segment correspondence remains unverified.

Adding the client methods does not install Rust host commands. Implement and
verify the commands before advertising them. A direct call to a missing Tauri
command fails with an unsupported-host error naming the host upgrade needed.

## Source-bound forms (agent-hwp 2.0.0)

Form binding is separate from `slots`/`fill`. A host must explicitly advertise
`formBindings: "v1"` in `hwped_capabilities`, with engine version >=2.0.0, before
this client sends either command. Without it the Form panel is hidden. Adding the
host commands is a separate host task; the client never probes an unknown command.

- `hwped_discover_forms({ document, workspaceRoot? })` returns validated
  `FormDiscovery` version 1 from `ahwp slots <source> --forms --occurrences --json`.
- `hwped_apply_form_bindings({ document, workspaceRoot?, plan, values, options })`
  takes `FormBindingPlan` version 1, literal string values and
  `options: { dryRun: boolean, name: string }`. Only the source format is allowed.
  The host stages one exclusive `apply_form_bindings` op with host-owned receipt
  and preview paths, and runs `ahwp edit ... --verify`, adding `--dry-run` in preview
  mode. Never send caller artifact paths or mix other edits into this operation.
- The response is `{ receipt, preview, name?, dataBase64? }`. Dry run requires
  `receipt.published: false` and no native document bytes. Apply requires
  `receipt.published: true` and same-format document bytes. Receipt and preview
  source/plan/values identities must agree. No staged filesystem paths cross the
  bridge; native warning prose is omitted by the client parser.

HTTP has equivalent multipart POST `/form-discovery` (`file`) and
`/form-bindings` (`file`, JSON `plan`, JSON `values`, `dryRun`, optional `name`).
Existing authorization, size admission and document magic checks apply. Receipt
and preview artifacts live in a private per-call directory removed after exit.
Discovery and explicit preview contain document text and stay in the caller's
local review flow; do not record them in public logs.

The panel selects exact occurrences without guessing label ownership. Each target
has its own value, Unicode scalar budget and explicit reflow permission (default
false). It dry-runs first and applies the same reviewed plan as one undoable editor
transition. Input or source changes invalidate the preview. Pending edits must be
applied or discarded first. Unsupported inventory targets retain their cause and
next action. A receipt proves semantic binding only; fonts, fit, clipping and
native-open acceptance remain separate.

With released ahwp 2.0.0, `apply_form_bindings` rejects a separate `--report`
and emits no refused edit report. Use its mandatory receipt and optional preview;
unavailable native refusal codes remain `engine_refused`, without reading prose.
Before edit, the server checks a fresh source-matching discovery against plan values
for `growth_without_reflow`. The panel also checks this before making an apply call.
No-growth permission uses the original UTF-16 length, whereas `max_chars` counts
Unicode scalars. A growth refusal names both remedies: allow reflow, or keep the
value within the original length. This preflight does not invent a native report.

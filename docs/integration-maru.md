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

Payloads mirror `packages/core/src/protocol.ts`, with two Tauri deltas:

| Command | Payload | Returns |
|---|---|---|
| `hwped_read` | `{ document, workspaceRoot? }` | `CatEnvelope` |
| `hwped_render` | `{ document, options?, workspaceRoot? }` | `RenderResponse` |
| `hwped_edit` | `{ document, ops? / opsArgv?, verify?, allowPartial?, workspaceRoot? }` | `EditResponse` |
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

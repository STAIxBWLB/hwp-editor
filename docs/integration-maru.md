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

## Commands

Payloads mirror `packages/core/src/protocol.ts`, with two Tauri deltas:

| Command | Payload | Returns |
|---|---|---|
| `hwped_read` | `{ document, workspaceRoot? }` | `CatEnvelope` |
| `hwped_render` | `{ document, options?, workspaceRoot? }` | `RenderResponse` |
| `hwped_edit` | `{ document, opsArgv, verify?, allowPartial?, workspaceRoot? }` | `EditResponse` |
| `hwped_compose` | `{ spec, name }` | `ComposeResponse` |
| `hwped_validate` | `{ document, workspaceRoot? }` | `ValidationReport` |
| `hwped_capabilities` | `{}` | `Capabilities` |

- `document` is a `TauriDocumentRef`: `{ name, path? }` when the bytes are
  already on disk (relative paths resolve against `workspaceRoot`, with an
  escape guard), `{ name, dataBase64 }` otherwise. Paths are preferred —
  base64 only when the document is in-memory.
- `opsArgv` is `opsToArgv(ops)` output, computed JS-side. Rust splices the
  fragments into `hwp edit` verbatim and owns no op grammar.
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

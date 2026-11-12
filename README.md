# hwp-editor

Embeddable GUI editor for Korean HWP/HWPX documents. All document
functionality (reading, rendering, editing, composing, validating) is
delegated to the external [`agent-hwp`](https://github.com/STAIxBWLB/agent-hwp)
binary, whose command is `ahwp` (the 1.x `hwp` name is accepted as a fallback;
**>= 0.20.0, < 3.0.0**). This repo contains UI and thin engine adapters only.

Editing model: segment-based structured editing. `ahwp render` visualizes
pages, clicked segments map to `ahwp edit` operations, and edits are verified
by re-rendering.

## Layout

- `packages/core` — framework-free TypeScript core: engine interface, typed
  edit ops (`ahwp edit` argv mapping), segment parsing, spec types, editor
  state store, HTTP engine client, Tauri engine client.
- `packages/react` — embeddable React UI: page canvas, segment inspector,
  table grid, fields panel, compose panel. Themeable via `--hwped-*` CSS
  variables only.
- `packages/server` — Node adapter that spawns the agent-hwp binary behind the
  `protocol.ts` HTTP contract (framework-agnostic handler + Next.js factory).
- `apps/playground` — smoke-test harness + Playwright e2e over the real
  binary.

## Host integrations

Every host uses the same `HwpEngine` contract; only the transport differs.

| Host | Transport | Recipe |
|---|---|---|
| ax (Next.js / Vercel) | HTTP via `@hwp-editor/server` Next factory, pinned binary via fetch script | [docs/integration-ax.md](docs/integration-ax.md) (canonical) |
| maru (Tauri 2 desktop) | `createTauriEngine` over `hwped_*` Rust commands | [docs/integration-maru.md](docs/integration-maru.md) |
| maru-web / anchor.halla.ai (browser) | `createHttpEngine` against a hosted endpoint, auth via fetch injection | [docs/integration-web.md](docs/integration-web.md) |

Theming is host-agnostic: map the host's tokens onto the `--hwped-*`
contract — [docs/theme-contract.md](docs/theme-contract.md).

## Child process environment

`@hwp-editor/server` decides the hwp-cli child's locale instead of
inheriting it. The child always runs with `LANG`, `LC_ALL` and `LC_MESSAGES`
set to `C.UTF-8` and `HWP_LANG` set to `en`, whatever the operator's shell
holds for those four names. This makes the child's language selection
independent of the shell it was launched from, and keeps its encoding
deterministic in slim container images where `en_US.UTF-8` may not exist.

A deployment that relied on `HWP_LANG=ko` in its shell must now pass the
language explicitly:

```ts
createCliEngine({ locale: "ko" });
// behind the route factory:
createHwpEditorRoutes({ engine: createCliEngine({ locale: "ko" }) });
```

This `locale` is the hwp-cli child's language and is unrelated to the
`HwpEditor` `locale` prop, which selects the UI chrome language and also
defaults to English; setting one does not set the other. See
[packages/react/README.md](packages/react/README.md) for the UI prop.

`locale` sets `HWP_LANG` only; `LANG`, `LC_ALL` and `LC_MESSAGES` stay
pinned to `C.UTF-8` regardless, so changing the language cannot accidentally
change the encoding. `HWP_FONT_DIR` is the only other `HWP_*` variable
copied from the parent environment; together with `PATH` and `HOME` it passes
through unchanged, and everything else is stripped. A server with no CJK
system fonts needs `HWP_FONT_DIR`, or its pages render without text; see
[docs/integration-ax.md section 2b](docs/integration-ax.md#2b-provisioning-fonts).

## Develop

```sh
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

Requires Node >= 22 and pnpm 10.

Run the playground from a clean checkout (Node >= 22, the pinned pnpm version,
and agent-hwp installed as `ahwp` >= 0.20.0, tested with 1.6.1):

```sh
pnpm playground
```

`HWP_EDITOR_BIN=/path/to/ahwp pnpm playground` selects a particular binary. The
command installs locked dependencies, builds the packages, seeds fixtures and
starts the editor at http://localhost:3100/editor. It does not install system
tools or change an existing hwp binary.

Playground e2e (real binary; `HWP_EDITOR_BIN` selects it, otherwise `ahwp` on
PATH, and `hwp` only where that 1.x name is all that is installed):

```sh
pnpm --filter playground seed
pnpm --filter playground exec playwright install chromium
pnpm --filter playground test:e2e
```

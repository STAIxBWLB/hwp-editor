# hwp-editor

Embeddable GUI editor for Korean HWP/HWPX documents. All document
functionality (reading, rendering, editing, composing, validating) is
delegated to the external [`hwp`](https://github.com/entelecheia/hwp-cli)
binary (hwp-cli **>= 0.8.7**); this repo contains UI and thin engine
adapters only.

Editing model: segment-based structured editing. `hwp render` visualizes
pages, clicked segments map to `hwp edit` operations, and edits are verified
by re-rendering.

## Layout

- `packages/core` — framework-free TypeScript core: engine interface, typed
  edit ops (`hwp edit` argv mapping), segment parsing, spec types, editor
  state store, HTTP engine client, Tauri engine client.
- `packages/react` — embeddable React UI: page canvas, segment inspector,
  table grid, fields panel, compose panel. Themeable via `--hwped-*` CSS
  variables only.
- `packages/server` — Node adapter that spawns the hwp-cli binary behind the
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

## Develop

```sh
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

Requires Node >= 22 and pnpm 10.

Playground e2e (real binary; `HWP_EDITOR_BIN` overrides the default path):

```sh
pnpm --filter playground seed
pnpm --filter playground exec playwright install chromium
pnpm --filter playground test:e2e
```

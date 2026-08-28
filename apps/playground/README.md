# playground

Smoke-test harness for `@hwp-editor/server` over the real `hwp` binary. The
actual editor UI is Phase 3; this app only proves the HTTP contract works
end to end inside a Next.js 16 App Router host.

## Setup

```sh
pnpm install
pnpm seed   # compose example specs into fixtures/ + public/fixtures/
pnpm dev
```

## hwp binary

The API route (`app/api/hwp-editor/[...action]/route.ts`) resolves the binary
in this order: `HWP_EDITOR_BIN` env -> `HWP_CLI` env -> `hwp` on PATH. The
route defaults `HWP_EDITOR_BIN` to the hwp-cli 0.8.8 debug build at
`/Users/yj.lee/workspace/work/dev/hwp-cli/target/debug/hwp` for local dev,
because PATH carries 0.8.6 which is too old (no `compose --report`, no
`render --report`, no edit structure ops). Minimum version is enforced by the
engine at first use.

## Routes

All under `/api/hwp-editor/` — see `packages/core/src/protocol.ts`:
`POST read|render|edit|validate` (multipart), `POST compose` (JSON),
`GET capabilities`.

# playground

Smoke-test harness for `@hwp-editor/server` over the real `hwp` binary. The
actual editor UI is Phase 3; this app only proves the HTTP contract works
end to end inside a Next.js 16 App Router host.

## Setup

```sh
pnpm install
pnpm seed   # compose the demo fixture into fixtures/ + public/fixtures/
pnpm dev
```

## hwp binary

The API route (`app/api/hwp-editor/[...action]/route.ts`) passes no `bin`, so
the binary is whatever the engine resolves, first match wins: the `bin` option
-> `HWP_EDITOR_BIN` env -> `HWP_CLI` env -> `hwp` on PATH. The accepted version
range is enforced by the engine at first use.

## Routes

All under `/api/hwp-editor/` — see `packages/core/src/protocol.ts`:
`POST read|render|edit|validate` (multipart), `POST compose` (JSON),
`GET capabilities`.

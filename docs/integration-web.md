# Host integration: web (maru-web / anchor.halla.ai)

Pure browser hosts have no local binary and no Tauri bridge: the editor
talks to a hosted endpoint over the `protocol.ts` HTTP contract with
`createHttpEngine`. This is the same client ax uses against its own routes —
only the base URL and the auth story differ.

```
browser (maru-web, anchor.halla.ai)
@hwp-editor/react ──engine──▶ createHttpEngine("https://<host>/api/hwp-editor", { fetch })
                                     │ multipart/JSON over HTTPS, auth headers
                                     ▼
                       hosted @hwp-editor/server (or hwp-gateway, below)
```

## Client

```ts
import { createHttpEngine } from "@hwp-editor/core";

const engine = createHttpEngine("https://hwp.halla.ai/api/hwp-editor", {
  // Auth via fetch injection: the engine never owns credentials.
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${getSessionToken()}`,
      },
      credentials: "include",
    }),
});
```

Notes:

- **Auth is the host's problem by design.** `HttpEngineOptions.fetch`
  replaces the transport wholesale, so bearer tokens, cookies, or a signing
  proxy all work without engine changes. Never bake credentials into the
  base URL.
- **Payloads are whole documents.** `read/render/edit/validate` upload the
  document as multipart on every call (the protocol is stateless per
  request; server-side sessions only key caches and undo snapshots by
  content hash). For large documents over slow links, prefer fewer, bigger
  calls: batch ops before `edit`, request `render` with a page range.
- **CORS** must allow the origin and the multipart content type when the
  API lives on a different origin than the page.
- The same-origin deployment (route handlers next to the page, as in the
  playground app) needs no auth story at all and is the cheapest way to
  pilot the UI.

## Endpoint options

1. **Self-hosted `@hwp-editor/server`.** Run `createHwpEditorHandler()`
  (framework-agnostic `(Request) => Response`) on any Fetch-API runtime, or
  `createHwpEditorRoutes()` under Next.js — the [ax recipe](./integration-ax.md)
  covers provisioning and deployment details.
2. **hwp-gateway (future shared endpoint).**
   [`hwp-gateway`](https://github.com/entelecheia/hwp-gateway)
   (`~/workspace/work/sites/hwp-gateway`) already operates hwp-cli as a
   serverless service (Vercel; Teams/Telegram bots; pinned-binary provisioning
   via `scripts/fetch-hwp-cli.sh`). Exposing the `protocol.ts` routes there
   would give every web host one shared, already-hardened endpoint instead of
   per-app binaries. Tracked as a follow-up; until it lands, hosts deploy
   their own route per option 1.
## Theming

Map the host's design tokens onto the `--hwped-*` contract — see
[theme-contract.md](./theme-contract.md) for the variable list and per-stack
examples.

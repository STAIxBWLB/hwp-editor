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
                       hosted @hwp-editor/server
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

### Opening a document

`HwpEditor`'s `file` prop is a `DocumentHandle`, not a browser `File`. The two are easy to
confuse because a file input hands you the latter, and the failure is misleading: the HTTP
engine builds its multipart part from `document.data`, so a `File` produces an EMPTY part and
the server answers `400 file is not an HWP or HWPX document`. The message accuses the document;
the cause is the prop.

```ts
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css"; // not auto-injected

async function toHandle(file: File) {
  return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
}

// <input type="file" onChange={async (e) => setDoc(await toHandle(e.target.files[0]))} />
<HwpEditor engine={engine} file={doc} />;
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

## Endpoint

Self-host `@hwp-editor/server`. Run `createHwpEditorHandler()`
(framework-agnostic `(Request) => Response`) on any Fetch-API runtime, or
`createHwpEditorRoutes()` under Next.js; the [ax recipe](./integration-ax.md)
covers provisioning and deployment details.

A shared multi-host endpoint (one hardened deployment instead of a binary per
app) is a plausible follow-up, but no such endpoint is published today.

## Theming

Map the host's design tokens onto the `--hwped-*` contract — see
[theme-contract.md](./theme-contract.md) for the variable list and per-stack
examples.

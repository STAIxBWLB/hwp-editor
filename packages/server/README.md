# @hwp-editor/server

Node adapter that serves the `@hwp-editor/core` HTTP contract by spawning the
external [hwp-cli](https://github.com/STAIxBWLB/hwp-cli) binary. All document
work (read/render/edit/compose/validate) is delegated to that binary; this
package contains no HWP parsing, only a hardened subprocess wrapper and a
framework-agnostic `(Request) => Response` handler.

## Install

```sh
pnpm add @hwp-editor/server
```

`@hwp-editor/core` arrives as a peer, deduped to a single copy. This package
also needs the external `hwp` binary at runtime — see **Binary resolution**
below; it is not an npm dependency and nothing installs it for you.

## Usage

Next.js App Router:

```ts
// app/api/hwp-editor/[...action]/route.ts
import { createHwpEditorRoutes } from "@hwp-editor/server/next";

export const runtime = "nodejs"; // the handler spawns a child process
export const { GET, POST } = createHwpEditorRoutes({});
```

Any Fetch-API runtime (Hono, Bun, Deno, a bare `node:http` bridge):

```ts
import { createHwpEditorHandler } from "@hwp-editor/server";

const handler = createHwpEditorHandler({ bin: process.env.HWP_EDITOR_BIN });
// handler(request) -> Response, for POST /read|render|edit|compose|validate
// and GET /capabilities. The action is the last path segment.
```

The client is `createHttpEngine(baseUrl)` from `@hwp-editor/core`; point it at
whatever path you mounted the handler on.

## Options

`createHwpEditorRoutes` and `createHwpEditorHandler` take the same
`RoutesOptions` object. The Next.js factory declares no options interface of
its own and forwards yours whole, so every field below reaches both.

| Option | Type | Notes |
| ------ | ---- | ----- |
| `engine` | `HwpEngine` | Serve a supplied engine instead of the default `CliEngine`. A plain `HwpEngine` receives no per-call options, so its children are not cancellable from here and its caches are not scope-salted. |
| `bin` | `string` | Default engine only: explicit path to the `hwp` binary. First in the resolution order below. |
| `timeoutMs` | `number` | Default engine only: per-invocation timeout, default `60000`. On a host with a hard request budget (a 60s serverless function), set this a few seconds under it so this package's 504 beats the platform's kill. |
| `locale` | `string` | Default engine only: language passed to the child as `HWP_LANG`, default `en`. Accepts `en`/`eng`/`english`/`c`/`posix` and `ko`/`kor`/`korean`. Unrelated to `@hwp-editor/react`'s `locale` prop, which is UI chrome only. |
| `maxRequestBytes` | `number` | Largest request admitted, default `52428800` (50 MiB). Compared against `Content-Length` before any buffering, so the figure covers the whole request envelope (multipart boundaries and part headers included), not the document alone. **Not a memory bound**; see Deployment assumptions. |
| `sessions` | `SessionStore \| false` | In-memory cache of read-pipeline extras (fields/bookmarks/slots/info), keyed by an opaque id with a 30-minute idle TTL. It retains no document bytes and touches no filesystem. Pass `false` to disable. |
| `authorize` | `AuthorizeFn` | `(req, action) => Promise<string \| null>`. The trust boundary; see below. Defaults to allow-all. |

## Trust boundary

**This package owns no authentication and by default admits every request.**
A deny-by-default would break every existing caller and the one-line example
above, so the default is permissive and stated rather than hidden. Mounting
this handler on a route an untrusted client can reach, without supplying
`authorize`, means that client can run the binary on any document they send.

`authorize(req, action)` is the insertion point:

```ts
createHwpEditorRoutes({
  async authorize(req, action) {
    const session = await getSession(req); // your auth, your rules
    if (session === null) return null;     // -> HTTP 403, code `forbidden`
    return session.tenantId;               // -> the cache scope for this request
  },
});
```

Its return value answers two questions in one call, deliberately:

- **Admission.** `null` refuses the request with HTTP 403 and `error.code`
  `forbidden`. The message is a fixed literal: no host-authored reason string
  can ride out to an unauthenticated client. It is awaited **before any body is
  read**, so a refusal costs zero uploaded bytes and zero engine calls.
- **Tenancy.** The string it returns is the scope every server-side cache key is
  salted with: the session map in the handler and the inspection and undo-
  snapshot caches inside the engine. Two callers uploading identical bytes under
  different scopes share no entry of any kind. Because one call decides both,
  admission and isolation cannot disagree.

`GET /capabilities` is gated too; it discloses the resolved hwp-cli version.

With no hook supplied every request is allowed and every request uses the same
fixed scope, which is the correct behaviour for a single-tenant host and the
wrong behaviour for a multi-tenant one.

## Request admission

Every refusal below is decided before the corresponding cost is incurred.

Pre-buffer, from the method, URL and headers alone:

1. **Unknown action** → 404 `not_found`.
2. **Wrong method** → 405 `method_not_allowed` (`GET` for `capabilities`, `POST`
   for the rest).
3. **`authorize`** → 403 `forbidden`.
4. **`Content-Length`** → 413 when over `maxRequestBytes`, 400 when the header is
   absent or unparseable.

Post-buffer, before the binary spawns:

5. **Magic-byte sniff**: the upload must be a CFBF/OLE2 container (HWP5) or a
   zip whose first entry is a STORED `mimetype` reading `application/hwp+zip`
   (HWPX). Anything else is 400. About ninety bytes are read and nothing is
   decompressed.
6. **Op path filter**: an `edit` whose ops include `insert-image` or `seal` is
   refused 400 `path_traversal`.

Two operational consequences worth knowing before you deploy:

- **A request with no `Content-Length` is refused with 400.** A proxy or ingress
  that re-frames uploads as `Transfer-Encoding: chunked` will therefore break
  every upload. The alternative, counting bytes as they arrive, would have to
  read the body first, which is exactly the cost the gate exists to avoid.
- **`insert-image` and `seal` are unavailable over HTTP.** Both name a path on
  the server's own filesystem, so over HTTP a client could otherwise ask the
  binary to embed any file the server process can read. Both remain available on
  the Tauri transport, which is a local application. A staged-asset upload flow
  that makes them usable here is planned but not shipped.

## Deployment assumptions

Four things this package assumes and does not enforce. Each is enforced by the
container or the host, so each is stated here rather than in code.

**Memory: size the container at 2 GiB or more per concurrent CLI invocation.**
hwp-cli's own default limit profile (`hwp-cli-native-v1`) permits 512 MiB per
archive entry and 2 GiB per package at a compression ratio of up to 1000:1, and
`hwp cat` (which every read performs) materialises image data in memory. A
measured 9.0 MB HWPX upload drove a single invocation to 1.70 GB peak RSS while
staying entirely inside those legal limits. **`maxRequestBytes` (default 50 MiB)
is a buffering bound on the request envelope, not a memory bound**; the two do
not compose, and sizing the container against the upload cap is the specific
mistake this section exists to prevent. The figure is per concurrent
invocation, not a total.

**Temp filesystem: size it for the staged input plus the render output of as
many calls as run concurrently.** Each invocation stages its input document and
any render output in a private temp directory, removed only after the child
exits.

**Concurrency: this package does not bound it; the host does.** There is no
queue, no semaphore and no in-flight cap here. Combined with the memory figure
above, an unbounded concurrent request rate is an unbounded memory bill.

**Archive limits: this handler relies on `hwp-cli-native-v1` and deliberately
implements no second decompression, entry-count or XML-size guard.** A duplicate
guard in TypeScript would be a second thing to keep correct against the same
threat. Bumping the binary therefore means re-checking that the profile still
applies and is still default-on.

## Binary

Resolution order, first match wins:

1. the `bin` option
2. `HWP_EDITOR_BIN`
3. `HWP_CLI`
4. `hwp` on `PATH`

The resolved binary is verified once per engine instance, and must satisfy both
checks:

- **Version range**: at least `0.16.0`, and below `1.0.0`. The floor is hard: a
  binary under it lacks flags this package emits. The ceiling is only a
  major-version gate, because a version string is what a binary calls itself.
- **Flag handshake**: `hwp edit --help` must list every long flag the edit-op
  grammar emits, plus `--verify` and `--allow-partial`, matched on word
  boundaries. A binary that reports an acceptable version but has dropped a flag
  is refused with `error.code` `version`. That is the check that actually
  binds this package to what the binary can do.

Child environment: the child is spawned with a scrubbed environment. `PATH` and
`HOME` are passed through, `HWP_FONT_DIR` is the only `HWP_*` variable copied
from the ambient environment, and `HWP_LANG`, `LANG`, `LC_ALL` and `LC_MESSAGES`
are pinned by this package (the locale three to `C.UTF-8`). Everything else,
including any credential in the parent's environment, is stripped.

## Errors

Every non-2xx response is an `ErrorResponse`: `{ error: { code, message } }`.
Codes map to statuses as follows: `bad_request`/`path_traversal`/
`unsupported_format` 400, `forbidden` 403, `not_found`/`session_not_found` 404,
`method_not_allowed` 405, `output_too_large` 413, `failed`/`protected` 422,
`cancelled` 499, `internal`/`version` 500, `unavailable` 503, `timeout` 504.

Messages carry no filesystem path and no raw CLI output. The binary path, the
staged temp file name and the child's stdout/stderr live on non-serialized
fields of the thrown `HwpCliError` (`stderr`, `detail`), which a host can catch
and log itself. This package has no logger and adds none.

## Develop

```sh
pnpm install
pnpm -r build
pnpm -r test        # server integration tests skip without a binary
pnpm -r typecheck
```

Point the suite at a specific binary with `HWP_EDITOR_BIN`.

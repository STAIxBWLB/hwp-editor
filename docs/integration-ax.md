# Host integration: ax (Next.js 16, Vercel)

The canonical server-side recipe. ax consumes the editor as vendored packages
plus the HTTP engine against its own API routes; the `hwp` binary is
provisioned at build time by a pinned fetch script.

```
browser                          ax (Next.js)
@hwp-editor/react  ──engine──▶  createHttpEngine("/api/hwp-editor")
                                      │ multipart/JSON (protocol.ts)
                                      ▼
                      app/api/hwp-editor/[...action]/route.ts
                      = createHwpEditorRoutes()  (@hwp-editor/server/next)
                                      │ execFile, 60s timeout, scrubbed env
                                      ▼
                                bin/hwp (hwp-cli, pinned release)
```

## 1. Vendoring the packages

The packages are `private: true` workspace packages — they are not published
to a registry, so ax takes them as tarballs or a git dependency:

- **Tarball (recommended for deploys).** `pnpm pack` each package in this
  repo (`packages/core`, `packages/react`, `packages/server`), commit or
  artifact-store the `.tgz` files, and depend on them with
  `"@hwp-editor/core": "file:./vendor/hwp-editor-core-0.0.0.tgz"` (and
  `link:` for local dev if both repos are checked out side by side).
  Tarballs make the deploy hermetic and reviewable; bump by re-packing.
- **Git dependency.** `"@hwp-editor/core": "github:entelecheia/hwp-editor#<sha>"`
  pins a commit but rebuilds on install — slower CI, no checked-in artifact
  to review. Acceptable for spikes.

Keep the pin in one place (a `.hwp-editor-version` file or the lockfile) and
bump deliberately, the same discipline as the binary pin below.

## 2. Provisioning the binary (fetch-hwp-cli.sh pattern)

Copy the pattern from hwp-gateway's `scripts/fetch-hwp-cli.sh`:

- The release tag lives in `.hwp-cli-version` (must be `>= v0.8.7`).
- The script downloads `hwp-<tag>-<target>.tar.gz` plus the published
  `.sha256` from the hwp-cli releases page and compares them locally — it
  never pipes upstream's installer into a shell (a git tag is mutable).
- Install goes to `bin/hwp` via a temp file + atomic `mv`; a stamp file
  (`bin/.hwp-cli-version`) skips repeat downloads.
- On Linux it additionally asserts the glibc floor (Vercel runs on the
  2.17 baseline) and that `bin/hwp --version` reports the pinned tag.

Wire it into the build: `"vercel-build": "npm run typecheck && sh scripts/fetch-hwp-cli.sh"`.
At runtime, point the engine at it with `HWP_EDITOR_BIN=<repo>/bin/hwp`
(the CliEngine resolution order is: `bin` option → `HWP_EDITOR_BIN` →
`HWP_CLI` → `hwp` on PATH).

## 3. API route

```ts
// app/api/hwp-editor/[...action]/route.ts
import { createHwpEditorRoutes } from "@hwp-editor/server/next";
import path from "node:path";

export const runtime = "nodejs";        // required: spawns a child process
export const dynamic = "force-dynamic";

export const { GET, POST } = createHwpEditorRoutes({
  bin: process.env.HWP_EDITOR_BIN ?? path.join(process.cwd(), "bin", "hwp"),
});
```

In `next.config.ts` keep the server package external so Next never bundles
the child-process code:

```ts
const nextConfig: NextConfig = {
  serverExternalPackages: ["@hwp-editor/server"],
};
```

The routes implement the `packages/core/src/protocol.ts` contract
(`POST read/render/edit/validate`, `POST compose` as JSON,
`GET capabilities`). Sessions (undo snapshots + cached inspections) default
to an in-memory store with a private temp root; pass
`sessions: false` to disable, or a custom `SessionStore`.

Errors are `ErrorResponse` JSON with mapped statuses: 400 bad request,
422 edit failed, 503 binary unavailable, 504 timeout. A missing binary
fails fast with 503 on every action, including `capabilities` — probe that
route in health checks.

## 4. Client

```tsx
"use client";
import { createHttpEngine } from "@hwp-editor/core";
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css";

const engine = createHttpEngine("/api/hwp-editor");

export function EditorPane({ file }: { file: DocumentHandle | null }) {
  return <HwpEditor engine={engine} file={file} onChange={saveSomewhere} />;
}
```

Theming: map ax's tokens onto the `--hwped-*` contract — see
[theme-contract.md](./theme-contract.md).

## 5. Operational notes

- **Lambda size**: the hwp binary is ~tens of MB; keep it out of the
  serverless bundle (`serverExternalPackages` + `outputFileTracing` excludes,
  or a layer) and out of git (stamp file + `.gitignore`).
- **Timeout**: the engine caps every CLI call at 60s (`HWP_TIMEOUT_MS`);
  the Vercel function limit must exceed that for big renders.
- **Cold start**: the first call per process verifies `hwp --version`
  (>= 0.8.7); subsequent calls reuse the memoized result.

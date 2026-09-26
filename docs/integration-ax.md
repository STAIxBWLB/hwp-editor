# Host integration: ax (Next.js 16, Vercel)

The canonical server-side recipe. ax installs the editor from npm and drives it
with the HTTP engine against its own API routes; the `hwp` binary is
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

## 1. Installing the packages

All three are on npm at `1.1.0`, published with provenance from a tag-triggered
workflow. Install the one you mount; core arrives on its own as a single deduped
peer, so naming it is unnecessary and naming a different version of it is how you
end up with two copies:

```sh
pnpm add @hwp-editor/core @hwp-editor/react @hwp-editor/server
```

Core is named on that line even though react and server already declare it as a
peer, because this guide imports `createHttpEngine` from it directly. pnpm's
strict `node_modules` layout does not expose an automatically installed peer to
the application: a package resolves only what it declares, so an import of core
from ax's own source fails unless ax declares core itself. Declaring it does not
create a second copy - the range is the same `^1.1.0` the peer asks for, and
`scripts/smoke-registry.mjs` asserts the single-copy property on every release.

```ts
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css"; // not auto-injected
```

The stylesheet import is not optional decoration. Nothing injects it, and an
install that omits it produces an editor that loads, imports and renders
*unstyled* - a failure no import probe notices, which is why the release
candidate was checked by mounting it and looking at it.

`@hwp-editor/core` is a `peerDependency` of react and server with a `^1.1.0`
range, so a host that also depends on core directly must keep it inside that
range or npm resolves two copies. The published range is asserted on every
release by `scripts/smoke-registry.mjs`, which installs react and server from
the registry *without naming core* and fails if more than one copy appears.

**This section used to describe vendoring.** Before the release ax took the
packages as `pnpm pack` tarballs referenced by `file:` path, because nothing was
on npm. That path is superseded. `sites/ax/scripts/vendor-hwp-editor.sh` still
exists and is Phase 7's to remove (EXT-03); until then, a reader looking at that
script should know the registry is now the supported route.

A git dependency is still not an option, and that reasoning survives
publication. `github:STAIxBWLB/hwp-editor#<sha>` installs the repository root,
which is named `hwp-editor` and declares no `main` or `exports`, and even a
subdirectory selector pointing at `packages/core` would resolve entry points
under `dist/`, which is gitignored and has no `prepare` script to build it on
install.

Keep the version pin in one place (the lockfile) and bump deliberately, the same
discipline as the binary pin below.

## 2. Provisioning the binary (fetch-hwp-cli.sh pattern)

Provision the binary with a pinned fetch script that follows this shape:

- The release tag lives in `.hwp-cli-version` (must be `>= v0.20.0` and below `v2.0.0`).
- Releases are published on
  [`STAIxBWLB/hwp-cli`](https://github.com/STAIxBWLB/hwp-cli/releases). Each tag
  ships one archive per target plus a sibling `.sha256`:

  | Target | Asset |
  |---|---|
  | `aarch64-apple-darwin` | `hwp-<tag>-aarch64-apple-darwin.tar.gz` |
  | `x86_64-apple-darwin` | `hwp-<tag>-x86_64-apple-darwin.tar.gz` |
  | `x86_64-unknown-linux-gnu` | `hwp-<tag>-x86_64-unknown-linux-gnu.tar.gz` |
  | `x86_64-pc-windows-msvc` | `hwp-<tag>-x86_64-pc-windows-msvc.zip` |

  Every asset has a `<asset>.sha256` next to it, so the download URL is
  `https://github.com/STAIxBWLB/hwp-cli/releases/download/<tag>/<asset>`.
- The script downloads the archive and its `.sha256` and compares them locally;
  it never pipes upstream's installer into a shell (a git tag is mutable).
- Install goes to `bin/hwp` via a temp file + atomic `mv`; a stamp file
  (`bin/.hwp-cli-version`) skips repeat downloads.
- On Linux it additionally asserts the glibc floor (Vercel runs on the
  2.17 baseline) and that `bin/hwp --version` reports the pinned tag.

Wire it into the build: `"vercel-build": "npm run typecheck && sh scripts/fetch-hwp-cli.sh"`.
At runtime, point the engine at it with `HWP_EDITOR_BIN=<repo>/bin/hwp`
(the CliEngine resolution order is: `bin` option → `HWP_EDITOR_BIN` →
`HWP_CLI` → `hwp` on PATH).

## 2b. Provisioning fonts

`hwp render` draws text with fonts from the host, and a serverless runtime
(Vercel included) has **no system fonts**. Without them nothing fails: every
action answers 200, `read` returns the text, and each rendered page comes back
with table rules and other strokes but **no text at all**. A developer Mac never
shows this, because macOS supplies CJK system fonts.

hwp-cli looks for render fonts in `--font-dir`, then `HWP_FONT_DIR`, then
`fonts/` relative to its working directory. `@hwp-editor/server` passes no
`--font-dir`, but `HWP_FONT_DIR` is the one `HWP_*` variable it copies into the
child's environment. So:

- Ship CJK faces with the deployment, for example in `fonts/`. Noto Sans CJK KR and
  Noto Serif CJK KR (SIL Open Font License, about 16 to 25 MB per face) are known to
  work. Pinned upstream bytes are at
  `https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf`
  (sha256 `6bcb2a0703aa137e874fc2dffa85f6c21ba9a67fa329e81b8c801663af7e992a`).
- **The family name has to match.** hwp-cli picks fallbacks by family name, and its list
  includes `Noto Serif CJK KR`, `Noto Sans CJK KR`, `NanumMyeongjo` and
  `NanumGothic`. Some builds report a different name: the Nanum OTFs say
  `NanumGothicOTF` and match nothing. Check a face before shipping it:
  `fc-query -f '%{family}\n' fonts/NotoSansCJKkr-Regular.otf` must list
  `Noto Sans CJK KR`.
- Set the variable before the first engine call, in the route module:

  ```ts
  process.env.HWP_FONT_DIR ??= path.join(process.cwd(), "fonts");
  ```

- Trace the directory into the function next to the binary; Next's tracer cannot
  follow a runtime path:

  ```ts
  outputFileTracingIncludes: {
    "/api/hwp-editor/**": ["./bin/hwp", "./fonts/**"],
  },
  ```

To confirm, render a Korean document through the route and check the page shows
its text. A page with only rules and boxes means the fonts are missing.

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
  return (
    <HwpEditor
      engine={engine}
      file={file}
      locale="ko"
      onChange={saveSomewhere}
    />
  );
}
```

Locale: the editor chrome defaults to English. `locale="ko"` selects Korean,
which is what ax wants; drop it and Korean users get English buttons. This
prop is unrelated to the server-side `createCliEngine({ locale })`, which
only sets the hwp-cli child's `HWP_LANG` and never touches the UI. Full prop
reference: [packages/react/README.md](../packages/react/README.md).

Theming: map ax's tokens onto the `--hwped-*` contract — see
[theme-contract.md](./theme-contract.md).

## 5. Operational notes

- **Lambda size**: the hwp binary is ~tens of MB; keep it out of the
  serverless bundle (`serverExternalPackages` + `outputFileTracing` excludes,
  or a layer) and out of git (stamp file + `.gitignore`).
- **Fonts**: the four Noto CJK KR faces (Sans/Serif, Regular/Bold) add about
  80 MB to the editor function; section 2b explains why they have to be there.
- **Timeout**: the engine caps every CLI call at 60s (`HWP_TIMEOUT_MS`);
  the Vercel function limit must exceed that for big renders.
- **Cold start**: the first call per process verifies `hwp --version`
  (>= 0.20.0 and < 2.0.0); subsequent calls reuse the memoized result.

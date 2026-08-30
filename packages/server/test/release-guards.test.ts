/**
 * Release-instrument guards for REL-01 and REL-03: the range arithmetic and the
 * dedupe count that `scripts/smoke-registry.mjs` judges a published release
 * with.
 *
 * Placement: these assertions are about the release instruments, not about
 * `@hwp-editor/server`. They live in this package's suite for the same reason
 * `repo-guards.test.ts` does - `pnpm -r test`, the command
 * `.github/workflows/ci.yml` runs, only reaches tests that sit inside a
 * workspace package. The known cost is the same one that file records: a
 * source-tree consumer running `pnpm --filter @hwp-editor/server test` outside a
 * full checkout fails on a repository fact rather than a server fact.
 *
 * What this suite does and does not prove. It fails if `expectedPeerRange` loses
 * its caret or if `assertResolvedPeer` becomes a no-op. It does NOT fail if the
 * script's stage 5 calls those helpers with the wrong arguments, because the
 * stage bodies sit behind the entry-module guard and never run under vitest.
 * That wiring is first exercised by the first green run of
 * `node scripts/smoke-registry.mjs`, which demands whatever range the three
 * manifests are at: `^1.0.0` today, and `^1.0.0-rc.0` only while the manifests
 * carry the candidate version, since the script derives the expectation from
 * `packages/core/package.json` rather than from a literal.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertResolvedPeer,
  countCoreCopies,
  expectedPeerRange,
  SCRATCH_PREFIX,
} from "../../../scripts/smoke-registry.mjs";

const SCRIPT_URL = new URL("../../../scripts/smoke-registry.mjs", import.meta.url).href;
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);

/**
 * A scratch tree holding a `package.json` at each given relative path, built
 * with the `mkdtempSync`/`writeFileSync` pattern `repo-guards.test.ts` uses.
 */
function manifestTree(relativePaths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hwped-release-guard-"));
  for (const relative of relativePaths) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"name":"@hwp-editor/core","version":"1.0.0"}\n');
  }
  return dir;
}

describe("REL-03: the peer range the RC proves is not the range 1.0.0 ships", () => {
  it("carets a prerelease version", () => {
    expect(expectedPeerRange("1.0.0-rc.0")).toBe("^1.0.0-rc.0");
  });

  it("carets a release version", () => {
    expect(expectedPeerRange("1.0.0")).toBe("^1.0.0");
  });

  it("produces two different strings for the RC and the release", () => {
    // The entire content of D-03: a prerelease does not satisfy a caret range
    // over its own release, so the RC never exercises the range 1.0.0 carries.
    expect(expectedPeerRange("1.0.0-rc.0")).not.toBe(expectedPeerRange("1.0.0"));
  });

  it("throws when the installed manifest declares a different range", () => {
    expect(() => assertResolvedPeer("@hwp-editor/react", "^1.0.0", "^1.0.0-rc.0")).toThrow(
      /\^1\.0\.0-rc\.0/,
    );
    expect(() => assertResolvedPeer("@hwp-editor/react", "^1.0.0", "^1.0.0-rc.0")).toThrow(
      /\^1\.0\.0[^-]/,
    );
  });

  it("names the package whose manifest disagreed", () => {
    expect(() => assertResolvedPeer("@hwp-editor/server", "^1.0.0", "^1.0.0-rc.0")).toThrow(
      /@hwp-editor\/server/,
    );
  });

  it("throws when the installed manifest declares no range at all", () => {
    // `undefined` is what a manifest that moved core into `dependencies`
    // produces, which is the regression the range assertion exists to catch.
    expect(() => assertResolvedPeer("@hwp-editor/react", undefined, "^1.0.0")).toThrow(
      /@hwp-editor\/react/,
    );
  });

  it("returns without throwing when the declared range equals the expected one", () => {
    expect(() => assertResolvedPeer("@hwp-editor/react", "^1.0.0", "^1.0.0")).not.toThrow();
  });
});

describe("REL-01: the dedupe count can fail", () => {
  it("counts two nested copies of the core manifest", () => {
    const dir = manifestTree([
      join("node_modules", "@hwp-editor", "core", "package.json"),
      join("node_modules", "@hwp-editor", "react", "node_modules", "@hwp-editor", "core", "package.json"),
    ]);
    expect(countCoreCopies(dir)).toBe(2);
  });

  it("counts a single hoisted copy as one", () => {
    const dir = manifestTree([join("node_modules", "@hwp-editor", "core", "package.json")]);
    expect(countCoreCopies(dir)).toBe(1);
  });

  it("counts no copy when core is absent, rather than throwing", () => {
    const dir = manifestTree([join("node_modules", "@hwp-editor", "react", "package.json")]);
    expect(countCoreCopies(dir)).toBe(0);
  });
});

/**
 * Both branches of the entry-module guard, in child processes.
 *
 * Not `vi.resetModules()` plus a dynamic import, which is what this used to be:
 * the static import at the top of this file has already executed the module by
 * the time any sample is taken, `resetModules` does not re-execute a natively
 * loaded `.mjs`, and the two samples were therefore equal whether the guard
 * existed or not. An assertion that cannot fail is not a test.
 *
 * The two children differ in exactly the thing the guard reads - whether
 * `process.argv[1]` is the module's own path - and in nothing else. The child
 * that DOES take the branch is the negative control: it runs with a PATH holding
 * no `npm`, so stage 2 dies at once instead of touching a registry, and the
 * scratch directory stage 1 created is left behind as the evidence that the
 * stages ran.
 */
describe("the entry-module guard", () => {
  const strays = () => readdirSync(tmpdir()).filter((name) => name.startsWith(SCRATCH_PREFIX));

  /** A PATH with nothing on it, so `npm` cannot be spawned by either child. */
  const noTools = { ...process.env, PATH: join(tmpdir(), "hwped-no-such-bin") };

  it("runs no stage when the module is imported rather than executed", () => {
    const before = strays();
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import * as m from ${JSON.stringify(SCRIPT_URL)}; console.log(typeof m.expectedPeerRange);`],
      { encoding: "utf8", env: noTools },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("function");
    // Surviving directories from a real run of the script are tolerated by
    // comparing before against after rather than demanding none exist.
    expect(strays()).toEqual(before);
  });

  it("runs the stages when the module IS the entry point", () => {
    // The negative control. If this passed too, the assertion above would be
    // measuring nothing about the guard.
    const before = strays();
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8", env: noTools });

    expect(result.status).not.toBe(0);
    const created = strays().filter((name) => !before.includes(name));
    expect(created.length).toBeGreaterThan(0);
    for (const name of created) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  });
});

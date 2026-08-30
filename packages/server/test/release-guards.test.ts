/**
 * Release-instrument guards for REL-01 and REL-03 - the range arithmetic and the
 * dedupe count that `scripts/smoke-registry.mjs` judges a published release with
 * - and for REL-04, the load-bearing content of `RELEASING.md`.
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
 *
 * What the REL-04 block does and does not prove. It fails if the document loses
 * a lever, loses the sentence denying unpublish, promotes the obsolete bootstrap
 * appendix back above the rollback section, or states an engine range the code
 * does not. It cannot tell whether any sentence in the document is TRUE - prose
 * correctness is not machine-checkable, which is exactly why the guard is
 * confined to presence, position and agreement with a constant.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// ===========================================================================
// REL-04: RELEASING.md's load-bearing content
// ===========================================================================

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RELEASING = join(REPO_ROOT, "RELEASING.md");
const CLI_ENGINE = join(REPO_ROOT, "packages", "server", "src", "cli-engine.ts");

/** D-13's denial, asserted verbatim because the whole point is that it is said. */
const UNPUBLISH_DENIAL = "Unpublishing is not a rollback lever.";

/**
 * The operational half of a trade `release.yml` records in its concurrency
 * comment. One constant group serializes releases so a slow run cannot move
 * `latest` backward, and the accepted cost is that an Actions group holds at
 * most one running and one pending member: a third tag pushed while one release
 * runs and another waits drops the middle one. That is the better failure only
 * because a dropped run spent no version and is re-runnable, while a backward
 * `latest` needs a 2FA-authenticated human. If this sentence leaves the
 * document, the accepted risk quietly becomes an unmanaged one.
 */
const PENDING_TAG_RULE = "Do not push a release tag while another release is pending.";

/**
 * The three levers that DO exist, as the document has to name them. `npm
 * dist-tag` covers moving `latest` back; it is also the command step 7 uses, so
 * this one string cannot distinguish the two sites - deliberately, since losing
 * either is a defect.
 */
const LEVERS = ["npm deprecate", "npm dist-tag", "patch release"] as const;

/** D-15's ordering: the recurring procedure and the rollback section come first. */
const ROLLBACK_HEADING = "## Rollback";
const APPENDIX_HEADING = "## Appendix A";

/** Reads the document. A missing file throws, which is the intended failure. */
function readDocument(path: string): string {
  return readFileSync(path, "utf8");
}

function missingStrings(doc: string, required: readonly string[]): string[] {
  return required.filter((needle) => !doc.includes(needle));
}

/**
 * Fails when the once-only bootstrap sits above the section a second releaser
 * needs. Throws when either heading is absent, because a document missing one of
 * them would otherwise satisfy an index comparison vacuously.
 */
function appendixOrderViolations(doc: string): string[] {
  const rollback = doc.indexOf(ROLLBACK_HEADING);
  const appendix = doc.indexOf(APPENDIX_HEADING);
  if (rollback < 0 || appendix < 0) {
    throw new Error(
      `REL-04 guard found no ${rollback < 0 ? ROLLBACK_HEADING : APPENDIX_HEADING} ` +
        `heading; the ordering check did not run.`,
    );
  }
  if (appendix < rollback) {
    return [
      `"${APPENDIX_HEADING}" appears at ${appendix}, before "${ROLLBACK_HEADING}" at ` +
        `${rollback}; the once-only bootstrap must not precede the recurring procedure`,
    ];
  }
  return [];
}

/**
 * One bound out of `packages/server/src/cli-engine.ts`, by parsing the source
 * text.
 *
 * Not an import: both constants are module-private with no `export`, so there is
 * nothing to import, and exporting them to make a test easier would widen a
 * package's public surface for a repository guard - the wrong trade in the phase
 * that freezes that surface. A parse that matched nothing throws, following
 * `repo-guards.test.ts`'s esbuild guard: "the guard did not run" is a failure,
 * not a clean tree.
 */
function engineBound(source: string, name: string): string {
  const pattern = new RegExp(
    `const ${name}: readonly \\[number, number, number\\] = \\[(\\d+), (\\d+), (\\d+)\\]`,
  );
  const parts = pattern.exec(source)?.slice(1) ?? [];
  if (parts.length !== 3) {
    throw new Error(
      `REL-04 guard found no ${name} tuple in ${CLI_ENGINE}; the engine-range ` +
        `check did not run. Either the constant was renamed or its declaration ` +
        `is no longer the readonly triple this guard reads.`,
    );
  }
  return parts.join(".");
}

/** FLR-01: the document's stated range must be the code's range. */
function engineRangeViolations(doc: string, floor: string, ceiling: string): string[] {
  return missingStrings(doc, [`>= ${floor}`, `< ${ceiling}`]).map(
    (bound) => `RELEASING.md states no supported-engine bound "${bound}"`,
  );
}

describe("REL-04: RELEASING.md keeps the content an operator needs", () => {
  // Read per case rather than once in the describe body: a missing RELEASING.md
  // must redden these cases, not stop the whole file from collecting and take
  // the unrelated REL-01 and REL-03 blocks down with it.
  const doc = () => readDocument(RELEASING);
  const engineSource = () => readDocument(CLI_ENGINE);

  it("exists and is readable, and reports a missing document rather than passing", () => {
    expect(doc().length).toBeGreaterThan(0);
    expect(() => readDocument(join(REPO_ROOT, "RELEASING-NO-SUCH-FILE.md"))).toThrow();
  });

  it("denies unpublish as a lever, verbatim", () => {
    expect(missingStrings(doc(), [UNPUBLISH_DENIAL])).toEqual([]);
  });

  it("reports a document that dropped the unpublish denial", () => {
    const fixture = "## Rollback\n\nUnpublish the version if it is recent.\n";
    expect(missingStrings(fixture, [UNPUBLISH_DENIAL])).toEqual([UNPUBLISH_DENIAL]);
  });

  it("carries the pending-tag rule verbatim", () => {
    expect(missingStrings(doc(), [PENDING_TAG_RULE])).toEqual([]);
  });

  it("reports a document that softened the pending-tag rule", () => {
    const fixture = "## The recurring release\n\nAvoid concurrent releases where practical.\n";
    expect(missingStrings(fixture, [PENDING_TAG_RULE])).toEqual([PENDING_TAG_RULE]);
  });

  it("names all three levers that do exist", () => {
    expect(missingStrings(doc(), LEVERS)).toEqual([]);
  });

  it("reports a rollback section that lists levers without naming them", () => {
    const fixture = "## Rollback\n\nDeprecate it, re-point the tag, or ship a fix.\n";
    expect(missingStrings(fixture, LEVERS)).toEqual([...LEVERS]);
  });

  it("keeps the bootstrap appendix after the rollback section", () => {
    expect(appendixOrderViolations(doc())).toEqual([]);
  });

  it("reports an appendix promoted above the rollback section", () => {
    const fixture = `${APPENDIX_HEADING}: the one-time bootstrap\n\n${ROLLBACK_HEADING}\n`;
    expect(appendixOrderViolations(fixture)).toHaveLength(1);
  });

  it("throws rather than passing when either heading is absent", () => {
    expect(() => appendixOrderViolations(`${ROLLBACK_HEADING}\n`)).toThrow(/Appendix A/);
    expect(() => appendixOrderViolations(`${APPENDIX_HEADING}\n`)).toThrow(/Rollback/);
  });

  it("states the engine range the code enforces", () => {
    const floor = engineBound(engineSource(), "MIN_VERSION");
    const ceiling = engineBound(engineSource(), "MAX_VERSION_EXCLUSIVE");
    expect(engineRangeViolations(doc(), floor, ceiling)).toEqual([]);
  });

  it("reports a document whose floor disagrees with cli-engine.ts", () => {
    const floor = engineBound(engineSource(), "MIN_VERSION");
    const ceiling = engineBound(engineSource(), "MAX_VERSION_EXCLUSIVE");
    // The floor this repository carried before FLR-01 raised it.
    const fixture = `Supports hwp-cli >= 0.8.8 and < ${ceiling}.\n`;
    expect(engineRangeViolations(fixture, floor, ceiling)).toEqual([
      `RELEASING.md states no supported-engine bound ">= ${floor}"`,
    ]);
  });

  it("reads both bounds out of the source rather than from a literal here", () => {
    expect(engineBound(engineSource(), "MIN_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(engineBound(engineSource(), "MAX_VERSION_EXCLUSIVE")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("throws when the constant it parses is not there to parse", () => {
    expect(() => engineBound("const MIN_VERSION = [0, 16, 0];\n", "MIN_VERSION")).toThrow(
      /did not run/,
    );
  });
});

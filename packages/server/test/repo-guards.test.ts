/**
 * Repository-shape guards for PKG-10 (the e2e job cannot gate a publishing job)
 * and PKG-11 (no esbuild below 0.28.1 is resolved).
 *
 * Placement: both assertions are about the repository, not about
 * `@hwp-editor/server`. They live in this package's suite because
 * `packages/server/test/paths.test.ts` set that precedent for PKG-09, and
 * because `pnpm -r test`, the command `.github/workflows/ci.yml` runs, only
 * reaches tests that sit inside a workspace package. The known cost is that a
 * source-tree consumer running `pnpm --filter @hwp-editor/server test` outside a
 * full checkout fails on a repository fact rather than a server fact. The fix is
 * to move all three guards into a repo-scoped vitest project, which needs edits
 * to the root manifest and to ci.yml.
 *
 * Deliberately NOT wrapped in `describeBin`: neither guard performs a document
 * operation, and both must run on a machine with no hwp-cli install so a
 * contributor's `pnpm -r test` catches the regression rather than only CI.
 *
 * Every check is a pure function over a path, so each one is also pointed at a
 * fixture that violates the property. A guard nobody has watched fail is not yet
 * a guard, and the negative controls keep that proof in the suite rather than in
 * a commit message.
 *
 * Fail-closed, as in `paths.test.ts`: a missing workflow directory, an
 * unparseable workflow, or a lockfile naming no esbuild at all throws. "The
 * guard did not run" is a failure, not a clean tree.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const LOCKFILE = join(REPO_ROOT, "pnpm-lock.yaml");

/** The job id `.github/workflows/e2e.yml` declares, per 05-03-SUMMARY.md. */
const E2E_JOB_ID = "e2e";

/** esbuild floor that clears GHSA-g7r4-m6w7-qqqr. */
const ESBUILD_FLOOR = "0.28.1";

interface WorkflowFile {
  name: string;
  /** Job id in declaration order, mapped to the lines of that job's body. */
  jobs: Map<string, string[]>;
}

/**
 * Job ids declared by one workflow file.
 *
 * A line-based read rather than a YAML parse: neither this package nor the
 * repository depends on a YAML library, and the shape needed here is narrow.
 * GitHub Actions requires `jobs:` as a top-level key with each job id one level
 * under it, and both workflows in this repository use two-space indentation. A
 * comment cannot be mistaken for a job id, because `#` is not a legal first
 * character of one.
 */
function parseJobs(text: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let inJobs = false;
  let body: string[] | undefined;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    // Any further top-level key closes the jobs block.
    if (/^\S/.test(line)) break;
    const declaration = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    const id = declaration?.[1];
    if (id !== undefined) {
      body = [];
      jobs.set(id, body);
      continue;
    }
    body?.push(line);
  }
  return jobs;
}

function readWorkflows(dir: string): WorkflowFile[] {
  // readdirSync throws on a missing directory, which is the intended failure.
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  if (names.length === 0) {
    throw new Error(
      `PKG-10 guard found no workflow file in ${dir}; the guard did not run.`,
    );
  }
  return names.map((name) => {
    const jobs = parseJobs(readFileSync(join(dir, name), "utf8"));
    if (jobs.size === 0) {
      throw new Error(
        `PKG-10 guard parsed no job out of ${name}; either the file declares ` +
          `none or its indentation is no longer the two-space form this guard reads.`,
      );
    }
    return { name, jobs };
  });
}

/**
 * Why aloneness is the whole check: Actions' `needs:` key resolves only within
 * one workflow file, so a job that is the sole job in its file is structurally
 * unreachable by any `needs:` edge. Merging the two workflows is therefore the
 * only in-repo way to make a `needs: e2e` edge expressible, and this catches it.
 * A required-check ruleset can still gate on the e2e check, but that state lives
 * in GitHub rather than in the tree and cannot be asserted here.
 */
function e2eGatingViolations(dir: string): string[] {
  const workflows = readWorkflows(dir);
  const hosts = workflows.filter((workflow) => workflow.jobs.has(E2E_JOB_ID));
  const host = hosts.length === 1 ? hosts[0] : undefined;
  if (host === undefined) {
    const found = hosts.map((workflow) => workflow.name).join(", ") || "none";
    return [
      `expected exactly one workflow file to declare a job id "${E2E_JOB_ID}", ` +
        `found ${hosts.length} (${found})`,
    ];
  }

  const violations: string[] = [];
  const others = [...host.jobs.keys()].filter((id) => id !== E2E_JOB_ID);
  if (others.length > 0) {
    violations.push(
      `${host.name} declares "${E2E_JOB_ID}" alongside ${others.join(", ")}; ` +
        `a job in the same workflow file can carry a needs: edge to it, so the ` +
        `e2e job would become able to gate a publishing job`,
    );
  }
  const body = host.jobs.get(E2E_JOB_ID) ?? [];
  if (!body.some((line) => /^ {4}continue-on-error:\s*true\s*$/.test(line))) {
    violations.push(
      `${host.name} job "${E2E_JOB_ID}" does not carry continue-on-error: true, ` +
        `so a red e2e run reddens the pull request`,
    );
  }
  return violations;
}

/**
 * Every esbuild resolution the lockfile records, including the `@esbuild/*`
 * platform packages, which move in lockstep with the main one. The lockfile
 * writes them as `esbuild@0.28.2:` and `'@esbuild/linux-x64@0.28.2':`; the range
 * forms (`esbuild: ^0.28.2`) carry no `@` and are deliberately not matched,
 * because a range is a request and this asserts on the resolution.
 *
 * The prerelease tail is captured rather than discarded. A pattern ending at
 * the patch digit reads `esbuild@0.28.1-beta.1` as `0.28.1`, which compares
 * EQUAL to the floor and lets a prerelease of the fixed release through the
 * advisory gate - a build that predates the fix passing a check that exists to
 * demand it.
 */
const ESBUILD_SPEC =
  /(?<![\w.-])(?:@esbuild\/[a-z0-9-]+|esbuild)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;

/**
 * Semver precedence, narrowed to what this guard needs: the numeric triple,
 * then the rule that a prerelease sorts BELOW the release it leads to
 * (semver.org #9). The floor is always a plain release here, so comparing
 * prerelease identifiers against each other is never required - only
 * recognising that `0.28.1-beta.1` is not `0.28.1`.
 */
function isBelow(version: string, floor: string): boolean {
  const [versionCore = "", versionPre] = splitPrerelease(version);
  const [floorCore = "", floorPre] = splitPrerelease(floor);
  const left = versionCore.split(".").map(Number);
  const right = floorCore.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a < b;
  }
  return versionPre !== undefined && floorPre === undefined;
}

/** Split `1.2.3-beta.1` into its core and its prerelease tail. */
function splitPrerelease(version: string): [string, string | undefined] {
  const dash = version.indexOf("-");
  if (dash < 0) return [version, undefined];
  return [version.slice(0, dash), version.slice(dash + 1)];
}

function esbuildFloorViolations(lockfilePath: string): string[] {
  // readFileSync throws on a missing lockfile, which is the intended failure.
  const lines = readFileSync(lockfilePath, "utf8").split("\n");
  const violations: string[] = [];
  let seen = 0;
  lines.forEach((line, index) => {
    for (const match of line.matchAll(ESBUILD_SPEC)) {
      const version = match[1];
      if (version === undefined) continue;
      seen += 1;
      if (isBelow(version, ESBUILD_FLOOR)) {
        violations.push(`${lockfilePath}:${index + 1}: ${line.trim()}`);
      }
    }
  });
  if (seen === 0) {
    throw new Error(
      `PKG-11 guard found no esbuild resolution in ${lockfilePath}; the guard ` +
        `did not run. esbuild is a tsup dependency of all three packages, so an ` +
        `absent one means the wrong file was read or the lockfile format moved.`,
    );
  }
  return violations;
}

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hwped-repo-guard-"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const E2E_ALONE = `name: e2e (non-required)
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v5
`;

const CI_TWO_JOBS = `name: ci
on: [pull_request]
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
`;

describe("PKG-10: the e2e job never gates a publishing job", () => {
  it("keeps the e2e job alone in its workflow file and tolerant of failure", () => {
    const violations = e2eGatingViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `the e2e job can now gate a publishing job:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation when the two workflows are merged into one file", () => {
    const merged = CI_TWO_JOBS.replace(
      "  package:",
      "  e2e:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n  package:",
    );
    const violations = e2eGatingViolations(fixtureDir({ "ci.yml": merged }));
    expect(violations.join("\n")).toContain("needs: edge");
  });

  it("reports a violation when the e2e job loses continue-on-error", () => {
    const gating = E2E_ALONE.replace("    continue-on-error: true\n", "");
    const violations = e2eGatingViolations(
      fixtureDir({ "ci.yml": CI_TWO_JOBS, "e2e.yml": gating }),
    );
    expect(violations.join("\n")).toContain("continue-on-error: true");
  });

  it("fails rather than passing when no workflow file can be read", () => {
    expect(() => e2eGatingViolations(fixtureDir({ "README.md": "not a workflow" })))
      .toThrow(/the guard did not run/);
  });
});

describe("PKG-11: no esbuild below the advisory floor is resolved", () => {
  it("records no esbuild below 0.28.1 in the lockfile", () => {
    const violations = esbuildFloorViolations(LOCKFILE);
    expect(
      violations,
      `pnpm-lock.yaml resolves esbuild below ${ESBUILD_FLOOR}, reopening ` +
        `GHSA-g7r4-m6w7-qqqr:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation for a lockfile carrying a pre-floor resolution", () => {
    const planted = readFileSync(LOCKFILE, "utf8").replace(
      "  esbuild@0.28.2:",
      "  esbuild@0.27.7:",
    );
    const dir = fixtureDir({ "pnpm-lock.yaml": planted });
    const violations = esbuildFloorViolations(join(dir, "pnpm-lock.yaml"));
    expect(violations.join("\n")).toContain("esbuild@0.27.7");
  });

  it("reports a violation for a pre-floor platform package too", () => {
    const dir = fixtureDir({
      "pnpm-lock.yaml": "packages:\n  '@esbuild/linux-x64@0.27.7':\n    resolution: {}\n",
    });
    const violations = esbuildFloorViolations(join(dir, "pnpm-lock.yaml"));
    expect(violations.join("\n")).toContain("@esbuild/linux-x64@0.27.7");
  });

  it("reports a violation for a prerelease of the floor release", () => {
    // The case a patch-digit-only pattern misses: `0.28.1-beta.1` truncates to
    // `0.28.1`, compares equal to the floor and passes, so a build predating
    // the advisory fix clears the gate that exists to demand it.
    const dir = fixtureDir({
      "pnpm-lock.yaml": "packages:\n  esbuild@0.28.1-beta.1:\n    resolution: {}\n",
    });
    const violations = esbuildFloorViolations(join(dir, "pnpm-lock.yaml"));
    expect(violations.join("\n")).toContain("esbuild@0.28.1-beta.1");
  });

  it("accepts the floor release itself, so the prerelease rule is not overbroad", () => {
    const dir = fixtureDir({
      "pnpm-lock.yaml": "packages:\n  esbuild@0.28.1:\n    resolution: {}\n",
    });
    expect(esbuildFloorViolations(join(dir, "pnpm-lock.yaml"))).toEqual([]);
  });

  it("fails rather than passing when the lockfile names no esbuild", () => {
    const dir = fixtureDir({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect(() => esbuildFloorViolations(join(dir, "pnpm-lock.yaml"))).toThrow(
      /the guard did not run/,
    );
  });
});

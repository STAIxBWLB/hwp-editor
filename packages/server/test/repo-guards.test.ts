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

/**
 * The deployment environment `.github/workflows/release.yml`'s publish job
 * targets, and the environment name recorded in the npm trusted-publisher
 * configuration of all three packages (D-07). The two are one binding. If it is
 * ever changed deliberately, this constant and the three publisher
 * configurations on npmjs.com move together.
 */
const PUBLISH_ENVIRONMENT = "npm-publish";

/** The job id in `.github/workflows/release.yml` that runs D-08's comparison. */
const VERIFY_JOB_ID = "verify";

/** The script D-08's tag/manifest comparison lives in. */
const CHECK_PUBLISHABLE = "scripts/check-publishable.mjs";

/** esbuild floor that clears GHSA-g7r4-m6w7-qqqr. */
const ESBUILD_FLOOR = "0.28.1";

interface WorkflowFile {
  name: string;
  /** Job id in declaration order, mapped to the lines of that job's body. */
  jobs: Map<string, string[]>;
  /** Every line of the file, comments included. Strip with `withoutComments`. */
  lines: string[];
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
    const text = readFileSync(join(dir, name), "utf8");
    const jobs = parseJobs(text);
    if (jobs.size === 0) {
      throw new Error(
        `PKG-10 guard parsed no job out of ${name}; either the file declares ` +
          `none or its indentation is no longer the two-space form this guard reads.`,
      );
    }
    return { name, jobs, lines: text.split("\n") };
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

/**
 * Lines with whole-line comments removed.
 *
 * Load-bearing, not tidiness. This repository's convention is that workflow
 * comments carry the decision record, so every string the REL-02 checks below
 * forbid is ALSO explained in prose in the file it is forbidden from -
 * `.github/workflows/release.yml`'s header states at length why it passes no
 * registry input to `actions/setup-node` and why it references no secret.
 * Matching raw text would let a file's own explanation of why it avoids a thing
 * satisfy the check that it avoids that thing. A guard a file's own explanation
 * can defeat is worse than no guard, because it reads as coverage.
 */
function withoutComments(lines: string[]): string[] {
  return lines.filter((line) => !/^\s*#/.test(line));
}

/** `id-token: write`, wherever a job's permissions block puts it. */
const OIDC_SCOPE = /^\s+id-token:\s*write\s*$/;

/** `contents: write`, likewise. */
const CONTENTS_WRITE_SCOPE = /^\s+contents:\s*write\s*$/;

/**
 * REL-02 check 1: no workflow passes a registry input to `actions/setup-node`.
 */
function registryInputViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const workflow of readWorkflows(dir)) {
    for (const line of withoutComments(workflow.lines)) {
      if (!/^\s*registry-url\s*:/.test(line)) continue;
      violations.push(
        `${workflow.name} passes ${line.trim()} to actions/setup-node; the action ` +
          `then writes an _authToken line into the runner's .npmrc, and with no ` +
          `token configured - the intended state under trusted publishing - the ` +
          `value substitutes to empty. The npm CLI reads the presence of that ` +
          `line as "auth is configured", never starts the OIDC exchange, and the ` +
          `publish fails with a bare 404`,
      );
    }
  }
  return violations;
}

/**
 * REL-02 check 2: no workflow references a repository secret.
 */
function storedCredentialViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const workflow of readWorkflows(dir)) {
    for (const line of withoutComments(workflow.lines)) {
      if (!/secrets\./.test(line)) continue;
      violations.push(
        `${workflow.name} reads ${line.trim()}; REL-02's whole content is that no ` +
          `stored credential exists, and the only credential on the release path ` +
          `is the ephemeral OIDC token minted per run. The likeliest innocent ` +
          `trip is the automatic GITHUB_TOKEN reached as secrets.GITHUB_TOKEN - ` +
          `that one is not a stored credential and is not what REL-02 forbids, ` +
          `but release.yml reaches it through the workflow-token expression ` +
          `(github.token) instead, so this check stays a flat prohibition. Use ` +
          `that spelling rather than relaxing this guard`,
      );
    }
  }
  return violations;
}

/**
 * The environment a job targets, read only in the scalar form
 * (`    environment: npm-publish`). The mapping form is deliberately unread: a
 * shape change there reports a violation rather than passing silently, which is
 * the safe direction for a value whose other half lives on npmjs.com.
 */
function environmentName(body: string[]): string | undefined {
  for (const line of body) {
    const scalar = /^ {4}environment:\s*(\S+)\s*$/.exec(line);
    if (scalar?.[1] !== undefined) return scalar[1];
  }
  return undefined;
}

/**
 * REL-02 check 3: the OIDC scope and the deployment environment are one
 * binding, and the environment is named exactly `npm-publish`.
 */
function oidcEnvironmentViolations(dir: string): string[] {
  const violations: string[] = [];
  let oidcJobs = 0;
  const coupling =
    `the two are one binding, not two settings: a job that targets an ` +
    `environment gets an OIDC subject claim of the form ` +
    `repo:<owner>/<repo>:environment:<name>, which does not match a publisher ` +
    `configured without one, so dropping either side breaks the exchange ` +
    `rather than loosening it`;
  for (const workflow of readWorkflows(dir)) {
    for (const [id, rawBody] of workflow.jobs) {
      const body = withoutComments(rawBody);
      const grantsOidc = body.some((line) => OIDC_SCOPE.test(line));
      const environment = environmentName(body);
      if (grantsOidc) oidcJobs += 1;
      if (grantsOidc && environment === undefined) {
        violations.push(
          `${workflow.name} job "${id}" grants id-token: write but targets no ` +
            `environment; ${coupling}`,
        );
      }
      if (!grantsOidc && environment !== undefined) {
        violations.push(
          `${workflow.name} job "${id}" targets environment "${environment}" but ` +
            `grants no id-token: write; ${coupling}`,
        );
      }
      if (grantsOidc && environment !== undefined && environment !== PUBLISH_ENVIRONMENT) {
        violations.push(
          `${workflow.name} job "${id}" targets environment "${environment}", not ` +
            `"${PUBLISH_ENVIRONMENT}". The literal name matters as much as the ` +
            `coupling, because the other half of the binding lives on npmjs.com ` +
            `where no repository test can see it: renaming the environment on ` +
            `this side alone leaves this guard passing and the first publish ` +
            `failing with a bare 404`,
        );
      }
    }
  }
  if (oidcJobs === 0) {
    throw new Error(
      `REL-02 guard found no job granting id-token: write in ${dir}; the guard ` +
        `did not run. It verifies a coupling, so an absent OIDC scope means it ` +
        `verified nothing rather than that the coupling holds.`,
    );
  }
  return violations;
}

/**
 * REL-02 check 4: no job holds both the repository write scope and the OIDC
 * write scope.
 */
function writeScopeViolations(dir: string): string[] {
  const violations: string[] = [];
  let writeJobs = 0;
  for (const workflow of readWorkflows(dir)) {
    for (const [id, rawBody] of workflow.jobs) {
      const body = withoutComments(rawBody);
      const grantsContentsWrite = body.some((line) => CONTENTS_WRITE_SCOPE.test(line));
      if (grantsContentsWrite) writeJobs += 1;
      if (!grantsContentsWrite) continue;
      if (!body.some((line) => OIDC_SCOPE.test(line))) continue;
      violations.push(
        `${workflow.name} job "${id}" grants both contents: write and ` +
          `id-token: write; D-16 scopes the write to the job that creates the ` +
          `GitHub Release precisely so the job that runs npm publish cannot ` +
          `write to this repository`,
      );
    }
  }
  if (writeJobs === 0) {
    throw new Error(
      `REL-02 guard found no job granting contents: write in ${dir}; the guard ` +
        `did not run. It verifies a separation, so with no write scope anywhere ` +
        `there is nothing to separate.`,
    );
  }
  return violations;
}

/**
 * A job body split into its step blocks. A step opens at `      - ` and runs
 * until the next one or until a job-level key (four spaces or fewer) closes it;
 * a step's own continuation lines are indented deeper than its dash. This is
 * what makes an `env:` hoisted to job level land in no step block at all, which
 * is the distinction check 5 exists to draw.
 */
function stepBlocks(body: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of body) {
    if (/^ {6}- /.test(line)) {
      current = [line];
      blocks.push(current);
      continue;
    }
    if (/^ {0,4}\S/.test(line)) {
      current = undefined;
      continue;
    }
    current?.push(line);
  }
  return blocks;
}

/**
 * REL-02 check 5: the verify job sets EXPECTED_VERSION on the step that runs
 * `check-publishable.mjs`, not merely somewhere in the job.
 */
function expectedVersionViolations(dir: string): string[] {
  const hosts = readWorkflows(dir).filter((workflow) => workflow.jobs.has(VERIFY_JOB_ID));
  const host = hosts.length === 1 ? hosts[0] : undefined;
  if (host === undefined) {
    const found = hosts.map((workflow) => workflow.name).join(", ") || "none";
    throw new Error(
      `REL-02 guard expected exactly one workflow file to declare a job id ` +
        `"${VERIFY_JOB_ID}", found ${hosts.length} (${found}); the guard did not run.`,
    );
  }
  const body = withoutComments(host.jobs.get(VERIFY_JOB_ID) ?? []);
  const steps = stepBlocks(body).filter((step) =>
    step.some((line) => line.includes(CHECK_PUBLISHABLE)),
  );
  if (steps.length === 0) {
    throw new Error(
      `REL-02 guard found no step running ${CHECK_PUBLISHABLE} in ${host.name} ` +
        `job "${VERIFY_JOB_ID}"; the guard did not run.`,
    );
  }
  const violations: string[] = [];
  for (const step of steps) {
    const declaresStepEnv = step.some((line) => /^ {8}env:\s*$/.test(line));
    const namesVariable = step.some((line) => /^ {10}EXPECTED_VERSION:\s*\S/.test(line));
    if (declaresStepEnv && namesVariable) continue;
    violations.push(
      `${host.name} job "${VERIFY_JOB_ID}" runs ${CHECK_PUBLISHABLE} without an ` +
        `env: mapping naming EXPECTED_VERSION in that step's own block. The ` +
        `script skips its comparison when the variable is absent or empty, by ` +
        `design, so that ci.yml's pull-request job stays green with no tag in ` +
        `scope - and that same silence means a misspelling, a deletion, or an ` +
        `env hoisted to job level disables D-08's tag/manifest comparison while ` +
        `verify still reports success. It is the only pre-publish gate on an ` +
        `irreversible path, and the one property here that fails open`,
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

/** The shape of `.github/workflows/release.yml`, reduced to what REL-02 reads. */
const RELEASE_THREE_JOBS = `name: release
on:
  push:
    tags:
      - "v*.*.*"
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Tag and manifests agree
        env:
          EXPECTED_VERSION: \${{ github.ref_name }}
        run: node scripts/check-publishable.mjs
  publish:
    needs: verify
    runs-on: ubuntu-latest
    environment: npm-publish
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v5
  release-notes:
    needs: publish
    runs-on: ubuntu-latest
    permissions:
      contents: write
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

/**
 * Five properties of `.github/workflows/release.yml` that no other test can
 * notice, because each of them fails for the first time at publish time - on an
 * irreversible path, against a version number that is permanently spent whether
 * the publish succeeds or not.
 */
describe("REL-02: the release path carries no stored credential", () => {
  it("passes no registry input to actions/setup-node in any workflow", () => {
    const violations = registryInputViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `a workflow now disables the OIDC exchange:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation for a workflow carrying a registry input", () => {
    const planted = CI_TWO_JOBS.replace(
      "  package:",
      "      - uses: actions/setup-node@v5\n" +
        "        with:\n" +
        "          registry-url: https://registry.npmjs.org\n" +
        "  package:",
    );
    const violations = registryInputViolations(fixtureDir({ "ci.yml": planted }));
    expect(violations.join("\n")).toContain("never starts the OIDC exchange");
  });

  it("references no repository secret in any workflow", () => {
    const violations = storedCredentialViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `a workflow now reads a stored credential:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation for a workflow reading a secret", () => {
    const planted = CI_TWO_JOBS.replace(
      "  package:",
      "      - run: npm publish\n" +
        "        env:\n" +
        "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n" +
        "  package:",
    );
    const violations = storedCredentialViolations(fixtureDir({ "ci.yml": planted }));
    expect(violations.join("\n")).toContain("no stored credential exists");
  });

  it("couples the OIDC scope to the npm-publish environment", () => {
    const violations = oidcEnvironmentViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `the OIDC/environment binding no longer holds:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation when a job grants the OIDC scope with no environment", () => {
    const planted = RELEASE_THREE_JOBS.replace("    environment: npm-publish\n", "");
    const violations = oidcEnvironmentViolations(
      fixtureDir({ "release.yml": planted }),
    );
    expect(violations.join("\n")).toContain("targets no environment");
  });

  it("reports a violation when the environment is renamed on this side only", () => {
    // The rename that a coupling-only check waves through: both halves are
    // present, so the binding "looks" intact, and the first publish 404s
    // because the publisher on npmjs.com still expects the old name.
    const planted = RELEASE_THREE_JOBS.replace(
      "    environment: npm-publish\n",
      "    environment: npm-release\n",
    );
    const violations = oidcEnvironmentViolations(
      fixtureDir({ "release.yml": planted }),
    );
    expect(violations.join("\n")).toContain(`not "${PUBLISH_ENVIRONMENT}"`);
  });

  it("keeps the repository write scope off the publishing job", () => {
    const violations = writeScopeViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `a publishing job can now write to this repository:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation when one job holds both write scopes", () => {
    const planted = RELEASE_THREE_JOBS.replace(
      "      contents: read\n      id-token: write\n",
      "      contents: write\n      id-token: write\n",
    );
    const violations = writeScopeViolations(fixtureDir({ "release.yml": planted }));
    expect(violations.join("\n")).toContain("both contents: write and id-token: write");
  });

  it("sets EXPECTED_VERSION on the step that runs check-publishable.mjs", () => {
    const violations = expectedVersionViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `D-08's tag comparison is no longer wired:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation when the step carries no env at all", () => {
    const planted = RELEASE_THREE_JOBS.replace(
      "        env:\n          EXPECTED_VERSION: ${{ github.ref_name }}\n",
      "",
    );
    const violations = expectedVersionViolations(
      fixtureDir({ "release.yml": planted }),
    );
    expect(violations.join("\n")).toContain("EXPECTED_VERSION");
  });

  it("reports a violation when the env is hoisted to job level", () => {
    // Hoisting reads as a tidy-up and disables D-08 exactly as a deletion does:
    // a job-level env is not the step's env, and the script's silence on an
    // absent variable is identical either way.
    const planted = RELEASE_THREE_JOBS.replace(
      "        env:\n          EXPECTED_VERSION: ${{ github.ref_name }}\n",
      "",
    ).replace(
      "  verify:\n    runs-on: ubuntu-latest\n",
      "  verify:\n    runs-on: ubuntu-latest\n    env:\n      EXPECTED_VERSION: ${{ github.ref_name }}\n",
    );
    const violations = expectedVersionViolations(
      fixtureDir({ "release.yml": planted }),
    );
    expect(violations.join("\n")).toContain("that step's own block");
  });
});

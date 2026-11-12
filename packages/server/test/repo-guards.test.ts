/**
 * Repository-shape guards for PKG-10 (the e2e job cannot gate a publishing job)
 * and PKG-11 (no esbuild below 0.28.1 is resolved), plus the engine asset the
 * two advisory jobs install (#121).
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

import { spawnSync } from "node:child_process";
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
const PUBLISH_JOB_ID = "publish";

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
    // A CRLF file is a workflow Actions accepts. Splitting on "\n" alone leaves
    // a trailing "\r" on every line, which any pattern ending in `.` cannot
    // match - so every line of such a file would be skipped rather than read.
    return { name, jobs, lines: text.split(/\r?\n/) };
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
  return violations;
}

/**
 * The two workflows that provision the engine binary themselves. They are the
 * only automated evidence that this repository runs against the renamed `ahwp`
 * command without the 1.x `hwp` name or the legacy `hwp-` asset (#121).
 */
const ENGINE_ASSET_WORKFLOWS = ["e2e.yml", "font-less-render.yml"];

/**
 * #121: both jobs download the `ahwp-<tag>-<target>` archive, install only its
 * `ahwp` member and leave HWP_EDITOR_BIN unset, so what they exercise is the
 * engine's own default resolution. A step that reached for the legacy `hwp-`
 * asset, pinned HWP_EDITOR_BIN to a `hwp` path, or called `./hwp`, would keep
 * both jobs green while proving the opposite of what they exist for - and
 * nothing else in the suite can see it, because the workflows only run on
 * GitHub.
 *
 * Two details that keep the check honest rather than approximate. Comment lines
 * are skipped, not stripped: both files name the legacy asset in prose on
 * purpose, so a file's own account of what it avoids must not read as the
 * avoidance, while the reported line number still has to be the file's own.
 * And the tag has two spellings, `$HWP_CLI_TAG` and `${HWP_CLI_TAG}`, which YAML
 * treats alike, so the asset pattern takes both.
 */
const LEGACY_ASSET = /(?:^|[^A-Za-z0-9_-])hwp-\$(?:\{HWP_CLI_TAG\}|HWP_CLI_TAG)/;
const LEGACY_EDITOR_BIN = /\bHWP_EDITOR_BIN=\S*[/\\]hwp(?=[\s"']|$)/;
/** The compatibility binary called by relative path, e.g. `./hwp render`. */
const LEGACY_CALL = /(?:^|[\s"';&|])\.\/hwp(?=[\s;&|"']|$)/;

function engineAssetViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const name of ENGINE_ASSET_WORKFLOWS) {
    // readFileSync throws on a missing or renamed workflow, which is the
    // intended failure: the guard did not run.
    const text = readFileSync(join(dir, name), "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      const at = `${name}:${index + 1}`;
      if (LEGACY_ASSET.test(line)) {
        violations.push(
          `${at}: fetches the legacy \`hwp-\` asset (${line.trim()}); ` +
            `#121 installs the \`ahwp-\` archive so a call to the 1.x name fails here`,
        );
      }
      if (LEGACY_EDITOR_BIN.test(line)) {
        violations.push(
          `${at}: points HWP_EDITOR_BIN at a \`hwp\` binary ` +
            `(${line.trim()}); the directory on PATH is what exercises the default`,
        );
      }
      if (LEGACY_CALL.test(line)) {
        violations.push(
          `${at}: calls the 1.x \`hwp\` binary (${line.trim()}); ` +
            `install only \`ahwp\` and call that`,
        );
      }
    });
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
 * The one stored credential REL-02 tolerates (#38): the npm token that moves
 * `next` after a stable release, in release.yml only. Matched as a whole line
 * so no other secret, and no other variable name for this one, gets through.
 */
const DIST_TAG_TOKEN_LINE =
  /^\s*NPM_DIST_TAG_TOKEN: \$\{\{ secrets\.NPM_DIST_TAG_TOKEN \}\}\s*$/;

/**
 * REL-02 check 2: no workflow references a repository secret, except the one
 * DIST_TAG_TOKEN_LINE in release.yml.
 */
function storedCredentialViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const workflow of readWorkflows(dir)) {
    for (const line of withoutComments(workflow.lines)) {
      if (!/secrets\./.test(line)) continue;
      if (workflow.name === "release.yml" && DIST_TAG_TOKEN_LINE.test(line)) continue;
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
 * REL-02 check 3 (#38): the tolerated token is read once, after every publish,
 * and never under the name npm itself consumes. Publishing must see no token at
 * all, or npm skips the OIDC exchange (release.yml header point 3).
 */
function distTagTokenPlacementViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const workflow of readWorkflows(dir)) {
    const lines = withoutComments(workflow.lines);
    if (lines.some((line) => /NODE_AUTH_TOKEN/.test(line))) {
      violations.push(
        `${workflow.name} sets NODE_AUTH_TOKEN; npm would then treat credentials ` +
          `as configured and never start the OIDC exchange a publish needs`,
      );
    }
    const uses = lines.flatMap((line, i) => (DIST_TAG_TOKEN_LINE.test(line) ? [i] : []));
    if (uses.length === 0) continue;
    if (workflow.name !== "release.yml" || uses.length > 1) {
      violations.push(
        `${workflow.name} reads NPM_DIST_TAG_TOKEN ${uses.length} time(s); it belongs ` +
          `to exactly one step of release.yml`,
      );
      continue;
    }
    const lastPublish = lines.reduce(
      (last, line, i) => (/publish_package\s/.test(line) ? i : last),
      -1,
    );
    if (lastPublish < 0 || uses[0]! < lastPublish) {
      violations.push(
        `release.yml reads NPM_DIST_TAG_TOKEN before the last publish_package; a ` +
          `publish step must run with no token in reach`,
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
 * The one value `EXPECTED_VERSION` may carry, matched exactly.
 *
 * An exact match rather than "names the variable non-empty", because the
 * variable's mere presence proves nothing: `check-publishable.mjs` skips its
 * comparison on an EMPTY value as well as an absent one, and there are two
 * quiet spellings that render empty. `EXPECTED_VERSION: ""` satisfies any
 * is-non-blank pattern, since the quote character is itself non-whitespace. And
 * `${{ env.WHATEVER }}` for a variable that is not set renders as the empty
 * string, so a plausible-looking indirection through a job-level `env` that
 * someone later renamed disables D-08 while reading as tidier than the
 * original. Only `github.ref_name` is guaranteed to be populated on the tag
 * push that is this workflow's sole trigger, so it is the only value that
 * cannot fail open, and it is what this guard demands.
 */
const EXPECTED_VERSION_VALUE = "${{ github.ref_name }}";

/**
 * The value on a step's own `EXPECTED_VERSION:` line, with surrounding quotes
 * stripped so the legal YAML spellings of one string compare equal.
 */
function expectedVersionValue(step: string[]): string | undefined {
  for (const line of step) {
    const match = /^ {10}EXPECTED_VERSION:(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    return match[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return undefined;
}

/**
 * REL-02 check 5: the verify job sets EXPECTED_VERSION on the step that runs
 * `check-publishable.mjs`, to a value that cannot render empty.
 */
/**
 * A workflow that can publish must serialize across ALL release tags, not per
 * ref. A per-tag concurrency group lets two releases overlap, and the approval
 * gate (D-07) makes that ordinary: v1.0.0 can wait for a reviewer while v1.0.1
 * is pushed and approved first, so the older run finishes last and its
 * `npm publish --tag latest` moves `latest` backward. The failure is invisible
 * until two tags are in flight, which is why it needs a standing assertion.
 */
function releaseConcurrencyViolations(dir: string): string[] {
  const hosts = readWorkflows(dir).filter((workflow) => workflow.jobs.has(PUBLISH_JOB_ID));
  const violations: string[] = [];
  for (const host of hosts) {
    const group = withoutComments(host.lines).find((line) =>
      /^\s*group:/.test(line),
    );
    if (group === undefined) {
      violations.push(`${host.name}: declares job "${PUBLISH_JOB_ID}" with no concurrency group`);
      continue;
    }
    if (/\$\{\{/.test(group)) {
      violations.push(
        `${host.name}: concurrency group is expression-keyed (${group.trim()}), so distinct ` +
          `tags get distinct groups and two releases can interleave`,
      );
    }
  }
  if (hosts.length === 0) {
    throw new Error(
      `REL-02 guard found no workflow declaring a job id "${PUBLISH_JOB_ID}"; the guard did not run.`,
    );
  }
  return violations;
}

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
    const value = expectedVersionValue(step);
    if (declaresStepEnv && value === EXPECTED_VERSION_VALUE) continue;
    violations.push(
      `${host.name} job "${VERIFY_JOB_ID}" runs ${CHECK_PUBLISHABLE} without an ` +
        `env: mapping setting EXPECTED_VERSION to ${EXPECTED_VERSION_VALUE} in ` +
        `that step's own block; found ${JSON.stringify(value)}. The script skips ` +
        `its comparison when the variable is absent OR EMPTY, by design, so that ` +
        `ci.yml's pull-request job stays green with no tag in scope - and that ` +
        `same silence means a misspelling, a deletion, an env hoisted to job ` +
        `level, or a value that renders empty disables D-08's tag/manifest ` +
        `comparison while verify still reports success. It is the only ` +
        `pre-publish gate on an irreversible path, and the one property here ` +
        `that fails open`,
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

/**
 * The two shipped engine-provisioning workflows copied into a temp dir with one
 * of them edited. Reading the real files rather than a hand-written fixture
 * keeps each negative control on the shape the repository actually has.
 */
function plantedEngineWorkflows(name: string, edit: (text: string) => string): string {
  const files: Record<string, string> = {};
  for (const workflow of ENGINE_ASSET_WORKFLOWS) {
    files[workflow] = readFileSync(join(WORKFLOWS_DIR, workflow), "utf8");
  }
  const target = files[name];
  if (target === undefined) throw new Error(`no workflow named ${name}`);
  files[name] = edit(target);
  return fixtureDir(files);
}

const E2E_ALONE = `name: e2e (non-required)
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
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
  it("keeps the e2e job alone in its workflow file", () => {
    const violations = e2eGatingViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `the e2e job can now gate a publishing job:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation when the two workflows are merged into one file", () => {
    const merged = CI_TWO_JOBS.replace(
      "  package:",
      "  e2e:\n    runs-on: ubuntu-latest\n  package:",
    );
    const violations = e2eGatingViolations(fixtureDir({ "ci.yml": merged }));
    expect(violations.join("\n")).toContain("needs: edge");
  });

  it("accepts a separate e2e workflow with visible failures", () => {
    expect(e2eGatingViolations(
      fixtureDir({ "ci.yml": CI_TWO_JOBS, "e2e.yml": E2E_ALONE }),
    )).toEqual([]);
  });

  it("fails rather than passing when no workflow file can be read", () => {
    expect(() => e2eGatingViolations(fixtureDir({ "README.md": "not a workflow" })))
      .toThrow(/the guard did not run/);
  });
});

/**
 * #121's CI half: the only two jobs that provision the engine must prove this
 * repository needs neither the legacy `hwp-` asset nor the `hwp` command name.
 * Both claims are invisible to every other test here, because the workflows run
 * on GitHub and a step that quietly reverted to the legacy pair would stay
 * green.
 */
describe("the advisory jobs install only the ahwp engine asset (#121)", () => {
  it("fetches the ahwp asset and points no HWP_EDITOR_BIN at a hwp binary", () => {
    const violations = engineAssetViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `an advisory job still depends on the 1.x name:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a job that downloads the legacy hwp- asset", () => {
    const dir = plantedEngineWorkflows("e2e.yml", (text) =>
      text.replace('asset="ahwp-$HWP_CLI_TAG', 'asset="hwp-$HWP_CLI_TAG'));
    expect(engineAssetViolations(dir).join("\n")).toContain("hwp-$HWP_CLI_TAG");
  });

  it("reports the braced spelling of the legacy asset too", () => {
    const dir = plantedEngineWorkflows("e2e.yml", (text) =>
      text.replace('asset="ahwp-$HWP_CLI_TAG', 'asset="hwp-${HWP_CLI_TAG}'));
    expect(engineAssetViolations(dir).join("\n")).toContain("hwp-${HWP_CLI_TAG}");
  });

  it("reports a job that points HWP_EDITOR_BIN at a hwp binary", () => {
    const dir = plantedEngineWorkflows("font-less-render.yml", (text) =>
      text.replace(
        'echo "$PWD" >> "$GITHUB_PATH"',
        'echo "HWP_EDITOR_BIN=$PWD/hwp" >> "$GITHUB_ENV"',
      ));
    expect(engineAssetViolations(dir).join("\n")).toContain("points HWP_EDITOR_BIN");
  });

  it("reports a job that calls the 1.x binary by relative path", () => {
    const dir = plantedEngineWorkflows("font-less-render.yml", (text) =>
      text.replace("./ahwp render", "./hwp render"));
    expect(engineAssetViolations(dir).join("\n")).toContain("calls the 1.x `hwp` binary");
  });

  it("does not read the files' own account of the legacy names, and reports the file's own line", () => {
    // The comment inserted at the first `#` pushes every later line down by
    // one: a number counted after comment lines are removed would point at a
    // different line than the one the reader opens.
    const dir = plantedEngineWorkflows("font-less-render.yml", (text) =>
      text
        .replace("#", "# the legacy hwp-$HWP_CLI_TAG asset is deliberately not fetched\n#")
        .replace(
          'echo "$PWD" >> "$GITHUB_PATH"',
          'echo "HWP_EDITOR_BIN=$PWD/hwp" >> "$GITHUB_ENV"',
        ));
    const lines = readFileSync(join(dir, "font-less-render.yml"), "utf8").split(/\r?\n/);
    const planted = lines.findIndex((line) => line.includes("HWP_EDITOR_BIN=$PWD/hwp")) + 1;
    const violations = engineAssetViolations(dir);
    // Exactly one: the comment naming the legacy asset is not a violation.
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`font-less-render.yml:${planted}:`);
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
  it("serializes releases across every tag, not per ref", () => {
    const violations = releaseConcurrencyViolations(WORKFLOWS_DIR);
    expect(
      violations,
      `two release tags could publish concurrently:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("reports a violation for a concurrency group keyed on the ref", () => {
    const dir = fixtureDir({
      "release.yml":
        "concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false\n" +
        "jobs:\n  publish:\n    runs-on: ubuntu-latest\n",
    });
    expect(releaseConcurrencyViolations(dir).join("\n")).toContain("interleave");
  });

  it("does not mistake a commented-out expression for the real group", () => {
    const dir = fixtureDir({
      "release.yml":
        "concurrency:\n  # not release-${{ github.ref }}, deliberately\n  group: release\n" +
        "jobs:\n  publish:\n    runs-on: ubuntu-latest\n",
    });
    expect(releaseConcurrencyViolations(dir)).toEqual([]);
  });

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

  it("tolerates NPM_DIST_TAG_TOKEN in release.yml and nowhere else (#38)", () => {
    const tokenLine = "          NPM_DIST_TAG_TOKEN: ${{ secrets.NPM_DIST_TAG_TOKEN }}\n";
    const withToken = CI_TWO_JOBS.replace(
      "  package:",
      "      - run: publish_package core\n        env:\n" + tokenLine + "  package:",
    );
    expect(storedCredentialViolations(fixtureDir({ "release.yml": withToken }))).toEqual([]);
    expect(
      storedCredentialViolations(fixtureDir({ "ci.yml": withToken })).join("\n"),
    ).toContain("no stored credential exists");
    const otherSecret = withToken.replace("secrets.NPM_DIST_TAG_TOKEN", "secrets.NPM_TOKEN");
    expect(
      storedCredentialViolations(fixtureDir({ "release.yml": otherSecret })).join("\n"),
    ).toContain("no stored credential exists");
  });

  it("keeps the dist-tag token after every publish and out of NODE_AUTH_TOKEN", () => {
    expect(distTagTokenPlacementViolations(WORKFLOWS_DIR)).toEqual([]);
    const tokenStep = "      - run: move_next_tag\n        env:\n" +
      "          NPM_DIST_TAG_TOKEN: ${{ secrets.NPM_DIST_TAG_TOKEN }}\n";
    const before = CI_TWO_JOBS.replace(
      "  package:",
      tokenStep + "      - run: publish_package server\n  package:",
    );
    expect(
      distTagTokenPlacementViolations(fixtureDir({ "release.yml": before })).join("\n"),
    ).toContain("before the last publish_package");
    const nodeAuth = CI_TWO_JOBS.replace(
      "  package:",
      "      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: x\n  package:",
    );
    expect(
      distTagTokenPlacementViolations(fixtureDir({ "release.yml": nodeAuth })).join("\n"),
    ).toContain("NODE_AUTH_TOKEN");
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

  it("reports a violation when the value is the empty string", () => {
    // The third and quietest way to disable D-08, and the one a check for a
    // non-blank value waves through: `""` is two non-whitespace characters and
    // an empty value, and the script's silence on it is identical to its
    // silence on a deleted line.
    const planted = RELEASE_THREE_JOBS.replace(
      "          EXPECTED_VERSION: ${{ github.ref_name }}\n",
      '          EXPECTED_VERSION: ""\n',
    );
    const violations = expectedVersionViolations(
      fixtureDir({ "release.yml": planted }),
    );
    expect(violations.join("\n")).toContain("EXPECTED_VERSION");
  });

  it("reports a violation for an expression that renders empty when unset", () => {
    // `${{ env.RELEASE_TAG }}` reads as an indirection someone tidied up; for a
    // variable that no longer exists GitHub substitutes the empty string, and
    // verify goes green with the gate off.
    const planted = RELEASE_THREE_JOBS.replace(
      "${{ github.ref_name }}",
      "${{ env.RELEASE_TAG }}",
    );
    const violations = expectedVersionViolations(
      fixtureDir({ "release.yml": planted }),
    );
    expect(violations.join("\n")).toContain("env.RELEASE_TAG");
  });

  it("accepts the same value quoted, so the rule is not merely textual", () => {
    const planted = RELEASE_THREE_JOBS.replace(
      "EXPECTED_VERSION: ${{ github.ref_name }}",
      'EXPECTED_VERSION: "${{ github.ref_name }}"',
    );
    expect(expectedVersionViolations(fixtureDir({ "release.yml": planted }))).toEqual([]);
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

describe("CI-2: bounded workflows and an explicit gating aggregate", () => {
  const workflows = readWorkflows(WORKFLOWS_DIR);
  const ci = workflows.find((workflow) => workflow.name === "ci.yml")!;
  const aggregate = ci.jobs.get("ci-ok")!.join("\n");

  it("gives every job a positive timeout", () => {
    for (const workflow of workflows) {
      for (const [id, lines] of workflow.jobs) {
        expect(lines.join("\n"), `${workflow.name}:${id}`).toMatch(/^ {4}timeout-minutes: [1-9][0-9]*$/m);
      }
    }
  });

  it("only cancels superseded pull-request runs", () => {
    for (const name of ["ci.yml", "e2e.yml", "font-less-render.yml"]) {
      const text = workflows.find((workflow) => workflow.name === name)!.lines.join("\n");
      expect(text).toContain("github.event.pull_request.number || github.run_id");
      expect(text).toContain("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    }
    const release = workflows.find((workflow) => workflow.name === "release.yml")!.lines.join("\n");
    expect(release).toContain("  cancel-in-progress: false");
  });

  it("always aggregates every other CI job, excluding advisory workflows", () => {
    expect(aggregate).toContain("    if: ${{ always() }}");
    const dependencies = /^ {4}needs: \[([^\]]+)\]$/m.exec(aggregate)![1]!
      .split(",").map((id) => id.trim()).sort();
    expect(dependencies).toEqual([...ci.jobs.keys()].filter((id) => id !== "ci-ok").sort());
    expect(dependencies).not.toContain("e2e");
    expect(dependencies).not.toContain("font-less-render");
    expect(aggregate).toContain("NEEDS_JSON: ${{ toJSON(needs) }}");
  });

  const nodeScript = /node <<'NODE'\n([\s\S]+?)\n {10}NODE/.exec(aggregate)![1]!
    .replace(/^ {10}/gm, "");
  it("accepts successful gating jobs", () => {
    const result = spawnSync(process.execPath, ["-e", nodeScript], {
      env: { ...process.env, NEEDS_JSON: JSON.stringify({ "build-test": { result: "success" }, package: { result: "success" } }) },
    });
    expect(result.status).toBe(0);
  });

  it.each(["failure", "cancelled", "skipped", undefined])("rejects a %s gating result", (result) => {
    for (const id of ["build-test", "package"]) {
      const needs = { "build-test": { result: "success" }, package: { result: "success" }, [id]: { result } };
      expect(spawnSync(process.execPath, ["-e", nodeScript], {
        env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) },
      }).status).toBe(1);
    }
  });

  it("rejects an empty dependency map", () => {
    expect(spawnSync(process.execPath, ["-e", nodeScript], {
      env: { ...process.env, NEEDS_JSON: "{}" },
    }).status).toBe(1);
  });

  it("never hides job failures behind job-level continue-on-error", () => {
    for (const workflow of workflows) {
      for (const [id, lines] of workflow.jobs) {
        expect(lines.join("\n"), `${workflow.name}:${id}`).not.toMatch(/^ {4}continue-on-error:/m);
      }
    }
  });

  it.each([
    ["font-less-render.yml", "font-less-render", "font-less render", "Font-less render"],
    ["e2e.yml", "e2e", "e2e", "E2E"],
  ])("reports a failed %s advisory through a warning and summary", (file, job, step, title) => {
    const body = workflows.find((workflow) => workflow.name === file)!
      .jobs.get(job)!.join("\n");
    const report = body.split(`      - name: Report ${step} advisory failure\n`)[1]!;
    expect(report).toContain("        if: ${{ failure() }}");
    const script = report.split("        run: |\n")[1]!.replace(/^ {10}/gm, "");
    const summary = join(mkdtempSync(join(tmpdir(), "hwped-advisory-")), "summary.md");
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`::warning title=${title} advisory::`);
    expect(readFileSync(summary, "utf8")).toContain(`### ${title} advisory failed`);
  });
});

/**
 * A `uses:` line, matched LOOSELY: `uses:` and then the rest of the line,
 * whatever it holds.
 *
 * The strict shape is parsed out of that rest by `USES_STRICT` afterwards, and
 * a rest it cannot read is reported rather than dropped. A single regex doing
 * both silently skipped any line it did not understand - `uses:
 * evil/act@v1 # pin later` matched neither the reference-plus-comment form nor
 * the bare form, so it reached neither the pin check nor the failure list,
 * which is the opposite of what a fail-closed guard means.
 */
const USES_LINE = /^(\s*)(?:-\s*)?uses:[ \t]*(\S.*)?$/;

/** What may follow `uses:`: the reference, then an optional `# version`. */
const USES_STRICT = /^(\S+)(?:\s+#\s*(\S+))?\s*$/;

/**
 * A `uses:` key in ANY other shape, which is what makes the failure closed.
 *
 * YAML admits spellings `USES_LINE` deliberately does not read: a quoted key
 * (`"uses": ...`), a space before the colon (`uses : ...`) and the flow mapping
 * (`- {uses: x@v1}`, `{name: n, uses: x@v1}`). Each of those named an action
 * that the pinned-commit rule never saw. Rather than teaching the scanner every
 * YAML form, any line naming the key that `USES_LINE` does not parse is a
 * violation, so an unreadable form fails instead of passing.
 */
const USES_KEY_ANYWHERE = /\buses\b\s*["']?\s*:/;

/** A full commit SHA, which is the only action reference that cannot be repointed. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A container image digest, which is the only `docker://` reference that cannot
 * be repointed. An image is pinned by `@sha256:` rather than by a commit,
 * because a tag on an image - `docker://alpine:3` - is repointable in exactly
 * the way a tag on an action is.
 */
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;

interface ActionUse {
  /** The reference exactly as written, which is what a message quotes. */
  text: string;
  /** Repository action, or container image, without its reference. */
  action: string;
  /** Everything after the last `@`, or "" when the reference names none. */
  ref: string;
  /** Version in the trailing comment, which keeps the pin readable. */
  comment: string | undefined;
  /** A `docker://` image, whose ref is a digest rather than a commit. */
  image: boolean;
  where: string;
}

/**
 * A `uses:` reference this guard could not read. Reported, never skipped.
 *
 * `rest` is the text after a `uses:` key `USES_LINE` did read, which
 * `USES_STRICT` could not split into a reference and a comment. `line` is a
 * whole line that names the key in a spelling `USES_LINE` does not read, so
 * nothing about it was parsed.
 */
type UnparsedUse =
  | { where: string; form: "rest"; rest: string }
  | { where: string; form: "line"; line: string };

interface UseScan {
  thirdParty: ActionUse[];
  unparsed: UnparsedUse[];
}

/**
 * Every `uses:` line in the workflows, split into the third-party references
 * and the lines this scanner could not read.
 *
 * `actions/*` is GitHub's own and stays on its major tag by the owner's decision
 * (#45 item 6 scopes the pinning to third-party actions); a local `./path`
 * action is this repository's own code and has no ref at all. `docker://` is
 * third-party by definition, so it is scanned as an image pin - excluding it
 * would be one more class of reference that vanishes instead of failing.
 *
 * Two readings decide each line. `USES_LINE` reads the shape this repository
 * writes; a line that names the key in any other shape is captured by
 * `USES_KEY_ANYWHERE` and reported unread, so a YAML spelling nobody tested
 * cannot carry an unpinned action past the rule. A comment is the one place the
 * key is discussed rather than used, so it is the one line skipped.
 */
function scanUses(dir: string): UseScan {
  const thirdParty: ActionUse[] = [];
  const unparsed: UnparsedUse[] = [];
  for (const workflow of readWorkflows(dir)) {
    for (const [index, line] of workflow.lines.entries()) {
      const where = `${workflow.name}:${index + 1}`;
      const loose = USES_LINE.exec(line);
      if (loose === null) {
        if (/^\s*#/.test(line) || !USES_KEY_ANYWHERE.test(line)) continue;
        unparsed.push({ where, form: "line", line: line.trim() });
        continue;
      }
      const raw = (loose[2] ?? "").trim();
      const strict = USES_STRICT.exec(raw);
      if (strict === null) {
        unparsed.push({ where, form: "rest", rest: raw });
        continue;
      }
      const text = strict[1]!;
      const comment = strict[2];
      if (text.startsWith("./")) continue;
      const image = text.startsWith("docker://");
      const bare = image ? text.slice("docker://".length) : text;
      const at = bare.lastIndexOf("@");
      const action = at === -1 ? bare : bare.slice(0, at);
      if (!image && action.split("/")[0] === "actions") continue;
      thirdParty.push({
        text,
        action,
        ref: at === -1 ? "" : bare.slice(at + 1),
        comment,
        image,
        where,
      });
    }
  }
  return { thirdParty, unparsed };
}

/**
 * #45 item 6: a third-party action may only run at a full commit SHA.
 *
 * Why this is a guard and not a style rule: `uses: pnpm/action-setup@v6` names a
 * tag, and a tag is a pointer the action's owner can move. A workflow run then
 * executes whatever that owner pushed next, with no diff in this repository to
 * review, and the permission it runs with is the one the job was given - the
 * publish job's OIDC identity included. The SHA is the reviewed commit; the
 * trailing comment is the version, because a 40-character hash names nothing a
 * reader can check.
 *
 * Fail-closed in three ways. A `uses:` line whose shape this scanner does not
 * read is a violation rather than a line to skip, so a hand-edited pin cannot
 * pass by being unparseable. A line that names the key in a spelling
 * `USES_LINE` does not read at all - a quoted key, a space before the colon, a
 * flow mapping - is reported the same way, because YAML
 * accepts forms this line-based reader does not and a silent skip on an
 * unfamiliar spelling is exactly how a guard stops guarding. And a workflow
 * directory that yields no `uses:` line at all throws, so an indentation change
 * that stops this from reading the files reads as a failure rather than a pass.
 */
function unpinnedActionViolations(dir: string): string[] {
  const scan = scanUses(dir);
  if (scan.thirdParty.length === 0 && scan.unparsed.length === 0) {
    throw new Error(
      `CI-3 guard found no uses: line in ${dir}; the guard did not run.`,
    );
  }
  const violations = scan.unparsed.map((unread) =>
    unread.form === "rest"
      ? `${unread.where}: uses: ${unread.rest === "" ? "(nothing)" : unread.rest} does not parse as <action>@<ref> # <version>`
      : `${unread.where}: ${unread.line} names uses: in a form this guard does not read; write "- uses: <action>@<ref> # <version>"`,
  );
  for (const use of scan.thirdParty) {
    if (use.image) {
      if (!IMAGE_DIGEST.test(use.text)) {
        violations.push(`${use.where}: ${use.text} is not pinned to an @sha256: digest`);
      }
      continue;
    }
    if (!FULL_SHA.test(use.ref)) {
      violations.push(`${use.where}: ${use.text} is not a full commit SHA`);
      continue;
    }
    if (use.comment === undefined || !/^v?\d/.test(use.comment)) {
      violations.push(`${use.where}: ${use.text} has no version comment`);
    }
  }
  return violations;
}

describe("CI-3: a third-party action runs only at a pinned commit (#45 item 6)", () => {
  it("pins every third-party action in the workflows to a SHA with its version", () => {
    expect(unpinnedActionViolations(WORKFLOWS_DIR)).toEqual([]);
    // Non-vacuous on this tree: the pin above is one of these.
    expect(scanUses(WORKFLOWS_DIR).thirdParty.map((use) => use.action)).toContain(
      "pnpm/action-setup",
    );
  });

  it("reports a tag reference, which its owner can repoint", () => {
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: pnpm/action-setup@v6",
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([
      "ci.yml:5: pnpm/action-setup@v6 is not a full commit SHA",
    ]);
  });

  it("reports a pinned action that lost its version comment", () => {
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: pnpm/action-setup@${"a".repeat(40)}`,
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([
      `ci.yml:5: pnpm/action-setup@${"a".repeat(40)} has no version comment`,
    ]);
  });

  it("reports a tag reference whose comment is prose, not a version", () => {
    // The shape that used to be skipped entire: a tag followed by a comment
    // with a space in it matches neither form of a single-pattern parser, so
    // it silently escaped a guard that claims to fail closed.
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: evil/act@v1 # pin later",
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([
      "ci.yml:5: uses: evil/act@v1 # pin later does not parse as <action>@<ref> # <version>",
    ]);
  });

  it("reports a uses: line it cannot read at all, rather than passing it", () => {
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: evil/act@${"c".repeat(40)}  # trailing spaces before the comment`,
        "      - uses:",
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([
      "ci.yml:5: uses: evil/act@" +
        "c".repeat(40) +
        "  # trailing spaces before the comment does not parse as <action>@<ref> # <version>",
      "ci.yml:6: uses: (nothing) does not parse as <action>@<ref> # <version>",
    ]);
  });

  it("reads a CRLF workflow instead of skipping every line of it", () => {
    // Actions accepts a CRLF file. Splitting on "\n" alone leaves "\r" on every
    // line, and a pattern that ends in `.` or in a bare `$` after `.*` matches
    // none of them - so a CRLF file used to pass with every pin unchecked.
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: pnpm/action-setup@${"e".repeat(40)} # v6.1.1`,
        "      - uses: pnpm/action-setup@v6",
      ].join("\r\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([
      "ci.yml:6: pnpm/action-setup@v6 is not a full commit SHA",
    ]);
  });

  it.each([
    ["a flow mapping", "      - {uses: evil/act@v1}"],
    ["a quoted key", '      "uses": evil/act@v1'],
    ["a space before the colon", "      - uses : evil/act@v1"],
  ])("reports %s, a YAML spelling this reader does not parse", (_label, line) => {
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        line,
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([
      `ci.yml:5: ${line.trim()} names uses: in a form this guard does not read; ` +
        `write "- uses: <action>@<ref> # <version>"`,
    ]);
  });

  it("leaves a comment that mentions uses: alone", () => {
    // The key is discussed in prose above the steps; a comment is not a step.
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      # every uses: in this file must name a full commit",
        `      - uses: pnpm/action-setup@${"f".repeat(40)} # v6.1.1`,
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([]);
  });

  it("allows a pinned action, an actions/* tag, a local action and a pinned image", () => {
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: pnpm/action-setup@${"b".repeat(40)} # v6.1.1`,
        "      - uses: actions/checkout@v5",
        "      - uses: ./scripts/local-action",
        `      - uses: docker://alpine:3.20@sha256:${"d".repeat(64)}`,
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([]);
  });

  it("reports an image named by tag, which its publisher can repoint", () => {
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: docker://alpine:3",
      ].join("\n"),
    });
    expect(unpinnedActionViolations(dir)).toEqual([
      "ci.yml:5: docker://alpine:3 is not pinned to an @sha256: digest",
    ]);
  });

  it("fails rather than passing when it reads no uses: line", () => {
    const dir = fixtureDir({
      "ci.yml": [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo hi",
      ].join("\n"),
    });
    expect(() => unpinnedActionViolations(dir)).toThrow(/the guard did not run/);
  });
});

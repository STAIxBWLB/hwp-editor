#!/usr/bin/env node
/**
 * PKG-08: prove that a publish from this workspace would attempt exactly three
 * packages, under exactly these names and versions, and nothing else.
 *
 * Division of labour with scripts/smoke-consumer.mjs: this script proves WHICH
 * packages publish would attempt and under what identity; smoke-consumer proves
 * WHAT is inside the tarballs. A dry-run cannot prove the latter. It prints no
 * file listing, and it does not fail on a `files` glob that matches nothing.
 *
 * Why this is anchored the way it is. The assertion this replaces ran
 * `pnpm publish -r --dry-run` once and grepped its output for the three names.
 * That form consults the registry and silently omits any package whose version
 * is already published: measured in a two-package scratch workspace, a
 * recursive dry-run over `left-pad@1.3.0` (published) and an unpublished scoped
 * sibling printed a line for the sibling only, produced no output at all for
 * left-pad, and still exited 0. So the moment 1.0.0 lands on npm, the recursive
 * output would name none of the three and the required CI job would go red on
 * every pull request for a reason that is not a defect.
 *
 * The same dry-run run NON-recursively from inside the left-pad directory
 * printed `left-pad@1.3.0` normally. The registry existence check lives in
 * pnpm's recursive publish path only, so a per-package dry-run is immune to it.
 * That is the property the old assertion was always trying to express. Do not
 * re-add `-r` as a simplification: that single flag is the whole defect.
 *
 * Two further things this script never does:
 *
 * 1. It never treats an exit status as sufficient evidence. The command must
 *    succeed, and a successful per-package dry-run must also name the package
 *    in captured output because a silent skip can still exit 0.
 * 2. It never infers privateness from a dry-run. A non-recursive dry-run names
 *    a `private: true` package instead of refusing it, so publishability is
 *    asserted from the manifests via `pnpm ls`, which reads them from disk and
 *    needs no registry access.
 *
 * There is no try/catch anywhere in this script: any assertion that fails
 * throws and stops it with a non-zero exit.
 *
 * Usage: node scripts/check-publishable.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The complete set of workspace packages that may ever reach the registry. */
const PUBLISHABLE = ["@hwp-editor/core", "@hwp-editor/react", "@hwp-editor/server"];

/** Package directory names, in the order publish must attempt them. */
const PACKAGE_DIRS = ["core", "react", "server"];

const capture = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();

// ===========================================================================
// Part A: the publishable set, read from the manifests
// ===========================================================================
// `pnpm ls -r --depth -1 --json` reports name, version, path and private for
// every workspace package including the root, straight off disk, so a private
// flip is reflected immediately and no network call is involved.
const workspace = JSON.parse(capture("pnpm", ["ls", "-r", "--depth", "-1", "--json"], repoRoot));

const publishable = workspace.filter((p) => p.private !== true).map((p) => p.name);
const unexpected = publishable.filter((name) => !PUBLISHABLE.includes(name));
const missing = PUBLISHABLE.filter((name) => !publishable.includes(name));

// Both directions are reported, because each is a distinct defect. This is
// strictly stronger than the `grep -qF playground` line it replaces: that grep
// only ever noticed playground, while this also fails when a future fourth
// workspace package ships without `private: true`.
if (unexpected.length > 0 || missing.length > 0) {
  const parts = [];
  if (unexpected.length > 0) {
    parts.push(`publishable but must not be: ${unexpected.join(", ")}`);
  }
  if (missing.length > 0) {
    parts.push(`expected to be publishable but is missing or went private: ${missing.join(", ")}`);
  }
  throw new Error(`workspace publishable set is wrong; ${parts.join("; ")}`);
}
console.log(`[set] exactly these are publishable: ${PUBLISHABLE.join(", ")}`);

const manifests = {};
for (const dir of PACKAGE_DIRS) {
  const path = join(repoRoot, "packages", dir, "package.json");
  manifests[dir] = JSON.parse(readFileSync(path, "utf8"));
}

const versions = Object.fromEntries(
  PACKAGE_DIRS.map((dir) => [manifests[dir].name, manifests[dir].version]),
);
if (new Set(Object.values(versions)).size !== 1) {
  throw new Error(`manifest versions are not in lockstep: ${JSON.stringify(versions)}`);
}
const version = manifests.core.version;
console.log(`[version] all three manifests agree on ${version}`);

for (const dir of PACKAGE_DIRS) {
  const access = manifests[dir].publishConfig?.access;
  if (access !== "public") {
    throw new Error(
      `${manifests[dir].name} publishConfig.access is ${JSON.stringify(access)}, want "public"; ` +
        `a scoped package without it publishes restricted`,
    );
  }
}
console.log("[access] all three declare publishConfig.access public");

// ===========================================================================
// Part B: the per-package publish dry-run
// ===========================================================================
// Order is load-bearing for the same reason as the pack order in
// smoke-consumer.mjs: the dry-run fires the prepack hook, and the react and
// server dts builds resolve @hwp-editor/core types through the workspace
// symlink into packages/core/dist/index.d.ts. Core first, always.
//
// --no-git-checks is required: pnpm publish verifies the branch and a clean
// tree by default and aborts on a CI checkout. The dry-run runs
// unauthenticated, so no token is needed.
for (const dir of PACKAGE_DIRS) {
  const { name } = manifests[dir];
  const expected = `${name}@${version}`;

  // spawnSync rather than execFileSync because both the termination state and
  // combined stdout/stderr are evidence. A zero exit alone cannot prove that
  // pnpm attempted the package, while matching output cannot excuse a failed
  // command.
  const result = spawnSync("pnpm", ["publish", "--dry-run", "--no-git-checks"], {
    cwd: join(repoRoot, "packages", dir),
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    console.error(output);
    const termination =
      result.error !== undefined
        ? `could not start: ${result.error.message}`
        : result.signal !== null
          ? `was terminated by ${result.signal}`
          : `exited with status ${result.status}`;
    throw new Error(`publish dry-run for packages/${dir} ${termination}`);
  }

  if (!output.includes(expected)) {
    console.error(output);
    throw new Error(
      `publish dry-run for packages/${dir} exited successfully but does not name ${expected}; ` +
        `a dry-run that silently skips a package can still leave the status at 0`,
    );
  }
  console.log(`[dry-run] publish would attempt ${expected}`);
}

console.log("\ncheck-publishable PASSED");

/**
 * No developer-machine path in the tracked tree (PKG-09). Deliberately NOT
 * wrapped in describeBin: this is a repository-shape assertion, not a document
 * operation, and it must run on a machine with no hwp-cli install so a
 * contributor's `pnpm -r test` catches a reintroduced path rather than only CI.
 *
 * The probes cover macOS, common Linux checkout roots, Windows user profiles,
 * the current home, and the current repository root. `.planning/`, `.claude/`
 * and `.gsd/` are gitignored, so a `git grep` over tracked files cannot match
 * planning artifacts and no exclusion pathspec is needed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Generic developer-machine path expressions; see the header for why these
 * shapes are assembled rather than written as matching literals.
 *
 * The generic Linux expression is limited to common checkout directories so
 * controlled fixture values such as `/home/tester` remain valid. The current
 * home and repository root are also scanned as fixed strings, which catches
 * any local layout regardless of those conventional directory names.
 */
const GENERIC_MACHINE_PATHS = [
  `/${"Users"}/[^/[:space:]]+/`,
  `/${"home"}/[^/[:space:]]+/(workspace|work|src|dev|projects|code)/`,
  `[A-Za-z]:[\\\\/]${"Users"}[\\\\/][^\\\\/[:space:]]+[\\\\/]`,
];

function repoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    // Never return early into a silent pass: an unavailable git or a
    // non-work-tree directory means the guard did not run, which is a
    // failure, not a clean tree.
    throw new Error(
      `PKG-09 guard could not resolve the repository root; git is unavailable ` +
        `or this is not a git work tree: ${String(error)}`,
    );
  }
}

/**
 * `git grep` exits 1 when it finds nothing. Only that status is a clean result;
 * a spawn error, signal, or any status above 1 means the guard itself failed.
 * Vitest runs with the package directory as cwd and `git grep` scopes to its
 * cwd, hence the explicit root.
 */
function grepTracked(cwd: string, mode: "-E" | "-F", pattern: string): string {
  const result = spawnSync("git", ["grep", "-n", "-I", mode, "--", pattern], {
    cwd,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.signal !== null || ![0, 1].includes(result.status ?? -1)) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? "unknown git grep failure";
    throw new Error(`PKG-09 guard failed while scanning ${JSON.stringify(pattern)}: ${detail}`);
  }
  return result.status === 0 ? result.stdout : "";
}

function grepTrackedForMachinePaths(cwd: string): string {
  const probes = [
    { label: "current home", mode: "-F" as const, pattern: `${homedir()}${sep}` },
    { label: "repository root", mode: "-F" as const, pattern: cwd },
    ...GENERIC_MACHINE_PATHS.map((pattern) => ({
      label: "generic developer path",
      mode: "-E" as const,
      pattern,
    })),
  ];
  return probes
    .map(({ label, mode, pattern }) => {
      const matches = grepTracked(cwd, mode, pattern).trim();
      return matches === "" ? "" : `[${label}: ${pattern}]\n${matches}`;
    })
    .filter(Boolean)
    .join("\n");
}

describe("PKG-09: no developer-machine path is committed", () => {
  it("resolves the repository root rather than trusting the vitest cwd", () => {
    const root = repoRoot();
    expect(root.length).toBeGreaterThan(0);
    expect(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toBe("true");
  });

  it("finds no developer-machine path in any tracked file", () => {
    const matches = grepTrackedForMachinePaths(repoRoot()).trim();
    expect(
      matches,
      `tracked files contain a developer-machine path:\n${matches}`,
    ).toBe("");
  });
});

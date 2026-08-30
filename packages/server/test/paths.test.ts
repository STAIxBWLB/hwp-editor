/**
 * No developer-machine path in the tracked tree (PKG-09). Deliberately NOT
 * wrapped in describeBin: this is a repository-shape assertion, not a document
 * operation, and it must run on a machine with no hwp-cli install so a
 * contributor's `pnpm -r test` catches a reintroduced path rather than only CI.
 *
 * The pattern is the absolute macOS home root, not a maintainer-specific
 * substring, so a future contributor's path under a different user name is
 * caught too. `.planning/`, `.claude/` and `.gsd/` are gitignored, so a
 * `git grep` over tracked files cannot match planning artifacts and no
 * exclusion pathspec is needed.
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/** Absolute macOS home-directory root; see the header for why this shape. */
const HOME_ROOT = "/Users/";

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
 * `git grep` exits non-zero when it finds nothing, so the assertion is on the
 * captured output, never on the exit status. vitest runs with the package
 * directory as cwd and `git grep` scopes to its cwd, hence the explicit root.
 */
function grepTrackedForHomePaths(cwd: string): string {
  try {
    return execFileSync("git", ["grep", "-n", "--", HOME_ROOT], {
      cwd,
      encoding: "utf8",
    });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string") return stdout;
    throw error;
  }
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

  it("finds no absolute home-directory path in any tracked file", () => {
    const matches = grepTrackedForHomePaths(repoRoot()).trim();
    expect(
      matches,
      `tracked files contain an absolute home-directory path:\n${matches}`,
    ).toBe("");
  });
});

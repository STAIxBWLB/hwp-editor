/**
 * `scripts/playground.mjs` startup refusal (#58 item 12): the resolved hwp
 * path and the cause, after resolving a relative `HWP_EDITOR_BIN` against
 * `INIT_CWD` rather than this repository's root.
 *
 * Placement follows `repo-guards.test.ts`: this is a fact about the
 * repository, not about `@hwp-editor/server`, and `pnpm -r test` (the command
 * CI runs) only reaches tests inside a workspace package.
 *
 * Deliberately not wrapped in `describeBin`: every case fails the binary probe,
 * so the script exits before it starts anything, and each assertion runs on a
 * machine with no hwp-cli install.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "playground.mjs");

/** Run the script with only the given hwp-selection variables set. */
function startup(env: Record<string, string>, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HWP_EDITOR_BIN: "", HWP_CLI: "", INIT_CWD: "", ...env },
  });
}

describe("playground startup failure", () => {
  it("resolves a relative HWP_EDITOR_BIN against INIT_CWD and names the path and the cause", () => {
    const caller = mkdtempSync(join(tmpdir(), "hwp-playground-cwd-"));
    try {
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "./missing-hwp", INIT_CWD: caller });
      expect(status).toBe(1);
      // Without the INIT_CWD resolution this reads the repository root, where
      // the caller never pointed, and the path in the message misleads.
      expect(stderr).toContain(`The playground cannot run hwp at ${join(caller, "missing-hwp")} (error ENOENT)`);
      expect(stderr).toMatch(/set HWP_EDITOR_BIN to its executable, then run pnpm playground again/);
    } finally { rmSync(caller, { recursive: true, force: true }); }
  });

  it("falls back to the working directory when INIT_CWD is absent", () => {
    const caller = mkdtempSync(join(tmpdir(), "hwp-playground-noinit-"));
    try {
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "./missing-hwp" }, caller);
      expect(status).toBe(1);
      expect(stderr).toContain(join(caller, "missing-hwp"));
    } finally { rmSync(caller, { recursive: true, force: true }); }
  });

  it("prints the exit status of a binary that runs but fails", () => {
    const caller = mkdtempSync(join(tmpdir(), "hwp-playground-status-"));
    try {
      const bin = join(caller, "failing-hwp");
      writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
      chmodSync(bin, 0o700);
      const { status, stderr } = startup({ HWP_EDITOR_BIN: bin });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${bin} (exit status 3)`);
    } finally { rmSync(caller, { recursive: true, force: true }); }
  });

  /**
   * The default is the bare name `hwp`, which `spawn` resolves on PATH, so the
   * old message repeated the name back: "cannot run hwp at hwp" (#58 item 31).
   * The refusal names the PATH entry the search would have picked, and says the
   * lookup was PATH-wide when there is no entry to name.
   */
  it("says a bare hwp was looked up on PATH when no entry matches", () => {
    const empty = mkdtempSync(join(tmpdir(), "hwp-playground-path-"));
    try {
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: empty });
      expect(status).toBe(1);
      expect(stderr).toContain("The playground cannot run hwp at hwp on PATH (error ENOENT)");
      expect(stderr).not.toContain("at hwp (");
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it("names the resolved PATH entry for a bare hwp that runs but fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwp-playground-onpath-"));
    try {
      const bin = join(dir, "hwp");
      writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
      chmodSync(bin, 0o700);
      // Nothing configures a path anywhere: the name alone, found on this PATH.
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: dir });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${bin} (exit status 3)`);
      expect(stderr).not.toContain("at hwp (");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * `existsSync` was also true for a directory named hwp, so the refusal named
   * an entry `spawn` skips (#105 item 4). The message names the entry that
   * would actually run, one PATH entry later.
   */
  it.runIf(process.platform !== "win32")("skips a directory named hwp and names the entry that would run", () => {
    const first = mkdtempSync(join(tmpdir(), "hwp-playground-dir-"));
    const second = mkdtempSync(join(tmpdir(), "hwp-playground-real-"));
    try {
      mkdirSync(join(first, "hwp"));
      const bin = join(second, "hwp");
      writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
      chmodSync(bin, 0o700);
      const { status, stderr } = startup({
        HWP_EDITOR_BIN: "", HWP_CLI: "",
        PATH: `${first}${delimiter}${second}`,
      });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${bin} (exit status 3)`);
      expect(stderr).not.toContain(join(first, "hwp"));
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("skips a non-executable file named hwp and names the entry that would run", () => {
    const first = mkdtempSync(join(tmpdir(), "hwp-playground-noexec-"));
    const second = mkdtempSync(join(tmpdir(), "hwp-playground-exec-"));
    try {
      writeFileSync(join(first, "hwp"), "not an executable\n");
      chmodSync(join(first, "hwp"), 0o600);
      const bin = join(second, "hwp");
      writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
      chmodSync(bin, 0o700);
      const { status, stderr } = startup({
        HWP_EDITOR_BIN: "", HWP_CLI: "",
        PATH: `${first}${delimiter}${second}`,
      });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${bin} (exit status 3)`);
      expect(stderr).not.toContain(join(first, "hwp"));
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

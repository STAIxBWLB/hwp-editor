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
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "playground.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

/** Run the script with only the given hwp-selection variables set. */
function startup(env: Record<string, string>, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HWP_EDITOR_BIN: "", HWP_CLI: "", INIT_CWD: "", ...env },
  });
}

/**
 * The same run with `process.platform` faked, which is the only way to reach
 * the Windows branch of the PATH search from a POSIX test machine: the script
 * reads the platform when it looks the name up, so a preload that redefines it
 * before the import drives the Windows order.
 */
function startupAs(platform: string, env: Record<string, string>, cwd = REPO_ROOT) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}});` +
        `await import(${JSON.stringify(SCRIPT_URL)});`,
    ],
    {
      encoding: "utf8",
      cwd,
      env: { ...process.env, HWP_EDITOR_BIN: "", HWP_CLI: "", INIT_CWD: "", ...env },
    },
  );
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

  /**
   * A relative PATH entry resolves against the spawn's working directory, which
   * is this repository's root, and not against wherever the caller ran the
   * script from (#105 item 4 review). Naming the caller-relative path pointed
   * the reader at a file `spawn` would never have run, in a directory it never
   * looked in.
   */
  it("does not name a relative PATH entry that resolves outside the spawn's working directory", () => {
    const caller = mkdtempSync(join(tmpdir(), "hwp-playground-relcwd-"));
    try {
      mkdirSync(join(caller, "rel"));
      const bin = join(caller, "rel", "hwp");
      writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
      chmodSync(bin, 0o700);
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: "rel" }, caller);
      expect(status).toBe(1);
      expect(stderr).toContain("The playground cannot run hwp at hwp on PATH (");
      expect(stderr).not.toContain(join("rel", "hwp"));
    } finally { rmSync(caller, { recursive: true, force: true }); }
  });

  /**
   * Windows tries the literal name only when it already carries an extension,
   * so `hwp` is looked for as hwp.com and hwp.exe and an extensionless hwp in
   * the same directory is never what `spawn` runs (#105 item 4 review). The
   * report named that file before, sending the caller to something the kernel
   * would skip.
   */
  it("on the Windows search order, names hwp.com rather than an extensionless hwp", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwp-playground-win-"));
    try {
      writeFileSync(join(dir, "hwp"), "not an executable\n");
      writeFileSync(join(dir, "hwp.com"), "not an executable\n");
      const env = { HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: dir };
      const extensionless = startupAs("win32", env);
      expect(extensionless.status).toBe(1);
      expect(extensionless.stderr).toContain(`The playground cannot run hwp at ${join(dir, "hwp.com")} (`);
      expect(extensionless.stderr).not.toContain(`${join(dir, "hwp")} (`);

      // A name that already carries an extension is tried as written, and only
      // as written: hwp.exe is found as hwp.exe, never as hwp.exe.com.
      writeFileSync(join(dir, "hwp.exe"), "not an executable\n");
      const named = startupAs("win32", { ...env, HWP_EDITOR_BIN: "hwp.exe" });
      expect(named.status).toBe(1);
      expect(named.stderr).toContain(`The playground cannot run hwp at ${join(dir, "hwp.exe")} (`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "playground.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

/**
 * The file this platform's unset-PATH default names `false` first. The default
 * is not one value across POSIX: macOS falls back to libuv's _PATH_DEFPATH,
 * /usr/bin:/bin, while Linux forks to glibc execvp, whose confstr CS_PATH is
 * /bin:/usr/bin. Only the first entry tells the two orders apart.
 */
const DEFAULT_FALSE = process.platform === "darwin" ? "/usr/bin/false" : "/bin/false";

/** A variable set to undefined is removed from the child's environment. */
type Env = Record<string, string | undefined>;

/** This process's environment with the hwp-selection variables and `env` applied. */
function childEnv(env: Env) {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.HWP_EDITOR_BIN = "";
  merged.HWP_CLI = "";
  merged.INIT_CWD = "";
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Run the script with only the given hwp-selection variables set. */
function startup(env: Env, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    cwd,
    env: childEnv(env),
  });
}

/**
 * The same run with `process.platform` faked, which is the only way to reach
 * the Windows branch of the PATH search from a POSIX test machine: the script
 * reads the platform when it looks the name up, so a preload that redefines it
 * before the import drives the Windows order.
 */
function startupAs(platform: string, env: Env, cwd = REPO_ROOT) {
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
      env: childEnv(env),
    },
  );
}

/**
 * The same startup with the script copied to `<dir>/scripts/playground.mjs`, so
 * the copy's own root is `dir`: an empty POSIX PATH entry names that directory
 * as the spawn's working directory, and a case can then plant the file `spawn`
 * would run without writing into this repository.
 */
function startupIn(dir: string, env: Env) {
  const script = join(dir, "scripts", "playground.mjs");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, readFileSync(SCRIPT, "utf8"));
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    cwd: dir,
    env: childEnv(env),
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
   * The default is two names now (#121): `ahwp`, then `hwp` as the 1.x
   * compatibility name. With neither on PATH the refusal names the pair, so a
   * reader learns which install is missing rather than which name was probed
   * last. The PATH-entry detail still applies to the single-name cases below.
   */
  it("names both default commands when neither is on PATH", () => {
    const empty = mkdtempSync(join(tmpdir(), "hwp-playground-path-"));
    try {
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: empty });
      expect(status).toBe(1);
      expect(stderr).toContain("The playground cannot run ahwp or hwp: neither is on PATH (error ENOENT)");
      expect(stderr).toMatch(/install agent-hwp so `ahwp` is on PATH/);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  /**
   * `ahwp` is the name this repository runs; `hwp` is only the 1.x fallback.
   * Both are installed here, so a chain that probed `hwp` first would name it.
   */
  it("prefers ahwp over the 1.x name when both are on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwp-playground-both-"));
    try {
      const legacy = join(dir, "hwp");
      const primary = join(dir, "ahwp");
      writeFileSync(legacy, `#!${process.execPath}\nprocess.exit(4);\n`);
      writeFileSync(primary, `#!${process.execPath}\nprocess.exit(3);\n`);
      chmodSync(legacy, 0o700);
      chmodSync(primary, 0o700);
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: dir });
      expect(status).toBe(1);
      // The exit status proves which binary answered: 3 is ahwp alone.
      expect(stderr).toContain(`The playground cannot run ahwp at ${primary} (exit status 3)`);
      expect(stderr).not.toContain(`${legacy} (`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
      expect(stderr).toContain("The playground cannot run ahwp or hwp: neither is on PATH (");
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
      const { status, stderr } = startupAs("win32", { HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: dir });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${join(dir, "hwp.com")} (`);
      expect(stderr).not.toContain(`${join(dir, "hwp")} (`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * A name that already carries an extension is tried as written before the
   * extensions are appended, so hwp.exe wins over hwp.exe.com. Both have to
   * exist on disk for that to be proved: with hwp.exe.com absent, an order that
   * appends first still lands on hwp.exe after the appended names miss
   * (#113 review).
   */
  it("on the Windows search order, tries a name that carries an extension as written before hwp.exe.com", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwp-playground-winlit-"));
    try {
      writeFileSync(join(dir, "hwp.exe"), "not an executable\n");
      writeFileSync(join(dir, "hwp.exe.com"), "not an executable\n");
      const { status, stderr } = startupAs("win32", { HWP_EDITOR_BIN: "hwp.exe", HWP_CLI: "", PATH: dir });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${join(dir, "hwp.exe")} (`);
      expect(stderr).not.toContain(`${join(dir, "hwp.exe.com")} (`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * An empty PATH entry is the spawn's working directory, not an entry to drop
   * (#113 item 2): libuv composes the bare name from it and the spawn runs with
   * that directory as its cwd (src/unix/process.c). The script's root is its
   * own parent directory, so the copy makes the temp directory the place the
   * entry names without writing a candidate into this repository.
   */
  it.runIf(process.platform !== "win32")("treats an empty PATH entry as the spawn's working directory", () => {
    const repo = mkdtempSync(join(tmpdir(), "hwp-playground-empty-"));
    try {
      const bin = join(repo, "hwp");
      writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
      chmodSync(bin, 0o700);
      const { status, stderr } = startupIn(repo, { HWP_EDITOR_BIN: "", HWP_CLI: "", PATH: "" });
      expect(status).toBe(1);
      // The copy's root comes from its own module URL, which is the real path:
      // on macOS the temp directory's /var is a symlink to /private/var.
      expect(stderr).toContain(`The playground cannot run hwp at ${join(realpathSync(repo), "hwp")} (exit status 3)`);
      expect(stderr).not.toContain("at hwp on PATH");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  /**
   * An unset PATH is the libc default, which is what libuv searches when the
   * child environment carries no PATH. That default follows the spawn path and
   * is therefore per platform (#113 review): macOS resolves the name itself and
   * falls back to _PATH_DEFPATH, /usr/bin:/bin (src/unix/process.c
   * uv__spawn_resolve_and_spawn, the value the SDK's paths.h:65 defines), while
   * Linux forks and calls glibc execvp, whose confstr CS_PATH is /bin:/usr/bin.
   * `false` proves the order, because it fails the version probe and the
   * reported entry is the file spawn actually ran: /bin is a symlink to
   * /usr/bin on the Linux CI image, so "a false resolved" would hold for either
   * order and only the exact string separates them.
   */
  it.runIf(process.platform !== "win32" && existsSync(DEFAULT_FALSE))(
    "searches the libc default PATH when PATH is unset, in its platform's order",
    () => {
      const { status, stderr } = startup({ HWP_EDITOR_BIN: "false", HWP_CLI: "", PATH: undefined });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${DEFAULT_FALSE} (exit status 1)`);
    },
  );

  /**
   * The extensions are appended after a name that already carries one, so
   * hwp.exe is also probed as hwp.exe.com (libuv path_search_walk_ext). The
   * earlier version of this test asserted the opposite; #111's review corrected
   * it against the source, and this case keeps the correction from regressing.
   */
  it("on the Windows search order, also probes hwp.exe.com for a name that has an extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwp-playground-winext-"));
    try {
      writeFileSync(join(dir, "hwp.exe.com"), "not an executable\n");
      const { status, stderr } = startupAs("win32", { HWP_EDITOR_BIN: "hwp.exe", HWP_CLI: "", PATH: dir });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${join(dir, "hwp.exe.com")} (`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * libuv's extension test is the first dot followed by a character, so `hwp.`
   * is extensionless: no literal try, and the appended extension is joined
   * without a second dot, which makes it hwp.com and never hwp..com (#113 item
   * 1).
   */
  it("on the Windows search order, treats hwp. as extensionless and does not double the dot", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwp-playground-windot-"));
    try {
      writeFileSync(join(dir, "hwp..com"), "not an executable\n");
      writeFileSync(join(dir, "hwp.com"), "not an executable\n");
      const { status, stderr } = startupAs("win32", { HWP_EDITOR_BIN: "hwp.", HWP_CLI: "", PATH: dir });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${join(dir, "hwp.com")} (`);
      expect(stderr).not.toContain(`${join(dir, "hwp..com")} (`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * A leading dot is a nonempty extension by the same test, so `.hwp` is tried
   * as written before any extension is appended (#113 item 1).
   */
  it("on the Windows search order, tries .hwp as written first", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwp-playground-winlead-"));
    try {
      writeFileSync(join(dir, ".hwp"), "not an executable\n");
      const { status, stderr } = startupAs("win32", { HWP_EDITOR_BIN: ".hwp", HWP_CLI: "", PATH: dir });
      expect(status).toBe(1);
      expect(stderr).toContain(`The playground cannot run hwp at ${join(dir, ".hwp")} (`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

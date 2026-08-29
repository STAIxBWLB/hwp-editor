/**
 * A stand-in `hwp` binary, shared by every test that must run on a machine
 * with no hwp-cli install (TEST-02). Extracted from the local helper in
 * `protected.test.ts` and widened with the failure modes the lifecycle suite
 * drives.
 *
 * It is an argv dispatcher rather than a stub because every `CliEngine`
 * method calls `ensureVersion()` first: a fake that only knows how to fail
 * fails in version verification, and the test then asserts `version` instead
 * of the failure kind it meant to cover. So `--version` and `edit --help`
 * are answered before the mode branch is ever reached.
 *
 * Everything the script needs — mode, version, help-fixture path, log path —
 * is baked into the script body as a literal rather than read from the
 * environment: `scrubbedEnv` passes exactly one ambient `HWP_*` variable
 * through, so there is no environment channel to steer the fake with.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Captured `hwp edit --help`; see `fixtures/edit-help.txt`. */
const DEFAULT_HELP_FIXTURE = path.join(HERE, "fixtures", "edit-help.txt");

/** A version inside the accepted range, so the fake survives the floor check. */
const DEFAULT_VERSION = "0.14.0";

/** 39 characters plus the newline `yes` appends: 40 bytes per line. */
const OVERFLOW_LINE = "012345678901234567890123456789012345678";

export type FakeBinMode = "ok" | "fail" | "overflow" | "hang" | "slow";

export interface FakeBinOptions {
  /** What `--version` prints; default `0.14.0`. */
  version?: string;
  /** What every subcommand other than `--version`/`edit --help`/`info` does. */
  mode?: FakeBinMode;
  /** `slow` sleep duration in ms; default 5000. */
  delayMs?: number;
  /** JSON printed for `info`, if the test needs the pre-flight to see one. */
  info?: string;
  /** stderr written by `mode: "fail"`; default `boom`. */
  editStderr?: string;
  /** stdout written by `ok`/`fail` before exiting, e.g. a validate report. */
  stdout?: string;
  /** Alternative `edit --help` output, for flag-surface cases. */
  helpFixture?: string;
}

const dirs: string[] = [];

function modeScript(opts: FakeBinOptions): string[] {
  const stdout =
    opts.stdout === undefined ? [] : [`printf '%s' ${JSON.stringify(opts.stdout)}`];
  switch (opts.mode ?? "ok") {
    case "ok":
      return [...stdout, "exit 0"];
    case "fail":
      return [...stdout, `printf '%s' ${JSON.stringify(opts.editStderr ?? "boom")} >&2`, "exit 3"];
    case "overflow":
      // `yes` is a C program; a shell `while echo` loop takes seconds to
      // reach 32 MiB. `exec` so no shell is left waiting on the pipe.
      return [`exec yes ${JSON.stringify(OVERFLOW_LINE)}`];
    case "hang":
      // Ignores SIGTERM, which is what forces the SIGKILL escalation. The
      // sleep is chopped into 0.1s slices so the grandchild the SIGKILL does
      // NOT reach (kill targets the pid, not the group) cannot outlive the
      // test by more than that.
      return ['trap "" TERM', "i=0", "while [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done", "exit 0"];
    case "slow":
      return [`sleep ${(opts.delayMs ?? 5000) / 1000}`, "exit 0"];
  }
}

/**
 * Write an executable fake `hwp` to a fresh temp dir. Returns its path and a
 * reader for the argv log, one invocation per line.
 */
export function createFakeBin(opts: FakeBinOptions = {}): { bin: string; log: () => string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hwp-editor-fake-"));
  dirs.push(dir);
  const logPath = path.join(dir, "argv.log");
  writeFileSync(logPath, "");
  const bin = path.join(dir, "hwp");
  const help = opts.helpFixture ?? DEFAULT_HELP_FIXTURE;
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      // JSON.stringify around every interpolated value: shell quoting handled
      // once, at the one place values enter the script.
      `echo "$@" >> ${JSON.stringify(logPath)}`,
      'case "$1" in',
      `  --version) echo ${JSON.stringify(`hwp ${opts.version ?? DEFAULT_VERSION}`)}; exit 0 ;;`,
      `  edit) if [ "$2" = "--help" ]; then cat ${JSON.stringify(help)}; exit 0; fi ;;`,
      ...(opts.info === undefined ? [] : [`  info) printf '%s' ${JSON.stringify(opts.info)}; exit 0 ;;`]),
      "esac",
      ...modeScript(opts),
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o700);
  return { bin, log: () => readFileSync(logPath, "utf8") };
}

/** Remove every fake created so far; call from `afterEach`. */
export function disposeFakeBins(): void {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
}

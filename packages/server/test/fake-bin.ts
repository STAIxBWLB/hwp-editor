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
const DEFAULT_VERSION = "0.20.0";

/** 39 characters plus the newline `yes` appends: 40 bytes per line. */
const OVERFLOW_LINE = "012345678901234567890123456789012345678";

export type FakeBinMode = "ok" | "fail" | "overflow" | "hang" | "slow" | "graceful";

export interface FakeBinOptions {
  /** What `--version` prints; default `0.20.0`. */
  version?: string;
  /** What every subcommand other than `--version`/`edit --help`/`info` does. */
  mode?: FakeBinMode;
  /** Fail one template command after the version/help handshake. */
  failTemplateCommand?: "slots" | "fields" | "fill" | "template" | "lint" | "list-templates" | "create" | "edit";
  /**
   * Exit code that failing template command uses; default 3. `lint` is the one
   * command whose exit 1 is meaningful on its own: hwp-cli exits 1 for an
   * unreadable document, which is not a lint failure a caller can fix.
   */
  templateFailureCode?: number;
  /**
   * stderr the failing template command writes; default `<command> failed at
   * /private/fake/document.hwpx`. Overrides the text so a test can drive the
   * Korean protected markers through a command other than `edit` (#105 item 2).
   */
  templateStderr?: string;
  /**
   * The same stderr as `templateStderr`, one line each. hwp-cli prints a note
   * before its `Error:` line for a distribution document, and `templateStderr`
   * is written with `printf '%s'`, which keeps no newline (#112).
   */
  templateStderrLines?: string[];
  /** `slow` sleep duration in ms; default 5000. */
  delayMs?: number;
  /** JSON printed for `info`, if the test needs the pre-flight to see one. */
  info?: string;
  /**
   * JSON printed for `info ... --body-stats`, the form that carries the body's
   * table count (#97). Answered from the same `info` case, so a test can give
   * the two forms different payloads.
   */
  infoBodyStats?: string;
  /** Make the `--body-stats` form exit non-zero, to drive the plain-info fallback. */
  failBodyStats?: boolean;
  /** stderr written by `mode: "fail"`; default `boom`. */
  editStderr?: string;
  /**
   * stderr written by `mode: "fail"`, one line each. A refusal the engine
   * prints over several lines — a note before its `Error:` line — cannot be
   * expressed through `editStderr`, because that one is emitted verbatim and
   * keeps no newline.
   */
  editStderrLines?: string[];
  /** stdout written by `ok`/`fail` before exiting, e.g. a validate report. */
  stdout?: string;
  /**
   * stdout for `cat` alone, answered before the mode branch is reached. Lets
   * a fake serve a parseable envelope instantly while `fields`/`bookmarks`/
   * `slots`/`info` still take the mode's path, which is the only way to drive
   * a cancellation that lands during the optional probes rather than during
   * `cat`.
   */
  catStdout?: string;
  /**
   * Alternative `edit --help` output, for flag-surface cases. Pointing this
   * at a path that does not exist is how a test drives a handshake whose
   * `edit --help` exits non-zero.
   */
  helpFixture?: string;
  /**
   * JSON text written to the `--report <FILE>` path on a successful `edit`.
   * The fake publishes the staged input as the output document and exits 0, so
   * a test can read back the report through the engine exactly as a real run
   * would — including an `output` the caller never asked for.
   */
  editReport?: string;
}

const dirs: string[] = [];

/**
 * Sleep in 0.1s slices rather than one long `sleep`. A shell waiting on a
 * foreground command defers signal handling until that command returns, so a
 * single `sleep 5` would swallow a SIGTERM for up to five seconds; slices
 * bound that to 0.1s. It also bounds how long the grandchild `sleep` — which
 * a SIGKILL aimed at the shell's pid does not reach — can outlive the test.
 */
function sleepSlices(ms: number): string[] {
  return ["i=0", `while [ $i -lt ${Math.ceil(ms / 100)} ]; do sleep 0.1; i=$((i+1)); done`];
}

function modeScript(opts: FakeBinOptions): string[] {
  const stdout =
    opts.stdout === undefined ? [] : [`printf '%s' ${JSON.stringify(opts.stdout)}`];
  switch (opts.mode ?? "ok") {
    case "ok":
      return [...stdout, "exit 0"];
    case "fail":
      return [
        ...stdout,
        ...(opts.editStderrLines === undefined
          ? [`printf '%s' ${JSON.stringify(opts.editStderr ?? "boom")} >&2`]
          : opts.editStderrLines.map((line) => `printf '%s\\n' ${JSON.stringify(line)} >&2`)),
        "exit 3",
      ];
    case "overflow":
      // `yes` is a C program; a shell `while echo` loop takes seconds to
      // reach 32 MiB. `exec` so no shell is left waiting on the pipe.
      return [`exec yes ${JSON.stringify(OVERFLOW_LINE)}`];
    case "hang":
      // Ignores SIGTERM, which is what forces the SIGKILL escalation.
      return ['trap "" TERM', ...sleepSlices(60_000), "exit 0"];
    case "graceful":
      // Traps SIGTERM and exits ZERO, the way a wrapper that cleans up after
      // itself does. This is the case that separates "the child exited 0"
      // from "the run succeeded": stdout is written up front, so a caller
      // that reads the exit status alone sees a complete, valid response for
      // a run that was actually timed out or cancelled.
      return [...stdout, 'trap "exit 0" TERM', ...sleepSlices(60_000), "exit 0"];
    case "slow":
      return sleepSlices(opts.delayMs ?? 5_000).concat("exit 0");
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
  /** The failing template command's stderr, one `printf` per line when asked. */
  const templateStderr = (command: string): string =>
    opts.templateStderrLines === undefined
      ? `printf '%s' ${JSON.stringify(opts.templateStderr ?? `${command} failed at /private/fake/document.hwpx`)} >&2`
      : opts.templateStderrLines.map((line) => `printf '%s\\n' ${JSON.stringify(line)} >&2`).join("; ");
  const fail = (command: string) => opts.failTemplateCommand === command
    ? [templateStderr(command), `exit ${opts.templateFailureCode ?? 3}`]
    : [];
  /**
   * A successful `edit` that publishes the staged input and writes the report.
   * The `-o` and `--report` paths are read from argv rather than assumed, so
   * the report lands where the engine will look for it.
   */
  const reportEdit = opts.editReport === undefined ? null : [
    'prev=""; out=""; rep="";',
    'for a in "$@"; do case "$prev" in -o) out="$a" ;; --report) rep="$a" ;; esac; prev="$a"; done;',
    'cp "$2" "$out";',
    `printf '%s' ${JSON.stringify(opts.editReport)} > "$rep";`,
    "exit 0",
  ];
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      // JSON.stringify around every interpolated value: shell quoting handled
      // once, at the one place values enter the script.
      `echo "$@" >> ${JSON.stringify(logPath)}`,
      'case "$1" in',
      `  --version) echo ${JSON.stringify(`hwp ${opts.version ?? DEFAULT_VERSION}`)}; exit 0 ;;`,
      // `|| exit 1` rather than an unconditional `exit 0`: an unreadable
      // fixture is the only way to give the handshake a failing `edit --help`.
      `  edit) if [ "$2" = "--help" ]; then cat ${JSON.stringify(help)} || exit 1; exit 0; fi; ${reportEdit !== null ? reportEdit.join(" ") : fail("edit").join("; ")} ;;`,
      ...(opts.catStdout === undefined
        ? []
        : [`  cat) printf '%s' ${JSON.stringify(opts.catStdout)}; exit 0 ;;`]),
      ...(opts.info === undefined && opts.infoBodyStats === undefined && opts.failBodyStats !== true
        ? []
        : [`  info) case " $* " in *" --body-stats "*)
        ${opts.failBodyStats === true
          ? "printf '%s' 'body stats failed' >&2; exit 3"
          : `printf '%s' ${JSON.stringify(opts.infoBodyStats ?? opts.info ?? "{}")}; exit 0`} ;;
        *)
        ${opts.info === undefined ? "exit 0" : `printf '%s' ${JSON.stringify(opts.info)}; exit 0`} ;; esac ;;`]),
      ...(opts.failTemplateCommand === undefined ? [] : [
        `  slots) ${fail("slots").length ? fail("slots").join("; ") : opts.failTemplateCommand === "fill" ? "printf '%s' '{\"placeholders\":[{\"name\":\"title\",\"occurrences\":1}],\"fields\":[]}'; exit 0" : "printf '%s' '{\"placeholders\":[],\"fields\":[]}'; exit 0"} ;;`,
        `  fields) ${fail("fields").length ? fail("fields").join("; ") : opts.failTemplateCommand === "edit" ? "printf '%s' '[{\"name\":\"approval\",\"kind\":\"text\",\"ctrl_id\":\"1\",\"value\":\"\"}]'; exit 0" : "printf '%s' '[]'; exit 0"} ;;`,
        `  fill) ${fail("fill").length ? fail("fill").join("; ") : "printf '%s' '{\"replaced\":0,\"counts\":{}}'; exit 0"} ;;`,
        `  template) ${fail("template").length ? fail("template").join("; ") : "exit 0"} ;;`,
        `  lint) ${fail("lint").length ? fail("lint").join("; ") : "printf '%s' '{\"contract\":\"hwp-lint-report-v1\",\"schema_version\":\"1.0\",\"findings\":[]}'; exit 0"} ;;`,
        `  new) if [ "$2" = "--list-templates" ]; then ${fail("list-templates").length ? fail("list-templates").join("; ") : "printf '%s\\t%s\\n' gongmun-basic 공문; exit 0"}; else ${fail("create").length ? fail("create").join("; ") : "exit 0"}; fi ;;`,
      ]),
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

/**
 * Behaviour guards for `scripts/release-helpers.sh`, the shell
 * `.github/workflows/release.yml` sources on the publish path.
 *
 * Why this file exists at all. Until this suite, that shell lived in a YAML
 * heredoc, where nothing could run it, lint it or test it: its first execution
 * was the publish it governs, on the one path where a wrong answer is permanent.
 * Four defects lived there undetected for exactly that reason - a skipped
 * publish that also skipped the build, a prerelease landing on `latest`, a
 * single 404 read as authoritative absence, and a 404 about a peer read as a 404
 * about the probed package.
 *
 * Placement: the same reasoning as `repo-guards.test.ts` and
 * `release-guards.test.ts`. `pnpm -r test`, the command
 * `.github/workflows/ci.yml` runs, only reaches tests inside a workspace
 * package, and the assertions here are about a repository script rather than
 * about `@hwp-editor/server`.
 *
 * How it drives the shell: a stub `npm` and a stub `pnpm` are placed first on
 * PATH. The stub npm replays a scripted sequence of outcomes - one line per
 * `npm install` - so the probe's classification, the two-probe absence rule and
 * the publish argv can all be exercised without a registry. Every stub
 * invocation is appended to a calls log, which is what the argv assertions read.
 *
 * `ABSENCE_CONFIRM_SECONDS=0` and `UNKNOWN_RETRY_SECONDS=0` throughout: the
 * production values are wall-clock waits, and what is under test is that the
 * second probe HAPPENS and that the retries run out, not how long the shell
 * sleeps in between.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HELPERS = join(REPO_ROOT, "scripts", "release-helpers.sh");

/**
 * One stub `npm install` outcome per line, in the wording npm 11.12.1 actually
 * produces. Both 404 spellings name the exact spec, which is what makes the
 * probe's attribution check possible - verified by running the real npm against
 * an unpublished scoped package and a nonexistent version of a published one.
 */
type Outcome =
  /** the install succeeds */
  | "ok"
  /** E404 naming `spec` - not necessarily the spec that was probed */
  | `e404:${string}`
  /** ETARGET naming `spec` */
  | `etarget:${string}`
  /** a 5xx, preceded by enough progress noise to bury a head-of-log print */
  | "noisy5xx";

const STUB_NPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS_NPM"
if [ "$1" != "install" ]; then exit 0; fi
n=$(cat "$COUNTER" 2>/dev/null || echo 0)
n=$(( n + 1 ))
echo "$n" > "$COUNTER"
effect=$(sed -n "\${n}p" "$OUTCOMES")
if [ -z "$effect" ]; then effect=$(tail -n 1 "$OUTCOMES"); fi
kind=\${effect%%:*}
spec=\${effect#*:}
case "$kind" in
  ok) exit 0 ;;
  e404)
    echo "npm error code E404"
    echo "npm error 404 Not Found - GET https://registry.npmjs.org/whatever"
    echo "npm error 404  The requested resource '$spec' could not be found or you do not have permission to access it."
    exit 1 ;;
  etarget)
    echo "npm error code ETARGET"
    echo "npm error notarget No matching version found for $spec."
    exit 1 ;;
  noisy5xx)
    i=0
    while [ "$i" -lt 60 ]; do echo "npm http fetch GET 200 https://registry.npmjs.org/noise-$i"; i=$(( i + 1 )); done
    echo "npm error code E503"
    echo "npm error 503 Service Unavailable"
    exit 1 ;;
esac
exit 1
`;

const STUB_PNPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS_PNPM"
exit 0
`;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  /** Argv of every stub `npm` invocation, in order. */
  npmCalls: string[];
  /** Argv of every stub `pnpm` invocation, in order. */
  pnpmCalls: string[];
}

/**
 * Source the helpers and run `snippet` under the shell GitHub Actions uses for
 * a `run:` block (`bash -e -o pipefail`), with the stubs first on PATH.
 *
 * The `-e` matters: several helpers return non-zero as a meaningful answer
 * rather than as a failure, and a snippet that calls them bare would abort the
 * shell. The workflow calls them from `if` conditions for that reason, and so
 * do the snippets below.
 */
function runHelpers(snippet: string, outcomes: Outcome[] = [], env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "hwped-release-helpers-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of [
    ["npm", STUB_NPM],
    ["pnpm", STUB_PNPM],
  ] as const) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  const outcomesFile = join(dir, "outcomes");
  writeFileSync(outcomesFile, `${outcomes.join("\n")}\n`);
  const callsNpm = join(dir, "calls-npm");
  const callsPnpm = join(dir, "calls-pnpm");
  writeFileSync(callsNpm, "");
  writeFileSync(callsPnpm, "");

  // spawnSync rather than execFileSync because stderr is evidence on the
  // success path too: the probe prints the tail of a failed install's log there
  // while still returning a status the caller handles.
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", `. "${HELPERS}"\n${snippet}\n`], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      ABSENCE_CONFIRM_SECONDS: "0",
      UNKNOWN_RETRY_SECONDS: "0",
      OUTCOMES: outcomesFile,
      COUNTER: join(dir, "counter"),
      CALLS_NPM: callsNpm,
      CALLS_PNPM: callsPnpm,
      ...env,
    },
  });
  if (result.error !== undefined) throw result.error;
  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const lines = (path: string) =>
    readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  return { status, stdout, stderr, npmCalls: lines(callsNpm), pnpmCalls: lines(callsPnpm) };
}

/** Run `registry_probe` and print its numeric answer, which is the whole result. */
const PROBE = 'status=0\nregistry_probe "$NAME" "$VER" || status=$?\necho "probe=$status"';

const PROBE_ENV = { NAME: "@hwp-editor/react", VER: "1.0.0" };

describe("registry_probe: what counts as absence", () => {
  it("answers 0 when the exact version installs", () => {
    const run = runHelpers(PROBE, ["ok"], PROBE_ENV);
    expect(run.stdout).toContain("probe=0");
  });

  it("answers 44 on an E404 naming the probed package at the probed version", () => {
    const run = runHelpers(PROBE, ["e404:@hwp-editor/react@1.0.0"], PROBE_ENV);
    expect(run.stdout).toContain("probe=44");
  });

  it("answers 44 on an ETARGET naming the probed package at the probed version", () => {
    const run = runHelpers(PROBE, ["etarget:@hwp-editor/react@1.0.0"], PROBE_ENV);
    expect(run.stdout).toContain("probe=44");
  });

  it("does NOT answer 44 when the 404 is about a different package", () => {
    // The defect this closes: npm 7+ auto-installs peerDependencies, so a bare
    // probe of react also fetches core, react and react-dom. A code-only match
    // reads core's momentary 404 as "react is not there" and licenses a
    // re-publish of a react that already exists. 1 means "unknown", which
    // `already_published` escalates into a failed job rather than a publish.
    const run = runHelpers(PROBE, ["e404:@hwp-editor/core@^1.0.0"], PROBE_ENV);
    expect(run.stdout).toContain("probe=1");
    expect(run.stdout).not.toContain("probe=44");
  });

  it("answers 1 on a 5xx, which is a network fact and not an absence fact", () => {
    const run = runHelpers(PROBE, ["noisy5xx"], PROBE_ENV);
    expect(run.stdout).toContain("probe=1");
  });

  it("omits peers from the probe install, so no peer can be fetched at all", () => {
    const run = runHelpers(PROBE, ["ok"], PROBE_ENV);
    expect(run.npmCalls).toHaveLength(1);
    expect(run.npmCalls[0]).toContain("--omit=peer");
    expect(run.npmCalls[0]).toContain("@hwp-editor/react@1.0.0");
  });

  it("prints the end of the failure log, where npm writes its error block", () => {
    // npm writes progress noise first and the cause last, so a head-of-log
    // print leaves a halted release with everything except the reason.
    const run = runHelpers(PROBE, ["noisy5xx"], PROBE_ENV);
    expect(run.stderr).toContain("npm error code E503");
    expect(run.stderr).not.toContain("noise-0");
  });
});

/** Report which branch `already_published` took, without tripping `set -e`. */
const ALREADY =
  'if already_published "$NAME" "$VER"; then echo "answer=published"; else echo "answer=absent"; fi';

describe("already_published: one 404 is not absence", () => {
  it("concludes absence only after a second 404 past the packument max-age", () => {
    const run = runHelpers(
      ALREADY,
      ["e404:@hwp-editor/react@1.0.0", "e404:@hwp-editor/react@1.0.0"],
      PROBE_ENV,
    );
    expect(run.stdout).toContain("answer=absent");
    expect(run.npmCalls).toHaveLength(2);
  });

  it("concludes published when the re-check finds what the first probe missed", () => {
    // The stale-edge case, and the reason the second probe exists. A packument
    // is served `cache-control: public, max-age=300` from a CDN edge, so a
    // re-run started minutes after a successful publish can read 404 for a
    // version that is permanently spent. Under a single-404 rule this answered
    // "absent" and re-published, leaving the conflicting provenance
    // npm/cli#7654 describes.
    const run = runHelpers(ALREADY, ["e404:@hwp-editor/react@1.0.0", "ok"], PROBE_ENV);
    expect(run.stdout).toContain("answer=published");
    expect(run.npmCalls).toHaveLength(2);
  });

  it("concludes published from the first successful install, with no re-check", () => {
    const run = runHelpers(ALREADY, ["ok"], PROBE_ENV);
    expect(run.stdout).toContain("answer=published");
    expect(run.npmCalls).toHaveLength(1);
  });

  it("fails the job when neither installable nor 404 can be established", () => {
    const run = runHelpers(ALREADY, ["noisy5xx"], PROBE_ENV);
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("answer=absent");
    expect(run.stderr).toContain("absence is not established");
  });
});

describe("dist_tag_for: a prerelease never lands on latest", () => {
  it("routes a prerelease version to next", () => {
    expect(runHelpers('dist_tag_for "1.0.0-rc.1"').stdout.trim()).toBe("next");
  });

  it("routes a release version to latest", () => {
    expect(runHelpers('dist_tag_for "1.0.0"').stdout.trim()).toBe("latest");
  });

  it("agrees with is_prerelease, which drives the GitHub Release flag", () => {
    const run = runHelpers(
      [
        'for v in 1.0.0 1.0.0-rc.0 2.3.4 2.3.4-beta.1; do',
        '  if is_prerelease "$v"; then echo "$v pre"; else echo "$v release"; fi',
        'done',
      ].join("\n"),
    );
    expect(run.stdout.trim().split("\n")).toEqual([
      "1.0.0 release",
      "1.0.0-rc.0 pre",
      "2.3.4 release",
      "2.3.4-beta.1 pre",
    ]);
  });
});

/**
 * `publish_package` needs a `packages/<pkg>` to cd into and the two variables
 * the workflow exports through `$GITHUB_ENV`.
 */
function publishRun(pkg: string, version: string, outcomes: Outcome[]): Run {
  const snippet = `mkdir -p packages/${pkg}\nmkdir -p packs\nPACKS="$PWD/packs"\nVERSION="${version}"\npublish_package ${pkg}`;
  return runHelpers(snippet, outcomes);
}

describe("publish_package: a skipped publish is not a skipped build", () => {
  it("packs even when the version is already on the registry", () => {
    // `pnpm pack` fires `prepack`, which is what builds packages/core/dist -
    // and react's tsup dts leg resolves @hwp-editor/core through the workspace
    // symlink into that directory. Returning early on the skip path left core
    // unbuilt on exactly the recovery D-11 and D-12 exist for, and react's
    // prepack then died with TS2307. The retry path could never complete a
    // partial release.
    const run = publishRun("core", "1.0.0", ["ok"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[skip]");
    expect(run.pnpmCalls.join("\n")).toContain("pack");
    expect(run.npmCalls.some((call) => call.startsWith("publish"))).toBe(false);
  });

  it("packs and then publishes when the version is absent", () => {
    const run = publishRun("core", "1.0.0", [
      "e404:@hwp-editor/core@1.0.0",
      "e404:@hwp-editor/core@1.0.0",
    ]);
    expect(run.status).toBe(0);
    expect(run.pnpmCalls.join("\n")).toContain("pack");
    expect(run.npmCalls.filter((call) => call.startsWith("publish"))).toHaveLength(1);
  });

  it("passes --tag latest explicitly for a release version", () => {
    const run = publishRun("core", "1.0.0", [
      "e404:@hwp-editor/core@1.0.0",
      "e404:@hwp-editor/core@1.0.0",
    ]);
    const publish = run.npmCalls.find((call) => call.startsWith("publish"));
    expect(publish).toContain("--tag latest");
    expect(publish).toContain("--provenance");
  });

  it("passes --tag next for a prerelease version", () => {
    // npm's default is `latest`, and the trigger glob `v*.*.*` matches
    // `v1.0.0-rc.1` by design, so without this an approved candidate becomes
    // what every plain `npm install` resolves - undoable only by a manually
    // authenticated human, because `npm dist-tag` is outside a trusted
    // publisher's allowed actions.
    const run = publishRun("react", "1.0.0-rc.1", [
      "e404:@hwp-editor/react@1.0.0-rc.1",
      "e404:@hwp-editor/react@1.0.0-rc.1",
    ]);
    const publish = run.npmCalls.find((call) => call.startsWith("publish"));
    expect(publish).toContain("--tag next");
    expect(publish).not.toContain("--tag latest");
  });
});

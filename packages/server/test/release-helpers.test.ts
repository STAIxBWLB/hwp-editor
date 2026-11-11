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
 * about the probed package. The last of those took two attempts to close: the
 * first fix leaned on `--omit=peer`, which turned out to govern installation
 * rather than resolution, so the `peer404` case below reproduces npm's real
 * output shape instead of the shape that fix assumed.
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
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  /**
   * The install fails resolving a PEER named `spec`, while the probed package
   * itself resolves fine. Reproduced verbatim against npm 11 by packing a
   * tarball whose only peerDependencies entry is a nonexistent scoped package
   * and installing it with --omit=peer: the peer never lands in node_modules
   * and the install fails anyway, because the flag governs installation and not
   * resolution. The warn block names the ROOT of the resolution - the probed
   * spec - which is what a whole-log search for that spec matches.
   */
  | `peer404:${string}`
  /** a 5xx, preceded by enough progress noise to bury a head-of-log print */
  | "noisy5xx";

const STUB_NPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS_NPM"
# Which of the three OIDC inputs this invocation's environment carried, one
# line per invocation and in the same order as the calls log. The fallback has
# to see none of them: npm exchanges them for a token on every dist-tag call
# and installs that token at a config layer that outranks --userconfig.
seen=
[ -n "\${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && seen="$seen url"
[ -n "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] && seen="$seen request_token"
[ -n "\${NPM_ID_TOKEN:-}" ] && seen="$seen id_token"
printf 'oidc:%s\\n' "$seen" >> "$CALLS_NPM_OIDC"
case "$1" in
  dist-tag)
    # Scripted separately from \`install\`: the OIDC attempt and the token
    # fallback are two different credentials on the same command, so the
    # sequence of dist-tag outcomes is what the fallback tests drive. With no
    # outcome written the attempt succeeds, which is the OIDC path.
    d=$(cat "$DIST_TAG_COUNTER" 2>/dev/null || echo 0)
    d=$(( d + 1 ))
    echo "$d" > "$DIST_TAG_COUNTER"
    dtag=$(sed -n "\${d}p" "$DIST_TAG_OUTCOMES" 2>/dev/null)
    if [ -z "$dtag" ]; then dtag=$(tail -n 1 "$DIST_TAG_OUTCOMES" 2>/dev/null); fi
    if [ "$dtag" = "denied" ]; then
      echo "npm error code E403"
      echo "npm error 403 Forbidden - the trusted publisher cannot manage dist-tags for this package"
      echo "npm error Ask a package maintainer to enable Allow npm dist-tag for this configuration."
      exit 1
    fi
    exit 0 ;;
  --userconfig)
    # The token attempt: npm skips the OIDC exchange only when no OIDC input is
    # in the environment, so a case that reaches here with one set is the bug
    # the \`oidc:\` log exists to expose. It still answers success, because the
    # test asserting the refusal belongs to the OIDC attempt.
    exit 0 ;;
  install) ;;
  *) exit 0 ;;
esac
for a in "$@"; do probed="$a"; done
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
  peer404)
    echo "npm warn ERESOLVE overriding peer dependency"
    echo "npm warn While resolving: $probed"
    echo "npm warn Could not resolve dependency:"
    echo "npm warn peer $spec from $probed"
    echo "npm error code E404"
    echo "npm error 404 Not Found - GET https://registry.npmjs.org/whatever - Not found"
    echo "npm error 404"
    echo "npm error 404  The requested resource '$spec' could not be found or you do not have permission to access it."
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
  /**
   * Which OIDC inputs each stub `npm` invocation saw, index-aligned with
   * `npmCalls`: `oidc:` alone, or `oidc: url request_token id_token`.
   */
  npmOidc: string[];
  /** Argv of every stub `pnpm` invocation, in order. */
  pnpmCalls: string[];
}

/**
 * The three inputs npm exchanges for an OIDC token, as `release.yml`'s publish
 * job carries them: `id-token: write` gives the runner the two request
 * variables, and npm accepts `NPM_ID_TOKEN` as a ready-made token instead.
 *
 * `runHelpers` strips them from the inherited environment and a case has to
 * pass them back, so a Mac whose shell happens to export one cannot make the
 * fallback's assertion pass for the wrong reason.
 */
const OIDC_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/pipeline?",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
  NPM_ID_TOKEN: "oidc-id-token",
};
const ALL_OIDC_SEEN = "oidc: url request_token id_token";
const NO_OIDC_SEEN = "oidc:";

/**
 * Source the helpers and run `snippet` under the shell GitHub Actions uses for
 * a `run:` block (`bash -e -o pipefail`), with the stubs first on PATH.
 *
 * The `-e` matters: several helpers return non-zero as a meaningful answer
 * rather than as a failure, and a snippet that calls them bare would abort the
 * shell. The workflow calls them from `if` conditions for that reason, and so
 * do the snippets below.
 */
/**
 * The stub bin directory, written ONCE for the whole file.
 *
 * The stubs are byte-identical across every case - all of the variation travels
 * in environment variables - so writing them per call bought nothing and cost a
 * great deal: a freshly created executable pays a first-execution security scan
 * on macOS, measured at roughly 200 ms per `runHelpers` call, and this file's
 * spawn load is what pushed `lifecycle.test.ts`'s timing assertions over their
 * budget when vitest ran the two files concurrently. Hoisting the write took the
 * file from 4.8 s to 0.6 s with no case removed.
 */
const STUB_BIN = mkdtempSync(join(tmpdir(), "hwped-release-stubs-"));
for (const [name, body] of [
  ["npm", STUB_NPM],
  ["pnpm", STUB_PNPM],
] as const) {
  const path = join(STUB_BIN, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runHelpers(
  snippet: string,
  outcomes: Outcome[] = [],
  env: Record<string, string> = {},
  distTag: ("ok" | "denied")[] = [],
): Run {
  const dir = mkdtempSync(join(tmpdir(), "hwped-release-helpers-"));
  const outcomesFile = join(dir, "outcomes");
  writeFileSync(outcomesFile, `${outcomes.join("\n")}\n`);
  const distTagFile = join(dir, "dist-tag-outcomes");
  writeFileSync(distTagFile, `${distTag.join("\n")}\n`);
  const callsNpm = join(dir, "calls-npm");
  const callsNpmOidc = join(dir, "calls-npm-oidc");
  const callsPnpm = join(dir, "calls-pnpm");
  writeFileSync(callsNpm, "");
  writeFileSync(callsNpmOidc, "");
  writeFileSync(callsPnpm, "");

  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(OIDC_ENV)) delete inherited[name];

  // spawnSync rather than execFileSync because stderr is evidence on the
  // success path too: the probe prints the tail of a failed install's log there
  // while still returning a status the caller handles.
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", `. "${HELPERS}"\n${snippet}\n`], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...inherited,
      PATH: `${STUB_BIN}:${process.env["PATH"] ?? ""}`,
      ABSENCE_CONFIRM_SECONDS: "0",
      UNKNOWN_RETRY_SECONDS: "0",
      OUTCOMES: outcomesFile,
      COUNTER: join(dir, "counter"),
      DIST_TAG_OUTCOMES: distTagFile,
      DIST_TAG_COUNTER: join(dir, "dist-tag-counter"),
      CALLS_NPM: callsNpm,
      CALLS_NPM_OIDC: callsNpmOidc,
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
  return {
    status,
    stdout,
    stderr,
    npmCalls: lines(callsNpm),
    npmOidc: lines(callsNpmOidc),
    pnpmCalls: lines(callsPnpm),
  };
}

/** Run `registry_probe` and print its numeric answer, which is the whole result. */
const PROBE = 'status=0\nregistry_probe "$NAME" "$VER" || status=$?\necho "probe=$status"';

const PROBE_ENV = { NAME: "@hwp-editor/react", VER: "1.0.0" };

/** Report which branch `already_published` took, without tripping `set -e`. */
const ALREADY =
  'if already_published "$NAME" "$VER"; then echo "answer=published"; else echo "answer=absent"; fi';

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
    const run = runHelpers(PROBE, ["e404:@hwp-editor/core@^1.0.0"], PROBE_ENV);
    expect(run.stdout).toContain("probe=1");
    expect(run.stdout).not.toContain("probe=44");
  });

  it("does NOT answer 44 when a PEER 404s and the log still names the probed spec", () => {
    // The defect this closes, and the one --omit=peer does not: that flag
    // governs installation, not resolution, so npm still resolves the peer and
    // still fails the install on its 404. npm's warn block names the ROOT of
    // the resolution - here `@hwp-editor/react@1.0.0` - so a whole-log search
    // for the probed spec matches a line that says nothing about whether the
    // probed package exists. Reading that as absence licenses a re-publish of
    // an already-spent react on a recovery run.
    const run = runHelpers(PROBE, ["peer404:@hwp-editor/core@^1.0.0"], PROBE_ENV);
    expect(run.stdout).toContain("probe=1");
    expect(run.stdout).not.toContain("probe=44");
  });

  it("fails the job rather than licensing a publish when a peer 404s", () => {
    const run = runHelpers(ALREADY, ["peer404:@hwp-editor/core@^1.0.0"], PROBE_ENV);
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("answer=absent");
  });

  it("answers 1 on a 5xx, which is a network fact and not an absence fact", () => {
    const run = runHelpers(PROBE, ["noisy5xx"], PROBE_ENV);
    expect(run.stdout).toContain("probe=1");
  });

  it("probes the exact spec, omitting peers from the install for speed only", () => {
    // --omit=peer keeps react and react-dom out of the probe's node_modules. It
    // does NOT stop npm resolving them, and it is not what makes the 44
    // trustworthy - the case above is.
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
    // authenticated human, because move_next_tag corrects `next` and only for a
    // stable release, and no step of this workflow touches `latest` at all.
    const run = publishRun("react", "1.0.0-rc.1", [
      "e404:@hwp-editor/react@1.0.0-rc.1",
      "e404:@hwp-editor/react@1.0.0-rc.1",
    ]);
    const publish = run.npmCalls.find((call) => call.startsWith("publish"));
    expect(publish).toContain("--tag next");
    expect(publish).not.toContain("--tag latest");
  });
});

describe("move_next_tag: next follows a stable release (#38, #45 item 5)", () => {
  const TOKEN = "npm_test_token_value_1234567890";
  const PKGS = ["core", "react", "server"];

  it("moves next on all three packages with OIDC, configuring no credential", () => {
    // #45 item 5: npm 11.21.0+ authenticates `npm dist-tag` with the OIDC
    // identity, so the first attempt must pass no credential at all - a
    // --userconfig with a token in it would be a configured credential, which
    // is what makes npm skip the OIDC exchange.
    const run = runHelpers(
      'move_next_tag "$VER"',
      [],
      { ...OIDC_ENV, VER: "1.2.0", NPM_DIST_TAG_TOKEN: TOKEN },
      ["ok", "ok", "ok"],
    );
    expect(run.status).toBe(0);
    expect(run.npmCalls).toEqual(
      PKGS.map((pkg) => `dist-tag add @hwp-editor/${pkg}@1.2.0 next`),
    );
    expect(run.stdout).toContain("[ok] @hwp-editor/server next -> 1.2.0 (OIDC)");
    expect(run.npmCalls.join("\n")).not.toContain(TOKEN);
    expect(run.stdout).not.toContain("falling back");
    // The attempt that needs the OIDC identity is the one that can see the
    // inputs it is exchanged from.
    expect(run.npmOidc).toEqual(PKGS.map(() => ALL_OIDC_SEEN));
  });

  it("runs the token fallback with none of the OIDC inputs in its environment", () => {
    const run = runHelpers(
      'move_next_tag "$VER"',
      [],
      { ...OIDC_ENV, VER: "1.2.0", NPM_DIST_TAG_TOKEN: TOKEN },
      ["denied"],
    );
    expect(run.status).toBe(0);
    // The bare attempt, then all three through the throwaway userconfig -
    // all three even though OIDC moved none, because a partial pass must not
    // leave one package on an older next.
    expect(run.npmCalls).toHaveLength(4);
    expect(run.npmCalls[0]).toBe("dist-tag add @hwp-editor/core@1.2.0 next");
    expect(run.npmCalls.slice(1).map((call) => call.replace(/--userconfig \S+ /, ""))).toEqual(
      PKGS.map((pkg) => `dist-tag add @hwp-editor/${pkg}@1.2.0 next`),
    );
    expect(run.npmCalls[1]).toMatch(/^--userconfig \S+ dist-tag add /);
    expect(run.stdout).toContain("[ok] @hwp-editor/server next -> 1.2.0 (token)");
    // The token rides in the file, never on the command line (argv shows in
    // process listings and in npm's own logs).
    expect(run.npmCalls.join("\n")).not.toContain(TOKEN);
    // The refusal is printed, because "Allow npm dist-tag is off" and a
    // registry failure need different repairs.
    expect(run.stdout).toContain("::group::npm dist-tag output (OIDC attempt)");
    expect(run.stdout).toContain("the trusted publisher cannot manage dist-tags");
    // And the token attempt sees no OIDC input at all. The userconfig is not
    // enough by itself: `npm dist-tag add` calls #oidc before every fetch and
    // every PUT, and setOidcToken lands at the `cli` config layer, which
    // outranks --userconfig. The exchange would then hand the PUT the very
    // identity the per-package switch just denied - the same E403, `next`
    // unmoved, and release.yml's continue-on-error keeping the job green.
    expect(run.npmOidc).toEqual([ALL_OIDC_SEEN, ...PKGS.map(() => NO_OIDC_SEEN)]);
    // And the userconfig is gone once the helper returns.
    const cfg = run.npmCalls[1]!.split(" ")[1]!;
    expect(existsSync(cfg)).toBe(false);
  });

  it("makes no npm call for a prerelease, which already published under next", () => {
    const run = runHelpers('move_next_tag "$VER"', [], {
      ...OIDC_ENV,
      VER: "1.3.0-rc.0",
      NPM_DIST_TAG_TOKEN: TOKEN,
    });
    expect(run.status).toBe(0);
    expect(run.npmCalls).toEqual([]);
    expect(run.stdout).toContain("[skip] 1.3.0-rc.0 is a prerelease");
  });

  it("warns and skips when OIDC is refused and no token is stored", () => {
    // The packages are published by this point, so this must not fail the job:
    // the warning is the only signal that next still points at the old version.
    const run = runHelpers(
      'move_next_tag "$VER"',
      [],
      { ...OIDC_ENV, VER: "1.2.0", NPM_DIST_TAG_TOKEN: "" },
      ["denied"],
    );
    expect(run.status).toBe(0);
    expect(run.npmCalls).toEqual(["dist-tag add @hwp-editor/core@1.2.0 next"]);
    expect(run.npmOidc).toEqual([ALL_OIDC_SEEN]);
    expect(run.stdout).toContain(
      "::warning::OIDC was refused and NPM_DIST_TAG_TOKEN is not set",
    );
  });
});

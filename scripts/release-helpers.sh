# shellcheck shell=bash
#
# The load-bearing shell of `.github/workflows/release.yml`, in a file rather
# than in a YAML heredoc.
#
# Why it lives here. Every function below decides something irreversible: whether
# a version is already spent, whether a tarball a consumer needs is servable yet,
# and which dist-tag a publish lands on. Inside a workflow heredoc none of that
# can be run, linted or tested - the first execution is the publish itself, on
# the one path where a wrong answer cannot be taken back. Committed here,
# `shellcheck` reads it and `packages/server/test/release-helpers.test.ts` drives
# every branch against a stub `npm` on PATH.
#
# Sourced, never executed: the workflow does `. ./scripts/release-helpers.sh` in
# each step that needs it, because every `run:` block is its own shell. VERSION
# and PACKS come from the workflow's environment (`$GITHUB_ENV`).
#
# Style note: no `local`, and every function prefixes its variables, because
# these run under `bash -e` where an AND-list whose test fails is a job failure.
# Conditions are spelled as `if` blocks for that reason - `[ x ] && return 0` as
# a statement exits the step when the test is false.

# Seconds a negative packument can be served from a CDN edge. Measured against
# registry.npmjs.org: a packument carries `cache-control: public, max-age=300`
# while a tarball is `immutable` (06-RESEARCH.md §6). Overridable so the test
# suite can drive the confirmation path without sleeping.
ABSENCE_CONFIRM_SECONDS="${ABSENCE_CONFIRM_SECONDS:-300}"

# Pause between attempts when a probe answers neither installable nor 404.
# Overridable for the same reason: the test suite drives the give-up path and
# has no interest in the wait.
UNKNOWN_RETRY_SECONDS="${UNKNOWN_RETRY_SECONDS:-10}"

# registry_probe <name> <version>
#   0  -> a real install of that exact version succeeded
#   44 -> the registry said THAT PACKAGE at THAT VERSION is not there
#   1  -> anything else: a blip, a 5xx, a timeout. NOT evidence of absence.
#
# A fresh temp dir AND a fresh cache dir per attempt are both load-bearing
# (release.yml header point 7): --prefer-online revalidates with the origin but
# does not control the CDN edge, and a warm cache can hold a negative packument
# for its five-minute max-age - long enough to outlive the publish that
# invalidated it.
#
# --omit=peer is load-bearing too, and is the whole reason the 44 can be
# attributed. npm 7+ installs peerDependencies automatically, so a bare probe of
# `@hwp-editor/react` also fetches `@hwp-editor/core`, `react` and `react-dom`;
# a 404 for any of those would land in this log and a code-only match would read
# it as "react is not there", licensing a re-publish of a react that already
# exists. With peers omitted and no `dependencies` in any of the three
# manifests, the probed package is the only thing fetched. The name check below
# keeps that attribution true if a manifest ever gains a dependency: npm names
# the exact spec in both wordings - `The requested resource '<spec>' could not be
# found` (E404) and `No matching version found for <spec>.` (ETARGET), both
# verified against npm 11.12.1.
registry_probe() {
  probe_name="$1"
  probe_version="$2"
  probe_dir="$(mktemp -d)"
  probe_cache="$(mktemp -d)"
  probe_log="$(mktemp)"
  if (cd "$probe_dir" && npm install --no-audit --no-fund --no-save \
        --omit=peer --cache "$probe_cache" --prefer-online \
        "$probe_name@$probe_version") >"$probe_log" 2>&1; then
    rm -rf "$probe_dir" "$probe_cache" "$probe_log"
    return 0
  fi
  probe_status=1
  if grep -qE 'npm (error|ERR!) code (E404|ETARGET)' "$probe_log" &&
     grep -qF "$probe_name@$probe_version" "$probe_log"; then
    probe_status=44
  else
    echo "probe of $probe_name@$probe_version failed for a non-404 reason:" >&2
    # tail, not head: npm writes progress noise first and its error block last,
    # so a head would print everything except the cause of a halted release.
    tail -n 40 "$probe_log" >&2
  fi
  rm -rf "$probe_dir" "$probe_cache" "$probe_log"
  return "$probe_status"
}

# already_published <name> <version>
#   0 -> already on the registry, skip the publish
#   1 -> absence established, publish it
# Fails the job on "unknown" (release.yml header point 6). A single flaky
# attempt read as absence is how a re-run re-publishes a version that already
# landed and leaves conflicting provenance on it.
#
# One 404 is not absence. It is one edge's opinion, and that opinion can be a
# cached negative up to ABSENCE_CONFIRM_SECONDS old - so a re-run started
# minutes after a successful publish can read 404 for a version that is
# permanently spent. Absence is therefore concluded only from two 404s separated
# by more than the packument max-age: the second 404 can only come from an entry
# cached after the first probe, so no publish preceding the first probe can be
# hiding behind either one.
#
# The cost is a full ABSENCE_CONFIRM_SECONDS per package on the ordinary path -
# roughly fifteen minutes across the three, inside the publish job's 45-minute
# budget alongside the ten-minute replication wait. It is not gated on
# GITHUB_RUN_ATTEMPT, which was considered and rejected: attempt 1 rules out a
# prior attempt of this run, but not the manual bootstrap publish (D-01), a
# hand-finished release, or a second run against a re-pushed tag, and those are
# exactly the situations where a stale-negative meets an already-spent version.
# A signal that covers only some of the cases would buy speed by narrowing the
# guarantee rather than by keeping it.
already_published() {
  ap_name="$1"
  ap_version="$2"
  ap_confirming=0
  while :; do
    ap_attempt=1
    while :; do
      ap_status=0
      registry_probe "$ap_name" "$ap_version" || ap_status=$?
      if [ "$ap_status" -eq 0 ]; then
        return 0
      fi
      if [ "$ap_status" -eq 44 ]; then
        break
      fi
      if [ "$ap_attempt" -ge 3 ]; then
        echo "cannot tell whether $ap_name@$ap_version is published: $ap_attempt attempts" \
          "answered neither installable nor 404, so absence is not established" >&2
        exit 1
      fi
      ap_attempt=$(( ap_attempt + 1 ))
      sleep "$UNKNOWN_RETRY_SECONDS"
    done
    if [ "$ap_confirming" -eq 1 ]; then
      return 1
    fi
    ap_confirming=1
    echo "$ap_name@$ap_version read as absent; re-checking in ${ABSENCE_CONFIRM_SECONDS}s" \
      "so the answer cannot be a stale negative from a CDN edge"
    sleep "$ABSENCE_CONFIRM_SECONDS"
  done
}

# wait_for_install <name> <version>
# Retries by construction and only ever concludes success, so it needs no
# 404-versus-unknown rule: 5s doubling to a 60s ceiling, ten-minute deadline,
# job failed on the deadline.
wait_for_install() {
  wf_deadline=$(( $(date +%s) + 600 ))
  wf_delay=5
  while :; do
    wf_status=0
    registry_probe "$1" "$2" || wf_status=$?
    if [ "$wf_status" -eq 0 ]; then
      echo "installable: $1@$2"
      return 0
    fi
    if [ "$(date +%s)" -ge "$wf_deadline" ]; then
      echo "timed out waiting for $1@$2 to become installable" >&2
      exit 1
    fi
    echo "$1@$2 not installable yet; retrying in ${wf_delay}s"
    sleep "$wf_delay"
    wf_delay=$(( wf_delay * 2 ))
    if [ "$wf_delay" -gt 60 ]; then
      wf_delay=60
    fi
  done
}

# is_prerelease <version>
# True when the version carries a prerelease identifier. The tag glob `v*.*.*`
# is a glob and not a semver matcher, so `v1.0.0-rc.1` reaches this workflow by
# design; the stop for a mistaken tag is the environment approval, not the
# pattern. VERSION has already been checked against the three manifests by
# scripts/check-publishable.mjs, whose regex admits a prerelease tail after the
# patch and nothing else, so a `-` here is a prerelease identifier and not some
# other punctuation.
is_prerelease() {
  case "$1" in
    *-*) return 0 ;;
    *) return 1 ;;
  esac
}

# dist_tag_for <version>
# The single derivation behind both the npm dist-tag and the GitHub Release's
# prerelease flag. `npm publish` defaults to `latest` when no --tag is passed,
# so an approved RC tag would otherwise put a prerelease on `latest` for every
# consumer - a direct violation of Phase 1's D-01, and one only a manually
# authenticated human can undo, because `npm dist-tag` is not among a trusted
# publisher's allowed actions. The tag is therefore passed explicitly in both
# cases, so npm's default is never what decides. This matches the `next` the
# hand-published RC uses (D-01, plan 06-04).
dist_tag_for() {
  if is_prerelease "$1"; then
    echo next
  else
    echo latest
  fi
}

# publish_package <core|react|server>
# D-09's split: pnpm packs, because pnpm is what substitutes the workspace
# protocol into a real semver range, and the npm CLI uploads that exact tarball,
# because npm is what implements the OIDC exchange and the attestation. No
# --access flag: publishConfig.access travels inside the packed manifest.
#
# The pack runs BEFORE the skip check and unconditionally, and the skip covers
# the publish alone. `pnpm pack` fires `prepack`, which is what builds
# packages/core/dist - and react's tsup config has `dts: true`, so its dts leg
# resolves `@hwp-editor/core` through the workspace symlink into
# packages/core/dist/index.d.ts. Returning early on the skip path left core
# unbuilt on exactly the recovery D-11 and D-12 exist for - core published, a
# later step failed, the operator re-runs on a fresh runner - and react's prepack
# then died with TS2307. A skipped publish must not mean a skipped build.
publish_package() {
  pp_pkg="$1"
  pp_name="@hwp-editor/$pp_pkg"
  ( cd "packages/$pp_pkg" && pnpm pack --pack-destination "$PACKS" )
  if already_published "$pp_name" "$VERSION"; then
    echo "[skip] $pp_name@$VERSION is already on the registry"
    return 0
  fi
  npm publish "$PACKS/hwp-editor-$pp_pkg-$VERSION.tgz" \
    --provenance --tag "$(dist_tag_for "$VERSION")"
}

# Releasing

How `@hwp-editor/core`, `@hwp-editor/react` and `@hwp-editor/server` are released, and what
can and cannot be done about a release that went wrong. It addresses a maintainer with an
authenticated npm session on the `hwp-editor` organization and approval rights on this
repository's `npm-publish` deployment environment. The three packages version in lockstep, so
one tag releases all three.

The release itself carries no stored credential: `.github/workflows/release.yml` publishes
through npm trusted publishing, and the only credential on that path is an OIDC token minted
per run. The steps that need a real npm login are the ones marked manual below, and they are
manual for that reason.

Engine range, for the local checks and for anyone mounting the editor: this repository
supports hwp-cli `>= 0.16.0` and `< 1.0.0`, matching `MIN_VERSION` and `MAX_VERSION_EXCLUSIVE`
in `packages/server/src/cli-engine.ts`. Nothing on the release path provisions or needs the
binary - the real-binary suites self-skip - but a local `pnpm -r test` and the manual half of
the release-candidate check both want one in that range on `HWP_EDITOR_BIN` or on `PATH`.

## The recurring release

Set the version once and use it throughout:

```sh
VERSION=1.0.0
```

### 1. Preflight, on the default branch

Check out the commit to be released, confirm the working tree matches it, and confirm all
three package manifests read `$VERSION`:

```sh
git status --short                      # empty
node -p "['core','react','server'].map(p => require('./packages/'+p+'/package.json').version)"
EXPECTED_VERSION="v$VERSION" node scripts/check-publishable.mjs
node scripts/smoke-consumer.mjs
```

`EXPECTED_VERSION` is optional and skipped when absent, so passing it here runs the same
tag-versus-manifests comparison the workflow will run. The `verify` job re-runs both scripts
against the tagged commit anyway; running them now turns a round trip through Actions into a
few seconds of local time.

### 2. Tag and push

```sh
git tag -a "v$VERSION" -m "v$VERSION"
git push origin "v$VERSION"
```

The tag is what the release binds to. Once a provenance attestation references it, the tag
must never be deleted and re-pushed: a mistake is superseded by a new version, never by moving
a tag.

**Do not push a release tag while another release is pending.** `release.yml` uses one
concurrency group for the whole repository, `release`, with `cancel-in-progress: false`. An
Actions concurrency group holds at most one running and one pending member, and a newly queued
member cancels the pending one even when cancellation is off, so a third tag pushed while one
release runs and another waits drops the middle one. The constant group is still the right
trade, and `release.yml`'s concurrency comment records why: a per-ref group lets two releases
overlap, and with an approval gate that is ordinary rather than exotic - an older run finishing
last moves `latest` backward, which this workflow cannot undo, because `npm dist-tag` is
outside a trusted publisher's allowed actions and reversing it needs a 2FA-authenticated human.
A dropped pending run, by contrast, published nothing, spent no version number, and is
recovered by re-running it.

### 3. Watch the `verify` job

It re-runs `pnpm -r build`, `pnpm -r typecheck` and `pnpm -r test` on the tagged commit in a
single cell (Node 22 with the workspace's own React 19), then runs
`scripts/check-publishable.mjs` with `EXPECTED_VERSION` set to the tag name, then
`scripts/smoke-consumer.mjs`. A tag whose version disagrees with any of the three manifests
fails here, before anything is uploaded.

### 4. Approve the deployment

The `publish` job targets the `npm-publish` environment and sits at **Waiting** until one
required reviewer approves it. GitHub fails a deployment left unapproved for 30 days.

This approval is the last reversible moment in the release. Everything after it is permanent:
every version number published is permanently consumed, whether or not the publish that
consumed it was the one intended.

### 5. Watch the `publish` job

In order:

- It installs `npm@^11.5.1` on the runner and prints `npm --version`. Node 22 bundles an npm
  from the 10.x line, which predates trusted publishing; the printed version is the job log's
  only evidence that the CLI can perform the OIDC exchange at all.
- It derives the version from the tag and packs and publishes core, then waits, then publishes
  react and server. The shell that does this is `scripts/release-helpers.sh`, sourced by each
  step - read it there, not in the workflow file.
- Per package, `publish_package` runs `pnpm pack` first and unconditionally, then the
  already-published check, then `npm publish <tarball> --provenance --tag <tag>`. The pack is
  unconditional because it fires `prepack`, which is what builds `packages/core/dist`; a
  skipped publish must not mean a skipped build, or react's declaration build fails on a
  re-run.
- The already-published check concludes "not published" only from two registry 404s separated
  by more than `ABSENCE_CONFIRM_SECONDS` (300s, the measured packument `max-age`), so budget
  about five minutes per package on the ordinary path. A probe that answers neither
  "installable" nor 404 is a network fact, not an absence fact, and fails the job rather than
  licensing a re-publish onto a spent version number.
- Between core and the other two, `wait_for_install` performs a **real install** of
  `@hwp-editor/core@$VERSION` into a fresh temp directory with a fresh cache, backing off from
  5s to a 60s ceiling against a ten-minute deadline. An install rather than a metadata check
  because a packument and a tarball are different cache objects with different lifetimes, so
  metadata can go green while the bytes a consumer needs are not yet servable.
- The dist-tag is always passed explicitly: a version carrying a prerelease identifier
  publishes under `next`, every other version under `latest`. npm's default never decides.

The job's budget is `timeout-minutes: 45`, which contains three absence confirmations, the
replication wait and three publishes.

### 6. Verify after publish

Three checks, all of them worth running:

```sh
node scripts/smoke-registry.mjs "$VERSION"
```

installs `@hwp-editor/react` and `@hwp-editor/server` from the registry at that exact version
**without naming core**, so the peer has to arrive on its own, and asserts core arrives exactly
once, at the expected version, declaring the expected range.

```sh
mkdir /tmp/hwped-audit && cd /tmp/hwped-audit && npm init -y
npm install "@hwp-editor/core@$VERSION" "@hwp-editor/react@$VERSION" "@hwp-editor/server@$VERSION"
npm audit signatures
```

Then open each package page on npmjs.com and confirm the **Provenance** badge. That third
check is not decoration: publishing is `pnpm pack` followed by `npm publish` on the resulting
tarball, and whether `--provenance` produces a real attestation for a pre-packed tarball was
never established before the first release. This is the check that settles it.

### 7. Move the `next` dist-tag - manual, authenticated

```sh
npm dist-tag add "@hwp-editor/core@$VERSION" next
npm dist-tag add "@hwp-editor/react@$VERSION" next
npm dist-tag add "@hwp-editor/server@$VERSION" next
npm dist-tag ls @hwp-editor/core          # confirm: latest and next both at $VERSION
```

**This step is not in the workflow and cannot be.** A trusted publisher's allowed actions cover
publishing only (`npm publish`, `npm stage publish`); `npm dist-tag` is not among them, so an
OIDC token cannot authorize it. Automating it would mean storing a long-lived npm token in this
repository, which would remove the one property the whole release path exists to have. Run it
from an `npm login` session; the organization is set to `auth-and-writes`, so expect a 2FA
prompt.

Skipping this leaves `npm install @hwp-editor/core@next` handing people a stale prerelease
after a stable release exists.

### 8. Release notes

The `release-notes` job creates the GitHub Release for the tag with `gh release create
--generate-notes --verify-tag`, adding `--prerelease --latest=false` for a prerelease version
from the same derivation that chose the npm dist-tag. It skips if a Release already exists for
the tag, so a re-run does not fail on a duplicate name.

This repository keeps no `CHANGELOG.md` by decision. The Release body is the changelog, and it
is the place to edit when the generated notes need help.

### If a release halts partway

Use GitHub Actions' **Re-run failed jobs**, and nothing else.

- A re-run uses the same `GITHUB_SHA` and `GITHUB_REF` as the original event, so the OIDC
  claims still match the trusted-publisher binding and the provenance record still names the
  same commit.
- Only failed jobs re-run. A `verify` that already passed is not re-paid for.
- The environment approval is requested again. That is a feature: the second approval is a
  human confirming that a partial publish should resume.
- The publish steps skip any package version already on the registry, which is what makes
  resuming safe rather than a second attempt at a spent version.
- Re-runs are available for 30 days after the original run.

Two things that are **not** recovery paths:

- **Deleting and re-pushing the tag.** Provenance records already reference it.
- **Hand-publishing the packages the workflow did not reach.** That would be the one publish in
  the release carrying no provenance, which is precisely the property the release path exists
  to guarantee.

## Rollback

Read this first: **the only lever that actually replaces broken code is a patch release.**
Everything else redirects, warns, or removes - none of it repairs what someone already
installed.

| Lever | Command | What it does | Its limit |
|---|---|---|---|
| Deprecate | `npm deprecate "@hwp-editor/core@1.0.0" "<message>"` | Prints a warning you write, on install and on the package page | The version stays fully installable; nothing is repaired |
| Move `latest` back | `npm dist-tag add "@hwp-editor/core@<older>" latest` | Redirects new bare installs to an earlier version | The bad version stays resolvable by exact specifier and by any range matching it - and at `1.0.0` there is no older version to move to, so this lever does not exist yet |
| Patch release | Bump the three manifests, tag, release | Replaces the broken code, for anyone on a range that picks it up | Costs a version number and a full release cycle; anyone pinned to the exact bad version stays there |
| Unpublish | `npm unpublish "@hwp-editor/core@1.0.0"` | Removes the version from the registry | Under 72 hours only, and see below - this is not a lever this project can use |

Three limits above are easy to lose and expensive to rediscover mid-incident:

- **Deprecation does not remove anything.** The version installs exactly as before; the only
  change is a warning line, and only for people who read it.
- **Moving `latest` back does not exist at the first release.** It becomes available at
  `1.0.1`. Even after that, it redirects only bare installs: `@hwp-editor/core@1.0.0` and any
  range that matches `1.0.0` still resolve to the bad version.
- **Unpublishing is not a rollback lever.** npm's window is 72 hours. Beyond it, unpublishing
  additionally requires no dependents in the public registry, fewer than 300 downloads in the
  last week, **and a single owner or maintainer** - and this organization has two owners,
  `staix` and `staix-npm`, so that path is already closed. Either way the version number stays
  permanently consumed and can never be reused, so unpublishing costs the number and removes
  the code that at least worked for whoever had it.

One operational prerequisite for all of this: both `npm deprecate` and `npm dist-tag` need an
authenticated npm session with two-factor authentication, not the release workflow's
credentials, which cannot perform either. Confirm `npm whoami` answers before the session is
needed, rather than during an incident.


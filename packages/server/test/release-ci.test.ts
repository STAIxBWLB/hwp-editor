import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = new URL("../../../scripts/release-ci.mjs", import.meta.url);
const { verifyReleaseCi } = await import(script.href);
const TAG = "a".repeat(40);
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
const TREE = "d".repeat(40);
const REPO = "owner/repo";

type Row = Record<string, unknown>;
const run = (sha: string): Row => ({
  head_sha: sha, path: ".github/workflows/ci.yml", status: "completed",
  conclusion: "success", repository: { full_name: REPO }, check_suite_id: 22,
});
const check = (sha: string): Row => ({
  name: "ci-ok", head_sha: sha, app: { slug: "github-actions" },
  status: "completed", conclusion: "success",
});
const pull = (): Row => ({
  number: 7, merged_at: "2026-11-13T00:11:07Z", merge_commit_sha: TAG,
  head: { sha: HEAD }, base: { ref: "main", repo: { full_name: REPO } },
});

/** API-shaped fixtures; no GitHub requests or credential are used by this suite. */
function fixture() {
  const runs: Record<string, Row[]> = {};
  const checks: Record<string, Row[]> = {};
  const trees: Record<string, string> = { [TAG]: TREE, [HEAD]: TREE };
  const pulls: Row[] = [];
  const calls: string[] = [];
  const api = async (route: string): Promise<unknown> => {
    calls.push(route);
    const url = new URL(route, "https://api.github.test/");
    const page = Number(url.searchParams.get("page") ?? 1);
    const paginate = (rows: Row[]): Row[] => rows.slice((page - 1) * 100, page * 100);
    if (url.pathname.endsWith("/actions/workflows/ci.yml/runs")) {
      return { workflow_runs: paginate(runs[url.searchParams.get("head_sha")!] ?? []) };
    }
    const suite = /check-suites\/(\d+)\/check-runs$/.exec(url.pathname);
    if (suite) return { check_runs: paginate(checks[suite[1]!] ?? []) };
    if (url.pathname.endsWith("/pulls")) return paginate(pulls);
    const sha = url.pathname.split("/").at(-1)!;
    if (trees[sha]) return { sha, commit: { tree: { sha: trees[sha] } } };
    throw new Error(`Unexpected API route: ${route}`);
  };
  const verify = () => verifyReleaseCi({ repo: REPO, sha: TAG, api });
  return { runs, checks, trees, pulls, calls, api, verify };
}

describe("release CI evidence (#45)", () => {
  it("accepts exact-SHA ci-ok from the CI workflow without reading a PR", async () => {
    const f = fixture();
    f.runs[TAG] = [run(TAG)]; f.checks["22"] = [check(TAG)];
    expect(await f.verify()).toMatchObject({ proof: "exact_sha", sha: TAG });
    expect(f.calls.some(route => route.includes("/pulls"))).toBe(false);
  });

  it("accepts a merged main PR with the tag merge SHA, identical trees and successful head CI", async () => {
    const f = fixture();
    f.pulls.push(pull()); f.runs[HEAD] = [run(HEAD)]; f.checks["22"] = [check(HEAD)];
    expect(await f.verify()).toEqual({ proof: "merged_pr_tree", sha: TAG, head: HEAD, tree: TREE, number: 7 });
  });

  it.each([
    { head_sha: OTHER }, { path: ".github/workflows/other.yml" },
    { status: "in_progress" }, { conclusion: "failure" }, { conclusion: "cancelled" },
    { conclusion: "skipped" }, { repository: { full_name: "other/repo" } },
    { check_suite_id: null },
  ])("rejects wrong, incomplete or unsuccessful CI-workflow evidence: %j", async (change) => {
    const f = fixture();
    f.runs[TAG] = [{ ...run(TAG), ...change }]; f.checks["22"] = [check(TAG)];
    await expect(f.verify()).rejects.toThrow("No successful CI-workflow ci-ok on exact tag SHA");
  });

  it.each([
    { name: "other" }, { head_sha: OTHER }, { app: { slug: "other-app" } },
    { status: "in_progress" }, { conclusion: "failure" }, { conclusion: "cancelled" },
    { conclusion: "skipped" },
  ])("rejects a non-proof ci-ok check: %j", async (change) => {
    const f = fixture();
    f.runs[TAG] = [run(TAG)]; f.checks["22"] = [{ ...check(TAG), ...change }];
    await expect(f.verify()).rejects.toThrow("no merged-PR tree proof");
  });

  it.each([
    { merged_at: null }, { merge_commit_sha: OTHER },
    { base: { ref: "other", repo: { full_name: REPO } } },
    { base: { ref: "main", repo: { full_name: "other/repo" } } },
  ])("rejects a PR that is not the tag's merged main PR: %j", async (change) => {
    const f = fixture();
    f.pulls.push({ ...pull(), ...change }); f.runs[HEAD] = [run(HEAD)]; f.checks["22"] = [check(HEAD)];
    await expect(f.verify()).rejects.toThrow("no merged PR into main has this merge_commit_sha");
  });

  it("rejects a merged PR with another tree even if its CI passed", async () => {
    const f = fixture();
    f.pulls.push(pull()); f.trees[HEAD] = OTHER;
    f.runs[HEAD] = [run(HEAD)]; f.checks["22"] = [check(HEAD)];
    await expect(f.verify()).rejects.toThrow("head tree differs from the tag tree");
  });

  it("rejects same-tree PRs without successful head CI", async () => {
    const f = fixture(); f.pulls.push(pull());
    await expect(f.verify()).rejects.toThrow("same tree but no successful CI-workflow ci-ok");
  });

  it("does not accept successful CI on another SHA", async () => {
    const f = fixture();
    f.runs[OTHER] = [run(OTHER)]; f.checks["22"] = [check(OTHER)];
    await expect(f.verify()).rejects.toThrow("No successful");
  });

  it("reads later pages of both runs and checks", async () => {
    const f = fixture();
    f.runs[TAG] = [...Array.from({ length: 100 }, () => run(OTHER)), run(TAG)];
    f.checks["22"] = [...Array.from({ length: 100 }, () => check(OTHER)), check(TAG)];
    expect(await f.verify()).toMatchObject({ proof: "exact_sha" });
    expect(f.calls.filter(route => route.includes("page=2"))).toHaveLength(2);
  });

  it("fails closed on incomplete pagination", async () => {
    const f = fixture();
    f.runs[TAG] = Array.from({ length: 1000 }, () => run(OTHER));
    await expect(f.verify()).rejects.toThrow("1000-entry evidence limit");
  });

  it("fails closed on API failures and malformed lists or trees", async () => {
    await expect(verifyReleaseCi({ repo: REPO, sha: TAG, api: async () => { throw new Error("HTTP 403"); } })).rejects.toThrow("HTTP 403");
    await expect(verifyReleaseCi({ repo: REPO, sha: TAG, api: async () => ({ workflow_runs: null }) })).rejects.toThrow("Malformed API list");
    const f = fixture(); f.trees[TAG] = "not-a-tree";
    await expect(f.verify()).rejects.toThrow("Malformed commit/tree evidence");
  });

  it("prints the tag, SHA and actionable recovery command on failure, without a token", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(script)], {
      env: { ...process.env, GH_TOKEN: "", GITHUB_REPOSITORY: REPO, GITHUB_SHA: TAG, GITHUB_REF_NAME: "v1.4.0" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`v1.4.0 (${TAG})`);
    expect(result.stderr).toContain("exact-SHA or merged-PR tree proof");
    expect(result.stderr).toContain("gh workflow run ci.yml --ref v1.4.0");
    expect(result.stderr).toContain("re-run the failed release jobs");
  });
});

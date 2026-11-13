#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const WORKFLOW = ".github/workflows/ci.yml";

/** Bounded pagination: incomplete or malformed API evidence never licenses a release. */
async function list(api, route, key) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = key === undefined ? result : result[key];
    if (!Array.isArray(batch)) throw new Error(`Malformed API list: ${route}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`API list exceeds the 1000-entry evidence limit: ${route}`);
}

/** Bind ci-ok to this repository's CI workflow and the exact SHA, not just a job name. */
async function successfulCi(api, root, repo, sha) {
  const runs = await list(api, `${root}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success`, "workflow_runs");
  for (const run of runs) {
    if (run.head_sha !== sha || run.path !== WORKFLOW ||
        run.repository?.full_name?.toLowerCase() !== repo.toLowerCase() ||
        run.status !== "completed" || run.conclusion !== "success" ||
        !Number.isSafeInteger(run.check_suite_id) || run.check_suite_id <= 0) continue;
    const checks = await list(api, `${root}/check-suites/${run.check_suite_id}/check-runs?check_name=ci-ok&filter=latest`, "check_runs");
    if (checks.some(check => check.name === "ci-ok" && check.head_sha === sha &&
        check.app?.slug === "github-actions" && check.status === "completed" &&
        check.conclusion === "success")) return true;
  }
  return false;
}

async function commitTree(api, root, sha) {
  const commit = await api(`${root}/commits/${sha}`);
  if (commit.sha !== sha || !SHA.test(commit.commit?.tree?.sha ?? "")) {
    throw new Error(`Malformed commit/tree evidence for ${sha}`);
  }
  return commit.commit.tree.sha;
}

/** Either exact-SHA CI, or the reviewed merged PR with identical contents (#45). */
export async function verifyReleaseCi({ repo, sha, api }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !SHA.test(sha)) {
    throw new Error("Repository or tag commit SHA is missing or malformed");
  }
  const root = `repos/${repo}`;
  if (await successfulCi(api, root, repo, sha)) return { proof: "exact_sha", sha };
  const tree = await commitTree(api, root, sha);
  const pulls = await list(api, `${root}/commits/${sha}/pulls`);
  const reasons = [];
  for (const pull of pulls) {
    if (!pull.merged_at || pull.base?.ref !== "main" ||
        pull.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() ||
        pull.merge_commit_sha !== sha) continue;
    const head = pull.head?.sha;
    if (!SHA.test(head ?? "")) throw new Error("Malformed merged PR head SHA");
    if (await commitTree(api, root, head) !== tree) {
      reasons.push(`PR #${pull.number} head tree differs from the tag tree`);
      continue;
    }
    if (await successfulCi(api, root, repo, head)) {
      return { proof: "merged_pr_tree", sha, head, tree, number: pull.number };
    }
    reasons.push(`PR #${pull.number} has the same tree but no successful CI-workflow ci-ok on ${head}`);
  }
  throw new Error(
    `No successful CI-workflow ci-ok on exact tag SHA ${sha}; no merged-PR tree proof: ` +
    (reasons.length ? reasons.join("; ") : "no merged PR into main has this merge_commit_sha"),
  );
}

/** GET only, with the job's read-only token; do not print response bodies or credentials. */
async function githubApi(route) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/${route}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status} for ${route}`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.env.GITHUB_REF_NAME ?? "(missing tag)";
  const sha = process.env.GITHUB_SHA ?? "(missing SHA)";
  try {
    if (!process.env.GH_TOKEN) throw new Error("The job's read-only GitHub token is missing");
    const proof = await verifyReleaseCi({ repo: process.env.GITHUB_REPOSITORY, sha, api: githubApi });
    console.log(`[ok] ${tag} (${sha}): ${JSON.stringify(proof)}`);
  } catch (error) {
    console.error(`Release CI proof failed for ${tag} (${sha}): could not establish exact-SHA or merged-PR tree proof. ${error.message}`);
    console.error(`Next step: gh workflow run ci.yml --ref ${tag}; wait for ci-ok to succeed, then re-run the failed release jobs.`);
    process.exitCode = 1;
  }
}

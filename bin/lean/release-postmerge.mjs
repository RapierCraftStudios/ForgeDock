// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post-merge step of `forgedock release` (#5213, part 3 of #5208): confirm or dispatch the publish run for the merge commit,
 * wait for the published artifact (`release.artifact_check`), then open and merge the version-sync PR (`release.version_sync`).
 * Every wait is bounded (`ctx.config.postMerge` overrides the bounds) and ends in `{blocked}`, never a throw, so a resume
 * retries the step; each sub-step is idempotent (an existing run, PR or merged PR is reused). Rationale:
 * devdocs/decisions/5208-release-postmerge.md.
 */

import { cleanupSnapshot } from "./release-snapshot.mjs";

const BOUNDS = {
  publishPolls: 6, publishPollMs: 10_000, // wait for a run to appear (bot merges never trigger one)
  runPolls: 90, runPollMs: 20_000, // wait for the run to finish
  artifactTries: 8, artifactBaseMs: 5_000, artifactMaxMs: 120_000, // npm propagation: exponential backoff
  branchPolls: 6, branchPollMs: 10_000, // wait for the sync branch to be pushed
  checkPolls: 30, checkPollMs: 20_000, // wait for the sync PR's checks
};
const json = (s) => JSON.parse(String(s || "null"));
const blocked = (reason) => ({ blocked: true, reason });
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

async function findRun({ io, repo, workflow, sha }) {
  const runs = json(await io.gh(["run", "list", "--repo", repo, "--workflow", workflow, "--commit", sha, "--json", "databaseId,status,conclusion", "--limit", "5"])) ?? [];
  return runs[0] ?? null;
}

/** Poll `fn` until it returns a truthy value, at most `polls` times, sleeping `ms` between tries. */
async function poll(io, polls, ms, fn) {
  for (let i = 0; i < polls; i++) {
    const v = await fn();
    if (v) return v;
    if (i < polls - 1) await io.sleep(ms);
  }
  return null;
}

async function publishRun(ctx, sha, b) {
  const { io, repo, config } = ctx;
  const workflow = config.publishWorkflow || "publish.yml";
  const look = () => findRun({ io, repo, workflow, sha });
  let run = await poll(io, b.publishPolls, b.publishPollMs, look);
  let dispatched = false;
  if (!run) {
    await io.gh(["workflow", "run", workflow, "--repo", repo, "--ref", ctx.def]);
    dispatched = true;
    run = await poll(io, b.publishPolls, b.publishPollMs, look);
    if (!run) return { err: `no ${workflow} run for ${sha.slice(0, 8)} after a dispatch on ${ctx.def}; check the Actions tab, then resume` };
  }
  const done = await poll(io, b.runPolls, b.runPollMs, async () => { const r = await look(); return r?.status === "completed" ? r : null; });
  if (!done) return { err: `${workflow} run ${run.databaseId} did not finish in time; resume to keep waiting` };
  if (done.conclusion !== "success") return { err: `${workflow} run ${done.databaseId} concluded ${done.conclusion}` };
  return { run: done.databaseId, dispatched };
}

async function artifact(ctx, b) {
  const { io, config } = ctx;
  let wait = b.artifactBaseMs;
  for (let i = 0; i < b.artifactTries; i++) {
    if ((await io.run(config.artifactCheck)).ok) return { ok: true, tries: i + 1 };
    if (i < b.artifactTries - 1) { await io.sleep(wait); wait = Math.min(wait * 2, b.artifactMaxMs); }
  }
  return { err: `release.artifact_check still failing after ${b.artifactTries} tries: ${config.artifactCheck}` };
}

async function versionSync(ctx, sha, b) {
  const { io, repo, staging } = ctx;
  const pkg = JSON.parse(Buffer.from(String(await io.gh(["api", `repos/${repo}/contents/package.json?ref=${sha}`, "--jq", ".content"])).replace(/\s/g, ""), "base64").toString("utf8"));
  const branch = `chore/sync-version-${pkg.version}`;
  const find = async () => json(await io.gh(["pr", "list", "--repo", repo, "--base", staging, "--head", branch, "--state", "all", "--json", "number,state", "--limit", "1"]))?.[0] ?? null;
  let pr = await find();
  if (pr?.state === "MERGED") return { pr: pr.number, merged: true, reused: true };
  if (!pr) {
    const has = await poll(io, b.branchPolls, b.branchPollMs, async () => { try { await io.gh(["api", `repos/${repo}/branches/${branch}`, "--jq", ".name"]); return true; } catch { return false; } });
    if (!has) return { err: `version-sync branch ${branch} did not appear; publish.yml may have skipped the sync, open it by hand` };
    const url = String(await io.gh(["pr", "create", "--repo", repo, "--base", staging, "--head", branch, "--title", `chore: sync version ${pkg.version} to ${staging}`, "--body", `Version-only sync of the ${pkg.version} release back to ${staging} (forgedock release).`])).trim();
    const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!Number.isSafeInteger(n)) return { err: `gh pr create returned no PR url: ${url}` };
    pr = { number: n };
  }
  let red = null;
  const green = await poll(io, b.checkPolls, b.checkPollMs, async () => {
    const v = json(await io.gh(["pr", "view", String(pr.number), "--repo", repo, "--json", "state,headRefOid,statusCheckRollup"]));
    if (v?.state === "MERGED") return { head: null, already: true };
    const res = (v?.statusCheckRollup ?? []).map((c) => String(c.conclusion || c.state || "").toUpperCase());
    if (res.some((r) => r && !GREEN.has(r) && !["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(r))) { red = res.find((r) => r && !GREEN.has(r) && !["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(r)); return { red: true }; }
    return res.length && res.every((r) => GREEN.has(r)) ? { head: v.headRefOid } : null;
  });
  if (green?.already) return { pr: pr.number, merged: true };
  if (green?.red) return { err: `version-sync PR #${pr.number} has a failing check (${red}); fix and merge it by hand` };
  // GITHUB_TOKEN PRs get no CI, so "no checks" is a stop, not a green light.
  if (!green) return { err: `version-sync PR #${pr.number} has no passing checks yet (a PR opened by GITHUB_TOKEN gets no CI: close and reopen it); resume once green` };
  await io.gh(["pr", "merge", String(pr.number), "--repo", repo, "--merge", "--match-head-commit", green.head]);
  return { pr: pr.number, merged: true };
}

/** @returns {Promise<{published, run, artifact, sync}|{blocked: true, reason: string}|{stopped: true, why: string}>} */
export async function postMergeStep(ctx) {
  const { io, repo, state, config = {} } = ctx;
  const b = { ...BOUNDS, ...(config.postMerge ?? {}) };
  const pr = state.steps["release-pr"].result.pr;
  const view = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "state,mergeCommit"]));
  const sha = view?.mergeCommit?.oid;
  if (view?.state !== "MERGED" || !sha) return { stopped: true, why: `release PR #${pr} is not merged (${view?.state ?? "unknown"}); nothing to publish yet` };

  const pub = await publishRun(ctx, sha, b);
  if (pub.err) return blocked(pub.err);
  let art = null;
  if (config.artifactCheck) {
    art = await artifact(ctx, b);
    if (art.err) return blocked(art.err);
  }
  let sync = null;
  if (config.versionSync) {
    sync = await versionSync(ctx, sha, b);
    if (sync.err) return blocked(sync.err);
  }
  if (state.release?.branch) {
    const gone = cleanupSnapshot({ git: io.git, branch: state.release.branch });
    if (!gone.deleted) io.print(`release: could not delete ${state.release.branch} (${gone.why}); delete it by hand`);
  }
  io.print(`release: published (run ${pub.run}${pub.dispatched ? ", dispatched" : ""})${art ? ", artifact confirmed" : ""}${sync ? `, version-sync PR #${sync.pr} merged` : ""}`);
  return { published: true, merge: sha, run: pub.run, dispatched: pub.dispatched, artifact: art?.ok ?? null, sync };
}

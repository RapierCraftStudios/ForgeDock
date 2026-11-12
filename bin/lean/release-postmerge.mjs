// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post-merge step of `forgedock release` (#5213, part 3 of #5208): confirm or dispatch the publish run for the merge commit,
 * wait for the published artifact (`release.artifact_check`), then open and auto-merge the version-sync PR (`release.version_sync`).
 * Every wait is bounded (`ctx.config.postMerge` overrides the bounds) and ends in `{blocked}`, never a throw, so a resume
 * retries the step; each sub-step is idempotent (an existing run, PR or merged PR is reused). Rationale:
 * devdocs/decisions/5208-release-postmerge.md.
 */

import { cleanupSnapshot } from "./release-snapshot.mjs";
import { fenced } from "./release-fence.mjs";

const BOUNDS = {
  publishPolls: 6, publishPollMs: 10_000, // wait for a run to appear (bot merges never trigger one)
  runPolls: 90, runPollMs: 20_000, // wait for the run to finish
  artifactTries: 8, artifactBaseMs: 5_000, artifactMaxMs: 120_000, // npm propagation: exponential backoff
  branchPolls: 6, branchPollMs: 10_000, // wait for the sync branch to be pushed
  autoPolls: 30, autoPollMs: 20_000, // wait for the sync PR's auto-merge
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
    const f = await fenced(ctx.fence, { action: "dispatch", key: `dispatch:${sha}` }, (epoch) => io.gh(["workflow", "run", workflow, "--repo", repo, "--ref", ctx.def, ...(epoch != null ? ["-f", `forge_epoch=${epoch}`] : [])]));
    if (f.refused) return { err: `dispatch ${f.refused}` };
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

const b64 = (s) => Buffer.from(String(s).replace(/\s/g, ""), "base64").toString("utf8");
const semverLt = (a, b) => { const x = String(a).split(/[.-]/).map(Number), y = String(b).split(/[.-]/).map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
const VERSION_FILES = ["package.json", ".claude-plugin/plugin.json"];

/** The sync branch is missing (publish.yml failed before pushing): cut it from the staging head with a version-only commit, through the gh API. */
async function createSyncBranch({ io, repo, staging }, branch, version) {
  const base = String(await io.gh(["api", `repos/${repo}/git/ref/heads/${staging}`, "--jq", ".object.sha"])).trim();
  await io.gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${base}`]);
  for (const f of VERSION_FILES) {
    let cur;
    try { cur = json(await io.gh(["api", `repos/${repo}/contents/${f}?ref=${staging}`])); } catch { if (f === "package.json") throw new Error(`${f} unreadable on ${staging}`); continue; }
    const doc = JSON.parse(b64(cur.content));
    doc.version = version;
    await io.gh(["api", "-X", "PUT", `repos/${repo}/contents/${f}`, "-f", `message=chore: sync version ${version} to ${staging}`, "-f", `content=${Buffer.from(JSON.stringify(doc, null, 2) + "\n").toString("base64")}`, "-f", `sha=${cur.sha}`, "-f", `branch=${branch}`]);
  }
}

/** The release PR's version goes back to staging (#5513): publish.yml cannot open the PR (enterprise policy), so the host does, then enables auto-merge. */
async function versionSync(ctx, sha, b) {
  const { io, repo, staging } = ctx;
  const read = async (ref) => JSON.parse(b64(await io.gh(["api", `repos/${repo}/contents/package.json?ref=${ref}`, "--jq", ".content"]))).version;
  const version = await read(sha);
  const cur = await read(staging);
  if (!semverLt(cur, version)) return { skipped: true, version, staging: cur };
  const branch = `chore/sync-version-${version}`;
  const find = async () => json(await io.gh(["pr", "list", "--repo", repo, "--base", staging, "--head", branch, "--state", "all", "--json", "number,state", "--limit", "1"]))?.[0] ?? null;
  let pr = await find();
  if (pr?.state === "MERGED") return { pr: pr.number, merged: true, reused: true };
  if (!pr) {
    const has = await poll(io, b.branchPolls, b.branchPollMs, async () => { try { await io.gh(["api", `repos/${repo}/branches/${branch}`, "--jq", ".name"]); return true; } catch { return false; } });
    if (!has) {
      try { await createSyncBranch(ctx, branch, version); } catch (e) { return { err: `version-sync branch ${branch} is missing and could not be created (${String(e.message).split("\n")[0]}); open it by hand` }; }
    }
    const url = String(await io.gh(["pr", "create", "--repo", repo, "--base", staging, "--head", branch, "--title", `chore: sync version ${version} to ${staging}`, "--body", `Version-only sync of the ${version} release back to ${staging} (forgedock release).\n\ndocs-not-needed: version-only sync, no behaviour change`])).trim();
    const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!Number.isSafeInteger(n)) return { err: `gh pr create returned no PR url: ${url}` };
    pr = { number: n };
  }
  const warn = (why) => ({ pr: pr.number, merged: false, warning: `version-sync PR #${pr.number} ${why}; merge it by hand so ${staging} reaches ${version}` });
  try {
    const f = await fenced(ctx.fence, { action: "merge", key: `sync-merge:${pr.number}` }, () => io.gh(["pr", "merge", String(pr.number), "--repo", repo, "--merge", "--auto"]));
    if (f.refused) return { err: `version-sync merge ${f.refused}` };
  } catch (e) { return warn(`could not enable auto-merge (${String(e.message).split("\n")[0]})`); }
  const end = await poll(io, b.autoPolls, b.autoPollMs, async () => {
    const st = json(await io.gh(["pr", "view", String(pr.number), "--repo", repo, "--json", "state"]))?.state;
    return st === "MERGED" || st === "CLOSED" ? st : null;
  });
  if (end === "MERGED") return { pr: pr.number, merged: true };
  return warn(end === "CLOSED" ? "was closed without merging" : "did not merge in time (auto-merge is enabled)");
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
    if (sync.warning) io.print(`release: WARNING ${sync.warning}`);
  }
  if (state.release?.branch) {
    const gone = cleanupSnapshot({ git: io.git, branch: state.release.branch });
    if (!gone.deleted) io.print(`release: could not delete ${state.release.branch} (${gone.why}); delete it by hand`);
  }
  io.print(`release: published (run ${pub.run}${pub.dispatched ? ", dispatched" : ""})${art ? ", artifact confirmed" : ""}${sync?.pr ? `, version-sync PR #${sync.pr} ${sync.merged ? "merged" : "pending"}` : sync?.skipped ? ", staging already synced" : ""}`);
  return { published: true, merge: sha, run: pub.run, dispatched: pub.dispatched, artifact: art?.ok ?? null, sync };
}

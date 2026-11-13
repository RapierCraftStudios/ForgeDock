// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The managed P0 lane (#5565, epic #5549 Phase 4; I10, I11, I14, I26): a production fix branches from what is live, deploys first
 * through the `hotfix` pipeline (#5560 step runner, #5562 verification, #5563 rollback on failure), then lands on the default
 * branch so no code is live without being on it. `laneStartGuard` is the live-vs-default rule fast lanes (#5570) call.
 * Every effect goes through `io` (`git`, `gh`, `rehearse`, `api`), so the module is testable with fake io. The engine never sets a
 * human break-glass input on a dispatch: `buildDispatchArgs` rejects them and the pipeline inputs are checked up front.
 */
import { readTarget, deployStep } from "./release-deploy.mjs";
import { runRollback, takeFence } from "./release-rollback.mjs";
import { claimDeploy, releaseDeploy, recordP0Divergence } from "./release-ledger.mjs";
import { buildDispatchArgs } from "./release-control.mjs";
import { applyOnExceed } from "./release-minutes.mjs";
import { fenced } from "./release-fence.mjs";

export const FAST_LANES = ["train"];
export const P0_BOUNDS = { pollMs: 20_000, queuePolls: 30 };
const short = (s) => String(s ?? "").slice(0, 8);
const json = (s) => JSON.parse(String(s || "null"));
const ok = (fn) => { try { fn(); return true; } catch { return false; } };

/** default == live: live is an ancestor of `origin/<def>` and the trees are identical. @returns {{equal: boolean, live, def, why?}} */
export function divergence({ io, def, live }) {
  const ref = `origin/${def}`;
  ok(() => io.git(["fetch", "--quiet", "origin", def]));
  const anc = ok(() => io.git(["merge-base", "--is-ancestor", live, ref]));
  let same = false;
  try { same = io.git(["rev-parse", `${live}^{tree}`]).trim() === io.git(["rev-parse", `${ref}^{tree}`]).trim(); } catch { same = false; }
  if (anc && same) return { equal: true, live, def };
  return { equal: false, live, def, why: `${def} (${short(ref)}) != live ${short(live)}: ${anc ? "the trees differ" : "live is not an ancestor of it"}` };
}

const deployOf = (ctx) => ctx.deploy ?? ctx.config?.deploy ?? ctx.policy?.deploy;

/**
 * Lane start guard (I10). A fast lane (train) refuses while the default branch != live; p0 is exempt, bases on live and records the
 * divergence in the ledger; other lanes are not guarded. `ctx`: {io, repo, def, deploy|config.deploy|policy.deploy, release?, recordDivergence?}.
 * @returns {Promise<{ok: true, lane, live?, base?, divergence?}|{refused: string}>}
 */
export async function laneStartGuard(ctx, lane) {
  if (lane !== "p0" && !FAST_LANES.includes(lane)) return { ok: true, lane };
  const cmd = deployOf(ctx)?.live_release_command;
  const live = await readTarget(ctx.io, cmd);
  if (!live) return { refused: `${lane}: cannot read the live sha (deploy.live_release_command is unset or returned nothing); nothing was started` };
  const d = divergence({ io: ctx.io, def: ctx.def, live: live.sha });
  if (lane !== "p0") return d.equal ? { ok: true, lane, live: live.sha } : { refused: `${lane} lane refused: ${d.why}; land or roll back the live difference first (I10)` };
  if (!d.equal) {
    const rec = { release: ctx.release ?? null, live: live.sha, def: ctx.def, why: d.why };
    const lctx = ctx.io.api ? { io: ctx.io, repo: ctx.repo, credential: "driver" } : null;
    const record = ctx.recordDivergence ?? (lctx ? (r) => recordP0Divergence(lctx, r, ctx.io.now?.()) : null);
    if (record) await record(rec);
  }
  return { ok: true, lane, live: live.sha, base: live.sha, ...(d.equal ? {} : { divergence: d.why }) };
}

/** Typed `go` unless `--yes`. @returns {Promise<boolean>} */
export async function confirmGo({ yes, ask, plan }) {
  if (yes) return true;
  if (!ask) return false;
  return String(await ask(`${plan}\nType go to deploy: `)).trim() === "go";
}

/** The fix branch: `p0/issue-<n>` cut from the live sha (never the default branch), or the given branch, which must descend from live. */
async function ensureBranch({ io, issue, branch, live }) {
  const name = branch ?? `p0/issue-${issue}`;
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes("..")) return { refused: `invalid branch name ${JSON.stringify(name)}` };
  const exists = !!String(io.git(["ls-remote", "--heads", "origin", name]) ?? "").trim();
  if (!exists) {
    if (branch) return { refused: `branch ${name} does not exist on origin` };
    io.git(["push", "--quiet", "origin", `${live}:refs/heads/${name}`]);
  }
  io.git(["fetch", "--quiet", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`]);
  const tip = io.git(["rev-parse", `refs/remotes/origin/${name}`]).trim();
  if (!ok(() => io.git(["merge-base", "--is-ancestor", live, tip]))) return { refused: `branch ${name} is not based on live ${short(live)}; a p0 bases on what is live, not the default branch` };
  const fullLive = ok(() => io.git(["rev-parse", live])) ? io.git(["rev-parse", live]).trim() : live;
  return { branch: name, tip, created: !exists, empty: tip === fullLive };
}

/** The landing PR to the default branch (idempotent: an open one for the branch is reused). @returns {Promise<number|null>} */
async function landingPr({ io, repo, def, branch, issue }) {
  const open = json(await io.gh(["pr", "list", "--repo", repo, "--head", branch, "--base", def, "--state", "open", "--json", "number"])) ?? [];
  if (open[0]) return open[0].number;
  const out = String(await io.gh(["pr", "create", "--repo", repo, "--base", def, "--head", branch, "--title", `p0: land ${branch} on ${def}`, "--body", `Landing PR for the p0 fix deployed from \`${branch}\`${issue ? ` (#${issue})` : ""}. No code may be live without being on ${def} (I10).`]));
  return Number(/\/pull\/(\d+)/.exec(out)?.[1]) || null;
}

/** WAVE_DONE (I11): a p0 wave is done only once its landing PR is merged to the default branch and live == default. @returns {Promise<{done: boolean, why?: string}>} */
export async function waveDone(ctx) {
  const pr = ctx.state?.p0?.landingPr;
  if (!pr) return { done: false, why: "no landing PR: the p0 is not merged to the default branch" };
  const v = json(await ctx.io.gh(["pr", "view", String(pr), "--repo", ctx.repo, "--json", "state"]));
  if (v?.state !== "MERGED") return { done: false, why: `landing PR #${pr} is ${v?.state ?? "unreadable"}, not merged to ${ctx.def}` };
  const live = await readTarget(ctx.io, deployOf(ctx)?.live_release_command);
  if (!live) return { done: false, why: "cannot read the live sha" };
  const d = divergence({ io: ctx.io, def: ctx.def, live: live.sha });
  return d.equal ? { done: true } : { done: false, why: d.why };
}

/** Cancel the in-flight runs of `workflow` (preempt only; fenced, audited by the ledger claim). */
async function cancelRuns(ctx, workflow) {
  const { io, repo } = ctx;
  const runs = json(await io.gh(["run", "list", "--repo", repo, "--workflow", workflow, "--status", "in_progress", "--json", "databaseId"])) ?? [];
  for (const r of runs) {
    const f = await fenced(ctx.fence, { action: "cancel-run", key: `${ctx.state.id}:p0:cancel:${r.databaseId}` }, () => io.gh(["run", "cancel", String(r.databaseId), "--repo", repo]));
    if (f.refused) return f.refused;
  }
  return null;
}

/**
 * Run a p0. `ctx`: {io, repo, def, state, save, config: {deploy, verify?, budget?, tracker?}, policy?, actor?, host?}; `args`: {issue?, branch?, units?, preempt?}.
 * @returns {Promise<{status: "live"|"rolled-back"|"queued"|"refused"|"stopped"|"blocked", reason?, branch?, landingPr?, wave?, rollback?}>}
 */
export async function runP0(ctx, { issue = null, branch = null, units = null, preempt = false }) {
  const { io, state } = ctx;
  const L = { claimDeploy, releaseDeploy, takeFence, ...(ctx.ledger ?? {}) }; // overridable for tests
  const d = ctx.config.deploy, pipe = d?.pipelines?.hotfix;
  const b = { ...P0_BOUNDS, ...(ctx.config.p0Bounds ?? {}) };
  if (!pipe?.workflow) return { status: "refused", reason: "deploy.pipelines.hotfix is not configured" };
  const inputs = { ...(pipe.inputs ?? {}), ...(units ? { units } : {}) };
  try { buildDispatchArgs({ workflow: pipe.workflow, repo: ctx.repo, ref: ctx.def, inputs }); } catch (e) { return { status: "refused", reason: e.message }; }
  const p0 = (state.p0 ??= { issue, units });
  p0.budget = applyOnExceed({ lane: "p0", forecast: ctx.forecast, remaining: ctx.remaining, cfg: ctx.config.budget }); // I14: never blocks
  const g = await laneStartGuard({ ...ctx, deploy: d, release: state.id }, "p0");
  if (g.refused) return { status: "refused", reason: g.refused };
  p0.live = g.live; if (g.divergence) p0.divergence = g.divergence;
  const br = await ensureBranch({ io, issue, branch, live: g.live });
  if (br.refused) return { status: "refused", reason: br.refused };
  p0.branch = br.branch; ctx.save();
  if (br.empty) return { status: "stopped", branch: br.branch, reason: `${br.branch} is at live ${short(g.live)} with no fix commits; push the fix, then run \`forgedock release p0 --branch ${br.branch}\`` };

  state.steps["release-pr"] = { done: true, result: { pr: ctx.config.tracker ?? issue, issues: issue ? [issue] : [] } };
  state.steps["post-merge"] = { done: true, result: { merge: br.tip } };
  state.lane = "p0";
  const dctx = { ...ctx, deployRef: br.branch, staging: ctx.def, git: io.git, config: { ...ctx.config, deployPipeline: "hotfix", deploy: { ...d, pipelines: { ...d.pipelines, hotfix: { ...pipe, inputs } } }, verifyRisk: "p0" } };
  if (io.api) {
    const f = await L.takeFence(dctx, io.holder ?? `host-${process.pid}`);
    if (f.refused) return { status: "refused", reason: f.refused };
    dctx.fence = f.fence;
  }
  const lctx = io.api ? { io, repo: ctx.repo, credential: "driver" } : null;
  if (lctx) { // one deploy at a time: queue behind a DEPLOYING release, never cancel it unless --preempt
    let c = null;
    for (let i = 0; i <= b.queuePolls; i++) {
      c = await L.claimDeploy(lctx, { release: state.id, preempt, actor: ctx.actor, reason: `p0 ${br.branch}`, now: io.now?.() });
      if (!c.queued) break;
      if (i < b.queuePolls) await io.sleep(b.pollMs);
    }
    if (c.queued) return { status: "queued", branch: br.branch, reason: c.queued };
    if (c.lost) return { status: "refused", reason: "could not claim the deploy slot in the ledger" };
    if (c.preempted) { const why = await cancelRuns(dctx, pipe.workflow); if (why) return { status: "refused", reason: why }; p0.preempted = c.preempted; }
  }
  try {
    const out = await deployStep(dctx);
    if (out.blocked || out.stopped) {
      const rolled = state.deploy?.target && state.deploy?.runId && !out.stopped;
      const reason = out.reason ?? out.why;
      if (!rolled) return { status: out.blocked ? "blocked" : "stopped", branch: br.branch, reason };
      const rb = await runRollback({ ...dctx, policy: ctx.policy, actor: ctx.actor, host: ctx.host }, { reason });
      p0.rollback = { rung: rb.rung, ok: rb.ok };
      return { status: "rolled-back", branch: br.branch, reason, rollback: rb };
    }
    if (out.skipped) return { status: "refused", reason: "deploy.pipelines is empty; nothing to deploy" };
    p0.landingPr = await landingPr({ io, repo: ctx.repo, def: ctx.def, branch: br.branch, issue }); ctx.save();
    const wave = await waveDone({ ...ctx, deploy: d });
    let sync; // #5566: once the landing PR is merged, sync the default branch back into the integration branch (managed only)
    if (wave.done && ctx.config.managed) { const { syncStep } = await import("./release-mergeback.mjs"); sync = await syncStep(ctx, { lane: "p0" }); }
    return { status: "live", branch: br.branch, landingPr: p0.landingPr, wave, ...(sync ? { sync } : {}) };
  } finally {
    if (lctx) await L.releaseDeploy(lctx, state.id).catch(() => null);
  }
}

/** `forgedock release p0 <#issue | --branch B> [--units a,b] [--preempt] [--yes] [--repo R]`; @returns 0 live, 1 refused, 3 queued/stopped/blocked/rolled back. */
export async function p0FromCli(argv, { io, rel, id, config, policy, def, actor, host, ask }) {
  const flag = (f) => { const i = argv.indexOf(f); return i >= 0 && !argv[i + 1]?.startsWith("--") ? argv[i + 1] : null; };
  const positional = argv.find((a, i) => !a.startsWith("--") && !["--branch", "--units", "--repo"].includes(argv[i - 1]));
  const issue = positional && /^#?\d+$/.test(positional) ? Number(positional.replace("#", "")) : null;
  const branch = flag("--branch");
  const refuse = (m) => { io.print(`release p0: refused: ${m}`); return 1; };
  if (!issue && !branch) return refuse("a p0 needs #<issue> or --branch <B>");
  if (issue && branch) return refuse("pass either #<issue> or --branch, not both");
  const repo = flag("--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const units = flag("--units"), preempt = argv.includes("--preempt");
  if (!await confirmGo({ yes: argv.includes("--yes"), ask, plan: `p0 ${issue ? `#${issue}` : branch}${units ? ` units ${units}` : ""}: base on live, deploy via the hotfix pipeline, then land on ${def}${preempt ? "; --preempt cancels an in-flight deploy" : ""}` })) return refuse("not confirmed (type go, or pass --yes)");
  const state = rel.load() ?? { v: 1, id, repo, startedAt: new Date(io.now()).toISOString(), steps: {}, held: [] };
  const ctx = { io, repo, def, state, save: () => rel.save(state), config, policy, actor, host };
  const r = await runP0(ctx, { issue, branch, units, preempt });
  io.print(`release p0 ${id}: ${r.status}${r.reason ? `: ${r.reason}` : ""}${r.landingPr ? ` (landing PR #${r.landingPr}${r.wave?.done ? ", wave done" : `, wave not done: ${r.wave?.why}`})` : ""}`);
  state.status = r.status; ctx.save();
  return r.status === "live" ? 0 : r.status === "refused" ? 1 : 3;
}

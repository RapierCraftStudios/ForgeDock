// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deploy stages of `forgedock release` (#5560, epic #5549 Phase 3): MERGED -> DEPLOYING -> LIVE_CHECK -> RECOVERING -> VERIFYING -> LIVE (verification layers, FORGE:VERIFIED and close-after-verified live in release-verify.mjs, #5562).
 * Off unless the policy has `deploy.pipelines` (`ctx.config.deploy`): without it the step is `{skipped}` and leaves no trace.
 * Every step is observe -> decide -> fenced act -> verify, and progress lives in `state.deploy`, so a resume re-observes GitHub
 * (the run, the live record, the freeze variable) before it acts and repeats no dispatch or rerun. Waits are bounded and end in
 * `{blocked}`, never a throw. The engine never sets a break-glass input and never reruns a deploy while a freeze is set (I26);
 * a run that concluded `success` while live is not the merge sha (or the expected digests) is a failed deploy (I28); no deploy
 * starts without a recorded rollback target (I9). Rationale: devdocs/decisions/5560-release-deploy.md.
 */
import { fenced } from "./release-fence.mjs";
import { buildDispatchArgs } from "./release-control.mjs";
import { INFRA_SIGNATURES } from "./release-flakes.mjs";
import { verifyStep, verifyConfigured } from "./release-verify.mjs";

export const BOUNDS = { pollMs: 10_000, runPollMs: 20_000, defaultStageS: 3600, rerunMax: 2, maxAttempts: 3 };
const json = (s) => JSON.parse(String(s || "null"));
const blocked = (reason) => ({ blocked: true, reason });
const tail = (s, n = 400) => String(s ?? "").trim().slice(-n);

/** `{sha, images}` from the live-release command output: JSON `{sha, images|units: {unit: digest}}` or a bare sha. */
export function parseLiveRelease(out) {
  const t = String(out ?? "").trim();
  if (!t) return null;
  if (t.startsWith("{")) { try { const o = JSON.parse(t); return o?.sha ? { sha: String(o.sha), images: o.images ?? o.units ?? {} } : null; } catch { return null; } }
  const sha = t.split(/\s+/)[0];
  return /^[0-9a-f]{7,64}$/i.test(sha) ? { sha, images: {} } : null;
}

const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/** LIVE_CHECK (I28): the digests decide when expected ones are recorded, else the sha. */
export function liveMatches(live, mergeSha, expected) {
  if (!live) return false;
  const units = Object.entries(expected ?? {});
  return units.length ? units.every(([u, d]) => live.images?.[u] === d) : sameSha(live.sha, mergeSha);
}

async function readTarget(io, cmd) {
  if (!cmd) return null;
  const r = await io.rehearse(cmd, { timeout: 120_000 });
  return r?.ok ? parseLiveRelease(r.output) : null;
}

/** The freeze variable's value ("" when unset or unreadable-as-absent). A gh failure means unset: `gh variable get` exits non-zero for a missing variable. */
async function freezeValue(io, repo, name) {
  if (!name) return "";
  try { return String(await io.gh(["variable", "get", name, "--repo", repo])).trim(); } catch { return ""; }
}

/** The newest run for `(workflow, sha)`; a `skipped` run (a push the workflow chose not to run) is expected and not a run. */
async function latestRun({ io, repo, workflow, sha }) {
  const runs = json(await io.gh(["run", "list", "--repo", repo, "--workflow", workflow, "--commit", sha, "--json", "databaseId,status,conclusion", "--limit", "5"])) ?? [];
  return runs.find((r) => r.conclusion !== "skipped") ?? null;
}

/** A cancelled run is a concurrency-group supersede (expected) when the workflow has a newer run. */
async function superseded({ io, repo, workflow }, run) {
  const runs = json(await io.gh(["run", "list", "--repo", repo, "--workflow", workflow, "--json", "databaseId,status", "--limit", "10"])) ?? [];
  return runs.some((r) => r.databaseId > run.databaseId);
}

async function poll(io, polls, ms, fn) {
  for (let i = 0; i < polls; i++) {
    const v = await fn();
    if (v) return v;
    if (i < polls - 1) await io.sleep(ms);
  }
  return null;
}

/** Intent key `(release, step, epoch, what)`: one irreversible action per epoch, named in the write-ahead intent (R10). */
const idemKey = (ctx, what) => `${ctx.fence?.lease?.release ?? ctx.state.id ?? "-"}:deploy:${ctx.fence?.lease?.epoch ?? 0}:${what}`;

/** A dispatch (fenced, write-ahead intent) and the run it makes; observe first so a crashed driver never dispatches twice. */
export async function runFor(ctx, { workflow, sha, inputs, key, startPolls, b }) {
  const { io, repo } = ctx;
  const look = () => latestRun({ io, repo, workflow, sha });
  let run = await poll(io, startPolls, b.pollMs, look);
  if (run) return { run, dispatched: false };
  if ((ctx.state.intents ?? []).some((i) => i.action === "dispatch" && String(i.key).endsWith(`:${key}`))) { // a dispatch intent (any epoch, done or not) may have taken effect: wait for its run, never repeat it (I7)
    run = await poll(io, Math.max(startPolls, Math.ceil((ctx.config.deploy?.start_timeout_s ?? 60) * 1000 / b.pollMs)), b.pollMs, look);
    return run ? { run, dispatched: false } : { err: `a ${workflow} dispatch for ${sha.slice(0, 8)} was already recorded but no run appeared; check the Actions tab, then resume (never redispatched)` };
  }
  const f = await fenced(ctx.fence, { action: "dispatch", key: idemKey(ctx, key) }, (epoch) => io.gh(buildDispatchArgs({ workflow, repo, ref: ctx.def, inputs: { ...inputs, ...(epoch != null ? { forge_epoch: epoch } : {}) } })));
  if (f.refused) return { err: `dispatch ${f.refused}` };
  run = await poll(io, startPolls, b.pollMs, look);
  return run ? { run, dispatched: true } : { err: `no ${workflow} run for ${sha.slice(0, 8)} after a dispatch on ${ctx.def}; check the Actions tab, then resume` };
}

export async function finished(ctx, workflow, sha, polls, b) {
  const { io, repo } = ctx;
  return poll(io, polls, b.runPollMs, async () => { const r = await latestRun({ io, repo, workflow, sha }); return r?.status === "completed" ? r : null; });
}

/** transient: shared infra signatures (release-flakes) or configured ones; migration: a rehearsal-class failure; else a deterministic build failure. */
export function classifyDeploy(log, sigs) {
  if (INFRA_SIGNATURES.some(([, re]) => re.test(log)) || (sigs ?? []).some((s) => { try { return new RegExp(s, "i").test(log); } catch { return log.includes(s); } })) return "transient";
  return /migrat/i.test(log) ? "migration" : "deterministic";
}

const hold = (reason, kind) => ({ blocked: `${reason} (owner ask: decide rollback or fix; label needs-agent when no host is attached)`, hold: { kind, label: "needs-agent" } });

/**
 * Recovery (6.5): one action at a time, bounded. @returns {{rerun: true}|{blocked: string}}
 * No rerun while a freeze is set (I26); only a failed run with a configured transient log signature is rerun.
 */
async function recover(ctx, d, run, why, freezeNow, b, workflow) {
  const { io, repo, state } = ctx;
  const st = state.deploy, rec = d.recovery ?? {};
  const rerunMax = rec.rerun_max ?? b.rerunMax, maxAttempts = rec.max_attempts ?? b.maxAttempts;
  if (freezeNow) return { blocked: `${why}; ${d.freeze_variable} is set, so the engine never reruns or redispatches the deploy (I26): roll back, or a human runs the workflow with override_freeze` };
  if (!run || !["failure", "timed_out", "cancelled"].includes(run.conclusion)) return { blocked: `${why}; nothing to rerun (a run that finished without changing live is not retried)` };
  if (run.conclusion === "cancelled" && await superseded({ io, repo, workflow }, run)) return { blocked: `${why}; run ${run.databaseId} was cancelled by a newer run of the concurrency group: expected, not rerun` };
  if (st.reruns >= rerunMax || st.attempts >= maxAttempts) return { blocked: `${why}; recovery spent (${st.reruns}/${rerunMax} reruns, ${st.attempts}/${maxAttempts} actions): hand off to the rollback ladder (#5563)` };
  let log = ""; try { log = String(await io.gh(["run", "view", String(run.databaseId), "--repo", repo, "--log-failed"])); } catch { /* unreadable log: not transient */ }
  const cls = classifyDeploy(log, rec.signatures);
  if (cls !== "transient") return hold(`${why}; ${cls === "migration" ? "migration failure" : "deterministic build failure"}, never retried blindly: ${tail(log, 200)}`, cls);
  st.reruns += 1; st.attempts += 1; ctx.save(); // counted before the act: a crash can only spend budget, never exceed it
  const f = await fenced(ctx.fence, { action: "rerun", key: idemKey(ctx, `rerun:${run.databaseId}:${st.reruns}`) }, () => io.gh(["run", "rerun", String(run.databaseId), "--repo", repo, "--failed"]));
  if (f.refused) return { blocked: `rerun ${f.refused}` };
  await io.sleep(b.pollMs); // the rerun flips the run back to in_progress before the next observation
  return { rerun: true };
}

/**
 * reconcile(): re-observe GitHub before acting on a persisted phase (resume after a crash or a moved world).
 * A LIVE_CHECKED phase whose live record no longer matches goes back to DEPLOYING (the run is observed, never redispatched);
 * a phase with no recorded run adopts the run GitHub already has for the merge sha.
 */
export async function reconcile(ctx, d, pipe, sha) {
  const { io, repo } = ctx, st = ctx.state.deploy;
  if (st.phase === "LIVE_CHECKED") {
    if (!liveMatches(await readTarget(io, d.live_release_command), sha, st.expected)) { st.phase = "DEPLOYING"; ctx.save(); }
  } else if (st.phase === "DEPLOYING" && !st.runId) {
    const run = await latestRun({ io, repo, workflow: pipe.workflow, sha });
    if (run) { st.runId = run.databaseId; ctx.save(); }
  }
  return st.phase;
}

const stageS = (d) => (typeof d.stage_timeout_s === "number" ? d.stage_timeout_s : BOUNDS.defaultStageS);

/** @returns {Promise<{skipped: true}|{live: true, merge, run, reruns}|{blocked: true, reason, hold?}|{stopped: true, why}>} */
export async function deployStep(ctx) {
  const { io, repo, state } = ctx;
  const d = ctx.config.deploy;
  if (!d?.pipelines || !Object.keys(d.pipelines).length) return { skipped: true };
  const b = { ...BOUNDS, ...(ctx.config.deployBounds ?? {}) };
  const pipe = d.pipelines[ctx.config.deployPipeline ?? "full"] ?? Object.values(d.pipelines)[0];
  if (!pipe?.workflow) return blocked("deploy.pipelines has no workflow for this release");
  let sha = state.steps["post-merge"]?.result?.merge ?? null;
  if (!sha) {
    const pr = state.steps["release-pr"]?.result?.pr;
    const v = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "state,mergeCommit"]));
    sha = v?.state === "MERGED" ? v.mergeCommit?.oid : null;
    if (!sha) return { stopped: true, why: `release PR #${pr} is not merged; nothing to deploy yet` };
  }
  const st = (state.deploy ??= { phase: "MERGED", attempts: 0, reruns: 0 });

  if (!st.target) { // MERGED -> DEPLOYING guard (I9, 6.3): the rollback target is frozen before anything is dispatched
    const target = await readTarget(io, d.live_release_command);
    if (!target) return blocked("rollback target unknown: deploy.live_release_command is unset or returned no live sha (I9); nothing was dispatched");
    let expected = null;
    if (d.expected_digests_command) {
      const r = await io.rehearse(d.expected_digests_command, { timeout: 120_000 });
      try { expected = r?.ok ? json(r.output) : null; } catch { expected = null; }
      if (!expected) return blocked("deploy.expected_digests_command returned no digests; refusing to deploy without them");
    }
    st.target = target; st.expected = expected; st.merge = sha; st.freezeBefore = await freezeValue(io, repo, d.freeze_variable); st.phase = "DEPLOYING";
    ctx.save();
  }

  await reconcile(ctx, d, pipe, sha);
  if (st.phase !== "LIVE_CHECKED" && st.phase !== "LIVE") {
    for (;;) {
      st.phase = "DEPLOYING"; ctx.save();
      const r = await runFor(ctx, { workflow: pipe.workflow, sha, inputs: pipe.inputs ?? {}, key: `deploy:${sha}`, startPolls: pipe.trigger === "dispatch" ? 1 : Math.max(1, Math.ceil((d.start_timeout_s ?? 60) * 1000 / b.pollMs)), b });
      if (r.err) return blocked(r.err);
      st.runId = r.run.databaseId; ctx.save();
      const done = await finished(ctx, pipe.workflow, sha, Math.ceil(stageS(d) * 1000 / b.runPollMs), b);
      if (!done) return blocked(`${pipe.workflow} run ${st.runId} did not finish within stage_timeout_s; check the live record before any rerun, then resume`);
      st.phase = "LIVE_CHECK"; ctx.save();
      const live = await readTarget(io, d.live_release_command);
      const freezeNow = await freezeValue(io, repo, d.freeze_variable);
      const frozenByRun = !!freezeNow && !st.freezeBefore;
      let why = null;
      if (done.conclusion === "failure" || done.conclusion === "timed_out") why = `${pipe.workflow} run ${done.databaseId} concluded ${done.conclusion}`;
      else if (!liveMatches(live, sha, st.expected)) why = `LIVE_CHECK failed: run ${done.databaseId} concluded ${done.conclusion} but live is ${live?.sha?.slice(0, 8) ?? "unreadable"}, not ${sha.slice(0, 8)} (I28)${frozenByRun ? `; the run set ${d.freeze_variable}` : ""}`;
      else if (frozenByRun) why = `LIVE_CHECK failed: the run set ${d.freeze_variable}`;
      if (!why) { st.phase = "LIVE_CHECKED"; ctx.save(); break; }
      const rec = await recover(ctx, d, done, why, !!freezeNow, b, pipe.workflow);
      if (rec.blocked) return { ...blocked(rec.blocked), ...(rec.hold ? { hold: rec.hold } : {}) };
    }
  }

  let verify = null;
  if (st.phase !== "LIVE") {
    st.phase = "VERIFYING"; ctx.save();
    if (verifyConfigured(ctx.config.verify)) { // #5562: layers, FORGE:VERIFIED, guarded close; unconfigured stays a bare transition
      verify = await verifyStep(ctx, sha);
      if (verify.blocked) return { ...blocked(verify.reason), ...(verify.hold ? { hold: verify.hold } : {}), ...(verify.rollback ? { rollback: verify.rollback } : {}) };
    }
    st.phase = "LIVE"; ctx.save();
  }
  io.print?.(`release: live at ${sha.slice(0, 8)} (run ${st.runId}, ${st.reruns} rerun(s))`);
  return { live: true, merge: sha, run: st.runId, reruns: st.reruns, ...(verify ? { verify } : {}) };
}

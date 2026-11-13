// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5571: `forgedock release start|go`. The managed runner above the planner (#5559), train lane (#5570) and release run: it drives the
// plan's waves in order (all trains, then the release wave), gates the release CUT on the last train being WAVE_DONE, applies the
// feature flag policy, keeps the milestone lane explicit, soaks the release wave at full strength and resumes from the ledger.
import { fenced } from "./release-fence.mjs";
import { planFromCli, DECISION_RE, approvalOf, PLAN_LABEL } from "./release-plan.mjs";

export const WAVE_STATES = ["PENDING", "BUILT", "CUT", "LIVE", "WAVE_DONE"];
export const FLAG_POLICIES = ["require", "warn", "off"];
export const MERGE_DECISION = (hash) => `<!-- FORGE:DECISION merge ${hash} -->`;
export const PLAN_DECISION = (hash) => `<!-- FORGE:DECISION plan ${hash} -->`;
const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const isTrain = (w) => w.lane === "train";

/** Waves in run order: trains (plan order) strictly before the release wave. */
export const orderWaves = (plan) => [...plan.waves.filter(isTrain), ...plan.waves.filter((w) => !isTrain(w))];

/** The recorded state of wave `id` (`PENDING` when it has none). */
export const waveState = (state, id) => state?.waves?.[id]?.state ?? "PENDING";

/** A wave is WAVE_DONE only when verified live, merged and merged back (validated); anything less stays LIVE. */
export const waveDone = (r) => !!(r?.verified && r.merged && r.mergedBack);

/** CUT of a release wave is refused until every train of the plan is WAVE_DONE; a train CUT only needs the trains before it. Building is never gated. */
export function cutAllowed(state, plan, wave) {
  const trains = plan.waves.filter(isTrain);
  const before = isTrain(wave) ? trains.slice(0, trains.findIndex((t) => t.id === wave.id)) : trains;
  const open = before.filter((t) => waveState(state, t.id) !== "WAVE_DONE");
  return open.length ? { ok: false, reason: `CUT of ${wave.id} refused: ${open.map((t) => t.id).join(", ")} not WAVE_DONE` } : { ok: true };
}

/**
 * `features.flag_policy` (a lane's own `flag_policy` wins) applied to a feature wave: `info` = {feature, added: new rollout keys, offKeys: new default-off keys}.
 * A feature wave that adds no rollout key is `missing`: require refuses, warn prints, off is silent. Default-off keys are returned as `keepOff`: never activated here.
 */
export function flagPolicyOutcome(policy, lane, info) {
  const mode = policy?.lanes?.[lane]?.flag_policy ?? policy?.features?.flag_policy ?? "off";
  if (!info?.feature) return { mode, action: "none", keepOff: [] };
  const missing = !(info.added ?? []).length;
  return { mode, action: !missing || mode === "off" ? "none" : mode === "require" ? "error" : "warn", missing, keepOff: [...(info.offKeys ?? [])].sort() };
}

/** Activation of a default-off key is its own recorded step, never part of a wave deploy. */
export function recordActivation(state, key, actor, at) {
  (state.activations ??= []).push({ key, actor, at });
  return state;
}

/** The milestone lane: one release wave of every planned issue, base = the milestone branch, pipeline `full`. Explicit `--milestone` only. */
export function milestonePlan(plan, slug, pattern = "milestone/{slug}") {
  if (!slug) throw new Error("release: the milestone lane needs --milestone <slug> (it is never auto-planned)");
  const issues = plan.waves.flatMap((w) => w.issues), units = [...new Set(plan.waves.flatMap((w) => w.units))].sort();
  return { ...plan, waves: issues.length ? [{ id: "release", lane: "release", issues, units, base: pattern.replace("{slug}", slug), pipeline: "full" }] : [] };
}

/**
 * Run the plan. `ctx`: {io, plan, approval, state, save, managed, wave: "train"|"release"|"all", policy, fence?, runners: {build?, train, release, verify, mergeback, rollouts?}}.
 * Approval is the only input: nothing here needs a hand-posted status. @returns {Promise<{status: "done"|"unmanaged"|"awaiting-approval"|"stopped"|"refused", wave?, reason?, ran: string[]}>}
 */
export async function startRelease(ctx) {
  const { io, plan, state, runners, policy } = ctx, ran = [], say = (l) => io.print(l);
  if (!ctx.managed) { say("release start: unmanaged repo, nothing written (release.managed is off)"); return { status: "unmanaged", ran }; }
  if (ctx.approval?.state !== "approved") { say(`release start: plan ${plan.plan_hash.slice(0, 12)} is not approved (${ctx.approval?.state ?? "none"}); run: forgedock release go <id> --plan`); return { status: "awaiting-approval", ran }; }
  const only = ctx.wave ?? "all", waves = orderWaves(plan), save = async () => ctx.save?.();
  state.waves ??= {};
  const rel = waves.find((w) => !isTrain(w));
  if (rel && runners.build && only !== "train" && waveState(state, rel.id) === "PENDING") { // pipelining: the release wave builds while trains deploy; never CUT here
    const b = await runners.build(rel);
    if (b?.ok === false) return { status: "stopped", wave: rel.id, reason: b.reason ?? "build failed", ran };
    state.waves[rel.id] = { ...state.waves[rel.id], state: "BUILT" }; await save(); ran.push(`build:${rel.id}`);
  }
  for (const w of waves) {
    if (only !== "all" && (only === "train") !== isTrain(w)) continue;
    if (waveState(state, w.id) === "WAVE_DONE") { say(`wave ${w.id}: already WAVE_DONE, skipped`); continue; }
    const gate = cutAllowed(state, plan, w);
    if (!gate.ok) { say(`release start: ${gate.reason}`); return { status: "refused", wave: w.id, reason: gate.reason, ran }; }
    const lane = isTrain(w) ? "train" : "release", fp = flagPolicyOutcome(policy, lane, await runners.rollouts?.(w));
    if (fp.action === "error") return { status: "refused", wave: w.id, reason: `features.flag_policy=require: feature wave ${w.id} adds no rollout key`, ran };
    if (fp.action === "warn") say(`WARN: feature wave ${w.id} adds no rollout key (features.flag_policy=warn)`);
    if (fp.keepOff.length) { say(`wave ${w.id}: default-off key(s) ${fp.keepOff.join(", ")} stay off at deploy; activate with a recorded step`); (state.waves[w.id] ??= {}).keepOff = fp.keepOff; }
    const f = waveState(state, w.id) === "LIVE" ? { value: { status: "live" } } : await fenced(ctx.fence, { action: "wave", key: `wave:${plan.plan_hash}:${w.id}` }, async () => {
      state.waves[w.id] = { ...state.waves[w.id], state: "CUT" }; await save();
      const r = isTrain(w) ? await runners.train(w) : await runners.release(w, { soak: "full", pipeline: w.pipeline ?? "full", base: w.base });
      return r;
    });
    if (f.refused) return { status: "refused", wave: w.id, reason: f.refused, ran };
    const r = f.value;
    if (!["live", "done"].includes(r?.status)) { say(`wave ${w.id}: ${r?.status ?? "no result"}${r?.reason ? `: ${r.reason}` : ""}`); return { status: "stopped", wave: w.id, reason: r?.reason ?? r?.status, ran }; }
    state.waves[w.id] = { ...state.waves[w.id], state: "LIVE" }; await save();
    const done = { verified: (await runners.verify(w, r))?.verified, merged: r.status === "done" || r.merged !== false, mergedBack: (await runners.mergeback(w, r))?.validated };
    if (!waveDone(done)) { const why = !done.verified ? "not verified live" : !done.mergedBack ? "merge-back not validated" : "not merged"; say(`wave ${w.id}: LIVE but ${why}`); return { status: "stopped", wave: w.id, reason: why, ran }; }
    state.waves[w.id] = { ...state.waves[w.id], state: "WAVE_DONE" }; await save(); ran.push(w.id); say(`wave ${w.id}: WAVE_DONE`);
  }
  return { status: "done", ran };
}

/** Plan record of `ref` (a release id or a plan hash) from the ledger. */
async function loadPlan(ref, { ledger }) {
  const byId = await ledger.read(ref);
  if (byId?.state?.plan) return { id: ref, ...byId };
  for (const id of (await ledger.list?.()) ?? []) { const l = await ledger.read(id); if (l?.state?.plan?.plan_hash?.startsWith(ref)) return { id, ...l }; }
  return null;
}

/**
 * `forgedock release start [--plan <id|hash>] [--approve] [--wave train|release|all] [--milestone <slug>] [--lane milestone]`.
 * Without `--plan` a fresh plan is made (and recorded when managed). `deps`: {io, policy, policySha, managed, newId, ledger: {read, write, list}, decisions, post, runners, fence, actor, ...}.
 * @returns the exit code.
 */
export async function startFromCli(argv, deps) {
  const { io, managed } = deps, ms = flagOf(argv, "--milestone"), wave = flagOf(argv, "--wave") ?? "all";
  if (!["train", "release", "all"].includes(wave)) throw new Error("release start: --wave must be train|release|all");
  if (flagOf(argv, "--lane") === "milestone" && !ms) throw new Error("release start: the milestone lane needs --milestone <slug> (it is never auto-planned)");
  if (!managed) { io.print("release start: unmanaged repo, nothing written (release.managed is off)"); return 0; }
  let rec, ref = flagOf(argv, "--plan");
  if (ref) rec = await loadPlan(ref, deps);
  else {
    await planFromCli([...(ms ? ["--milestone", ms] : []), ...(flagOf(argv, "--repo") ? ["--repo", flagOf(argv, "--repo")] : [])], {
      ...deps, managed: true, ledger: async ({ id, plan }) => { rec = { id, state: { v: 1, id, kind: "plan", status: "planned", plan }, head: null }; await deps.ledger.create(id, rec.state); rec = await deps.ledger.read(id) ?? rec; rec.id = id; },
    });
  }
  if (!rec?.state?.plan) { io.print(`release start: no plan ${ref ?? ""} found`); return 1; }
  let plan = rec.state.plan;
  if (ms) plan = milestonePlan(plan, ms, deps.policy?.branches?.feature_pattern);
  const decisions = async () => approvalOf(plan, await deps.decisions(), deps.policy);
  let approval = await decisions();
  if (argv.includes("--approve") && approval.state !== "approved") { await deps.post(PLAN_DECISION(plan.plan_hash)); approval = await decisions(); }
  const state = rec.state;
  const save = async () => { const w = await deps.ledger.write(rec.id, state, rec.head); if (w?.ok) rec.head = w.sha; };
  const r = await startRelease({ io, plan, approval, state, save, managed, wave, policy: deps.policy, fence: deps.fence, runners: deps.runners });
  io.print(`release start ${rec.id}: ${r.status}${r.reason ? `: ${r.reason}` : ""}`);
  return r.status === "done" || r.status === "unmanaged" || r.status === "awaiting-approval" ? 0 : 1;
}

/** `forgedock release go <id> [--plan|--merge]`: writes the typed approval comment (`--plan` default) bound to the plan hash. */
export async function goFromCli(argv, { io, ledger, post, managed }) {
  const id = argv[0];
  if (!id || id.startsWith("--")) throw new Error("release go needs a release id; usage: forgedock release go <id> [--plan|--merge]");
  if (!managed) { io.print("release go: unmanaged repo, nothing written (release.managed is off)"); return 0; }
  const rec = await ledger.read(id);
  if (!rec?.state?.plan) { io.print(`release go: no plan record for ${id}`); return 1; }
  const hash = rec.state.plan.plan_hash, merge = argv.includes("--merge");
  await post(merge ? MERGE_DECISION(hash) : PLAN_DECISION(hash));
  io.print(`release go ${id}: ${merge ? "merge" : "plan"} approval recorded for ${hash.slice(0, 12)}`);
  return 0;
}

export { DECISION_RE, PLAN_LABEL };

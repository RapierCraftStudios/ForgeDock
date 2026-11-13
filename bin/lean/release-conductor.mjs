// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Release conductor (#5564, epic #5549 Phase 3, I17/I22/I24, R6): `forgedock release recover <id>`, the host-less recovery path run by
 * the version-pinned `forge-conductor.yml` workflow. With a stale lease (`CONDUCTOR_TTL_S`) it takes the lease (epoch + 1) and
 * continues the deploy from the last `done` (deployStep reconciles every unfinished intent); with a fresh lease it does nothing.
 * It acts only when the ledger says merged, for allowlisted actors (`trust.actors`), fenced by epoch, and never while HELD.
 * `CAPABILITIES` is the matrix of design 2.6: GitHub-only actions run, host-only ones wait (listed by `release status`), and
 * plan/build/review/merge/patch are refused. Safe end state: roll back to the recorded target, else hold and file `needs-agent`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readActive, readLedger, writeRelease } from "./release-ledger.mjs";
import { holdCheck, runControl } from "./release-control.mjs";
import { deployStep } from "./release-deploy.mjs";
import { runRollback, takeFence } from "./release-rollback.mjs";
import { riskClass } from "./release-verify.mjs";

export const CONDUCTOR_TTL_S = 900;
export const WORKFLOW_PATH = ".github/workflows/forge-conductor.yml";
export const CONDUCTOR_MARKER = "FORGE:CONDUCTOR";
const TEMPLATE = new URL("../../templates/github-actions/forge-conductor.yml", import.meta.url);

/** Design 2.6: where each action class may run. `needs` is a policy key the action requires. */
export const CAPABILITIES = {
  rerun: { where: "github" },
  redispatch: { where: "github" },
  observe: { where: "github" },
  livecheck: { where: "github" },
  smoke: { where: "github" },
  rollback_full: { where: "github", needs: "rollback.full_workflow" },
  sli_soak: { where: "host" },
  purge: { where: "host" },
};
/** Never run by the conductor, whatever the matrix says (patching is host-only work). */
export const REFUSED = ["plan", "build", "review", "merge", "patch"];

/** @returns {{run: true} | {host: true, why} | {refused: true, why}} */
export function capability(action, policy = {}) {
  if (REFUSED.includes(action)) return { refused: true, why: `the conductor never does ${action}` };
  const c = CAPABILITIES[action];
  if (!c) return { refused: true, why: `unknown action ${action}` };
  if (c.where === "host") return { host: true, why: `${action} is host-only; waits for a host driver` };
  if (c.needs && !c.needs.split(".").reduce((o, k) => o?.[k], policy)) return { host: true, why: `${action} needs ${c.needs}, which is not configured` };
  return { run: true };
}

/** `controls.conductor` of the policy: {enabled, watchdogCron, workflows}. */
export function conductorConfig(policy) {
  const c = policy?.controls?.conductor ?? {};
  return { enabled: c.enabled === true, watchdogCron: typeof c.watchdog_cron === "string" ? c.watchdog_cron : "0 */6 * * *", workflows: Array.isArray(c.workflows) && c.workflows.length ? c.workflows : ["Deploy"] };
}

/** Bootstrap guard (R10): a reason to refuse starting a managed release, or null. */
export function conductorGuard({ io, policy, def }) {
  if (!conductorConfig(policy).enabled) return null;
  try { io.git(["show", `origin/${def}:${WORKFLOW_PATH}`]); return null; } catch { return `controls.conductor is enabled but ${WORKFLOW_PATH} is absent from origin/${def}; run \`forgedock release init --conductor\` and merge it first`; }
}

/** The template with the exact forgedock version, the watchdog cron and the deploy workflow names filled in. */
export function renderConductor({ version, cron = "0 */6 * * *", workflows = ["Deploy"], template = readFileSync(TEMPLATE, "utf8") }) {
  return template.replaceAll("__FORGEDOCK_VERSION__", version).replaceAll("__WATCHDOG_CRON__", cron).replaceAll("__DEPLOY_WORKFLOWS__", JSON.stringify(workflows));
}

/** `release init --conductor`: write the pinned workflow into the repo (never overwrites). @returns exit code */
export function installConductor({ io, cwd, policy }) {
  const file = join(cwd, WORKFLOW_PATH);
  if (existsSync(file)) { io.print(`release init: ${WORKFLOW_PATH} exists; not overwriting`); return 1; }
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const c = conductorConfig(policy);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderConductor({ version, cron: c.watchdogCron, workflows: c.workflows }));
  io.print(`release init: wrote ${WORKFLOW_PATH} (forgedock@${version}); merge it to the default branch, then set controls.conductor.enabled`);
  return 0;
}

/** Stale = the lease heartbeat comment (else `expires`) is older than `ttlS`. */
async function leaseStale(lctx, lease, ttlS, now) {
  if (lease.commentId) {
    try { const c = await lctx.io.api("GET", `repos/${lctx.repo}/issues/comments/${lease.commentId}`); return now - Date.parse(c.updated_at) >= ttlS * 1000; } catch (e) { if (!/404|not found/i.test(String(e?.message ?? e))) throw e; }
  }
  return typeof lease.expires === "number" ? now >= lease.expires : true;
}

const mergedSha = (s) => s?.deploy?.merge ?? s?.steps?.["post-merge"]?.result?.merge ?? null;

/** One needs-agent issue per release (idempotent by marker). */
async function fileNeedsAgent(ctx, why) {
  const { io, repo, state } = ctx, marker = `${CONDUCTOR_MARKER} ${state.id}`;
  const found = JSON.parse(String(await io.gh(["issue", "list", "--repo", repo, "--state", "open", "--search", `"${marker}" in:body`, "--json", "number,body", "--limit", "20"])) || "[]");
  const hit = found.find((i) => String(i.body ?? "").includes(marker));
  if (hit) return hit.number;
  const url = String(await io.gh(["issue", "create", "--repo", repo, "--label", "needs-agent", "--title", `release ${state.id}: conductor stopped at last healthy state`, "--body", `${why}\n\nA host driver must finish this release (\`forgedock release --resume ${state.id}\`).\n\n<!-- ${marker} -->`])).trim();
  return Number(/\/issues\/(\d+)/.exec(url)?.[1]) || url;
}

/** Safe end state: roll back to the recorded target when the rollback workflow is configured (unless the live record never moved), else hold and file needs-agent. */
async function safeEnd(ctx, why, deps, { rollback = true } = {}) {
  const rb = capability("rollback_full", ctx.policy);
  if (rollback && rb.run) {
    const r = await deps.rollback(ctx, { reason: why, to: "full" });
    return { ended: r.ok ? "rolled-back" : "rollback-stopped", why, rollback: r };
  }
  const h = await runControl("hold", [ctx.state.id, "--reason", `conductor: ${why}`], { io: ctx.io, repo: ctx.repo, policy: ctx.policy, actor: ctx.actor, host: ctx.host, now: ctx.io.now?.() });
  const issue = await fileNeedsAgent(ctx, why);
  return { ended: "held", why, hold: h.ok, issue, ...(rb.run ? {} : { note: rb.why }) };
}

/**
 * Take over a stale lease for release `id` and continue it with GitHub-only actions.
 * `ctx`: {io, repo, id, policy, def, actor, host}. `deps` (tests): {deploy, rollback, takeFence}.
 * @returns {Promise<{noop: string} | {refused: string} | {live: true} | {ended: string, why: string}>}
 */
export async function recover(ctx, deps = {}) {
  const { io, repo, id, policy = {} } = ctx;
  const d = { deploy: deployStep, rollback: runRollback, takeFence, ...deps };
  const lctx = { io, repo, credential: "driver" };
  let active;
  try { active = await readActive(lctx); } catch (e) { return { refused: `cannot read _active (${String(e?.message ?? e)}); acting on nothing (I5)` }; }
  const lease = active.lease;
  if (!lease || lease.release !== id) return { noop: `no active lease for ${id}` };
  if (!(await leaseStale(lctx, lease, CONDUCTOR_TTL_S, io.now()))) return { noop: `lease of ${lease.holder} (epoch ${lease.epoch}) is fresh` };
  if (!ctx.actor || !(policy.trust?.actors ?? []).includes(ctx.actor)) return { refused: `actor ${ctx.actor ?? "unknown"} is not in trust.actors` };
  let why = null;
  try { why = await holdCheck(lctx, id); } catch (e) { why = `cannot read _active (${String(e?.message ?? e)})`; }
  if (why) return { refused: why };
  const led = await readLedger(lctx, id);
  if (!led || led.rejected) return { refused: led ? `ledger rejected: ${led.rejected}` : `no ledger for ${id}` };
  const state = led.state;
  if (!mergedSha(state)) return { refused: "the ledger does not say the release is merged; the conductor only recovers deploys" };
  if (state.deploy?.phase === "LIVE") return { noop: "release is already LIVE" };

  let head = led.head, chain = Promise.resolve();
  const write = async () => { const r = await writeRelease(lctx, id, state, head); if (!r.ok) throw new Error(`ledger write lost the race for ${id}`); head = r.sha; };
  const lane = policy.lanes?.[state.lane], pipeline = lane?.pipeline ?? "full";
  const verify = policy.verify ? { ...policy.verify, slis: [] } : undefined; // SLI soak is host-only (2.6): the other layers still run
  const c = { io, repo, def: ctx.def, state, policy, actor: ctx.actor, host: ctx.host, save: () => { chain = chain.then(write); }, config: { deploy: policy.deploy, deployPipeline: pipeline, policy, verify, verifyRisk: riskClass(state.lane, pipeline), verifySoak: lane?.soak_min } };
  const f = await d.takeFence(c, `conductor-${ctx.host ?? "gh"}`, CONDUCTOR_TTL_S);
  if (f.refused) return { refused: f.refused };
  c.fence = f.fence;
  const epoch = f.fence?.lease?.epoch, pending = (state.intents ?? []).filter((i) => !i.done).length;
  state.conductorWaiting = (policy.verify?.slis ?? []).length ? ["sli_soak (host-only)"] : [];
  let r;
  try { r = await d.deploy(c); } catch (e) { r = { blocked: true, reason: `conductor step failed: ${String(e?.message ?? e).split("\n")[0]}` }; }
  c.save(); await chain;
  if (r.live || r.skipped) { io.print?.(`release ${id}: conductor finished the deploy (epoch ${epoch}, ${pending} unfinished intent(s) replayed)`); return { live: true, epoch, waiting: state.conductorWaiting }; }
  const e = await safeEnd(c, r.reason ?? r.why ?? "deploy did not complete", d, { rollback: !r.hold });
  return { ...e, epoch };
}

/** `forgedock release recover <id> [--repo R]`; @returns 0 done, nothing to do or rolled back, 1 refused, 3 ended in hold or a stopped rollback. */
export async function recoverFromCli(argv, { io, policy, def, actor, host }) {
  const flagOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const id = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--repo");
  if (!id) { io.print("release recover: release id required"); return 1; }
  const repo = flagOf("--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const r = await recover({ io, repo, id, policy, def, actor, host });
  if (r.noop) { io.print(`release recover ${id}: nothing to do (${r.noop})`); return 0; }
  if (r.refused) { io.print(`release recover ${id}: refused: ${r.refused}`); return 1; }
  if (r.live) { io.print(`release recover ${id}: live`); return 0; }
  io.print(`release recover ${id}: ${r.ended} (${r.why})`);
  return r.ended === "rolled-back" ? 0 : 3;
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Verification of a deployed release (#5562, epic #5549 Phase 3, invariants I19/I22): the VERIFYING stage between LIVE_CHECK and LIVE.
 * Layers in order: (1) repo workflow results (smoke, edge gate, convergence), (2) the configured verification workflow, dispatched
 * through `fenced()`, (3) the SLI soak against an injected read-only metric source, (4) each issue's `[check:id]`, (5) flag-gated
 * features verified in the off state. Only then is `FORGE:VERIFIED <deploy sha>` written on each issue and the issue closed (I19).
 * An input this module cannot read blocks (I5). Verification only reads production: every probe is an injected `io.metrics` or a
 * default-branch check command, and the module has no write path of its own (I22, enforced by a static scan in the test).
 * Rationale: devdocs/decisions/5562-release-verify.md.
 */
import { fenced } from "./release-fence.mjs";
import { runFor, finished, BOUNDS } from "./release-deploy.mjs";
import { INFRA_SIGNATURES } from "./release-flakes.mjs";

/** Soak minutes by risk class (design 6.4); `lanes.<lane>.soak_min` (a number or a map by class) overrides. */
export const SOAK_MIN = { low: 10, medium: 20, full: 30, p0: 15 };
const KEYS = ["workflow", "results", "slis", "post_deploy_checks_file", "flags", "close_requires"];
const TRANSPORT = /identity|unauthori[sz]ed|\b40[13]\b|ECONN|ETIMEDOUT|timed? ?out|certificate|\bdns\b|transport|\b50[234]\b/i;
const json = (s) => JSON.parse(String(s || "null"));
const blocked = (reason, extra = {}) => ({ blocked: true, reason, ...extra });
const hold = (reason, kind) => blocked(`${reason} (owner ask: decide rollback or fix; label needs-agent when no host is attached)`, { hold: { kind, label: "needs-agent" } });
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const short = (sha) => String(sha).slice(0, 8);

export const verifiedMarker = (sha) => `<!-- FORGE:VERIFIED ${sha} -->`;
/** True when a comment names the deploy sha in a `FORGE:VERIFIED <sha>` marker (the prod-watch `fp=` form never matches). */
export function hasVerified(comments, sha) {
  return (comments ?? []).some((c) => [...String(c?.body ?? c ?? "").matchAll(/<!--\s*FORGE:VERIFIED\s+([0-9a-f]{7,64})\s*-->/gi)].some((m) => sameSha(m[1], sha)));
}

export const verifyConfigured = (v) => !!v && KEYS.some((k) => v[k] != null && !(Array.isArray(v[k]) && !v[k].length));

/** Risk class of a release: p0 lane, a full-pipeline release, else medium. */
export const riskClass = (lane, pipeline) => (lane === "p0" ? "p0" : pipeline === "full" ? "full" : "medium");

export function soakMinutes(risk, override) {
  const o = override && typeof override === "object" ? override[risk] : override;
  return typeof o === "number" && o > 0 ? o : SOAK_MIN[risk] ?? SOAK_MIN.medium;
}

/** SLI breaches of `{baseline, current}` readings beyond tolerance (default 20%); `worse: "lower"` for rates where a drop is bad. */
export function sliBreaches(slis, readings) {
  return slis.filter((s) => {
    const { baseline, current } = readings[s.name];
    const tol = typeof s.tolerance === "number" ? s.tolerance : 0.2, abs = s.abs ?? 0;
    return s.worse === "lower" ? current < baseline * (1 - tol) - abs : current > baseline * (1 + tol) + abs;
  }).map((s) => ({ sli: s.name, ...readings[s.name] }));
}

/** An emitted rollback trigger is recorded once and handed to the ladder's sink (#5563) when one is attached. */
function rollbackResult(ctx, st, reason) {
  if (!st.rollback) { st.rollback = { reason }; ctx.save(); ctx.rollbackTrigger?.({ reason, sha: ctx.state.deploy?.merge }); }
  return blocked(`${reason}; rollback trigger emitted to the ladder (#5563)`, { rollback: st.rollback });
}

async function layerResults(ctx, v, sha, st, b) {
  const { io, repo } = ctx;
  for (const w of v.results ?? []) {
    let run;
    try { run = (json(await io.gh(["run", "list", "--repo", repo, "--workflow", w.workflow, "--commit", sha, "--json", "databaseId,status,conclusion", "--limit", "5"])) ?? []).find((r) => r.conclusion !== "skipped"); }
    catch (e) { return blocked(`cannot read ${w.workflow} results (I5): ${String(e?.message ?? e).split("\n")[0]}`); }
    if (!run || run.status !== "completed") return blocked(`${w.workflow} (${w.kind}) has no completed run for ${short(sha)}; resume once it finishes`);
    if (run.conclusion === "success") continue;
    if (w.kind === "convergence") { (st.convergence ??= []).push(`${w.workflow} run ${run.databaseId} ${run.conclusion}`); continue; }
    let log = null; try { log = String(await io.gh(["run", "view", String(run.databaseId), "--repo", repo, "--log-failed"])); } catch { /* unreadable log */ }
    if (log == null || TRANSPORT.test(log) || INFRA_SIGNATURES.some(([, re]) => re.test(log))) { // identity/transport: not evidence about the release
      if (log != null && st.reverifies < 1) { st.reverifies += 1; ctx.save(); await io.sleep(b.pollMs); return layerResults(ctx, v, sha, st, b); }
      return hold(`${w.workflow} (${w.kind}) run ${run.databaseId} failed on identity/transport after ${st.reverifies} re-verify; no blind rollback`, "verify-transport");
    }
    return rollbackResult(ctx, st, `${w.workflow} (${w.kind}) run ${run.databaseId} concluded ${run.conclusion}`);
  }
  return null;
}

async function layerWorkflow(ctx, v, sha, st, b) {
  const r = await runFor(ctx, { workflow: v.workflow, sha, inputs: {}, key: `verify:${sha}`, startPolls: 1, b });
  if (r.err) return blocked(r.err);
  const stageS = ctx.config.deploy?.stage_timeout_s ?? BOUNDS.defaultStageS;
  const done = await finished(ctx, v.workflow, sha, Math.ceil(stageS * 1000 / b.runPollMs), b);
  if (!done) return blocked(`${v.workflow} run ${r.run.databaseId} did not finish within stage_timeout_s; resume (never redispatched)`);
  return done.conclusion === "success" ? null : rollbackResult(ctx, st, `${v.workflow} run ${done.databaseId} concluded ${done.conclusion}`);
}

async function layerSoak(ctx, v, sha, st) {
  const { io } = ctx, slis = v.slis ?? [];
  if (!io.metrics) { st.sli = "skipped (no host)"; return null; }
  if (!slis.length) { st.sli = "skipped (no slis configured)"; return null; }
  const min = soakMinutes(ctx.config.verifyRisk ?? "medium", ctx.config.verifySoak);
  st.soakStart ??= io.now(); ctx.save();
  const wait = st.soakStart + min * 60_000 - io.now();
  if (wait > 0) await io.sleep(wait);
  const readings = {};
  for (const s of slis) {
    let r; try { r = await io.metrics({ sli: s, minutes: min, sha }); } catch (e) { return blocked(`cannot read SLI ${s.name} (I5): ${String(e?.message ?? e).split("\n")[0]}`); }
    if (![r?.baseline, r?.current].every(Number.isFinite)) return blocked(`SLI ${s.name} returned no baseline/current (I5)`);
    readings[s.name] = { baseline: r.baseline, current: r.current };
  }
  const bad = sliBreaches(slis, readings);
  if (bad.length) return rollbackResult(ctx, st, `SLI breach over ${min} min: ${bad.map((x) => `${x.sli} ${x.current} vs baseline ${x.baseline}`).join(", ")}`);
  st.sli = `pass (${min} min soak, ${slis.length} sli)`;
  return null;
}

async function readIssue(ctx, n) {
  return json(await ctx.io.gh(["issue", "view", String(n), "--repo", ctx.repo, "--json", "state,body,comments"])) ?? {};
}

/** Windowed checks are follow-ups on the rollup issue and never block the close. */
async function followUp(ctx, st, id, issue, entry, sha) {
  const key = `${issue}:${id}`;
  if (st.followups.includes(key)) return;
  try {
    const [roll] = json(await ctx.io.gh(["issue", "list", "--repo", ctx.repo, "--state", "open", "--search", "FORGE:POSTDEPLOY_ROLLUP in:body", "--json", "number", "--limit", "1"])) ?? [];
    if (roll) await ctx.io.gh(["issue", "comment", String(roll.number), "--repo", ctx.repo, "--body", `- [ ] [check:${id}] windowed (${entry.for}) for #${issue} at deploy ${short(sha)}`]);
  } catch { /* a follow-up that cannot be filed does not block the close */ }
  st.followups.push(key); ctx.save();
}

async function layerChecks(ctx, v, sha, st, issues) {
  if (!v.post_deploy_checks_file || !issues.length) return null;
  const want = [];
  for (const n of issues) {
    let info; try { info = await readIssue(ctx, n); } catch (e) { return blocked(`cannot read issue #${n} (I5): ${String(e?.message ?? e).split("\n")[0]}`); }
    for (const m of String(info.body ?? "").matchAll(/\[check:([\w.-]+)\]/g)) want.push([n, m[1]]);
  }
  if (!want.length) return null;
  let table; // the registry comes from the default branch, never the working tree (I13)
  try { table = json(ctx.io.git(["show", `origin/${ctx.def}:${v.post_deploy_checks_file}`])); } catch (e) { return blocked(`cannot read ${v.post_deploy_checks_file} from origin/${ctx.def} (I13, I5): ${String(e?.message ?? e).split("\n")[0]}`); }
  for (const [n, id] of want) {
    const entry = table?.[id];
    if (!entry?.run) return blocked(`#${n} names [check:${id}] but ${v.post_deploy_checks_file} has no such check`);
    if (entry.for) { await followUp(ctx, st, id, n, entry, sha); continue; }
    if (st.checks[id] === "pass") continue; // each check runs once
    const r = await ctx.io.rehearse(entry.run, { timeout: (entry.timeout ?? 120) * 1000 });
    if (!r?.ok) return hold(`post-deploy check ${id} (#${n}) failed: ${String(r?.output ?? "").trim().slice(-200)}`, "check");
    st.checks[id] = "pass"; ctx.save();
  }
  return null;
}

async function layerFlags(ctx, v, st) {
  for (const f of v.flags ?? []) {
    if (st.flags[f.flag] === "off") continue;
    const r = await ctx.io.rehearse(f.off_command, { timeout: 120_000 }); // observes the off state; activation is never performed
    if (!r?.ok) return hold(`flag ${f.flag} could not be verified in the off state: ${String(r?.output ?? "").trim().slice(-200)}`, "flag");
    st.flags[f.flag] = "off"; ctx.save();
  }
  return null;
}

/** CLOSING guard (I19): with `mode: verified` an issue closes only when a `FORGE:VERIFIED` names the deploy sha; `deployed` is the opt-out. */
export async function closeIssues(ctx, { issues, sha, mode = "verified" }) {
  const { io, repo } = ctx, closed = [], refused = [];
  for (const n of issues) {
    let info; try { info = await readIssue(ctx, n); } catch (e) { refused.push({ issue: n, why: `unreadable: ${String(e?.message ?? e).split("\n")[0]}` }); continue; }
    if (String(info.state).toUpperCase() === "CLOSED") continue;
    if (mode !== "deployed" && !hasVerified(info.comments, sha)) { refused.push({ issue: n, why: `no FORGE:VERIFIED ${short(sha)}` }); continue; }
    const key = `${ctx.fence?.lease?.release ?? ctx.state.id ?? "-"}:verify:${ctx.fence?.lease?.epoch ?? 0}:close:${n}`;
    const f = await fenced(ctx.fence, { action: "close", key }, () => io.gh(["issue", "close", String(n), "--repo", repo, "--comment", `Released and verified at ${short(sha)}.`]));
    if (f.refused) refused.push({ issue: n, why: f.refused }); else closed.push(n);
  }
  return { closed, refused };
}

/** Issue numbers of the release (the release record, else the release-PR step). */
export function releaseIssues(state) {
  const raw = state.release?.issues ?? state.steps?.["release-pr"]?.result?.issues ?? [];
  return raw.map((i) => Number(i?.number ?? i)).filter(Number.isInteger);
}

/**
 * Run the layers (resumable: `state.verify` records each passed layer, so a resume re-runs none and redispatches nothing).
 * @returns {Promise<{verified: true, outcome, sli, closed}|{blocked: true, reason, hold?, rollback?}>}
 */
export async function verifyStep(ctx, sha) {
  const v = ctx.config.verify, { io } = ctx;
  const st = (ctx.state.verify ??= { layers: {}, reverifies: 0, checks: {}, flags: {}, followups: [] });
  const b = { ...BOUNDS, ...(ctx.config.deployBounds ?? {}) };
  const issues = releaseIssues(ctx.state);
  const layers = [
    ["results", () => layerResults(ctx, v, sha, st, b), !!v.results?.length],
    ["workflow", () => layerWorkflow(ctx, v, sha, st, b), !!v.workflow],
    ["sli", () => layerSoak(ctx, v, sha, st), true],
    ["checks", () => layerChecks(ctx, v, sha, st, issues), true],
    ["flags", () => layerFlags(ctx, v, st), !!v.flags?.length],
  ];
  for (const [name, run, on] of layers) {
    if (!on || st.layers[name]) continue;
    const r = await run();
    if (r) return r;
    st.layers[name] = "pass"; ctx.save();
  }
  io.print?.(`release verify ${short(sha)}: sli: ${st.sli ?? "n/a"}`);
  if (st.convergence?.length) {
    st.outcome = "released-with-convergence-failures";
    if (!st.repair) {
      st.repair = true; ctx.save();
      await io.gh(["issue", "create", "--repo", ctx.repo, "--title", `released-with-convergence-failures: ${short(sha)}`, "--body", `Deploy and smoke are green; convergence failed (no rollback):\n${st.convergence.map((c) => `- ${c}`).join("\n")}`]);
    }
  }
  for (const n of issues) { // every layer passed: the evidence comment, then the guarded close
    const info = await readIssue(ctx, n).catch(() => null);
    if (info && !hasVerified(info.comments, sha)) await io.gh(["issue", "comment", String(n), "--repo", ctx.repo, "--body", `${verifiedMarker(sha)}\nrelease verified at ${short(sha)} (${Object.keys(st.layers).join(", ")}).`]);
  }
  const c = await closeIssues(ctx, { issues, sha, mode: v.close_requires ?? "verified" });
  if (c.refused.length) return blocked(`CLOSING refused (I19): ${c.refused.map((r) => `#${r.issue} ${r.why}`).join("; ")}`);
  return { verified: true, outcome: st.outcome ?? "verified", sli: st.sli ?? null, closed: c.closed };
}

/** `forgedock release verify <id>`: re-run the verification of a deployed release from its local record. */
export async function verifyReleaseById({ io, state, save, def, policy, lane }) {
  const sha = state?.deploy?.merge;
  if (!sha || !["LIVE_CHECKED", "VERIFYING", "LIVE"].includes(state.deploy.phase)) return blocked("release has not passed LIVE_CHECK; nothing to verify yet");
  const pipeline = policy?.lanes?.[lane]?.pipeline ?? "full";
  const config = { deploy: policy?.deploy, verify: policy?.verify, verifyRisk: riskClass(lane, pipeline), verifySoak: policy?.lanes?.[lane]?.soak_min };
  if (!verifyConfigured(config.verify)) return blocked("verify policy is not configured (.forge/release.yaml verify)");
  const r = await verifyStep({ io, repo: state.repo, def, config, state, save }, sha);
  io.print(r.verified ? `release verify ${state.id}: ${r.outcome}; sli: ${r.sli ?? "n/a"}; closed ${r.closed.length} issue(s)` : `release verify ${state.id}: blocked: ${r.reason}`);
  return r;
}

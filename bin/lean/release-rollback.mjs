// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rollback ladder (#5563, epic #5549 Phase 3, I8/I10/I26, Q8): `forgedock release rollback <id> [--to flag|unit|full] --reason "..."`.
 * The engine picks the lowest sufficient rung and records why: flag (kill the wave's rollout flags), unit (the service pipeline's
 * rollback action with the recorded previous per-unit digests), full (the standalone rollback workflow), stop (hold, page, incident).
 * Every dispatch is `fenced()` with `forge_epoch` and built by `buildDispatchArgs` (I26). After a unit or full rung the rollback
 * result record must show matching per-service (and per-host) counts; a mismatch, an unreadable record or a failed health
 * command escalates to stop. Rollback to code that predates a destructive migration is refused (I8). This module never talks to
 * a database: the destructive-migration patterns live in release-config.mjs and are only matched against migration file text.
 * Afterwards: a revert PR (default == live, I10), the wave's issues reopened, one incident issue, later waves held.
 * Rationale: devdocs/decisions/5563-release-rollback.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenced } from "./release-fence.mjs";
import { buildDispatchArgs, runControl } from "./release-control.mjs";
import { acquireLease } from "./release-ledger.mjs";
import { releaseIssues } from "./release-verify.mjs";
import { DESTRUCTIVE_SQL, MIGRATION_PATHS } from "./release-config.mjs";

export const RUNGS = ["flag", "unit", "full", "stop"];
export const ROLLBACK_TRIGGERS = ["smoke", "health", "livecheck", "sli", "crashloop", "human"];
export const INCIDENT_MARKER = "FORGE:INCIDENT";
export const ROLLBACK_BOUNDS = { pollMs: 10_000, startPolls: 6, donePolls: 180 };
const FLAG_OK = ["smoke", "health", "sli", "crashloop", "human"]; // a wrong deploy (livecheck) is not fixed by a flag
const json = (s) => { try { return JSON.parse(String(s || "null")); } catch { return null; } };
const short = (s) => String(s ?? "").slice(0, 8);
const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/** Trigger class of a recorded reason (release-verify / release-deploy wording). */
export function classifyTrigger(reason) {
  const r = String(reason ?? "");
  if (/SLI/i.test(r)) return "sli";
  if (/crash/i.test(r)) return "crashloop";
  if (/LIVE_CHECK|live sha|digest/i.test(r)) return "livecheck";
  if (/health/i.test(r)) return "health";
  if (/smoke|edge|verify/i.test(r)) return "smoke";
  return "human";
}

/**
 * The lowest sufficient rung at or after `from` (`--to` or an escalation floor), honouring `rollback.ladder`.
 * @returns {{rung: string, why: string}}
 */
export function chooseRung({ trigger, from = "flag", rb = {}, target = null }) {
  const ladder = (rb.ladder?.length ? rb.ladder : RUNGS).filter((r) => RUNGS.includes(r));
  const ok = {
    flag: () => (!(rb.flags ?? []).some((f) => f?.kill_command) ? "no rollout flag has a kill_command" : FLAG_OK.includes(trigger) ? null : `a ${trigger} trigger is not fixed by a flag`),
    unit: () => (!rb.unit_workflow ? "rollback.unit_workflow is not set" : Object.keys(target?.images ?? {}).length ? null : "no recorded previous per-unit digests"),
    full: () => (rb.full_workflow ? null : "rollback.full_workflow is not set"),
    stop: () => null,
  };
  const skipped = [];
  for (const rung of RUNGS.slice(RUNGS.indexOf(from))) {
    if (!ladder.includes(rung) && rung !== "stop") { skipped.push(`${rung}: not in rollback.ladder`); continue; }
    const why = ok[rung]();
    if (!why) return { rung, why: `${trigger}: lowest sufficient rung is ${rung}${skipped.length ? ` (skipped ${skipped.join("; ")})` : ""}` };
    skipped.push(`${rung}: ${why}`);
  }
  return { rung: "stop", why: `${trigger}: no rung sufficient (${skipped.join("; ")})` };
}

/**
 * I8: destructive migrations between the rollback target and the live sha, read from migration file text only.
 * @returns {{ok: true} | {refused: string}} unreadable git history refuses (fail closed)
 */
export function refuseAcross({ io, target, live, paths = MIGRATION_PATHS }) {
  let files;
  try { files = String(io.git(["diff", "--name-only", "--diff-filter=AM", `${target}..${live}`, "--", ...paths])).split("\n").filter(Boolean); }
  catch (e) { return { refused: `cannot list migrations between ${short(target)} and ${short(live)}: ${String(e?.message ?? e).split("\n")[0]}` }; }
  for (const f of files) {
    let text;
    try { text = String(io.git(["show", `${live}:${f}`])); } catch (e) { return { refused: `cannot read migration ${f}: ${String(e?.message ?? e).split("\n")[0]}` }; }
    if (DESTRUCTIVE_SQL.test(text)) return { refused: `rollback to ${short(target)} crosses destructive migration ${f} (I8); roll forward instead` };
  }
  return { ok: true };
}

/** Per-service (and per-host) counts of the rollback result record against the recorded previous set (Q8). @returns {string|null} the mismatch */
export function checkCounts(record, target) {
  const units = record?.units;
  if (!units || typeof units !== "object" || !Object.keys(units).length) return "rollback result record is unreadable or empty";
  const images = target?.images ?? {};
  const missing = Object.keys(images).filter((u) => !units[u]);
  if (missing.length) return `result record has no entry for ${missing.join(", ")}`;
  for (const [u, x] of Object.entries(units)) {
    if (images[u] && x?.digest && x.digest !== images[u]) return `${u}: rolled to ${x.digest}, recorded previous digest is ${images[u]}`;
    for (const [h, c] of Object.entries(x?.hosts ?? { all: x })) {
      if (!Number.isInteger(c?.expected) || !Number.isInteger(c?.rolled)) return `${u}@${h}: counts missing`;
      if (c.rolled !== c.expected) return `${u}@${h}: ${c.rolled} of ${c.expected} rolled back`;
    }
  }
  return null;
}

async function poll(io, polls, ms, fn) {
  for (let i = 0; i < polls; i++) { const v = await fn(); if (v) return v; if (i < polls - 1) await io.sleep(ms); }
  return null;
}

/** A fenced dispatch of `workflow` and the run it makes (newer than every run seen before). Never redispatched once an intent exists (I7). */
async function dispatchRung(ctx, rung, workflow, inputs, b) {
  const { io, repo } = ctx, st = ctx.state.rollbackRun, rec = (st.dispatch ??= {})[rung] ??= {};
  const list = async () => json(await io.gh(["run", "list", "--repo", repo, "--workflow", workflow, "--json", "databaseId,status,conclusion", "--limit", "10"])) ?? [];
  if (rec.baseId == null) { rec.baseId = Math.max(0, ...(await list()).map((r) => r.databaseId)); ctx.save(); }
  const had = rec.dispatched || (ctx.state.intents ?? []).some((i) => i.action === "dispatch" && String(i.key).endsWith(`:rollback:${rung}`));
  if (!had) {
    const key = `${ctx.fence?.lease?.release ?? ctx.state.id}:${ctx.fence?.lease?.epoch ?? 0}:rollback:${rung}`;
    const f = await fenced(ctx.fence, { action: "dispatch", key }, (epoch) => io.gh(buildDispatchArgs({ workflow, repo, ref: ctx.def, inputs: { ...inputs, ...(epoch != null ? { forge_epoch: epoch } : {}) } })));
    if (f.refused) return { err: `dispatch ${f.refused}` };
    rec.dispatched = true; ctx.save();
  }
  const newer = async () => (await list()).find((r) => r.databaseId > rec.baseId) ?? null;
  const run = await poll(io, b.startPolls, b.pollMs, newer);
  if (!run) return { err: `no ${workflow} run appeared after the ${rung} rollback dispatch (never redispatched; check the Actions tab)` };
  const done = await poll(io, b.donePolls, b.pollMs, async () => { const r = await newer(); return r?.status === "completed" ? r : null; });
  if (!done) return { err: `${workflow} run ${run.databaseId} did not finish` };
  return done.conclusion === "success" ? { run: done } : { err: `${workflow} run ${done.databaseId} concluded ${done.conclusion}` };
}

async function healthy(io, rb) {
  if (!rb.health_command) return { ok: true, note: "health: unchecked (rollback.health_command unset)" };
  const r = await io.rehearse(rb.health_command, { timeout: 120_000 });
  return r?.ok ? { ok: true, note: "health: ok" } : { ok: false, why: `health command failed: ${String(r?.output ?? "").trim().slice(-200)}` };
}

/** Execute one rung. @returns {{ok: true, note} | {fail: string}} */
async function runRung(ctx, rung, rb, b, reason) {
  const { io } = ctx, d = ctx.state.deploy, target = d.target;
  if (rung === "flag") {
    for (const f of rb.flags ?? []) {
      if (!f?.kill_command) continue;
      const r = await fenced(ctx.fence, { action: "flag-kill", key: `${ctx.fence?.lease?.release ?? ctx.state.id}:${ctx.fence?.lease?.epoch ?? 0}:rollback:flag:${f.flag}` }, () => io.rehearse(f.kill_command, { timeout: 120_000 }));
      if (r.refused) return { fail: `flag ${f.flag}: ${r.refused}` };
      if (!r.value?.ok) return { fail: `flag ${f.flag}: kill command failed` };
    }
    const h = await healthy(io, rb);
    return h.ok ? { ok: true, note: h.note } : { fail: h.why };
  }
  const workflow = rung === "unit" ? rb.unit_workflow : rb.full_workflow;
  const inputs = rung === "unit"
    ? { action: rb.unit_action ?? "rollback", sha: target.sha, digests: JSON.stringify(target.images ?? {}) }
    : { sha: target.sha, reason: String(reason).slice(0, 200) };
  const r = await dispatchRung(ctx, rung, workflow, inputs, b);
  if (r.err) return { fail: r.err };
  const rr = rb.result_command ? await io.rehearse(rb.result_command, { timeout: 120_000 }) : null;
  const bad = checkCounts(rr?.ok ? json(rr.output) : null, target);
  if (bad) return { fail: `counts check: ${bad}` };
  const h = await healthy(io, rb);
  return h.ok ? { ok: true, note: `counts match the recorded set; ${h.note}` } : { fail: h.why };
}

const ensureIssue = async (ctx, title, body, marker) => { // exactly one issue per marker, any state
  const { io, repo } = ctx;
  const found = json(await io.gh(["issue", "list", "--repo", repo, "--state", "all", "--search", `"${marker}" in:body`, "--json", "number,body", "--limit", "20"])) ?? [];
  const hit = found.find((i) => String(i.body ?? "").includes(marker));
  if (hit) return { number: hit.number, created: false };
  const url = String(await io.gh(["issue", "create", "--repo", repo, "--title", title, "--body", `${body}\n\n<!-- ${marker} -->`])).trim();
  return { number: Number(/\/issues\/(\d+)/.exec(url)?.[1]) || url, created: true };
};

/** Revert PR to the default branch (I10), built in a throwaway worktree so the caller's checkout is never touched. */
async function revertPr(ctx, reason) {
  const { io, repo, def } = ctx, sha = ctx.state.deploy.merge, branch = `rollback/${ctx.state.id}`;
  const open = json(await io.gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"])) ?? [];
  if (open[0]) return { pr: open[0].number, reused: true };
  const dir = mkdtempSync(join(ctx.tmp ?? tmpdir(), "forge-rollback-"));
  const g = (...a) => io.git(["-C", dir, ...a]);
  try {
    io.git(["fetch", "origin", def]);
    io.git(["worktree", "add", "--detach", dir, `origin/${def}`]);
    const parents = String(g("rev-list", "--parents", "-n", "1", sha)).trim().split(/\s+/).length - 1;
    g("checkout", "-b", branch);
    g("revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), sha);
    const f = await fenced(ctx.fence, { action: "revert-pr", key: `${ctx.state.id}:${ctx.fence?.lease?.epoch ?? 0}:rollback:revert` }, () => { g("push", "origin", branch); });
    if (f.refused) return { err: f.refused };
  } catch (e) { return { err: `revert PR not created: ${String(e?.message ?? e).split("\n")[0]}` }; }
  finally { try { io.git(["worktree", "remove", "--force", dir]); } catch { rmSync(dir, { recursive: true, force: true }); } }
  const url = String(await io.gh(["pr", "create", "--repo", repo, "--base", def, "--head", branch, "--title", `Revert release ${ctx.state.id} (rollback)`, "--body", `Rollback of ${short(sha)} so ${def} matches live (I10).\n\nCause: ${reason}`])).trim();
  return { pr: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || url, reused: false };
}

async function reopenIssues(ctx, reason) {
  const { io, repo } = ctx, out = [];
  for (const n of releaseIssues(ctx.state)) {
    const info = json(await io.gh(["issue", "view", String(n), "--repo", repo, "--json", "state"]));
    if (String(info?.state).toUpperCase() !== "CLOSED") continue;
    const f = await fenced(ctx.fence, { action: "reopen", key: `${ctx.state.id}:${ctx.fence?.lease?.epoch ?? 0}:rollback:reopen:${n}` }, () => io.gh(["issue", "reopen", String(n), "--repo", repo, "--comment", `Reopened: release ${ctx.state.id} was rolled back (${reason}).`]));
    if (!f.refused) out.push(n);
  }
  return out;
}

async function page(ctx, webhook, text) {
  if (!webhook) return "no events.webhook_url";
  try { const r = await (ctx.io.post ?? ((u, body) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })))(webhook, { text }); return r?.ok === false ? `webhook answered ${r.status}` : "paged"; }
  catch (e) { return `page failed: ${String(e?.message ?? e).split("\n")[0]}`; }
}

/**
 * Run the ladder for `ctx.state` (a deployed release). `ctx`: {io, repo, def, state, save, fence?, policy, actor, host, config?}.
 * `args`: {reason, to?, trigger?, later?: [release ids to hold]}. State in `state.rollbackRun`; reruns skip finished post-steps.
 * @returns {Promise<{ok: boolean, rung: string, why: string, history: object[], refused?: string, post: object}>}
 */
export async function runRollback(ctx, { reason, to = "flag", trigger = null, later = [] }) {
  const { io, state } = ctx, rb = ctx.policy?.rollback ?? {}, b = { ...ROLLBACK_BOUNDS, ...(ctx.config?.rollbackBounds ?? {}) };
  const run = (state.rollbackRun ??= { history: [], post: {} });
  const d = state.deploy;
  if (!d?.target?.sha || !d.merge) return { ok: false, rung: "none", why: "no recorded rollback target (I9); nothing to roll back", history: run.history, refused: "no recorded rollback target", post: run.post };
  const trig = trigger ?? classifyTrigger(reason);
  if (rb.triggers?.length && trig !== "human" && !rb.triggers.includes(trig)) return { ok: false, rung: "none", why: `trigger ${trig} is not in rollback.triggers`, history: run.history, refused: `trigger ${trig} is not enabled`, post: run.post };
  run.reason = reason; run.trigger = trig; ctx.save();
  const across = refuseAcross({ io, target: d.target.sha, live: d.merge });
  let from = to, refused = null, rung, why, note = "";
  for (;;) {
    ({ rung, why } = chooseRung({ trigger: trig, from, rb, target: d.target }));
    if (across.refused && (rung === "unit" || rung === "full")) { refused = across.refused; run.history.push({ rung, why: `refused: ${across.refused}` }); from = "stop"; continue; }
    run.rung = rung; run.why = why; ctx.save();
    if (rung === "stop") break;
    const r = await runRung(ctx, rung, rb, b, reason);
    run.history.push({ rung, why, result: r.ok ? r.note : r.fail });
    if (r.ok) { note = r.note; break; }
    from = rung === "flag" ? "unit" : "stop"; // a failed flag kill tries code; a failed unit/full or counts mismatch stops (Q8)
  }
  const ok = rung !== "stop";
  const post = run.post;
  if (rung === "unit" || rung === "full") { if (rb.open_revert_pr !== false) post.revert ??= await revertPr(ctx, reason); }
  if (ok) post.reopened ??= await reopenIssues(ctx, reason);
  const inc = await (post.incident ? Promise.resolve(post.incident) : ensureIssue(ctx, `incident: rollback of release ${state.id}`, `Release ${state.id} (${short(d.merge)}) was rolled back via rung ${rung}.\n\nTrigger: ${trig}\nReason: ${reason}\nWhy this rung: ${why}\n${refused ? `Refused: ${refused}\n` : ""}${note ? `Result: ${note}\n` : ""}Ladder: ${run.history.map((h) => `${h.rung} -> ${h.result ?? h.why}`).join("; ") || "none"}`, `${INCIDENT_MARKER} ${state.id}`));
  post.incident = inc;
  if (rung === "stop") post.paged ??= await page(ctx, ctx.policy?.events?.webhook_url, `Release ${state.id} rollback stopped at rung stop: ${reason}. Incident #${inc.number}.`);
  post.held ??= [];
  for (const id of io.api ? later.filter((x) => x !== state.id && !post.held.includes(x)) : []) { // later waves are held through the audited control path
    const h = await runControl("hold", [id, "--reason", `release ${state.id} rolled back: ${reason}`], { io, repo: ctx.repo, policy: ctx.policy, actor: ctx.actor, host: ctx.host, now: io.now?.() });
    if (h.ok) post.held.push(id);
  }
  run.done = true; ctx.save();
  return { ok, rung, why, history: run.history, ...(refused ? { refused } : {}), post };
}

/** The lease that fences the rollback's effects (own epoch, `forge_epoch` on every dispatch); unmanaged (no `io.api`): no fence. */
export async function takeFence(ctx, holder, ttlS = 300) {
  if (!ctx.io.api) return { fence: null };
  const lctx = { io: ctx.io, repo: ctx.repo, credential: "driver" };
  const l = await acquireLease(lctx, { holder, release: ctx.state.id, issue: ctx.state.steps?.["release-pr"]?.result?.pr, ttlS, now: ctx.io.now() });
  if (!l.ok) return { refused: l.refused ?? "lease lost the race" };
  const record = async (rec) => { const a = (ctx.state.intents ??= []); const i = a.findIndex((x) => x.key === rec.key); if (i < 0) a.push(rec); else a[i] = rec; ctx.save(); };
  return { fence: { lctx, lease: l.lease, record, now: () => new Date(ctx.io.now()).toISOString() } };
}

/** `forgedock release rollback <id> --reason "..." [--to flag|unit|full] [--later id,id] [--repo R] [--json]`; @returns 0 rolled back, 1 refused, 3 stopped. */
export async function rollbackFromCli(argv, { io, rel, policy, def, actor, host }) {
  const id = argv.find((a, i) => !a.startsWith("--") && !["--reason", "--to", "--later", "--repo"].includes(argv[i - 1]));
  const reason = flagOf(argv, "--reason"), to = flagOf(argv, "--to") ?? "flag", json_ = argv.includes("--json");
  const say = (o, line) => io.print(json_ ? JSON.stringify(o) : line);
  const refuse = (error) => { say({ ok: false, error }, `release rollback: refused: ${error}`); return 1; };
  if (!id) return refuse("release id required");
  if (!reason || !reason.trim() || reason.startsWith("--")) return refuse("--reason is required");
  if (!RUNGS.slice(0, 3).includes(to)) return refuse(`--to must be one of ${RUNGS.slice(0, 3).join("|")}`);
  const state = rel.load();
  if (!state) return refuse(`no release ${id}`);
  const repo = flagOf(argv, "--repo") ?? state.repo;
  const ctx = { io, repo, def, state, save: () => rel.save(state), policy, actor, host };
  if (io.api) { // mutating: audited like every control verb (#5556)
    const c = await runControl("rollback", [id, "--reason", reason, "--to", to], { io, repo, policy, actor, host, now: io.now?.() });
    if (!c.ok) return refuse(c.error);
  }
  const f = await takeFence(ctx, io.holder ?? `host-${process.pid}`);
  if (f.refused) return refuse(f.refused);
  ctx.fence = f.fence;
  const r = await runRollback(ctx, { reason, to, trigger: null, later: (flagOf(argv, "--later") ?? "").split(",").filter(Boolean) });
  if (r.refused && r.rung === "none") return refuse(r.refused);
  say(r, `release rollback ${id}: ${r.ok ? "rolled back" : "stopped"} at rung ${r.rung} (${r.why})${r.refused ? `; refused: ${r.refused}` : ""}`);
  return r.ok ? 0 : 3;
}

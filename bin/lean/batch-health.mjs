// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Early batch health (#5167). A batch that fails in its first minutes (roots engine-error, the rest skipped) or is refused
 * at launch used to look "launched" until someone read its log. The batch runner (`runBatch`, the schedd per-batch runner)
 * evaluates the batch's `state.json` at T+15 and T+60 min after `plan.created` and once when the batch ends; the first
 * unhealthy evaluation emits one `BATCH UNHEALTHY` alert (a runner line, a GitHub comment on `orchestrate.health.issue`
 * or the batch's `--epic` issues, and `notify.command`) with its causes and recovery commands. `health.json` in the batch
 * dir records the checkpoints done and the alert, so a restarted daemon re-arms only the remaining checks and never alerts
 * twice. A refused launch has no batch dir: it is recorded in `<batch root>/refusals.json`. `forgedock status` reads both.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawn as spawnProc } from "node:child_process";
import { join } from "node:path";
import { listBatches, openBatch, REQUEUABLE, writeAtomic } from "./batch.mjs";

export const DEFAULT_HEALTH = Object.freeze({ rootFailed: true, terminalShare: 0.5, stalled: true, checksMin: Object.freeze([15, 60]), issue: null, notifyCommand: null });
/** #5469: a hold older than this many hours is flagged (`config.holdHours` overrides). */
export const DEFAULT_HOLD_HOURS = 4;
/** Outcomes that end a row well: never counted against the batch. */
export const GOOD_END = new Set(["merged", "invalid", "decomposed"]);
export const REFUSALS_FILE = "refusals.json";
export const REFUSAL_KEEP = 20;
export const REFUSAL_SHOW_MS = 24 * 3600 * 1000;
export const NOTIFY_TIMEOUT_MS = 30 * 1000;

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const list = (ns) => ns.map((n) => `#${n}`).join(", ");

/** forge.yaml (parsed) → health config. The parser flattens `orchestrate.health.*` to `orchestrate.*`. */
export function parseHealthConfig(yaml) {
  const o = yaml?.orchestrate && typeof yaml.orchestrate === "object" ? yaml.orchestrate : {};
  const bool = (v, d) => (v === undefined || String(v).trim() === "" ? d : String(v).trim().toLowerCase() !== "false");
  const share = Number(o.terminal_share);
  const issue = Number(String(o.issue ?? "").replace(/^#/, ""));
  const checks = String(o.checks_min ?? "").replace(/^\[|\]$/g, "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const cmd = String(yaml?.notify?.command ?? "").trim();
  return { rootFailed: bool(o.root_failed, DEFAULT_HEALTH.rootFailed), terminalShare: o.terminal_share !== undefined && Number.isFinite(share) && share >= 0 && share <= 1 ? share : DEFAULT_HEALTH.terminalShare,
    stalled: bool(o.stalled, DEFAULT_HEALTH.stalled), checksMin: checks.length ? checks : [...DEFAULT_HEALTH.checksMin], issue: Number.isSafeInteger(issue) && issue > 0 ? issue : null, notifyCommand: cmd || null };
}

/** Issues of the batch with no dependency edge to another issue of the batch. */
export function rootsOf(state) {
  const order = (state?.order ?? []).map(Number), inBatch = new Set(order);
  return order.filter((n) => !(state?.deps?.[n] ?? []).some((d) => inBatch.has(Number(d)) && Number(d) !== n));
}

/**
 * `{healthy, causes:[{code, issues, detail}], recovery:[cmd]}` for one batch state. `held`: operator-held issues (not a
 * stall); `refused`: a refusal record (the launch never started); `resolved` (#5243): issues already
 * resolved on GitHub (merged by hand), counted as good ends. Pure.
 */
export function evaluateHealth(state, { held = [], refused = null, config = DEFAULT_HEALTH, batchId = "<id>", repo = null, resolved = [], holdInfo = null, now = Date.now() } = {}) {
  const causes = [], recovery = [];
  if (refused) {
    causes.push({ code: "refused", issues: refused.issues ?? [], detail: refused.message ?? "launch refused" });
    const relaunch = `forgedock orchestrate ${(refused.issues ?? []).join(" ")}${repo ? ` --repo ${repo}` : ""}`;
    recovery.push(`merge the unmet dependencies, then: ${relaunch}`, `${relaunch} --force "<why the unmet dependencies are acceptable>"`);
    return { healthy: false, causes, recovery };
  }
  const order = (state?.order ?? []).map(Number);
  const running = new Set(Object.keys(state?.running ?? {}).map(Number));
  const pending = new Set((state?.pending ?? []).map(Number));
  const results = state?.results ?? {};
  const outcomeOf = (n) => results[n]?.outcome;
  // Terminal and not good: a final row not running and not waiting again (a held row stays pending but counts).
  const done = new Set([...resolved].map(Number));
  const bad = (n) => { const o = outcomeOf(n); return o !== undefined && !done.has(n) && !GOOD_END.has(o) && !running.has(n) && (!pending.has(n) || o === "held"); };
  const merged = order.filter((n) => outcomeOf(n) === "merged").length;
  const failedRoots = rootsOf(state).filter(bad);
  if (config.rootFailed && failedRoots.length) causes.push({ code: "root-failed", issues: failedRoots, detail: `root ${failedRoots.map((n) => `#${n} ${outcomeOf(n)}`).join(", ")}` });
  const badRows = order.filter(bad);
  if (order.length && merged === 0 && badRows.length && badRows.length / order.length >= config.terminalShare) {
    const by = {};
    for (const n of badRows) by[outcomeOf(n)] = (by[outcomeOf(n)] ?? 0) + 1;
    causes.push({ code: "terminal-share", issues: badRows, detail: `${badRows.length}/${order.length} rows ended non-merged (${Object.entries(by).map(([o, k]) => `${k} ${o}`).join(", ")}), 0 merged` });
  }
  const heldSet = new Set(held.map(Number));
  const waiting = [...pending].filter((n) => !heldSet.has(n));
  if (config.stalled && !running.size && waiting.length && state?.phase !== "setup" && !state?.cancelled) {
    causes.push({ code: "stalled", issues: waiting, detail: `0 lanes running while ${waiting.length} issue${waiting.length === 1 ? "" : "s"} pending${state?.breaker ? " (breaker tripped)" : ""}` });
  }
  // #5469: a hold older than `holdHours` is flagged (hold-info records its owner and since); the legacy plain hold has no age
  const holdHours = Number(config.holdHours) > 0 ? Number(config.holdHours) : DEFAULT_HOLD_HOURS, holdMs = holdHours * 3600000;
  const stale = Object.entries(holdInfo ?? {}).filter(([n, e]) => heldSet.has(Number(n)) && Date.parse(e?.since) <= now - holdMs);
  if (stale.length) causes.push({ code: "stale-hold", issues: stale.map(([n]) => Number(n)), detail: `held by operator for over ${holdHours}h: ${stale.slice(0, 6).map(([n, e]) => `#${n} (${e.owner}, since ${e.since})`).join(", ")}; forgedock orchestrate --release ${batchId} <issue...>` });
  if (!causes.length) return { healthy: true, causes, recovery };
  const failed = [...new Set(causes.filter((c) => c.code !== "stalled" && c.code !== "stale-hold").flatMap((c) => c.issues))];
  const requeue = failed.filter((n) => REQUEUABLE(outcomeOf(n))), relaunch = failed.filter((n) => !REQUEUABLE(outcomeOf(n)));
  if (requeue.length) recovery.push(`forgedock orchestrate --requeue ${batchId} ${requeue.join(" ")} --reason "batch unhealthy"`);
  if (relaunch.length) recovery.push(`forgedock orchestrate ${relaunch.join(" ")}${repo ? ` --repo ${repo}` : ""}   # after fixing the cause (see lanes/<n>.log)`);
  if (pending.size) recovery.push(`forgedock orchestrate --resume ${batchId}`);
  recovery.push(`forgedock status --batch ${batchId}`, `forgedock orchestrate --cancel ${batchId}`);
  return { healthy: false, causes, recovery };
}

/** The `BATCH UNHEALTHY` text: top causes, then the exact recovery commands. */
export function formatAlert({ batchId, checkpoint, health }) {
  return [`BATCH UNHEALTHY ${batchId} (${checkpoint})`, ...health.causes.slice(0, 5).map((c) => `  cause: ${c.code}: ${c.detail}${c.issues?.length && c.code !== "refused" ? ` [${list(c.issues.slice(0, 12))}${c.issues.length > 12 ? ", …" : ""}]` : ""}`),
    "  recovery:", ...health.recovery.map((r) => `    ${r}`)].join("\n");
}

export const healthPath = (dir) => join(dir, "health.json");
export const readHealth = (dir) => { const h = readJson(healthPath(dir)); return h && typeof h === "object" && !Array.isArray(h) ? h : null; };
export const writeHealth = (dir, h) => writeAtomic(healthPath(dir), JSON.stringify(h) + "\n", { private: true });

/** The checkpoints `[{label, at}]` (`T+<min>`) for a batch created at `created` (ms). */
export const checkpointsOf = (created, checksMin = DEFAULT_HEALTH.checksMin) => checksMin.map((m) => ({ label: `T+${m}`, at: created + m * 60000 }));

/** `health checks: T+15 14:05Z, T+60 14:50Z; forgedock status --batch <id>` */
export function scheduleLine(batchId, created, checksMin = DEFAULT_HEALTH.checksMin) {
  const hhmm = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;
  return `health checks: ${checkpointsOf(created, checksMin).map((c) => `${c.label} ${hhmm(c.at)}`).join(", ")}, and at batch end; forgedock status --batch ${batchId}`;
}

/**
 * One checkpoint: evaluate the batch, persist it, and call `alert(text, health)` on the first unhealthy result only.
 * @returns the evaluation, plus `alerted` when this call raised the alert
 */
export async function runCheck({ batch, checkpoint, config = DEFAULT_HEALTH, repo = null, now = () => Date.now(), alert = async () => {}, resolve = null }) {
  const state = batch.store.load() ?? {};
  let held = [];
  try { held = batch.readHeld?.() ?? []; } catch { held = []; }
  // #5243: the local rows are a cache; a failed row whose issue GitHub shows as merged by hand is resolved, not failed.
  let resolved = [];
  if (resolve) {
    const res = state.results ?? {}, run = new Set(Object.keys(state.running ?? {}).map(Number));
    const cand = (state.order ?? []).map(Number).filter((n) => res[n]?.outcome !== undefined && !GOOD_END.has(res[n].outcome) && !run.has(n)).map((n) => ({ issue: n, outcome: res[n].outcome }));
    try { if (cand.length) resolved = (await resolve(cand) ?? []).map(Number); } catch { resolved = []; }
  }
  let holdInfo = null;
  try { holdInfo = batch.readHoldInfo?.() ?? null; } catch { holdInfo = null; }
  const health = evaluateHealth(state, { held, config, batchId: batch.id, repo, resolved, holdInfo, now: now() });
  const prev = readHealth(batch.dir) ?? {};
  const at = new Date(now()).toISOString();
  const next = { ...prev, checks: { ...(prev.checks ?? {}), [checkpoint]: at }, last: { at, checkpoint, healthy: health.healthy, ...(resolved.length ? { resolved } : {}), causes: health.causes, recovery: health.recovery } };
  const fire = !health.healthy && !prev.alertedAt;
  if (fire) Object.assign(next, { alertedAt: at, alert: formatAlert({ batchId: batch.id, checkpoint, health }) });
  try { writeHealth(batch.dir, next); } catch { /* health is advisory */ }
  if (fire) { try { await alert(next.alert, health); } catch { /* every channel is best effort */ } }
  return { ...health, alerted: fire };
}

/**
 * Arm the timed checkpoints not yet done (per `health.json`); past-due ones run on the next tick. Timers are unref'd.
 * @returns `{cancel()}`
 */
export function scheduleChecks({ batch, created, config = DEFAULT_HEALTH, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, check }) {
  const done = readHealth(batch.dir)?.checks ?? {};
  const timers = checkpointsOf(created, config.checksMin).filter((c) => !done[c.label]).map((c) => {
    const t = setTimer(() => { Promise.resolve().then(() => check(c.label)).catch(() => {}); }, Math.max(0, c.at - now()));
    t?.unref?.();
    return t;
  });
  return { cancel: () => { for (const t of timers) clearTimer(t); } };
}

/** Run `notify.command` through the shell: alert JSON on stdin, FORGEDOCK_ALERT_* in env. Never throws. */
export function runNotify(command, payload, { spawn = spawnProc, timeoutMs = NOTIFY_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ["pipe", "ignore", "ignore"], env: { ...env, FORGEDOCK_ALERT: "BATCH_UNHEALTHY", FORGEDOCK_ALERT_BATCH: String(payload.batch ?? ""), FORGEDOCK_ALERT_TEXT: String(payload.text ?? "") } });
    } catch (e) { return resolve({ ok: false, error: String(e?.message ?? e) }); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
    timer.unref?.();
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message ?? e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}` }); });
    try { child.stdin?.on?.("error", () => {}); child.stdin?.end?.(JSON.stringify(payload) + "\n"); } catch { /* the command ignores stdin */ }
  });
}

/**
 * The alert channels: a runner line, a comment on the configured issue (else the batch's epics), and notify.command.
 * Each is best effort.
 */
export async function deliverAlert({ text, batchId, health, sink = { line: () => {} }, gh = null, repo = null, config = DEFAULT_HEALTH, epics = [], notify = runNotify }) {
  sink.line(text);
  const targets = config.issue ? [config.issue] : [...new Set(epics)];
  if (gh && repo) for (const n of targets) {
    try { await gh(["issue", "comment", String(n), "-R", repo, "--body", `<!-- FORGE:BATCH-HEALTH batch=${batchId} -->\n## BATCH UNHEALTHY\n\`\`\`text\n${text}\n\`\`\``]); } catch (e) { sink.line(`health: comment on #${n} failed (${String(e?.message ?? e).slice(0, 160)})`); }
  }
  if (config.notifyCommand) {
    const r = await notify(config.notifyCommand, { alert: "BATCH_UNHEALTHY", batch: batchId, repo, text, causes: health?.causes ?? [], recovery: health?.recovery ?? [] });
    if (!r?.ok) sink.line(`health: notify.command failed (${r?.error ?? "unknown"})`);
  }
}

/** Record a refused launch under the batch root (no batch dir exists); keeps the newest `REFUSAL_KEEP`. */
export function recordRefusal(root, rec) {
  const prev = readRefusals(root, { maxAgeMs: Infinity });
  writeAtomic(join(root, REFUSALS_FILE), JSON.stringify([...prev, rec].slice(-REFUSAL_KEEP)) + "\n", { private: true });
}

/** Refusals newer than `maxAgeMs`, oldest first. */
export function readRefusals(root, { now = Date.now(), maxAgeMs = REFUSAL_SHOW_MS } = {}) {
  const v = readJson(join(root, REFUSALS_FILE));
  return (Array.isArray(v) ? v : []).filter((r) => r && typeof r.at === "string" && now - Date.parse(r.at) <= maxAgeMs);
}

/** Health of one batch for `forgedock status --batch <id>`. */
export function batchStatusLines(root, id, { now = Date.now() } = {}) {
  const b = openBatch(root, id);
  if (!b.exists()) return [`batch ${id}: not found in ${root}`];
  const h = readHealth(b.dir), plan = b.readPlan() ?? {};
  const created = Date.parse(plan.created ?? "");
  const out = [];
  if (h?.alertedAt) out.push(`batch ${id}: UNHEALTHY since ${h.alertedAt}`, ...String(h.alert ?? "").split("\n").slice(1));
  else if (h?.last) out.push(`batch ${id}: healthy at ${h.last.checkpoint} (${h.last.at})`);
  else out.push(`batch ${id}: no health check yet`);
  if (h?.alertedAt && h.last && h.last.at !== h.alertedAt) out.push(`  last check ${h.last.checkpoint} (${h.last.at}): ${h.last.healthy ? "healthy" : h.last.causes.map((c) => c.code).join(", ")}`);
  if (Number.isFinite(created)) {
    const due = checkpointsOf(created, DEFAULT_HEALTH.checksMin).filter((c) => !h?.checks?.[c.label]);
    if (due.length && !b.readReport()) out.push(`  next checks: ${due.map((c) => `${c.label} ${new Date(c.at).toISOString().slice(11, 16)}Z${c.at < now ? " (due)" : ""}`).join(", ")}`);
  }
  return out;
}

/**
 * `forgedock status` lines: unhealthy batches still unresolved (no report, or alerted within a day) and recent refusals;
 * with `batch`, that one batch's health.
 */
export function statusLines(root, { now = Date.now(), batch = null } = {}) {
  if (batch) return batchStatusLines(root, batch, { now });
  const out = [];
  for (const id of listBatches(root)) {
    try {
      const b = openBatch(root, id), h = readHealth(b.dir);
      if (!h?.alertedAt || (b.readReport() && now - Date.parse(h.alertedAt) > REFUSAL_SHOW_MS)) continue;
      const causes = (h.last?.healthy === false ? h.last.causes : null) ?? [];
      out.push(`  BATCH UNHEALTHY ${id} (since ${h.alertedAt})${causes.length ? `: ${causes.map((c) => c.detail).join("; ")}` : ""} — forgedock status --batch ${id}`);
    } catch { /* an unreadable batch has no line */ }
  }
  for (const r of readRefusals(root, { now })) out.push(`  LAUNCH REFUSED ${r.at}: ${String(r.message ?? "").slice(0, 300)}`);
  return out;
}

/**
 * #5243: which `[{issue, outcome}]` rows GitHub shows as resolved: the issue is CLOSED with a MERGED closing PR, or a
 * `needs-human` row whose label was removed with a `FORGE:DECISION` comment. Any read failure leaves the row unresolved.
 * @returns issue numbers
 */
export async function resolvedOnGithub(cands, gh, repo) {
  const out = [];
  for (const { issue, outcome } of cands) {
    try {
      const v = JSON.parse(await gh(["issue", "view", String(issue), "-R", repo, "--json", "state,labels,comments,closedByPullRequestsReferences"]));
      let ok = false;
      if (String(v.state).toUpperCase() === "CLOSED") {
        for (const ref of v.closedByPullRequestsReferences ?? []) {
          const pr = JSON.parse(await gh(["pr", "view", String(ref.number), "-R", repo, "--json", "state"]));
          if (String(pr.state).toUpperCase() === "MERGED") { ok = true; break; }
        }
      } else if (outcome === "needs-human") {
        ok = !(v.labels ?? []).some((l) => l.name === "needs-human") && (v.comments ?? []).some((c) => /<!--\s*FORGE:DECISION/.test(c.body ?? ""));
      }
      if (ok) out.push(issue);
    } catch { /* unresolved */ }
  }
  return out;
}

export const DEFAULT_STALL_MIN = 10;
/**
 * #5314: dispatch stall. A batch with ready pending issues, free capacity and no progress for `windowMin` minutes. Ready: pending,
 * not held, no retry-at in the future, every in-batch dependency ended well. Independent of the runner (it may be dead), so the
 * schedd polls it. `hosted`: a runner is alive. @returns null (healthy) or `{code, ready, idleMin, hosted, detail}`. Pure.
 */
export function evaluateDispatchStall(state, { held = [], parallel = null, hosted = false, lastProgressMs = null, now = Date.now(), windowMin = DEFAULT_STALL_MIN, cancelled = false, reported = false } = {}) {
  if (!state || cancelled || reported || lastProgressMs === null) return null;
  if (state.breaker && !state.breaker.transport) return null; // an operator --resume clears it; a re-host would stop again at once
  const order = new Set((state.order ?? []).map(Number)), results = state.results ?? {}, heldSet = new Set(held.map(Number));
  const running = Object.keys(state.running ?? {}).length;
  const k = Number.isInteger(parallel) && parallel > 0 ? parallel : Number.isInteger(state.parallel) && state.parallel > 0 ? state.parallel : 1;
  const ready = (state.pending ?? []).map(Number).filter((n) => !heldSet.has(n) && results[n] === undefined && !(Number(state.notBefore?.[n]) > now)
    && (state.deps?.[n] ?? []).every((d) => !order.has(Number(d)) || Number(d) === n || GOOD_END.has(results[d]?.outcome)));
  const idleMin = Math.floor((now - lastProgressMs) / 60000);
  if (!ready.length || running >= k || idleMin < windowMin) return null;
  return { code: "dispatch-stalled", ready, idleMin, hosted, detail: `${ready.length} ready issue${ready.length === 1 ? "" : "s"} (${list(ready.slice(0, 8))}${ready.length > 8 ? ", …" : ""}) pending with ${k - running} free lane${k - running === 1 ? "" : "s"} and no dispatch for ${idleMin} min; ${hosted ? "the runner is alive but not dispatching" : "no runner hosts the batch"}` };
}

export const FIRST_HOUR_FILE = "first-hour.json";
export const BATCH_LOG_FILE = "batch.log";
export const FIRST_HOUR_MIN = 60;
export const readFirstHour = (dir) => readJson(join(dir, FIRST_HOUR_FILE));
/** Append one line to the batch's operator-readable log. Best effort. */
export const appendBatchLog = (dir, text) => { try { appendFileSync(join(dir, BATCH_LOG_FILE), `${text}\n`, { mode: 0o600 }); } catch { /* advisory */ } };

/** The first-hour report of one batch: dispatched / running / merged / stuck, and why. Pure. */
export function firstHourReport(state, { batchId, now = Date.now(), held = [], stall = null, holdInfo = null } = {}) {
  const order = (state?.order ?? []).map(Number), results = state?.results ?? {}, running = Object.keys(state?.running ?? {}).map(Number);
  const merged = order.filter((n) => GOOD_END.has(results[n]?.outcome)), heldSet = new Set(held.map(Number));
  const stuck = order.filter((n) => !running.includes(n) && !GOOD_END.has(results[n]?.outcome) && (results[n] !== undefined || (state?.pending ?? []).map(Number).includes(n)));
  const why = (n) => results[n]?.outcome ? `#${n} ${results[n].outcome}` : heldSet.has(n) ? `#${n} held${holdInfo?.[n] ? ` (${holdInfo[n].owner}, since ${holdInfo[n].since})` : ""}` : Number(state?.notBefore?.[n]) > now ? `#${n} waiting on a retry` : `#${n} pending`;
  const dispatched = order.filter((n) => results[n] !== undefined || running.includes(n)).length;
  const counts = { total: order.length, dispatched, running: running.length, merged: merged.length, stuck: stuck.length };
  const reasons = [...stuck.map(why), ...(stall ? [stall.detail] : [])];
  const summary = `first hour: ${dispatched}/${order.length} dispatched, ${running.length} running, ${merged.length} merged, ${stuck.length} stuck${reasons.length ? ` (${reasons.slice(0, 6).join("; ")})` : ""}`;
  return { batch: batchId, at: new Date(now).toISOString(), counts, summary, lines: [`batch ${batchId}: ${summary}`, ...reasons.slice(0, 12).map((r) => `  ${r}`)] };
}

/** Persist the first-hour report once (batch dir + `batch.log`); false when it already exists. */
export function writeFirstHour(batch, report) {
  if (existsSync(join(batch.dir, FIRST_HOUR_FILE))) return false;
  try { writeAtomic(join(batch.dir, FIRST_HOUR_FILE), JSON.stringify(report) + "\n", { private: true }); } catch { return false; }
  for (const l of report.lines) appendBatchLog(batch.dir, `${report.at} ${l}`);
  return true;
}

/** The one needs-you item of a stall: recorded in `health.json` (shown by status) per distinct ready set. @returns true when newly raised */
export function recordStallAlert(batch, stall, { now = Date.now() } = {}) {
  const sig = stall.ready.join(","), prev = readHealth(batch.dir) ?? {};
  if (prev.stall?.sig === sig) return false;
  const at = new Date(now).toISOString();
  const text = `BATCH UNHEALTHY ${batch.id} (dispatch-stalled)\n  cause: dispatch-stalled: ${stall.detail}\n  recovery:\n    forgedock orchestrate --resume ${batch.id}\n    forgedock orchestrate --cancel ${batch.id}`;
  try { writeHealth(batch.dir, { ...prev, stall: { at, sig, detail: stall.detail }, ...(prev.alertedAt ? {} : { alertedAt: at, alert: text }) }); } catch { return false; }
  appendBatchLog(batch.dir, `${at} ${text.split("\n").slice(0, 2).join(" | ")}`);
  return true;
}

/** `sched show` lines: per unfinished batch, its first-hour summary and any dispatch stall. */
export function summaryLines(root, { now = Date.now() } = {}) {
  const out = [];
  for (const id of listBatches(root)) {
    try {
      const b = openBatch(root, id);
      if (b.readReport() || b.readCancel()) continue;
      const fh = readFirstHour(b.dir), h = readHealth(b.dir);
      if (fh?.summary) out.push(`  batch ${id}: ${fh.summary}`);
      if (h?.stall && now - Date.parse(h.stall.at) < 24 * 3600 * 1000) out.push(`  batch ${id}: DISPATCH STALLED since ${h.stall.at}: ${h.stall.detail}`);
    } catch { /* an unreadable batch has no line */ }
  }
  return out;
}

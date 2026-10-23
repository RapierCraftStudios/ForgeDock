// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin orchestrate: run core work-on for several issues with bounded concurrency, honouring `Depends on` / `Blocked by`
 * among the given issues (wait for the dependency to merge; skip when it ends anywhere but merged/invalid).
 * A `dependency-open` run is requeued behind its dependencies, pulling an out-of-set one into the batch; a
 * `decomposed` run adds its sub-issues and its dependents wait on them instead (#4124). A dependency that is parked
 * (ended needs-human in this batch, or an out-of-set issue labelled needs-human per `issueLabels(n)`) is never pulled in:
 * the issue ends `skipped` (`dependency #N needs-human`) and its dependents with it (#4387).
 * No investigation, synthesis or agent spawning. `runOne(issue)` and `readBody(issue)` are injected.
 * Optional `prefilter(issue, lane)` (#4123) runs in the lane slot before `runOne`: when it closed the issue, no lane starts.
 * When it parked the issue (#4389, `parked: true`), no lane starts either and the row ends with the parked kind.
 * Optional `resolveLane(issue)` (#4125) works out each issue's own lane (milestone branch or staging): an issue whose
 * lane is refused ends `lane-refused` without a run, and a dependency edge between two lanes goes to `onCrossLane`.
 *
 * Durable batch runner (#4121): with a `store` every transition is persisted, so a restarted dispatcher continues the
 * batch; lanes it launched that are still alive are re-attached through `adopt(issue, rec)` instead of relaunched.
 * `deferred` is a scheduling fact, not an end: each typed code is requeued with its retry-at (`deferPolicy`), a usage
 * limit holds admissions for that account until its reset, and non-host deferrals stop after `maxDeferrals`.
 * Usage-limit holds (#4190) are keyed by backend identity in `limits` (the host store, shared by every batch on the
 * host; in memory when absent): admission checks the hold of `identity()`, the account the next lane would use. While held, the
 * batch re-reads the store every `pollMs` (#4446), so `forgedock limits clear` admits on the next poll, not at the reset. An `engine-error` is
 * relaunched once; `breaker` ({errors, window_min}) stops admissions after a burst and lets running lanes finish, the
 * rest stay pending (outcome `held`) for a resume. `getParallel()` is read on every pass, so K can change live.
 * `getAdded()` (#4408, `forgedock orchestrate --add`) is read on every pass too: issues it returns that are not in the batch
 * join it through `addIssues` (the still-pending issues' `Depends on` are re-read first, so edges hold both ways), with one
 * batch decision and one `added` row; while it is set, lanes running with an empty queue still wake every `pollMs`.
 *
 * Maintenance budget (#4197), off unless `maintenance: {share, whenIdle}` is passed: `classify(issue)` gives each issue
 * `{maintenance, priority}` (persisted as `classes`) and admission follows `pickNext`: P0/P1 features, then a maintenance
 * issue while maintenance starts stay within `share` of all lane starts (`dispatch: {started, maint}`, persisted), then
 * P2+ features, then (`whenIdle`) maintenance once no feature is pending. Maintenance the budget never admits ends `held`.
 *
 * Milestone drift (#4161), off unless `drift` is passed (`bin/lean/drift.mjs` makeDrift): a `merged` milestone-lane run
 * whose result carries `structure` awaits `drift.onMerged(issue, row, result)` before its slot frees. A drift error is
 * reported as a `drift` row and never changes the outcome. With `drift.holds(issue, {body, lane})` (block_dispatch), a
 * pending issue it returns a package for is not started; it ends `held` (`drift: <package> flagged`) if nothing else runs.
 *
 * Host lane registry (#4191), off unless `sched: {registry, batch, repo, cap}` is passed (`sched.mjs` `openSched`): a lane
 * starts only when the batch is under its K and the registry grants it a host slot; `priorityOf(issue)` (persisted as
 * `priorities`) ranks it host-wide, and the batch's ready issues are tried in priority order. Ready issues it cannot
 * start yet stay offered in the registry (polled every `pollMs`) and are withdrawn once no longer ready; a settled lane
 * releases its slot, an adopted one re-records it.
 * Per-issue lock (#4481), on with `sched.exclusive` (registry entries ask `exclusive: true`): when another batch holds a live slot for the same repo and issue (`tryAcquire` `conflict`, or
 * `registry.holder` for a lane placed remote), the issue is not started: it is retried after `pollMs` with one `deferred`
 * row naming that batch (no deferral count, no breaker), and admission goes on with the next ready issue.
 *
 * Dispatch check (#4481), off unless `dispatchCheck(issue)` is passed: it runs before EVERY lane start (first and
 * requeued, unlike the once-per-issue pre-filter) and returns null (run) or `{outcome: "merged", pr}` / `{outcome:
 * "invalid"}` for an issue already closed or whose PR merged; the row ends with that outcome and no lane starts. Fail-open.
 *
 * Remote lanes (#4253), off unless `remote: {max, isRemote(issue)}` is passed (execution.mjs): a lane `isRemote` places
 * in a sandbox takes no host registry slot; it starts only while fewer than `max` remote lanes of this batch run (the
 * batch K still applies). Its run record keeps `remote: true` and the provider handle, so a resume re-counts and adopts it.
 * `runOne` gets `ctx.remote` (true for a lane admitted remote).
 *
 * Execution budget (#4255): a lane result's `sandbox: {minutes, cost_usd}` is summed per issue (persisted as `sandbox`,
 * over attempts) onto the row and handed to `remote.onUsage(issue, sandbox, rec)`. Before a remote lane is admitted,
 * `remote.admit(usage)` gets the batch's settled usage plus the running remote lanes' elapsed minutes
 * (× `remote.costPerMinute`); when it refuses, running lanes finish and the queue either runs the rest locally
 * (`remote.onBudget: "local"`, host path) or stops: the rest end `held` ("execution budget: ...") for a resume.
 *
 * Hybrid placement (#4256): `remote.place(issue) -> {where, reason}` (execution.mjs `placeLane`) replaces `isRemote`.
 * With `remote.fallbackLocal`, a lane placed remote runs on the host path instead of waiting when `max` remote lanes run,
 * and instead of stopping when the budget refuses. The final `{where, reason}` is kept on the run record and the row as
 * `placement` and passed to `runOne` as `ctx.placement` (the lane records it in its FORGE:STATE).
 *
 * In-batch recovery (#4267), on by default: this module recovers only when `recovery: {maxAttempts}` is passed, and the
 * CLI always passes it (forge.yaml `orchestration.recovery.max_attempts`, default 1; 0 disables): a row `classifyNeedsHuman` calls
 * recoverable (needs-human `ci.red` / `base.conflict` / `builder.block_untyped`, `contract.invalid` after a mid-run issue
 * edit, `ci-pending` whose PR `conflicting(issue, pr)` says conflicts) is not final while its persisted `recoveries` stay
 * under `maxAttempts`: it is requeued as a recovery lane (`ctx.recover = {code, attempt, final}`, `final` when attempt ==
 * `maxAttempts`) under the same admission as any lane, so its dependents stay queued. Only a final lane relabels needs-human
 * itself; a non-final attempt that ends needs-human/ci-pending without a successor is relabelled here, once (#4302). A recovery
 * still queued when the batch exits (breaker, budget, hold, or a resume that does not relaunch it) is relabelled once with the
 * full persisted lane reason (#4315); also when the loop throws, and through `onExit(fn)` (the caller's signal handler
 * awaits `fn(cause)`), each once (#4318). `relabelNeedsHuman` may return `false`/"failed" (not recorded, a resume retries)
 * or "skipped" (closed or leased issue: recorded); any other result counts as relabelled.
 * A merged recovery row carries `recovered: <code>`; any other end is final with `recovery` evidence. Human codes (`builder.blocked`) are never recovered. Every operational decision the runner takes
 * (recovery, engine-error relaunch, dependency requeue, sub-issues added) goes to `decide({issue, what, why, alternative})`,
 * fire-and-forget: the runner never waits on it.
 * Daemon shutdown (#4454): an aborted `signal` stops the runner without ending the batch: nothing more is admitted, every wait
 * wakes, running lanes are neither awaited nor stopped (they are detached), nothing is relabelled and the state is saved once
 * with its `running` records, so a `--resume` re-adopts the lanes; then it throws `code: "batch.stopped"` (no rows, no report).
 *
 * Longest-first admission (#4409): `estimate(issue, {body})` (minutes; off when null, persisted as `estimates`) ranks the
 * ready issues inside a priority level. All admission paths order them by priority (unchanged), then the head band
 * (sub-issues of a decomposed lane, inserted at the front of the queue; with an estimate also issues queued longer than
 * `starveMs`, oldest first), then the estimate plus the estimates of their in-batch dependents (critical path), descending,
 * then queue order. A sub-issue's estimate is the parent's ÷ N, floored at the M default. Without `estimate` the order is
 * the queue order except that decomposed sub-issues go first. A settled row carries `est_minutes` (estimated vs. actual).
 */
import { parseDependsOn } from "../engine/phases.mjs";
import { classifyNeedsHuman, recoveryCodeOf } from "../engine/outcome-codes.mjs";
import { recoveryEvidence } from "./render.mjs";
import { renderAlerts } from "../stats/render.mjs";
import { formatParkedLine, postDeployOnly } from "./prefilter.mjs";
import { laneSize, SIZES } from "./budget.mjs";

// A dependency that finished like this no longer blocks its dependents.
const SATISFIED = new Set(["merged", "invalid"]);
// Times one issue may be requeued behind a dependency before its dependency-open row is final.
export const MAX_REQUEUES = 2;
// Non-host deferrals (anything but host.busy) one issue may take before its deferred row is final.
export const DEFAULT_MAX_DEFERRALS = 3;
// Relaunches of an issue whose lane ended engine-error.
export const ENGINE_ERROR_RELAUNCHES = 1;
export const HOST_BUSY_RETRY_S = 60;
export const RATE_LIMIT_FALLBACK_S = 15 * 60;
export const DEFER_BACKOFF_S = 120;
export const DEFER_BACKOFF_MAX_S = 30 * 60;
// A dependency-open whose dependencies already finished satisfied (GitHub not yet closed): wait before relaunching.
export const DEP_REQUEUE_DELAY_S = 60;

// #4409 lane duration estimates (minutes) without history; the ratio follows the S/M/L turn budgets.
export const EST_DEFAULT_MIN = Object.freeze({ S: 10, M: 25, L: 50 });
// A post-deploy-only follow-up starts no real lane (the pre-filter parks or closes it).
export const POST_DEPLOY_EST_MIN = 2;
// A ready issue queued longer than this joins the head band (starvation guard; only with an estimator).
export const DEFAULT_STARVE_MS = 30 * 60000;
// Merged runs of one repo and size needed before their median replaces the default.
export const HISTORY_MIN_SAMPLES = 3;

/** #4409: estimated lane minutes from facts: post-deploy-only body, else the `size:` label (unsized = M) -> history median or default. */
export function estimateLaneMinutes({ labels = [], body = "", history = null } = {}) {
  if (postDeployOnly(body)) return POST_DEPLOY_EST_MIN;
  const size = laneSize({ labels }) ?? "M";
  const h = Number(history?.[size]);
  return Number.isFinite(h) && h > 0 ? h : EST_DEFAULT_MIN[size];
}

/** #4409: {S?, M?, L?} median wall minutes of `repo`'s merged runs (summariseLog rows) per size, only sizes with enough samples. */
export function laneHistory(runs, repo) {
  const by = {};
  for (const r of runs ?? []) {
    if (r?.repo !== repo || r?.reason !== "merged" || !SIZES.includes(r?.size) || !Number.isFinite(r?.wallMs)) continue;
    (by[r.size] ??= []).push(r.wallMs / 60000);
  }
  const out = {};
  for (const [s, xs] of Object.entries(by)) {
    if (xs.length < HISTORY_MIN_SAMPLES) continue;
    xs.sort((a, b) => a - b);
    const m = xs.length >> 1;
    out[s] = Math.round((xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2) * 10) / 10;
  }
  return out;
}

/** Declared dependencies of an issue body; the same parser as the engine's admission (`openDependency`). */
export function parseDeps(body, issue) {
  return parseDependsOn(body, issue);
}

const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/**
 * When to run a `deferred` issue again. `deferrals` counts this issue's earlier non-host deferrals.
 * @returns {{delayMs:number, host?:true, hold?:true} | {capped:true}}
 */
export function deferPolicy(r, { now, deferrals = 0, maxDeferrals = DEFAULT_MAX_DEFERRALS }) {
  const code = r?.code ?? null;
  if (code === "host.busy") return { delayMs: (posNum(r?.retryInSeconds) ?? HOST_BUSY_RETRY_S) * 1000, host: true };
  const k = deferrals + 1;
  if (k > maxDeferrals) return { capped: true };
  if (code === "rate_limited") {
    const at = posNum(r?.resetAtEpochMs) && r.resetAtEpochMs > now ? r.resetAtEpochMs : now + (posNum(r?.retryInSeconds) ?? RATE_LIMIT_FALLBACK_S) * 1000;
    return { delayMs: at - now, hold: true };
  }
  if (posNum(r?.retryInSeconds)) return { delayMs: r.retryInSeconds * 1000 };
  // lease-held: "leased by X until <ISO>"
  const until = /\buntil (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(String(r?.detail ?? ""))?.[1];
  const at = until ? Date.parse(until) : NaN;
  if (Number.isFinite(at) && at > now) return { delayMs: Math.min(at - now + 5000, DEFER_BACKOFF_MAX_S * 1000) };
  return { delayMs: Math.min(DEFER_BACKOFF_S * 2 ** (k - 1), DEFER_BACKOFF_MAX_S) * 1000 };
}

const cancellableSleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

// In-memory hold store with the `openLimits` interface, for callers without the host store.
const memoryLimits = (now) => {
  const holds = new Map();
  return {
    holdUntil: (id) => { const u = holds.get(id)?.until; return u > now() ? u : null; },
    set: (id, untilMs, source = null) => {
      const prev = holds.get(id);
      if (!(prev?.until > untilMs)) holds.set(id, { until: untilMs, source, setAt: now() });
      return holds.get(id).until;
    },
    clear: (id) => { const live = !!(holds.get(id)?.until > now()); holds.delete(id); return live; },
    clearAll: () => { const n = [...holds.values()].filter((h) => h.until > now()).length; holds.clear(); return n; },
    list: () => [...holds].filter(([, h]) => h.until > now()).map(([id, h]) => ({ id, ...h })),
  };
};

const clsOf = (classes, n) => (classes instanceof Map ? classes.get(n) : classes?.[n]) ?? { maintenance: false, priority: 2 };

/**
 * The next issue to start from `ready` (pending order) under the maintenance budget, or null when none may start now.
 * Order: P0/P1 features; maintenance while `maint + 1 <= floor(share * (started + 1))`; P2+ features; maintenance
 * regardless of share when `whenIdle` and no feature is pending at all.
 */
export function pickNext(ready, { classes, share, whenIdle = false, started = 0, maint = 0, featuresPending = true }) {
  const isM = (n) => !!clsOf(classes, n).maintenance;
  const urgent = ready.find((n) => !isM(n) && Number(clsOf(classes, n).priority) <= 1);
  if (urgent !== undefined) return urgent;
  const m = ready.find(isM);
  if (m !== undefined && maint + 1 <= Math.floor(share * (started + 1) + 1e-9)) return m;
  const f = ready.find((n) => !isM(n));
  if (f !== undefined) return f;
  if (m !== undefined && whenIdle && !featuresPending) return m;
  return null;
}

const toObj = (m) => Object.fromEntries([...m].map(([k, v]) => [String(k), v]));
const toMap = (o) => new Map(Object.entries(o ?? {}).map(([k, v]) => [Number(k), v]));

/**
 * @returns {Promise<Array<{issue:number, outcome:string, pr:?number, cost_usd:number, minutes:number, detail?:string}>>}
 */
export async function orchestrate({ issues, parallel = 3, runOne, readBody, prefilter = null, resolveLane = null, now = () => Date.now(), onUpdate = () => {}, onCrossLane = () => {},
  store = null, adopt = null, getParallel = null, getAdded = null, breaker = null, maxDeferrals = DEFAULT_MAX_DEFERRALS, sleep = cancellableSleep, pollMs = 5000,
  classify = null, maintenance = null, limits = null, identity = () => "default", batchId = null, drift = null, sched = null, priorityOf = null, remote = null, beforeAdmit = null,
  recovery = null, decide = () => {}, conflicting = null, relabelNeedsHuman = null, onExit = null, issueLabels = null, getCancelled = null, stopLane = null,
  estimate = null, starveMs = DEFAULT_STARVE_MS, signal = null, dispatchCheck = null }) {
  const saved = store?.load?.() ?? null;
  const order = saved ? [...saved.order] : [];
  const set = new Set(order);
  const deps = toMap(saved?.deps); // issue -> declared dependencies (any issue); only those in `set` are edges
  const lanes = toMap(saved?.lanes); // issue -> resolveLane result
  const crossSeen = new Set(saved?.crossSeen ?? []);
  const results = toMap(saved?.results); // issue -> final row
  const running = new Map(); // issue -> promise
  const runRecs = toMap(saved?.running); // issue -> {startedAt, lane, pid?}: persisted so a restart can adopt the lane
  const pending = [...(saved?.pending ?? [])];
  const notBefore = toMap(saved?.notBefore);
  const requeues = toMap(saved?.requeues);
  const deferrals = toMap(saved?.deferrals);
  const engineErrors = toMap(saved?.engineErrors);
  const checked = toMap(saved?.prefilter); // issue -> pre-filter result
  const estimates = toMap(saved?.estimates); // #4409: issue -> estimated lane minutes; only with `estimate`
  const enqueued = toMap(saved?.enqueued); // #4409: issue -> when it last entered the queue (starvation guard)
  const heads = new Set(saved?.heads ?? []); // #4409: decomposed sub-issues not started yet: the head of their priority band
  let errorTimes = [...(saved?.errorTimes ?? [])];
  // A legacy batch-local `holdUntil` (pre-#4190) names no account and is ignored: a same-account lane re-sets the hold.
  const holds = limits ?? memoryLimits(now);
  const heldUntil = () => { try { const id = identity(); const u = holds.holdUntil(id); return Number.isFinite(u) && u > now() ? u : null; } catch { return null; } };
  let tripped = saved?.breaker ?? null;
  // #4376: operator cancel (the batch `cancel` file through `getCancelled`); persisted, but the file stays the authority.
  let cancelled = getCancelled ? (saved?.cancelled ?? null) : null;
  const budget = maintenance && Number(maintenance.share) > 0 ? { share: Number(maintenance.share), whenIdle: !!maintenance.whenIdle } : null;
  const classes = toMap(saved?.classes); // issue -> {maintenance, priority}; only with a maintenance budget
  const dispatch = { started: saved?.dispatch?.started ?? 0, maint: saved?.dispatch?.maint ?? 0 };
  let budgetHeld = false;
  const bodies = new Map(); // issue -> body, kept in memory for drift.holds only
  const driftHeld = new Map(); // issue -> flagged package dir holding it this pass
  const reg = sched?.registry ?? null;
  const priorities = toMap(saved?.priorities); // issue -> priority number; only with the registry
  const remoteMax = remote && Number.isInteger(remote.max) && remote.max >= 0 ? remote.max : 0;
  const remoteRun = new Set(); // remote lanes running now (#4253): admitted against remoteMax, never the host cap
  let budgetLocal = false; // the execution budget refused a remote lane under on_budget local: the rest run on the host
  // #4256: where a lane goes before capacity: `remote.place` (hybrid) or `remote.isRemote` (remote mode).
  const placeOf = (n) => {
    if (!remote) return null;
    if (budgetLocal) return { where: "local", reason: `fallback to local: execution budget: ${budgetHit ?? "cap reached"}` };
    try {
      if (typeof remote.place === "function") {
        const p = remote.place(n);
        return { where: p?.where === "remote" ? "remote" : "local", reason: String(p?.reason ?? "") };
      }
      return remote.isRemote?.(n) ? { where: "remote", reason: "mode remote" } : { where: "local", reason: "local" };
    } catch { return { where: "local", reason: "placement failed" }; }
  };
  const isRemote = (n) => placeOf(n)?.where === "remote";
  const placed = new Map(); // issue -> {where, reason} granted this pass, picked up by start()
  const sandboxUse = toMap(saved?.sandbox); // issue -> {minutes, cost_usd, attempts} (#4255)
  const remoteCpm = Number(remote?.costPerMinute) > 0 ? Number(remote.costPerMinute) : 0;
  let budgetStop = null, budgetHit = null; // this pass's refusal under on_budget stop; the last refusal reason
  const recoveryMax = Number.isInteger(recovery?.maxAttempts) && recovery.maxAttempts > 0 ? recovery.maxAttempts : 0;
  const recoveries = toMap(saved?.recoveries); // issue -> recovery lanes launched (#4267)
  const recovering = toMap(saved?.recovering); // issue -> {code, attempt, detail, outcome, ...} of the recovery lane queued or running
  const relabelled = new Set(saved?.relabelled ?? []); // #4315: queued recoveries relabelled needs-human when a batch stopped
  // #4267: decisions are recorded, never awaited: a failing or slow recorder cannot block the batch.
  const decided = (d) => { try { Promise.resolve(decide?.(d)).catch(() => {}); } catch { /* best effort */ } };
  const firstLine = (x) => String(x ?? "").split("\n")[0].slice(0, 300);

  let halted = false; // #4454: stopped by `signal`; the batch's state is no longer this process's to write
  const save = () => {
    if (!store || halted) return;
    store.save({ v: 1, order, deps: toObj(deps), lanes: toObj(lanes), crossSeen: [...crossSeen], results: toObj(results), running: toObj(runRecs),
      pending, notBefore: toObj(notBefore), requeues: toObj(requeues), deferrals: toObj(deferrals), engineErrors: toObj(engineErrors),
      prefilter: toObj(checked), errorTimes, breaker: tripped, ...(budget ? { classes: toObj(classes), dispatch: { ...dispatch } } : {}),
      ...(reg ? { priorities: toObj(priorities) } : {}), ...(sandboxUse.size ? { sandbox: toObj(sandboxUse) } : {}),
      ...(recoveries.size || recovering.size ? { recoveries: toObj(recoveries), recovering: toObj(recovering) } : {}),
      ...(relabelled.size ? { relabelled: [...relabelled] } : {}), ...(cancelled ? { cancelled } : {}),
      ...(estimate ? { estimates: toObj(estimates), enqueued: toObj(enqueued) } : {}), ...(heads.size ? { heads: [...heads] } : {}) });
  };
  const update = (row) => { store?.log?.(row); onUpdate(row); };
  const classifyOne = async (n) => {
    if (!budget) return;
    let c = null;
    try { c = classify ? await classify(n) : null; } catch { c = null; } // unclassifiable: an ordinary P2 feature
    classes.set(n, { maintenance: !!c?.maintenance, priority: Number.isFinite(Number(c?.priority)) ? Number(c.priority) : 2 });
  };
  const readPriority = async (n) => {
    if (!reg) return;
    let p = null;
    try { p = priorityOf ? await priorityOf(n) : null; } catch { p = null; }
    priorities.set(n, p !== null && p !== "" && Number.isFinite(Number(p)) ? Number(p) : 2);
  };
  // #4409: fail-open: a thrown or junk estimate is the M default.
  const readEstimate = async (n, body) => {
    if (!estimate || estimates.has(n)) return;
    let v = null;
    try { v = Number(await estimate(n, { body })); } catch { v = null; }
    estimates.set(n, Number.isFinite(v) && v > 0 ? v : EST_DEFAULT_MIN.M);
  };
  const readDeps = async (n) => {
    let body = "";
    try { body = await readBody(n); } catch { /* unreadable: no ordering info, work-on's own check still applies */ }
    if (drift?.holds) bodies.set(n, body);
    deps.set(n, parseDeps(body, n));
    await readEstimate(n, body);
    await classifyOne(n);
    await readPriority(n);
    if (resolveLane) { let l; try { l = await resolveLane(n); } catch (e) { l = { ok: false, code: "lane.unresolved", detail: e?.message ?? String(e) }; } lanes.set(n, l); }
  };
  const edges = (n) => (deps.get(n) ?? []).filter((d) => set.has(d));
  // A milestone issue waiting on a staging fix (or the reverse) never sees that fix on its own base: surface the edge.
  const noteCrossLane = () => {
    for (const n of order) for (const d of edges(n)) {
      const a = lanes.get(n), b = lanes.get(d), key = `${n}<${d}`;
      if (!a?.ok || !b?.ok || a.lane === b.lane || crossSeen.has(key)) continue;
      crossSeen.add(key);
      onCrossLane({ issue: n, lane: a.lane, dependency: d, dependencyLane: b.lane });
    }
  };
  // #4409: `head` (decomposed sub-issues) puts them at the front of the queue in their given order; a sub-issue's
  // estimate is the parent's ÷ N, floored at the M default.
  const addIssues = async (ns, { head = false, parent = null } = {}) => {
    const fresh = ns.filter((d) => !set.has(d));
    for (const d of fresh) {
      set.add(d); order.push(d);
      if (estimate && parent !== null && estimates.has(parent)) estimates.set(d, Math.max(EST_DEFAULT_MIN.M, estimates.get(parent) / ns.length));
    }
    let at = 0;
    for (const d of fresh) {
      await readDeps(d);
      if (head) { pending.splice(at++, 0, d); heads.add(d); } else pending.push(d);
      enqueued.set(d, now());
    }
    noteCrossLane();
  };
  // New issues (a fresh batch, or extra issues passed to a resume) join the queue.
  for (const n of issues) if (!set.has(n)) { set.add(n); order.push(n); pending.push(n); }
  for (const n of pending) if (!enqueued.has(n)) enqueued.set(n, now());
  for (const n of order) if (!deps.has(n)) await readDeps(n);
  if (estimate) for (const n of order) { // a resume that enabled the estimator
    if (estimates.has(n) || results.has(n)) continue;
    let b = ""; try { b = await readBody(n); } catch { b = ""; }
    await readEstimate(n, b);
  }
  if (budget) for (const n of order) if (!classes.has(n)) await classifyOne(n); // a resume that enabled the budget
  if (drift?.holds) for (const n of pending) if (!bodies.has(n)) { try { bodies.set(n, await readBody(n)); } catch { bodies.set(n, ""); } } // a resume
  if (reg) for (const n of order) if (!priorities.has(n)) await readPriority(n); // a resume of a pre-#4191 batch
  noteCrossLane();
  save();

  // Host registry seams (#4191): `offered` issues are queued for a slot, `slotted` ones hold one.
  const offered = new Set(), slotted = new Set();
  let fellBack = false;
  const keyOf = (n) => `${sched?.batch ?? batchId ?? "?"}#${n}`;
  const prioOf = (n) => priorities.get(n) ?? 2;
  // #4409: priority, then the head band (decomposed sub-issues; with an estimator also starved issues, oldest first), then
  // the estimate plus in-batch dependents' estimates descending, then queue order. Without an estimator: queue order.
  const rank = (ready) => {
    const t = now(), idx = new Map(pending.map((n, i) => [n, i]));
    const starved = (n) => !!estimate && !heads.has(n) && t - (enqueued.get(n) ?? t) > starveMs;
    const weight = (n) => {
      if (!estimate) return 0;
      let w = estimates.get(n) ?? 0;
      for (const m of order) if (m !== n && !results.has(m) && edges(m).includes(n)) w += estimates.get(m) ?? 0;
      return w;
    };
    return ready.map((n) => ({ n, p: prioOf(n), b: heads.has(n) || starved(n) ? 0 : 1, s: starved(n) ? enqueued.get(n) : 0, w: weight(n), i: idx.get(n) ?? 0 }))
      .sort((a, b) => a.p - b.p || a.b - b.b || a.s - b.s || b.w - a.w || a.i - b.i).map((x) => x.n);
  };
  const entryOf = (n) => ({ key: keyOf(n), batch: sched?.batch ?? batchId ?? null, repo: sched?.repo ?? null, issue: n, priority: prioOf(n), ...(sched?.exclusive ? { exclusive: true } : {}) });
  const releaseSlot = (n) => { if (reg && slotted.delete(n)) reg.release(keyOf(n)); };
  const offerFresh = (ns) => { const fresh = ns.filter((n) => !offered.has(n)); if (!fresh.length) return; reg.offer(fresh.map(entryOf)); for (const n of fresh) offered.add(n); };
  const withdrawExcept = (keep) => {
    const gone = [...offered].filter((n) => !keep.has(n));
    if (!gone.length) return;
    reg.withdraw(gone.map(keyOf));
    for (const n of gone) offered.delete(n);
  };
  // The batch's sandbox usage: settled (persisted) plus the running remote lanes' elapsed minutes so far.
  const remoteUsage = () => {
    let minutes = 0, cost_usd = 0, rm = 0;
    for (const u of sandboxUse.values()) { minutes += Number(u?.minutes) || 0; cost_usd += Number(u?.cost_usd) || 0; }
    const t = now();
    for (const n of remoteRun) { const st = runRecs.get(n)?.startedAt; if (Number.isFinite(st)) rm += Math.max(0, t - st) / 60000; }
    return { minutes: minutes + rm, cost_usd: cost_usd + rm * remoteCpm, running: { minutes: rm, cost_usd: rm * remoteCpm } };
  };
  // A thrown budget check refuses: the cap is hard.
  const admitRemote = () => {
    if (typeof remote?.admit !== "function") return { ok: true };
    try { const a = remote.admit(remoteUsage()); return a?.ok === false ? { ok: false, reason: a.reason ?? "cap reached" } : { ok: true }; }
    catch (e) { return { ok: false, reason: `budget check failed: ${e?.message ?? e}` }; }
  };
  const noteBudget = (reason) => {
    if (budgetHit === null) update({ issue: null, outcome: "budget", detail: `execution budget reached: ${reason}; ${remote?.onBudget === "local" || remote?.fallbackLocal ? "remaining lanes run locally" : "no further remote lanes admitted"}` });
    budgetHit = reason;
  };
  // #4481: another batch runs a lane for `n` now: retry after a poll, one row (and decision) per other batch.
  const busyNoted = new Map(); // issue -> the other batch last reported
  const busy = (n, other, wanted) => {
    const delayMs = Math.max(pollMs, 1);
    notBefore.set(n, now() + delayMs); offered.delete(n); wanted.delete(n);
    if (busyNoted.get(n) !== other) {
      busyNoted.set(n, other); save();
      decided({ issue: n, what: `deferred: batch ${other} runs a lane for #${n}`, why: "one lane per issue on the host (two batches include it)", alternative: "run a second lane on the same branch" });
      update({ issue: n, outcome: "deferred", pr: null, cost_usd: 0, minutes: 0, detail: `#${n} has a live lane in batch ${other}; retried in ${Math.round(delayMs / 1000)}s` });
    }
    return "busy";
  };
  // A host slot for `n` (a lane-refused issue runs nothing and needs none); refused: `n` stays queued in the registry.
  // true: start it; false: no capacity now; "busy" (#4481): another batch runs `n`, try the next issue.
  const grant = (n, wanted) => {
    if (lanes.get(n)?.ok === false) return true;
    let p = placeOf(n);
    if (p?.where === "remote" && reg?.holder) {
      let other = null;
      try { other = reg.holder(entryOf(n)) ?? null; } catch { other = null; }
      if (other !== null) return busy(n, other, wanted);
    }
    if (p?.where === "remote") {
      const adm = admitRemote();
      if (adm.ok) {
        if (remoteRun.size < remoteMax) { remoteRun.add(n); placed.set(n, p); return true; }
        if (!remote.fallbackLocal) return false;
        p = { where: "local", reason: `fallback to local: max_remote ${remoteMax} reached (${p.reason})` }; // #4256: hybrid runs it on the host
      } else {
        noteBudget(adm.reason);
        if (remote.onBudget !== "local" && !remote.fallbackLocal) { budgetStop = adm.reason; return false; }
        budgetLocal = true; // falls through to the host path
        p = { where: "local", reason: `fallback to local: execution budget: ${adm.reason}` };
      }
    }
    if (!reg) { if (p) placed.set(n, p); return true; }
    const r = reg.tryAcquire(keyOf(n), entryOf(n), sched.cap);
    if (!r?.ok && r?.conflict != null) return busy(n, r.conflict, wanted);
    if (!r?.ok) { offered.add(n); wanted.add(n); return false; }
    offered.delete(n); slotted.add(n);
    if (p) placed.set(n, p);
    if (r.fallback && !fellBack) { fellBack = true; update({ issue: null, outcome: "sched", detail: `host lane registry unavailable, admitting without the global cap: ${r.reason}` }); }
    return true;
  };

  const skip = (n, detail) => { results.set(n, { issue: n, outcome: "skipped", pr: null, cost_usd: 0, minutes: 0, detail }); update(results.get(n)); };
  const requeue = (n, delayMs) => { pending.push(n); enqueued.set(n, now()); if (delayMs > 0) notBefore.set(n, now() + delayMs); else notBefore.delete(n); };
  const noteEngineError = () => {
    if (!breaker) return;
    const t = now(), windowMs = breaker.window_min * 60000;
    errorTimes = [...errorTimes.filter((x) => t - x < windowMs), t];
    if (!tripped && errorTimes.length >= breaker.errors) {
      tripped = { at: t, detail: `circuit breaker: ${errorTimes.length} engine-errors within ${breaker.window_min} min; admissions stopped` };
      update({ issue: null, outcome: "breaker", detail: tripped.detail });
    }
  };

  // Apply one lane's result: requeue it (deferred, dependency-open, engine-error) or record its final row.
  const settle = async (n, r, rec, pf) => {
    if (halted) return; // #4454: a resume adopts the lane and settles it
    // #4304: the pre-filter runs once per issue; a recovery pass's row adds the earlier attempt's cost, which already holds it.
    const pfCost = recovering.has(n) ? 0 : (pf?.cost_usd ?? 0);
    const row = { issue: n, outcome: r?.terminalReason ?? "engine-error", pr: r?.pr ?? null, cost_usd: (r?.cost_usd ?? 0) + pfCost, minutes: Math.round((now() - rec.startedAt) / 6000) / 10, detail: r?.detail, ...(r?.code ? { code: r.code } : {}), ...(pf ? { prefilter: pf } : {}),
      ...(r?.waits && typeof r.waits === "object" ? { waits: r.waits } : {}), ...(Number.isInteger(r?.heavyQueueMax) ? { heavyQueueMax: r.heavyQueueMax } : {}),
      ...(Number.isFinite(r?.wall_ms) ? { wall_ms: r.wall_ms } : {}), ...(Number.isFinite(r?.model_ms) ? { model_ms: r.model_ms } : {}), // #4451
      ...(Number.isFinite(r?.precheckMs) ? { precheck_ms: r.precheckMs } : {}), ...(Number.isInteger(r?.precheckDeferred) && r.precheckDeferred > 0 ? { precheck_deferred: r.precheckDeferred } : {}), // #4331
      ...(typeof r?.firstPass === "boolean" ? { first_pass: r.firstPass } : {}), // #4362
      ...(r?.turns && typeof r.turns === "object" ? { turns: r.turns } : {}), // #4392
      ...(r?.conformance && typeof r.conformance === "object" ? { conformance: r.conformance } : {}), // #4398
      ...(rec?.placement ? { placement: rec.placement } : {}), ...(estimates.has(n) ? { est_minutes: Math.round(estimates.get(n) * 10) / 10 } : {}) }; // #4409
    const depList = (Array.isArray(r?.dependencies) ? r.dependencies : []).filter((d) => Number.isSafeInteger(d) && d > 0 && d !== n);
    const subs = (Array.isArray(r?.subissues) ? r.subissues : []).filter((d) => Number.isSafeInteger(d) && d > 0 && d !== n);
    if (subs.length) row.subissues = subs; // #4396: links a decomposed parent to its sub-lanes in the report
    if (r?.decomposition && typeof r.decomposition === "object") row.decomposition = r.decomposition;
    if (r?.sandbox && typeof r.sandbox === "object") {
      const prev = sandboxUse.get(n) ?? { minutes: 0, cost_usd: 0, attempts: 0 };
      const m = Number(r.sandbox.minutes) >= 0 ? Number(r.sandbox.minutes) : 0, c = Number(r.sandbox.cost_usd) >= 0 ? Number(r.sandbox.cost_usd) : 0;
      sandboxUse.set(n, { minutes: Math.round((prev.minutes + m) * 10) / 10, cost_usd: Math.round((prev.cost_usd + c) * 1e6) / 1e6, attempts: prev.attempts + 1 });
      try { remote?.onUsage?.(n, r.sandbox, rec); } catch { /* the batch total still counts it */ }
    }
    if (sandboxUse.has(n)) row.sandbox = { ...sandboxUse.get(n) };
    const done = () => { running.delete(n); runRecs.delete(n); releaseSlot(n); remoteRun.delete(n); };
    if (row.outcome === "dependency-open" && depList.length) {
      // #4387: a parked dependency is not pulled in again (fail-open on an unreadable label).
      let parked;
      for (const d of depList) {
        if (results.get(d)?.outcome === "needs-human") { parked = d; break; }
        if (set.has(d) || typeof issueLabels !== "function") continue;
        let names = [];
        try { names = (await issueLabels(d)) ?? []; } catch { names = []; }
        if (Array.isArray(names) && names.includes("needs-human")) { parked = d; break; }
      }
      if (parked !== undefined) {
        done();
        const final = { ...row, outcome: "skipped", detail: `dependency #${parked} needs-human` };
        results.set(n, final); save();
        decided({ issue: n, what: `skipped: dependency #${parked} needs-human (not pulled into the batch)`, why: firstLine(row.detail) || "the lane reported an open dependency",
          alternative: `pull #${parked} in and run it again` });
        update(final);
        return;
      }
    }
    if (row.outcome === "dependency-open" && depList.length && (requeues.get(n) ?? 0) < MAX_REQUEUES) {
      // A scheduling fact, not a failure: add the edge, pull the dependency in, and run this issue again after it.
      requeues.set(n, (requeues.get(n) ?? 0) + 1);
      deps.set(n, [...new Set([...(deps.get(n) ?? []), ...depList])]);
      await addIssues(depList);
      // Dependencies already done but still open on GitHub: a delay instead of a hot relaunch loop.
      const allDone = depList.every((d) => results.has(d) && SATISFIED.has(results.get(d).outcome));
      requeue(n, allDone ? DEP_REQUEUE_DELAY_S * 1000 : 0); done(); save();
      decided({ issue: n, what: `requeued behind ${depList.map((d) => `#${d}`).join(", ")} (Depends on edge added)`, why: firstLine(row.detail) || "the lane reported an open dependency",
        alternative: "skip the issue and its dependents" });
      update({ ...row, detail: `requeued behind ${depList.map((d) => `#${d}`).join(", ")}` });
      return;
    }
    // #4376: a lane stopped by a cancel is not a scheduling failure: requeued (held at the end), no deferral, no hold.
    if (cancelled && (row.outcome === "deferred" || row.outcome === "engine-error")) {
      requeue(n, 0); done(); save();
      update({ ...row, detail: `stopped by cancel: ${r?.code ?? row.outcome}${r?.detail ? ` ${r.detail}` : ""}` });
      return;
    }
    if (row.outcome === "deferred") {
      const pol = deferPolicy(r, { now: now(), deferrals: deferrals.get(n) ?? 0, maxDeferrals });
      if (!pol.capped) {
        if (!pol.host) deferrals.set(n, (deferrals.get(n) ?? 0) + 1);
        // A usage limit is held per account; the hold, not a per-issue delay, gates the retry, so a lane on another
        // account runs it at once. If the hold cannot be recorded, the reset delay applies to this issue instead.
        let delayMs = pol.delayMs;
        if (pol.hold) {
          try { holds.set(r?.backendId ?? identity(), now() + pol.delayMs, `batch ${batchId ?? "?"} #${n}`); delayMs = 0; } catch { /* fail-open */ }
        }
        requeue(n, delayMs); done(); save();
        update({ ...row, detail: `requeued in ${Math.round(pol.delayMs / 1000)}s${pol.hold ? " (admissions held)" : ""}: ${r?.code ?? "deferred"}${r?.detail ? ` ${r.detail}` : ""}` });
        return;
      }
      row.detail = `gave up after ${deferrals.get(n) ?? 0} deferrals: ${r?.detail ?? r?.code ?? ""}`;
    }
    if (row.outcome === "engine-error") {
      noteEngineError();
      if ((engineErrors.get(n) ?? 0) < ENGINE_ERROR_RELAUNCHES) {
        engineErrors.set(n, (engineErrors.get(n) ?? 0) + 1);
        requeue(n, 0); done(); save();
        decided({ issue: n, what: "relaunch once after engine-error", why: firstLine(row.detail) || "engine-error", alternative: "end the issue engine-error and skip its dependents" });
        update({ ...row, detail: `relaunching once: ${row.detail ?? ""}` });
        return;
      }
    }
    if (row.outcome === "decomposed" && subs.length) {
      await addIssues(subs, { head: true, parent: n }); // #4409: on the batch's critical path by construction
      decided({ issue: n, what: `added sub-issues ${subs.map((d) => `#${d}`).join(", ")} to the batch; dependents wait on them`, why: "the builder decomposed the issue",
        alternative: "end the batch row decomposed and let dependents wait for a later batch" });
      for (const [m, ds] of deps) if (ds.includes(n)) deps.set(m, [...new Set(ds.flatMap((d) => (d === n ? subs : [d])))]);
      noteCrossLane();
    }
    // #4267: a recovery pass ends here; a recoverable row under the attempt cap is requeued as a recovery lane.
    const prior = recovering.get(n) ?? null;
    // #4318: the full persisted lane reason (capped by the comment writer), not its first 300 chars
    const evidence = () => recoveryEvidence({ code: prior.code, attempt: prior.attempt, outcome: row.outcome, resultCode: row.code, detail: row.detail, full: true });
    if (prior) {
      recovering.delete(n);
      // #4298: the row reports the whole issue: earlier attempts' cost and minutes are summed into the recovery's.
      row.cost_usd = Math.round(((Number(row.cost_usd) || 0) + (Number(prior.cost_usd) || 0)) * 1e6) / 1e6;
      row.minutes = Math.round(((Number(row.minutes) || 0) + (Number(prior.minutes) || 0)) * 10) / 10;
      if (row.outcome === "merged") row.recovered = prior.code;
      else row.recovery = { code: prior.code, attempts: recoveries.get(n) ?? prior.attempt, outcome: row.outcome, ...(row.code ? { result_code: row.code } : {}), detail: firstLine(row.detail) };
      // A recovery that failed for good keeps needs-human. The lane relabels needs-human/ci-pending itself; engine-error (after its
      // relaunch) and deferred (no longer requeued) end here, so the runner does it, once. invalid/decomposed/dependency-*/merged never.
      if (["engine-error", "deferred"].includes(row.outcome) && typeof relabelNeedsHuman === "function") {
        try { await relabelNeedsHuman({ issue: n, evidence: evidence() }); } catch { /* best effort */ }
      }
    }
    if (recoveryMax && (row.outcome === "needs-human" || row.outcome === "ci-pending")) {
      let isConflicting = false;
      if (row.outcome === "ci-pending" && typeof conflicting === "function" && Number.isInteger(row.pr)) {
        try { isConflicting = (await conflicting(n, row.pr)) === true; } catch { isConflicting = false; }
      }
      const facts = { ...row, issueEdited: r?.issueEdited === true, conflicting: isConflicting };
      const used = recoveries.get(n) ?? 0;
      if (classifyNeedsHuman(facts) === "recoverable" && used < recoveryMax) {
        const code = recoveryCodeOf(facts), attempt = used + 1;
        // #4315: the full lane detail is kept (never firstLine) for the relabel when the batch stops before this attempt
        recoveries.set(n, attempt); recovering.set(n, { code, attempt, cost_usd: Number(row.cost_usd) || 0, minutes: Number(row.minutes) || 0,
          detail: String(row.detail ?? ""), outcome: row.outcome, ...(row.code ? { result_code: row.code } : {}), prev_attempt: prior?.attempt ?? 0 });
        requeue(n, 0); done(); save();
        decided({ issue: n, what: `recovery lane for ${code} (attempt ${attempt}/${recoveryMax}); dependents stay queued`, why: firstLine(row.detail) || code,
          alternative: "leave needs-human for the operator and skip the dependents" });
        update({ ...row, outcome: "recovering", detail: `recovering (${code}), attempt ${attempt}/${recoveryMax}: ${firstLine(row.detail)}` });
        return;
      }
    }
    // #4302: a non-final recovery attempt left needs-human/ci-pending unlabelled for its successor; none is launched, so relabel once.
    if (prior && prior.attempt < recoveryMax && ["needs-human", "ci-pending"].includes(row.outcome) && typeof relabelNeedsHuman === "function") {
      try { await relabelNeedsHuman({ issue: n, evidence: evidence() }); } catch { /* best effort */ }
    }
    results.set(n, row);
    if (row.outcome === "merged" && drift?.onMerged && r?.structure && String(rec?.lane ?? r?.lane ?? "").startsWith("milestone/")) {
      save(); update(row);
      // Before the slot frees: the batch never ends with a fold pending, and block_dispatch sees the new flags.
      try { await drift.onMerged(n, { ...row, lane: rec?.lane ?? r?.lane }, r); } catch (e) { update({ issue: n, outcome: "drift", detail: `drift check failed: ${String(e?.message ?? e).slice(0, 300)}` }); }
      done(); save();
      return;
    }
    done(); save(); update(row);
  };

  const track = (n, p) => { running.set(n, p.catch((e) => settle(n, { terminalReason: "engine-error", detail: e?.message ?? String(e) }, runRecs.get(n), null))); };
  const start = (n) => {
    const ln = lanes.get(n);
    if (ln && !ln.ok) { // settled synchronously: nothing runs, no lease, no comment
      const row = { issue: n, outcome: "lane-refused", pr: null, cost_usd: 0, minutes: 0, detail: `${ln.code}: ${ln.detail}`, code: ln.code };
      results.set(n, row); save(); update(row);
      return;
    }
    const lane = ln?.lane;
    if (relabelled.delete(n)) save(); // #4315: the recovery lane launches after all; it removes needs-human itself
    const pl = placed.get(n);
    placed.delete(n);
    heads.delete(n); enqueued.delete(n); busyNoted.delete(n);
    const rec = { startedAt: now(), ...(lane ? { lane } : {}), ...(remoteRun.has(n) ? { remote: true } : {}), ...(pl ? { placement: pl } : {}) };
    runRecs.set(n, rec); notBefore.delete(n); save();
    track(n, (async () => {
      // Pre-filter once per issue (a requeued issue is not re-checked); fail-open: an error means a normal lane.
      if (prefilter && !checked.has(n)) { let pf = null; try { pf = await prefilter(n, lane); } catch { pf = null; } checked.set(n, pf); save(); }
      const pf = checked.get(n) ?? null;
      // #4481: every start re-checks GitHub: a closed issue or a merged PR ends the row without a lane (fail-open).
      let gone = null;
      if (dispatchCheck && !cancelled && !pf?.closed && !pf?.parked) {
        try { gone = (await dispatchCheck(n)) ?? null; } catch { gone = null; }
        if (!["merged", "invalid"].includes(gone?.outcome)) gone = null;
      }
      if (halted) return; // #4454: stopped before launch; no pid, so a resume queues it again
      let r;
      if (cancelled) r = { terminalReason: "deferred", code: "run.interrupted", cost_usd: 0, detail: "cancelled before launch" }; // #4376
      else if (pf?.closed) r = { terminalReason: "invalid", cost_usd: 0, detail: `pre-filter: ${pf.detail}` };
      else if (gone) r = { terminalReason: gone.outcome, pr: Number.isInteger(gone.pr) ? gone.pr : null, cost_usd: 0, detail: `skipped at dispatch: ${gone.detail ?? gone.outcome}` };
      // #4389: a parked post-deploy follow-up starts no lane; it ends awaiting-promotion|awaiting-precondition, re-checked next batch.
      else if (pf?.parked) r = { terminalReason: pf.kind, cost_usd: 0, detail: `pre-filter: ${pf.detail}` };
      else {
        try {
          r = await runOne(n, lane, { remote: !!rec.remote, ...(rec.placement ? { placement: rec.placement } : {}), ...(recovering.has(n) ? { recover: { code: recovering.get(n).code, attempt: recovering.get(n).attempt, final: recovering.get(n).attempt >= recoveryMax } } : {}), onStart: (info) => {
            Object.assign(rec, info ?? {}); save();
            if (cancelled) stop(n, rec); // #4376: launched while the cancel arrived
            if (reg && slotted.has(n) && info?.pid) reg.setLanePid(keyOf(n), info.pid);
          } });
        }
        catch (e) { r = { terminalReason: "engine-error", detail: e?.message ?? String(e) }; }
      }
      await settle(n, r, rec, pf);
    })());
  };

  // Lanes launched by an earlier dispatcher: re-attach to the live ones, queue the rest again (no result was recorded).
  for (const [n, rec] of [...runRecs]) {
    let p = null;
    if (adopt && (rec?.pid || rec?.handle)) { try { p = await adopt(n, rec); } catch { p = null; } }
    if (p && rec.remote) { remoteRun.add(n); track(n, Promise.resolve(p).then((r) => settle(n, r, rec, checked.get(n) ?? null))); }
    else if (p) {
      if (reg) { reg.adoptSlot(keyOf(n), { ...entryOf(n), lanePid: rec.pid }); slotted.add(n); }
      track(n, Promise.resolve(p).then((r) => settle(n, r, rec, checked.get(n) ?? null)));
    }
    else { runRecs.delete(n); if (!pending.includes(n) && !results.has(n)) { pending.unshift(n); enqueued.set(n, now()); } }
  }
  // A resume re-derives each unfinished issue's lane from its current milestone (#4153): a re-milestone takes effect.
  if (saved && resolveLane) {
    for (const n of order) {
      if (results.has(n) || running.has(n)) continue;
      let l; try { l = await resolveLane(n); } catch (e) { l = { ok: false, code: "lane.unresolved", detail: e?.message ?? String(e) }; }
      lanes.set(n, l);
    }
    noteCrossLane();
  }
  save();

  const heldDetail = (n) => cancelled ? "cancelled by operator" : tripped?.detail ?? (driftHeld.has(n) ? `drift: ${driftHeld.get(n)} flagged` : budgetStop ? `execution budget: ${budgetStop}` : budgetHeld ? "maintenance share" : "not run");
  // #4315: a recovery queued but never launched (the batch stopped: breaker, budget, hold; or a resume that did not relaunch a
  // lost run) left the issue without needs-human, since a non-final attempt does not relabel. Relabel it once, with the full reason.
  // #4318: also on a throw out of the loop and on a signal (`onExit`); `cause` overrides the held reason. Runs once per process.
  let exitRelabel = null;
  const relabelQueued = (cause = null) => (exitRelabel ??= (async () => {
    for (const [n, q] of recovering) {
      if (running.has(n) || results.has(n) || relabelled.has(n) || typeof relabelNeedsHuman !== "function") continue;
      const why = cause ?? (heldDetail(n) === "not run" ? "batch stopped" : heldDetail(n));
      const evidence = recoveryEvidence({ code: q.code, attempt: q.prev_attempt, outcome: q.outcome, resultCode: q.result_code, detail: q.detail, full: true,
        queued: q.attempt, cause: why, recoveryMax });
      let res;
      try { res = await relabelNeedsHuman({ issue: n, evidence }); } catch { res = "failed"; }
      if (res !== false && res !== "failed") relabelled.add(n); // a failed label add is retried by a resume
    }
    save();
  })());
  if (typeof onExit === "function") { try { onExit(relabelQueued); } catch { /* best effort */ } }

  // #4408: issues added to the running batch; returns how many joined. Re-reading the cumulative list is a no-op.
  const drainAdds = async () => {
    if (!getAdded) return 0;
    let got = [];
    try { got = getAdded() ?? []; } catch { got = []; }
    const fresh = [...new Set((Array.isArray(got) ? got : []).filter((n) => Number.isSafeInteger(n) && n > 0 && !set.has(n)))];
    if (!fresh.length) return 0;
    // An edge an operator wrote into a pending issue after the batch started (it waits on an added issue) holds too.
    for (const n of pending) {
      let body;
      try { body = await readBody(n); } catch { continue; }
      if (drift?.holds) bodies.set(n, body);
      deps.set(n, [...new Set([...(deps.get(n) ?? []), ...parseDeps(body, n)])]);
    }
    await addIssues(fresh);
    save();
    const list = fresh.map((n) => `#${n}`).join(", ");
    decided({ issue: null, what: `added ${list} to the batch (forgedock orchestrate --add)`, why: "operator request", alternative: "start a second batch" });
    update({ issue: null, outcome: "added", detail: list });
    return fresh.length;
  };
  // #4376: one SIGTERM per running local lane (their teardown saves the work); remote lanes run to their result.
  const stopSent = new Set();
  function stop(n, rec) {
    if (!stopLane || rec?.remote || stopSent.has(n)) return;
    stopSent.add(n);
    try { Promise.resolve(stopLane(n, rec)).catch(() => {}); } catch { /* best effort */ }
  }
  const checkCancel = () => {
    if (!getCancelled) return;
    let c = null;
    try { c = getCancelled() ?? null; } catch { c = null; }
    if (!c) { if (cancelled) { cancelled = null; save(); } return; }
    const first = !cancelled;
    cancelled = c;
    if (first) {
      save();
      decided({ issue: null, what: "cancelled the batch (forgedock orchestrate --cancel)", why: "operator request", alternative: "stop the shared schedd" });
      update({ issue: null, outcome: "cancelled", detail: "cancelled by operator (forgedock orchestrate --cancel)" });
      if (reg) withdrawExcept(new Set());
    }
    for (const [n, rec] of runRecs) if (running.has(n)) stop(n, rec);
  };
  // #4454: the shutdown stop; every wait races it and cancels its sleep.
  const aborted = signal ? new Promise((r) => { if (signal.aborted) r(); else signal.addEventListener("abort", () => r(), { once: true }); }) : null;
  const nap = (ms) => {
    const ac = new AbortController();
    return Promise.race([sleep(ms, ac.signal), ...(aborted ? [aborted] : [])]).finally(() => ac.abort());
  };
  const race = (ps) => Promise.race([...ps, ...(aborted ? [aborted] : [])]);
  const halt = () => {
    if (reg) withdrawExcept(new Set());
    save();
    halted = true;
    return Object.assign(new Error("batch stopped: schedd shutting down"), { code: "batch.stopped" });
  };
  const K = () => { let k = null; try { k = getParallel?.(); } catch { k = null; } return Number.isInteger(k) && k >= 1 ? k : parallel; };
  try {
    for (;;) {
      if (signal?.aborted) throw halt();
      await drainAdds();
      checkCancel();
      if (!pending.length && !running.size) break;
      // Resolve skips first: a dependency that finished unsatisfied (or never can) skips its dependents.
      for (let i = pending.length - 1; i >= 0; i--) {
        const n = pending[i];
        if (results.has(n)) { pending.splice(i, 1); continue; }
        const bad = edges(n).find((d) => results.has(d) && !SATISFIED.has(results.get(d).outcome));
        if (bad !== undefined) { pending.splice(i, 1); skip(n, `dependency #${bad} ended ${results.get(bad).outcome}`); }
      }
      const t = now();
      const holdUntil = heldUntil();
      let started = 0;
      driftHeld.clear();
      const isReady = (n) => {
        if (!((notBefore.get(n) ?? 0) <= t && edges(n).every((d) => results.has(d) && SATISFIED.has(results.get(d).outcome)))) return false;
        if (!drift?.holds) return true;
        let pkg = null;
        try { pkg = drift.holds(n, { body: bodies.get(n) ?? "", lane: lanes.get(n)?.lane ?? null }); } catch { pkg = null; }
        if (pkg) driftHeld.set(n, pkg);
        return !pkg;
      };
      budgetHeld = false;
      // #4183: a hook (owned-resource GC near the host ceiling) before lanes are admitted; its errors never stop the batch.
      if (beforeAdmit && !tripped && !cancelled && !holdUntil && running.size < K() && pending.some(isReady)) { try { await beforeAdmit(); } catch { /* ignored */ } }
      if (signal?.aborted) throw halt();
      budgetStop = null;
      const wanted = new Set(); // issues that stay offered in the host registry after this pass
      if (!tripped && !cancelled && !holdUntil && budget) {
        while (running.size < K()) {
          const ready = rank(pending.filter(isReady));
          const n = pickNext(ready, { classes, share: budget.share, whenIdle: budget.whenIdle, started: dispatch.started, maint: dispatch.maint,
            featuresPending: pending.some((p) => !clsOf(classes, p).maintenance) });
          if (n === null) { budgetHeld = ready.length > 0; break; }
          const g = grant(n, wanted);
          if (g === "busy") continue; // #4481: not ready any more this pass (notBefore), so `ready` drops it
          if (!g) break;
          pending.splice(pending.indexOf(n), 1);
          if (lanes.get(n)?.ok !== false) { dispatch.started++; if (clsOf(classes, n).maintenance) dispatch.maint++; }
          start(n); started++;
        }
      } else if (!tripped && !cancelled && !holdUntil && reg) {
        // Priority first, then `rank` within a priority; the free per-batch K is offered so the host queue keeps FIFO.
        const ready = rank(pending.filter(isReady));
        const want = ready.filter((n) => lanes.get(n)?.ok !== false && !isRemote(n)).slice(0, Math.max(0, K() - running.size));
        offerFresh(want);
        for (const n of want) wanted.add(n);
        for (const n of ready) {
          if (running.size >= K()) break;
          const g = grant(n, wanted);
          if (g === "busy") continue; // #4481
          if (!g) break;
          pending.splice(pending.indexOf(n), 1); start(n); started++;
        }
      } else if (!tripped && !cancelled && !holdUntil) {
        for (const n of rank(pending.filter(isReady))) {
          if (running.size >= K()) break;
          if (grant(n, new Set()) === true) { pending.splice(pending.indexOf(n), 1); start(n); started++; }
        }
      }
      if (reg) withdrawExcept(wanted);
      if (tripped && !running.size) { await drainAdds(); break; } // breaker: let running lanes finish, keep the rest pending for a resume
      if (cancelled && !running.size) { await drainAdds(); break; } // #4376: cancel: the rest end held for a resume
      if (budgetStop && !running.size) { await drainAdds(); break; } // execution budget (stop): the same, the rest end held
      // Wake for a delayed issue, the end of a usage-limit hold, or (with a live K) a poll.
      const waits = pending.map((n) => notBefore.get(n) ?? 0).filter((x) => x > t);
      if (holdUntil) waits.push(holdUntil);
      let wake = waits.length ? Math.max(0, Math.min(...waits) - t) : null;
      if (holdUntil && pending.length) wake = Math.min(wake ?? pollMs, pollMs); // #4446: a cleared hold (forgedock limits clear) admits on the next poll
      if (getParallel && pending.length) wake = Math.min(wake ?? pollMs, pollMs);
      if (offered.size && pending.length) wake = Math.min(wake ?? pollMs, pollMs); // a slot another batch frees
      if (getAdded && running.size) wake = Math.min(wake ?? pollMs, pollMs); // #4408: an add while only lanes run
      if (tripped) wake = null;
      if (getCancelled && running.size && !cancelled) wake = Math.min(wake ?? pollMs, pollMs); // #4376: notice a cancel while lanes run
      if (running.size) {
        if (wake === null) await race(running.values());
        else { const ac = new AbortController(); await race([...running.values(), sleep(wake, ac.signal)]); ac.abort(); }
      } else if (started) continue; // only lane-refused rows settled (synchronously): re-resolve skips first
      else if (pending.length && offered.size) await nap(wake); // waiting for a host slot
      else if (pending.length && waits.length) await nap(Math.min(wake, getCancelled ? pollMs : Infinity)); // wake is poll-capped by a hold or a live K; #4454: nap wakes on a stop
      else if (pending.length && budgetHeld) { if (await drainAdds()) continue; break; } // maintenance the budget does not admit now: held for a later batch
      else if (pending.length && driftHeld.size) { if (await drainAdds()) continue; break; } // held by a drift flag (block_dispatch): pending for a later batch
      else if (pending.length) { // nothing runnable, nothing running, nothing waiting on time: a dependency cycle
        for (const n of pending.splice(0)) skip(n, "dependency cycle");
        save();
      }
    }
  } catch (e) {
    // #4318: an exception out of the loop still relabels the queued recoveries before it propagates (not a #4454 stop)
    if (!halted) try { await relabelQueued(`batch failed: ${firstLine(e?.message ?? e)}`); } catch { /* best effort */ }
    throw e;
  }
  if (reg) withdrawExcept(new Set());
  await relabelQueued();
  save();
  return order.map((n) => results.get(n) ?? { issue: n, outcome: "held", pr: null, cost_usd: 0, minutes: 0, detail: heldDetail(n),
    ...(recovering.has(n) ? { recovery: { code: recovering.get(n).code, attempts: recoveries.get(n) ?? recovering.get(n).attempt, outcome: recovering.get(n).outcome ?? "needs-human",
      ...(recovering.get(n).result_code ? { result_code: recovering.get(n).result_code } : {}), detail: firstLine(recovering.get(n).detail ?? recovering.get(n).code) } } : {}) });
}

/**
 * #4409 batch-report line: estimated vs. actual lane minutes over the rows that ran with an estimate (feeds the estimator).
 * Null when no row has both.
 */
export function formatEstimateSummary(rows) {
  const xs = (rows ?? []).filter((r) => Number.isFinite(r?.est_minutes) && Number(r?.minutes) > 0 && !["held", "skipped", "lane-refused"].includes(r.outcome));
  if (!xs.length) return null;
  const sum = (f) => xs.reduce((a, r) => a + f(r), 0);
  const errs = xs.map((r) => Math.abs(r.minutes - r.est_minutes)).sort((a, b) => a - b);
  const med = errs.length % 2 ? errs[errs.length >> 1] : (errs[errs.length / 2 - 1] + errs[errs.length / 2]) / 2;
  const worst = xs.reduce((a, r) => (Math.abs(r.minutes - r.est_minutes) > Math.abs(a.minutes - a.est_minutes) ? r : a));
  return `estimates: ${xs.length} lane${xs.length === 1 ? "" : "s"}, est ${sum((r) => r.est_minutes).toFixed(1)} min vs actual ${sum((r) => r.minutes).toFixed(1)} min; median |error| ${med.toFixed(1)} min; worst #${worst.issue} est ${worst.est_minutes} actual ${worst.minutes}`;
}

/** Max chars of one row's detail in the batch-report outcome lists (#4298). */
export const OUTCOME_LINE_MAX = 200;
/**
 * #4267 batch-report lines after the table: `recovered: #A (ci.red) #B (base.conflict)`, one `unrecovered:` line per
 * mechanical needs-human row (failed recovery or a terminal code), then one escalation list holding only human codes,
 * asked once at the end of the batch. Empty when there is nothing to list.
 */
export function formatOutcomeLists(rows) {
  const out = [];
  const one = (x) => String(x ?? "").split("\n")[0].slice(0, OUTCOME_LINE_MAX);
  const rec = (rows ?? []).filter((r) => r?.recovered);
  if (rec.length) out.push(`recovered: ${rec.map((r) => `#${r.issue} (${r.recovered})`).join(" ")}`);
  for (const r of rows ?? []) {
    if (!r || r.recovered) continue;
    const human = r.outcome === "needs-human" && classifyNeedsHuman(r) === "human";
    if (!human && (r.outcome === "needs-human" || r.recovery)) out.push(`unrecovered: #${r.issue} (${r.code ?? r.recovery?.code ?? "unclassified"}: ${one(r.recovery ? `recovery ${r.recovery.code} ended ${r.recovery.outcome}: ${r.recovery.detail}` : r.detail)})`);
  }
  const esc = (rows ?? []).filter((r) => r?.outcome === "needs-human" && classifyNeedsHuman(r) === "human");
  const parked = formatParkedLine(rows); // #4389: one line for every parked post-deploy follow-up, never an escalation
  if (parked) out.push(parked);
  if (esc.length) out.push(["escalations (human decisions, asked once):", ...esc.map((r) => `- #${r.issue} (${r.code}): ${one(r.detail)}`)].join("\n"));
  return out;
}

export function formatTable(rows) {
  // #4255: sandbox minutes and cost next to the token cost, only when some lane ran in a sandbox.
  const sbx = rows.some((r) => r?.sandbox);
  const head = ["issue", "outcome", "PR", "cost", ...(sbx ? ["sbx-min", "sbx-$"] : []), "min"];
  const body = rows.map((r) => [`#${r.issue}`, r.outcome + (["skipped", "held"].includes(r.outcome) && r.detail ? ` (${r.detail})` : r.prefilter?.closed || r.prefilter?.parked ? " (pre-filter)" : ""), r.pr ? `#${r.pr}` : "-", `$${(r.cost_usd ?? 0).toFixed(2)}`,
    ...(sbx ? (r.sandbox ? [(Number(r.sandbox.minutes) || 0).toFixed(1), `$${(Number(r.sandbox.cost_usd) || 0).toFixed(2)}`] : ["-", "-"]) : []), String(r.minutes ?? 0)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join("  ").trimEnd();
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}

/**
 * #4169 batch-report line: wait time per phase summed over the rows' lane `waits` ({phase: ms}), and the heavy-step
 * semaphore queue: `now` live from `heavyStats.queued`, `max` the longest queue a lane of this batch saw. Null when nothing waited or queued.
 */
export function formatWaitSummary(rows, heavyStats = null) {
  const by = {};
  for (const r of rows ?? []) for (const [p, ms] of Object.entries(r?.waits ?? {})) if (Number.isFinite(ms) && ms >= 0) by[p] = (by[p] ?? 0) + ms;
  const seen = Math.max(0, ...(rows ?? []).map((r) => (Number.isInteger(r?.heavyQueueMax) ? r.heavyQueueMax : 0)));
  const hasRows = Object.keys(by).length > 0, hasStats = heavyStats && typeof heavyStats === "object";
  if (!hasRows && !seen && !(hasStats && heavyStats.queued > 0)) return null; // nothing waited, nothing queued: no line
  const waits = hasRows ? Object.entries(by).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, ms]) => `${p} ${(ms / 60000).toFixed(1)}m`).join(", ") : "none";
  return `waits by phase: ${waits}; heavy queue: now ${hasStats && Number.isInteger(heavyStats.queued) ? heavyStats.queued : "?"}, max ${seen}`;
}

/** #4354 batch-report tail: the fail-soft alerts (stats computeAlerts) for the batch's repo; [] when none fired. */
export function formatAlertLines(alerts) {
  return alerts?.length ? ["ALERTS", ...renderAlerts(alerts)] : [];
}

/**
 * #4255 batch-report line: sandbox lanes, minutes and cost next to those lanes' token cost, plus the execution budget
 * (`budget` from parseExecution, `day` from openExecutionBudget `dayTotals`) when a cap is set. Null without sandbox usage.
 */
export function formatSandboxSummary(rows, { budget = null, day = null } = {}) {
  const sb = (rows ?? []).filter((r) => r?.sandbox);
  if (!sb.length) return null;
  const sum = (f) => sb.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const parts = [`sandbox: ${sb.length} lane${sb.length === 1 ? "" : "s"}, ${sum((r) => r.sandbox.minutes).toFixed(1)} min, $${sum((r) => r.sandbox.cost_usd).toFixed(2)} (token cost $${sum((r) => r.cost_usd).toFixed(2)})`];
  const caps = [];
  if (budget?.batchMinutes != null) caps.push(`batch ${budget.batchMinutes} min`);
  if (budget?.batchUsd != null) caps.push(`batch $${budget.batchUsd}`);
  if (budget?.dayMinutes != null) caps.push(`day ${budget.dayMinutes} min`);
  if (budget?.dayUsd != null) caps.push(`day $${budget.dayUsd}`);
  if (caps.length) {
    let b = `budget: ${caps.join(", ")}`;
    if (day?.ok) b += `; host today ${Number(day.minutes).toFixed(1)} min, $${Number(day.cost_usd).toFixed(2)}`;
    const held = (rows ?? []).filter((r) => r?.outcome === "held" && String(r.detail ?? "").startsWith("execution budget")).length;
    if (held) b += `; cap reached, ${held} held`;
    parts.push(b);
  }
  return parts.join("; ");
}

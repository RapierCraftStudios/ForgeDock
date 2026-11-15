// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Actions minutes per release (#5569, epic #5549 5.8): minutes = sum of ceil(job minutes) from the jobs API (billable_ms is 0 on
 * some repos, so it is ignored), recorded in the release state (mirrored to the ledger when managed); the forecast is the lane's
 * trailing median; `budget.on_exceed` (local-first | hold | proceed) is applied at the gate before the release starts. p0 is never
 * blocked (I14). The monthly model report and its 25% check are pure. Used only when `release.managed`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ON_EXCEED = Object.freeze(["local-first", "hold", "proceed"]);
export const MODEL_TOLERANCE = 0.25;
const json = (s) => { try { return JSON.parse(String(s)); } catch { return null; } };

/** forge.yaml `budget:` -> {onExceed, ignore}; junk falls back to local-first. `ignore: true` (lane config `budget: ignore`) never blocks. */
export function parseBudgetConfig(sec) {
  const s = sec && typeof sec === "object" ? sec : {};
  const v = String(s.on_exceed ?? "").trim().toLowerCase();
  return { onExceed: ON_EXCEED.includes(v) ? v : "local-first", modelPerRelease: Number(s.model_release_minutes) > 0 ? Number(s.model_release_minutes) : 500, ignore: String(s.ignore ?? "").trim().toLowerCase() === "true" };
}

/** Sum of ceil(minutes) over the jobs of a jobs-API payload (jobs without both timestamps count 0). */
export function jobMinutes(payload) {
  let total = 0;
  for (const j of payload?.jobs ?? []) {
    const ms = Date.parse(j.completed_at) - Date.parse(j.started_at);
    if (ms > 0) total += Math.ceil(ms / 60_000);
  }
  return total;
}

/** Minutes of the runs created since `sinceMs` (optionally one branch), from the jobs API; null when the runs are unreadable. */
export async function releaseMinutes({ gh, repo, sinceMs, branch = null }) {
  const q = `repos/${repo}/actions/runs?per_page=100&created=>=${new Date(sinceMs).toISOString()}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;
  const runs = json(await gh(["api", q]))?.workflow_runs;
  if (!Array.isArray(runs)) return null;
  let minutes = 0;
  for (const r of runs) minutes += jobMinutes(json(await gh(["api", `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`])));
  return { runs: runs.length, minutes };
}

/** Records `{lane, minutes}` of the finished releases kept under `root` (the local cache of the ledger states); the array's non-enumerable `gates` property carries the #5583 gate records (see gateHistoryFromRoot). */
export function historyFromRoot(root) {
  if (!existsSync(root)) return Object.defineProperty([], "gates", { value: [], enumerable: false });
  const out = [];
  for (const id of readdirSync(root)) {
    try { const s = JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")); if (s?.minutes?.total > 0) out.push({ lane: s.lane ?? "release", minutes: s.minutes.total }); } catch { /* skip */ }
  }
  return Object.defineProperty(out, "gates", { value: gateHistoryFromRoot(root), enumerable: false });
}

/** Gate telemetry records (#5583) of the releases kept under `root`, oldest release first, each with `release` and `at`; [] when none. */
export function gateHistoryFromRoot(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const id of readdirSync(root).sort()) {
    try { const s = JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")); for (const g of Array.isArray(s?.gates) ? s.gates : []) out.push({ ...g, release: id, at: s.startedAt }); } catch { /* skip */ }
  }
  return out;
}

/** Median of the last `n` records of `lane`; null with no history. */
export function trailingMedian(records, lane = "release", n = 5) {
  const v = records.filter((r) => (r.lane ?? "release") === lane).slice(-n).map((r) => r.minutes).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The action at the gate: `proceed` when p0, budget ignored, forecast unknown or it fits `remaining`; else the configured `onExceed`.
 * @returns {{action: "proceed"|"local-first"|"hold", why}}
 */
export function applyOnExceed({ lane = "release", forecast, remaining, cfg }) {
  if (lane === "p0" || cfg?.ignore) return { action: "proceed", why: lane === "p0" ? "p0 is never blocked by budget" : "budget ignored" };
  if (forecast == null || remaining == null) return { action: "proceed", why: "no forecast or budget known" };
  if (forecast <= remaining) return { action: "proceed", why: `forecast ${forecast} min within ${Math.round(remaining)} min left` };
  return { action: cfg?.onExceed ?? "local-first", why: `forecast ${forecast} min exceeds ${Math.round(remaining)} min left` };
}

/** True when the measured minutes are within `tol` of the model's (the 25% exit criterion of 5.8). */
export const withinTolerance = (model, measured, tol = MODEL_TOLERANCE) => model > 0 && Math.abs(measured - model) / model <= tol;

/** Monthly model report: items [{name, model, measured}] -> {lines, model, measured, within}; measured-less items are shown as `n/a`. */
export function monthlyModel(items) {
  const done = items.filter((i) => i.measured != null);
  const model = items.reduce((a, i) => a + i.model, 0), measured = done.reduce((a, i) => a + i.measured, 0);
  const comparable = done.reduce((a, i) => a + i.model, 0);
  return {
    lines: items.map((i) => `${i.name}: model ${i.model} min, measured ${i.measured ?? "n/a"}`),
    model, measured, within: done.length > 0 && withinTolerance(comparable, measured),
  };
}

/** Report over the first 3 recorded releases (the managed waves of 5.8): model = `model_release_minutes` each (default 500) vs measured. */
export function waveReport(records, cfg = parseBudgetConfig(null)) {
  const waves = records.filter((r) => (r.lane ?? "release") === "release").slice(0, 3);
  const m = monthlyModel(waves.map((w, i) => ({ name: `release wave ${i + 1}`, model: cfg.modelPerRelease, measured: w.minutes })));
  const verdict = waves.length < 3 ? `${waves.length}/3 waves measured` : m.within ? "within 25% of the model" : "OUTSIDE 25% of the model: tune budget.on_exceed and the nightly cadence";
  return { ...m, waves: waves.length, lines: [...m.lines, `total: model ${m.model} min, measured ${m.measured} min (${verdict})`] };
}

// ---- Actions timing primitives (#5718, Forge CI W8): pure readers of runs/jobs/steps payloads, shared by `forgedock stats --release-ledger`. ----

const spanMs = (a, b) => { const d = Date.parse(b) - Date.parse(a); return Number.isFinite(d) && d > 0 ? d : 0; };
const FAILED = ["failure", "timed_out", "startup_failure"];
const lc = (v) => String(v ?? "").toLowerCase();
/** A job that ran (skipped jobs carry no time and no queue). */
export const jobRan = (j) => lc(j?.conclusion) !== "skipped" && spanMs(j?.started_at, j?.completed_at) > 0;
export const jobSeconds = (j) => spanMs(j?.started_at, j?.completed_at) / 1000;
/** Seconds a job waited for a runner (created -> started); null when the job never ran or the API gave no `created_at`. */
export const queueSeconds = (j) => (jobRan(j) && j.created_at ? spanMs(j.created_at, j.started_at) / 1000 : null);
/** Self-hosted by its labels, else by a runner group that is not GitHub's own. */
export function isSelfHosted(j) {
  if ((j?.labels ?? []).some((l) => lc(l) === "self-hosted")) return true;
  const g = lc(j?.runner_group_name);
  return Boolean(g) && !/github actions|larger runners/.test(g);
}

/**
 * Step classes, by step name only (the jobs API has no `uses`), ecosystem-neutral. Order matters: dependency installs are
 * tested before toolchains so "Install Python dependencies" is `deps`. `Post ...` steps and the runner's own
 * "Set up job" / "Complete job" are never setup.
 */
export const STEP_CLASSES = Object.freeze([
  ["checkout", /(^|[\s/])checkout(@|\s|$)|\bgit clone\b|\bfetch (the )?(repo|repository|sources?)\b/i],
  ["deps", /\bnpm (ci|install|i)\b|\bpnpm (install|i)\b|\byarn( install)?\s*(--|$)|\bpip3? install\b|\bpoetry install\b|\buv (sync|pip install)\b|\bpipenv (install|sync)\b|\bbundle install\b|\bcomposer install\b|\bgo mod download\b|\bcargo fetch\b|\bdotnet restore\b|\binstall (\w+ )?(dependencies|deps|packages|requirements|modules)\b|\brestore (\w+ )?(dependencies|deps|cache)\b|actions\/cache|^cache\b|\bdependency cache\b/i],
  ["image-build", /docker\/build-push-action|\bdocker (buildx )?build\b|\bbuildx bake\b|\bbuild (and push )?(the )?(\S+ )?(docker )?images?\b|\bimage build\b/i],
  ["toolchain", /setup-[a-z0-9-]+(@|\s|$)|\baction-setup\b|^(run )?set ?up (?!job\b)\S+|\binstall (node|python|rust|go|java|ruby|php|deno|bun|toolchain)\b|\brustup\b|\bnvm (install|use)\b|\bpyenv\b|\basdf install\b|\btoolchain\b/i],
  ["lint", /\b(lint\w*|eslint|ruff|flake8|prettier|format(ting)?( check)?|typecheck|type-check|tsc|mypy|lockfile|generated|drift|shellcheck)\b/i],
]);
export const SETUP_CLASSES = Object.freeze(["checkout", "toolchain", "deps"]);
/** Failures of these classes are mechanical: no test ran, the fix is deterministic. */
export const MECHANICAL_CLASSES = Object.freeze(["checkout", "toolchain", "deps", "lint"]);
export function classifyStep(name) {
  const n = String(name ?? "").trim();
  if (!n || /^post\b/i.test(n) || /^(set up|complete) job$/i.test(n)) return null;
  for (const [cls, re] of STEP_CLASSES) if (re.test(n)) return cls;
  return null;
}
/** Seconds one job spent per setup class: {checkout, toolchain, deps, total}. */
export function jobSetup(j) {
  const out = { checkout: 0, toolchain: 0, deps: 0, total: 0 };
  for (const s of j?.steps ?? []) {
    const cls = classifyStep(s?.name);
    if (!SETUP_CLASSES.includes(cls)) continue;
    const sec = spanMs(s.started_at, s.completed_at) / 1000;
    out[cls] += sec; out.total += sec;
  }
  return out;
}
/** Job seconds by outcome: {seconds, failed, cancelled, failedShare, cancelledShare}; shares are null with no time. */
export function minuteShares(jobs) {
  let seconds = 0, failed = 0, cancelled = 0;
  for (const j of jobs ?? []) {
    const s = jobSeconds(j), c = lc(j?.conclusion);
    seconds += s;
    if (FAILED.includes(c)) failed += s; else if (c === "cancelled") cancelled += s;
  }
  return { seconds, failed, cancelled, failedShare: seconds ? failed / seconds : null, cancelledShare: seconds ? cancelled / seconds : null };
}
/** The job that ends last: it sets the wall time of its run. Null when no job ran. */
export function criticalJob(jobs) {
  let best = null;
  for (const j of jobs ?? []) if (jobRan(j) && (!best || Date.parse(j.completed_at) > Date.parse(best.completed_at))) best = j;
  return best;
}
/** The earliest failed step over `jobs`: {job, step, cls, at} (`cls` from classifyStep), or null. */
export function firstFailedStep(jobs) {
  let best = null;
  for (const j of jobs ?? []) for (const s of j?.steps ?? []) {
    if (!FAILED.includes(lc(s?.conclusion)) || !s.completed_at) continue;
    if (!best || Date.parse(s.completed_at) < Date.parse(best.at)) best = { job: j.name, step: s.name, cls: classifyStep(s.name), at: s.completed_at };
  }
  return best;
}
export const isFailedConclusion = (c) => FAILED.includes(lc(c));

const lines = (out) => String(out ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const RUN_JQ = ".workflow_runs[] | {id, name, path, event, status, conclusion, head_sha, head_branch, run_attempt, created_at, run_started_at, updated_at, prs: [.pull_requests[]?.number], actor: (.triggering_actor.login // .actor.login // null)} | @json";
const JOB_JQ = ".jobs[] | {id, name, run_attempt, status, conclusion, created_at, started_at, completed_at, labels, runner_group_name, steps: [.steps[]? | {name, status, conclusion, started_at, completed_at}]} | @json";
/** The runs list API returns at most this many results per query; a fuller window is split in two. */
export const RUNS_QUERY_CAP = 1000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/**
 * Workflow runs created in [sinceMs, untilMs], optionally one branch and one event, paginated (`gh api --paginate`, so the
 * caller's retry helper covers each page). A window that hits the API's 1000-result cap is halved and fetched again, so
 * nothing is silently dropped. The runs API is slow (seconds per page): callers scope by branch and event.
 */
export async function listRuns({ gh, repo, sinceMs, untilMs = Date.now(), branch = null, event = null, cap = RUNS_QUERY_CAP }) {
  const q = `repos/${repo}/actions/runs?per_page=100&created=${iso(sinceMs)}..${iso(untilMs)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}${event ? `&event=${encodeURIComponent(event)}` : ""}`;
  const runs = lines(await gh(["api", "--paginate", q, "--jq", RUN_JQ]));
  if (runs.length < cap || untilMs - sinceMs < 2000) return runs;
  const mid = Math.floor((sinceMs + untilMs) / 2000) * 1000;
  const [a, b] = [await listRuns({ gh, repo, sinceMs, untilMs: mid, branch, event, cap }), await listRuns({ gh, repo, sinceMs: mid + 1000, untilMs, branch, event, cap })];
  return [...b, ...a];
}
/** Jobs (with steps) of one run, every attempt, paginated. */
export const listRunJobs = async ({ gh, repo, runId }) => lines(await gh(["api", "--paginate", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=all`, "--jq", JOB_JQ]));

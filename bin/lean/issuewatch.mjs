// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock issue-watch` (#4765): named, scoped, capped watches that claim matching open issues and feed them to lanes.
 * One watch = one (repo, name) with its own dir `~/.forge/watch/<repo>/<name>/` (or `FORGEDOCK_WATCH_DIR`), lock and
 * `status.json`; `~/.forge/watch/<repo>/claims.json` is the repo-wide registry that gives an issue at most one claim across
 * watches. Selectors, caps and the lane rule are pure functions; gh, the clock and lane/batch launching are injected (`io`).
 * `mode: per-issue` runs `forgedock run-issue` per claim; `mode: batch` `--add`s claims into one long-lived orchestrate
 * batch (batch.mjs `addIssues`, so K, the `Depends on` DAG and the report apply) and starts a new one after it reports.
 * No LLM calls.
 */
import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic, batchRoot, openBatch, listBatches } from "./batch.mjs";
import { milestoneSlug, readBranches, isDefaultLane, defaultBranches, DEFAULT_STAGING_BRANCH, DEFAULT_FEATURE_PATTERN } from "./lane.mjs";
import { postDeployOnly } from "./prefilter.mjs";
import { releaseTick, formatDryRun } from "./issuewatch-release.mjs";
import { loadPolicy } from "./decision-engine.mjs";
import { APP_SLUG } from "../init-repo.mjs";
import { noComments } from "./render.mjs";
import { listAssociations } from "./gh-assoc.mjs";
import { verifyMerge, verifyComment } from "./issuewatch-verify.mjs";

const WATCH_KEYS = ["milestone", "labels", "exclude_labels", "search", "title_regex", "since", "version", "lane", "max_issues", "max_inflight", "until", "mode", "parallel", "include_followups", "postdeploy_rollup", "threshold", "immediate", "max_release_issues", "theme_map", "tracker"];
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RETRIES = 3;
const VERIFY_WAIT_MS = 60 * 60000; // how long a merge commit's CI may stay pending before verification fails
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

// ── config ───────────────────────────────────────────────────────────────────────────────────────────────────
const scalar = (v) => {
  const s = String(v ?? "").replace(/\s+#.*$/, "").trim();
  if (/^\{.*\}$/.test(s)) return Object.fromEntries(s.slice(1, -1).split(",").map((x) => x.split(/:(.*)/s).slice(0, 2).map((y) => scalar(y))).filter(([k]) => k).map(([k, v]) => [k, v !== "" && Number.isFinite(Number(v)) ? Number(v) : v]));
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== "");
  return s.replace(/^(["'])(.*)\1$/, "$2");
};

/** The `issue_watch.watches.<name>.<key>` block of forge.yaml text (three nesting levels, which parseForgeYaml does not read): `{name: {key: value}}`. */
export function parseWatches(raw) {
  const out = {};
  let inSec = false, inWatches = false, cur = null, sub = null;
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = /^\s*/.exec(line)[0].length;
    const m = /^\s*([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (indent === 0) { inSec = m[1] === "issue_watch"; inWatches = false; cur = null; continue; }
    if (!inSec) continue;
    if (indent <= 2) { inWatches = m[1] === "watches"; cur = null; continue; }
    if (!inWatches) continue;
    if (indent <= 4) { cur = m[1]; out[cur] = {}; sub = null; continue; }
    if (indent <= 6) sub = null;
    if (cur && sub) { out[cur][sub][m[1]] = scalar(m[2]); continue; }
    if (cur && m[1] === "theme_map" && m[2] === "") { out[cur].theme_map = {}; sub = "theme_map"; continue; } // one nested block: theme -> rule list
    if (cur) out[cur][m[1]] = scalar(m[2]);
  }
  return out;
}

/** Validate one watch and return it with defaults; throws on an unknown key, bad mode, regex, date or number. */
export function validateWatch(name, cfg = {}) {
  if (!NAME_RE.test(String(name))) throw new Error(`invalid watch name ${JSON.stringify(name)}`);
  for (const k of Object.keys(cfg)) if (!WATCH_KEYS.includes(k)) throw new Error(`watch ${name}: unknown key ${k}`);
  const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : []);
  const int = (k, d) => {
    if (cfg[k] === undefined || cfg[k] === "") return d;
    const n = Number(cfg[k]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`watch ${name}: ${k} must be a positive integer`);
    return n;
  };
  const w = { name, milestone: cfg.milestone || null, labels: list(cfg.labels), exclude_labels: list(cfg.exclude_labels), search: cfg.search || null, title_regex: cfg.title_regex || null,
    since: cfg.since || null, version: cfg.version ? String(cfg.version) : null, lane: cfg.lane || null, max_issues: int("max_issues", null), max_inflight: int("max_inflight", 4),
    until: cfg.until || null, mode: cfg.mode || "per-issue", parallel: int("parallel", 4), include_followups: cfg.include_followups || "none", postdeploy_rollup: cfg.postdeploy_rollup ? Number(String(cfg.postdeploy_rollup).replace("#", "")) : null };
  if (!["per-issue", "batch", "release"].includes(w.mode)) throw new Error(`watch ${name}: mode must be per-issue, batch or release`);
  if (w.mode === "release") validateRelease(name, cfg, w, int);
  else for (const k of ["threshold", "immediate", "max_release_issues", "theme_map", "tracker"]) if (cfg[k] !== undefined) throw new Error(`watch ${name}: ${k} needs mode: release`);
  if (!["none", "defer-only"].includes(w.include_followups)) throw new Error(`watch ${name}: include_followups must be none or defer-only`);
  if (w.title_regex) { try { new RegExp(w.title_regex); } catch { throw new Error(`watch ${name}: invalid title_regex`); } }
  for (const k of ["until", "since"]) if (w[k] && !Number.isFinite(Date.parse(w[k]))) throw new Error(`watch ${name}: ${k} is not an ISO time`);
  if (w.version && !/^\d+\.\d+$/.test(w.version)) throw new Error(`watch ${name}: version must be x.y`);
  if (w.postdeploy_rollup != null && !(Number.isInteger(w.postdeploy_rollup) && w.postdeploy_rollup > 0)) throw new Error(`watch ${name}: postdeploy_rollup must be an issue number`);
  return w;
}

/** `mode: release` keys: threshold {min_issues,min_score,max_age_days}, immediate [label:x|priority:Px], max_release_issues, theme_map {theme: [label:|path:|scope:]}, tracker. */
function validateRelease(name, cfg, w, int) {
  const th = cfg.threshold && typeof cfg.threshold === "object" ? cfg.threshold : {};
  for (const k of Object.keys(th)) if (!["min_issues", "min_score", "max_age_days"].includes(k)) throw new Error(`watch ${name}: unknown threshold key ${k}`);
  for (const [k, v] of Object.entries(th)) if (!(Number(v) > 0)) throw new Error(`watch ${name}: threshold.${k} must be a positive number`);
  w.threshold = Object.fromEntries(Object.entries(th).map(([k, v]) => [k, Number(v)]));
  w.immediate = (Array.isArray(cfg.immediate) ? cfg.immediate : cfg.immediate ? [cfg.immediate] : []).map(String);
  for (const r of w.immediate) if (!/^(label:.+|priority:P[0-3])$/i.test(r)) throw new Error(`watch ${name}: immediate entry ${r} must be label:<name> or priority:P0..P3`);
  if (!Object.keys(w.threshold).length && !w.immediate.length) throw new Error(`watch ${name}: mode release needs a threshold or immediate trigger`);
  w.max_release_issues = int("max_release_issues", 40);
  const tm = cfg.theme_map && typeof cfg.theme_map === "object" ? cfg.theme_map : {};
  w.theme_map = Object.fromEntries(Object.entries(tm).map(([t, rules]) => [t, [].concat(rules).map(String)]));
  for (const [t, rules] of Object.entries(w.theme_map)) for (const r of rules) if (!/^(label|path|scope):.+/.test(r)) throw new Error(`watch ${name}: theme_map.${t} rule ${r} must be label:, path: or scope:`);
  w.tracker = cfg.tracker ? Number(String(cfg.tracker).replace("#", "")) : null;
  if (w.tracker != null && !(Number.isInteger(w.tracker) && w.tracker > 0)) throw new Error(`watch ${name}: tracker must be an issue number`);
}

/** All watches of a forge.yaml text, validated. */
export const loadWatches = (raw) => Object.fromEntries(Object.entries(parseWatches(raw)).map(([n, c]) => [n, validateWatch(n, c)]));

// ── selectors ────────────────────────────────────────────────────────────────────────────────────────────────
const labelNames = (i) => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);

/** An issue's target version: x.y from its milestone title, else from a `version:x.y` label; null when none. */
export function issueVersion(issue) {
  const m = /(\d+\.\d+)/.exec(issue.milestone?.title ?? "");
  if (m) return m[1];
  for (const l of labelNames(issue)) { const v = /^version:(\d+\.\d+)$/i.exec(l); if (v) return v[1]; }
  return null;
}

/** AND of every set selector. `search` is applied by gh, not here. */
export function matchesSelectors(issue, sel) {
  const names = labelNames(issue);
  if (sel.milestone === "none" ? issue.milestone : sel.milestone && milestoneSlug(issue.milestone?.title) !== milestoneSlug(sel.milestone)) return false;
  if ((sel.labels ?? []).some((l) => !names.includes(l))) return false;
  if ((sel.exclude_labels ?? []).some((l) => names.includes(l))) return false;
  if (sel.title_regex && !new RegExp(sel.title_regex).test(issue.title ?? "")) return false;
  if (sel.since && !(Date.parse(issue.createdAt) >= Date.parse(sel.since))) return false;
  if (sel.version && issueVersion(issue) !== sel.version) return false;
  return true;
}

const CHECK_RE = /^\s*[-*]\s+\[ \]\s+(.*)$/;
/** True when the body has an unchecked `— defer` checklist item. */
export const hasUnresolvedDefer = (body) => noComments(body).split("\n").some((l) => { const t = CHECK_RE.exec(l)?.[1]; return t != null && /\s[—-]+\s*defer\b/.test(t); });

// Bot authorship comes from the author only, never the body: a `FORGE:DEFERRED` marker in an outsider's issue is not
// the App. `gh` reports the ForgeDock App as a bare login with no `[bot]` suffix (#4467), so it is matched by slug.
const isBot = (i) => { const l = String(i.author?.login ?? ""); return /\[bot\]$|^app\//i.test(l) || i.author?.is_bot === true || l.toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "") === APP_SLUG; };
const isFollowup = (i) => /^follow-up\b/i.test(i.title ?? "");

/** `claim` (a lane/batch takes it), `fold` (post-deploy-only follow-up for the rollup), or null (not for this watch). */
export function classifyIssue(issue, watch) {
  if (isBot(issue)) {
    if (!isFollowup(issue) || watch.include_followups !== "defer-only") return null;
    if (postDeployOnly(issue.body)) return watch.postdeploy_rollup ? "fold" : null;
    return hasUnresolvedDefer(issue.body) ? "claim" : null;
  }
  return TRUSTED.has(issue.authorAssociation) ? "claim" : null;
}

/** `milestone/<slug>` (forge.yaml feature pattern) for a milestone issue, else staging; a pinned `lane:` wins but is never a default branch. Throws on a default-branch lane. */
export function laneFor(issue, watch, { branches = {}, defaults = [] } = {}) {
  const staging = branches.staging || DEFAULT_STAGING_BRANCH;
  const slug = issue.milestone?.title ? milestoneSlug(issue.milestone.title) : "";
  const lane = watch.lane || (slug ? (branches.featurePattern || DEFAULT_FEATURE_PATTERN).replace("{slug}", slug) : staging);
  if (isDefaultLane(lane, defaults)) throw new Error(`lane ${lane} is a default branch; a watch never targets it`);
  return lane;
}

/** Order `issues` so an issue named in another's `Depends on #N` line comes after it (stable otherwise). */
export function dagOrder(issues) {
  const nums = new Set(issues.map((i) => i.number));
  const deps = (i) => [...String(i.body ?? "").matchAll(/^\s*(?:[-*]\s*)?\**depends on\**:?\s*(.+)$/gim)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => +x[1])).filter((n) => nums.has(n) && n !== i.number);
  const out = [], seen = new Set();
  const visit = (i, stack = new Set()) => {
    if (seen.has(i.number) || stack.has(i.number)) return;
    stack.add(i.number);
    for (const d of deps(i)) visit(issues.find((x) => x.number === d), stack);
    seen.add(i.number); out.push(i);
  };
  issues.forEach((i) => visit(i));
  return out;
}

// ── state: dir, lock, claims ───────────────────────────────────────────────────────────────────────────────────
export const watchRoot = (env = process.env) => env.FORGEDOCK_WATCH_DIR || join(homedir(), ".forge", "watch");
export const repoDir = (repo, env = process.env) => join(watchRoot(env), String(repo).replace("/", "__"));
export const watchDir = (repo, name, env = process.env) => join(repoDir(repo, env), name);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Take the (repo, name) lock; throws when a live watcher on this host holds it. A dead holder is taken over. @returns {() => void} release */
export function acquireLock(dir, { pid = process.pid, host = hostname(), alive = pidAlive } = {}) {
  const f = join(dir, "lock");
  const held = readJson(f);
  if (held && held.host === host && held.pid !== pid && alive(held.pid)) throw new Error(`watch already running (pid ${held.pid}); lock ${f}`);
  writeAtomic(f, JSON.stringify({ pid, host }) + "\n");
  return () => { const now = readJson(f); if (now?.pid === pid) { try { writeAtomic(f, "{}\n"); } catch { /* best effort */ } } };
}

/**
 * Claim `issue` for `name` in the repo-wide registry; false when another watch already has it. Serialised across processes by a
 * mkdir lock. Idempotent for the holder: the registry is written before the watch saves its own state or launches, so after a
 * crash or a throwing launch the same watch re-claims its issue on the next pass instead of losing it (release #4820 BUG-1).
 */
export function claimIssue(rdir, issue, name) {
  const lock = join(rdir, "claims.lock");
  mkdirSync(rdir, { recursive: true });
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch (e) { if (e.code !== "EEXIST" || i > 200) throw e; sleepSync(10); }
  }
  try {
    const f = join(rdir, "claims.json");
    const claims = readJson(f) ?? {};
    if (claims[issue]) return claims[issue] === name;
    claims[issue] = name;
    writeAtomic(f, JSON.stringify(claims) + "\n");
    return true;
  } finally { rmdirSync(lock); }
}

/** Verify closed issue `n` (see tick); a pending result waits up to VERIFY_WAIT_MS from the first attempt. */
async function verifyClosed({ n, repo, io, state, now, lane }) {
  const comments = JSON.parse(String(await io.gh(["issue", "view", String(n), "-R", repo, "--json", "comments"]))).comments ?? [];
  let r = await verifyMerge({ gh: io.gh, repo, lane, issue: n, comments, ...(io.requiredChecks ? { requiredChecks: io.requiredChecks } : {}) });
  state.verifyFrom = { ...(state.verifyFrom ?? {}) };
  state.verifyFrom[n] ??= now;
  if (r.status === "pending") {
    if (now - state.verifyFrom[n] < VERIFY_WAIT_MS) return;
    r = { ...r, status: "failed", evidence: [...r.evidence, `FAIL: still unverified after ${VERIFY_WAIT_MS / 60000} min`] };
  }
  // Side effects first, state last: a failed gh call throws with the issue still closed and in pendingVerify, so the next tick
  // resumes (state.escalation records the finished steps). Reopen is last because only closed issues are revisited.
  const settled = () => { state.pendingVerify = state.pendingVerify.filter((x) => x !== n); delete state.verifyFrom[n]; };
  if (r.status === "unmerged") { settled(); state.closed.push(n); return; }
  if (r.status === "verified") {
    await io.gh(["issue", "comment", String(n), "-R", repo, "--body", verifyComment(r, now)]);
    settled(); state.merged.push(n); state.verified.push(n); return;
  }
  state.escalation = { ...(state.escalation ?? {}) };
  const done = (state.escalation[n] ??= {});
  if (!done.comment) { await io.gh(["issue", "comment", String(n), "-R", repo, "--body", verifyComment(r, now)]); done.comment = true; }
  if (!done.label) { await io.gh(["issue", "edit", String(n), "-R", repo, "--add-label", "needs-human"]); done.label = true; }
  await io.gh(["issue", "reopen", String(n), "-R", repo]);
  delete state.escalation[n];
  settled(); state.merged.push(n); state.unverified.push(n);
}

// ── the watch ────────────────────────────────────────────────────────────────────────────────────────────────
const fresh = (watch, repo) => ({ name: watch.name, repo, phase: "running", started: null, claimed: [], inflight: [], merged: [], verified: [], unverified: [], closed: [], failed: [], folded: [], retries: {}, lanes: {}, batch: null, laneFor: {} });

/**
 * One pass. `io`: `gh(args)→string`, `now()→ms`, `launch(issue,lane)→{poll()→null|{code}}` (per-issue), `batch.{add(id,issues),start(issues,parallel,lane)→id,reported(id)→bool}` (batch mode).
 * Settles inflight issues, applies the caps, claims new ones. Mutates and returns `state`; `state.phase === "done"` when a capped watch has drained.
 * A closed issue is verified, not trusted: `verified` only when its merge checks out (issuewatch-verify.mjs), `unverified`
 * (reopened, `needs-human`) when it does not, `closed` when no lane PR merged. `io.requiredChecks(lane)` overrides the lookup.
 */
export async function tick({ watch, repo, io, state, dir, branches = {}, defaults = [], handles = new Map() }) {
  const now = io.now();
  state.started ??= now;
  const ghJson = async (args) => JSON.parse(String(await io.gh(args)));
  const closed = async (n) => (await ghJson(["issue", "view", String(n), "-R", repo, "--json", "state"])).state === "CLOSED";
  const fail = (n) => { state.inflight = state.inflight.filter((x) => x !== n); state.failed.push(n); };
  const settle = (n) => { state.inflight = state.inflight.filter((x) => x !== n); state.pendingVerify = [...(state.pendingVerify ?? []), n]; };
  for (const k of ["unverified", "closed"]) state[k] ??= [];
  const verify = (n) => verifyClosed({ n, repo, io, state, now, lane: state.lanes[n] ?? branches.staging ?? DEFAULT_STAGING_BRANCH });

  for (const n of [...state.inflight]) {
    if (watch.mode === "batch") { if (await closed(n)) settle(n); continue; }
    const h = handles.get(n);
    if (!h) { handles.set(n, io.launch(n, state.lanes[n])); continue; } // a restarted watch re-launches (run-issue resumes from GitHub)
    const r = h.poll();
    if (!r) continue;
    handles.delete(n);
    if (r.code === 0) settle(n);
    else if (r.code === 75 && (state.retries[n] = (state.retries[n] ?? 0) + 1) <= RETRIES) handles.set(n, io.launch(n, state.lanes[n]));
    else fail(n);
  }
  for (const n of [...(state.pendingVerify ?? [])]) if (await closed(n)) await verify(n);
  if (watch.mode === "batch" && state.batch && io.batch.reported(state.batch)) { state.inflight.forEach(fail); state.batch = null; }

  const capped = (watch.max_issues && state.claimed.length >= watch.max_issues) || (watch.until && now >= Date.parse(watch.until));
  if (capped && state.phase === "running") state.phase = "draining";
  if (state.phase === "draining") { if (!state.inflight.length && !Object.keys(state.verifyFrom ?? {}).length) state.phase = "done"; return state; } // a merge mid-verification holds the drain

  const room = Math.min(watch.max_inflight - state.inflight.length, watch.max_issues ? watch.max_issues - state.claimed.length : Infinity);
  const args = ["issue", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,title,body,labels,milestone,author,createdAt"];
  if (watch.search) args.push("--search", watch.search);
  const candidates = [];
  const assoc = await listAssociations(io.gh, repo); // #4859: not a `gh issue list` field
  for (const raw of await ghJson(args)) {
    const i = { ...raw, authorAssociation: assoc.get(raw.number) };
    if (!matchesSelectors(i, watch)) continue;
    const kind = classifyIssue(i, watch);
    if (kind === "fold") { await fold({ issue: i, watch, repo, io, state }); continue; }
    if (kind === "claim" && !state.claimed.includes(i.number)) candidates.push(i);
  }
  const ordered = watch.mode === "batch" ? dagOrder(candidates) : candidates;
  const taken = [];
  for (const i of ordered) {
    if (taken.length >= room) break;
    const lane = laneFor(i, watch, { branches, defaults });
    if (!claimIssue(repoDir(repo, io.env), i.number, watch.name)) continue;
    state.claimed.push(i.number); state.inflight.push(i.number); state.lanes[i.number] = lane; taken.push({ n: i.number, lane });
  }
  if (taken.length && watch.mode === "batch") {
    const nums = taken.map((t) => t.n);
    if (state.batch) io.batch.add(state.batch, nums); else state.batch = await io.batch.start(nums, watch.parallel, taken[0].lane);
  } else for (const t of taken) handles.set(t.n, io.launch(t.n, t.lane));
  return state;
}

/** True when the registry leaves issue `n` to watch `name`: unclaimed, or already this watch's own claim (crash-safe re-claim, #4825). */
export const unclaimedOrOwn = (registry, n, name) => !registry?.[n] || registry[n] === name;

/** `mode: release` pass: wires the pure selectors, claim registry and lane rule into releaseTick (bin/lean/issuewatch-release.mjs). */
async function releaseStep({ watch, repo, io, state, dir, branches = {}, defaults = [], dryRun = false, cwd = process.cwd() }) {
  const args = ["issue", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,title,body,labels,milestone,author,createdAt"];
  if (watch.search) args.push("--search", watch.search);
  const registry = () => readJson(join(repoDir(repo, io.env), "claims.json")) ?? {};
  const listOpen = async () => {
    const assoc = await listAssociations(io.gh, repo); // #4859
    const all = JSON.parse(String(await io.gh(args))).map((i) => ({ ...i, authorAssociation: assoc.get(i.number) }));
    if (!dryRun) for (const i of all) if (matchesSelectors(i, watch) && classifyIssue(i, watch) === "fold") await fold({ issue: i, watch, repo, io, state });
    return all;
  };
  const eligible = (i) => matchesSelectors(i, watch) && classifyIssue(i, watch) === "claim" && !state.claimed.includes(i.number) && unclaimedOrOwn(registry(), i.number, watch.name); // release #4820 CONC-1: own claims stay eligible
  const p = loadPolicy({ io: { readFile: (f) => readFileSync(f, "utf8") }, cwd });
  return releaseTick({ watch, repo, io, state, defaults, listOpen, eligible, claim: (n) => claimIssue(repoDir(repo, io.env), n, watch.name), laneFor: (i) => laneFor(i, watch, { branches, defaults }), dagOrder,
    policy: { path: p.policyPath, text: p.policyText }, dryRun });
}

/** Append a post-deploy-only follow-up to the rollup issue's checklist, once per follow-up. */
async function fold({ issue, watch, repo, io, state }) {
  if (state.folded.includes(issue.number)) return;
  const target = String(watch.postdeploy_rollup);
  const body = JSON.parse(String(await io.gh(["issue", "view", target, "-R", repo, "--json", "body"]))).body ?? "";
  if (!new RegExp(`#${issue.number}\\b`).test(body)) await io.gh(["issue", "edit", target, "-R", repo, "--body", `${body.replace(/\s*$/, "")}\n- [ ] #${issue.number} ${issue.title} — post-deploy: folded follow-up\n`]);
  state.folded.push(issue.number);
}

/** Status text: selector, claims against max_issues, inflight, merged, verified, unverified, failed, time remaining. */
export function formatStatus(s, watch, now = Date.now()) {
  const sel = ["milestone", "labels", "exclude_labels", "search", "title_regex", "since", "version", "lane"].filter((k) => (Array.isArray(watch[k]) ? watch[k].length : watch[k])).map((k) => `${k}=${[].concat(watch[k]).join(",")}`).join(" ") || "(all trusted issues)";
  const left = watch.until ? `${Math.max(0, Math.round((Date.parse(watch.until) - now) / 60000))}m` : "forever";
  return [`watch ${s.name} (${s.repo}) [${s.phase}, ${watch.mode}]`, `  selector: ${sel}`,
    `  claims: ${s.claimed.length}/${watch.max_issues ?? "∞"}  inflight: ${s.inflight.length}  merged: ${s.merged.length}  verified: ${s.verified.length}  unverified: ${(s.unverified ?? []).length}  closed unmerged: ${(s.closed ?? []).length}  failed: ${s.failed.length}`, `  time remaining: ${left}`,
    ...(watch.mode === "release" ? [`  pool: ${(s.pool ?? []).length}  releases: ${(s.releases ?? []).length + (s.release ? 1 : 0)}${s.release ? `  active: ${s.release.theme} (${s.release.issues.length} issues, batch ${s.release.batch})` : ""}  llm-classified: ${s.llm ?? 0}`] : [])].join("\n");
}

/** Run until done (capped) or `once`; writes status.json each pass. */
export async function runWatch({ watch, repo, io, dir, branches, defaults, once = false, intervalMs = 300000, release = () => {}, cwd }) {
  const state = readJson(join(dir, "status.json")) ?? fresh(watch, repo);
  const handles = new Map();
  try {
    do {
      if (watch.mode === "release") await releaseStep({ watch, repo, io, state, dir, branches, defaults, cwd }); else await tick({ watch, repo, io, state, dir, branches, defaults, handles });
      writeAtomic(join(dir, "status.json"), JSON.stringify(state) + "\n");
      if (state.phase === "done" || once) break;
      await io.sleep(intervalMs);
    } while (true);
  } finally { release(); }
  return state;
}

// ── real io + CLI ───────────────────────────────────────────────────────────────────────────────────────────
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "forgedock.mjs");
function realIo(repo, env = process.env) {
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const root = batchRoot(env);
  return { env, gh, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    classify: (issues, themes) => { // the one LLM judgment of release mode: issues no theme_map rule classifies
      const prompt = `Classify each GitHub issue into exactly one theme of [${themes.join(", ")}], or "general" when none fits. Reply with only a JSON object {"<number>": "<theme>"}.\n\n${issues.map((i) => `#${i.number} ${i.title}\n${String(i.body ?? "").slice(0, 600)}`).join("\n---\n")}`;
      return JSON.parse(/\{[\s\S]*\}/.exec(execFileSync("claude", ["--print"], { input: prompt, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }))[0]);
    },
    launch: (n, lane) => {
      let res = null;
      const p = spawn(process.execPath, [CLI, "run-issue", String(n), "--lane", lane], { detached: true, windowsHide: true, stdio: "ignore", cwd: process.cwd(), env });
      p.on("close", (code) => { res = { code: code ?? 1 }; }); p.on("error", () => { res = { code: 1 }; });
      return { poll: () => res };
    },
    batch: {
      add: (id, issues) => openBatch(root, id).addIssues(issues),
      reported: (id) => existsSync(join(root, id, "report.json")),
      start: async (issues, parallel, lane) => {
        const before = new Set(listBatches(root));
        spawn(process.execPath, [CLI, "orchestrate", ...issues.map(String), "--parallel", String(parallel), "--lane", lane, "--repo", repo], { detached: true, windowsHide: true, stdio: "ignore", cwd: process.cwd(), env }).unref();
        for (let i = 0; i < 60; i++) { const id = listBatches(root).find((b) => !before.has(b)); if (id) return id; await new Promise((r) => setTimeout(r, 1000)); }
        throw new Error("orchestrate did not create a batch within 60s");
      },
    } };
}

const flag = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/** `forgedock issue-watch run [--name w] [--repo o/r] [--once] [--interval s] | status [--name w] [--repo o/r]`; `--dry-run` (mode release) prints the would-cut set and writes nothing. */
export async function issueWatchFromCli(argv, deps = {}) {
  const [op] = argv;
  const usage = "usage: forgedock issue-watch run [--name <w>] [--repo owner/repo] [--once] [--interval <s>] [--dry-run] | status [--name <w>] [--repo owner/repo]";
  if (!["run", "status"].includes(op)) throw new Error(usage);
  const cwd = deps.cwd ?? process.cwd(), env = deps.env ?? process.env, print = deps.print ?? ((l) => console.log(l));
  let raw = ""; try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { /* no forge.yaml: the default watch */ }
  const watches = loadWatches(raw);
  const name = flag(argv, "--name") ?? (Object.keys(watches).length === 1 ? Object.keys(watches)[0] : "default");
  const watch = watches[name] ?? (name === "default" ? validateWatch("default", {}) : null);
  if (!watch) throw new Error(`no watch ${name} in forge.yaml issue_watch.watches`);
  const io = deps.io ?? realIo(null, env);
  const repo = flag(argv, "--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const dir = watchDir(repo, name, env);
  if (op === "status") {
    const s = readJson(join(dir, "status.json"));
    print(s ? formatStatus(s, watch, io.now()) : `watch ${name}: no status yet`);
    return { ok: true };
  }
  if (argv.includes("--dry-run")) {
    if (watch.mode !== "release") throw new Error("--dry-run needs a watch with mode: release");
    const real = deps.io ?? realIo(repo, env), branches = readBranches(cwd);
    const defaults = await defaultBranches({ repo, io: { gh: async (a) => real.gh(a) }, branches });
    const state = readJson(join(dir, "status.json")) ?? fresh(watch, repo);
    const r = await releaseStep({ watch, repo, io: real, state, dir, branches, defaults, dryRun: true, cwd });
    print(r.decision ? formatDryRun(r.decision, r.pool, r.themes) : "release in flight; nothing to cut");
    return { ok: true, dryRun: r };
  }
  mkdirSync(dir, { recursive: true });
  const release = acquireLock(dir);
  const real = deps.io ?? realIo(repo, env);
  const branches = readBranches(cwd);
  const defaults = await defaultBranches({ repo, io: { gh: async (a) => real.gh(a) }, branches });
  const state = await runWatch({ watch, repo, io: real, dir, branches, defaults, cwd, once: argv.includes("--once"), intervalMs: (Number(flag(argv, "--interval")) || 300) * 1000, release });
  print(formatStatus(state, watch, real.now()));
  return { ok: true, state };
}

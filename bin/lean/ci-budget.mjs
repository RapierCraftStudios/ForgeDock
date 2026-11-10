// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Actions-minutes budget awareness and CI placement policy (#5278). No LLM anywhere.
 * - Policy: forge.yaml `ci.mode` = remote | local-first | local-attested | auto (default). The one-level parser flattens the
 *   `ci` section, so the keys are flat: `mode`, `monthly_minutes`, `reserve_pct`, `included_minutes`, `plan`.
 * - Detect: repo visibility, plan and month-to-date Actions usage across the owner (org or user) through the billing usage
 *   API, projected to month end. A public repo is free hosted minutes and is never auto-switched. A billing failure is
 *   fail-soft: stay `remote` and say the usage is unknown.
 * - Effective mode is recomputed from GitHub each time (GitHub is the register); the only local files are rebuildable
 *   caches under `~/.forge/ci-budget/` (or FORGEDOCK_CI_BUDGET_DIR): the last effective mode, parity rows, seen repos.
 * - `local-first` / `local-attested` coerce verify.mode ci|hybrid to local (no paid CI before review). `local-attested`
 *   posts the host check result as a `forgedock/ci-local` commit status: the trust trade-off is the same as a self-hosted runner.
 * Every GitHub effect goes through the injected `gh` (argv -> stdout string).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseForgeYaml } from "../forge-utils.mjs";

export const CI_MODES = Object.freeze(["remote", "local-first", "local-attested", "auto"]);
/** Included Actions minutes per month by plan (overridable: GitHub changes pricing). Public repos are free on standard runners. */
export const PLAN_MINUTES = Object.freeze({ free: 2000, pro: 3000, team: 3000, enterprise: 50000 });
/** Minutes consumed from the included pool per runner minute. */
export const OS_RATE = Object.freeze({ linux: 1, windows: 2, macos: 10 });
export const DEFAULT_RESERVE_PCT = 10;
export const ATTEST_CONTEXT = "forgedock/ci-local";
const CACHE_TTL_MS = 24 * 3600 * 1000;

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const posInt = (v) => { const n = Number(v); return str(v) !== "" && Number.isInteger(n) && n > 0 ? n : null; };
const kmin = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** forge.yaml `ci` section -> {mode, monthlyMinutes, reservePct, includedMinutes, plan}; junk keeps the defaults (auto, 10%). */
export function parseCiPolicy(sec) {
  const s = sec && typeof sec === "object" ? sec : {};
  const mode = CI_MODES.includes(str(s.mode)) ? str(s.mode) : "auto";
  const r = Number(str(s.reserve_pct));
  const plan = str(s.plan).toLowerCase();
  return {
    mode,
    monthlyMinutes: posInt(s.monthly_minutes),
    reservePct: str(s.reserve_pct) !== "" && Number.isFinite(r) && r >= 0 && r <= 90 ? r : DEFAULT_RESERVE_PCT,
    includedMinutes: posInt(s.included_minutes),
    plan: PLAN_MINUTES[plan] !== undefined ? plan : null,
  };
}

/** The policy of the forge.yaml in `cwd` (defaults when absent or unreadable). */
export function readCiPolicy(cwd = process.cwd()) {
  try { return parseCiPolicy(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.ci); } catch { return parseCiPolicy(null); }
}

const json = (s) => { try { return JSON.parse(String(s)); } catch { return null; } };
const ghJson = async (gh, args) => { try { return json(await gh(args)); } catch { return null; } };

/** Month-to-date Actions minutes (runner-rate weighted) from a billing usage payload: {total, byRepo, byOs}. */
export function sumUsage(payload) {
  const items = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
  const out = { total: 0, byRepo: {}, byOs: {} };
  for (const it of items) {
    if (str(it?.product).toLowerCase() !== "actions" || !/minute/i.test(str(it?.unitType) || "minutes")) continue;
    const q = Number(it.quantity);
    if (!Number.isFinite(q) || q <= 0) continue;
    const sku = str(it.sku).toLowerCase();
    const os = /macos|mac_/.test(sku) ? "macos" : /windows/.test(sku) ? "windows" : "linux";
    const pooled = q * OS_RATE[os];
    out.total += pooled;
    out.byOs[os] = (out.byOs[os] ?? 0) + q;
    const repo = str(it.repositoryName) || "(unattributed)";
    out.byRepo[repo] = (out.byRepo[repo] ?? 0) + pooled;
  }
  return out;
}

/** Linear projection of the month: burn per elapsed day x days in the month. */
export function project(mtd, now) {
  const d = new Date(now), day = d.getUTCDate();
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const burn = day > 0 ? mtd / day : 0;
  return { burnPerDay: burn, projected: Math.round(burn * days), day, days };
}

/**
 * Facts for the budget: visibility, plan, included minutes, month-to-date usage across the owner, projection.
 * `usage` is null when the billing API is unreadable (token scope, plan): callers treat it as unknown.
 */
export async function detectBudget({ gh, repo, policy = parseCiPolicy(null), now = Date.now() }) {
  const meta = await ghJson(gh, ["api", `repos/${repo}`]);
  const owner = str(meta?.owner?.login) || repo.split("/")[0];
  const isOrg = str(meta?.owner?.type) === "Organization";
  const isPublic = meta ? meta.private === false : false;
  const d = new Date(now);
  const usageRaw = await ghJson(gh, ["api", `${isOrg ? "orgs" : "users"}/${owner}/settings/billing/usage?year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`]);
  let plan = policy.plan;
  if (!plan) {
    const o = await ghJson(gh, ["api", isOrg ? `orgs/${owner}` : "user"]);
    const name = str(o?.plan?.name).toLowerCase();
    plan = PLAN_MINUTES[name] !== undefined ? name : /enterprise/.test(name) ? "enterprise" : null;
  }
  const included = policy.includedMinutes ?? (plan ? PLAN_MINUTES[plan] : null);
  const budget = policy.monthlyMinutes ?? included;
  const usage = usageRaw ? sumUsage(usageRaw) : null;
  const proj = usage ? project(usage.total, now) : null;
  return { repo, owner, isOrg, isPublic, plan, included, budget, usage, mtd: usage ? Math.round(usage.total) : null, projected: proj?.projected ?? null, burnPerDay: proj?.burnPerDay ?? null };
}

/**
 * The effective mode. A public repo is free hosted minutes and never auto-switched. A configured non-auto mode is honoured.
 * `auto`: `remote` while the projection stays under budget x (1 - reserve), else `local-first` (switched, with the reason);
 * an unknown usage or budget stays `remote`.
 * @returns {{configured, effective, switched, free, reason}}
 */
export function resolveCiMode({ policy, facts }) {
  const configured = policy.mode;
  if (facts?.isPublic && configured === "auto") return { configured, effective: "remote", switched: false, free: true, reason: "public repo: free hosted minutes" };
  if (configured !== "auto") return { configured, effective: configured, switched: false, free: !!facts?.isPublic, reason: "configured" };
  if (!facts || facts.projected === null || facts.budget === null) return { configured, effective: "remote", switched: false, free: false, reason: "usage unknown (billing API unreadable): staying remote" };
  const limit = Math.floor(facts.budget * (1 - policy.reservePct / 100));
  if (facts.projected > limit) return { configured, effective: "local-first", switched: true, free: false, reason: `projected ${kmin(facts.projected)} > budget ${kmin(limit)} (${kmin(facts.budget)} less ${policy.reservePct}% reserve)` };
  return { configured, effective: "remote", switched: false, free: false, reason: `projected ${kmin(facts.projected)} within budget ${kmin(limit)}` };
}

/** One budget line for the batch and release reports: `ci: auto -> local-first (...); month: 22k/50k, projected 41k`. */
export function formatBudgetLine({ res, facts, release = null }) {
  const mode = res.switched ? `${res.configured} -> ${res.effective}` : res.configured === "auto" ? `auto (${res.effective})` : res.effective;
  const parts = [];
  if (release) parts.push(`this release: ${release.runs} CI run${release.runs === 1 ? "" : "s"}, ${Math.round(release.minutes)} min`);
  parts.push(`ci: ${mode} (${res.reason})`);
  if (res.free) parts.push("free hosted minutes");
  else if (facts?.mtd !== null && facts?.mtd !== undefined) parts.push(`month: ${kmin(facts.mtd)}/${facts.budget === null ? "?" : kmin(facts.budget)}, projected ${kmin(facts.projected)}`);
  if (res.switched) parts.push("SWITCHED to local-first: host checks run before paid CI");
  return parts.join("; ");
}

/** A workflow run's duration in minutes (0 when its timestamps are missing or inverted). */
const runMinutes = (r) => { const ms = Date.parse(r.updated_at) - Date.parse(r.run_started_at ?? r.created_at); return ms > 0 ? ms / 60000 : 0; };

/** Actions runs since `sinceMs` on the repo: {runs, minutes} from run durations (best effort, null on failure). */
export async function releaseRuns({ gh, repo, sinceMs, branch = null }) {
  const since = new Date(sinceMs).toISOString();
  const q = `repos/${repo}/actions/runs?per_page=100&created=>=${since}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;
  const j = await ghJson(gh, ["api", q]);
  if (!j || !Array.isArray(j.workflow_runs)) return null;
  let minutes = 0;
  for (const r of j.workflow_runs) minutes += runMinutes(r);
  return { runs: j.workflow_runs.length, minutes };
}

// ---- caches (rebuildable) -------------------------------------------------------------------------------------------
export const cacheDir = (env = process.env) => env.FORGEDOCK_CI_BUDGET_DIR || join(homedir(), ".forge", "ci-budget");
const keyOf = (cwd) => createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
const ensure = (dir) => { mkdirSync(dir, { recursive: true }); return dir; };

export function writeEffective({ cwd = process.cwd(), res, now = Date.now(), dir = cacheDir() }) {
  try { writeFileSync(join(ensure(dir), `effective-${keyOf(cwd)}.json`), JSON.stringify({ at: now, effective: res.effective, configured: res.configured, switched: res.switched, reason: res.reason })); } catch { /* a cache */ }
}
/** The last effective mode the budget resolver cached for this checkout, or null when none or older than a day. */
export function readEffective({ cwd = process.cwd(), now = Date.now(), dir = cacheDir() } = {}) {
  const j = json((() => { try { return readFileSync(join(dir, `effective-${keyOf(cwd)}.json`), "utf8"); } catch { return ""; } })());
  return j && now - j.at < CACHE_TTL_MS ? j : null;
}

/** The mode engine seams act on, synchronously: a configured mode, or for `auto` the cached resolution (remote when none). */
export function effectiveModeSync({ cwd = process.cwd(), now = Date.now(), dir = cacheDir() } = {}) {
  const policy = readCiPolicy(cwd);
  if (policy.mode !== "auto") return policy.mode;
  return readEffective({ cwd, now, dir })?.effective ?? "remote";
}

/** `local-first` and `local-attested` never push-and-wait for paid CI before review: verify.mode ci|hybrid becomes local. */
export function coerceVerify(verify, opts = {}) {
  if (!verify || (verify.mode !== "ci" && verify.mode !== "hybrid")) return verify;
  const m = effectiveModeSync(opts);
  return m === "local-first" || m === "local-attested" ? { ...verify, mode: "local", ciModeCoerced: m } : verify;
}

// ---- parity (local green -> remote red) ------------------------------------------------------------------------------
export const parityFile = (dir = cacheDir()) => join(dir, "parity.jsonl");

/** Per-suite hit rate: of the suites that were local green and have a remote result, the share that went red remotely. */
export function hitRates(rows) {
  const out = {};
  for (const r of rows) for (const [suite, remote] of Object.entries(r.remote ?? {})) {
    if (r.local?.[suite] !== "pass") continue;
    const s = (out[suite] ??= { greenLocal: 0, redRemote: 0 });
    s.greenLocal++; if (remote === "fail") s.redRemote++;
  }
  for (const s of Object.values(out)) s.rate = s.greenLocal ? s.redRemote / s.greenLocal : 0;
  return out;
}

export const formatHitRates = (rates) => {
  const e = Object.entries(rates);
  return e.length ? `parity (local green -> remote red): ${e.map(([k, v]) => `${k} ${v.redRemote}/${v.greenLocal}`).join(", ")}` : "parity: no local/remote pairs yet";
};

/** Maps check-run names to pass/fail for a head sha (check-runs payload); neutral/skipped count as pass. */
export function remoteSuites(payload) {
  const out = {};
  for (const c of Array.isArray(payload?.check_runs) ? payload.check_runs : []) {
    if (!c.conclusion) continue;
    const bad = ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion);
    out[c.name] = bad ? "fail" : out[c.name] === "fail" ? "fail" : "pass";
  }
  return out;
}

/** Fills each local row's `remote` map from the head's check runs (rows whose head has no completed runs stay unpaired). */
export async function pairParity({ gh, repo, rows }) {
  const out = [];
  for (const r of rows) {
    if (!r.head) continue;
    const remote = remoteSuites(await ghJson(gh, ["api", `repos/${repo}/commits/${r.head}/check-runs?per_page=100`]));
    out.push({ ...r, remote: Object.fromEntries(Object.entries(remote).filter(([k]) => k in (r.local ?? {}))) });
  }
  return out;
}

export function readParity(dir = cacheDir()) {
  try { return readFileSync(parityFile(dir), "utf8").split("\n").filter(Boolean).map(json).filter(Boolean); } catch { return []; }
}

// ---- the host check hook ---------------------------------------------------------------------------------------------
/** The attested commit status body for a host result. */
export const attestPayload = ({ ok, suites }) => ({
  state: ok ? "success" : "failure", context: ATTEST_CONTEXT,
  description: `${ok ? "host checks passed" : "host checks failed"} (${suites.length} suite(s), attested by ForgeDock, not run by Actions)`.slice(0, 140),
});

/**
 * Called after the pre-PR host check record is written: appends a parity row (head, per-suite pass/fail) and, in
 * `local-attested`, posts the `forgedock/ci-local` commit status. Fail-soft: never throws.
 */
export async function recordHostCheck({ cwd, head, ok, suites, gh = defaultGh, repo = null, dir = cacheDir(), mode = null, now = Date.now() }) {
  try {
    if (!head) return;
    ensure(dir);
    appendFileSync(parityFile(dir), `${JSON.stringify({ at: now, head, local: Object.fromEntries(suites.map((s) => [s.name, s.ok ? "pass" : "fail"])) })}\n`);
    if ((mode ?? effectiveModeSync({ cwd, dir, now })) !== "local-attested") return;
    const slug = repo ?? JSON.parse(String(await gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
    const p = attestPayload({ ok, suites });
    await gh(["api", `repos/${slug}/statuses/${head}`, "-f", `state=${p.state}`, "-f", `context=${p.context}`, "-f", `description=${p.description}`]);
  } catch { /* a missing status never fails the check */ }
}

const defaultGh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// ---- alerts and digest -----------------------------------------------------------------------------------------------
/** Alerts: projected overage and repos burning minutes that were not seen in the previous digest (e.g. a repo flipped private). */
export function budgetAlerts({ facts, seen = null }) {
  const out = [];
  if (facts?.budget && facts.projected !== null && facts.projected > facts.budget) out.push(`ALERT projected overage: ${kmin(facts.projected)} > ${kmin(facts.budget)} included minutes`);
  if (seen && facts?.usage) for (const [r, m] of Object.entries(facts.usage.byRepo)) if (!seen.includes(r) && m > 0) out.push(`ALERT new burn source: ${r} used ${kmin(m)} min this month (new or flipped private)`);
  return out;
}

/** Monthly digest: per-repo minutes (billing items) and the per-OS split. */
export function formatDigest(facts) {
  if (!facts?.usage) return "digest: usage unknown (billing API unreadable)";
  const repos = Object.entries(facts.usage.byRepo).sort((a, b) => b[1] - a[1]);
  const lines = [`digest ${facts.owner}: ${kmin(facts.mtd)} min month-to-date, projected ${kmin(facts.projected)}`];
  for (const [r, m] of repos) lines.push(`  ${r}: ${kmin(m)} min`);
  const os = Object.entries(facts.usage.byOs).map(([k, v]) => `${k} ${kmin(v)} (x${OS_RATE[k]})`).join(", ");
  if (os) lines.push(`  by runner OS: ${os}`);
  return lines.join("\n");
}

/** Per-workflow minutes of the month from run durations (best effort), `[ [name, minutes], ... ]` descending. */
export async function workflowDigest({ gh, repo, now = Date.now() }) {
  const d = new Date(now), since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const j = await ghJson(gh, ["api", `repos/${repo}/actions/runs?per_page=100&created=>=${since}`]);
  const by = {};
  for (const r of Array.isArray(j?.workflow_runs) ? j.workflow_runs : []) by[r.name] = (by[r.name] ?? 0) + runMinutes(r);
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}

const seenFile = (owner, dir) => join(dir, `seen-${owner.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
export const readSeen = (owner, dir = cacheDir()) => { try { return json(readFileSync(seenFile(owner, dir), "utf8"))?.repos ?? null; } catch { return null; } };
export function writeSeen(owner, repos, dir = cacheDir()) { try { writeFileSync(seenFile(owner, ensure(dir)), JSON.stringify({ repos })); } catch { /* a cache */ } }

// ---- forge.yaml writer -----------------------------------------------------------------------------------------------
const CI_KEYS = ["mode", "monthly_minutes", "reserve_pct", "included_minutes", "plan"];

/**
 * Returns forge.yaml text with the ci policy keys set, keeping every other line of the `ci:` block (milestone integration
 * keys) as is. Creates the block when absent. `set` is {mode?, monthly_minutes?, reserve_pct?, included_minutes?, plan?}.
 * Validates through parseCiPolicy semantics and throws on an invalid value.
 */
export function writeCiBlock(raw, set) {
  if (set.mode !== undefined && !CI_MODES.includes(set.mode)) throw new Error(`ci.mode must be one of ${CI_MODES.join(", ")}`);
  for (const k of ["monthly_minutes", "included_minutes"]) if (set[k] !== undefined && !posInt(set[k])) throw new Error(`ci.${k} must be a positive integer`);
  if (set.reserve_pct !== undefined && !(Number(set.reserve_pct) >= 0 && Number(set.reserve_pct) <= 90)) throw new Error("ci.reserve_pct must be 0-90");
  if (set.plan !== undefined && PLAN_MINUTES[String(set.plan).toLowerCase()] === undefined) throw new Error(`ci.plan must be one of ${Object.keys(PLAN_MINUTES).join(", ")}`);
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => /^ci:\s*(#.*)?$/.test(l));
  const want = CI_KEYS.filter((k) => set[k] !== undefined).map((k) => `  ${k}: ${k === "plan" ? String(set[k]).toLowerCase() : set[k]}`);
  if (start < 0) return `${raw.replace(/\n*$/, "\n")}\nci:\n${want.join("\n")}\n`;
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^\s*(#.*)?$/.test(lines[end]))) end++;
  const body = lines.slice(start + 1, end).filter((l) => !CI_KEYS.some((k) => new RegExp(`^\\s+${k}:`).test(l) && set[k] !== undefined));
  return [...lines.slice(0, start + 1), ...want, ...body, ...lines.slice(end)].join("\n");
}

// ---- CLI -------------------------------------------------------------------------------------------------------------
export const CI_USAGE = "usage: forgedock ci budget [--repo owner/repo] [--json] [--digest] [--propose [--base REF]] [--set-mode MODE] [--budget MINUTES] [--reserve PCT] [--plan PLAN]";
const flagVal = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

/** `forgedock ci budget ...`; @returns the exit code. `deps`: {gh, cwd, now, out, dir}. */
export async function ciFromCli(argv, deps = {}) {
  const out = deps.out ?? ((l) => console.log(l)), cwd = deps.cwd ?? process.cwd(), gh = deps.gh ?? defaultGh, now = deps.now ?? Date.now(), dir = deps.dir ?? cacheDir();
  if (argv[0] !== "budget") throw new Error(CI_USAGE);
  const rest = argv.slice(1);
  const valued = ["--repo", "--set-mode", "--budget", "--reserve", "--plan", "--base"];
  const unknown = rest.find((a, i) => a.startsWith("--") && ![...valued, "--json", "--digest", "--propose"].includes(a) && !valued.includes(rest[i - 1] ?? ""));
  if (unknown) throw new Error(`unknown option ${unknown}; ${CI_USAGE}`);
  const set = {};
  if (flagVal(rest, "--set-mode") !== undefined) set.mode = flagVal(rest, "--set-mode");
  if (flagVal(rest, "--budget") !== undefined) set.monthly_minutes = flagVal(rest, "--budget");
  if (flagVal(rest, "--reserve") !== undefined) set.reserve_pct = flagVal(rest, "--reserve");
  if (flagVal(rest, "--plan") !== undefined) set.plan = flagVal(rest, "--plan");
  if (Object.keys(set).length) {
    const file = join(cwd, "forge.yaml");
    if (!existsSync(file)) throw new Error(`no forge.yaml in ${cwd}`);
    writeFileSync(file, writeCiBlock(readFileSync(file, "utf8"), set));
    out(`forge.yaml: ci ${Object.entries(set).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  const repo = flagVal(rest, "--repo") ?? JSON.parse(String(await gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const policy = readCiPolicy(cwd);
  const facts = await detectBudget({ gh, repo, policy, now });
  const res = resolveCiMode({ policy, facts });
  writeEffective({ cwd, res, now, dir });
  const seen = readSeen(facts.owner, dir);
  const alerts = budgetAlerts({ facts, seen });
  if (facts.usage) writeSeen(facts.owner, Object.keys(facts.usage.byRepo), dir);
  const rates = hitRates(await pairParity({ gh, repo, rows: readParity(dir).slice(-50) }));
  if (rest.includes("--json")) { out(JSON.stringify({ repo, plan: facts.plan, includedMinutes: facts.included, budget: facts.budget, public: facts.isPublic, monthToDate: facts.mtd, projected: facts.projected, mode: res.effective, configured: res.configured, switched: res.switched, reason: res.reason, alerts, parity: rates }, null, 2)); return 0; }
  out(`repo: ${repo} (${facts.isPublic ? "public: free hosted minutes" : "private"})`);
  out(`plan: ${facts.plan ?? "unknown"}; included minutes: ${facts.included ?? "unknown"}; budget: ${facts.budget ?? "unknown"}`);
  out(facts.usage ? `month-to-date (all repos of ${facts.owner}): ${facts.mtd} min; burn ${Math.round(facts.burnPerDay)}/day; projected ${facts.projected}` : `month-to-date: unknown (billing API unreadable; needs a token that can read ${facts.isOrg ? "org" : "user"} billing)`);
  out(`mode: ${res.configured}${res.configured !== res.effective ? ` -> ${res.effective}` : ""} (${res.reason})`);
  for (const a of alerts) out(a);
  out(formatHitRates(rates));
  if (rest.includes("--digest")) { out(formatDigest(facts)); for (const [n, m] of await workflowDigest({ gh, repo, now })) out(`  workflow ${n}: ${kmin(m)} min`); }
  if (rest.includes("--propose")) {
    const { buildPlan, summarizePlan } = await import(fileURLToPath(new URL("../../scripts/ci-local/plan.mjs", import.meta.url)));
    const base = flagVal(rest, "--base") ?? "origin/main";
    for (const l of summarizePlan(buildPlan({ repo: cwd, base })).filter((x) => /CI_LOCAL_JOB: runnable/.test(x))) out(l);
    out(`run locally: bash scripts/ci-local.sh --base ${base}`);
  }
  return 0;
}

/** The report line for the cwd repo (batch and release reports); resolves, caches the effective mode, and never throws. */
export async function budgetReportLine({ cwd = process.cwd(), repo, gh = defaultGh, now = Date.now(), dir = cacheDir(), release = null } = {}) {
  try {
    const policy = readCiPolicy(cwd);
    const facts = await detectBudget({ gh, repo, policy, now });
    const res = resolveCiMode({ policy, facts });
    writeEffective({ cwd, res, now, dir });
    return formatBudgetLine({ res, facts, release });
  } catch (e) { return `ci: budget n/a (${String(e?.message ?? e).split("\n")[0].slice(0, 120)})`; }
}

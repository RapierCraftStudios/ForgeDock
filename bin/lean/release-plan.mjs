// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock release plan` (#5559): a deterministic, read-only dry run. A snapshot of open issues + the default-branch policy + the live sha
 * becomes ordered waves, exclusions with machine-readable reason keys and a `plan_hash` an approval binds to (I2).
 * `buildPlan` is pure (no clock, no I/O): the same inputs give a byte-identical plan whatever the input order. Effects (gh, git, ledger) live in `planFromCli`.
 */
import { createHash } from "node:crypto";
import { resolvePath } from "./release-unitmap.mjs";
import { deriveFacts, riskOf } from "./release-classify.mjs";
import { priorityOf } from "./issuewatch-release.mjs";
import { trailingMedian, applyOnExceed, parseBudgetConfig } from "./release-minutes.mjs";

export const PLAN_SCHEMA = "forgedock.release.plan/v1";
export const PLAN_LABEL = "release-plan"; // tracking issue(s) whose comments carry FORGE:DECISION plan <hash>; never a candidate
export const DECISION_RE = /<!--\s*FORGE:DECISION\s+plan\s+([0-9a-f]{64})\s*-->/i;
export const BATCH_SKIP_LABELS = ["needs-human", "post-deploy", "workflow:merged", "awaiting-promotion", "host-task"];
export const EXCLUSION_KEYS = ["epic", "plan.skip_labels", "design_gate", "dependency_open", "ready_no", "unclassified", "dependency_cycle", "max_issues", "lane_force_exclude", "p0"];
export const LANE_FORCE_TTL_MS = 24 * 3_600_000; // a `lane --force` decision without `until` is honoured this long after `at`
const SEV = { P0: 0, P1: 1, P2: 2, P3: 3 };

const sha = (s) => createHash("sha256").update(s).digest("hex");
/** JSON with sorted object keys: the byte-stable form the hash and the output use. */
export const stableJson = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const names = (i) => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
const depsOf = (i) => [...new Set([...String(i.body ?? "").matchAll(/^\s*(?:[-*]\s*)?\**depends on\**:?\s*(.+)$/gim)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => +x[1])).filter((n) => n !== i.number))].sort((a, b) => a - b);

/** The latest `FORGE:CLASSIFY` record in an issue's comments (JSON body), or null. */
export function recordOf(comments) {
  const c = (comments ?? []).map((x) => String(x?.body ?? "")).filter((b) => b.includes("FORGE:CLASSIFY")).at(-1);
  if (!c) return null;
  let body = c, prev; // strip comment markers until stable (CodeQL js/incomplete-multi-character-sanitization)
  do { prev = body; body = body.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--/g, ""); } while (body !== prev);
  try { const o = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)); return o && typeof o === "object" ? o : null; } catch { return null; }
}

/**
 * The units a set of changed files rolls (design 4.4), as one pure function. `units` is a superset of the units owning or coupled to the files and of every
 * contract producer and consumer touched; `contract.order` is producer first; `pipeline` is `full` when any `forces` entry or a `service_pipeline: false` unit is involved.
 */
export function rollSet(policy, files) {
  const res = (files ?? []).map((f) => resolvePath(policy, f));
  const units = new Set(), contracts = [], forced = [];
  for (const r of res) {
    r.units.forEach((u) => units.add(u));
    r.affects.forEach((u) => units.add(u)); // shared paths roll the full couplings consumer set
    for (const c of r.contracts) { if (!contracts.includes(c)) contracts.push(c); }
    for (const f of r.forces) forced.push(f.reason ?? f.pipeline ?? "forces");
  }
  const order = [];
  for (const c of contracts) { for (const u of [c.producer, ...(c.consumers ?? [])]) { if (u) { units.add(u); if (!order.includes(u)) order.push(u); } } }
  const all = [...units].sort();
  const noService = all.filter((u) => policy?.units?.[u]?.service_pipeline === false);
  const hosts = {};
  for (const u of all) {
    const h = policy?.units?.[u]?.hosts;
    if (Array.isArray(h) && h.length) hosts[u] = h.length > 1 && policy.units[u].single_host_ok ? [h[0]] : [...h]; // a two-host unit rolls on both unless single_host_ok
  }
  const additive = contracts.every((c) => c.additive_only === true);
  return {
    units: all,
    contract: { atomic: contracts.length > 0, order, additive_only: additive, release_only: contracts.length > 0 && !additive },
    pipeline: !all.length && !forced.length ? "none" : forced.length || noService.length ? "full" : "service",
    forced: [...new Set(forced)].sort(), no_service: noService, hosts,
  };
}

/** `lane --force` entries (`{force, actor, at, until?}`) still in force at `now` and from a trusted actor (when `trust.actors` is set). */
export function honouredLanes(lanes, policy, now) {
  const trusted = policy?.trust?.actors ?? [], out = {};
  for (const [n, e] of Object.entries(lanes ?? {})) {
    if (!e?.actor || !["train", "release", "p0", "exclude"].includes(e.force)) continue;
    if (trusted.length && !trusted.includes(e.actor)) continue;
    const end = Date.parse(e.until ?? "") || (Date.parse(e.at ?? "") + LANE_FORCE_TTL_MS);
    if (!(end > now)) continue; // expired or no usable timestamp
    out[n] = { force: e.force, actor: e.actor, until: new Date(end).toISOString() };
  }
  return out;
}

function sccs(nodes, edges) { // Tarjan; edges: n -> [dependency numbers]
  let idx = 0; const st = [], on = new Set(), low = new Map(), num = new Map(), out = [];
  const visit = (v) => {
    num.set(v, idx); low.set(v, idx++); st.push(v); on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!num.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), num.get(w)));
    }
    if (low.get(v) === num.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); out.push(c); }
  };
  for (const v of nodes) if (!num.has(v)) visit(v);
  return out;
}

/**
 * @param {{issues: object[], policy: object, policySha: string, liveSha: string|null, lanes?: object, now?: number, investigate?: (issue) => object|null, verifiedLive?: (n: number) => boolean}} input
 *   issues: `{number, title, body, labels, createdAt, updatedAt, comments?}`; PRs (`pullRequest`/`pull_request`/`isPullRequest`) are never candidates.
 * @returns the plan: `{schema, plan_hash, policy_sha, live_sha, snapshot, waves, issues, excluded}`.
 */
export function buildPlan({ issues, policy, policySha, liveSha, lanes = {}, now = 0, investigate, verifiedLive }) {
  const pool = (issues ?? []).filter((i) => !(i.pullRequest || i.pull_request || i.isPullRequest) && !names(i).includes(PLAN_LABEL)).sort((a, b) => a.number - b.number);
  const byNum = new Map(pool.map((i) => [i.number, i]));
  const forces = honouredLanes(lanes, policy, now);
  const snapshot = pool.map((i) => ({ number: i.number, updated_at: i.updatedAt ?? null, body_sha: sha(String(i.body ?? "")) }));
  const hashed = { snapshot, policy_sha: policySha ?? null, live_sha: liveSha ?? null, ...(Object.keys(forces).length ? { lane_forces: forces } : {}) };
  const excluded = new Map(), info = new Map();
  const exclude = (n, key, detail) => { if (!excluded.has(n)) excluded.set(n, { number: n, key, detail }); };
  const skip = [...new Set([...(policy?.plan?.skip_labels ?? BATCH_SKIP_LABELS), "hold"])], min = policy?.classify?.min_confidence;
  const alive = [];
  for (const i of pool) {
    const n = i.number, ls = names(i);
    if (ls.includes("epic")) { exclude(n, "epic", "epics are not built"); continue; }
    const hit = ls.filter((l) => skip.includes(l) || l.startsWith("parked:"));
    if (hit.length) { exclude(n, "plan.skip_labels", `labelled ${hit.join(", ")}`); continue; }
    if (policy?.plan?.require_design_gate !== false && ls.includes("design:needed") && !ls.includes("design:approved")) { exclude(n, "design_gate", "design:needed without design:approved"); continue; }
    let rec = recordOf(i.comments);
    if (rec?.ready === false || ls.includes("ready:no")) { exclude(n, "ready_no", "classified ready: no"); continue; }
    const low = (r) => !r || (min !== undefined && !(Number(r.confidence) >= min));
    if (low(rec) && investigate) { const r = investigate(i); if (r && typeof r === "object") rec = { ...(rec ?? {}), ...r }; }
    if (low(rec)) { exclude(n, "unclassified", rec ? `confidence ${rec.confidence ?? "unknown"} below classify.min_confidence ${min}` : "no FORGE:CLASSIFY record"); continue; }
    if (forces[n]?.force === "exclude") { exclude(n, "lane_force_exclude", `lane --force exclude by ${forces[n].actor}`); continue; }
    info.set(n, { rec });
    alive.push(n);
  }
  // dependencies: a dependency that is excluded (or not verified live) blocks; cycles are found among the survivors
  const edges = new Map();
  for (const n of alive) {
    edges.set(n, depsOf(byNum.get(n)).filter((d) => byNum.has(d)));
  }
  let live = new Set(alive);
  for (const comp of sccs(alive, new Map([...edges].map(([k, v]) => [k, v.filter((d) => live.has(d))])))) {
    if (comp.length > 1) comp.sort((a, b) => a - b).forEach((n) => { exclude(n, "dependency_cycle", `cycle ${comp.map((x) => `#${x}`).join(" -> ")}`); live.delete(n); });
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const n of [...live]) {
      const bad = depsOf(byNum.get(n)).filter((d) => (byNum.has(d) && !live.has(d)) || (!byNum.has(d) && verifiedLive && !verifiedLive(d)));
      if (bad.length) { exclude(n, "dependency_open", `depends on ${bad.map((d) => `#${d}`).join(", ")} (unresolved, not verified live nor in an earlier wave)`); live.delete(n); changed = true; }
    }
  }
  // topological order: dependency first, then severity, then age
  const sev = (n) => SEV[info.get(n).rec.severity ?? priorityOf(byNum.get(n))] ?? 3;
  const rank = (a, b) => sev(a) - sev(b) || String(byNum.get(a).createdAt ?? "").localeCompare(String(byNum.get(b).createdAt ?? "")) || a - b;
  const pending = new Map([...live].map((n) => [n, new Set(depsOf(byNum.get(n)).filter((d) => live.has(d)))]));
  const order = [];
  while (pending.size) {
    const ready = [...pending].filter(([, d]) => !d.size).map(([n]) => n).sort(rank);
    const n = ready[0];
    order.push(n); pending.delete(n); for (const d of pending.values()) d.delete(n);
  }
  // lane assignment, first match wins (design 4.5)
  const plan = new Map(), trainMax = policy?.lanes?.train?.train_max_units ?? 3, unitsMax = policy?.lanes?.train?.units_max ?? trainMax;
  for (const n of order) {
    const { rec } = info.get(n), files = Array.isArray(rec.files) ? rec.files : [];
    const rs = files.length ? rollSet(policy, files) : { ...rollSet(policy, []), units: [...(rec.units ?? [])].sort() };
    const facts = files.length ? deriveFacts(policy, files, { diffLines: Number(rec.diff_lines) || 0 }) : null;
    const risk = facts ? riskOf(policy, facts).risk : (rec.risk ?? "low");
    const migrations = facts ? facts.migrations : (rec.migrations ?? "none");
    const e = { number: n, lane: "release", reason: "", risk, units: rs.units, pipeline: rs.pipeline, severity: rec.severity ?? priorityOf(byNum.get(n)) ?? "P3" };
    if (rs.contract.atomic) e.atomic = { order: rs.contract.order, additive_only: rs.contract.additive_only };
    if (Object.keys(rs.hosts).length) e.hosts = rs.hosts;
    const forced = forces[n];
    const bug = rec.type === "bug";
    if (forced && forced.force !== "exclude") { e.lane = forced.force; e.reason = `lane --force ${forced.force} by ${forced.actor} until ${forced.until}`; e.forced = true; }
    else if (bug && e.severity === "P0") { exclude(n, "p0", "call p0"); continue; }
    else if (bug) {
      const why = [];
      if (rec.exists_in !== "live") why.push(rec.exists_in === "staging-only" ? "staging-only" : `exists_in=${rec.exists_in ?? "unknown"}`);
      if (migrations !== "none") why.push(`migrations=${migrations}`);
      if (rs.contract.atomic || rec.contract_changed) why.push("contract change");
      if (rs.units.length > unitsMax) why.push(`rolled set ${rs.units.length} > units_max ${unitsMax}`);
      if (risk === "high") why.push("risk high");
      e.lane = why.length ? "release" : "train"; e.reason = why.length ? why.join("; ") : "bug live, no migrations, no contract change, small rolled set";
    } else if (rec.type === "docs" && !rs.units.length) { e.reason = "docs-only"; e.docs_only = true; }
    else e.reason = `${rec.type ?? "unknown"} rolls with the release wave`;
    if (rs.contract.release_only && e.lane === "train") { e.lane = "release"; e.reason = "contract change is not additive-only"; }
    const late = depsOf(byNum.get(n)).find((d) => plan.get(d)?.lane === "release");
    if (e.lane === "train" && late !== undefined) { e.lane = "release"; e.reason = `depends on #${late} (release wave)`; }
    plan.set(n, e);
  }
  // waves: train waves (overflow opens the next), then the release wave
  const waves = [], trainIds = order.filter((n) => plan.get(n)?.lane === "train");
  const maxIssues = policy?.lanes?.train?.train_max_issues ?? 15;
  let cur = null;
  for (const n of trainIds) {
    const u = plan.get(n).units;
    const merged = cur ? new Set([...cur.units, ...u]) : null;
    if (!cur || cur.issues.length >= maxIssues || merged.size > trainMax) { cur = { lane: "train", issues: [], units: [] }; waves.push(cur); }
    cur.issues.push(n); cur.units = [...new Set([...cur.units, ...u])].sort();
  }
  const rel = order.filter((n) => plan.get(n)?.lane === "release");
  if (rel.length) waves.push({ lane: "release", issues: rel, units: [...new Set(rel.flatMap((n) => plan.get(n).units))].sort() });
  const cap = policy?.plan?.max_issues ?? 60;
  let left = cap;
  for (const w of waves) {
    const keep = w.issues.slice(0, Math.max(0, left)); left -= keep.length;
    for (const n of w.issues.slice(keep.length)) { exclude(n, "max_issues", `plan.max_issues ${cap} reached`); plan.delete(n); }
    w.issues = keep; w.units = [...new Set(keep.flatMap((n) => plan.get(n).units))].sort();
  }
  const kept = waves.filter((w) => w.issues.length);
  let t = 0;
  kept.forEach((w) => { w.id = w.lane === "train" ? `train-${++t}` : "release"; });
  return {
    schema: PLAN_SCHEMA, plan_hash: sha(stableJson(hashed)), policy_sha: policySha ?? null, live_sha: liveSha ?? null, snapshot,
    waves: kept, issues: Object.fromEntries([...plan].sort((a, b) => a[0] - b[0]).map(([n, e]) => [n, e])),
    excluded: [...excluded.values()].sort((a, b) => a.number - b.number), lane_forces: forces,
  };
}

/** The approval state of `plan` from typed decision comments (`{author, body}`): only an actor in `trust.actors` counts (none trusted = nobody). */
export function approvalOf(plan, decisions, policy) {
  const trusted = policy?.trust?.actors ?? [], ignored = [];
  let stale = false, by = null;
  for (const d of decisions ?? []) {
    const m = DECISION_RE.exec(String(d?.body ?? ""));
    if (!m) continue;
    if (!trusted.includes(d.author)) { ignored.push(d.author ?? "unknown"); continue; }
    if (m[1].toLowerCase() === plan.plan_hash) by = d.author; else stale = true;
  }
  return { state: by ? "approved" : stale ? "stale" : "none", by, ignored };
}

/** Minutes forecast per wave from the trailing median of the lane's history, and the `budget.on_exceed` action. Not part of the hash. */
export function forecastPlan(plan, history, { remaining = null, cfg = parseBudgetConfig(null) } = {}) {
  const per = plan.waves.map((w) => ({ wave: w.id, minutes: trailingMedian(history ?? [], w.lane) }));
  const known = per.filter((p) => p.minutes != null);
  const forecast = known.length ? known.reduce((s, p) => s + p.minutes, 0) : null;
  return { per_wave: per, forecast, remaining, ...applyOnExceed({ lane: "release", forecast, remaining, cfg }) };
}

export function renderReleasePlan(plan, { approval, forecast, lane = "auto" } = {}) {
  const out = [`release plan ${plan.plan_hash.slice(0, 12)}  policy ${String(plan.policy_sha ?? "none").slice(0, 7)}  live ${String(plan.live_sha ?? "unknown").slice(0, 7)}`];
  for (const w of plan.waves.filter((x) => lane === "auto" || x.lane === lane)) {
    out.push(`wave ${w.id} (${w.issues.length} issue(s); units ${w.units.join(",") || "none"})`);
    for (const n of w.issues) { const e = plan.issues[n]; out.push(`  #${n} ${e.lane} risk=${e.risk} ${e.reason}`); }
  }
  for (const x of plan.excluded.filter((e) => lane === "auto" || (lane === "p0" && e.key === "p0"))) out.push(`${x.key === "p0" ? "call p0" : "excluded"}: #${x.number} [${x.key}] ${x.detail}`);
  if (forecast) out.push(`forecast: ${forecast.forecast ?? "unknown"} min (${forecast.action}: ${forecast.why})`);
  if (approval) out.push(`approval: ${approval.state}${approval.by ? ` by ${approval.by}` : ""}${approval.ignored.length ? ` (ignored untrusted: ${approval.ignored.join(", ")})` : ""}`);
  return out;
}

const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/**
 * `forgedock release plan [--lane auto|train|release|p0] [--milestone <slug>] [--issues N,N] [--repo R] [--json]`. Read-only (gh issue list, the live-release command);
 * only with `managed` the plan record is committed to a `forge-ledger/<id>` branch through the ledger writer. @returns the exit code.
 */
export async function planFromCli(argv, { io, policy, policySha, managed = false, newId, history = [], budget = {}, readLanes, ledger }) {
  const lane = flagOf(argv, "--lane") ?? "auto";
  if (!["auto", "train", "release", "p0"].includes(lane)) throw new Error(`release plan: --lane must be auto|train|release|p0`);
  if (!policy || !policySha) { io.print("release plan: refused: no valid .forge/release.yaml on the default branch (run release check-config)"); return 1; }
  const repo = flagOf(argv, "--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const ms = flagOf(argv, "--milestone"), only = flagOf(argv, "--issues");
  const list = JSON.parse(String(await io.gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", "500", ...(ms ? ["--milestone", ms] : []), "--json", "number,title,body,labels,createdAt,updatedAt,comments"])) || "[]");
  const picked = only ? new Set(only.split(",").map((s) => +s.replace("#", "")).filter(Boolean)) : null;
  const decisions = list.filter((i) => names(i).includes(PLAN_LABEL)).flatMap((i) => (i.comments ?? []).map((c) => ({ author: c.author?.login ?? c.user?.login, body: c.body })));
  const { readTarget } = await import("./release-deploy.mjs");
  const liveSha = (await readTarget(io, policy.deploy?.live_release_command))?.sha ?? null;
  const lanes = (readLanes ? await readLanes() : null) ?? {};
  const plan = buildPlan({ issues: picked ? list.filter((i) => picked.has(i.number) || names(i).includes(PLAN_LABEL)) : list, policy, policySha, liveSha, lanes, now: io.now?.() ?? 0 });
  const approval = approvalOf(plan, decisions, policy);
  const fc = forecastPlan(plan, history, { remaining: budget.remaining ?? null, cfg: budget.cfg });
  if (argv.includes("--json")) io.print(stableJson({ ...plan, approval, forecast: fc }));
  else renderReleasePlan(plan, { approval, forecast: fc, lane }).forEach((l) => io.print(l));
  if (managed && ledger && newId) await ledger({ id: newId, repo, plan, approval });
  return 0;
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `mode: release` of `forgedock issue-watch` (#4767): pool eligible issues, cut a themed release when a threshold is crossed,
 * orchestrate it as one batch and open the deploy PR. Deterministic first: score, triggers, theme rules, the `Depends on`
 * closure and the cap are pure functions; the only judgment is one injected `io.classify` call for issues no `theme_map` rule
 * classifies (counted in `state.llm`). The watch never merges: the deploy PR is only created, promotion stays human-only.
 */
import { milestoneSlug } from "./lane.mjs";

export const PRIORITY_WEIGHT = { P0: 8, P1: 4, P2: 2, P3: 1 };
export const GENERAL_THEME = "general";
const DAY = 86400000;
const labelNames = (i) => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);

/** `P0`..`P3` from a `P1` or `priority:P1` label; null when none. */
export function priorityOf(issue) {
  for (const l of labelNames(issue)) { const m = /^(?:priority[:/ -]?)?(P[0-3])$/i.exec(l); if (m) return m[1].toUpperCase(); }
  return null;
}
/** Priority weight; an unprioritised issue weighs 1 (P3). */
export const weightOf = (issue) => PRIORITY_WEIGHT[priorityOf(issue)] ?? 1;
export const ageDays = (issue, now) => Math.max(0, (now - Date.parse(issue.createdAt)) / DAY);
export const poolScore = (issues) => issues.reduce((s, i) => s + weightOf(i), 0);

/** True when `issue` matches an `immediate` entry: `label:<name>` or `priority:<P0..P3>`. */
export function isImmediate(issue, immediate = []) {
  const names = labelNames(issue).map((l) => l.toLowerCase());
  return immediate.some((r) => { const [k, ...v] = String(r).split(":"), val = v.join(":").trim().toLowerCase(); return k === "label" ? names.includes(val) : k === "priority" ? priorityOf(issue)?.toLowerCase() === val : false; });
}

/** Every trigger that fires for the pool: `[{kind, detail}]` (min_issues, min_score, max_age_days, immediate). */
export function triggers(pool, watch, now) {
  const t = watch.threshold ?? {}, out = [];
  if (!pool.length) return out;
  if (t.min_issues && pool.length >= t.min_issues) out.push({ kind: "min_issues", detail: `${pool.length} >= ${t.min_issues}` });
  const score = poolScore(pool);
  if (t.min_score && score >= t.min_score) out.push({ kind: "min_score", detail: `score ${score} >= ${t.min_score}` });
  const oldest = Math.max(...pool.map((i) => ageDays(i, now)));
  if (t.max_age_days && oldest >= t.max_age_days) out.push({ kind: "max_age_days", detail: `oldest ${oldest.toFixed(1)}d >= ${t.max_age_days}d` });
  const imm = pool.filter((i) => isImmediate(i, watch.immediate));
  if (imm.length) out.push({ kind: "immediate", detail: `#${imm.map((i) => i.number).join(", #")}` });
  return out;
}

// ── themes ──────────────────────────────────────────────────────────────────────────────────────────────────
/** The conventional-commit scope of a title: `feat(security): x` → `security`. */
export const titleScope = (title) => /^\w+\(([^)]+)\)!?:/.exec(String(title ?? ""))?.[1].trim().toLowerCase() ?? null;
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")}$`);
/** Paths an issue names: slash-containing tokens of title and body (backticks, quotes and trailing punctuation stripped). */
export const pathsNamed = (issue) => [...new Set(`${issue.title ?? ""}\n${issue.body ?? ""}`.replace(/<!--[\s\S]*?-->/g, "").split(/[\s`'"()<>,;]+/).map((t) => t.replace(/^\.\//, "").replace(/[.:]+$/, "")).filter((t) => /^[\w.@-][\w.@*-]*(\/[\w.@*-]+)+\/?$/.test(t) && !/^https?:/.test(t)))];

/** Theme of an issue from `theme_map` rules (`label:`, `path:` glob, `scope:`; the first theme in config order wins), else a title scope equal to a theme name; null when no rule classifies it. */
export function classifyTheme(issue, themeMap = {}) {
  const names = labelNames(issue).map((l) => l.toLowerCase()), scope = titleScope(issue.title), paths = pathsNamed(issue);
  for (const [theme, rules] of Object.entries(themeMap)) {
    for (const r of [].concat(rules)) {
      const [k, ...v] = String(r).split(":"), val = v.join(":").trim();
      if (k === "label" && names.includes(val.toLowerCase())) return { theme, via: r };
      if (k === "scope" && scope === val.toLowerCase()) return { theme, via: r };
      if (k === "path" && paths.some((p) => globRe(val).test(p))) return { theme, via: r };
    }
  }
  const byScope = Object.keys(themeMap).find((t) => t.toLowerCase() === scope);
  return byScope ? { theme: byScope, via: `scope:${scope}` } : null;
}

/**
 * Classify the pool: rules first, then one `io.classify(issues, themes) → {number: theme}` call for the rest (counted).
 * `cache` (state.themes) keeps earlier answers so a rolled-over issue costs no second call. Returns `{themes: {n: {theme, via}}, llm}`.
 */
export async function classifyPool(pool, watch, { classify, cache = {} } = {}) {
  const themes = {}, rest = [];
  for (const i of pool) {
    const c = classifyTheme(i, watch.theme_map);
    if (c) themes[i.number] = c; else if (cache[i.number]) themes[i.number] = cache[i.number]; else rest.push(i);
  }
  let llm = 0;
  if (rest.length) {
    let ans = null;
    if (classify) { try { ans = await classify(rest, Object.keys(watch.theme_map ?? {})); llm = rest.length; } catch { ans = null; } }
    for (const i of rest) { const t = ans?.[i.number]; themes[i.number] = Object.hasOwn(watch.theme_map ?? {}, t) ? { theme: t, via: "llm" } : { theme: GENERAL_THEME, via: ans ? "llm" : "unclassified" }; }
  }
  return { themes, llm };
}

/** The ordered `Release priorities:` list of a NORTHSTAR text (inline `a, b` or following `- a` bullets), lower-cased; [] when absent. */
export function releasePriorities(text) {
  const lines = String(text ?? "").split(/\r?\n/), at = lines.findIndex((l) => /^\s*(?:[-*]\s*)?\**release priorities\**:/i.test(l));
  if (at < 0) return [];
  const inline = lines[at].replace(/^[^:]*:\**/, "").trim();
  if (inline) return inline.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const l of lines.slice(at + 1)) { const m = /^\s*(?:[-*]|\d+\.)\s+`?([\w./-]+)`?/.exec(l); if (!m) break; out.push(m[1].toLowerCase()); }
  return out;
}

/** Theme scores, best first: Σ priority weight + age (0.1/day, max 3 per issue) + a NORTHSTAR rank bonus; ties by priorities order then name. */
export function scoreThemes(pool, themes, now, priorities = []) {
  const by = {};
  for (const i of pool) (by[themes[i.number].theme] ??= []).push(i);
  return Object.entries(by).map(([theme, issues]) => {
    const idx = priorities.indexOf(theme.toLowerCase());
    const score = Math.round(poolScore(issues) + issues.reduce((s, i) => s + Math.min(3, ageDays(i, now) * 0.1), 0) + (idx >= 0 ? priorities.length - idx : 0));
    return { theme, count: issues.length, score, rank: idx >= 0 ? idx : Infinity };
  }).sort((a, b) => b.score - a.score || a.rank - b.rank || a.theme.localeCompare(b.theme));
}

// ── the release set ─────────────────────────────────────────────────────────────────────────────────────────
const depsOf = (i) => [...String(i.body ?? "").matchAll(/^\s*(?:[-*]\s*)?\**depends on\**:?\s*(.+)$/gim)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => +x[1])).filter((n) => n !== i.number);

/** `issue` plus every open prerequisite, transitively (`openByNum`: all open issues); closed or unknown prerequisites are not part of it. */
export function closure(issue, openByNum) {
  const out = new Map();
  const visit = (i) => { if (out.has(i.number)) return; out.set(i.number, i); for (const d of depsOf(i)) if (openByNum.has(d)) visit(openByNum.get(d)); };
  visit(issue);
  return [...out.values()];
}

/**
 * The release of `theme`: its issues (immediate first, then priority, then age) each with its `Depends on` closure, in order, while
 * the set fits `max`; an issue whose closure does not fit stays out (rolls over). Prerequisites from another theme are marked `pulled`.
 * Returns `{set: [issue], pulled: [{number, theme, for}], excluded: [{number, reason}]}`.
 */
export function pickRelease(theme, pool, themes, openByNum, watch, now) {
  const max = watch.max_release_issues ?? 40;
  const mine = pool.filter((i) => themes[i.number].theme === theme)
    .sort((a, b) => (isImmediate(b, watch.immediate) - isImmediate(a, watch.immediate)) || weightOf(b) - weightOf(a) || ageDays(b, now) - ageDays(a, now) || a.number - b.number);
  const set = new Map(), pulled = [], excluded = [];
  for (const i of mine) {
    if (set.has(i.number)) continue;
    const add = closure(i, openByNum).filter((x) => !set.has(x.number));
    if (set.size + add.length > max) { excluded.push({ number: i.number, reason: `release cap ${max}` }); continue; }
    for (const x of add) { set.set(x.number, x); if (themes[x.number]?.theme !== theme && !mine.includes(x)) pulled.push({ number: x.number, theme: themes[x.number]?.theme ?? classifyTheme(x, watch.theme_map)?.theme ?? "outside pool", for: i.number }); }
  }
  for (const i of pool) if (!set.has(i.number) && !excluded.some((e) => e.number === i.number)) excluded.push({ number: i.number, reason: themes[i.number].theme === theme ? "release cap" : `theme ${themes[i.number].theme}` });
  return { set: [...set.values()], pulled, excluded };
}

/**
 * The decision for a pool: `{fired, ranking, theme, release, forced, below}`. `release` is null (nothing cut) when no trigger fires.
 * An immediate trigger forces the theme of its highest-priority issue and ships only that theme (plus its prerequisites).
 */
export function decideRelease({ pool, openByNum, themes, watch, now, priorities = [] }) {
  const fired = triggers(pool, watch, now), ranking = pool.length ? scoreThemes(pool, themes, now, priorities) : [];
  const below = ranking.filter((r) => r.count < (watch.threshold?.min_issues ?? Infinity)).map((r) => `${r.theme} pool ${r.count} < threshold`);
  if (!fired.length) return { fired, ranking, theme: null, release: null, forced: false, below };
  const imm = pool.filter((i) => isImmediate(i, watch.immediate)).sort((a, b) => weightOf(b) - weightOf(a) || a.number - b.number);
  const forced = imm.length > 0, theme = forced ? themes[imm[0].number].theme : ranking[0].theme;
  return { fired, ranking, theme, release: pickRelease(theme, pool, themes, openByNum, watch, now), forced, below: below.filter((b) => !b.startsWith(`${theme} `)) };
}

/** `would cut: stealth (14 issues, score 46; security pool 1 < threshold)` plus triggers and per-issue theme lines. */
export function formatDryRun(d, pool, themes) {
  const lines = [];
  if (!d.release) lines.push(`would not cut: ${pool.length} pooled, no trigger fired`);
  else {
    const sc = d.ranking.find((r) => r.theme === d.theme)?.score;
    lines.push(`would cut: ${d.theme} (${d.release.set.length} issues, score ${sc}${d.below.length ? `; ${d.below.join("; ")}` : ""})`);
    lines.push(`  triggers: ${d.fired.map((f) => `${f.kind} (${f.detail})`).join(", ")}${d.forced ? " [immediate: theme forced]" : ""}`);
    lines.push(`  set: ${d.release.set.map((i) => `#${i.number}`).join(" ")}`);
    if (d.release.pulled.length) lines.push(`  pulled prerequisites: ${d.release.pulled.map((p) => `#${p.number} (${p.theme}, for #${p.for})`).join(", ")}`);
  }
  lines.push("  theme scores: " + (d.ranking.map((r) => `${r.theme}=${r.score} (${r.count})`).join(", ") || "(empty pool)"));
  for (const i of pool) lines.push(`  #${i.number} ${themes[i.number].theme} [${themes[i.number].via}]${d.release?.set.some((s) => s.number === i.number) ? "" : " (stays pooled)"}`);
  return lines.join("\n");
}

/** The trusted `FORGE:RELEASE_PLAN` comment: theme, reasons, included and excluded issues, cited policy. */
export function releasePlanComment({ theme, tag, decision, policy, now }) {
  const r = decision.release, data = { v: 1, theme, tag, at: new Date(now).toISOString(), included: r.set.map((i) => i.number), pulled: r.pulled, excluded: r.excluded, triggers: decision.fired, policy: policy ?? null };
  return [`<!-- FORGE:RELEASE_PLAN ${JSON.stringify(data)} -->`, `## Release plan: ${theme} (${tag})`,
    `**Why:** ${decision.fired.map((f) => `${f.kind} (${f.detail})`).join(", ")}${decision.forced ? "; immediate trigger, theme forced" : ""}`,
    `**Policy:** ${policy ?? "none (score, then theme name)"}`,
    `**Included:** ${r.set.map((i) => `#${i.number}`).join(" ")}`,
    ...(r.pulled.length ? [`**Pulled prerequisites:** ${r.pulled.map((p) => `#${p.number} (${p.theme}, for #${p.for})`).join(", ")}`] : []),
    `**Excluded (stay pooled):** ${r.excluded.map((e) => `#${e.number} (${e.reason})`).join(", ") || "none"}`,
    "Promotion to the default branch stays human-only; the watch opens the deploy PR and never merges it."].join("\n");
}

// ── the tick ─────────────────────────────────────────────────────────────────────────────────────────────────
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One release-mode pass. Settles the active release (opens the deploy PR once its batch reports), else pools, decides and cuts.
 * `listOpen()→[issue]` all open issues, `eligible(issue)` selector + trust + unclaimed, `claim(n)→bool` repo-wide claim,
 * `laneFor(issue)`, `dagOrder(issues)`, `policy {path,text}`. `dryRun` writes nothing and returns `{state, decision, pool, themes}`.
 */
export async function releaseTick({ watch, repo, io, state, defaults = [], listOpen, eligible, claim, laneFor, dagOrder, policy = {}, dryRun = false }) {
  const now = io.now(), gh = async (a) => String(await io.gh(a));
  state.started ??= now;
  const rel = state.release;
  if (rel && !dryRun) {
    for (const n of [...state.inflight]) if (JSON.parse(await gh(["issue", "view", String(n), "-R", repo, "--json", "state"])).state === "CLOSED") { state.inflight = state.inflight.filter((x) => x !== n); state.merged.push(n); state.verified.push(n); }
    if (!io.batch.reported(rel.batch)) return state;
    state.inflight.forEach((n) => state.failed.push(n)); state.inflight = [];
    if (!rel.deployPr) {
      const base = defaults[0];
      if (!base) throw new Error("no default branch known; cannot open the deploy PR");
      const open = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", rel.lane, "--base", base, "--state", "open", "--json", "number"]));
      rel.deployPr = open[0]?.number ?? (+(/(\d+)\s*$/.exec(await gh(["pr", "create", "-R", repo, "--base", base, "--head", rel.lane, "--title", `release(${rel.theme}): ${rel.tag}`,
        "--body", `Themed release **${rel.theme}** (${rel.tag}).\n\nIssues: ${rel.issues.map((n) => `#${n}`).join(" ")}\nMerged: ${state.merged.filter((n) => rel.issues.includes(n)).map((n) => `#${n}`).join(" ") || "none"}\nFailed: ${state.failed.filter((n) => rel.issues.includes(n)).map((n) => `#${n}`).join(" ") || "none"}\n\nPromotion is human-only: the issue watch opened this PR and never merges it.`]))?.[1]) || true);
    }
    (state.releases ??= []).push(rel); state.release = null;
  }
  if (state.release && dryRun) return { state, decision: null, pool: [], themes: {} };
  const capped = (watch.max_issues && state.claimed.length >= watch.max_issues) || (watch.until && now >= Date.parse(watch.until));
  if (capped && !dryRun) { state.phase = "done"; return state; }

  const open = await listOpen(), openByNum = new Map(open.map((i) => [i.number, i]));
  const pool = open.filter(eligible).sort((a, b) => a.number - b.number);
  const { themes, llm } = await classifyPool(pool, watch, { classify: io.classify, cache: state.themes });
  const decision = decideRelease({ pool, openByNum, themes, watch, now, priorities: releasePriorities(policy.text) });
  if (dryRun) return { state, decision, pool, themes };
  state.llm = (state.llm ?? 0) + llm;
  state.themes = { ...(state.themes ?? {}), ...Object.fromEntries(Object.entries(themes).filter(([, v]) => v.via === "llm").map(([n, v]) => [n, v])) };
  state.pool = pool.map((i) => i.number);
  if (!decision.release?.set.length) return state;

  const taken = [];
  for (const i of dagOrder(decision.release.set)) { if (watch.max_issues && state.claimed.length + taken.length >= watch.max_issues) break; if (claim(i.number)) taken.push(i); }
  if (!taken.length) return state;
  const lane = taken.map((i) => laneFor(i))[0], tag = `${milestoneSlug(decision.theme) || decision.theme}-${isoDate(now)}`, nums = taken.map((i) => i.number);
  const plan = releasePlanComment({ theme: decision.theme, tag, decision: { ...decision, release: { ...decision.release, set: taken } }, policy: policy.path, now });
  const tracker = watch.tracker ?? nums[0];
  await gh(["issue", "comment", String(tracker), "-R", repo, "--body", plan]);
  if (watch.milestone && watch.milestone !== "none") {
    const title = `release/${tag}`;
    await gh(["api", `repos/${repo}/milestones`, "-f", `title=${title}`]);
    for (const n of nums) await gh(["issue", "edit", String(n), "-R", repo, "--milestone", title]);
  } else {
    const label = `release:${tag}`;
    await gh(["label", "create", label, "-R", repo, "--force"]);
    for (const n of nums) await gh(["issue", "edit", String(n), "-R", repo, "--add-label", label]);
  }
  for (const i of taken) { state.claimed.push(i.number); state.inflight.push(i.number); state.lanes[i.number] = lane; }
  const batch = await io.batch.start(nums, watch.parallel, lane);
  state.release = { theme: decision.theme, tag, lane, batch, issues: nums, tracker, at: now, deployPr: null };
  return state;
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Flake policy for managed releases (#5568, epic #5549 5.5, I15/I20/I29, R2). Pure functions plus `gh`-injected reads; no model call.
 * Flips and infra signatures go to `flakes.json` (on `_active`); an infra flake is rerun once per job inside `ci.rerun_budget_min`;
 * a repeated flake files one `flake` issue, and only then may a test be quarantined (expiring, capped, never an unskippable class).
 */
import { createHash } from "node:crypto";
import { readActive, updateActive } from "./release-ledger.mjs";

export const FLAKE_LABEL = "flake";
export const FLAKE_MARKER = "FORGE:FLAKE";
export const UNSKIPPABLE_CLASSES = ["migration", "security", "rollback", "backup-restore", "secrets"];
const DAY_MS = 86_400_000;
const json = (s) => { try { return JSON.parse(String(s)); } catch { return null; } };
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** Known infra signatures (artifact upload outage, runner cancel, Postgres init race, apt/network). */
export const INFRA_SIGNATURES = [
  ["artifact-upload", /artifact.*(upload|storage)|upload-artifact|unable to upload/i],
  ["runner-cancel", /runner.*(lost communication|shutdown|received a shutdown signal)|operation was canceled|the job was canceled/i],
  ["postgres-init", /pg_isready|database system is starting up|connection refused.*5432|postgres.*(not ready|init)/i],
  ["network", /ETIMEDOUT|ECONNRESET|EAI_AGAIN|apt-get.*(failed|unable)|temporary failure in name resolution|could not resolve host|502 bad gateway|503 service unavailable/i],
];

/** forge.yaml policy -> {rerunBudgetMin, quarantineAfter, windowDays, quarantineDays, quarantineMax, unskippable}. */
export function parseFlakeConfig(policy) {
  const ci = policy?.ci ?? {}, f = ci.flake ?? {}, q = policy?.quarantine ?? {};
  return {
    rerunBudgetMin: num(ci.rerun_budget_min, 0), quarantineAfter: num(f.quarantine_after, 3), windowDays: num(f.window_days, 14),
    quarantineDays: num(q.days, 14), quarantineMax: num(q.max, 15), unskippable: [...UNSKIPPABLE_CLASSES, ...(Array.isArray(ci.unskippable) ? ci.unskippable : [])],
  };
}

/** True when `check` is, or is under (`class:x`, `class/x`), an unskippable class; the one matcher for exempt and quarantine. */
export const isUnskippable = (check, classes = UNSKIPPABLE_CLASSES) => classes.some((c) => check === c || check.startsWith(`${c}:`) || check.startsWith(`${c}/`));

/** @returns {{class: "infra"|"unknown", signature: string|null}} from failure text (log tail or annotations). */
export function classifyFailure(text) {
  const hit = INFRA_SIGNATURES.find(([, re]) => re.test(String(text ?? "")));
  return hit ? { class: "infra", signature: hit[0] } : { class: "unknown", signature: null };
}
export const signatureHash = (check, test, signature) => createHash("sha256").update([check, test ?? "", signature ?? ""].join("\0")).digest("hex").slice(0, 16);

/** Same-SHA flips in `runs` [{sha, check, test?, conclusion, id, at}]: a check that failed and then passed on one sha. */
export function detectSameShaFlip(runs) {
  const by = new Map();
  for (const r of [...runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const k = `${r.sha}\0${r.check}\0${r.test ?? ""}`, g = by.get(k) ?? { fail: [], flipped: false, r };
    if (r.conclusion === "failure") g.fail.push(r); else if (r.conclusion === "success" && g.fail.length) g.flipped = true;
    g.runs = [...(g.runs ?? []), r.id]; by.set(k, g);
  }
  return [...by.values()].filter((g) => g.flipped).map((g) => ({ check: g.r.check, test: g.r.test ?? null, sha: g.r.sha, run_ids: g.runs }));
}

/** One `flakes.json` entry. */
export const flakeEntry = ({ check, test = null, signature = null, kind, sha = null, runIds = [], at, rerun = false }) =>
  ({ check, test, signature, signature_hash: signatureHash(check, test, signature), kind, sha, run_ids: runIds, at, ...(rerun ? { rerun: true } : {}) });

/** Append entries to `flakes.json` and the `_active` `flakes` key in one commit. */
export async function recordFlakes(lctx, entries, now = Date.now()) {
  if (!entries.length) return { ok: true, recorded: 0 };
  const r = await updateActive(lctx, ["flakes"], (a) => {
    const flakes = [...(a.flakes ?? []), ...entries];
    return { patch: { flakes }, files: { "flakes.json": `${JSON.stringify({ updated: new Date(now).toISOString(), flakes }, null, 2)}\n` } };
  });
  return r.ok ? { ok: true, recorded: entries.length } : { ok: false, error: r.refused ?? "lost the race recording flakes" };
}

/**
 * Which failed jobs to `rerun --failed`: infra class only, once per job (`done` = keys of jobs already rerun), and only while the
 * minutes already spent stay inside `ci.rerun_budget_min`. Every job gets a decision, so a skipped rerun is never silent.
 * @param {{jobs: {key, name, class, minutes?}[], done?: Set|string[], spentMin?: number, budgetMin: number}} p
 */
export function planRerun({ jobs, done = [], spentMin = 0, budgetMin }) {
  const seen = new Set(done);
  let spent = spentMin;
  return jobs.map((j) => {
    if (j.class !== "infra") return { ...j, rerun: false, why: "not an infra flake" };
    if (seen.has(j.key)) return { ...j, rerun: false, why: "already rerun once" };
    const cost = j.minutes ?? 0;
    if (!(budgetMin > 0) || spent + cost > budgetMin) return { ...j, rerun: false, why: `ci.rerun_budget_min ${budgetMin} exhausted (${spent} spent)` };
    spent += cost; seen.add(j.key);
    return { ...j, rerun: true, why: "infra flake, first rerun" };
  });
}

const targetOf = (f) => f.test ? `${f.check}:${f.test}` : f.check;

/** Targets with >= quarantine_after flips inside window_days: [{target, check, test, count, evidence}]. Infra reruns do not count as flips. */
export function repeatedFlakes(flakes, cfg, now = Date.now()) {
  const groups = new Map();
  for (const f of flakes ?? []) {
    if (f.kind !== "flip" && f.kind !== "test") continue;
    if (now - Date.parse(f.at) > cfg.windowDays * DAY_MS) continue;
    const g = groups.get(targetOf(f)) ?? { target: targetOf(f), check: f.check, test: f.test ?? null, count: 0, evidence: [] };
    g.count++; g.evidence.push(...(f.run_ids ?? [])); groups.set(g.target, g);
  }
  return [...groups.values()].filter((g) => g.count >= cfg.quarantineAfter);
}

const markerFor = (target) => `<!-- ${FLAKE_MARKER} target=${target} -->`;

/** The open `flake` issue of `target`, else a new one (label `flake`, evidence). @returns {{issue, created}|null} null for an unskippable target. */
export async function fileFlakeIssue({ gh, repo, target, evidence = [], count = 0, owner = null, cfg }) {
  if (isUnskippable(target, cfg?.unskippable)) return null;
  const mark = markerFor(target);
  const open = json(await gh(["issue", "list", "--repo", repo, "--label", FLAKE_LABEL, "--state", "open", "--json", "number,body", "--limit", "100"])) ?? [];
  const found = open.find((i) => String(i.body ?? "").includes(mark));
  if (found) return { issue: found.number, created: false };
  const body = `${mark}\nRepeated flake: \`${target}\` flipped ${count} time(s) inside the window.${owner ? `\nOwner: ${owner}` : ""}\nRuns: ${evidence.join(", ") || "none"}\n`;
  const url = String(await gh(["issue", "create", "--repo", repo, "--label", FLAKE_LABEL, "--title", `flake: ${target} is flaky`, "--body", body])).trim();
  return { issue: Number(/(\d+)$/.exec(url)?.[1]) || null, created: true };
}

/** An exemption is live until `until`; a quarantine also lapses `quarantine.days` after it was recorded (fail closed: blocking again). */
export function isLive(e, cfg, now = Date.now()) {
  if (!e || !(Date.parse(e.until) > now)) return false;
  return e.mode !== "quarantine" || now - Date.parse(e.at) <= cfg.quarantineDays * DAY_MS;
}
export const activeQuarantines = (exemptions, cfg, now = Date.now()) => Object.entries(exemptions ?? {}).filter(([, e]) => e?.mode === "quarantine" && isLive(e, cfg, now)).map(([k]) => k);

/**
 * May `target` be quarantined? Refused for an unskippable class, without an existing open `flake` issue, or at the cap.
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function canQuarantine({ target, exemptions, issueLabels = [], issueOpen = true, cfg, now = Date.now() }) {
  if (isUnskippable(target, cfg.unskippable)) return { ok: false, why: `${target} is an unskippable class and can never be quarantined` };
  if (!issueOpen || !issueLabels.includes(FLAKE_LABEL)) return { ok: false, why: `quarantine needs an open issue labelled ${FLAKE_LABEL} (file it first)` };
  const live = activeQuarantines(exemptions, cfg, now);
  if (live.length >= cfg.quarantineMax && !live.includes(target)) return { ok: false, why: `quarantine cap ${cfg.quarantineMax} reached` };
  return { ok: true };
}

/** I29: a run that needed an in-runner retry or a rerun (a `FLAKE:` annotation) never writes a cache marker. */
export const shouldWriteMarker = ({ retried = false, flakeAnnotated = false, rerun = false, passed = true } = {}) => passed && !retried && !flakeAnnotated && !rerun;

/** Live flakes ledger from `_active` (empty when unreadable). */
export async function readFlakes(lctx) { try { return (await readActive(lctx)).flakes ?? []; } catch { return []; } }

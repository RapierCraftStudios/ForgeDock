// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Nightly results for managed releases (#5569, epic #5549 5.6): read the latest nightly run on the integration branch
 * (T0-T2 daily, T3-T4 weekly), file or refresh one `nightly-red` issue, and decide whether a red blocks a release.
 * Only `lane: release` is ever blocked, and only by T0-T2 reds or unskippable classes; T3/T4, train and p0 never.
 * Pure functions plus `gh`-injected reads; no model call. forge.yaml `nightly:` block, used only when `release.managed`.
 */
export const NIGHTLY_LABEL = "nightly-red";
const json = (s) => { try { return JSON.parse(String(s)); } catch { return null; } };
const off = (v) => ["false", "off", "no", "0"].includes(String(v ?? "").trim().toLowerCase());
const list = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const hours = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** forge.yaml `nightly:` -> null when unset, else {branch, workflow, blockRelease, t0t2Hours, t3t4Hours, unskippable, t3, t4}. */
export function parseNightlyConfig(sec) {
  if (!sec || typeof sec !== "object" || (!sec.workflow && !sec.branch)) return null;
  return {
    branch: String(sec.branch || "staging"), workflow: String(sec.workflow || "nightly.yml"),
    blockRelease: !off(sec.block_release ?? "true"),
    t0t2Hours: hours(sec.t0_t2_hours, 24), t3t4Hours: hours(sec.t3_t4_hours, 168),
    unskippable: list(sec.unskippable), t3: list(sec.t3_jobs), t4: list(sec.t4_jobs),
  };
}

/** Tier 0-4 of a job: a leading `T<n>`, else a configured t3_jobs/t4_jobs substring, else T2 (unclassified counts as blocking-eligible). */
export function classifyTier(name, cfg = {}) {
  const n = String(name ?? "").toLowerCase();
  const m = /^t([0-4])\b/.exec(n);
  if (m) return Number(m[1]);
  if ((cfg.t4 ?? []).some((p) => n.includes(p))) return 4;
  if ((cfg.t3 ?? []).some((p) => n.includes(p))) return 3;
  return 2;
}

const RED = new Set(["failure", "timed_out", "startup_failure"]);
const ageH = (iso, now) => (now - Date.parse(iso)) / 3_600_000;

/**
 * Latest completed nightly runs -> {run, stale, reds:[{name, tier, run}]}. T0-T2 reds come from the newest run (stale when older than
 * 2x t0_t2_hours); T3-T4 reds from the newest run inside t3_t4_hours that has a T3/T4 job. null when the runs are unreadable.
 */
export async function readNightly({ gh, repo, cfg, now = Date.now() }) {
  const runs = json(await gh(["api", `repos/${repo}/actions/workflows/${cfg.workflow}/runs?branch=${encodeURIComponent(cfg.branch)}&status=completed&per_page=20`]))?.workflow_runs;
  if (!Array.isArray(runs)) return null;
  if (!runs.length) return { run: null, stale: true, reds: [] };
  const jobsOf = async (r) => json(await gh(["api", `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`]))?.jobs ?? [];
  const reds = [];
  const first = runs[0];
  for (const j of await jobsOf(first)) if (classifyTier(j.name, cfg) <= 2 && RED.has(j.conclusion)) reds.push({ name: j.name, tier: classifyTier(j.name, cfg), run: first.id });
  for (const r of runs) {
    if (ageH(r.created_at, now) > cfg.t3t4Hours) break;
    const high = (await jobsOf(r)).filter((j) => classifyTier(j.name, cfg) >= 3);
    if (!high.length) continue;
    for (const j of high) if (RED.has(j.conclusion)) reds.push({ name: j.name, tier: classifyTier(j.name, cfg), run: r.id });
    break;
  }
  return { run: first.id, stale: ageH(first.created_at, now) > cfg.t0t2Hours * 2, reds };
}

/** The reds that stop `lane`: only `release` is ever blocked, by T0-T2 reds or a job matching `unskippable` (never when block_release is off). */
export function blocksRelease({ lane = "release", reds = [], cfg }) {
  if (lane !== "release" || !cfg?.blockRelease) return [];
  return reds.filter((r) => r.tier <= 2 || cfg.unskippable.some((p) => r.name.toLowerCase().includes(p)));
}

/** One open `nightly-red` issue: created on the first red, its body edited afterwards. @returns {{issue, created}|null} null when nothing is red. */
export async function fileNightlyRed({ gh, repo, reds, run }) {
  if (!reds.length) return null;
  const body = `<!-- FORGE:NIGHTLY -->\nNightly run ${run ?? "?"} is red:\n${reds.map((r) => `- T${r.tier}: ${r.name} (run ${r.run})`).join("\n")}\n`;
  const open = json(await gh(["issue", "list", "--repo", repo, "--label", NIGHTLY_LABEL, "--state", "open", "--json", "number", "--limit", "1"])) ?? [];
  if (open[0]) { await gh(["issue", "edit", String(open[0].number), "--repo", repo, "--body", body]); return { issue: open[0].number, created: false }; }
  const url = String(await gh(["issue", "create", "--repo", repo, "--label", NIGHTLY_LABEL, "--title", `nightly-red: ${reds.length} red job(s) on the integration branch`, "--body", body])).trim();
  return { issue: Number(/(\d+)$/.exec(url)?.[1]) || null, created: true };
}

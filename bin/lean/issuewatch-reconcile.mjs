// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5467: reconcile an issue-watch's claims with the batch result and the issue labels. Each claim is `merged | needs-human(code) |
 * parked(code) | running | stranded`. A final batch result leaves `inflight` at once (a long-lived batch that has not reported must not
 * keep it for hours); a mechanical park (`needs-human` row with a terminal code) gets one budgeted `run-issue --recover` lane, and only
 * when that fails becomes `needs-human` with the reason stated; a needs-human/parked claim a person cleared (label gone, plus a trusted
 * FORGE:DECISION or a newer comment) is released so the next pass re-claims it. `status --stuck` lists the old claims. Gh, the clock and the
 * lane launch are injected; the state callbacks (`fail`, `settle`, `release`) belong to the caller.
 */
import { classifyNeedsHuman, REMEDIATION_QUEUE_LABEL } from "../engine/outcome-codes.mjs";

const HOUR_MS = 3600_000;
const MERGED = new Set(["merged", "done", "complete", "completed", "closed"]);
const NEEDS_HUMAN_LABEL = "needs-human";
export const STUCK_HOURS = 24;

/** `{kind, code}` for one batch result row; `running` when there is no final row. Pure. */
export function classifyClaim(row) {
  if (!row || typeof row !== "object") return { kind: "running", code: null };
  const outcome = String(row.outcome ?? row.terminalReason ?? "");
  if (MERGED.has(outcome)) return { kind: "merged", code: null };
  if (outcome === "needs-human") {
    const code = typeof row.code === "string" && row.code !== "" ? row.code : null;
    // a code a person must settle (HUMAN_CODES) stays needs-human; any other code is a mechanical park the engine's own lanes already gave up on
    return code && classifyNeedsHuman(row) !== "human" && code !== "unclassified" ? { kind: "parked", code } : { kind: "needs-human", code };
  }
  if (outcome === "" || outcome === "pending" || outcome === "running") return { kind: "running", code: null };
  return { kind: "stranded", code: outcome };
}

/**
 * Settle every inflight claim whose batch result is final. `results` is state.json `results` of the watch's batch. Merged claims go to
 * `settle` (verified once closed), the rest to `fail`; `state.outcomes[n]` keeps the classification. @returns {number[]} the issues settled.
 */
export function reconcileClaims({ state, results, now, fail, settle }) {
  state.outcomes ??= {};
  const done = [];
  for (const n of [...state.inflight]) {
    const c = classifyClaim(results?.[n]);
    if (c.kind === "running") continue;
    state.outcomes[n] = { ...c, at: now };
    (c.kind === "merged" ? settle : fail)(n);
    done.push(n);
  }
  return done;
}

const labelsOf = (v) => (v?.labels ?? []).map((l) => String(l?.name ?? l));

/**
 * One remediation lane per parked claim, at most `watch.max_remediations` per watch. A launched lane is polled each pass: exit 0 hands
 * the issue to verification, any other exit makes it `needs-human` with the reason in a comment. A restarted watch re-launches a
 * running lane (run-issue resumes from GitHub) without spending budget again.
 */
export async function remediateStep({ watch, repo, io, state, handles, lanes = {}, now, settle, fail }) {
  if (!io.remediate) return;
  state.remediated ??= {};
  const key = (n) => `remediate:${n}`;
  for (const [n, o] of Object.entries(state.outcomes ?? {})) {
    if (o.kind !== "parked" || state.remediated[n]) continue;
    if (Object.keys(state.remediated).length >= (watch.max_remediations ?? 10)) break;
    state.remediated[n] = { code: o.code, at: now, status: "running" };
    handles.set(key(n), io.remediate(Number(n), state.lanes?.[n] ?? lanes[n], o.code));
  }
  for (const [n, r] of Object.entries(state.remediated)) {
    if (r.status !== "running") continue;
    let h = handles.get(key(n));
    if (!h) { handles.set(key(n), io.remediate(Number(n), state.lanes?.[n] ?? lanes[n], r.code)); continue; }
    const res = h.poll();
    if (!res) continue;
    handles.delete(key(n));
    if (res.code === 0) { r.status = "done"; settle(Number(n)); continue; }
    r.status = "failed";
    const reason = `remediation lane for \`${r.code}\` exited ${res.code}`;
    state.outcomes[n] = { kind: "needs-human", code: r.code, at: now, reason };
    try {
      await io.gh(["issue", "edit", String(n), "-R", repo, "--add-label", NEEDS_HUMAN_LABEL, "--remove-label", REMEDIATION_QUEUE_LABEL]);
      await io.gh(["issue", "comment", String(n), "-R", repo, "--body", `## Needs human\nissue-watch ${watch.name} remediated this parked issue once (${reason}); a person has to take it from here.`]);
    } catch { /* the label/comment retry is the next human pass; the state already records the reason */ }
    fail(Number(n));
  }
}

/**
 * A needs-human/parked claim whose block a person cleared (no `needs-human`/`parked:*` label, a trusted FORGE:DECISION or a comment newer
 * than the outcome) is released through `release(n)` so the next pass selects it again. A claim under remediation is left alone.
 * @returns {number[]} the issues released.
 */
export async function reclaimStep({ repo, io, state, trusted, release }) {
  const out = [];
  for (const [n, o] of Object.entries(state.outcomes ?? {})) {
    if (!["needs-human", "parked"].includes(o.kind) || state.remediated?.[n]?.status === "running") continue;
    let v;
    try { v = JSON.parse(String(await io.gh(["issue", "view", n, "-R", repo, "--json", "state,labels,comments"]))); } catch { continue; }
    if (v.state === "CLOSED" || labelsOf(v).some((l) => l === NEEDS_HUMAN_LABEL || l.startsWith("parked:"))) continue;
    const cleared = (v.comments ?? []).some((c) => trusted(c) && (/FORGE:DECISION/.test(String(c.body ?? "")) || Date.parse(c.createdAt) > o.at));
    if (!cleared) continue;
    release(Number(n));
    delete state.outcomes[n]; delete state.remediated?.[n];
    out.push(Number(n));
  }
  return out;
}

/** Counts of the claims by reconciled kind: `{merged, "needs-human", parked, running, stranded}`. */
export function claimCounts(state) {
  const c = { merged: (state.merged ?? []).length, "needs-human": 0, parked: 0, running: (state.inflight ?? []).length, stranded: 0 };
  for (const o of Object.values(state.outcomes ?? {})) if (o.kind in c && o.kind !== "merged" && o.kind !== "running") c[o.kind]++;
  return c;
}

/** `[{issue, ageHours, why}]` of claims older than `hours` with no merged issue, oldest first. */
export function stuckClaims(state, now, hours = STUCK_HOURS) {
  const merged = new Set([...(state.merged ?? []), ...(state.verified ?? [])]);
  return (state.claimed ?? []).filter((n) => !merged.has(n)).map((n) => {
    const at = state.claimedAt?.[n] ?? state.started ?? now, o = state.outcomes?.[n], r = state.remediated?.[n];
    const why = o ? `${o.kind}${o.code ? ` (${o.code})` : ""}${o.reason ? `: ${o.reason}` : ""}${r ? `; remediation ${r.status}` : ""}` : state.inflight?.includes(n) ? "running in its lane" : "no batch result";
    return { issue: n, ageHours: Math.floor((now - at) / HOUR_MS), why };
  }).filter((r) => r.ageHours >= hours).sort((a, b) => b.ageHours - a.ageHours);
}

export const formatStuck = (rows, hours = STUCK_HOURS) => rows.length ? rows.map((r) => `#${r.issue} claimed ${r.ageHours}h ago, no merged PR: ${r.why}`).join("\n") : `no claims older than ${hours}h without a merged PR`;

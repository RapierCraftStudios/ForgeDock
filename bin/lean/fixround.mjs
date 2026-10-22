// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fresh fix sessions (#4363): which fix rounds run in a new, narrow session (resume: null, lean.fix_model) instead of
 * resuming the builder's whole plan+build transcript, and the caps of that session's prompt. Pure: no I/O.
 * Repo-agnostic: a failure "cites a file:line" when its text names any `path.ext:N`, whatever the language.
 */

/** Fix-round kinds whose failures are mechanical: always a fresh session. */
export const MECHANICAL_KINDS = Object.freeze(["precheck", "ci", "docs", "structure", "enumerating", "sequence"]);

/** The fresh prompt stays under this many characters; the per-part caps leave room for the fixed text. */
export const FIX_PROMPT_MAX = 60000;
export const FIX_CAPS = Object.freeze({ task: 20000, diff: 24000, contract: 8000, summary: 1500 });

const FILE_LINE_RE = /[\w.@/-]+\.[A-Za-z0-9]+:\d+/;

/** True only for a non-empty list whose every failure (a string, or `f.detail`) cites a `path.ext:N`. */
export function citesFileLine(failures) {
  if (!Array.isArray(failures) || !failures.length) return false;
  return failures.every((f) => FILE_LINE_RE.test(typeof f === "string" ? f : String(f?.detail ?? "")));
}

/** A mechanical kind, or a conformance/review FAIL whose failures all cite a file:line. */
export function freshFix(kind, failures = []) {
  if (MECHANICAL_KINDS.includes(kind)) return true;
  return (kind === "conformance" || kind === "review") && citesFileLine(failures);
}

/** `s` cut to `max` characters with a marker naming what was dropped. */
export function capText(s, max) {
  const t = String(s ?? "");
  return t.length <= max ? t : `${t.slice(0, max)}\n[... ${t.length - max} more characters cut]`;
}

/** The issue body without HTML comments (FORGE:STATE and other markers), trimmed and capped. */
export function issueSummary(body, max = FIX_CAPS.summary) {
  const t = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return capText(t, max);
}

/**
 * #4362: why a PHASE_ATTEMPT_USAGE attempt ran (its `trigger`). Every builder, reviewer and grouping call passes one of
 * these; events written before the field existed read as "unknown" in `forgedock stats`.
 */
export const TRIGGERS = Object.freeze(["plan", "build", "block_correction", "contract_correction", "precheck", "structure", "docs", "enumerating",
  "sequence", "ci_unavailable", "ci_red", "conformance", "review", "merge_ci", "timeout_restart", "recovery", "verifier",
  "context_restart"]); // #4390: a session stopped at the context ceiling, restarted fresh (restart_of: the stopped trigger)

/** Builder attempts after the build that mean its diff needed rework (environment and engine repairs do not). */
export const REWORK_TRIGGERS = Object.freeze(["precheck", "structure", "docs", "enumerating", "sequence", "ci_red", "conformance", "review", "merge_ci"]);

/**
 * First pass of one lane from its implement-phase attempts in order ({trigger, restart_of}): null when it never reached the
 * build or an attempt has no trigger (not measurable), else true when no rework-trigger attempt follows the first `build`
 * (or the `timeout_restart`/`context_restart` of a build, `restart_of: "build"`, when the build itself was killed).
 */
export function firstPassOf(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.some((a) => !a?.trigger)) return null;
  const at = list.findIndex((a) => a.trigger === "build" || (["timeout_restart", "context_restart"].includes(a.trigger) && a.restart_of === "build"));
  if (at < 0) return null;
  return !list.slice(at + 1).some((a) => REWORK_TRIGGERS.includes(a.trigger));
}

/** The batch report's first-pass line (rows carry `first_pass`), or null when no lane reached the build. */
export function formatFirstPassSummary(rows) {
  const reached = (rows ?? []).filter((r) => typeof r?.first_pass === "boolean");
  if (!reached.length) return null;
  const k = reached.filter((r) => r.first_pass).length;
  return `first-pass: ${Math.round((k / reached.length) * 100)}% (${k}/${reached.length} lane${reached.length === 1 ? "" : "s"} that reached the build)`;
}

/**
 * #4407: one attempt's cost from the CLI envelope's `total_cost_usd`, which is cumulative over a resumed session.
 * `last` maps a session id to its last reported total (updated in place). A resumed attempt costs its total minus the
 * session's previous total; a fresh call, an unknown session or a total below the previous one counts in full, so the
 * deltas of a session's attempts sum to its final total. A non-finite cost yields nulls and leaves `last` alone.
 */
export function sessionCostDelta(last, { resume = null, sessionId = null, cost = null } = {}) {
  if (!Number.isFinite(cost)) return { delta: null, session: null };
  const prev = resume ? last.get(resume) : undefined;
  const delta = Number.isFinite(prev) && cost >= prev ? Math.round((cost - prev) * 1e9) / 1e9 : cost;
  const key = sessionId ?? resume;
  if (key) last.set(key, cost);
  return { delta, session: cost };
}

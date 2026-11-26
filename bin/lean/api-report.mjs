// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5821: before/after report over PHASE_ATTEMPT_USAGE telemetry rows: fresh CLI sessions per merged issue, cache-write
 * share of input and cost per merged issue, split by route (api|cli rows carry `route`; a row without it is a CLI session).
 * Usage: node bin/lean/api-report.mjs <telemetry.jsonl> <cutoff-iso-ts>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The audit expects 35-45% lower cost per merged issue; measured on real runs, not asserted. */
export const COST_GAIN_TARGET = [0.35, 0.45];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Summary of the rows (issues = distinct issue numbers seen; merged = those with `merged:true` rows or all when none marks it). */
export function summarizeApiRoute(rows) {
  const issues = new Set(rows.map((r) => r.issue).filter((x) => x != null));
  const merged = new Set(rows.filter((r) => r.merged === true).map((r) => r.issue));
  const denom = (merged.size || issues.size) || 1;
  const attempts = rows.filter((r) => r.event === "phase_attempt" || r.event === "PHASE_ATTEMPT_USAGE");
  const cli = attempts.filter((r) => r.route !== "api");
  const fresh = cli.filter((r) => r.baseline_tokens != null || r.baselineTokens != null);
  const write = attempts.reduce((s, r) => s + num(r.cache_creation_tokens ?? r.usage?.cache_creation_input_tokens), 0);
  const input = attempts.reduce((s, r) => s + num(r.input_tokens ?? r.usage?.input_tokens) + num(r.cache_creation_tokens ?? r.usage?.cache_creation_input_tokens) + num(r.cache_read_tokens ?? r.usage?.cache_read_input_tokens), 0);
  const cost = attempts.reduce((s, r) => s + num(r.cost_usd_delta ?? r.cost_usd), 0);
  return { issues: issues.size, fresh_cli_sessions: fresh.length, fresh_cli_sessions_per_issue: fresh.length / denom,
    api_calls: attempts.length - cli.length, cache_write_share: input ? write / input : 0, cost_usd_per_issue: cost / denom };
}

/** Rows split at `cutoff` (ISO timestamp) into before and after summaries. */
export function compare(rows, cutoff) {
  const t = Date.parse(cutoff);
  const before = summarizeApiRoute(rows.filter((r) => Date.parse(r.ts) < t)), after = summarizeApiRoute(rows.filter((r) => Date.parse(r.ts) >= t));
  const gain = before.cost_usd_per_issue > 0 ? 1 - after.cost_usd_per_issue / before.cost_usd_per_issue : null;
  return { before, after, cost_gain: gain, meets_target: gain == null ? null : gain >= COST_GAIN_TARGET[0] };
}

export function formatApiReport(c) {
  const line = (n, s) => `${n}: ${s.issues} issues, ${s.fresh_cli_sessions} fresh CLI sessions (${s.fresh_cli_sessions_per_issue.toFixed(2)}/issue), ${s.api_calls} API calls, cache-write share ${(s.cache_write_share * 100).toFixed(0)}%, $${s.cost_usd_per_issue.toFixed(2)}/issue`;
  const gain = c.cost_gain == null ? "n/a" : `${(c.cost_gain * 100).toFixed(0)}% (target ${COST_GAIN_TARGET[0] * 100}-${COST_GAIN_TARGET[1] * 100}%)`;
  return `${line("before", c.before)}\n${line("after", c.after)}\ncost gain per issue: ${gain}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, cutoff] = process.argv.slice(2);
  if (!file || !cutoff) { console.error("usage: api-report.mjs <telemetry.jsonl> <cutoff-iso-ts>"); process.exit(2); }
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log(formatApiReport(compare(rows, cutoff)));
}

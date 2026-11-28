// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #6206: the admit probe. Before the first builder or plan session a lane asks four cheap deterministic questions, so no builder
 * spend goes to a lane the base or the environment already dooms:
 *   1. base health: the base head's required checks (red on something this issue does not touch -> `base.red`, deferred);
 *   2. environment: the claude login answers (`backend.auth`, deferred);
 *   3. contract dry-run: the frozen validates run once on the base tree (existing runPreflight); Docker-only gaps become
 *      deferred-to-CI with a FORGE:DECISION, other missing tools end `env.tool_missing` before the build;
 *   4. failure fingerprint: an issue parked with fingerprint F on (base head B, input I) is not re-admitted until B or I changed.
 * Every outcome is one typed `ADMIT_PROBE` telemetry event with `builder_spend_usd: 0`. Everything here is pure or takes seams; no LLM.
 */
import { OUTCOME_CODES, ENV_ENGINE_OWNED_CODES } from "../engine/outcome-codes.mjs";
import { baseRedPaths } from "./basered.mjs";
import { computeInputHash, frozenContractHash } from "./attempts.mjs";
import { isResetDecision } from "./failure-stop.mjs";

export const ADMIT_EVENT = "ADMIT_PROBE";
export const ADMIT_MARKER = "FORGE:ADMIT_PROBE";
const RED = new Set(["failure", "timed_out", "startup_failure", "error"]);
const sha12 = (s) => String(s ?? "").trim().slice(0, 12);

/** Failing required checks of the base head. `checks`: [{name, conclusion|state, url, completed_at, summary}] (check runs and commit statuses); latest per name wins. */
export function failingRequired({ checks = [], required = [] } = {}) {
  const want = new Set((required ?? []).map(String));
  if (!want.size) return []; // no known required set: no evidence, fail open
  const latest = new Map();
  for (const c of checks ?? []) {
    const name = String(c?.name ?? "");
    if (!want.has(name)) continue;
    const prev = latest.get(name);
    if (!prev || String(c.completed_at ?? "") >= String(prev.completed_at ?? "")) latest.set(name, c);
  }
  return [...latest.values()].filter((c) => RED.has(String(c.conclusion ?? c.state ?? "").toLowerCase()))
    .map((c) => ({ name: String(c.name), conclusion: String(c.conclusion ?? c.state), url: c.url ?? c.html_url ?? "", summary: String(c.summary ?? "").slice(0, 600) }));
}

/** True when the issue text names the failing check or a file the check's output names: the issue is then the fix (or about it), not a bystander. */
export function touchedByIssue(fail, issueText) {
  const text = String(issueText ?? "").toLowerCase();
  if (!text) return false;
  if (text.includes(String(fail.name).toLowerCase())) return true;
  const { src, tests } = baseRedPaths([{ command: "", output: fail.summary }]);
  return [...src, ...tests].some((p) => text.includes(p.toLowerCase()));
}

/** Base health verdict: red only for a failing required check this issue does not touch. */
export function baseHealth({ checks, required, issueText } = {}) {
  const failing = failingRequired({ checks, required });
  const foreign = failing.filter((f) => !touchedByIssue(f, issueText));
  return { red: foreign.length > 0, failing: foreign, touched: failing.filter((f) => !foreign.includes(f)) };
}

/** Reads check runs and commit statuses of `sha` through `gh` (a function of argv, string out). Throws on an unreadable base; the caller fails open. */
export async function fetchBaseChecks({ gh, repo, sha }) {
  const runs = String(await gh(["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs`, "--jq", ".check_runs[] | {name, conclusion, url: .html_url, completed_at, summary: (.output.summary // .output.title // \"\")}"]));
  let statuses = "";
  try { statuses = String(await gh(["api", `repos/${repo}/commits/${sha}/status`, "--jq", ".statuses[] | {name: .context, conclusion: .state, url: .target_url, completed_at: .updated_at, summary: (.description // \"\")}"])); } catch { /* classic statuses are optional */ }
  const rows = [];
  for (const l of `${runs}\n${statuses}`.split("\n")) { try { if (l.trim()) rows.push(JSON.parse(l)); } catch { /* skip */ } }
  return rows;
}

/** Evidence comment for a red base: the checks with links. Keyed by the base sha so a requeue loop posts it once. */
export function baseRedComment({ base, sha, failing }) {
  const rows = failing.map((f) => `- \`${f.name}\` (${f.conclusion})${f.url ? ` ${f.url}` : ""}${f.summary ? `\n  ${f.summary.split("\n")[0].slice(0, 200)}` : ""}`).join("\n");
  return `<!-- ${ADMIT_MARKER} base.red ${base}@${sha12(sha)} -->\n## Admit probe: base is red\nRequired check(s) fail on \`${base}\` at \`${sha12(sha)}\`, and this issue does not touch them:\n${rows}\n\nNo builder session was started (spend $0). The lane is deferred and re-admitted when the base head moves.`;
}
export const hasAdmitComment = (comments, key) => (comments ?? []).some((c) => String(c?.body ?? "").includes(`<!-- ${ADMIT_MARKER} ${key} -->`));

/** What the dry-run's misses mean: Docker-only gaps are deferred to CI, other tools (not owned by the repo's manifests) end the lane before the build. */
export function classifyDryRun({ misses = [], owned = () => false } = {}) {
  const isDocker = (m) => /^docker(?: daemon)?$/i.test(String(m?.tool ?? "")) || /Cannot connect to the Docker daemon|docker\.sock/i.test(String(m?.line ?? ""));
  const docker = new Set(), tools = new Set(), toolIds = new Set();
  for (const m of misses ?? []) {
    if (!m || !m.tool) continue;
    if (isDocker(m)) { for (const id of m.ids ?? []) docker.add(String(id)); continue; }
    if (m.kind !== "command" || owned(m.tool)) continue; // paths, modules, env vars stay the builder's to fix: the existing contract correction handles them
    tools.add(String(m.tool)); for (const id of m.ids ?? []) toolIds.add(String(id));
  }
  return { docker: [...docker].sort(), tools: [...tools].sort(), ids: [...toolIds].sort() };
}

/** The park stamp a NEEDS_HUMAN/PARKED comment carries: the base head and the input hash it ran on, and the code. */
export const STAMP_RE = /\bbase=([0-9a-f]{12})\s+in=([0-9a-f]{16})\s+code=([\w.:-]+)/;
export const renderStamp = ({ base, input, code }) => (sha12(base) && input && code ? `base=${sha12(base)} in=${input} code=${code}` : "");

/** Hash of what a person can change on the issue: title, body, trusted FORGE:DECISIONs, the frozen contract, the engine major.minor (labels are state, not input). */
export function inputOf({ iss, comments = [], trusted = () => true, engineVersion = null }) {
  const decisions = (comments ?? []).filter((c) => /^\s*<!--\s*FORGE:DECISION\b/.test(String(c?.body ?? "")) && trusted(c)).map((c) => c.body);
  return computeInputHash({ title: iss?.title ?? "", body: iss?.body ?? "", labels: [], decisions, engineVersion, contractHash: frozenContractHash(comments, trusted) });
}

/** Codes a repeat cannot help: the engine's own environment recovery, a human block, a deferral. Parks of these never stop admission. */
const NO_STOP = new Set([...ENV_ENGINE_OWNED_CODES, OUTCOME_CODES.BUILDER_BLOCKED, OUTCOME_CODES.FAILURE_REPEATED, OUTCOME_CODES.BASE_RED, OUTCOME_CODES.BASE_CONFLICT]);
export const stampable = (code) => !NO_STOP.has(code);

/**
 * The failure-fingerprint stop: the newest trusted NEEDS_HUMAN/PARKED comment (after the last trusted FORGE:DECISION) carries a stamp whose base head and
 * input hash equal the current ones. Returns {sig, code, base, input} or null (a missing stamp, a changed base or input, an engine-owned code admit).
 */
export function fingerprintStop({ comments = [], base, input, trusted = () => true } = {}) {
  let last = null;
  for (const c of comments ?? []) {
    const body = String(c?.body ?? "");
    if (isResetDecision(body) && trusted(c)) { last = null; continue; }
    if (!/<!--\s*FORGE:(NEEDS_HUMAN|PARKED)(?![A-Za-z0-9_])/.test(body) || !trusted(c)) continue;
    const m = STAMP_RE.exec(body);
    if (m) last = { base: m[1], input: m[2], code: m[3], sig: /\bsig=([0-9a-f]{12})\b/.exec(body)?.[1] ?? "" }; // an unstamped park (older, or an engine-owned code) leaves the last stamp standing
  }
  if (!last || !stampable(last.code) || !base || !input) return null;
  return last.base === sha12(base) && last.input === input ? last : null;
}

export const stopReason = (s) => `parked before with fingerprint ${s.sig || "(unsigned)"} (${s.code}) on this base head and this issue input; nothing changed since, so no builder session is spent. Change the issue, add a FORGE:DECISION, or wait for the base to move, then rerun`;

/** The one telemetry record of a probe, always zero builder spend. */
export const admitEvent = ({ outcome, code = null, detail = "", checks = [], ms = 0 } = {}) => ({ event: ADMIT_EVENT, outcome, code, detail: String(detail).slice(0, 300), checks, builder_spend_usd: 0, ms });

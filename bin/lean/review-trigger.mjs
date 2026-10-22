// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deterministic review trigger (#4273, #4199 "Judge only on a risk trigger"). The conformance reviewer is needed when
 * the diff touches a risk path, adds a package edge (#4159), changes an over-threshold file (#4195), or a deterministic
 * gate failed or could not answer. Otherwise the review would be skipped. forge.yaml `review.trigger`: shadow (default:
 * log REVIEW_TRIGGER, always review), enforce (skip the reviewer when not triggered), off (today's behaviour).
 * Run directly, it reports per repo how many would-skip lanes the reviewer flagged as nonconforming.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesGlob } from "./verify.mjs";

/** The engine run-log dir (same rule as bin/stats/local-source.mjs runsDir). */
const runsDir = (env = process.env) => env.FORGE_RUNS_DIR || join(homedir(), ".forge", "runs");

export const TRIGGER_MODES = Object.freeze(["shadow", "enforce", "off"]);

/** Built-in risk words, matched against a path's word tokens (camelCase, "/", ".", "-", "_" split them). */
export const DEFAULT_RISK_PATTERNS = Object.freeze({
  auth: ["auth", "authn", "authz", "oauth", "login", "logout", "session", "sessions", "permission", "permissions", "rbac", "acl"],
  payments: ["payment", "payments", "billing", "checkout", "stripe", "invoice", "invoices", "subscription", "subscriptions"],
  security: ["security", "crypto", "secret", "secrets", "credential", "credentials", "token", "tokens"],
  deletion: ["delete", "deletion", "purge", "gdpr", "erase"],
  migrations: ["migration", "migrations", "migrate", "alembic"],
});
const RISK_WORDS = new Map(Object.entries(DEFAULT_RISK_PATTERNS).flatMap(([k, ws]) => ws.map((w) => [w, k])));

/** Word tokens of a path: "src/AuthService/user_delete.ts" -> src, auth, service, user, delete, ts. */
const tokens = (p) => String(p).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The built-in risk class a path hits, or null. */
export function riskClassOf(path) {
  for (const t of tokens(path)) if (RISK_WORDS.has(t)) return RISK_WORDS.get(t);
  return null;
}

/** forge.yaml review.risk_paths: a comma-separated string or a list -> trimmed non-empty globs. */
export function parseRiskPaths(v) {
  const xs = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return xs.map((x) => String(x ?? "").trim()).filter(Boolean);
}

/**
 * #4398: the changed files matching a declared forge.yaml review.risk_paths glob (sorted, unique). Only declared globs
 * count, never the built-in risk words: a hit makes the conformance gate enforce for that lane. [] without globs.
 */
export function riskPathHits(files = [], riskPaths = []) {
  const globs = parseRiskPaths(riskPaths);
  if (!globs.length) return [];
  return [...new Set((files ?? []).map(String))].filter((f) => globs.some((g) => matchesGlob(f, g))).sort();
}

/**
 * {would_skip, reasons:[{code, detail}]} from facts only. Codes: risk_path, package_edge, hotspot, gate.failed,
 * gate.ambiguous. `hotspots` null/undefined means the facts were unavailable (ambiguous); {enabled:false} is an answer.
 * gates: {precheckFailures[], checkCommandsFailing, ciFellBack}. Reasons are sorted, so equal input gives equal output.
 */
export function computeTrigger({ files = [], riskPaths = [], structure = null, hotspots, gates = {}, contract = null } = {}) {
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, detail });
  const globs = parseRiskPaths(riskPaths);
  for (const f of [...new Set(files.map(String))].sort()) {
    const cls = riskClassOf(f);
    if (cls) add("risk_path", `${f} (${cls})`);
    else { const g = globs.find((x) => matchesGlob(f, x)); if (g) add("risk_path", `${f} (review.risk_paths ${g})`); }
  }
  for (const e of Array.isArray(structure?.package_edges_added) ? structure.package_edges_added : []) add("package_edge", `${e?.from} → ${e?.to}`);
  if (hotspots == null) add("gate.ambiguous", "hotspot facts unavailable");
  else if (hotspots.enabled !== false && Array.isArray(hotspots.files)) {
    const changed = new Set(files.map(String));
    for (const h of hotspots.files) if (h?.over === true && h.excluded !== true && changed.has(String(h.path))) add("hotspot", `${h.path} (${h.lines} lines)`);
  }
  const pre = Array.isArray(gates.precheckFailures) ? gates.precheckFailures : [];
  for (const c of [...new Set(pre.map((f) => String(f?.code ?? f)))].sort()) add("gate.failed", `precheck ${c}`);
  if (gates.checkCommandsFailing) add("gate.failed", "declared check commands still failing");
  if (gates.ciFellBack) add("gate.failed", "CI verification unavailable (local fallback)");
  const tracked = (contract?.requirements ?? []).filter((r) => r?.disposition === "defer" || r?.disposition === "post-deploy").map((r) => r.id);
  if (tracked.length) add("gate.ambiguous", `contract defers ${tracked.sort().join(", ")} (only the reviewer judges deferrals)`);
  reasons.sort((a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));
  return { would_skip: reasons.length === 0, reasons };
}

/**
 * Per repo, over run logs (one event array per log; the slice from the last RUN_START counts): runs with a
 * REVIEW_TRIGGER, would-skip runs (their last REVIEW_TRIGGER), how many of those the reviewer flagged nonconforming
 * (a CONFORMANCE event with state "nonconforming"), and enforce skips.
 */
export function triggerReport(logs = []) {
  const out = {};
  for (const events of logs) {
    if (!Array.isArray(events)) continue;
    let s = -1;
    events.forEach((e, i) => { if (e?.event === "RUN_START") s = i; });
    if (s < 0) continue;
    const ev = events.slice(s);
    const trig = ev.filter((e) => e?.event === "REVIEW_TRIGGER");
    if (!trig.length) continue;
    const repo = typeof ev[0].repo === "string" && ev[0].repo ? ev[0].repo : "unknown";
    const r = (out[repo] ??= { runs: 0, would_skip: 0, would_skip_flagged: 0, skipped: 0 });
    r.runs++;
    if (trig.some((e) => e.skipped === true)) r.skipped++;
    if (trig.at(-1).would_skip !== true) continue;
    r.would_skip++;
    if (ev.some((e) => e?.event === "CONFORMANCE" && e.state === "nonconforming")) r.would_skip_flagged++;
  }
  return out;
}

function parseLog(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object") out.push(e); } catch { /* truncated or corrupt line */ }
  }
  return out;
}

/** Every *.jsonl run log in `dir`; a missing dir is no runs. */
export function readRunLogs(dir = runsDir()) {
  if (!existsSync(dir)) return [];
  const logs = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    try { logs.push(parseLog(readFileSync(join(dir, f), "utf8"))); } catch { /* unreadable log */ }
  }
  return logs;
}

export function formatReport(report) {
  const rows = Object.entries(report).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return "No REVIEW_TRIGGER runs found.";
  return ["| Repo | Runs | Would skip | Would skip, reviewer flagged | Skipped (enforce) |", "| --- | --- | --- | --- | --- |",
    ...rows.map(([repo, r]) => `| ${repo} | ${r.runs} | ${r.would_skip} | ${r.would_skip_flagged} | ${r.skipped} |`)].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--dir");
  const report = triggerReport(readRunLogs(i >= 0 && argv[i + 1] ? argv[i + 1] : runsDir()));
  process.stdout.write((argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report)) + "\n");
}

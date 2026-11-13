// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deploy-gate catalogue, false-block telemetry and admission checklist (#5583, epic #5549 N4, rule R8).
 * `.forge/gates.yaml` (committed, read from a git ref) lists the gates; each run records `{gate, outcome, class, minutes}`
 * (class TP|FB needs an evidence field, else `unknown`) into the release state (`state.gates`). A gate whose FB rate over the
 * last `gates.demote_window` runs exceeds `gates.demote_fb_rate` percent is demoted to warn through `runControl("demote")`
 * with an expiry and an issue, unless it is on the safety allowlist. `release gates` reports runs/fails/FB share/minutes
 * (FB share = FB runs / runs, the same rate the demotion uses). No catalogue file: every entry point is a no-op, zero writes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load, JSON_SCHEMA } from "../vendor/js-yaml/js-yaml.mjs";
import { isUnskippable } from "./release-flakes.mjs";
import { readActive } from "./release-ledger.mjs";

export const GATES_PATH = ".forge/gates.yaml";
export const GATE_MODES = ["block", "skip", "rollback", "freeze", "warn", "red"];
export const OUTCOMES = ["pass", "fail", "inconclusive", "skip"];
export const GATE_CLASSES = ["TP", "FB", "unknown"];
export const TELEMETRY_SCHEMA = "forgedock.release.gate/v1";
export const REPORT_SCHEMA = "forgedock.release.gates/v1";
export const DEMOTE_MODES = ["warn", "inconclusive"];
export const SAFETY_DEFAULT = ["migration-immutability", "identity-preflight", "backup-freshness", "health-auto-restore"];
export const REQUIRED = ["id", "protects_against", "where", "determinism", "pre_merge_artifact", "version", "mode", "owner", "review_by"];
const OPTIONAL = ["on_uncertainty", "failure_triggers", "proportionality"];
const DAY_MS = 86_400_000;

/** @returns {string[]} findings for a parsed catalogue `{schema: 1, gates: [...]}`; empty when valid. */
export function validateCatalogue(cat) {
  if (!cat || typeof cat !== "object" || Array.isArray(cat)) return ["gates: expected a mapping"];
  const out = [];
  for (const k of Object.keys(cat)) if (k !== "schema" && k !== "gates") out.push(`${k}: unknown key`);
  if (cat.schema !== 1) out.push("schema: required and must be 1");
  if (!Array.isArray(cat.gates)) return [...out, "gates: expected a list"];
  const seen = new Set();
  cat.gates.forEach((g, i) => {
    const at = `gates[${i}]`;
    if (!g || typeof g !== "object" || Array.isArray(g)) return void out.push(`${at}: expected a mapping`);
    for (const k of Object.keys(g)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) out.push(`${at}.${k}: unknown key`);
    for (const k of REQUIRED) if (g[k] === undefined || g[k] === null || String(g[k]).trim() === "") out.push(`${at}.${k}: required`);
    if (g.mode !== undefined && !GATE_MODES.includes(g.mode)) out.push(`${at}.mode: ${JSON.stringify(g.mode)} is not one of ${GATE_MODES.join("|")}`);
    if (g.review_by != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(g.review_by))) out.push(`${at}.review_by: expected YYYY-MM-DD`);
    if (g.id != null) { if (seen.has(g.id)) out.push(`${at}.id: duplicate ${g.id}`); seen.add(g.id); }
  });
  return out;
}

/** @returns {{catalogue}|{error}} */
export function parseCatalogue(text) {
  try { return { catalogue: load(String(text), { schema: JSON_SCHEMA }) }; } catch (e) { return { error: String(e?.message ?? e).split("\n")[0] }; }
}

/** The catalogue text at `ref` (`git show`), or null when the file is absent there. */
export function catalogueAt(io, ref) {
  try { return String(io.git(["show", `${ref}:${GATES_PATH}`])); } catch { return null; }
}

/** Findings for the catalogue at `ref`; null when there is none (nothing to validate, nothing written). */
export function catalogueFindings(io, ref) {
  const text = catalogueAt(io, ref);
  if (text === null) return null;
  const { catalogue, error } = parseCatalogue(text);
  return error ? [`parse: ${error}`] : validateCatalogue(catalogue);
}

/** `gates.*` of the release policy: percent threshold, run window, safety allowlist (defaults + the unskippable classes). */
export function parseGatesConfig(policy) {
  const g = policy?.gates ?? {};
  return {
    demoteFbRate: Number(g.demote_fb_rate) >= 0 && g.demote_fb_rate != null ? Number(g.demote_fb_rate) : 5,
    demoteWindow: Number.isInteger(g.demote_window) && g.demote_window > 0 ? g.demote_window : 20,
    safety: Array.isArray(g.safety) ? g.safety.map(String) : SAFETY_DEFAULT,
  };
}

/** Safety-allowlisted gates are never demoted: the `gates.safety` entries and every unskippable class. */
export const isSafetyGate = (gate, safety = SAFETY_DEFAULT) =>
  isUnskippable(String(gate)) || safety.some((s) => gate === s || String(gate).startsWith(`${s}:`) || String(gate).startsWith(`${s}/`));

/** One telemetry record, or null for an unknown gate or outcome. A TP/FB class needs a non-empty `evidence`, else `unknown`. */
export function gateRecord({ gate, outcome, class: cls, evidence, minutes = 0 }) {
  if (!gate || !OUTCOMES.includes(outcome)) return null;
  const ev = typeof evidence === "string" ? evidence.trim() : "";
  const r = { gate: String(gate), outcome, class: (cls === "TP" || cls === "FB") && ev ? cls : "unknown", minutes: Number(minutes) > 0 ? Number(minutes) : 0 };
  if (ev) r.evidence = ev;
  return r;
}

/** The JSON line a repo's `deploy-telemetry` job prints (documented in docs/CONFIG.md). */
export const telemetryLine = (rec) => JSON.stringify({ schema: TELEMETRY_SCHEMA, ...rec });

/** Records from JSON lines (telemetry lines or bare records); lines that are not records are skipped. */
export function parseTelemetry(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    try { const r = gateRecord(JSON.parse(line)); if (r) out.push(r); } catch { /* not a record */ }
  }
  return out;
}

/** `30d` / `12h` -> ms; null when malformed. */
export function parseSince(s) {
  const m = /^(\d+)([hd])$/.exec(String(s ?? ""));
  return m ? Number(m[1]) * (m[2] === "d" ? DAY_MS : 3_600_000) : null;
}

/** Per-gate counts of `records` (`at` filtered by `sinceMs`): `{gate, runs, fails, fb, fb_share, minutes}`, sorted by gate. */
export function summarize(records, { sinceMs = null, now = Date.now() } = {}) {
  const by = new Map();
  for (const r of records) {
    if (sinceMs != null && !(Date.parse(r.at) >= now - sinceMs)) continue;
    const s = by.get(r.gate) ?? { gate: r.gate, runs: 0, fails: 0, fb: 0, minutes: 0 };
    s.runs++; s.minutes += r.minutes ?? 0;
    if (r.outcome === "fail") s.fails++;
    if (r.class === "FB") s.fb++;
    by.set(r.gate, s);
  }
  return [...by.values()].sort((a, b) => a.gate.localeCompare(b.gate)).map((s) => ({ ...s, fb_share: s.runs ? Math.round((s.fb / s.runs) * 1000) / 10 : 0 }));
}

/** Text lines (one table row per gate) or the JSON document of a summary. */
export function formatGatesReport(rows, { json = false } = {}) {
  if (json) return [JSON.stringify({ schema: REPORT_SCHEMA, gates: rows })];
  if (!rows.length) return ["release gates: no gate records"];
  return ["gate\truns\tfails\tfb\tfb_share\tminutes", ...rows.map((r) => `${r.gate}\t${r.runs}\t${r.fails}\t${r.fb}\t${r.fb_share}%\t${r.minutes}`)];
}

const liveDemotion = (e, now) => e && Date.parse(e.until) > now;

/**
 * Gates to demote: the last `demoteWindow` records of the gate hold FB runs above `demoteFbRate` percent (a full window is
 * needed, so two early runs never decide), the gate is not on the safety allowlist and is not already demoted.
 * `records` are in run order. @returns {{gate, runs, fb, rate}[]}
 */
export function planDemotions(records, cfg, { gateModes = {}, now = Date.now() } = {}) {
  const by = new Map();
  for (const r of records) by.set(r.gate, [...(by.get(r.gate) ?? []), r]);
  const out = [];
  for (const [gate, rs] of by) {
    const win = rs.slice(-cfg.demoteWindow);
    if (win.length < cfg.demoteWindow || isSafetyGate(gate, cfg.safety) || liveDemotion(gateModes[gate], now)) continue;
    const fb = win.filter((r) => r.class === "FB").length;
    if (fb * 100 > cfg.demoteFbRate * win.length) out.push({ gate, runs: win.length, fb, rate: Math.round((fb / win.length) * 1000) / 10 });
  }
  return out.sort((a, b) => a.gate.localeCompare(b.gate));
}

/** The mode a gate runs in now: its catalogue mode unless a live demotion lowers it. */
export const effectiveGateMode = (gate, mode, gateModes, now = Date.now()) => (liveDemotion(gateModes?.[gate], now) ? gateModes[gate].mode : mode);

/**
 * Demote every planned gate: file one issue, then `runControl("demote")` (audited, with expiry). @returns {{gate, ok, issue?, error?}[]}
 * `run` defaults to release-control's `runControl`.
 */
export async function applyDemotions({ io, repo, policy, records, now = Date.now(), days = 14, run }) {
  const cfg = parseGatesConfig(policy);
  const lctx = { io, repo, credential: "driver" };
  const active = await readActive(lctx);
  const plan = planDemotions(records, cfg, { gateModes: active.gateModes ?? {}, now });
  const runControl = run ?? (await import("./release-control.mjs")).runControl;
  const out = [];
  for (const p of plan) {
    const why = `false-block rate ${p.rate}% (${p.fb} of the last ${p.runs} runs) exceeds ${cfg.demoteFbRate}%`;
    const url = String(await io.gh(["issue", "create", "--repo", repo, "--title", `gate ${p.gate} demoted to warn: ${why}`,
      "--body", `Gate \`${p.gate}\` was demoted to warn for ${days}d by the false-block policy (#5583): ${why}.\nRe-promote with \`forgedock release promote ${p.gate} --fixture <ref> --reason <text>\` once a fixture reproduces the false block.`])).trim();
    const issue = /(\d+)$/.exec(url)?.[1];
    if (!issue) { out.push({ gate: p.gate, ok: false, error: "could not file the issue" }); continue; }
    const r = await runControl("demote", [p.gate, "--mode", "warn", "--issue", issue, "--until", `${days}d`, "--reason", why], { io, repo, policy, now });
    out.push(r.ok ? { gate: p.gate, ok: true, issue: Number(issue) } : { gate: p.gate, ok: false, issue: Number(issue), error: r.error });
  }
  return out;
}

const ANSWERS = [
  ["pre_merge_artifact", (g) => String(g.pre_merge_artifact ?? "").trim() !== "", "pre_merge_artifact (a fixture)"],
  ["version", (g) => String(g.version ?? "").trim() !== "", "version it runs"],
  ["on_uncertainty", (g) => g.on_uncertainty === "inconclusive", "on_uncertainty: inconclusive (not fail)"],
  ["failure_triggers", (g) => String(g.failure_triggers ?? "").trim() !== "" && String(g.proportionality ?? "").trim() !== "", "failure_triggers and proportionality (what failure triggers and why that is proportional)"],
  ["owner", (g) => String(g.owner ?? "").trim() !== "" && String(g.review_by ?? "").trim() !== "", "owner and review_by"],
];

/** Admission checklist: every gate added or changed in `head` against `base` must carry the five answers. @returns {string[]} findings */
export function admission(base, head) {
  const was = new Map((base?.gates ?? []).map((g) => [g?.id, JSON.stringify(g)]));
  const out = [];
  for (const g of head?.gates ?? []) {
    if (!g || was.get(g.id) === JSON.stringify(g)) continue;
    for (const [, ok, label] of ANSWERS) if (!ok(g)) out.push(`gate ${g.id}: ${was.has(g.id) ? "changed" : "added"} without ${label}`);
  }
  return out;
}

const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/**
 * `forgedock release gates [--since 30d] [--json]` | `gates check [--base <ref>]` | `gates demote [--repo R]`.
 * `ctx`: {io, cwd, defaultBranch, history: gate records with `at` in run order, policy, repo}. @returns the exit code.
 * Without `.forge/gates.yaml` (on the ref, or in the worktree for `check`) nothing is read or written and the exit is 0.
 */
export async function gatesFromCli(argv, ctx) {
  const { io, cwd = process.cwd(), defaultBranch = "main", history = [], policy = null } = ctx;
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "report";
  const base = flagOf(argv, "--base") ?? `origin/${defaultBranch}`;
  if (sub === "check") {
    const file = join(cwd, GATES_PATH);
    if (!existsSync(file)) { io.print(`release gates check: no ${GATES_PATH}; nothing to check`); return 0; }
    const head = parseCatalogue(readFileSync(file, "utf8"));
    const findings = head.error ? [`parse: ${head.error}`] : validateCatalogue(head.catalogue);
    if (!findings.length) {
      const was = catalogueAt(io, base);
      findings.push(...admission(was === null ? null : parseCatalogue(was).catalogue, head.catalogue));
    }
    findings.forEach((f) => io.print(`release gates check: ${f}`));
    io.print(findings.length ? `release gates check: FAILED (${findings.length})` : "release gates check: ok");
    return findings.length ? 1 : 0;
  }
  if (!existsSync(join(cwd, GATES_PATH)) && catalogueAt(io, base) === null) { io.print(`release gates: no ${GATES_PATH}; nothing to do`); return 0; }
  if (sub === "demote") {
    const res = await applyDemotions({ io, repo: ctx.repo, policy, records: history, now: io.now?.() });
    res.forEach((r) => io.print(r.ok ? `release gates: demoted ${r.gate} (issue #${r.issue})` : `release gates: ${r.gate}: ${r.error}`));
    if (!res.length) io.print("release gates: no gate to demote");
    return res.every((r) => r.ok) ? 0 : 1;
  }
  const since = flagOf(argv, "--since");
  const sinceMs = since == null ? null : parseSince(since);
  if (since != null && sinceMs == null) { io.print(`release gates: --since must be <N>d or <N>h, got ${since}`); return 1; }
  formatGatesReport(summarize(history, { sinceMs, now: io.now?.() }), { json: argv.includes("--json") }).forEach((l) => io.print(l));
  return 0;
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Classification record (#5557): path facts and risk are derived by code from the unit map; the LLM sets only type, severity, exists_in, flag, narrative. */
import { resolvePath, matchesAny } from "./release-unitmap.mjs";

export const CLASSIFICATION_FILE = ".forge-lean/classification.json";
export const ReleaseClassifyTYPES = ["bug", "feature", "chore", "docs", "infra", "incident"];
export const SEVERITIES = ["P0", "P1", "P2", "P3"];
export const EXISTS_IN = ["live", "staging-only", "unknown"];
export const FLAGS = ["present", "required", "exempt", "none"];
export const SOURCES = ["path-derived", "text-only", "human"];
const MIGRATION_RE = /(^|\/)infra\/migrations\//;
const SAFE_MARKER = /--\s*HOTFIX-SAFE/, UNSAFE_MARKER = /HOTFIX-UNSAFE/;

/** Design 4.3 defaults, used when the policy has no `risk.rules`. */
export const DEFAULT_RISK_RULES = [
  { when: { migration: true }, risk: "high", forces: "release" },
  { when: { contract: true }, risk: "medium" },
  { when: { rolled_units_gt: 1 }, risk: "medium" },
  { when: { diff_lines_gt: 400 }, risk: "medium" },
];

/** @param {{texts?: Record<string,string>}} extra file contents by path, to look for HOTFIX markers. */
export function deriveFacts(policy, files, { diffLines = 0, texts = {} } = {}) {
  const res = (files ?? []).map((f) => resolvePath(policy, f));
  const units = [...new Set(res.flatMap((r) => (r.units.length ? r.units : [])).concat(res.flatMap((r) => r.affects)))];
  const shared = [...new Set(res.filter((r) => r.unit === "none" && r.affects.length).map((r) => r.path.split("/").slice(0, 2).join("/")))];
  const migFiles = res.filter((r) => MIGRATION_RE.test(r.path) || r.forces.some((f) => f.reason === "migrations")).map((r) => r.path);
  const unsafe = Object.values(texts).some((t) => UNSAFE_MARKER.test(t));
  const safe = migFiles.length > 0 && migFiles.every((p) => SAFE_MARKER.test(texts[p] ?? ""));
  const migrations = unsafe || (migFiles.length && !safe) ? "breaking" : migFiles.length ? "additive" : "none";
  return { units, shared_modules: shared, migrations, contract: res.some((r) => r.contracts.length > 0), paths: res.map((r) => r.path), diff_lines: diffLines };
}

/** First matching rule wins: {risk, rule: <index|"default">, forces?}. */
export function riskOf(policy, facts) {
  const rules = policy?.risk?.rules?.length ? policy.risk.rules : DEFAULT_RISK_RULES;
  for (let i = 0; i < rules.length; i++) {
    const w = rules[i].when ?? {};
    const hit = (w.migration === undefined || (w.migration === (facts.migrations !== "none")))
      && (w.paths === undefined || facts.paths.some((p) => matchesAny(w.paths, p)))
      && (w.contract === undefined || w.contract === facts.contract)
      && (w.rolled_units_gt === undefined || facts.units.length > w.rolled_units_gt)
      && (w.diff_lines_gt === undefined || facts.diff_lines > w.diff_lines_gt);
    if (Object.keys(w).length && hit) return { risk: rules[i].risk, rule: i + 1, ...(rules[i].forces ? { forces: rules[i].forces } : {}) };
  }
  return { risk: "low", rule: "default" };
}

/**
 * `live` needs a cited file:line that exists on the live sha (git cat-file) AND repro evidence red on live and green after the fix.
 * @param {{git: (args: string[]) => Promise<string>|string}} io
 */
export async function verifyExistsIn(rec, { git, liveSha }) {
  if (rec.exists_in !== "live") return { ...rec };
  const ev = rec.exists_in_evidence ?? {};
  const m = /^([^\s:]+):(\d+)$/.exec(String(ev.cite ?? "").trim());
  let ok = false;
  if (m && liveSha && ev.repro?.red_on_live === true && ev.repro?.green_after === true) {
    try {
      await git(["cat-file", "-e", `${liveSha}:${m[1]}`]);
      const lines = String(await git(["show", `${liveSha}:${m[1]}`])).split("\n").length;
      ok = Number(m[2]) >= 1 && Number(m[2]) <= lines;
    } catch { ok = false; }
  }
  return ok ? { ...rec } : { ...rec, exists_in: "unknown", lane_hint: "release", downgraded: "exists_in live lacked a verifiable file:line on the live sha and a red-then-green repro" };
}

/** Text-only records are capped at `classify.text_only_cap` (default 0.5) and never claim `migrations: none`. */
export function applySourceRules(rec, policy) {
  const cap = policy?.classify?.text_only_cap ?? 0.5;
  const out = { ...rec };
  if (out.source === "text-only") {
    out.confidence = Math.min(Number(out.confidence ?? cap), cap);
    if (out.migrations === "none") out.migrations = "unknown";
  }
  return out;
}

export function validateClassification(rec) {
  const p = [];
  const en = (k, vals) => { if (!vals.includes(rec?.[k])) p.push(`${k}: must be one of ${vals.join("|")}`); };
  if (!rec || typeof rec !== "object") return ["classification must be an object"];
  en("type", ReleaseClassifyTYPES); en("severity", SEVERITIES); en("exists_in", EXISTS_IN);
  if (rec.flag !== undefined) en("flag", FLAGS);
  if (rec.severity === "P0" && !(rec.severity_evidence ?? rec.production_evidence)) p.push("severity: P0 needs production-impacting evidence cited");
  return p;
}

/** Overwrites every derived field; the LLM's units, migrations and risk are never kept. */
export function buildRecord(llm, policy, facts, { text = false } = {}) {
  const r = riskOf(policy, facts);
  const { units: _u, shared_modules: _s, migrations: _m, risk: _r, ...kept } = llm ?? {};
  const rec = { ...kept, units: facts.units, shared_modules: facts.shared_modules, migrations: facts.migrations, contract_changed: facts.contract, risk: r.risk, risk_rule: r.rule,
    source: text ? "text-only" : (llm?.source === "human" ? "human" : "path-derived") };
  if (rec.migrations !== "none" || r.forces === "release") rec.lane_hint = "release";
  else rec.lane_hint ??= "none";
  return applySourceRules(rec, policy);
}

const lab = (ns, v) => `${ns}:${v}`;
export function labelsOf(rec) {
  const risk = { low: "low", medium: "med", high: "high" }[rec.risk];
  return [lab("type", rec.type), lab("where", rec.exists_in), ...(rec.units ?? []).map((u) => lab("unit", u)), lab("mig", rec.migrations), risk && lab("risk", risk),
    rec.lane_hint && rec.lane_hint !== "none" ? lab("lane", rec.lane_hint) : null].filter((l) => l && !l.endsWith(":undefined"));
}

export const renderClassify = (rec) => `**Classification** (engine-derived paths and risk)\n\n\`\`\`json\n${JSON.stringify(rec, null, 1)}\n\`\`\``;

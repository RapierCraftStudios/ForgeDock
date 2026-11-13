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

/** Design 4.3 defaults (epic #5549), used when the policy has no `risk.rules`; the implicit last rule is `{risk: low}`. */
export const DEFAULT_RISK_RULES = [
  { when: { migration: true }, risk: "high", forces: "release" },
  { when: { paths: ["shared/billing*", "services/api/app/**/auth*", "services/api/app/**/billing*", "services/worker/**/queue*", "services/worker/**/dispatch*"] }, risk: "high" },
  { when: { paths: ["shared/penetrator/**", "shared/detection/**", "services/worker/worker/anti_detection/**", "**/tier_policy.py", "shared/rollout*.py"] }, risk: "high", requires: "rollout-declaration" },
  { when: { contract: true }, risk: "medium", forces: "atomic-wave" },
  { when: { rolled_units_gt: 1 }, risk: "medium" },
  { when: { diff_lines_gt: 400 }, risk: "medium" },
];

/**
 * @param {{diffLines?: number, hotfixMarkers?: {unsafe?: boolean, safe?: string[]}, texts?: Record<string,string>}} extra
 *   hotfixMarkers: `unsafe` when any file carries HOTFIX-UNSAFE, `safe` the migration paths carrying `-- HOTFIX-SAFE`; `texts` (file contents by path) is scanned for the same markers.
 */
export function deriveFacts(policy, files, { diffLines = 0, hotfixMarkers = {}, texts = {} } = {}) {
  const res = (files ?? []).map((f) => resolvePath(policy, f));
  const units = [...new Set(res.flatMap((r) => (r.units.length ? r.units : [])).concat(res.flatMap((r) => r.affects)))];
  const shared = [...new Set(res.filter((r) => r.unit === "none" && r.affects.length).map((r) => r.path.split("/").slice(0, 2).join("/")))];
  const migFiles = res.filter((r) => MIGRATION_RE.test(r.path) || r.forces.some((f) => f.reason === "migrations")).map((r) => r.path);
  const unsafe = hotfixMarkers.unsafe === true || Object.values(texts).some((t) => UNSAFE_MARKER.test(t));
  const safePaths = new Set([...(hotfixMarkers.safe ?? []), ...Object.keys(texts).filter((k) => SAFE_MARKER.test(texts[k]))]);
  const safe = migFiles.length > 0 && migFiles.every((p) => safePaths.has(p));
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
    if (hit) return { risk: rules[i].risk, rule: i + 1, ...(rules[i].forces ? { forces: rules[i].forces } : {}), ...(rules[i].requires ? { requires: rules[i].requires } : {}) };
  }
  return { risk: "low", rule: "default" };
}

/**
 * `live` needs (a) a cited file:line that exists on the live sha (git cat-file + the line) and (b) a repro `{command, red_on_live, green_after}`
 * whose command, run on a detached checkout of the live sha via `run(command, liveSha)` (exit code or `{exit}`), fails. `green_after` may be null until the fix lands.
 * `staging-only` and `unknown` need no live evidence.
 * @param {{git: (args: string[]) => Promise<string>|string, liveSha?: string|null, run?: (command: string, sha: string) => Promise<number|{exit:number}>|number|{exit:number}}} io
 */
export async function verifyExistsIn(rec, { git, liveSha, run }) {
  if (rec.exists_in !== "live") return { ...rec };
  const ev = rec.exists_in_evidence ?? {};
  const repro = ev.repro ?? {};
  const m = /^([^\s:]+):(\d+)$/.exec(String(ev.cite ?? "").trim());
  let ok = false;
  if (m && liveSha && typeof repro.command === "string" && repro.command.trim() && typeof run === "function") {
    try {
      await git(["cat-file", "-e", `${liveSha}:${m[1]}`]);
      const lines = String(await git(["show", `${liveSha}:${m[1]}`])).split("\n").length;
      if (Number(m[2]) >= 1 && Number(m[2]) <= lines) {
        const res = await run(repro.command, liveSha);
        const exit = typeof res === "number" ? res : res?.exit;
        ok = typeof exit === "number" && exit !== 0; // red: the repro fails on the live sha
      }
    } catch { ok = false; }
  }
  return ok ? { ...rec, exists_in_evidence: { ...ev, repro: { ...repro, red_on_live: true, green_after: repro.green_after ?? null } } }
    : { ...rec, exists_in: "unknown", lane_hint: "release", downgraded: "exists_in live lacked a verifiable file:line on the live sha and a repro that fails (red) there" };
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
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return ["classification must be an object"];
  const en = (k, vals, opt) => { if (rec[k] === undefined && opt) return; if (!vals.includes(rec[k])) p.push(`${k}: must be one of ${vals.join("|")}`); };
  const strs = (k) => { if (rec[k] !== undefined && !(Array.isArray(rec[k]) && rec[k].every((x) => typeof x === "string"))) p.push(`${k}: must be an array of strings`); };
  en("type", ReleaseClassifyTYPES); en("severity", SEVERITIES); en("exists_in", EXISTS_IN);
  en("flag", FLAGS, true); en("source", SOURCES, true); en("risk", ["low", "medium", "high"], true);
  en("migrations", ["none", "additive", "breaking", "unknown"], true); en("lane_hint", ["none", "release", "hotfix", "train", "integration"], true);
  strs("units"); strs("shared_modules"); strs("deps");
  if (rec.ready !== undefined && typeof rec.ready !== "boolean") p.push("ready: must be a boolean");
  if (rec.epic !== undefined && rec.epic !== null && typeof rec.epic !== "string" && !Number.isInteger(rec.epic)) p.push("epic: must be a string, integer or null");
  if (rec.confidence !== undefined && !(typeof rec.confidence === "number" && rec.confidence >= 0 && rec.confidence <= 1)) p.push("confidence: must be a number in 0..1");
  const ev = rec.exists_in_evidence;
  if (ev !== undefined) {
    if (!ev || typeof ev !== "object") p.push("exists_in_evidence: must be an object");
    else {
      if (ev.cite !== undefined && typeof ev.cite !== "string") p.push("exists_in_evidence.cite: must be a string file:line");
      const r = ev.repro;
      if (r !== undefined && r !== null) {
        if (typeof r !== "object" || typeof r.command !== "string") p.push("exists_in_evidence.repro.command: must be a string");
        else {
          if (typeof r.red_on_live !== "boolean") p.push("exists_in_evidence.repro.red_on_live: must be a boolean");
          if (r.green_after !== null && r.green_after !== undefined && typeof r.green_after !== "boolean") p.push("exists_in_evidence.repro.green_after: must be a boolean or null");
        }
      }
    }
  }
  if (rec.severity === "P0" && !(rec.severity_evidence ?? rec.production_evidence)) p.push("severity: P0 needs production-impacting evidence cited");
  return p;
}

/** Overwrites every derived field; the LLM's units, migrations and risk are never kept. */
export function buildClassifyRecord(llm, policy, facts, { text = false } = {}) {
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
  return [lab("type", rec.type), lab("priority", rec.severity), lab("where", rec.exists_in), ...(rec.units ?? []).map((u) => lab("unit", u)), lab("mig", rec.migrations), risk && lab("risk", risk),
    rec.lane_hint && rec.lane_hint !== "none" ? lab("lane", rec.lane_hint) : null].filter((l) => l && !l.endsWith(":undefined"));
}

export const renderClassify = (rec) => `**Classification** (engine-derived paths and risk)\n\n\`\`\`json\n${JSON.stringify(rec, null, 1)}\n\`\`\``;

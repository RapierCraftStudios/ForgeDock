// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `.forge/release.yaml` (#5551): committed, nested release policy (`schema: 1`). Read ONLY from the default branch with
 * `git show origin/<default>:.forge/release.yaml`, never the worktree or PR head, so a PR cannot weaken its own gates (I13).
 * Parsed by the vendored, pinned js-yaml (bin/vendor/js-yaml/PIN.md) and validated closed: unknown keys, wrong types,
 * duplicate keys, unreachable lanes and keys deferred to a later phase (I23) all fail. Absent file: the flat forge.yaml `release.*` keys.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { load, JSON_SCHEMA } from "../vendor/js-yaml/js-yaml.mjs";
import { readReleaseConfig } from "./release.mjs";
import { readBranches } from "./lane.mjs";
import { catalogueFindings } from "./release-gates.mjs";

export const POLICY_PATH = ".forge/release.yaml";
/** Migration locations and destructive statements the rollback ladder looks for in migration file text (I8, #5563); text only, nothing is executed. */
export const MIGRATION_PATHS = ["**/migrations/**", "**/migrate/**", "*.sql"];
export const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE[^;]*\b(DROP|RENAME)\b|RENAME\s+(TO|COLUMN))\b/i;
export const DEFERRED_KEYS = ["plan.auto_if", "retention_days", "ci.forbid_per_issue_steps", "couplings[].refine", "ci.provider=command", "risk.weights"];

export const INIT_PROFILE = `schema: 1
branches: {default: main}
plan: {approval: wait}
lanes: {release: {pipeline: existing}}
merge: {approval: confirm}
`;

// Schema nodes: {t: "object", p: {key: node}} (closed), {t: "map", v: node}, {t: "array", i: node}, {t: "string"|"number"|"integer"|"boolean"|"any"}, {e: [..]}; `n` allows null.
const S = { t: "string" }, N = { t: "number" }, I = { t: "integer" }, B = { t: "boolean" }, ANY = { t: "any" };
const SN = { t: "string", n: true };
const list = (i = S) => ({ t: "array", i });
const obj = (p, extra = {}) => ({ t: "object", p, ...extra });
const en = (...e) => ({ t: "string", e });
const PIPELINE = obj({ workflow: S, trigger: en("push", "dispatch"), inputs: { t: "map", v: S }, wait: B });
export const POLICY_SCHEMA = obj({
  schema: { t: "integer", e: [1] },
  branches: obj({ default: S, integration: SN, train: S, release: S, hotfix: S }),
  trust: obj({ actors: list(), require_verified_commits: B }),
  state: obj({ ledger_prefix: S, lease_ttl_s: N, heartbeat_s: N }),
  units: { t: "map", v: obj({ paths: list(), image: SN, criticality: en("low", "medium", "high"), tests: list(), verify: list(), service_pipeline: B, single_host_ok: B }) },
  couplings: list(obj({ paths: list(), affects: list() })),
  contracts: list(obj({ producer: S, consumers: list(), paths: list(), additive_only: B })),
  forces: list(obj({ paths: list(), pipeline: en("full", "service", "hotfix"), reason: S })),
  classify: obj({ min_confidence: N, text_only_cap: N, triage_max_per_hour: N, exists_in_evidence: en("mechanical", "llm") }),
  risk: obj({ rules: list(obj({ when: obj({ migration: B, paths: list(), contract: B, rolled_units_gt: N, diff_lines_gt: N, requires: S }), risk: en("low", "medium", "high"), forces: S })) }),
  plan: obj({ approval: en("wait", "auto", "auto-if"), skip_labels: list(), require_design_gate: B, max_issues: N, stale_snapshot_s: N }),
  lanes: { t: "map", v: obj({ pipeline: S, ci_tier: S, approval: S, budget: S, base: en("live", "integration", "default"), units_max: N, max_risk: en("low", "medium", "high"), train_max_issues: N, train_max_units: N, soak_min: { t: "any" }, flag_policy: en("require", "warn", "off"), requires: list() }) },
  credentials: obj({ gate_app: SN, lane_env_strip: list() }),
  merge: obj({ approval: en("confirm", "with-plan", "auto"), method: en("merge-commit", "squash", "rebase"), trailers: list() }),
  ci: obj({ provider: en("github-actions", "command"), required_checks: ANY, selection: ANY, rerun_budget_min: N, fix: obj({ max_rounds: I, co_start: B, full_run_workflow: S }), flake: obj({ quarantine_after: N, window_days: N }), unskippable: list(), tiers: { t: "map", v: obj({ jobs: list() }) }, nightly: ANY, budget: ANY }),
  preflight: obj({ commands: list(), timeout_s: N, blocking: B }),
  deploy: obj({ live_release_command: S, freeze_variable: S, concurrency_group: S, start_timeout_s: N, stage_timeout_s: N, expected_digests_command: S, recovery: obj({ rerun_max: I, max_attempts: I, signatures: list() }), pipelines: { t: "map", v: PIPELINE } }),
  verify: obj({ workflow: S, results: list(obj({ workflow: S, kind: en("smoke", "edge", "convergence") })), flags: list(obj({ flag: S, off_command: S })), slis: list(ANY), post_deploy_checks_file: S, close_requires: en("verified", "deployed") }),
  rollback: obj({
    triggers: list(en("smoke", "health", "livecheck", "sli", "crashloop", "human")), ladder: list(en("flag", "unit", "full", "stop")), refuse_across: list(en("destructive_migration")), open_revert_pr: B,
    flags: list(obj({ flag: S, kill_command: S })), unit_workflow: S, unit_action: S, full_workflow: S, health_command: S, result_command: S,
  }),
  events: obj({ webhook_url: S }),
  quarantine: obj({ days: N, max: N }),
  gates: obj({ demote_fb_rate: N, demote_window: I, safety: list(), paths: list(), workflow_steps: list() }),
  controls: obj({ intake: ANY, conductor: ANY, exempt: ANY }),
});

const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const typeOk = { string: (v) => typeof v === "string", number: (v) => typeof v === "number" && Number.isFinite(v), integer: Number.isInteger, boolean: (v) => typeof v === "boolean" };

function walk(node, v, at, out) {
  if (v === null && node.n) return;
  if (node.t === "any") return;
  if (node.t === "object" || node.t === "map") {
    if (kind(v) !== "object") return void out.push(`${at}: expected a mapping, got ${kind(v)}`);
    for (const [k, x] of Object.entries(v)) {
      const child = node.t === "map" ? node.v : node.p[k];
      if (!child) out.push(`${at ? `${at}.` : ""}${k}: unknown key`);
      else walk(child, x, `${at ? `${at}.` : ""}${k}`, out);
    }
  } else if (node.t === "array") {
    if (!Array.isArray(v)) return void out.push(`${at}: expected a list, got ${kind(v)}`);
    v.forEach((x, i) => walk(node.i, x, `${at}[${i}]`, out));
  } else if (!typeOk[node.t]?.(v)) return void out.push(`${at}: expected ${node.t}, got ${kind(v)}`);
  if (node.e && !node.e.includes(v)) out.push(`${at}: ${JSON.stringify(v)} is not one of ${node.e.join("|")}`);
}

const DEFERRED_AT = [
  [(p) => p?.plan && "auto_if" in p.plan, "plan.auto_if"],
  [(p) => p && "retention_days" in p, "retention_days"],
  [(p) => p?.ci && "forbid_per_issue_steps" in p.ci, "ci.forbid_per_issue_steps"],
  [(p) => Array.isArray(p?.couplings) && p.couplings.some((c) => c && typeof c === "object" && "refine" in c), "couplings[].refine"],
  [(p) => p?.ci?.provider === "command", "ci.provider: command"],
  [(p) => p?.risk && "weights" in p.risk, "risk.weights"],
];

const DEFERRED_UNKNOWN = new Set(["plan.auto_if", "retention_days", "ci.forbid_per_issue_steps", "risk.weights"].map((k) => `${k}: unknown key`));

/** Lanes that can never run: unknown pipeline, `base: integration` without an integration branch, tier not in `ci.tiers`. */
function unreachable(p, out) {
  const pipes = p.deploy?.pipelines && Object.keys(p.deploy.pipelines);
  const tiers = p.ci?.tiers && Object.keys(p.ci.tiers);
  for (const [name, l] of Object.entries(p.lanes ?? {})) {
    if (!l || typeof l !== "object") continue;
    if (pipes?.length && l.pipeline && l.pipeline !== "existing" && !pipes.includes(l.pipeline)) out.push(`lanes.${name}: unreachable, pipeline ${l.pipeline} is not in deploy.pipelines`);
    if (l.base === "integration" && !p.branches?.integration) out.push(`lanes.${name}: unreachable, base integration but branches.integration is not set`);
    if (tiers?.length && l.ci_tier && !tiers.includes(l.ci_tier)) out.push(`lanes.${name}: unreachable, ci_tier ${l.ci_tier} is not in ci.tiers`);
  }
  const units = Object.keys(p.units ?? {});
  const dangling = (ids, at) => (ids ?? []).filter((u) => !units.includes(u)).forEach((u) => out.push(`${at}: unit ${u} is not in units`));
  (p.couplings ?? []).forEach((c, i) => dangling(c?.affects, `couplings[${i}].affects`));
  (p.contracts ?? []).forEach((c, i) => { dangling(c?.producer ? [c.producer] : [], `contracts[${i}].producer`); dangling(c?.consumers, `contracts[${i}].consumers`); });
}

/** @returns {string[]} findings, empty when `policy` is valid. */
export function validatePolicy(policy) {
  const out = [];
  if (kind(policy) !== "object") return [`policy: expected a mapping, got ${kind(policy)}`];
  for (const [test, name] of DEFERRED_AT) if (test(policy)) out.push(`${name}: deferred to a later phase, not accepted yet`);
  const rest = [];
  walk(POLICY_SCHEMA, policy, "", rest);
  out.push(...rest.filter((l) => !DEFERRED_UNKNOWN.has(l)));
  if (policy.schema !== 1) out.push("schema: required and must be 1");
  if (!out.length) unreachable(policy, out);
  return out;
}

/** @returns {{policy}|{error}} js-yaml with JSON_SCHEMA; duplicate keys throw. */
export function parsePolicy(text) {
  try { return { policy: load(String(text), { schema: JSON_SCHEMA }) }; } catch (e) { return { error: String(e?.message ?? e).split("\n")[0] }; }
}

/**
 * Policy as of the default branch. `source`: "file" (sha = sha256 of the text), or "forge.yaml" (flat `release.*` fallback) when the file is absent there.
 * Only `io.git(["show", "origin/<default>:.forge/release.yaml"])` is read: a head-modified worktree copy has no effect (I13).
 */
export function readPolicy({ io, defaultBranch, cwd = process.cwd(), ref }) {
  const spec = `${ref ?? `origin/${defaultBranch}`}:${POLICY_PATH}`;
  let text = null;
  try { text = String(io.git(["show", spec])); } catch { text = null; }
  if (text === null) {
    let raw = ""; try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { /* none */ }
    return { source: "forge.yaml", policy: null, flat: readReleaseConfig(raw), findings: [] };
  }
  const { policy, error } = parsePolicy(text);
  const findings = error ? [`parse: ${error}`] : validatePolicy(policy);
  return { source: "file", policy: findings.length ? null : policy, findings, sha: createHash("sha256").update(text).digest("hex") };
}

const GATES_PATH_LABEL = ".forge/gates.yaml";
const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/** `forgedock release check-config [--ref <git ref>]`: exit 0 valid (or file absent: flat keys), 1 on any finding. */
export function checkConfigFromCli(argv, { io, cwd = process.cwd() }) {
  const defaultBranch = readBranches(cwd).default || "main";
  const ref = flagOf(argv, "--ref");
  const gf = catalogueFindings(io, ref ?? `origin/${defaultBranch}`); // #5583: .forge/gates.yaml, validated when present
  const gatesLines = () => (gf ?? []).map((f) => `release check-config: ${GATES_PATH_LABEL}: ${f}`);
  const r = readPolicy({ io, defaultBranch, cwd, ref });
  if (r.source === "forge.yaml") {
    io.print(`release check-config: no ${POLICY_PATH} on origin/${defaultBranch}; using forge.yaml release.* keys`);
    gatesLines().forEach((l) => io.print(l));
    return gf?.length ? 1 : 0;
  }
  const findings = [...r.findings, ...(gf ?? []).map((f) => `${GATES_PATH_LABEL}: ${f}`)];
  findings.forEach((f) => io.print(`release check-config: ${f}`));
  io.print(findings.length ? `release check-config: FAILED (${findings.length})` : `release check-config: ok (sha256 ${r.sha.slice(0, 12)})`);
  return findings.length ? 1 : 0;
}

/** `forgedock release init [--conductor]`: writes the zero-config profile (7.4) to `.forge/release.yaml` and nothing else; never overwrites. */
export function initFromCli(argv, { io, cwd = process.cwd() }) {
  const file = join(cwd, POLICY_PATH);
  if (argv?.includes("--conductor")) return initConductor(file, { io, cwd }); // #5564: async; the plain init stays synchronous
  if (existsSync(file)) { io.print(`release init: ${POLICY_PATH} exists; not overwriting`); return 1; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, INIT_PROFILE);
  io.print(`release init: wrote ${POLICY_PATH}`);
  return 0;
}

/** `release init --conductor`: the policy file (left alone when present) plus the version-pinned conductor workflow. */
async function initConductor(file, { io, cwd }) {
  const { installConductor } = await import("./release-conductor.mjs");
  let pol = null; try { pol = parsePolicy(readFileSync(file, "utf8")).policy; } catch { /* no policy yet: defaults */ }
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, INIT_PROFILE); io.print(`release init: wrote ${POLICY_PATH}`); }
  return installConductor({ io, cwd, policy: pol });
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bin/config-schema.mjs — forge.yaml schema check (#5315). A setting nobody reads, or one the active engine path
// ignores, must never be silent: `forgedock doctor` fails on it and a batch warns at start. Pure: text in, findings out.
// The sections below mirror docs/CONFIG.md (bin/tests/config-schema.test.mjs fails when a documented section is missing here).
// Nested keys are only checked where a section is listed in CLOSED; elsewhere only the top level and typed keys are.

import { parseForgeYaml } from "./forge-utils.mjs";

export const TOP_LEVEL = [
  "project", "paths", "branches", "agents", "repos", "project_board", "orchestration", "orchestrate", "notify", "decisions",
  "hygiene", "pipeline", "execution", "engine", "prod_watch", "selftest", "release", "issue_watch", "followups", "rollouts",
  "post_deploy", "events", "lean", "stats", "verify", "ci", "env", "build", "decomposition", "services", "review", "devdocs",
  "verification", "billing", "adaptive_scripts", "branding", "marketing", "acceptance_probe", "attribution", "autopilot",
  "deploy", "design", "gate", "experiment", "learned", "maintenance", "milestones", "pattern_feeds", "topology", "validate",
];

/** Sections whose direct children are a closed set: another child is an unknown key. */
export const CLOSED = {
  "verification.ci_local": ["mode", "exclude_jobs", "include_jobs", "extra_commands", "services", "budget_minutes", "max_parallel"],
  "env.snapshots": ["enabled", "store", "keep", "max_age_days", "ready", "base_image", "image"],
  "env.proxies": ["npm", "pypi", "apt", "git"],
  // #5710 test engine. The one-level parser flattens these under `ci`, so every name is unique within `ci`.
  "ci.tests": ["selection", "suites", "run_all", "ignore", "test_globs", "full_branches", "graduate_after", "graduate_min_failing", "shards", "shard_target_s", "quarantine", "quarantine_after", "quarantine_window_days", "recall_ledger"],
  // #5760 CI budget gate (bin/lean/ci-gate.mjs). Flattened under `ci` too: monthly_minutes is the same key as #5278's ci.monthly_minutes.
  "ci.budget": ["max_workflows", "max_ci_jobs", "monthly_minutes", "shared_regression_job"],
  // #5712: the deploy stage engine (bin/lean/deploy-stages.mjs); the stage entries themselves are checked by validateEngine
  "deploy.engine": ["enabled", "live_release_command", "stage_timeout_s", "colour", "services", "canary", "rollback", "stages"],
  "deploy.engine.colour": ["active_command", "names"],
  "deploy.engine.services": ["mode", "desired_command", "live_command"],
  "deploy.engine.canary": ["health_command", "low", "medium", "high"],
  "deploy.engine.rollback": ["budget_s", "shift_back_command", "abort_command"],
  "deploy.promote": ["enabled", "shadow", "required_checks", "evidence_app", "cache_ref", "cache_mode", "builder", "rebuild_all", "services"], // #5711, read by bin/lean/release-promote.mjs
};

/** Typed keys: list | number | bool | scalar | {enum:[...]}. */
export const TYPES = {
  "verification.ci_local.mode": { enum: ["advisory", "blocking"] },
  "verification.ci_local.services": { enum: ["auto", "off"] },
  "verification.ci_local.exclude_jobs": "list",
  "verification.ci_local.include_jobs": "list",
  "verification.ci_local.extra_commands": "list",
  "verification.ci_local.budget_minutes": "number",
  "verification.ci_local.max_parallel": "number",
  "env.snapshots.enabled": "bool",
  "env.snapshots.store": { enum: ["local", "oci"] },
  "env.snapshots.keep": "number",
  "env.snapshots.max_age_days": "number",
  "env.snapshots.ready": "number",
  "ci.tests.selection": { enum: ["off", "shadow", "enforce"] },
  "ci.tests.quarantine": { enum: ["off", "report", "non-blocking"] },
  "ci.tests.suites": "list",
  "ci.tests.run_all": "list",
  "ci.tests.ignore": "list",
  "ci.tests.test_globs": "list",
  "ci.tests.full_branches": "list",
  "ci.tests.graduate_after": "number",
  "ci.tests.graduate_min_failing": "number",
  "ci.tests.shards": "number",
  "ci.tests.shard_target_s": "number",
  "ci.tests.quarantine_after": "number",
  "ci.tests.quarantine_window_days": "number",
  "ci.budget.max_workflows": "number",
  "ci.budget.max_ci_jobs": "number",
  "ci.budget.monthly_minutes": "number",
  "ci.budget.shared_regression_job": "scalar",
  "engine.path": { enum: ["core", "full", "lean", "auto"] },
  "deploy.engine.enabled": "bool",
  "deploy.engine.stage_timeout_s": "number",
  "deploy.engine.stages": "list",
  "deploy.engine.colour.names": "list",
  "deploy.engine.services.mode": { enum: ["off", "shadow", "enforce"] },
  "deploy.engine.rollback.budget_s": "number",
  "billing.enabled": "bool",
  "gate.required_checks": "list",
  "verify.settle": { enum: ["fixed", "shadow", "condition"] }, // #5718
  "verify.cancel_superseded": { enum: ["off", "own", "all", "true", "false"] },
  "stats.ledger_ci_workflows": "list",
  "deploy.promote.enabled": "bool",
  "deploy.promote.shadow": "bool",
  "deploy.promote.required_checks": "list",
  "deploy.promote.rebuild_all": "list",
  "deploy.promote.cache_mode": { enum: ["min", "max"] },
};

/** Keys the legacy `full` path never reads (the core path reads them: bin/engine-cli.mjs readEnvConfig, readConformanceMode). */
export const IGNORED_ON = {
  full: ["env", "verify", "lean", "engine.conformance", "engine.conformance_kinds"],
  core: [],
};

export const DEPRECATED = {
  "pipeline.token_budget_per_batch": "orchestration.cascade.token_budget",
  "build.diff_size.threshold": "review.depth.extended_weight",
};

/** Indentation scan of forge.yaml: Map of dotted key path -> {kind: "map"|"list"|"scalar", value}. Arrays, block scalars and comments are skipped. */
export function scanKeys(text) {
  const out = new Map();
  const lines = String(text).split(/\r?\n/);
  const stack = []; // {indent, path}
  let skipAbove = -1; // block scalar body: lines indented deeper than this are values
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    if (skipAbove >= 0) { if (indent > skipAbove) continue; skipAbove = -1; }
    if (/^\s*-(\s|$)/.test(line)) { skipAbove = indent; continue; } // a list item; the keys of a map item (deeper lines) belong to the item, not to the parent
    const m = line.match(/^( *)([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/);
    if (!m) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), m[2]].join(".");
    const value = (m[3] ?? "").replace(/\s+#.*$/, "").trim();
    let kind = "scalar";
    if (value === "" || value === "|" || value === ">" || /^[|>][+-]?$/.test(value)) {
      if (/^[|>]/.test(value)) { skipAbove = indent; kind = "scalar"; }
      else {
        const next = lines.slice(i + 1).find((l) => !/^\s*(#.*)?$/.test(l));
        kind = next && /^\s*-(\s|$)/.test(next) && next.match(/^ */)[0].length >= indent ? "list" : "map";
      }
    } else if (value.startsWith("[")) kind = "list";
    out.set(path, { kind, value });
    if (kind === "map") stack.push({ indent, key: m[2] });
  }
  return out;
}

function typeError(spec, { kind, value }) {
  const bare = value.replace(/^["']|["']$/g, "");
  if (spec === "list") return kind === "list" ? "" : "a list";
  if (kind !== "scalar") return "a scalar value";
  if (spec === "number") return /^-?\d+(\.\d+)?$/.test(bare) ? "" : "a number";
  if (spec === "bool") return /^(true|false)$/.test(bare) ? "" : "true or false";
  if (spec && spec.enum) return spec.enum.includes(bare) ? "" : `one of ${spec.enum.join("|")}`;
  return "";
}

/**
 * @param {string} text forge.yaml content
 * @param {{path?: string}} [opts] active engine path: core|full|lean|auto (anything but full reads as core)
 * @returns {{level: "error"|"warn", code: string, key: string, message: string}[]}
 */
export function validateForgeYaml(text, { path } = {}) {
  const keys = scanKeys(text);
  let parsed = {};
  try { parsed = parseForgeYaml(String(text)); } catch { /* unparseable: scan findings still apply */ }
  const active = keys.get("engine.path")?.value.replace(/^["']|["']$/g, "") ?? "";
  const engine = path ?? (active || "core");
  const side = engine === "full" ? "full" : "core";
  const findings = [];
  const add = (level, code, key, message) => findings.push({ level, code, key, message });
  for (const [key, node] of keys) {
    if (!key.includes(".") && !TOP_LEVEL.includes(key)) { add("error", "unknown-key", key, `unknown top-level key "${key}" (nothing reads it; check the spelling against docs/CONFIG.md)`); continue; }
    const parent = key.slice(0, key.lastIndexOf("."));
    if (CLOSED[parent] && !CLOSED[parent].includes(key.slice(parent.length + 1))) { add("error", "unknown-key", key, `unknown key "${key}" (known under ${parent}: ${CLOSED[parent].join(", ")})`); continue; }
    const ignored = IGNORED_ON[side].find((p) => key === p || key.startsWith(p + "."));
    if (ignored && key === ignored) add("error", "ignored-on-path", key, `"${key}" is set but the ${side} engine path (engine.path: ${engine}) never reads it`);
    if (DEPRECATED[key]) add("warn", "deprecated-alias", key, `"${key}" is a deprecated alias; use "${DEPRECATED[key]}"`);
    // #5504: a list the YAML text writes (block or flow) or the schema types as a list must reach readers as an array.
    // Only `key` and `section.key` are checked: deeper blocks have their own readers (e.g. issue_watch.watches.*).
    const [sec, leaf, deeper] = key.split(".");
    const got = leaf === undefined ? parsed[sec] : deeper === undefined ? parsed[sec]?.[leaf] : undefined;
    if (deeper === undefined && (node.kind === "list" || TYPES[key] === "list") && node.kind !== "map" && got !== undefined && !Array.isArray(got)) {
      add("warn", "list-not-array", key, `"${key}" is a list but parses to ${typeof got === "string" ? JSON.stringify(got) : typeof got}, not an array (readers of it will ignore it)`);
    }
    if (TYPES[key]) {
      const want = typeError(TYPES[key], node);
      if (want) add("error", "wrong-type", key, `"${key}" must be ${want} (got ${node.kind === "scalar" ? JSON.stringify(node.value) : node.kind})`);
    }
  }
  return findings;
}

/** One line per finding, key named. */
export const formatFinding = (f) => `${f.level === "error" ? "error" : "warn"}: ${f.message}`;

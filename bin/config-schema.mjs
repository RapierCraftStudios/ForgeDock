// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bin/config-schema.mjs — forge.yaml schema check (#5315). A setting nobody reads, or one the active engine path
// ignores, must never be silent: `forgedock doctor` fails on it and a batch warns at start. Pure: text in, findings out.
// The sections below mirror docs/CONFIG.md (bin/tests/config-schema.test.mjs fails when a documented section is missing here).
// Nested keys are only checked where a section is listed in CLOSED; elsewhere only the top level and typed keys are.

export const TOP_LEVEL = [
  "project", "paths", "branches", "agents", "repos", "project_board", "orchestration", "orchestrate", "notify", "decisions",
  "hygiene", "pipeline", "execution", "engine", "prod_watch", "selftest", "release", "issue_watch", "followups", "rollouts",
  "post_deploy", "events", "lean", "stats", "verify", "ci", "env", "build", "decomposition", "services", "review", "devdocs",
  "verification", "billing", "adaptive_scripts", "branding", "marketing", "acceptance_probe", "attribution", "autopilot",
  "deploy", "gate", "experiment", "learned", "maintenance", "milestones", "pattern_feeds", "topology", "validate",
];

/** Sections whose direct children are a closed set: another child is an unknown key. */
export const CLOSED = {
  "verification.ci_local": ["mode", "exclude_jobs", "include_jobs", "extra_commands", "services", "budget_minutes", "max_parallel"],
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
  "engine.path": { enum: ["core", "full", "lean", "auto"] },
  "billing.enabled": "bool",
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
    if (/^\s*-(\s|$)/.test(line)) continue;
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
    if (TYPES[key]) {
      const want = typeError(TYPES[key], node);
      if (want) add("error", "wrong-type", key, `"${key}" must be ${want} (got ${node.kind === "scalar" ? JSON.stringify(node.value) : node.kind})`);
    }
  }
  return findings;
}

/** One line per finding, key named. */
export const formatFinding = (f) => `${f.level === "error" ? "error" : "warn"}: ${f.message}`;

#!/usr/bin/env node
/**
 * scripts/bootstrap-validate.mjs — mechanical backlog plan validator for /bootstrap (#4171, part of #4155)
 *
 * Validates a JSON backlog plan BEFORE any issue is created: milestones in build order, issues with plan keys,
 * `#{{KEY}}` placeholders standing in for not-yet-created issue numbers, planned dependencies and bodies.
 * Codebase-agnostic: it reads only the plan, never the repo, so planned (not-yet-existing) paths are fine.
 *
 * Plan shape:
 *   {
 *     "labels":     ["backend", ...],                      // optional: when given, every issue label must be in it
 *     "milestones": [{ "key": "M1", "title": "..." }, ...],  // build order: foundation first
 *     "issues": [{ "key": "API", "title": "...", "milestone": "M1", "labels": ["backend"],
 *                  "deps": ["DB"], "needsHuman": false, "ui": false, "hero": false, "body": "## Problem\n..." }],
 *     "numbers":    { "DB": 12 }                             // optional: real issue numbers once created
 *   }
 *
 * Rejects: invalid-plan, unknown-dep, cycle, forward-milestone-dep, depends-on-mismatch, unresolved-placeholder,
 * missing-section, missing-type-tag, missing-parent, missing-labels, unknown-label, code-depends-on-needs-human,
 * missing-design-spec (a `ui` issue lacks a design-spec item), hero-not-routed (a `hero` issue never names `/design`),
 * missing-needs-human-section (a needs-human issue lacks setup steps, env var names or secret handling) (#4176).
 * `Depends on` lines are read with the engine's own parser (bin/engine/phases.mjs parseDependsOn) after placeholder
 * resolution, so the plan and engine admission agree on what blocks what.
 *
 * Usage:
 *   node scripts/bootstrap-validate.mjs <plan.json>
 *   node scripts/bootstrap-validate.mjs -            # read the plan from stdin
 *
 * Exit codes:
 *   0 = plan valid
 *   1 = plan invalid (one `<KEY>: [code] message` line per error on stderr)
 *   2 = usage error, unreadable file or bad JSON
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDependsOn } from "../bin/engine/phases.mjs";

const NEEDS_HUMAN_LABEL = "needs-human";
const TYPE_TAG_RE = /\[type:(?:api|unit|e2e|manual)\]/;
const CHECKBOX_RE = /^[ \t]*[-*+][ \t]+\[[ xX]\]/;
const PLACEHOLDER_RE = /#\{\{([^{}]*)\}\}/g;
// Synthetic numbers for keys without a real number: far above any real issue number, so they never collide.
const SYNTHETIC_BASE = 1_000_000_000;

// Mandatory Pipeline Issue Template sections (commands/issue.md Phase 3D). Matched case-insensitively on `## ` headings,
// ignoring a trailing parenthetical such as "Root Cause (if known)".
const SECTIONS = ["Problem", "Root Cause", "Affected Files", "Acceptance Criteria", "Context", "Dependencies"];

// UI issues carry a full design spec (#4176): each item must be named somewhere in the body.
const DESIGN_SPEC = [
  ["breakpoints", /breakpoint/i],
  ["empty state", /\bempty\b/i],
  ["loading state", /\bloading\b/i],
  ["error state", /\berror\b/i],
  ["offline state", /\boffline\b/i],
  ["motion", /\bmotion\b/i],
  ["accessibility", /\b(?:accessibility|a11y)\b/i],
  ["dark mode", /\bdark[ -]mode\b/i],
];
// Needs-human issues (#4176): headings for setup steps, env vars and secret handling, plus at least one env var name.
const NEEDS_HUMAN_PARTS = [
  ["setup steps heading", /^#{2,6}[ \t]+.*\bsetup steps\b/im],
  ["environment variables heading", /^#{2,6}[ \t]+.*\b(?:environment variables|env vars)\b/im],
  ["secret handling heading", /^#{2,6}[ \t]+.*\bsecrets?\b/im],
  ["env var name (e.g. `API_KEY`)", /`[A-Z][A-Z0-9]*_[A-Z0-9_]+`/],
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const normHeading = (h) => h.replace(/\([^)]*\)\s*$/, "").trim().toLowerCase();

/** True when the issue is a needs-human issue (credential, account or external input). */
export function isNeedsHuman(issue) {
  return issue?.needsHuman === true || (Array.isArray(issue?.labels) && issue.labels.includes(NEEDS_HUMAN_LABEL));
}

/**
 * Replace every `#{{KEY}}` whose KEY is in `keyToNumber` with `#N`. Unknown keys are left in place.
 * @param {string} body
 * @param {Record<string, number>|Map<string, number>} keyToNumber
 */
export function resolvePlaceholders(body, keyToNumber) {
  const map = keyToNumber instanceof Map ? keyToNumber : new Map(Object.entries(keyToNumber ?? {}));
  return String(body ?? "").replace(PLACEHOLDER_RE, (whole, key) => {
    const n = map.get(key);
    return Number.isSafeInteger(n) && n > 0 ? `#${n}` : whole;
  });
}

/** `## ` sections of a markdown body (fenced code blocks ignored): normalized heading -> content lines. */
function sections(body) {
  const out = new Map();
  let current = null;
  let fence = null;
  for (const line of String(body).replace(/\r\n/g, "\n").split("\n")) {
    const f = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      if (current) current.push(line);
      continue;
    }
    const h = !fence && line.match(/^##(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (h) {
      current = [];
      const name = normHeading(h[1]);
      if (!out.has(name)) out.set(name, current);
      continue;
    }
    if (current) current.push(line);
  }
  return out;
}

function checkStructure(plan) {
  const errors = [];
  const bad = (message) => errors.push({ issue: null, code: "invalid-plan", message });
  if (!isObj(plan)) return [{ issue: null, code: "invalid-plan", message: "plan must be a JSON object" }];
  if (!Array.isArray(plan.milestones) || plan.milestones.length === 0) bad("`milestones` must be a non-empty array");
  if (!Array.isArray(plan.issues) || plan.issues.length === 0) bad("`issues` must be a non-empty array");
  if (plan.labels !== undefined && !(Array.isArray(plan.labels) && plan.labels.every(isNonEmptyString))) {
    bad("`labels` must be an array of strings when given");
  }
  if (plan.numbers !== undefined && !isObj(plan.numbers)) bad("`numbers` must be an object of KEY -> issue number");
  if (errors.length) return errors;

  const milestoneKeys = new Set();
  plan.milestones.forEach((m, i) => {
    if (!isObj(m) || !isNonEmptyString(m.key)) return bad(`milestones[${i}] needs a string \`key\``);
    if (milestoneKeys.has(m.key)) bad(`duplicate milestone key ${m.key}`);
    milestoneKeys.add(m.key);
  });
  const issueKeys = new Set();
  plan.issues.forEach((it, i) => {
    if (!isObj(it) || !isNonEmptyString(it.key)) return bad(`issues[${i}] needs a string \`key\``);
    const at = (message) => errors.push({ issue: it.key, code: "invalid-plan", message });
    if (issueKeys.has(it.key)) at(`duplicate issue key ${it.key}`);
    issueKeys.add(it.key);
    if (!isNonEmptyString(it.title)) at("needs a non-empty `title`");
    if (!milestoneKeys.has(it.milestone)) at(`unknown milestone ${JSON.stringify(it.milestone)}`);
    if (it.deps !== undefined && !(Array.isArray(it.deps) && it.deps.every(isNonEmptyString))) {
      at("`deps` must be an array of issue keys");
    }
    if (it.labels !== undefined && !(Array.isArray(it.labels) && it.labels.every((l) => typeof l === "string"))) {
      at("`labels` must be an array of strings");
    }
    if (typeof it.body !== "string") at("needs a string `body`");
    for (const f of ["ui", "hero"]) if (it[f] !== undefined && typeof it[f] !== "boolean") at(`\`${f}\` must be a boolean`);
  });
  return errors;
}

/** Issue keys on dependency cycles, each with one cycle path through it (DFS over known deps). */
function findCycles(issues, byKey) {
  const state = new Map(); // key -> 1 visiting | 2 done
  const stack = [];
  const onCycle = new Map();
  const visit = (key) => {
    state.set(key, 1);
    stack.push(key);
    for (const d of byKey.get(key).deps ?? []) {
      if (!byKey.has(d)) continue;
      if (state.get(d) === 1) {
        const path = [...stack.slice(stack.indexOf(d)), d];
        for (const k of path) if (!onCycle.has(k)) onCycle.set(k, path);
      } else if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(key, 2);
  };
  for (const it of issues) if (!state.has(it.key)) visit(it.key);
  return onCycle;
}

/**
 * Validate a backlog plan. Never throws on bad input; structural problems come back as `invalid-plan` errors.
 * @returns {{ ok: boolean, errors: Array<{ issue: string|null, code: string, message: string }> }}
 */
export function validatePlan(plan) {
  const structural = checkStructure(plan);
  if (structural.length) return { ok: false, errors: structural };

  const errors = [];
  const { issues, milestones } = plan;
  const err = (issue, code, message) => errors.push({ issue, code, message });
  const byKey = new Map(issues.map((it) => [it.key, it]));
  const milestoneIndex = new Map(milestones.map((m, i) => [m.key, i]));
  const declaredLabels = Array.isArray(plan.labels) ? new Set(plan.labels) : null;

  // Every plan key resolves: to its real number when known, else to a unique synthetic one.
  const keyToNumber = new Map();
  issues.forEach((it, i) => {
    const real = plan.numbers?.[it.key];
    keyToNumber.set(it.key, Number.isSafeInteger(real) && real > 0 ? real : SYNTHETIC_BASE + i);
  });
  const numberToKey = new Map([...keyToNumber].map(([k, n]) => [n, k]));

  const cycles = findCycles(issues, byKey);

  for (const it of issues) {
    const deps = it.deps ?? [];
    const myMilestone = milestoneIndex.get(it.milestone);

    for (const d of deps) {
      const dep = byKey.get(d);
      if (!dep) {
        err(it.key, "unknown-dep", `depends on ${d}, which is not an issue in the plan`);
        continue;
      }
      const depMilestone = milestoneIndex.get(dep.milestone);
      if (depMilestone > myMilestone) {
        err(it.key, "forward-milestone-dep",
          `in milestone ${it.milestone} but depends on ${d} in later milestone ${dep.milestone}`);
      }
      if (!isNeedsHuman(it) && isNeedsHuman(dep)) {
        err(it.key, "code-depends-on-needs-human",
          `code issue depends on needs-human issue ${d}; reference it for real credentials, but keep mocks so it never blocks`);
      }
    }
    if (cycles.has(it.key)) err(it.key, "cycle", `dependency cycle: ${cycles.get(it.key).join(" -> ")}`);

    const labels = it.labels ?? [];
    if (labels.filter(isNonEmptyString).length === 0) err(it.key, "missing-labels", "issue has no labels");
    if (declaredLabels) {
      for (const l of labels) {
        if (isNonEmptyString(l) && !declaredLabels.has(l)) err(it.key, "unknown-label", `label ${l} is not in the plan's labels`);
      }
    }

    const resolved = resolvePlaceholders(it.body, keyToNumber);
    const unresolved = [...new Set([...resolved.matchAll(PLACEHOLDER_RE)].map((m) => m[0]))];
    for (const p of unresolved) err(it.key, "unresolved-placeholder", `${p} does not match any issue key in the plan`);

    const declared = new Set();
    const strays = [];
    for (const n of parseDependsOn(resolved)) {
      if (numberToKey.has(n)) declared.add(numberToKey.get(n));
      else strays.push(`#${n}`);
    }
    const planned = new Set(deps);
    const missing = [...planned].filter((k) => !declared.has(k));
    const extra = [...declared].filter((k) => !planned.has(k)).concat(strays);
    if (missing.length || extra.length) {
      const parts = [];
      if (missing.length) parts.push(`planned but not declared: ${missing.join(", ")}`);
      if (extra.length) parts.push(`declared but not planned: ${extra.join(", ")}`);
      err(it.key, "depends-on-mismatch", `\`Depends on\` lines differ from planned deps (${parts.join("; ")})`);
    }

    const secs = sections(it.body);
    for (const name of SECTIONS) {
      if (!secs.has(name.toLowerCase())) err(it.key, "missing-section", `missing \`## ${name}\` section`);
    }
    const ac = secs.get("acceptance criteria");
    if (ac) {
      const items = ac.filter((l) => CHECKBOX_RE.test(l));
      if (items.length === 0) err(it.key, "missing-section", "`## Acceptance Criteria` has no `- [ ]` checklist items");
      const untagged = items.filter((l) => !TYPE_TAG_RE.test(l));
      if (untagged.length) {
        err(it.key, "missing-type-tag",
          `${untagged.length} acceptance criteria lack a [type:api|unit|e2e|manual] tag: ${untagged[0].trim()}`);
      }
    }
    const ctx = secs.get("context");
    if (ctx && !ctx.some((l) => l.includes("**Parent**"))) err(it.key, "missing-parent", "`## Context` has no `**Parent**` line");

    if (it.ui === true) {
      const lacking = DESIGN_SPEC.filter(([, re]) => !re.test(it.body)).map(([name]) => name);
      if (lacking.length) err(it.key, "missing-design-spec", `UI issue design spec lacks: ${lacking.join(", ")}`);
    }
    if (it.hero === true && !/(^|[^\w/])\/design\b/.test(it.body)) {
      err(it.key, "hero-not-routed", "hero surface issue does not route to `/design`");
    }
    if (isNeedsHuman(it)) {
      const lacking = NEEDS_HUMAN_PARTS.filter(([, re]) => !re.test(it.body)).map(([name]) => name);
      if (lacking.length) err(it.key, "missing-needs-human-section", `needs-human issue lacks: ${lacking.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** One `<KEY>: [code] message` line per error; plan-level errors use `(plan)`. */
export function formatErrors(errors) {
  return errors.map((e) => `${e.issue ?? "(plan)"}: [${e.code}] ${e.message}`).join("\n");
}

function main(argv) {
  const arg = argv[0];
  if (!arg || argv.length > 1) {
    process.stderr.write("usage: node scripts/bootstrap-validate.mjs <plan.json|->\n");
    return 2;
  }
  let raw;
  try {
    raw = readFileSync(arg === "-" ? 0 : arg, "utf8");
  } catch (e) {
    process.stderr.write(`bootstrap-validate: cannot read ${arg}: ${e.message}\n`);
    return 2;
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`bootstrap-validate: invalid JSON: ${e.message}\n`);
    return 2;
  }
  const { ok, errors } = validatePlan(plan);
  if (!ok) {
    process.stderr.write(formatErrors(errors) + "\n");
    process.stderr.write(`bootstrap-validate: ${errors.length} error(s)\n`);
    return 1;
  }
  process.stdout.write(`bootstrap-validate: OK (${plan.issues.length} issues, ${plan.milestones.length} milestones)\n`);
  return 0;
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}

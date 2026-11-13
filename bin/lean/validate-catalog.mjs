// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5653: deterministic helpers for validate-command executability (0 LLM calls). A catalogue of rewrite entries
 * ({match, replace}, the shape of forge.yaml `validate.recipes`) is derived from the commands the repo's own CI runs;
 * forge.yaml recipes always come first. Also: test-id extraction and the equivalent-substitute verdict, and the
 * base-drift classifier. Pure; lean.mjs owns every effect.
 */

import { venvPythonRewrite } from "./preflight.mjs";

/** Default CI sources read for the derived catalogue (repo-relative). */
export const DEFAULT_CATALOG_SOURCES = [".github/workflows/ci.yml", "scripts/ci-local.sh"];

const PY_RUNNER_RE = /\b(uv run(?: +--[\w-]+(?:[ =][^\s|&;-][^\s|&;]*)?)* +)(?:python3? +-m +)?pytest\b/; // an option value never starts with "-" (no ambiguous backtracking)
const JS_RUNNER_RE = /\b(pnpm exec|npx|yarn) +(vitest|jest)\b/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Entries derived from CI text: the repo's own pytest runner prefix replaces `poetry run pytest` / bare `.venv/bin/pytest`
 * a plan guessed, and its own JS runner replaces another one. Empty when CI shows no such runner.
 */
export function deriveCatalog(texts) {
  const text = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === "string").join("\n");
  const out = [];
  const py = PY_RUNNER_RE.exec(text);
  if (py) {
    const prefix = py[1].trim();
    out.push({ match: "\\bpoetry run (?:python3? -m )?pytest\\b", replace: `${prefix} pytest` });
    out.push({ match: "(?:\\./)?(?:[\\w./-]*/)?\\.venv/bin/pytest\\b", replace: `${prefix} pytest` });
  }
  const js = JS_RUNNER_RE.exec(text);
  if (js) {
    const alt = ["pnpm exec", "npx", "yarn"].filter((r) => r !== js[1]);
    out.push({ match: `\\b(?:${alt.map(esc).join("|")}) +(vitest|jest)\\b`, replace: `${js[1]} $1` });
  }
  return out;
}

/** forge.yaml recipes first, derived entries after, one entry per `match`. */
export function mergeRecipes(recipes, derived) {
  const seen = new Set(), out = [];
  for (const r of [...(Array.isArray(recipes) ? recipes : []), ...(Array.isArray(derived) ? derived : [])]) {
    if (!r || !r.match || seen.has(String(r.match))) continue;
    seen.add(String(r.match)); out.push(r);
  }
  return out;
}

/**
 * Rewrite only the commands of `ids` (the ones preflight found unrunnable) from `entries`. `apply` is applyValidateRecipes.
 * Returns {contract, applied[{id, from, to}]}; the contract is the input when nothing changed.
 */
export function rewriteMissed(contract, entries, ids, apply) {
  const want = new Set(ids ?? []);
  if (!want.size || !entries?.length || !contract || typeof contract !== "object") return { contract, applied: [] };
  const r = apply(contract, entries);
  const applied = r.applied.filter((a) => want.has(a.id));
  if (!applied.length) return { contract, applied: [] };
  const to = new Map(applied.map((a) => [a.id, a.to]));
  const out = { ...contract };
  if (Array.isArray(contract.validate)) out.validate = contract.validate.map((v) => (v && to.has(v.id) ? { ...v, command: to.get(v.id) } : v));
  const t = contract.repro_test;
  if (t && typeof t === "object" && to.has("repro_test")) out.repro_test = { ...t, command: to.get("repro_test") };
  if (Array.isArray(contract.test_plan)) out.test_plan = contract.test_plan.map((p) => (p && to.has(`test_plan ${p.requirement}`) ? { ...p, command: to.get(`test_plan ${p.requirement}`) } : p));
  return { contract: out, applied };
}

/** The tests a runner's output names, as Map(id -> passed): pytest `path::name PASSED`, TAP `ok N - name`, vitest/jest `✓ name`. */
export function extractTests(output) {
  const tests = new Map();
  for (const line of String(output ?? "").split("\n")) {
    let m;
    if ((m = /^\s*(?:(PASSED|FAILED|ERROR)\s+)?([\w./-]+::[\w:.\[\]-]+)(?:\s+(PASSED|FAILED|ERROR))?/.exec(line))) { const st = m[1] ?? m[3]; if (st) tests.set(m[2], st === "PASSED"); }
    else if ((m = /^\s*(not )?ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line))) tests.set(m[2].trim(), !m[1]);
    else if ((m = /^\s*([✓✔×✗])\s+(.+?)(?:\s+\d+\s*ms)?$/.exec(line))) tests.set(m[2].trim(), m[1] === "✓" || m[1] === "✔");
  }
  return tests;
}
/** The test ids a runner's output names. */
export const extractTestIds = (output) => new Set(extractTests(output).keys());

/**
 * A substitute is equivalent to a frozen command that exited non-zero only when both ran the same test ids, every one of
 * them passed in both runs (the frozen exit came from the runner, not a test), and the substitute exited 0. A failing
 * test, a failing substitute, other ids or no ids is never equivalent. `frozen` and `sub` are {rc, output}.
 */
export function equivalentRuns(frozen, sub) {
  if (!frozen || !sub || sub.rc !== 0) return false;
  const a = extractTests(frozen.output), b = extractTests(sub.output);
  return a.size > 0 && a.size === b.size && [...a].every(([id, ok]) => ok && b.get(id) === true);
}

const DRIFT_RE = /(?:generated|artifact|snapshot)s?\b[^\n]*\b(?:out of date|out-of-date|stale|differ|drift|not up to date)|\b(?:out of date|stale)\b[^\n]*\b(?:generated|regenerate)|run [`'"]?[^\n]*\bgenerate[\w:-]*[`'"]? to (?:update|regenerate)/i;
/** True when a validate failure's output reads as a stale generated artifact (a regenerate case), not a failing test. */
export const isDriftFailure = (output) => DRIFT_RE.test(String(output ?? ""));

/**
 * #5683: the repro and validate commands that run a bare `python -m pytest` / `pytest` inside a sub-project with a tracked
 * Python manifest and a `.venv` run through that venv's interpreter. Returns {contract, applied[{id, from, to}]}.
 */
export function rewriteSubprojectVenv(contract, files, exists) {
  if (!contract || typeof contract !== "object") return { contract, applied: [] };
  const applied = [], fix = (id, cmd) => { const to = venvPythonRewrite(cmd, files, exists); if (to !== cmd) applied.push({ id, from: cmd, to }); return to; };
  const out = { ...contract };
  if (Array.isArray(contract.validate)) out.validate = contract.validate.map((v) => (v && typeof v.command === "string" ? { ...v, command: fix(v.id, v.command) } : v));
  const t = contract.repro_test;
  if (t && typeof t === "object" && typeof t.command === "string") out.repro_test = { ...t, command: fix("repro_test", t.command) };
  return applied.length ? { contract: out, applied } : { contract, applied };
}

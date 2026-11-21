// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5653: deterministic helpers for validate-command executability (0 LLM calls). A catalogue of rewrite entries
 * ({match, replace}, the shape of forge.yaml `validate.recipes`) is derived from the commands the repo's own CI runs;
 * forge.yaml recipes always come first. Also: test-id extraction and the equivalent-substitute verdict, and the
 * base-drift classifier. Pure; lean.mjs owns every effect.
 */

import { posix } from "node:path";
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

const CI_PY_RUNNER_RE = /\b((?:poetry|uv) run(?: +--[\w-]+(?:[ =][^\s|&;-][^\s|&;]*)?)*) +(?:python3? +-m +)?pytest\b([^\n|&;]*)/; // PY_RUNNER_RE's option grammar
const PYTEST_SEG_RE = /^(\s*(?:[A-Za-z_]\w*=\S*\s+)*)((?:\S*\/)?\.venv\/bin\/python3?\s+-m\s+pytest|(?:\S*\/)?\.venv\/bin\/pytest|python3?(?:\.\d+)?\s+-m\s+pytest|pytest)(?=\s|$)(.*)$/s;
const normRel = (p) => { const n = posix.normalize(String(p).replace(/^\.\//, "").replace(/\/+$/, "")); return n === "" ? "." : n.replace(/\/+$/, ""); };
const under = (p, root) => (root === "." ? !p.startsWith("..") : p === root || p.startsWith(`${root}/`));
const pathish = (x) => !!x && !x.startsWith("-") && !x.startsWith("$") && !x.includes("=") && (x.includes("/") || /\.py(?:::|$)/.test(x) || x === ".");
const indent = (l) => /^\s*/.exec(l)[0].length;

/**
 * #5753: which env the repo's own CI runs each Python test path in, parsed from CI text (0 LLM calls). Every `poetry run` /
 * `uv run` pytest line, with its step's `working-directory:` (and an inline `cd X &&`), becomes {dir, runner, paths}: `paths`
 * are repo-relative (`../../shared` under `services/worker` is `shared`); no path argument means the whole `dir`. Pure.
 */
export function deriveTestEnvMap(texts) {
  const out = [], seen = new Set();
  for (const text of (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === "string")) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = CI_PY_RUNNER_RE.exec(lines[i]);
      if (!m) continue;
      let s = i;
      while (s > 0 && !/^\s*-\s/.test(lines[s])) s--; // the step this line belongs to
      let e = s + 1;
      while (e < lines.length && !(lines[e].trim() && indent(lines[e]) <= indent(lines[s]))) e++;
      const wd = lines.slice(s, e).map((l) => /^\s*-?\s*working-directory:\s*["']?([^"'\s#]+)/.exec(l)).find(Boolean);
      if (wd && wd[1].includes("$")) continue;
      let dir = wd ? normRel(wd[1]) : ".";
      const cd = /\bcd\s+["']?([^"'\s&;]+)["']?\s*&&[^&|;]*$/.exec(lines[i].slice(0, m.index));
      if (cd) {
        if (cd[1].includes("$") || cd[1].startsWith("/")) continue;
        dir = normRel(posix.join(dir, cd[1]));
      }
      if (dir.startsWith("..")) continue;
      const args = m[2].trim().split(/\s+/).filter(pathish).map((x) => x.replace(/::.*$/, ""));
      const paths = (args.length ? args : ["."]).map((p) => normRel(posix.join(dir, p))).filter((p) => !p.startsWith(".."));
      const runner = m[1].trim(), key = `${dir}|${runner}|${paths.join(",")}`;
      if (paths.length && !seen.has(key)) { seen.add(key); out.push({ dir, runner, paths }); }
    }
  }
  return out;
}

/** #5753: one pytest segment run from `cwd` -> {dir, cmd} in its CI env (or its lock's runner), or null when it stays. */
function ciEnvSegment(seg, cwd, map, files, exists) {
  const m = PYTEST_SEG_RE.exec(seg);
  if (!m) return null;
  const [, envs, interp, rest] = m;
  const venv = /^(\S*?)\.venv\/bin\/(\S+)/.exec(interp);
  if (venv && exists(normRel(posix.join(cwd, `${venv[1]}.venv/bin/${venv[2]}`)))) return null; // #5683: a venv that resolves stays
  const toks = rest.trim() ? rest.trim().split(/\s+/) : [];
  const tests = toks.filter(pathish).map((x) => normRel(posix.join(cwd, x.replace(/::.*$/, ""))));
  const all = tests.length ? tests : [cwd];
  const hit = all.some((p) => p.startsWith("..")) ? null : map.find((en) => all.every((p) => en.paths.some((root) => under(p, root))));
  if (hit) {
    const reRel = (x) => { const [p, ...id] = x.split("::"); return [posix.relative(hit.dir === "." ? "" : hit.dir, normRel(posix.join(cwd, p))) || ".", ...id].join("::"); };
    const args = toks.map((x) => (pathish(x) ? reRel(x) : x));
    return { dir: hit.dir, cmd: `${envs}${hit.runner} pytest${args.length ? ` ${args.join(" ")}` : ""}` };
  }
  if (!venv) return null; // a bare interpreter CI does not map stays (rewriteSubprojectVenv owns the sub-project venv case)
  const proj = normRel(posix.join(cwd, venv[1] || "."));
  if (proj !== cwd) return null;
  const at = (f) => (proj === "." ? f : `${proj}/${f}`);
  const runner = files.includes(at("poetry.lock")) ? "poetry run" : files.includes(at("uv.lock")) ? "uv run" : null;
  return runner ? { dir: cwd, cmd: `${envs}${runner} pytest${rest.replace(/\s+$/, "")}` } : null;
}

/**
 * #5753: the repro and validate pytest commands that run under a bare interpreter (`python -m pytest`, `pytest`) or a
 * `.venv/bin/python` that does not exist, for test paths CI runs in another env (`map`: deriveTestEnvMap), become
 * `cd <dir> && <runner> pytest <dir-relative paths>`. With no map entry, a missing `.venv` with a poetry.lock / uv.lock next
 * to it runs through `poetry run` / `uv run`. Commands already using poetry/uv run, a venv that resolves and unmapped bare
 * commands are unchanged. `files`: tracked paths; `exists(rel)`: repo-relative check. Returns {contract, applied[{id, from, to}]}.
 */
export function rewriteToCiEnv(contract, map = [], files = [], exists = () => false) {
  if (!contract || typeof contract !== "object") return { contract, applied: [] };
  const fix1 = (command) => {
    const parts = String(command).split(/(&&|\|\||;|\||\n)/);
    let cwd = ".", onlyCd = true, changed = false;
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      if (i % 2) { out.push(seg); continue; }
      const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(seg);
      if (cd) {
        const t = cd[1] ?? cd[2] ?? cd[3];
        cwd = cwd === "?" || t.startsWith("/") || t.startsWith("$") ? "?" : normRel(posix.join(cwd, t));
        if (cwd.startsWith("..")) cwd = "?";
        out.push(seg); continue;
      }
      const r = cwd === "?" || /\b(?:poetry|uv)\s+(?:-\S+\s+)*run\b/.test(seg) ? null : ciEnvSegment(seg, cwd, map, files, exists);
      if (!r) { onlyCd = false; out.push(seg); continue; }
      changed = true;
      const lead = /^\s*/.exec(seg)[0], tail = /\s*$/.exec(seg)[0], cmd = r.cmd.trim(), last = i === parts.length - 1;
      if (onlyCd && last) { out.length = 0; out.push(r.dir === "." ? cmd : `cd ${r.dir} && ${cmd}`); } // leading cds give way to the env's dir
      else if (r.dir === cwd) out.push(`${lead}${cmd}${tail}`);
      else { const rel = posix.relative(cwd === "." ? "" : cwd, r.dir === "." ? "" : r.dir) || "."; out.push(`${lead}${last ? `cd ${rel} && ${cmd}` : `(cd ${rel} && ${cmd})`}${tail}`); } // later segments keep their cwd
      onlyCd = false;
    }
    return changed ? out.join("") : String(command);
  };
  const applied = [], fix = (id, cmd) => { const to = fix1(cmd); if (to !== cmd) applied.push({ id, from: cmd, to }); return to; };
  const out = { ...contract };
  if (Array.isArray(contract.validate)) out.validate = contract.validate.map((v) => (v && typeof v.command === "string" ? { ...v, command: fix(v.id, v.command) } : v));
  const t = contract.repro_test;
  if (t && typeof t === "object" && typeof t.command === "string") out.repro_test = { ...t, command: fix("repro_test", t.command) };
  return applied.length ? { contract: out, applied } : { contract, applied };
}

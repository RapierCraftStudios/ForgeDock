// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guard gate (#4693): execution-based, no pattern matching on diff text. A lane whose diff changes lines a merged fix
 * protected (git blame on the lane's merge base names the guard's merge commit, or a later commit that kept the lines), or
 * edits/deletes a guard's test file, reruns that guard's test files *as they exist on base* against the lane's tree. A
 * failure is `conformance.guard_broken` (builder resumed once). The only override is a `supersedes` amendment (conformance.mjs).
 * Deterministic, 0 LLM calls; a lane touching nothing guarded does one local index read and no git work.
 */
import * as nodeFs from "node:fs";
import { dirname, extname, join } from "node:path";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { collectGuards, guardsIndexPath, readIndex, writeIndex } from "./guards.mjs";
import { isTestPath } from "./enumerating.mjs";

export const GUARD_CAP_MS = 120000;
export const INDEX_MAX_AGE_MS = 6 * 3600000;
const TIMEOUT_RC = 124;
const SLACK = 10; // lines a guarded hunk may have drifted since its merge when only a later commit kept it
const SHA_RE = /^[0-9a-f]{40}$/;
const ok = async (fn) => { try { await fn(); return true; } catch { return false; } };
const norm = (p) => String(p ?? "").replace(/^\.\//, "");

/** Guards from the local index; rebuilt from the GitHub register when absent or older than INDEX_MAX_AGE_MS (a stale index is still used when GitHub is unreachable). */
export async function loadGuards({ repo, gh, root, fs = nodeFs, now = Date.now() }) {
  const cached = readIndex(repo, { root, fs });
  let age = Infinity;
  try { age = now - fs.statSync(guardsIndexPath(repo, root)).mtimeMs; } catch { /* no index yet */ }
  if (cached && age < INDEX_MAX_AGE_MS) return cached;
  try { const g = await collectGuards({ gh, repo }); writeIndex(repo, g, { root, fs }); return g; } catch { return cached ?? []; }
}

/** Old-side line ranges of a `git diff -U0` text for non-test files: {file: [[start, end]]}. Pure insertions touch no old line. */
export function oldRanges(diff) {
  const out = {};
  let file = null;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("--- ")) { file = line === "--- /dev/null" ? null : line.replace(/^--- a\//, ""); continue; }
    if (line.startsWith("+++ ")) { if (line === "+++ /dev/null") continue; continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (!m || !file || isTestPath(file)) continue;
    const start = Number(m[1]), len = m[2] === undefined ? 1 : Number(m[2]);
    if (len > 0) (out[file] ??= []).push([start, start + len - 1]);
  }
  return out;
}

/** Commit shas that last touched lines a..b of `file` at `rev` (git blame --porcelain). */
export function blameShas(text) {
  const shas = new Set();
  for (const l of String(text ?? "").split("\n")) { const s = l.split(" ")[0]; if (SHA_RE.test(s)) shas.add(s); }
  return shas;
}

/**
 * The guards a lane's diff intersects, each with why it was selected: {guard, reason}. `files` are the lane's changed paths.
 * Guards whose hunk files and test files the lane does not touch are never looked at (no git calls).
 */
export async function selectGuards({ guards, files, git, base }) {
  const changed = new Set((files ?? []).map(norm));
  const cands = (guards ?? []).filter((g) => (g.hunks ?? []).some((h) => changed.has(norm(h.file))) || (g.tests ?? []).some((t) => changed.has(norm(t.path))));
  if (!cands.length) return { selected: [], mergeBase: null };
  const mergeBase = String(await git(["merge-base", base, "HEAD"])).trim();
  const hunkFiles = [...new Set(cands.flatMap((g) => (g.hunks ?? []).map((h) => norm(h.file))).filter((f) => changed.has(f)))];
  const ranges = hunkFiles.length ? oldRanges(String(await git(["diff", "-U0", "--no-renames", `${base}...HEAD`, "--", ...hunkFiles]))) : {};
  const blamed = new Map(); // `${file}:${a}-${b}` -> Set(sha)
  const shasOf = async (file, [a, b]) => {
    const k = `${file}:${a}-${b}`;
    if (!blamed.has(k)) blamed.set(k, blameShas(await git(["blame", "--porcelain", "-L", `${a},${b}`, mergeBase, "--", file]).catch(() => "")));
    return blamed.get(k);
  };
  const selected = [];
  for (const g of cands) {
    const sha = String(g.merge_sha ?? "");
    const known = SHA_RE.test(sha) || sha.length >= 7 ? await ok(() => git(["cat-file", "-e", `${sha}^{commit}`])) : false;
    let reason = null;
    for (const h of g.hunks ?? []) {
      const f = norm(h.file);
      for (const r of ranges[f] ?? []) {
        const near = r[0] <= h.end + SLACK && r[1] >= h.start - SLACK;
        if (!known) { if (near) reason = `lines ${r[0]}-${r[1]} of ${f} overlap the protected hunk (merge commit not local)`; }
        else if (near) {
          for (const s of await shasOf(f, r)) {
            if (s === sha || (s.startsWith(sha) && sha.length >= 7) || sha.startsWith(s) || await ok(() => git(["merge-base", "--is-ancestor", sha, s]))) { reason = `lines ${r[0]}-${r[1]} of ${f} last changed by ${s.slice(0, 10)}, which carries the fix`; break; }
          }
        }
        if (reason) break;
      }
      if (reason) break;
    }
    if (!reason) { const t = (g.tests ?? []).find((x) => changed.has(norm(x.path))); if (t) reason = `the lane edits or deletes its test ${t.path}`; }
    if (reason) selected.push({ guard: g, reason });
  }
  return { selected, mergeBase };
}

/**
 * The command that runs one test file: the repo's `verify.guard_command` template for the extension (`{path}` substituted,
 * or the path appended), else the contract's own validate command with that path substituted, else a per-extension
 * default; null when unknown. The command runs from the worktree root with the repo-relative path.
 */
export function commandFor(path, contract, guardCommand = {}) {
  const ext = extname(path);
  const tpl = String(guardCommand?.[ext.toLowerCase()] ?? "").trim();
  if (tpl) return tpl.includes("{path}") ? tpl.replaceAll("{path}", path) : `${tpl} ${path}`;
  for (const v of contract?.validate ?? []) {
    const cmd = String(v?.command ?? "");
    if (/(?:^|\s)(?:-k|-t|--grep|--test-name-pattern|--testNamePattern)(?:\s|=)|::/.test(cmd)) continue;
    const toks = cmd.match(/[^\s"']+/g) ?? [];
    const tests = toks.filter((t) => extname(t) === ext && isTestPath(t));
    if (tests.length === 1 && /\b(?:node|pytest|python3?|vitest|jest|npx|pnpm|npm|yarn|bun)\b/.test(cmd)) return cmd.replace(tests[0], path);
  }
  if ([".mjs", ".cjs", ".js"].includes(ext)) return `node --test ${path}`;
  if (ext === ".py") return `python -m pytest -q ${path}`;
  return null;
}

/** Sibling path for the base copy of a test file, so its relative imports resolve against the lane's tree. */
export const basePathOf = (path) => { const e = extname(path); return `${path.slice(0, path.length - e.length)}__guardbase${e}`; };

const tailOf = (out) => String(out ?? "").split("\n").filter((l) => l.trim()).slice(-40).join("\n").slice(-1500);

/**
 * Rerun the selected guards' base test files against the lane tree, in a small pool, under one wall-time cap.
 * Returns {failures, runs, skipped[], ms}. A test that cannot be run (no base copy, unknown runner, over the cap) is skipped, never a failure.
 */
export async function runGuards({ selected, mergeBase, contract, guardCommand, git, runCommand, cwd, env, capMs = GUARD_CAP_MS, parallelism = 2, fs = nodeFs, now = Date.now }) {
  const t0 = now(), skipped = [], runs = [], jobs = [];
  for (const { guard } of selected) {
    for (const t of guard.tests ?? []) {
      const path = norm(t.path), copy = basePathOf(path), command = commandFor(copy, contract, guardCommand);
      if (!command) { skipped.push(`#${guard.issue} ${path}: no runner known for ${extname(path) || "this file"}`); continue; }
      jobs.push({ guard, path, copy, command });
    }
  }
  const made = [];
  try {
    const queue = jobs.slice();
    const work = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        const left = capMs - (now() - t0);
        if (left <= 0) { skipped.push(`#${j.guard.issue} ${j.path}: over the ${Math.round(capMs / 1000)}s guard cap`); continue; }
        let body;
        try { body = await git(["show", `${mergeBase}:${j.path}`]); } catch { skipped.push(`#${j.guard.issue} ${j.path}: not on base`); continue; }
        const abs = join(cwd, j.copy);
        try { fs.mkdirSync(dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); made.push(abs); } catch (e) { skipped.push(`#${j.guard.issue} ${j.path}: ${String(e?.message ?? e).slice(0, 80)}`); continue; }
        let r;
        try { r = await runCommand({ command: j.command, cwd, timeoutMs: left, env }); } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
        if (r?.rc === TIMEOUT_RC) { skipped.push(`#${j.guard.issue} ${j.path}: over the ${Math.round(capMs / 1000)}s guard cap`); continue; }
        if (r?.rc === 127) { skipped.push(`#${j.guard.issue} ${j.path}: runner unavailable`); continue; }
        runs.push({ issue: j.guard.issue, why: j.guard.why, test: j.path, command: j.command, rc: Number.isInteger(r?.rc) ? r.rc : 1, output: String(r?.output ?? "") });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallelism, jobs.length)) }, work));
  } finally {
    for (const p of made) { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } }
  }
  return { failures: guardFailures(runs), runs, skipped, ms: now() - t0 };
}

/** conformance.guard_broken rows (one per failing guard test): the guard's issue, its one-line why, the failing test and its output tail. */
export function guardFailures(runs) {
  return (runs ?? []).filter((r) => r.rc !== 0).map((r) => ({
    code: OUTCOME_CODES.CONFORMANCE_GUARD_BROKEN, kind: "guard_broken", guard: `#${r.issue}`, test: r.test,
    detail: `guard #${r.issue} broken (${String(r.why ?? "").slice(0, 200)}): base test ${r.test} fails against your tree (\`${r.command}\`, exit ${r.rc}):\n${tailOf(r.output)}`,
  }));
}

/** The comment the engine posts on a guarded issue once its guard is superseded. */
export const supersessionComment = ({ guard, pr, why }) => `The fix guard from ${guard} was superseded by PR #${pr}: ${String(why ?? "").trim()}\n\nThe lane's contract carried a \`supersedes\` amendment the reviewer accepted; this guard's test no longer describes current behaviour.`;

/** Guard ids the effective contract's accepted supersedes amendments retire, limited to guards the gate selected. */
export function supersededIds(contract, selected) {
  const sel = new Set((selected ?? []).map((s) => `#${s.guard.issue}`));
  return (contract?.supersedes ?? []).filter((s) => sel.has(s.guard));
}

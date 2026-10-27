// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fix guards (#4692): a merged lane whose frozen contract names a regression/repro test records a guard on its issue as
 * `<!-- FORGE:GUARD {json} -->`: {v, issue, pr, merge_sha, tests:[{path, ids}], hunks:[{file, start, end, symbol}], why}.
 * GitHub is the register; `~/.forge/guards/<repo>.json` is a cache rebuilt from those comments. Codebase-agnostic and
 * deterministic (0 LLM calls): test identity comes from the contract's repro_test and validate commands, never from a
 * language parser; without per-test ids a guard is file-granular (ids: []). Protected hunks come from the merged diff
 * against the merge commit's first parent, which is the base for both merge-commit and squash merges.
 */
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTestPath } from "./enumerating.mjs";
import { parseContractComment } from "./render.mjs";

export const GUARD_MARKER = "FORGE:GUARD";
const GUARD_RE = /<!-- FORGE:GUARD (\{[\s\S]*?\}) -->/;
const PATHISH = /^[\w@.+/-]+\.[A-Za-z0-9]+$/;
const hasMarker = (b) => GUARD_RE.test(String(b ?? ""));

export const guardsIndexPath = (repo, root = join(homedir(), ".forge", "guards")) => join(root, `${String(repo).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/** Test ids a validate/repro command names: `-k expr`, `--test-name-pattern x`, `-t x`, `--grep x`, and `file::name` pytest ids. */
function idsOf(command, path) {
  const toks = String(command ?? "").match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? [];
  const unq = (t) => t.replace(/^(["'])(.*)\1$/, "$2");
  const ids = [];
  toks.forEach((t, i) => {
    const v = unq(t);
    if (/^(?:-k|-t|--grep|--test-name-pattern|--testNamePattern)$/.test(v) && toks[i + 1]) ids.push(unq(toks[i + 1]));
    else if (/^--(?:k|grep|test-name-pattern|testNamePattern)=/.test(v)) ids.push(unq(v.split("=").slice(1).join("=")));
    else if (v.startsWith(`${path}::`)) ids.push(v.slice(path.length + 2));
  });
  return ids;
}

/** Test files (and ids) from the contract's repro_test and validate commands. [] when the contract names no test. */
export function guardTests(contract) {
  const by = new Map();
  const add = (path, ids) => { const e = by.get(path) ?? new Set(); ids.filter(Boolean).forEach((i) => e.add(i)); by.set(path, e); };
  const t = contract?.repro_test;
  const cmds = [];
  if (t && typeof t === "object") {
    if (t.path) add(String(t.path), t.id ? [String(t.id)] : []);
    cmds.push(t.command);
  }
  for (const v of contract?.validate ?? []) cmds.push(v?.command);
  for (const c of cmds) {
    for (const tok of String(c ?? "").match(/[^\s"']+/g) ?? []) {
      const p = tok.split("::")[0];
      if (PATHISH.test(p) && isTestPath(p)) add(p, idsOf(c, p));
    }
  }
  if (t && typeof t === "object" && t.path) add(String(t.path), []);
  return [...by].map(([path, ids]) => ({ path, ids: [...ids] }));
}

/** Hunks of a `git diff -U0` text for non-test files: [{file, start, end, symbol}] in post-image lines (deletions anchor at the line after). */
export function parseHunks(diff) {
  const out = [];
  let file = null;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+++ ")) { file = line === "+++ /dev/null" ? null : line.replace(/^\+\+\+ b\//, ""); continue; }
    if (line.startsWith("--- ")) { if (line === "--- /dev/null") file = null; continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (!m || !file || isTestPath(file)) continue;
    const delOnly = m[4] === "0", start = Number(m[3]) + (delOnly ? 1 : 0), len = m[4] === undefined ? 1 : Number(m[4]);
    out.push({ file, start, end: delOnly ? start : start + len - 1, symbol: m[5].trim().slice(0, 120) || null });
  }
  return out;
}

/** The guard for a merged lane, or {skipped, reason} when its contract names no regression/repro test. */
export function buildGuard({ issue, title = "", pr = null, mergeSha = null, contract, diff = "" }) {
  const tests = guardTests(contract);
  if (!tests.length) {
    const why = contract?.repro_test === "none" ? `repro_test none (${String(contract.repro_test_reason ?? "").slice(0, 120)})` : "contract names no test file";
    return { skipped: true, reason: `no guard for #${issue}: ${why}` };
  }
  return { guard: { v: 1, issue, pr, merge_sha: mergeSha, tests, hunks: parseHunks(diff), why: String(title).replace(/\s+/g, " ").trim().slice(0, 200) } };
}

export const renderGuard = (g) => `<!-- ${GUARD_MARKER} ${JSON.stringify(g).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e")} -->`;
export function parseGuard(body) {
  const m = GUARD_RE.exec(String(body ?? ""));
  if (!m) return null;
  try { const g = JSON.parse(m[1]); return g && g.v === 1 && Number.isInteger(g.issue) ? g : null; } catch { return null; }
}

const json = (s, d) => { try { return JSON.parse(String(s) || "null") ?? d; } catch { return d; } };

/**
 * Build the guard for one merged issue from GitHub alone (its FORGE:CONTRACT comment, merged PR and merge commit) and post it
 * once. Idempotent: an issue that already has a FORGE:GUARD comment is left alone. Returns {posted|exists|skipped, ...}.
 */
export async function guardIssue({ gh, git, repo, issue, pr = null, post = null, dryRun = false }) {
  const iss = json(await gh(["issue", "view", String(issue), "-R", repo, "--json", "number,title,comments"]), null);
  if (!iss) return { skipped: true, reason: `#${issue}: issue not readable` };
  const bodies = (iss.comments ?? []).map((c) => c?.body ?? "");
  const existing = bodies.map(parseGuard).find(Boolean);
  if (existing) return { exists: true, guard: existing };
  const cb = [...bodies].reverse().find((b) => b.startsWith("<!-- FORGE:CONTRACT -->") && parseContractComment(b));
  if (!cb) return { skipped: true, reason: `no guard for #${issue}: no frozen FORGE:CONTRACT comment` };
  const contract = parseContractComment(cb).contract;
  let prn = pr, sha = null;
  const view = prn
    ? json(await gh(["pr", "view", String(prn), "-R", repo, "--json", "number,state,mergeCommit"]), null)
    : json(await gh(["pr", "list", "-R", repo, "--state", "merged", "--search", `#${issue} in:body`, "--limit", "5", "--json", "number,mergeCommit,body"]), []).find((p) => new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, "i").test(p.body ?? "")) ?? null;
  if (view) { prn = view.number ?? prn; sha = view.mergeCommit?.oid ?? null; }
  if (!sha) return { skipped: true, reason: `no guard for #${issue}: no merged PR with a merge commit` };
  let diff = "";
  try { diff = String(await git(["diff", "-U0", "--no-color", "--no-renames", `${sha}^1`, sha])); } catch (e) {
    return { skipped: true, reason: `no guard for #${issue}: merge commit ${sha.slice(0, 10)} not available locally (${String(e?.message ?? e).split("\n")[0].slice(0, 100)})` };
  }
  const built = buildGuard({ issue, title: iss.title, pr: prn, mergeSha: sha, contract, diff });
  if (built.skipped) return built;
  if (!dryRun) await (post ?? ((b) => gh(["issue", "comment", String(issue), "-R", repo, "--body", b])))(renderGuard(built.guard));
  return { posted: true, guard: built.guard };
}

/** Guards read from a repo's issue comments (the register of record). */
export async function collectGuards({ gh, repo, limit = 500 }) {
  const rows = json(await gh(["issue", "list", "-R", repo, "--state", "all", "--search", `${GUARD_MARKER} in:comments`, "--limit", String(limit), "--json", "number,comments"]), []);
  const guards = [];
  for (const r of rows) for (const c of r.comments ?? []) { const g = hasMarker(c?.body) ? parseGuard(c.body) : null; if (g) { guards.push(g); break; } }
  return guards;
}

/** Rewrite the local cache from the guards found on GitHub. */
export function writeIndex(repo, guards, { root, fs = nodeFs } = {}) {
  const p = guardsIndexPath(repo, root);
  fs.mkdirSync(dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ v: 1, repo, guards }, null, 1));
  return p;
}
export function readIndex(repo, { root, fs = nodeFs } = {}) {
  try { const j = JSON.parse(fs.readFileSync(guardsIndexPath(repo, root), "utf8")); return Array.isArray(j?.guards) ? j.guards : null; } catch { return null; }
}

/** Guards covering `path` (a protected hunk file or a guarding test file; a directory prefix matches too). No path: all. */
export function listGuards(guards, { path = null } = {}) {
  if (!path) return guards;
  const p = String(path).replace(/^\.\//, "").replace(/\/$/, "");
  const hit = (f) => f === p || f.startsWith(`${p}/`);
  return guards.filter((g) => (g.hunks ?? []).some((h) => hit(h.file)) || (g.tests ?? []).some((t) => hit(t.path)));
}

/**
 * Backfill guards for issues closed since `since` (ISO date) that ran through the lean lane (a FORGE:CONTRACT comment and a
 * merged PR). Lanes without a test yield no guard; the reason is reported in `logs`. Idempotent.
 */
export async function backfill({ gh, git, repo, since, dryRun = false, log = () => {} }) {
  const rows = json(await gh(["issue", "list", "-R", repo, "--state", "closed", "--search", `closed:>=${since}`, "--limit", "500", "--json", "number"]), []);
  const res = { posted: [], exists: [], skipped: [] };
  for (const { number } of rows) {
    let r;
    try { r = await guardIssue({ gh, git, repo, issue: number, dryRun }); } catch (e) { r = { skipped: true, reason: `#${number}: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}` }; }
    if (r.posted) res.posted.push(number); else if (r.exists) res.exists.push(number);
    else { res.skipped.push({ issue: number, reason: r.reason }); log(r.reason); }
  }
  return res;
}

/** Lane hook: after a merge, fetch the base so the merge commit is local, then guard the issue. Best effort: never throws. */
export async function guardAfterMerge({ io, repo, issue, pr, cwd, base = null }) {
  try {
    if (base) { try { await io.git(["fetch", "origin", base], { cwd }); } catch { /* offline: use the local ref */ } }
    return await guardIssue({ gh: (a) => io.gh(a), git: (a) => io.git(a, { cwd }), repo, issue, pr });
  } catch (e) { return { skipped: true, reason: `guard failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}` }; }
}

/** `forgedock guards list [--path p] [--json] | backfill --since <date> [--dry-run]`. Returns the exit code. */
export async function guardsCli(argv, { gh, git, repo, print = console.log, root, fs = nodeFs } = {}) {
  const sub = argv[0];
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (sub === "list") {
    let guards = null;
    try { guards = await collectGuards({ gh, repo }); writeIndex(repo, guards, { root, fs }); } catch { guards = readIndex(repo, { root, fs }); }
    if (!guards) throw new Error("guards list: GitHub is unreachable and there is no local index");
    const hits = listGuards(guards, { path: flag("--path") });
    if (argv.includes("--json")) print(JSON.stringify(hits, null, 1));
    else if (!hits.length) print("No guards" + (flag("--path") ? ` cover ${flag("--path")}` : "") + ".");
    else for (const g of hits) print(`#${g.issue} (PR ${g.pr ?? "?"}, ${String(g.merge_sha ?? "").slice(0, 10)}): ${g.why}\n  tests: ${g.tests.map((t) => t.path + (t.ids.length ? ` [${t.ids.join(", ")}]` : "")).join(", ")}\n  hunks: ${(g.hunks ?? []).map((h) => `${h.file}:${h.start}-${h.end}${h.symbol ? ` (${h.symbol})` : ""}`).join(", ") || "none"}`);
    return 0;
  }
  if (sub === "backfill") {
    const since = flag("--since");
    if (!since || Number.isNaN(Date.parse(since))) throw new Error("usage: forgedock guards backfill --since <YYYY-MM-DD> [--dry-run]");
    const r = await backfill({ gh, git, repo, since, dryRun: argv.includes("--dry-run"), log: (m) => print(m) });
    print(`guards backfill: ${r.posted.length} ${argv.includes("--dry-run") ? "would be posted" : "posted"}, ${r.exists.length} already guarded, ${r.skipped.length} skipped`);
    return 0;
  }
  throw new Error("usage: forgedock guards list [--path p] [--json] | backfill --since <date> [--dry-run]");
}

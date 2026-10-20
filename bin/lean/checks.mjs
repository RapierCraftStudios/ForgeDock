#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Change-scoped lane checks (#4218): discover the repo's typecheck/lint/test commands, narrow each to what the lane's
 * change can affect with the ci-local scoper (widening to the full command when impact is unknown), and share the
 * tsc/eslint incremental caches across worktrees keyed by base commit: a shared entry is read-only and is copied into
 * the worktree (hydrate); a lane publishes its caches only when no entry exists yet (copy on write, first writer wins).
 *
 *   node bin/lean/checks.mjs [--repo DIR] --base REF [--json]   print the scoped checks (hydrates the cache first)
 *   node bin/lean/checks.mjs [--repo DIR] --base REF --publish  publish this worktree's caches for the base commit
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, changedFiles, sha256, homeForgeDir, shellSplit, shellQuote, globToRegex } from "../../scripts/ci-local/lib.mjs";
import { makeScopeCtx, scopeCommand } from "../../scripts/ci-local/scoping.mjs";

const px = path.posix;
/** Lane-local cache dir, at the same relative path in every worktree so tsbuildinfo's relative paths match. */
export const LOCAL_CACHE = "node_modules/.cache/forge-verify";
const SCRIPT_KINDS = { typecheck: "typecheck", "type-check": "typecheck", tsc: "typecheck", lint: "lint", test: "test" };
/** Runs a resolved script body's binary from node_modules/.bin, as `<pm> run` would. */
const EXEC = { pnpm: "pnpm exec", yarn: "yarn", npm: "npx" };
/** Commands a script body runs from PATH, never from node_modules/.bin. */
const SYSTEM_BINS = new Set(["pnpm", "yarn", "npx", "npm", "bun", "bunx", "node", "bash", "sh", "env", "make", "python", "python3", "uv", "poetry"]);
const exists = (repo, f) => fs.existsSync(path.join(repo, f));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };

function packageManager(repo) {
  if (exists(repo, "pnpm-lock.yaml")) return "pnpm";
  if (exists(repo, "yarn.lock")) return "yarn";
  return "npm";
}

function turboTasks(repo) {
  const t = readJson(path.join(repo, "turbo.json"));
  return new Set(Object.keys((t && (t.tasks || t.pipeline)) || {}));
}

/** The root package plus its declared workspace packages (package.json `workspaces`, pnpm-workspace.yaml `packages`). */
function workspaceDirs(repo, tracked) {
  const root = readJson(path.join(repo, "package.json"));
  if (!root) return [];
  const ws = root.workspaces;
  const globs = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  const pnpm = readText(path.join(repo, "pnpm-workspace.yaml"));
  for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?/gm)) globs.push(m[1]);
  const res = globs.filter((g) => typeof g === "string" && !g.startsWith("!")).map((g) => globToRegex(g.replace(/^\.\//, "").replace(/\/$/, "")));
  const dirs = tracked.filter((f) => px.basename(f) === "package.json" && f !== "package.json" && !f.split("/").includes("node_modules") && exists(repo, f))
    .map((f) => px.dirname(f)).filter((d) => res.some((re) => re.test(d)));
  return [".", ...dirs];
}

/**
 * The repo's typecheck/lint/test commands: [{kind, command, cwd}] (cwd repo-relative). JS: a turbo task when turbo.json
 * defines it, else the workspace packages' scripts when any defines it, else the root script. Python: pytest and ruff
 * when configured, run through `uv run` / `poetry run` when that lockfile exists.
 */
export function discoverChecks(repo) {
  const out = [];
  const tracked = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"]).out.split("\n").filter(Boolean);
  const pkgDirs = workspaceDirs(repo, tracked);
  if (pkgDirs.length) {
    const pm = packageManager(repo);
    const turbo = turboTasks(repo);
    const scripts = new Map(pkgDirs.map((d) => [d, (readJson(path.join(repo, d, "package.json")) || {}).scripts || {}]));
    for (const [script, kind] of Object.entries(SCRIPT_KINDS)) {
      if (turbo.has(script)) { out.push({ kind, command: `${exists(repo, "node_modules/.bin/turbo") ? "" : "npx "}turbo run ${script}`, cwd: "." }); continue; }
      const ws = pkgDirs.filter((d) => d !== "." && typeof scripts.get(d)[script] === "string").sort();
      const dirs = ws.length ? ws : typeof (scripts.get(".") || {})[script] === "string" ? ["."] : [];
      for (const d of dirs) out.push({ kind, command: `${pm} run ${script}`, cwd: d, exec: EXEC[pm] });
    }
  }
  const pyproject = readText(path.join(repo, "pyproject.toml"));
  const run = exists(repo, "uv.lock") ? "uv run " : exists(repo, "poetry.lock") ? "poetry run " : "";
  if (/^\[tool\.ruff/m.test(pyproject) || exists(repo, "ruff.toml") || exists(repo, ".ruff.toml")) out.push({ kind: "lint", command: `${run}ruff check .`, cwd: "." });
  if (/^\[tool\.pytest/m.test(pyproject) || exists(repo, "pytest.ini") || tracked.some((f) => px.basename(f) === "conftest.py")) out.push({ kind: "test", command: `${run}pytest`, cwd: "." });
  return out;
}

/** The shared cache entry for this repo (all its worktrees share the git common dir) at the base commit. */
export function cacheEntry(repo, baseSha) {
  const gc = git(repo, ["rev-parse", "--git-common-dir"]).out.trim();
  const common = fs.realpathSync(path.resolve(repo, gc || ".git"));
  return path.join(homeForgeDir(), "verify-cache", sha256(common).slice(0, 16), baseSha);
}

/** Copy the shared entry's files into the worktree's local cache (files the lane already has are kept). */
export function hydrate(repo, entry) {
  if (!exists(repo, "node_modules") || !fs.existsSync(entry)) return { hydrated: [] };
  const local = path.join(repo, LOCAL_CACHE);
  fs.mkdirSync(local, { recursive: true });
  const hydrated = [];
  for (const f of fs.readdirSync(entry)) {
    const to = path.join(local, f);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(entry, f), to);
    hydrated.push(f);
  }
  return { hydrated };
}

/** Publish the worktree's caches as the shared entry, only when none exists yet: tmp dir + rename, never overwrite. */
export function publish(repo, entry) {
  const local = path.join(repo, LOCAL_CACHE);
  const files = fs.existsSync(local) ? fs.readdirSync(local).filter((f) => fs.statSync(path.join(local, f)).isFile()) : [];
  if (!files.length) return { published: false, reason: "no local cache" };
  if (fs.existsSync(entry)) return { published: false, reason: "entry exists" };
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const tmp = `${entry}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmp);
  try {
    for (const f of files) fs.copyFileSync(path.join(local, f), path.join(tmp, f));
    fs.renameSync(tmp, entry);
    return { published: true, files };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(e.code)) return { published: false, reason: "entry exists" };
    throw e;
  }
}

/** Add the shared-cache flags to a tsc (-p or plain; not -b, which keeps per-project buildinfo) or eslint command. */
export function withCacheFlags(check, repo) {
  if (!check.command || !exists(repo, "node_modules")) return check;
  const toks = shellSplit(check.command);
  if (!toks) return check;
  const local = px.relative(check.cwd || ".", LOCAL_CACHE);
  const i = toks.findIndex((t) => ["tsc", "eslint"].includes(px.basename(t)));
  if (i < 0) return check;
  const rest = toks.slice(i + 1);
  let add = [];
  if (px.basename(toks[i]) === "tsc") {
    if (rest.some((t) => ["-b", "--build", "--tsBuildInfoFile", "--incremental", "-w", "--watch"].includes(t) || t.startsWith("--incremental="))) return check;
    const p = rest.indexOf("-p") >= 0 ? rest[rest.indexOf("-p") + 1] : rest.indexOf("--project") >= 0 ? rest[rest.indexOf("--project") + 1] : ".";
    const project = px.normalize(px.join(check.cwd || ".", p || "."));
    add = ["--incremental", "--tsBuildInfoFile", `${local}/tsc-${sha256(project).slice(0, 12)}.tsbuildinfo`];
  } else {
    if (rest.some((t) => t === "--cache-location" || t.startsWith("--cache-location="))) return check;
    add = [...(rest.includes("--cache") ? [] : ["--cache"]), ...(rest.includes("--cache-strategy") ? [] : ["--cache-strategy", "content"]), "--cache-location", `${local}/eslintcache`];
  }
  return { ...check, command: [...toks.slice(0, i + 1), ...add, ...rest].map(shellQuote).join(" "), cache: true };
}

/** Changed files vs the merge base with `base` (the engine's .forge-lean/ hand-off files excluded). */
export function laneChanges(repo, base) {
  const { files, from } = changedFiles(repo, base);
  return { files: files.filter((f) => !f.startsWith(".forge-lean/")), from };
}

/** The scoped checks for this lane: [{kind, command, cwd, mode, widen_reason, selector, reason}]. */
export function scopedChecks({ repo, base, checks = discoverChecks(repo) }) {
  const { files, from } = laneChanges(repo, base);
  const sctx = makeScopeCtx({ repo, baseRef: base, from, changed: files });
  return checks.map((c) => {
    const r = scopeCommand(c.command, c.cwd === "." ? "" : c.cwd, sctx);
    // A resolved script body (`pnpm run typecheck` -> `tsc -p apps/web`) runs its binary through the package manager.
    const resolved = r.action !== "skip" && c.exec && r.command !== c.command && !SYSTEM_BINS.has(px.basename((shellSplit(r.command) || [""])[0]));
    const out = { kind: c.kind, cwd: c.cwd, command: r.action === "skip" ? "" : resolved ? `${c.exec} ${r.command}` : r.command, mode: r.mode, widen_reason: r.widen_reason || "", selector: r.selector || "" };
    if (r.reason) out.reason = r.reason;
    return r.action === "skip" ? out : withCacheFlags(out, repo);
  });
}

function parseArgs(argv) {
  const o = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--repo") o.repo = argv[++i]; else if (t === "--base") o.base = argv[++i];
    else if (t === "--json") o.json = true; else if (t === "--publish") o.publish = true;
    else throw new Error(`unknown option ${t}`);
  }
  return o;
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`checks: ${e.message}`); return 2; }
  if (!o.base) { console.error("usage: checks.mjs [--repo DIR] --base REF [--json] [--publish]"); return 2; }
  const repo = path.resolve(o.repo);
  const mb = git(repo, ["merge-base", o.base, "HEAD"]);
  if (mb.code !== 0) { console.error(`checks: cannot resolve base ${o.base}`); return 2; }
  const entry = cacheEntry(repo, mb.out.trim());
  if (o.publish) { console.log(JSON.stringify(publish(repo, entry))); return 0; }
  hydrate(repo, entry);
  const checks = scopedChecks({ repo, base: o.base });
  if (o.json) { console.log(JSON.stringify(checks, null, 2)); return 0; }
  if (!checks.length) console.log("# no typecheck/lint/test command found");
  for (const c of checks) {
    const where = c.cwd && c.cwd !== "." ? `(cd ${shellQuote(c.cwd)} && ${c.command})` : c.command;
    if (c.mode === "skip") console.log(`${c.kind} skip  # skipped: ${c.reason || "not affected"}`);
    else console.log(`${c.kind} ${c.mode} ${where}${c.widen_reason ? `  # widened: ${c.widen_reason}` : ""}`);
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

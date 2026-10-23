#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Public-API-shape change detector (forge#4449, light lane #4442). Deterministic, no LLM: for every file changed in
 * <base>...<head> it indexes the base and head blobs with scripts/symbol-index.py / symbol-index.mjs `--shape` (the
 * target repo's own Python `ast` / `typescript`) and compares the public symbols:
 *   signature | sync-async | generator-function | removed | renamed
 * renamed = a vanished public symbol paired with a new public symbol of the same kind and shape in the same file;
 * public→private counts as removed; additions never report. Code in a language without an indexer (go, rust, ...)
 * or a blob the indexer refuses (parse error, no parser) is `unknown`, which the light lane treats as an upgrade.
 * Docs/config/data files, test files and .d.ts are skipped.
 *
 * CLI: node bin/lean/apishape.mjs <base>...<head> | <base> <head>   (run from the repo root)
 *   stdout {"status":"none|changed|unknown","changes":[{file,symbol,change,before,after}],"unknown":[{file,lang,reason}]}
 *   exit 0 none/changed/unknown | 2 usage or bad ref
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL("../../scripts/", import.meta.url));
export const SYMBOL_INDEX_PY = join(SCRIPTS, "symbol-index.py");
export const SYMBOL_INDEX_MJS = join(SCRIPTS, "symbol-index.mjs");

const INDEXED = { ".py": "python", ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js" };
const UNINDEXED = {
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java", ".kt": "kotlin", ".c": "c", ".h": "c", ".cc": "cpp",
  ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php", ".swift": "swift", ".sh": "shell",
};
const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py|[^/]*\.(test|spec)\.[^/]+)$|(^|\/)(tests?|__tests__)\//;

/** argv runner without a shell; never throws for a non-zero exit. */
export function defaultRun(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (Number.isInteger(err.code) ? err.code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err && !Number.isInteger(err.code) ? err.message : "")) });
    });
  });
}

/** "python" | "ts" | "js" for an indexed file, { unknown: lang } for code without an indexer, null when skipped. */
export function classifyPath(path) {
  const p = String(path);
  if (TEST_FILE.test(p) || /\.d\.[cm]?ts$/.test(p)) return null;
  const ext = extname(p).toLowerCase();
  if (INDEXED[ext]) return INDEXED[ext];
  return UNINDEXED[ext] ? { unknown: UNINDEXED[ext] } : null;
}

/** `git diff -z --name-status -M` → [{ status, before, after }] (before/after null for added/deleted). */
export function parseNameStatus(out) {
  const f = String(out).split("\0");
  const rows = [];
  for (let i = 0; i < f.length && f[i];) {
    const st = f[i][0];
    if (st === "R" || st === "C") { rows.push({ status: st, before: st === "R" ? f[i + 1] : null, after: f[i + 2] }); i += 3; continue; }
    const p = f[i + 1];
    rows.push({ status: st, before: st === "A" ? null : p, after: st === "D" ? null : p });
    i += 2;
  }
  return rows;
}

const shapeOf = (s) => ({ async: !!s.async, generator: !!s.generator, sig: s.sig ?? null });
const shapeKey = (s) => JSON.stringify([s.kind, shapeOf(s)]);

/** Public-symbol shape changes between two `--shape` indexes of one file. */
export function compareIndexes(file, base, head) {
  const pub = (idx) => new Map((idx?.symbols ?? []).filter((s) => s.public).map((s) => [s.name, s]));
  const b = pub(base), h = pub(head), changes = [];
  for (const [name, bs] of b) {
    const hs = h.get(name);
    if (!hs) continue;
    const x = shapeOf(bs), y = shapeOf(hs);
    if (x.async !== y.async) changes.push({ file, symbol: name, change: "sync-async", before: x.async ? "async" : "sync", after: y.async ? "async" : "sync" });
    if (x.generator !== y.generator) changes.push({ file, symbol: name, change: "generator-function", before: x.generator ? "generator" : "function", after: y.generator ? "generator" : "function" });
    if (x.sig !== y.sig) changes.push({ file, symbol: name, change: "signature", before: x.sig, after: y.sig });
    else if (x.async === y.async && x.generator === y.generator && bs.kind !== hs.kind) {
      changes.push({ file, symbol: name, change: "signature", before: bs.kind, after: hs.kind });
    }
  }
  const added = [...h.keys()].filter((n) => !b.has(n)).sort();
  for (const name of [...b.keys()].filter((n) => !h.has(n)).sort()) {
    const key = shapeKey(b.get(name));
    const i = added.findIndex((n) => shapeKey(h.get(n)) === key);
    if (i >= 0) changes.push({ file, symbol: name, change: "renamed", before: name, after: added.splice(i, 1)[0] });
    else changes.push({ file, symbol: name, change: "removed", before: name, after: null });
  }
  return changes;
}

async function indexBlob({ cwd, run, dir, ref, path, lang }) {
  const show = await run("git", ["show", `${ref}:${path}`], { cwd });
  if (show.code !== 0) return { unknown: { lang, reason: `git-show-failed: ${ref}:${path}` } };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, basename(path));
  writeFileSync(file, show.stdout);
  const r = lang === "python"
    ? await run("python3", [SYMBOL_INDEX_PY, "--shape", file], { cwd })
    : await run(process.execPath, [SYMBOL_INDEX_MJS, "--shape", file], { cwd });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* reported below */ }
  if (r.code !== 0 || !out) return { unknown: { lang, reason: r.code === 127 ? "no-indexer-runtime" : `index-failed: exit ${r.code}` } };
  if (out.unsupported) return { unknown: { lang: out.unsupported, reason: out.reason ?? "unsupported" } };
  return { index: out };
}

/**
 * Compare base vs head for the changed files. Throws only for a bad ref or a failed `git diff` (CLI exit 2).
 * @returns {Promise<{status:"none"|"changed"|"unknown", changes:object[], unknown:object[]}>}
 */
export async function detectApiShape({ cwd = process.cwd(), base, head, run = defaultRun } = {}) {
  for (const ref of [base, head]) {
    if (!ref || (await run("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd })).code !== 0) throw new Error(`bad ref: ${ref}`);
  }
  const diff = await run("git", ["diff", "-z", "--name-status", "-M", `${base}...${head}`], { cwd });
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const changes = [], unknown = [];
  const tmp = mkdtempSync(join(tmpdir(), "apishape-"));
  try {
    let n = 0;
    for (const row of parseNameStatus(diff.stdout)) {
      if (!row.before) continue; // added (or copied) file: additions are not shape changes
      const file = row.after ?? row.before;
      const kind = classifyPath(row.before);
      if (kind === null) continue;
      if (typeof kind === "object") { unknown.push({ file, lang: kind.unknown, reason: "unsupported-language" }); continue; }
      const dir = join(tmp, String(n++));
      const b = await indexBlob({ cwd, run, dir: join(dir, "base"), ref: base, path: row.before, lang: kind });
      if (b.unknown) { unknown.push({ file, ...b.unknown }); continue; }
      let h = { index: { symbols: [] } };
      if (row.after) {
        const headKind = classifyPath(row.after);
        if (headKind !== kind) { unknown.push({ file, lang: typeof headKind === "object" && headKind ? headKind.unknown : String(headKind), reason: "language-changed" }); continue; }
        h = await indexBlob({ cwd, run, dir: join(dir, "head"), ref: head, path: row.after, lang: kind });
        if (h.unknown) { unknown.push({ file, ...h.unknown }); continue; }
      }
      changes.push(...compareIndexes(file, b.index, h.index));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  changes.sort((a, b) => cmp(a.file, b.file) || cmp(a.symbol, b.symbol) || cmp(a.change, b.change));
  unknown.sort((a, b) => cmp(a.file, b.file));
  return { status: unknown.length ? "unknown" : changes.length ? "changed" : "none", changes, unknown };
}

async function main(argv) {
  let base, head;
  if (argv.length === 1 && argv[0].includes("...")) [base, head] = argv[0].split("...");
  else if (argv.length === 2) [base, head] = argv;
  if (!base || !head || argv.includes("-h") || argv.includes("--help")) {
    process.stderr.write("usage: apishape.mjs <base>...<head> | <base> <head>\n");
    return 2;
  }
  try {
    process.stdout.write(JSON.stringify(await detectApiShape({ base, head })) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`apishape: ${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2));

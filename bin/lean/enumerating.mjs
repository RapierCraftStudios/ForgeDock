// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Enumerating tests (#4322): tests whose expected list names every member of a group (a module's exports, or the files
 * of one directory), so a new member must join the list or CI goes red. Deterministic and codebase-agnostic: git + fs,
 * no LLM, runs none of the repo's commands. A test enumerates a group when it names at least min(3, n) members as string
 * literals or object keys, or calls Object.keys/Object.entries on an import of the module. Never throws: failures are [].
 */
import fs from "node:fs";
import { basename, dirname, join, posix } from "node:path";

const SOURCE_RE = /\.(?:[cm]?[jt]sx?|py)$/;
const TEST_RE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.[^/]+$/;
const SKIP_RE = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)\//;
const MAX_TEST_BYTES = 512 * 1024;
const MAX_TESTS = 5000;
const MAX_MODULES = 20, MAX_TESTS_PER_MODULE = 10;
const MIN_NAME = 3;

export const isTestPath = (p) => TEST_RE.test(p);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const stem = (p) => basename(p).replace(/\.[^.]+$/, "").replace(/\.d$/, "");

/** Exported names of a JS/TS or Python source text. */
export function exportNames(text, path = "") {
  const t = String(text ?? ""), out = new Set();
  if (/\.py$/.test(path)) {
    const all = /^__all__\s*=\s*[[(]([\s\S]*?)[\])]/m.exec(t);
    if (all) for (const m of all[1].matchAll(/["']([A-Za-z_]\w*)["']/g)) out.add(m[1]);
    else for (const m of t.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm)) out.add(m[1]);
    return [...out];
  }
  for (const m of t.matchAll(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of t.matchAll(/^\s*export\s+(?!type\b)\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p || part.trim().startsWith("type ")) continue;
      const name = (/\bas\s+([A-Za-z_$][\w$]*)$/.exec(p)?.[1]) ?? /^[A-Za-z_$][\w$]*/.exec(p)?.[0];
      if (name && name !== "default") out.add(name);
    }
  }
  return [...out];
}

/** Line (1-based) of the first literal/key mention of any of `names` in `text`, and the distinct names mentioned. */
function mentions(text, names) {
  const hit = new Set();
  let line = 0;
  for (const n of names) {
    if (n.length < MIN_NAME) continue;
    const re = new RegExp(`(["'\`])${esc(n)}\\1|(?:^|[{,\\s])${esc(n)}\\s*:(?!:)`, "m");
    const m = re.exec(text);
    if (!m) continue;
    hit.add(n);
    const l = text.slice(0, m.index).split("\n").length;
    if (!line || l < line) line = l;
  }
  return { hit, line };
}

/** Local names bound to an import of `module` in a test at `testPath` (namespace, default or require). */
function importBindings(text, testPath, module, pkgs) {
  const out = [];
  const target = module.replace(SOURCE_RE, "");
  const targets = new Set([target, ...(stem(module) === "index" ? [dirname(module)] : [])]);
  const pkgNames = pkgs.filter((p) => stem(module) === "index" && [p.dir, posix.join(p.dir, "src")].includes(dirname(module))).map((p) => p.name);
  const matches = (spec) => {
    if (pkgNames.includes(spec)) return true;
    if (!spec.startsWith(".")) return false;
    const r = posix.normalize(posix.join(dirname(testPath), spec)).replace(SOURCE_RE, "");
    return targets.has(r) || targets.has(r.replace(/\/index$/, ""));
  };
  for (const m of text.matchAll(/import\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s+from\s+["']([^"']+)["']/g)) if (matches(m[3])) out.push(m[1] ?? m[2]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+import|require)\(\s*["']([^"']+)["']\s*\)/g)) if (matches(m[2])) out.push(m[1]);
  return out;
}

/** {path, text} of the repo's tracked test files (read from the working tree; absent/sparse/oversize files skipped). */
async function loadTests(git, cwd) {
  let files;
  try { files = lines(await git(["-c", "core.quotepath=off", "ls-files"])); } catch { return { tests: [], files: [], pkgs: [] }; }
  const tests = [];
  for (const f of files) {
    if (tests.length >= MAX_TESTS) break;
    if (!isTestPath(f) || SKIP_RE.test(f) || !SOURCE_RE.test(f)) continue;
    try {
      const p = join(cwd, f);
      if (fs.statSync(p).size > MAX_TEST_BYTES) continue;
      tests.push({ path: f, text: fs.readFileSync(p, "utf8") });
    } catch { /* sparse or unreadable: skip */ }
  }
  const pkgs = [];
  for (const f of files.filter((x) => /(?:^|\/)package\.json$/.test(x) && !SKIP_RE.test(x))) {
    try { const n = JSON.parse(fs.readFileSync(join(cwd, f), "utf8")).name; if (typeof n === "string" && n) pkgs.push({ name: n, dir: dirname(f) }); } catch { /* skip */ }
  }
  return { tests, files, pkgs };
}

/** Tests enumerating one group: [{test, line, why}]. `exports` groups also match Object.keys/entries of an import of `module`. */
function enumerators(tests, { module, names, kind }, pkgs) {
  const out = [];
  const usable = names.filter((n) => n.length >= MIN_NAME);
  if (usable.length < 2) return out;
  const need = Math.min(3, usable.length);
  for (const t of tests) {
    if (t.path === module) continue;
    const { hit, line } = mentions(t.text, usable);
    if (hit.size >= need) { out.push({ test: t.path, line, why: `literal list of ${hit.size} sibling ${kind === "files" ? "file names" : "export names"}` }); continue; }
    if (kind !== "exports") continue;
    for (const b of importBindings(t.text, t.path, module, pkgs)) {
      const m = new RegExp(`Object\\.(?:keys|entries)\\(\\s*${esc(b)}\\s*\\)`).exec(t.text);
      if (m) { out.push({ test: t.path, line: t.text.slice(0, m.index).split("\n").length, why: `Object.keys(${b})` }); break; }
    }
  }
  return out.slice(0, MAX_TESTS_PER_MODULE);
}

const fileGroup = (files, dir, exclude = new Set()) => [...new Set(files.filter((f) => dirname(f) === dir && !isTestPath(f) && !exclude.has(f) && stem(f) !== "index").map(stem))];

/**
 * Plan time: tests enumerating the exports or directory siblings of each path the issue names.
 * @returns {Promise<Array<{module:string, test:string, line:number, why:string}>>}
 */
export async function enumeratingTests({ git, cwd, paths = [] }) {
  try {
    const { tests, files, pkgs } = await loadTests(git, cwd);
    if (!tests.length) return [];
    const tracked = new Set(files), out = [], seen = new Set();
    for (const raw of [...new Set(paths.map((p) => String(p).replace(/^\.\//, "").replace(/\/$/, "")))].slice(0, MAX_MODULES)) {
      const groups = [];
      if (tracked.has(raw) && SOURCE_RE.test(raw) && !isTestPath(raw)) {
        let text = ""; try { text = fs.readFileSync(join(cwd, raw), "utf8"); } catch { /* sparse */ }
        groups.push({ module: raw, names: exportNames(text, raw), kind: "exports" });
        groups.push({ module: dirname(raw), names: fileGroup(files, dirname(raw)), kind: "files" });
      } else if (files.some((f) => dirname(f) === raw)) groups.push({ module: raw, names: fileGroup(files, raw), kind: "files" });
      for (const g of groups) for (const e of enumerators(tests, g, pkgs)) {
        const k = `${g.module}\0${e.test}`;
        if (!seen.has(k)) { seen.add(k); out.push({ module: g.module, ...e }); }
      }
    }
    return out;
  } catch { return []; }
}

/**
 * After implement: each new export (vs `base`) of a changed source file and each new file, paired with every test that
 * enumerates its existing siblings but never names it. @returns {Promise<Array<{symbol, module, test, line}>>}
 */
export async function missingEntries({ git, cwd, base }) {
  try {
    const changed = lines(await git(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`]));
    const added = new Set(lines(await git(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", `${base}...HEAD`])));
    const groups = [];
    for (const f of changed) {
      if (isTestPath(f) || SKIP_RE.test(f)) continue;
      if (SOURCE_RE.test(f)) {
        let head = "", old = "";
        try { head = fs.readFileSync(join(cwd, f), "utf8"); } catch { continue; }
        if (!added.has(f)) { try { old = String(await git(["show", `${base}:${f}`])); } catch { old = ""; } }
        const now = exportNames(head, f), was = new Set(exportNames(old, f));
        const fresh = now.filter((n) => !was.has(n) && n.length >= MIN_NAME);
        if (fresh.length) groups.push({ module: f, names: now.filter((n) => was.has(n)), fresh, kind: "exports" });
      }
    }
    if (!groups.length && !added.size) return [];
    const { tests, files, pkgs } = await loadTests(git, cwd);
    if (!tests.length) return [];
    const newFiles = [...added].filter((f) => !isTestPath(f) && !SKIP_RE.test(f));
    for (const dir of [...new Set(newFiles.map(dirname))]) {
      const fresh = newFiles.filter((f) => dirname(f) === dir).map(stem).filter((s) => s.length >= MIN_NAME && s !== "index");
      if (fresh.length) groups.push({ module: dir, names: fileGroup(files, dir, added), fresh, kind: "files" });
    }
    const out = [];
    for (const g of groups.slice(0, MAX_MODULES)) {
      for (const e of enumerators(tests, g, pkgs)) {
        const text = tests.find((t) => t.path === e.test)?.text ?? "";
        for (const s of g.fresh) if (!new RegExp(`(?<![\\w$])${esc(s)}(?![\\w$])`).test(text)) out.push({ symbol: s, module: g.module, test: e.test, line: e.line });
      }
    }
    return out;
  } catch { return []; }
}

/** Drop entries the builder justified in result.json "not_members" [{symbol, test, why}] (a non-empty why is required). */
export function unjustified(missing, notMembers) {
  const ok = new Set((Array.isArray(notMembers) ? notMembers : []).filter((n) => n && String(n.why ?? "").trim()).map((n) => `${n.symbol}\0${n.test}`));
  return (missing ?? []).filter((m) => !ok.has(`${m.symbol}\0${m.test}`));
}

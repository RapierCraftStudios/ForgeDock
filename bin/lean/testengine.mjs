// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test engine (#5710, Forge CI W3): affected-test selection and the `forgedock tests select|shard|recall` CLI.
 * - Selection: changed files -> test files. JS/TS by a static import/require graph, Python by module imports (plus
 *   `conftest.py`), quoted repo paths, `ci.tests.suites` path -> suite globs as the declared fallback. A lockfile, manifest or CI-file change,
 *   and any changed file nothing maps, select everything. Every selected test carries a reason.
 * - Modes (`ci.tests.selection`): off (default: nothing is computed) | shadow (selection recorded, full suite runs) |
 *   enforce (refused, stays shadow, until the recall ledger graduated; `testengine-recall.mjs`). Scheduled runs and
 *   release branches always run the full suite.
 * - Config: the one-level forge.yaml parser flattens `ci.tests.*` under `ci`, so the key names are unique within `ci`.
 * Pure functions over injected `files` / `read`; only the CLI touches git and the filesystem. No network, no model call.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { parseForgeYaml } from "../forge-utils.mjs";

export const ENGINE_VERSION = 1;
export const SELECTION_MODES = ["off", "shadow", "enforce"];
export const QUARANTINE_MODES = ["off", "report", "non-blocking"];
/** Changes that select everything: dependency manifests and lockfiles, toolchain and test-runner config, CI files. */
export const RUN_ALL_DEFAULT = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", ".npmrc", ".yarnrc*", "bun.lock*",
  "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock", "requirements*.txt", "constraints*.txt", "setup.py", "setup.cfg", "tox.ini", "noxfile.py", "pytest.ini",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
  "tsconfig*.json", "jsconfig*.json", "babel.config.*", ".babelrc*", "jest.config.*", "vitest.config.*", "vitest.workspace.*", "playwright.config.*", ".mocharc*",
  ".nvmrc", ".node-version", ".python-version", ".tool-versions",
  ".github/**", "forge.yaml", ".forge/**", "Dockerfile*", "docker-compose*.y*ml", "compose*.y*ml", "Makefile", "GNUmakefile", ".env*",
];
export const FULL_BRANCHES_DEFAULT = ["main", "master", "release/**"];

const str = (v) => (v == null ? "" : String(v)).trim();
const list = (v) => (Array.isArray(v) ? v : str(v) ? [str(v)] : []).map(str).filter(Boolean);
const posInt = (v, d) => { const n = Number(str(v)); return Number.isInteger(n) && n > 0 ? n : d; };
const nonNeg = (v, d) => { const n = Number(str(v)); return str(v) !== "" && Number.isInteger(n) && n >= 0 ? n : d; };
const uniq = (a) => [...new Set(a)];

/** A glob as an anchored RegExp: `*` within a segment, `**` across segments (`**​/` also matches no directory), `?` one character. */
export function globRe(glob) {
  const g = String(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i++; } }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
/** True when `path` matches `glob`; a glob without `/` is matched against the basename (so `package.json` matches in any directory). */
export const matchGlob = (path, glob) => globRe(glob).test(String(glob).includes("/") ? path : posix.basename(path));
const firstGlob = (path, globs) => globs.find((g) => matchGlob(path, g));

/** One `ci.tests.suites` entry `"<glob> [<glob>...] => <target> [<target>...]"`; a target is a test-file glob, `@name` or `*`. */
export function parseSuiteRule(entry) {
  const [l, r, extra] = str(entry).split("=>");
  const when = str(l).split(/\s+/).filter(Boolean), targets = str(r).split(/\s+/).filter(Boolean);
  return extra === undefined && when.length && targets.length ? { when, targets } : null;
}

/** forge.yaml `ci` section (flattened `ci.tests.*`) -> the engine config; junk keeps the defaults, and the default is off. */
export function parseTestsConfig(ci) {
  const s = ci && typeof ci === "object" ? ci : {};
  const pick = (v, allowed, d) => (allowed.includes(str(v)) ? str(v) : d);
  const rules = list(s.suites).map(parseSuiteRule);
  return {
    selection: pick(s.selection, SELECTION_MODES, "off"),
    suites: rules.filter(Boolean),
    badSuites: list(s.suites).filter((_, i) => !rules[i]),
    runAll: [...RUN_ALL_DEFAULT, ...list(s.run_all)],
    ignore: list(s.ignore),
    testGlobs: list(s.test_globs),
    fullBranches: s.full_branches === undefined ? FULL_BRANCHES_DEFAULT : list(s.full_branches),
    graduateAfter: posInt(s.graduate_after, 50),
    graduateMinFailing: nonNeg(s.graduate_min_failing, 1),
    shards: posInt(s.shards, 0),
    shardTargetS: posInt(s.shard_target_s, 0),
    quarantine: pick(s.quarantine, QUARANTINE_MODES, "report"),
    quarantineAfter: posInt(s.quarantine_after, 3),
    quarantineWindowDays: posInt(s.quarantine_window_days, 14),
    ledger: str(s.recall_ledger),
  };
}
export function readTestsConfig(cwd = process.cwd()) {
  try { return parseTestsConfig(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.ci); } catch { return parseTestsConfig(null); }
}
/** Identity of everything that decides a selection: a change restarts the graduation count. */
export const configHash = (cfg) => createHash("sha256")
  .update(JSON.stringify([ENGINE_VERSION, cfg.suites, cfg.runAll, cfg.ignore, cfg.testGlobs])).digest("hex").slice(0, 12);

// ---- ecosystems --------------------------------------------------------------------------------------------------------
const JS_EXT = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];
const JS_RE = /\.[cm]?[jt]sx?$/;
const JS_TEST_RE = /(^|\/)__tests__\/.*\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST_RE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
export const ecosystemOf = (f) => (JS_RE.test(f) && !f.endsWith(".d.ts") ? "js" : f.endsWith(".py") ? "python" : "other");
/** Test files of `files`: `ci.tests.test_globs` when set, else the JS (`*.test.*`, `*.spec.*`, `__tests__/`) and pytest (`test_*.py`, `*_test.py`) conventions. */
export function testFilesOf(files, cfg = {}) {
  const globs = cfg.testGlobs ?? [];
  return files.filter((f) => (globs.length ? globs.some((g) => matchGlob(f, g)) : JS_TEST_RE.test(f) || PY_TEST_RE.test(f))).sort();
}

const JS_SPEC_RES = [
  /\bimport\s+(?:[^'"()]*?\s+from\s+)?["']([^"'\n]+)["']/g,
  /\bexport\s+[^'";]*?\s+from\s+["']([^"'\n]+)["']/g,
  /\b(?:require|import|require\.resolve|jest\.(?:mock|doMock|requireActual)|vi\.(?:mock|doMock|importActual))\s*\(\s*["'`]([^"'`\n]+)["'`]/g,
  /\bnew\s+URL\(\s*["'`](\.{1,2}\/[^"'`\n]+)["'`]\s*,\s*import\.meta\.url/g,
];
const JS_DYNAMIC_RE = /\b(?:require|import)\s*\(\s*(?:[A-Za-z_$]|`[^`]*\$\{)/;
const PATH_LITERAL_RE = /["'`]((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+)["'`]/g;
/** Literal module specifiers of a JS/TS source (imports, re-exports, require, dynamic import, mocks, `new URL(rel, import.meta.url)`). */
export function jsSpecifiers(src) {
  const out = [];
  for (const re of JS_SPEC_RES) for (const m of String(src).matchAll(re)) if (!m[1].includes("${")) out.push(m[1]);
  return uniq(out);
}

/** The file a path-like import base names: itself, with an extension, a TS source behind a `.js` specifier, or a directory index. */
function tryFile(base, has) {
  const b = base.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!b || b.startsWith("..")) return null;
  if (has(b)) return b;
  for (const e of JS_EXT) if (has(b + e)) return b + e;
  const swap = /\.([cm]?)jsx?$/.exec(b);
  if (swap) for (const e of [`.${swap[1]}ts`, ".tsx", ".ts"]) { const c = b.slice(0, swap.index) + e; if (has(c)) return c; }
  for (const e of JS_EXT) if (has(`${b}/index${e}`)) return `${b}/index${e}`;
  return null;
}
const lenientJson = (text) => {
  try { return JSON.parse(String(text)); } catch { /* tsconfig allows comments and trailing commas */ }
  try { return JSON.parse(String(text).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
};
const dirOf = (f) => (posix.dirname(f) === "." ? "" : posix.dirname(f));
const under = (f, dir) => dir === "" || f.startsWith(`${dir}/`);
const pj = (...p) => posix.normalize(p.filter((x) => x !== "").join("/") || ".").replace(/^\.$/, "");

/** Workspace packages (`name` -> dir, entry) and tsconfig/jsconfig `baseUrl` + `paths` aliases, read from the repo's own files. */
function jsResolvers(files, read) {
  const packages = [], aliases = [];
  for (const f of files) {
    const base = posix.basename(f);
    if (base === "package.json" && !f.includes("node_modules/")) {
      const p = lenientJson(read(f) ?? "");
      if (p && typeof p.name === "string") packages.push({ name: p.name, dir: dirOf(f), main: [p.source, p.module, p.main, typeof p.exports === "string" ? p.exports : p.exports?.["."]?.import ?? p.exports?.["."]?.default ?? (typeof p.exports?.["."] === "string" ? p.exports["."] : null)].filter((x) => typeof x === "string") });
    } else if (/^[tj]sconfig(\..+)?\.json$/.test(base)) {
      const co = lenientJson(read(f) ?? "")?.compilerOptions;
      if (!co || typeof co !== "object") continue;
      const root = pj(dirOf(f), str(co.baseUrl) || ".");
      const paths = Object.entries(co.paths && typeof co.paths === "object" ? co.paths : {}).map(([k, v]) => ({ key: k, targets: list(v) }));
      aliases.push({ dir: dirOf(f), root, paths, baseUrl: co.baseUrl !== undefined });
    }
  }
  packages.sort((a, b) => b.name.length - a.name.length);
  aliases.sort((a, b) => b.dir.length - a.dir.length);
  return { packages, aliases };
}

/** Repo files a JS specifier of `from` resolves to ([] for an external package). */
function resolveJs(spec, from, { has, files, packages, aliases }) {
  if (spec.startsWith(".")) { const r = tryFile(pj(dirOf(from), spec), has); return r ? [r] : []; }
  if (spec.startsWith("/") || /^[a-z]+:/i.test(spec)) return [];
  for (const a of aliases) {
    if (!under(from, a.dir)) continue;
    for (const p of a.paths) {
      const star = p.key.indexOf("*");
      const hit = star < 0 ? spec === p.key : spec.startsWith(p.key.slice(0, star)) && spec.endsWith(p.key.slice(star + 1));
      if (!hit) continue;
      const mid = star < 0 ? "" : spec.slice(star, spec.length - (p.key.length - star - 1));
      for (const t of p.targets) { const r = tryFile(pj(a.root, t.replace("*", mid)), has); if (r) return [r]; }
    }
    if (a.baseUrl) { const r = tryFile(pj(a.root, spec), has); if (r) return [r]; }
  }
  const pkg = packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
  if (!pkg) return [];
  const sub = spec.slice(pkg.name.length + 1);
  const tries = sub ? [pj(pkg.dir, sub), pj(pkg.dir, "src", sub)] : [...pkg.main.map((m) => pj(pkg.dir, m)), pj(pkg.dir, "src/index"), pj(pkg.dir, "index")];
  for (const t of tries) { const r = tryFile(t, has); if (r) return [r]; }
  // A workspace package whose entry cannot be found statically: depend on every source file of it (over-approximation, never under).
  return files.filter((f) => under(f, pkg.dir) && ecosystemOf(f) === "js" && !JS_TEST_RE.test(f));
}

/** Imported module names of a Python source: [{level, module, names}] (`level` = leading dots of a relative import). */
export function pyImports(src) {
  const out = [], text = String(src);
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const names = m[3].replace(/[()\\]/g, " ").replace(/#.*$/gm, "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter((n) => /^\w+$/.test(n));
    out.push({ level: m[1].length, module: m[2], names });
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w., \t]+)/gm)) for (const part of m[1].split(",")) {
    const name = part.trim().split(/\s+as\s+/)[0].trim();
    if (/^[\w.]+$/.test(name)) out.push({ level: 0, module: name, names: [] });
  }
  // String references that import at run time: importlib, __import__, mock.patch targets, pytest_plugins.
  for (const m of text.matchAll(/\b(?:import_module|__import__|patch(?:\.object)?)\(\s*["']([A-Za-z_][\w.]*)["']/g)) out.push({ level: 0, module: m[1], names: [] });
  for (const m of text.matchAll(/^pytest_plugins\s*=\s*(.+)$/gm)) for (const s of m[1].matchAll(/["']([A-Za-z_][\w.]*)["']/g)) out.push({ level: 0, module: s[1], names: [] });
  return out;
}

/** Files a dotted module name resolves to under `base`: the longest prefix that is a module or package, plus the `__init__.py` of its parents. */
function resolvePy(base, dotted, has) {
  const parts = dotted.split(".").filter(Boolean);
  for (let k = parts.length; k >= 1; k--) {
    const p = pj(base, parts.slice(0, k).join("/"));
    const hit = has(`${p}.py`) ? `${p}.py` : has(`${p}/__init__.py`) ? `${p}/__init__.py` : null;
    if (!hit) continue;
    const out = [hit];
    for (let j = 1; j < k; j++) { const init = `${pj(base, parts.slice(0, j).join("/"))}/__init__.py`; if (has(init)) out.push(init); }
    return out;
  }
  return [];
}
const ancestors = (dir) => { const out = [dir]; let d = dir; while (d !== "") { d = dirOf(d); out.push(d); } return out; };

/**
 * Static dependency graph of the repo's JS/TS and Python files.
 * @param {{files: string[], read: (path: string) => string|null}} p repo-relative posix paths and a reader (null = unreadable)
 * @returns {{deps: Map<string, Set<string>>, dynamic: string[]}} `dynamic` = files with a computed import the graph cannot follow
 */
export function buildGraph({ files, read }) {
  const set = new Set(files), has = (f) => set.has(f);
  const deps = new Map(), dynamic = [];
  const add = (from, to) => { if (to && to !== from) (deps.get(from) ?? deps.set(from, new Set()).get(from)).add(to); };
  const js = { has, files, ...jsResolvers(files, read) };
  const pyRoots = uniq(["", "src", ...files.filter((f) => /^(pyproject\.toml|setup\.(py|cfg)|requirements[^/]*\.txt)$/.test(posix.basename(f))).flatMap((f) => [dirOf(f), pj(dirOf(f), "src")])]);
  for (const f of files) {
    const eco = ecosystemOf(f);
    if (eco === "other") continue;
    const src = read(f);
    if (src == null) continue;
    // A quoted repo path (root-relative or relative to the file) is a dependency too: tests that read a doc, fixture or script by path.
    for (const m of src.matchAll(PATH_LITERAL_RE)) { const lit = m[1].replace(/^\.\//, ""); add(f, has(lit) ? lit : has(pj(dirOf(f), lit)) ? pj(dirOf(f), lit) : null); }
    if (eco === "js") {
      if (JS_DYNAMIC_RE.test(src)) dynamic.push(f);
      for (const spec of jsSpecifiers(src)) for (const to of resolveJs(spec, f, js)) add(f, to);
      continue;
    }
    const here = ancestors(dirOf(f));
    const bases = uniq([...here, ...here.map((d) => pj(d, "src")), ...pyRoots]);
    for (const imp of pyImports(src)) {
      const targets = imp.names.length ? [...imp.names.map((n) => [imp.module, n].filter(Boolean).join(".")), imp.module].filter(Boolean) : [imp.module];
      if (imp.level > 0) {
        let pkg = dirOf(f);
        for (let i = 1; i < imp.level; i++) pkg = dirOf(pkg);
        if (has(`${pkg}/__init__.py`.replace(/^\//, ""))) add(f, `${pkg}/__init__.py`.replace(/^\//, ""));
        for (const t of targets) for (const to of resolvePy(pkg, t, has)) add(f, to);
      } else for (const t of targets) for (const b of bases) { const r = resolvePy(b, t, has); if (r.length) { r.forEach((to) => add(f, to)); break; } }
    }
    if (/\b(?:import_module|__import__)\(\s*[A-Za-z_]/.test(src)) dynamic.push(f);
    // pytest loads every conftest.py from the rootdir down to the test file's directory.
    if (PY_TEST_RE.test(f) || posix.basename(f) === "conftest.py") for (const d of here) add(f, pj(d, "conftest.py") === f ? null : has(pj(d, "conftest.py")) ? pj(d, "conftest.py") : null);
  }
  return { deps, dynamic };
}

/**
 * Tests a change can affect.
 * @param {{files: string[], changed: string[], read: Function, cfg: object}} p
 * @returns {{mode: "all"|"subset"|"none", tests: string[], suites: string[], total: number, reasons: Record<string, string[]>,
 *   run_all: {file: string, why: string}[], ignored: string[], warnings: string[], by_ecosystem: Record<string, string[]>}}
 */
export function selectTests({ files, changed, read, cfg }) {
  const all = testFilesOf(files, cfg), isTest = new Set(all), set = new Set(files);
  const { deps, dynamic } = buildGraph({ files, read });
  const rdeps = new Map();
  for (const [from, tos] of deps) for (const to of tos) (rdeps.get(to) ?? rdeps.set(to, []).get(to)).push(from);
  const picked = new Map(), suites = new Set(), runAll = [], ignored = [], warnings = [];
  const pick = (t, why) => { const r = picked.get(t) ?? picked.set(t, []).get(t); if (r.length < 3 && !r.includes(why)) r.push(why); };
  const changes = uniq((changed ?? []).map((c) => str(c).replace(/^\.\//, "")).filter(Boolean));
  if (!changes.length) runAll.push({ file: "", why: "no changed files were given (unknown diff)" });
  for (const c of changes) {
    if (firstGlob(c, cfg.ignore ?? [])) { ignored.push(c); continue; }
    const trigger = firstGlob(c, cfg.runAll ?? RUN_ALL_DEFAULT);
    if (trigger) { runAll.push({ file: c, why: `matches run-everything glob ${trigger}` }); continue; }
    let mapped = false;
    for (const rule of cfg.suites ?? []) {
      const when = firstGlob(c, rule.when);
      if (!when) continue;
      mapped = true;
      for (const t of rule.targets) {
        if (t === "*") runAll.push({ file: c, why: `ci.tests.suites maps ${when} to everything` });
        else if (t.startsWith("@")) suites.add(t);
        else {
          const hits = all.filter((f) => matchGlob(f, t));
          if (!hits.length) warnings.push(`ci.tests.suites target ${t} (for ${when}) matches no test file`);
          for (const h of hits) pick(h, `${c} matches ${when} => ${t}`);
        }
      }
    }
    if (isTest.has(c)) { pick(c, "changed test file"); mapped = true; }
    else if (!set.has(c) && (cfg.testGlobs?.length ? cfg.testGlobs.some((g) => matchGlob(c, g)) : JS_TEST_RE.test(c) || PY_TEST_RE.test(c))) mapped = true; // a deleted test file
    // Reverse reachability: every test that (transitively) imports the changed file.
    const via = new Map([[c, null]]), queue = [c];
    for (let i = 0; i < queue.length; i++) for (const up of rdeps.get(queue[i]) ?? []) if (!via.has(up)) { via.set(up, queue[i]); queue.push(up); }
    for (const f of queue.slice(1)) {
      if (!isTest.has(f)) continue;
      mapped = true;
      pick(f, via.get(f) === c ? `depends on ${c}` : `reaches ${c} through ${via.get(f)}`);
    }
    if (!mapped) runAll.push({ file: c, why: set.has(c) ? "no test imports it and no ci.tests.suites glob maps it" : "deleted or unknown file that no ci.tests.suites glob maps" });
  }
  const hitDynamic = dynamic.filter((f) => !isTest.has(f)).length;
  if (hitDynamic) warnings.push(`${hitDynamic} file(s) use a computed import the static graph cannot follow (shadow recall measures the effect)`);
  for (const b of cfg.badSuites ?? []) warnings.push(`ci.tests.suites entry ignored (want "<glob> ... => <target> ..."): ${b}`);
  const tests = runAll.length ? all : [...picked.keys()].sort();
  const mode = runAll.length ? "all" : tests.length || suites.size ? "subset" : "none";
  const reasons = Object.fromEntries([...picked.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  const by = {};
  for (const t of tests) (by[ecosystemOf(t)] ??= []).push(t);
  return { mode, tests, suites: [...suites].sort(), total: all.length, reasons, run_all: runAll, ignored, warnings, by_ecosystem: by };
}

/** Why this run must be the full suite whatever the mode: `--full`, a scheduled (nightly) run, or a release branch. */
export function fullReason({ flag = false, event = "", ref = "", baseRef = "", cfg }) {
  if (flag) return "--full was passed";
  if (event === "schedule") return "scheduled run: the full suite always runs nightly";
  const branch = [baseRef, ref.replace(/^refs\/heads\//, "")].map(str).find((b) => b && (cfg.fullBranches ?? []).some((g) => globRe(g).test(b)));
  return branch ? `release branch ${branch}: the full suite always runs on the release commit` : null;
}

/**
 * What actually runs. Skipping is allowed only when enforce is configured, the ledger graduated and nothing forces a full run.
 * @returns {{configured, effective, run: "all"|"selection", why: string, refused?: string}}
 */
export function planRun({ cfg, selection, graduation, full = null }) {
  const configured = cfg.selection;
  if (configured === "off") return { configured, effective: "off", run: "all", why: "ci.tests.selection is off" };
  if (configured === "enforce" && !graduation?.graduated) {
    const refused = `ci.tests.selection: enforce refused: ${graduation?.why ?? "no recall ledger"}`;
    return { configured, effective: "shadow", run: "all", why: refused, refused };
  }
  if (configured === "shadow") return { configured, effective: "shadow", run: "all", why: "shadow: the selection is recorded, the full suite runs" };
  if (full) return { configured, effective: "enforce", run: "all", why: full };
  if (selection.mode === "all") return { configured, effective: "enforce", run: "all", why: selection.run_all[0]?.why ?? "everything is selected" };
  return { configured, effective: "enforce", run: "selection", why: `graduated: ${selection.tests.length} of ${selection.total} test file(s) selected` };
}

// ---- CLI ---------------------------------------------------------------------------------------------------------------
export const TESTS_USAGE = [
  "usage: forgedock tests select [--base <ref>] [--head <ref>] [--changed <file>]... [--changed-from <file|->] [--full] [--json] [--out <file>]",
  "       forgedock tests shard [--shards <n> | --target-seconds <s>] [--max-shards <n>] [--report <file>]... [--from <selection.json>] [--ecosystem js|python] [--json | --matrix]",
  "       forgedock tests recall record --selection <selection.json> [--report <file>]... [--failed <test>]... [--sha <sha>] [--run-id <id>]",
  "       forgedock tests recall [status] [--json] | recall check",
  "       common: [--ledger <file>]",
].join("\n");

const flagVals = (argv, name) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const flagVal = (argv, name) => flagVals(argv, name).at(-1);
function checkFlags(argv, valued, bare) {
  for (let i = 0; i < argv.length; i++) {
    if (valued.includes(argv[i])) { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value\n${TESTS_USAGE}`); i++; }
    else if (!bare.includes(argv[i])) throw new Error(`unknown argument ${argv[i]}\n${TESTS_USAGE}`);
  }
}
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const MAX_SOURCE_BYTES = 1024 * 1024;

/** Repo facts for the CLI: tracked + untracked-unignored files, and a size-capped reader. */
export function repoInputs(cwd) {
  const files = git(cwd, ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean)
    .filter((f) => existsSync(join(cwd, f)));
  const read = (f) => { try { const p = join(cwd, f); return statSync(p).size > MAX_SOURCE_BYTES ? null : readFileSync(p, "utf8"); } catch { return null; } };
  return { files, read };
}
/** Default ledger file: outside the checkout, so a change under test cannot edit its own recall record. */
export function ledgerPath({ cwd, cfg, flag, env = process.env }) {
  if (flag) return flag;
  if (cfg.ledger) return cfg.ledger;
  if (env.FORGEDOCK_TESTS_LEDGER) return env.FORGEDOCK_TESTS_LEDGER;
  let slug = "";
  try { slug = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/.exec(git(cwd, ["remote", "get-url", "origin"]))?.[1].replace("/", "__") ?? ""; } catch { /* no remote */ }
  return join(env.FORGEDOCK_TESTS_DIR || join(homedir(), ".forge", "tests"), slug || createHash("sha1").update(cwd).digest("hex").slice(0, 12), "recall.jsonl");
}

async function selectFromCli(argv, { out, cwd, env, now, stdin }) {
  checkFlags(argv, ["--base", "--head", "--changed", "--changed-from", "--out", "--ledger", "--event", "--ref", "--base-ref"], ["--full", "--json"]);
  const cfg = readTestsConfig(cwd);
  const emit = (res) => {
    if (flagVal(argv, "--out")) writeFileSync(flagVal(argv, "--out"), `${JSON.stringify(res, null, 2)}\n`);
    if (argv.includes("--json")) { out(JSON.stringify(res, null, 2)); return 0; }
    out(`tests: selection ${res.plan.configured}${res.plan.configured !== res.plan.effective ? ` -> ${res.plan.effective}` : ""}; run ${res.plan.run} (${res.plan.why})`);
    if (!res.selection) return 0;
    const s = res.selection;
    out(`selected: ${s.mode === "all" ? `all ${s.total}` : `${s.tests.length} of ${s.total}`} test file(s)${s.suites.length ? `, suites ${s.suites.join(" ")}` : ""}`);
    for (const r of s.run_all) out(`  everything: ${r.file ? `${r.file}: ` : ""}${r.why}`);
    if (s.mode !== "all") for (const [t, why] of Object.entries(s.reasons)) out(`  ${t}: ${why.join("; ")}`);
    for (const f of s.ignored) out(`  ignored: ${f}`);
    for (const w of s.warnings) out(`  warning: ${w}`);
    for (const q of res.quarantined) out(`  quarantined${q.blocking ? "" : " (non-blocking)"}: ${q.target} flaked ${q.count}x`);
    if (res.graduation) out(`recall: ${res.graduation.why}`);
    return 0;
  };
  if (cfg.selection === "off") return emit({ plan: planRun({ cfg }), selection: null, run_tests: null, quarantined: [], graduation: null });
  let changed = flagVals(argv, "--changed");
  const from = flagVal(argv, "--changed-from");
  if (from) changed = [...changed, ...String(from === "-" ? await stdin() : readFileSync(from, "utf8")).split(/\r?\n|\0/)];
  const base = flagVal(argv, "--base") ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : null);
  if (!changed.length && !from) {
    if (!base) throw new Error(`tests select needs --base <ref>, --changed or --changed-from\n${TESTS_USAGE}`);
    changed = git(cwd, ["-c", "core.quotepath=off", "diff", "--name-only", "-z", `${base}...${flagVal(argv, "--head") ?? "HEAD"}`]).split("\0");
  }
  const { files, read } = repoInputs(cwd);
  const selection = selectTests({ files, changed, read, cfg });
  const { readLedger, graduation: grad, quarantineFromLedger } = await import("./testengine-recall.mjs");
  const entries = readLedger(ledgerPath({ cwd, cfg, flag: flagVal(argv, "--ledger"), env }));
  const graduation = grad(entries, { after: cfg.graduateAfter, minFailing: cfg.graduateMinFailing, config: configHash(cfg) });
  const full = fullReason({ flag: argv.includes("--full"), event: flagVal(argv, "--event") ?? env.GITHUB_EVENT_NAME ?? "", ref: flagVal(argv, "--ref") ?? env.GITHUB_REF ?? "", baseRef: flagVal(argv, "--base-ref") ?? env.GITHUB_BASE_REF ?? "", cfg });
  const plan = planRun({ cfg, selection, graduation, full });
  const run_tests = plan.run === "selection" ? selection.tests : testFilesOf(files, cfg);
  return emit({ plan, config: configHash(cfg), selection, run_tests, run_suites: plan.run === "selection" ? selection.suites : null, quarantined: quarantineFromLedger(entries, cfg, now), graduation });
}

async function shardFromCli(argv, { out, cwd }) {
  checkFlags(argv, ["--shards", "--target-seconds", "--max-shards", "--report", "--from", "--ecosystem"], ["--json", "--matrix"]);
  const cfg = readTestsConfig(cwd);
  const { parseReport, fileDurations, planShards } = await import("./testengine-shard.mjs");
  const all = testFilesOf(repoInputs(cwd).files, cfg);
  let files = all;
  if (flagVal(argv, "--from")) {
    const sel = JSON.parse(readFileSync(flagVal(argv, "--from"), "utf8"));
    files = sel.run_tests ?? sel.selection?.tests ?? sel.tests ?? all;
  }
  const eco = flagVal(argv, "--ecosystem");
  if (eco) files = files.filter((f) => ecosystemOf(f) === eco);
  const durations = fileDurations(flagVals(argv, "--report").flatMap((r) => parseReport(readFileSync(r, "utf8"))), all);
  const num = (name, d) => { const v = flagVal(argv, name); if (v === undefined) return d; if (!(Number(v) > 0)) throw new Error(`${name} must be a positive number`); return Number(v); };
  const plan = planShards({ files, durations, shards: num("--shards", cfg.shards), targetS: num("--target-seconds", cfg.shardTargetS), maxShards: num("--max-shards", 0) });
  if (argv.includes("--matrix")) { out(JSON.stringify(plan.matrix)); return 0; }
  if (argv.includes("--json")) { out(JSON.stringify(plan, null, 2)); return 0; }
  const timed = plan.source === "durations";
  out(timed ? `shards: ${plan.shards.length} by durations; estimated longest ${plan.est_max_s} s of ${plan.est_total_s} s total (${plan.known} of ${files.length} file(s) have a recorded duration)`
    : `shards: ${plan.shards.length} by file count (no recorded durations; pass --report <junit.xml|tap|json>)`);
  for (const s of plan.shards) out(`  shard ${s.index}/${plan.shards.length}: ${s.files.length} file(s)${timed ? `, ~${s.est_s} s` : ""}`);
  for (const o of plan.oversize) out(`  oversize: ${o.file} takes ~${o.s} s alone, over the ${plan.target_s} s target: no file split can shorten it`);
  return 0;
}

async function recallFromCli(argv, { out, cwd, env, now }) {
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "status", rest = argv[0] === sub ? argv.slice(1) : argv;
  if (!["record", "status", "check"].includes(sub)) throw new Error(`unknown tests recall subcommand ${sub}\n${TESTS_USAGE}`);
  checkFlags(rest, ["--selection", "--report", "--failed", "--sha", "--run-id", "--ledger", "--event"], ["--json"]);
  const cfg = readTestsConfig(cwd);
  const R = await import("./testengine-recall.mjs");
  const file = ledgerPath({ cwd, cfg, flag: flagVal(rest, "--ledger"), env });
  if (sub === "record") {
    if (cfg.selection === "off") { out("tests recall: ci.tests.selection is off; nothing recorded"); return 0; }
    if (!flagVal(rest, "--selection")) throw new Error(`tests recall record needs --selection <selection.json>\n${TESTS_USAGE}`);
    const sel = JSON.parse(readFileSync(flagVal(rest, "--selection"), "utf8"));
    if (!sel.selection) { out("tests recall: the selection file has no selection (mode off); nothing recorded"); return 0; }
    const { parseReport, failedFiles } = await import("./testengine-shard.mjs");
    const known = testFilesOf(repoInputs(cwd).files, cfg);
    const fromReports = failedFiles(flagVals(rest, "--report").flatMap((r) => parseReport(readFileSync(r, "utf8"))), known);
    let sha = flagVal(rest, "--sha") ?? env.GITHUB_SHA;
    if (!sha) try { sha = git(cwd, ["rev-parse", "HEAD"]).trim(); } catch { sha = ""; }
    const entry = R.recallEntry({ selection: sel.selection, ran: sel.plan?.run ?? "all", config: sel.config ?? configHash(cfg), failed: [...fromReports.failed, ...flagVals(rest, "--failed")],
      unattributed: fromReports.unattributed, sha, runId: flagVal(rest, "--run-id") ?? env.GITHUB_RUN_ID ?? null, event: flagVal(rest, "--event") ?? env.GITHUB_EVENT_NAME ?? null, now });
    R.appendLedger(file, entry);
    if (rest.includes("--json")) out(JSON.stringify(entry));
    else out(`tests recall: ${entry.ok ? "ok" : "MISS"}: ${entry.failed.length} failing test file(s), ${entry.missed.length} outside the selection${entry.unattributed.length ? `, ${entry.unattributed.length} failure(s) without a file` : ""}${entry.missed.length ? `: ${entry.missed.join(" ")}` : ""}`);
    return 0; // recording never fails the build: the full suite's own result is the gate
  }
  const entries = R.readLedger(file);
  const g = R.graduation(entries, { after: cfg.graduateAfter, minFailing: cfg.graduateMinFailing, config: configHash(cfg) });
  const quarantined = R.quarantineFromLedger(entries, cfg, now);
  if (rest.includes("--json")) out(JSON.stringify({ ledger: file, selection: cfg.selection, runs: entries.length, graduation: g, quarantined }, null, 2));
  else {
    out(`ledger: ${file} (${entries.length} run(s)); ci.tests.selection: ${cfg.selection}`);
    out(`recall: ${g.why}`);
    if (g.last_miss) out(`last miss: ${g.last_miss.sha?.slice(0, 12) || "?"} at ${g.last_miss.at}: ${[...g.last_miss.missed, ...g.last_miss.unattributed.map((u) => `(no file) ${u}`)].join(" ")}`);
    for (const q of quarantined) out(`quarantined${q.blocking ? "" : " (non-blocking)"}: ${q.target} flaked ${q.count}x in ${cfg.quarantineWindowDays} d: ${q.why}`);
  }
  return sub === "check" && !g.graduated ? 1 : 0;
}

/** `forgedock tests select|shard|recall`. */
export async function testsFromCli(argv, deps = {}) {
  const ctx = { out: deps.out ?? ((l) => console.log(l)), cwd: deps.cwd ?? process.cwd(), env: deps.env ?? process.env, now: deps.now ?? Date.now(),
    stdin: deps.stdin ?? (async () => { let s = ""; for await (const c of process.stdin) s += c; return s; }) };
  if (argv[0] === "select") return selectFromCli(argv.slice(1), ctx);
  if (argv[0] === "shard") return shardFromCli(argv.slice(1), ctx);
  if (argv[0] === "recall") return recallFromCli(argv.slice(1), ctx);
  throw new Error(TESTS_USAGE);
}

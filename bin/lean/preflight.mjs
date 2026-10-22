// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4328: freeze-time preflight of a contract's validate commands. Pure: derives the host tools a command needs
 * (each segment's bare executable, Python modules a bare python imports via -c/-m, Node packages `node -e` code imports)
 * and a read-only bash probe for each. The engine runs the probes (lean.mjs) before the implement session, so a validate
 * command the host cannot run is corrected in the plan instead of found after the build (#4323 env.tool_missing).
 * #4393: text alone misses wrapped interpreters (`uv run python -m x`) and transitive imports, so `runPreflight` also runs
 * each command once on the base worktree and classifies its output (`runProbeMiss`); `unsetEnvVars` flags `$NAME`s the lane
 * env leaves empty (#4325).
 */
import { builtinModules } from "node:module";
import { missingTool } from "./conformance.mjs";

export const PREFLIGHT_CAP = 20;
const KIND_NAME = { command: "command", "python-module": "Python module", "node-module": "Node package", path: "path", "env-var": "env var" };
const PY_RE = /^python(\d+(\.\d+)?)?$/;
const PY_ARG_FLAGS = new Set(["-W", "-X", "-Q"]);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Quote-aware split of a bash command into segments (on &&, ||, |, ;, newline) of unquoted words; `$(...)` stays one word. */
export function shellSegments(command) {
  const segs = [];
  let words = [], word = "", has = false, q = null, depth = 0;
  const endWord = () => { if (has) words.push(word); word = ""; has = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  const s = String(command ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else word += ch; continue; }
    if (ch === "\\" && i + 1 < s.length) { word += s[++i]; has = true; continue; }
    if (q === '"') { if (ch === '"') q = null; else word += ch; continue; }
    if (depth) { word += ch; if (ch === "(") depth++; else if (ch === ")") depth--; continue; }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === "$" && s[i + 1] === "(") { word += "$("; i++; depth = 1; has = true; continue; }
    if (ch === " " || ch === "\t") { endWord(); continue; }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") { if (ch === "&" && s[i + 1] !== "&") { endWord(); continue; } endSeg(); if (s[i + 1] === ch) i++; continue; }
    if ((ch === "(" || ch === ")" || ch === "{" || ch === "}") && !has) continue;
    word += ch; has = true;
  }
  endSeg();
  return segs;
}

/** Top-level module names a Python `-c` program imports (absolute imports only). */
export function pythonImports(code) {
  const out = [];
  for (const line of String(code ?? "").split(/[;\n]/)) {
    const imp = /^\s*import\s+(.+)$/.exec(line), from = /^\s*from\s+([\w.]+)\s+import\b/.exec(line);
    if (imp) for (const part of imp[1].split(",")) { const m = /^\s*([A-Za-z_]\w*)/.exec(part); if (m) out.push(m[1]); }
    else if (from && !from[1].startsWith(".")) out.push(from[1].split(".")[0]);
  }
  for (const m of String(code ?? "").matchAll(/(?:__import__|import_module)\(\s*['"]([A-Za-z_][\w.]*)['"]/g)) out.push(m[1].split(".")[0]);
  return [...new Set(out)].filter((x) => x !== "__future__");
}

/** Package names (bare specifiers, cut to the package) a `node -e` program imports; builtins, node:, relative and absolute are not packages. */
export function nodeImports(code) {
  const specs = [], c = String(code ?? "");
  for (const re of [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g, /\bfrom\s*['"]([^'"]+)['"]/g, /(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g]) for (const m of c.matchAll(re)) specs.push(m[1]);
  const out = [];
  for (const spec of specs) {
    if (/^(\.|\/|node:|file:|data:)/.test(spec)) continue;
    const parts = spec.split("/"), pkg = spec.startsWith("@") ? (parts.length > 1 ? parts.slice(0, 2).join("/") : null) : parts[0];
    if (pkg && !builtinModules.includes(pkg)) out.push(pkg);
  }
  return [...new Set(out)];
}

const PY_PROBE = "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 3)";
const NODE_PROBE = "const m=require('module'),p=require('path'),f=require('fs'),n=process.argv[1];if(m.builtinModules.includes(n))process.exit(0);for(let d=process.cwd();;){if(f.existsSync(p.join(d,'node_modules',n,'package.json')))process.exit(0);const u=p.dirname(d);if(u===d)process.exit(3);d=u}";

/** The program text and modules of one python/node segment's arguments. */
function moduleNeeds(exe, args) {
  if (PY_RE.test(exe)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-c") return pythonImports(args[i + 1]);
      if (a.startsWith("-c") && a.length > 2) return pythonImports(a.slice(2));
      if (a === "-m") return args[i + 1] ? [args[i + 1].split(".")[0]] : [];
      if (a.startsWith("-m") && a.length > 2) return [a.slice(2).split(".")[0]];
      if (PY_ARG_FLAGS.has(a)) { i++; continue; }
      if (!a.startsWith("-")) return [];
    }
    return [];
  }
  if (exe === "node") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (["-e", "--eval", "-p", "--print"].includes(a)) return nodeImports(args[i + 1]);
      const eq = /^--(?:eval|print)=(.*)$/s.exec(a);
      if (eq) return nodeImports(eq[1]);
      if (!a.startsWith("-")) return [];
    }
  }
  return [];
}

/**
 * The probes for `contract.validate[]`: {probes: [{ids, tool, kind, interp, needs, probe}], dropped}. `needs` is the command
 * probe (tool) a module probe depends on: skip the module probe when its interpreter is missing. A name `repoHas(name)` holds
 * or a deliverable's change text names (the change adds it) is not probed; paths and `$...` words are never probed.
 */
export function preflightProbes(contract, { repoHas = () => false, cap = PREFLIGHT_CAP } = {}) {
  const changes = (Array.isArray(contract?.deliverables) ? contract.deliverables : []).map((d) => String(d?.change ?? "")).join("\n");
  const named = (name) => new RegExp(`(^|[^\\w@/.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`).test(changes);
  const skip = (name) => !name || name.includes("/") && !name.startsWith("@") || name.startsWith("$") || repoHas(name) || named(name);
  const byKey = new Map();
  const add = (id, kind, tool, interp = null) => {
    const key = `${kind}|${tool}|${interp ?? ""}`;
    const p = byKey.get(key);
    if (p) { if (!p.ids.includes(id)) p.ids.push(id); return; }
    const probe = kind === "command" ? `command -v -- ${sq(tool)} >/dev/null 2>&1`
      : kind === "python-module" ? `${sq(interp)} -c ${sq(PY_PROBE)} ${sq(tool)} >/dev/null 2>&1`
      : `node -e ${sq(NODE_PROBE)} ${sq(tool)} >/dev/null 2>&1`;
    byKey.set(key, { ids: [id], tool, kind, interp, needs: kind === "command" ? null : interp, probe });
  };
  for (const v of Array.isArray(contract?.validate) ? contract.validate : []) {
    if (!v?.id || typeof v.command !== "string") continue;
    for (const seg of shellSegments(v.command)) {
      let i = 0;
      while (i < seg.length && (/^[A-Za-z_]\w*=/.test(seg[i]) || ["!", "time", "exec", "command", "env"].includes(seg[i]))) i++;
      const exe = seg[i];
      if (!exe || exe.includes("/") || exe.startsWith("$") || exe.startsWith("-")) continue;
      if (!skip(exe)) add(v.id, "command", exe);
      const kind = exe === "node" ? "node-module" : "python-module";
      for (const mod of moduleNeeds(exe, seg.slice(i + 1))) if (!skip(mod)) add(v.id, kind, mod, exe);
    }
  }
  const all = [...byKey.values()];
  return { probes: all.slice(0, cap), dropped: Math.max(0, all.length - cap) };
}

const FIX_HOW = "run the check through the repo's own toolchain (its virtualenv, lockfile-pinned runner or package scripts) or use a check that does not need it, never a global install";
/** One contract problem per miss: names the validate ids and the tool (or path, or env var), and how to fix the plan (never a global install). */
export function preflightProblems(misses) {
  return (misses ?? []).map((m) => {
    const ids = m.ids.join(", ");
    if (m.kind === "env-var") return `${ids}: uses $${m.tool}, which is unset or empty in the lane environment, so the validate command cannot run as written; set it inside the command or ${FIX_HOW}`;
    if (m.source === "run") return `${ids}: running it on the base worktree stopped before any test ran: needs ${KIND_NAME[m.kind] ?? m.kind} '${m.tool}'${m.line ? ` (\`${m.line}\`)` : ""}, so the validate command cannot run here; ${m.kind === "path" ? "point it at a path the repo or a deliverable has, or " : ""}${FIX_HOW}`;
    return `${ids}: needs ${KIND_NAME[m.kind] ?? m.kind} '${m.tool}'${m.interp ? ` (for ${m.interp})` : ""}, which this host lacks, so the validate command cannot run here; ${FIX_HOW}`;
  });
}

/** #4393: per-command timeout and total budget of the freeze-time runs; a command cut by either is no evidence. */
export const RUN_PROBE_MS = 30000, RUN_BUDGET_MS = 120000;
const TIMEOUT_RC = 124;
// bash sets these itself; they are never "missing from the lane env"
const SHELL_VARS = new Set(["RANDOM", "SECONDS", "LINENO", "PWD", "OLDPWD", "HOME", "UID", "EUID", "PPID", "BASHPID", "IFS", "HOSTNAME", "SHELL", "USER", "PATH", "BASH", "BASH_SOURCE", "BASH_VERSION", "BASH_REMATCH", "PIPESTATUS", "FUNCNAME", "EPOCHSECONDS", "EPOCHREALTIME", "SHLVL", "OPTARG", "OPTIND", "REPLY", "HOSTTYPE", "OSTYPE", "MACHTYPE", "GROUPS"]);

/**
 * `$NAME` / `${NAME}` references (outside single quotes, not escaped) that are unset or empty in `env` and that the command
 * does not assign itself (`NAME=`, `export NAME=`, `for NAME in`). `${NAME:-x}`-style defaults, `${#NAME}` and specials are not flagged.
 */
export function unsetEnvVars(command, env = {}) {
  const s = String(command ?? ""), refs = [];
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === "\\") { i++; continue; }
    if (ch === '"') { q = q ? null : '"'; continue; }
    if (ch === "'" && !q) { q = "'"; continue; }
    if (ch !== "$") continue;
    const m = /^\{([A-Za-z_]\w*)(\}|:?[-=+?])|^([A-Za-z_]\w*)/.exec(s.slice(i + 1));
    if (m && (m[3] || m[2] === "}")) refs.push(m[1] ?? m[3]);
  }
  const assigned = (n) => new RegExp(`(^|[\\s;&|(])((export|local|readonly|declare)\\s+)?${n}=|\\bfor\\s+${n}\\s+in\\b`).test(s);
  return [...new Set(refs)].filter((n) => !SHELL_VARS.has(n) && (env[n] === undefined || env[n] === null || env[n] === "") && !assigned(n));
}

// [rc, pattern]: bash could not exec a path (127), python could not open its script, pytest / node --test could not find a file
const PATH_MISSING_RES = [[127, /(?:^|\s)([^\s:'"`]+): No such file or directory/m], [null, /can't open file '([^']+)'/], [null, /file or directory not found: (\S+)/], [null, /Could not find '([^']+)'/]];
const TESTISH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;

/**
 * #4393: why one freeze-time run of a validate command shows it cannot run on this host, or null when it ran (passed, or
 * failed on test content: RED on base is expected), timed out (no evidence) or gave no recognisable reason.
 * A path counts as missing unless `knownPath(path)` (repo-tracked, a deliverable, the repro test) or it looks like a test the
 * builder adds; a module goes through conformance.mjs `missingTool` with `repoHas`, as the post-build gate does.
 * Returns {tool, kind: command|python-module|node-module|path, line} with the output line that showed it.
 */
export function runProbeMiss(r, { repoHas = () => false, command = "", knownPath = () => false } = {}) {
  const rc = r?.rc, out = String(r?.output ?? "");
  if (!Number.isInteger(rc) || rc === 0 || rc === TIMEOUT_RC) return null;
  const lineOf = (needle) => (out.split("\n").find((l) => l.includes(needle)) ?? "").trim().slice(0, 160);
  for (const [onlyRc, re] of PATH_MISSING_RES) {
    const p = onlyRc === null || onlyRc === rc ? re.exec(out)?.[1] : null;
    if (!p) continue;
    if (TESTISH_RE.test(p) || knownPath(p)) return null;
    return { tool: p, kind: "path", line: lineOf(p) };
  }
  const miss = missingTool(r, { repoHas, command });
  return miss ? { ...miss, line: lineOf(miss.tool) } : null;
}

/**
 * #4393: what a freeze-time run may legitimately not find yet: `repoHas` (a name the repo tracks or a deliverable's change
 * text names) and `knownPath` (a tracked file, a deliverable or the repro test, matched as a suffix of an absolute path).
 */
export function knownToContract(contract, files = []) {
  const changes = (Array.isArray(contract?.deliverables) ? contract.deliverables : []).map((d) => String(d?.change ?? "")).join("\n");
  const paths = [...files, ...(contract?.deliverables ?? []).map((d) => d?.path), contract?.repro_test?.path].filter((x) => typeof x === "string" && x).map((x) => x.replace(/^\.\//, "").replace(/\/+$/, ""));
  const segs = new Set(paths.flatMap((x) => x.split("/")));
  const repoHas = (name) => segs.has(name) || segs.has(`${name}.py`) || new RegExp(`(^|[^\\w@/.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`).test(changes);
  const knownPath = (p) => { const rel = String(p).replace(/^\.\//, ""); return paths.some((k) => rel === k || rel.endsWith(`/${k}`) || rel.startsWith(`${k}/`) || rel.includes(`/${k}/`)); };
  return { repoHas, knownPath };
}

const porcelain = (out) => new Map(String(out ?? "").split("\n").filter((l) => l.length > 3).map((l) => [l.slice(3), l.slice(0, 2)]));

/**
 * #4393: run each `contract.validate[]` command (ids in `skipIds` excepted) once through `run({command, timeoutMs, env})`,
 * 30 s each inside a 120 s budget, and classify each with `runProbeMiss`. `git(args)` runs in the worktree: whatever the runs
 * newly created or modified (`git status --porcelain`) is reverted; a path dirty before the runs is never touched.
 * Returns {misses: [{ids, tool, kind, line, source: "run"}], skipped: ids not run (budget), reverted: paths}.
 */
export async function runPreflight({ contract, run, git, env = {}, repoHas = () => false, knownPath = () => false, skipIds = [], now = () => Date.now(), perCommandMs = RUN_PROBE_MS, budgetMs = RUN_BUDGET_MS }) {
  const misses = [], skipped = [], reverted = [];
  const todo = (Array.isArray(contract?.validate) ? contract.validate : []).filter((v) => v?.id && typeof v.command === "string" && !skipIds.includes(v.id));
  if (!todo.length) return { misses, skipped, reverted };
  const status = async () => porcelain(await git(["status", "--porcelain", "--untracked-files=all"]).catch(() => ""));
  const before = await status(), deadline = now() + budgetMs;
  for (const v of todo) {
    const left = deadline - now();
    if (left <= 0) { skipped.push(v.id); continue; }
    let r;
    try { r = await run({ command: v.command, timeoutMs: Math.min(perCommandMs, left), env }); } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
    const miss = runProbeMiss(r, { repoHas, command: v.command, knownPath });
    if (miss) misses.push({ ids: [v.id], ...miss, source: "run" });
  }
  const after = await status();
  for (const [path, xy] of after) {
    if (before.has(path) || path.includes(" -> ")) continue;
    try { await git(xy === "??" ? ["clean", "-fdq", "--", path] : ["checkout", "--", path]); reverted.push(path); } catch { /* left as is; the scope gate still sees it */ }
  }
  return { misses, skipped, reverted };
}

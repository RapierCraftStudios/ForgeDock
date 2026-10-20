// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4328: freeze-time preflight of a contract's validate commands. Pure: derives the host tools a command needs
 * (each segment's bare executable, Python modules a bare python imports via -c/-m, Node packages `node -e` code imports)
 * and a read-only bash probe for each. The engine runs the probes (lean.mjs) before the implement session, so a validate
 * command the host cannot run is corrected in the plan instead of found after the build (#4323 env.tool_missing).
 */
import { builtinModules } from "node:module";

export const PREFLIGHT_CAP = 20;
const KIND_NAME = { command: "command", "python-module": "Python module", "node-module": "Node package" };
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

/** One contract problem per missed probe: names the validate ids and the tool, and how to fix the plan (never a global install). */
export function preflightProblems(misses) {
  return (misses ?? []).map((m) => `${m.ids.join(", ")}: needs ${KIND_NAME[m.kind] ?? m.kind} '${m.tool}'${m.interp ? ` (for ${m.interp})` : ""}, which this host lacks, so the validate command cannot run here; run the check through the repo's own toolchain (its virtualenv, lockfile-pinned runner or package scripts) or use a check that does not need it, never a global install`);
}

#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// symbol-index.mjs: JS/TS twin of scripts/symbol-index.py (forge#4208), same output schema.
// No new dependencies: the `typescript` package is loaded from the target repo (resolved from the target path, then
// cwd). When it is not installed the run prints only {"unsupported":"ts"|"js","reason":"no-parser"} and exits 0.
// .py targets are handed to symbol-index.py. Never emits source text or literal values.
//
// Usage: node scripts/symbol-index.mjs <file | dir>...
// Output: {"symbols":[{name,kind,start,end,lines,public[,file]}], "edges":[{from,to}],
//          "imports":[{module,names,line[,file]}], "cycles":[[module,...],...]}
//   kind: function|async_function|class|method|const|interface|type|enum. public = exported (methods: exported class
//   and not private/#private). One file: bare names; otherwise `file` on entries and "<module>:<symbol>" edge ends,
//   module = path relative to its root without extension (index files name their directory). cycles = strongly
//   connected components of the relative-import graph between indexed modules (`import type` ignored).
// Exit: 0 ok or unsupported | 2 usage or missing path.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TS_EXT = [".ts", ".tsx", ".mts", ".cts"];
const JS_EXT = [".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
const OTHER = { ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java", ".sh": "shell", ".php": "php" };

const emit = (o) => process.stdout.write(JSON.stringify(sortKeys(o)) + "\n");
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const langOf = (ext) => (TS_EXT.includes(ext) ? "ts" : JS_EXT.includes(ext) ? "js" : ext === ".py" ? "python" : OTHER[ext] || ext.slice(1) || "unknown");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function loadTs(targets) {
  const bases = [...targets.map((t) => path.resolve(statSync(t).isDirectory() ? t : path.dirname(t))), process.cwd()];
  for (const b of bases) {
    // typescript >= 7 (native port) ships no in-process compiler API at the package root: skip it.
    try { const ts = createRequire(path.join(b, "noop.js"))("typescript"); if (typeof ts?.createSourceFile === "function") return ts; } catch { /* try next */ }
  }
  return null;
}

function collect(roots) {
  const found = [];
  for (const root of roots) {
    if (statSync(root).isFile()) {
      const ext = path.extname(root).toLowerCase();
      found.push({ file: root, module: path.basename(root, path.extname(root)), ext });
      continue;
    }
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name))) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!ent.name.startsWith(".") && !SKIP_DIRS.has(ent.name)) walk(p); continue; }
        const ext = path.extname(ent.name).toLowerCase();
        if (![...TS_EXT, ...JS_EXT].includes(ext) || /\.d\.[cm]?ts$/.test(ent.name)) continue;
        let mod = path.relative(root, p).slice(0, -ext.length).split(path.sep).join("/");
        if (mod === "index" || mod.endsWith("/index")) mod = mod.slice(0, -"index".length).replace(/\/$/, "") || ".";
        found.push({ file: p, module: mod, ext });
      }
    };
    walk(root);
  }
  return found.sort((a, b) => cmp(a.file, b.file));
}

function tarjan(graph) {
  let i = 0;
  const index = new Map(), low = new Map(), on = new Set(), stack = [], comps = [];
  const visit = (v) => {
    index.set(v, i); low.set(v, i); i++; stack.push(v); on.add(v);
    for (const w of [...(graph.get(v) || [])].sort()) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      comps.push(comp.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
  return comps;
}

function index(ts, entries, multi) {
  const K = ts.SyntaxKind;
  const byFile = new Map(entries.map((e) => [path.resolve(e.file), e]));
  const symbols = [], imports = [], edges = new Set(), graph = new Map(entries.map((e) => [e.module, new Set()]));
  const tables = new Map(); // module -> Map(name -> node)
  const parsed = entries.map((e) => {
    const src = ts.createSourceFile(e.file, readFileSync(e.file, "utf8"), ts.ScriptTarget.Latest, true,
      e.ext.endsWith("x") ? ts.ScriptKind.TSX : undefined);
    if (src.parseDiagnostics?.length) throw { lang: langOf(e.ext), reason: `parse-error: ${e.file}` };
    return { e, src };
  });
  const line = (src, pos) => src.getLineAndCharacterOfPosition(pos).line + 1;
  const exported = (n) => (ts.getCombinedModifierFlags?.(n) ?? 0) & ts.ModifierFlags.Export;
  const ref = (e, name) => (multi ? `${e.module}:${name}` : name);

  for (const { e, src } of parsed) {
    const table = new Map();
    tables.set(e.module, table);
    const add = (name, kind, node, pub, owner = null) => {
      const start = line(src, node.getStart(src)), end = line(src, node.getEnd());
      symbols.push({ name, kind, start, end, lines: end - start + 1, public: !!pub, ...(multi ? { file: e.file } : {}) });
      table.set(name, { node, owner });
    };
    const exportNames = new Set();
    for (const st of src.statements) {
      if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) exportNames.add((el.propertyName || el.name).text);
      } else if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) exportNames.add(st.expression.text);
    }
    const pub = (n, name) => exported(n) || exportNames.has(name);
    for (const st of src.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) {
        const isAsync = (st.modifiers || []).some((m) => m.kind === K.AsyncKeyword);
        add(st.name.text, isAsync ? "async_function" : "function", st, pub(st, st.name.text));
      } else if (ts.isClassDeclaration(st) && st.name) {
        const cname = st.name.text, cpub = pub(st, cname);
        add(cname, "class", st, cpub);
        for (const m of st.members) {
          if (!(ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isConstructorDeclaration(m))) continue;
          const mname = ts.isConstructorDeclaration(m) ? "constructor" : m.name && (m.name.text ?? m.name.getText(src));
          if (!mname || table.has(`${cname}.${mname}`)) continue;
          const priv = (m.modifiers || []).some((x) => x.kind === K.PrivateKeyword) || String(mname).startsWith("#");
          add(`${cname}.${mname}`, "method", m, cpub && !priv, cname);
        }
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) add(d.name.text, "const", d, exported(st) || exportNames.has(d.name.text));
        }
      } else if (ts.isInterfaceDeclaration(st)) add(st.name.text, "interface", st, pub(st, st.name.text));
      else if (ts.isTypeAliasDeclaration(st)) add(st.name.text, "type", st, pub(st, st.name.text));
      else if (ts.isEnumDeclaration(st)) add(st.name.text, "enum", st, pub(st, st.name.text));
    }
  }

  const resolveSpec = (fromFile, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    const stem = base.replace(/\.(m|c)?js$/, "");
    const cands = [base, ...[...TS_EXT, ...JS_EXT].flatMap((x) => [stem + x, path.join(base, "index" + x)])];
    for (const c of cands) if (byFile.has(c)) return byFile.get(c).module;
    return null;
  };

  for (const { e, src } of parsed) {
    const table = tables.get(e.module), bindings = new Map();
    for (const st of src.statements) {
      const isImp = ts.isImportDeclaration(st), isRe = ts.isExportDeclaration(st) && st.moduleSpecifier;
      if (!isImp && !isRe) continue;
      const spec = st.moduleSpecifier.text, names = [];
      const typeOnly = isImp ? !!st.importClause?.isTypeOnly : !!st.isTypeOnly;
      const target = resolveSpec(e.file, spec);
      const clause = isImp ? st.importClause : null;
      if (clause?.name) { names.push("default"); bindings.set(clause.name.text, [target, "default"]); }
      const nb = isImp ? clause?.namedBindings : st.exportClause;
      if (nb && ts.isNamespaceImport(nb)) { names.push("*"); bindings.set(nb.name.text, [target, null]); }
      else if (nb && (ts.isNamedImports(nb) || ts.isNamedExports(nb))) {
        for (const el of nb.elements) {
          const orig = (el.propertyName || el.name).text;
          names.push(orig);
          if (isImp) bindings.set(el.name.text, [target, orig]);
        }
      }
      imports.push({ module: target ?? spec, names: names.sort(), line: line(src, st.getStart(src)), ...(multi ? { file: e.file } : {}) });
      if (target !== null && !typeOnly) graph.get(e.module).add(target);
    }
    for (const [name, { node, owner }] of table) {
      const from = ref(e, name);
      const roots = ts.isClassDeclaration(node)
        ? [...(node.heritageClauses || []), ...node.members.filter((m) => !(ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isConstructorDeclaration(m)))]
        : [node];
      const visit = (n) => {
        let to = null;
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
          const obj = n.expression;
          if (owner && obj.kind === K.ThisKeyword && table.has(`${owner}.${n.name.text}`)) to = ref(e, `${owner}.${n.name.text}`);
          else if (ts.isIdentifier(obj) && bindings.has(obj.text) && bindings.get(obj.text)[1] === null) {
            const [mod] = bindings.get(obj.text);
            if (mod !== null && tables.get(mod)?.has(n.name.text)) to = `${mod}:${n.name.text}`;
          }
        } else if (ts.isIdentifier(n) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
          if (n !== node.name && table.has(n.text)) to = ref(e, n.text);
          else if (bindings.has(n.text)) {
            const [mod, sym] = bindings.get(n.text);
            if (mod !== null && sym !== null && tables.get(mod)?.has(sym)) to = `${mod}:${sym}`;
          }
        }
        if (to && to !== from) edges.add(JSON.stringify([from, to]));
        ts.forEachChild(n, visit);
      };
      for (const r of roots) visit(r);
    }
  }

  const cycles = tarjan(graph).filter((c) => c.length > 1 || graph.get(c[0]).has(c[0])).sort((a, b) => cmp(a.join("\0"), b.join("\0")));
  symbols.sort((a, b) => cmp(a.file || "", b.file || "") || a.start - b.start || cmp(a.name, b.name));
  imports.sort((a, b) => cmp(a.file || "", b.file || "") || a.line - b.line || cmp(a.module, b.module));
  return {
    symbols,
    edges: [...edges].sort().map((s) => { const [from, to] = JSON.parse(s); return { from, to }; }),
    imports,
    cycles,
  };
}

function main(argv) {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    process.stderr.write("usage: symbol-index.mjs <file | dir>...\n");
    return 2;
  }
  for (const p of argv) if (!existsSync(p)) { process.stderr.write(`symbol-index: no such path: ${p}\n`); return 2; }
  const files = argv.filter((p) => statSync(p).isFile());
  const exts = files.map((f) => path.extname(f).toLowerCase());
  if (exts.includes(".py")) {
    if (exts.some((x) => x !== ".py")) return emit({ unsupported: "mixed", reason: "mixed-languages" }), 0;
    const py = path.join(path.dirname(fileURLToPath(import.meta.url)), "symbol-index.py");
    const r = spawnSync("python3", [py, ...argv], { stdio: "inherit" });
    if (r.error) return emit({ unsupported: "python", reason: "no-python3" }), 0;
    return r.status ?? 2;
  }
  const bad = exts.find((x) => ![...TS_EXT, ...JS_EXT].includes(x));
  if (bad !== undefined) return emit({ unsupported: langOf(bad), reason: "unknown-language" }), 0;
  const entries = collect(argv);
  if (!entries.length) return emit({ unsupported: "unknown", reason: "no-js-ts-files" }), 0;
  const lang = entries.some((e) => TS_EXT.includes(e.ext)) ? "ts" : "js";
  const ts = loadTs(argv);
  if (!ts) return emit({ unsupported: lang, reason: "no-parser" }), 0;
  const multi = !(argv.length === 1 && files.length === 1);
  let out;
  try { out = index(ts, entries, multi); } catch (err) {
    if (err && err.reason) return emit({ unsupported: err.lang, reason: err.reason }), 0;
    throw err;
  }
  emit(out);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

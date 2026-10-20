#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// symbol-move.mjs: TypeScript twin of scripts/symbol-move.py for refactor:split (forge#4212, #4196). Moves groups of
// top-level symbols out of one TS module into a sibling directory of modules and leaves a re-export barrel at the old
// path. ts-morph parses the source and resolves every reference; moved statements are copied byte-for-byte from the
// source text, never re-printed. No LLM, no network, no ForgeDock dependency: ts-morph is resolved from the --src
// directory, then the cwd (NODE_PATH is honoured), like `typescript` in scripts/symbol-index.mjs.
//
// Usage: node scripts/symbol-move.mjs --src <file.ts|.tsx|.mts|.cts> --plan <plan.json> [--package <name>] [--extend] [--dry-run]
//        node scripts/symbol-move.mjs --probe [--src <file>]     (only checks that ts-morph resolves)
//   plan: {"<module>": ["<top-level symbol>", ...], ...}, names as scripts/symbol-index.mjs reports them.
//   --package defaults to <stem>_parts, a directory created next to --src. --extend (a chain step of a large split,
//   forge#4211) adds the plan's modules to an existing package dir (created when absent); a module file that already
//   exists in it refuses. Without --extend an existing package path refuses.
// Output (stdout, one JSON object):
//   ok:      {"status":"ok","package":"<package dir, --src's dir joined with the name>","modules":{module:[symbols]},"shim":"<src path>"}
//   probe:   {"status":"ok","tool":"ts-morph"}
//   refused: {"status":"refused","reason":"..."}
// Result: <package>/<module><src ext> per plan entry, each holding, in order: the source's import declarations its
//   symbols use (pruned to the used names; relative specifiers re-based to the package dir), `import { ... } from
//   "./<sibling>"` for symbols moved to sibling modules (`type` on interface/type-alias names), then the moved
//   statements verbatim (leading comments and `export` keywords included) in source order. --src keeps every unmoved
//   statement verbatim and gains, at the position of the first moved statement, `export { ... } from "./<pkg>/<module>"`
//   for every moved name that was exported and `import { ... } from ...` for moved names kept code still uses. New
//   relative specifiers mirror the source's relative-import extension style (.ts, .js or none; the source's own
//   extension when it has no relative import). Every changed line is a moved block or an import/`export ... from`
//   line, so scripts/refactor-verify.sh can prove the move.
// Refuses (no file touched) when ts-morph does not resolve, the source does not parse, or the plan is invalid:
//   unknown or non-top-level symbol, a symbol listed twice, a statement split across modules, a bad or colliding
//   module name, an existing package path (without --extend) or module file, a moved symbol that needs a name declared
//   in --src that stays, a moved non-exported symbol used by kept code or another new module (exporting it would be a
//   logic change), `export default` among the moved statements, module-identity code in moved statements
//   (import.meta, __dirname, __filename, a relative require()/import()), or an import cycle between the new modules.
// Writes are atomic: every file is built in memory, written to a temp file and renamed in, the barrel last.
// Exit: 0 ok | 2 usage or missing file | 3 refused.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const TS_EXT = [".ts", ".tsx", ".mts", ".cts"];
const JS_OF = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

class Refused extends Error {}
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const usage = () => {
  process.stderr.write("usage: symbol-move.mjs --src <file.ts> --plan <plan.json> [--package <name>] [--extend] [--dry-run]\n"
    + "       symbol-move.mjs --probe [--src <file>]\n");
  return 2;
};

function parseArgs(argv) {
  const o = { package: null, dryRun: false, extend: false, probe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--extend") o.extend = true;
    else if (a === "--probe") o.probe = true;
    else if (["--src", "--plan", "--package"].includes(a) && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else return null;
  }
  return o.probe || (o.src && o.plan) ? o : null;
}

/** ts-morph from the --src directory, then the cwd; null when neither resolves it. */
function loadTsMorph(src) {
  const bases = [...(src ? [path.resolve(path.dirname(src))] : []), process.cwd()];
  for (const b of bases) {
    try { const m = createRequire(path.join(b, "noop.js"))("ts-morph"); if (m?.Project && m?.ts) return m; } catch { /* try next */ }
  }
  return null;
}

function loadPlan(file) {
  let plan;
  try { plan = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Refused(`plan is not readable JSON: ${e.message}`); }
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Object.keys(plan).length) throw new Refused("plan must be a non-empty object {module: [symbols]}");
  const lower = new Map();
  for (const [mod, names] of Object.entries(plan)) {
    if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === "string" && n)) throw new Refused(`plan entry ${JSON.stringify(mod)} must be a non-empty list of symbol names`);
    if (!IDENT.test(mod) || mod === "index") throw new Refused(`module name ${JSON.stringify(mod)} is not a valid identifier`);
    const k = mod.toLowerCase();
    if (lower.has(k)) throw new Refused(`module names ${JSON.stringify(lower.get(k))} and ${JSON.stringify(mod)} collide on a case-insensitive filesystem`);
    lower.set(k, mod);
  }
  return plan;
}

const posix = (p) => p.split(path.sep).join("/");
const dotted = (p) => (p.startsWith(".") ? p : `./${p}`);

/** Builds every output file in memory. Returns {files: [[absPath, text]], barrel: [absPath, text], pkgDir}. */
function build(tm, src, plan, pkgName, extend) {
  const { ts } = tm;
  const text = readFileSync(src, "utf8");
  const ext = path.extname(src).toLowerCase();
  const project = new tm.Project({
    useInMemoryFileSystem: true,
    compilerOptions: { noLib: true, noResolve: true, allowJs: false, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
  });
  const sf = project.createSourceFile(`/src/${path.basename(src)}`, text).compilerNode;
  if (sf.parseDiagnostics?.length) {
    const d = sf.parseDiagnostics[0];
    throw new Refused(`source does not parse: line ${sf.getLineAndCharacterOfPosition(d.start).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  const checker = project.getTypeChecker().compilerObject;
  const stmts = [...sf.statements];
  const K = ts.SyntaxKind;
  const mods = (n) => (ts.canHaveModifiers?.(n) ? ts.getModifiers(n) : n.modifiers) ?? [];
  const hasMod = (n, k) => mods(n).some((m) => m.kind === k);

  // ---- top-level declarations: statement -> names it binds, name -> statements ----
  const bound = new Map(), byName = new Map();
  const bindingNames = (b, out) => {
    if (ts.isIdentifier(b)) out.push(b.text);
    else for (const el of b.elements ?? []) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
    return out;
  };
  for (const st of stmts) {
    let names = null;
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names = [st.name.text];
    else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) names = [st.name.text];
    else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) names = [st.name.text];
    else if (ts.isVariableStatement(st)) names = st.declarationList.declarations.flatMap((d) => bindingNames(d.name, []));
    if (!names) continue;
    bound.set(st, names);
    for (const n of names) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(st); }
  }

  // ---- plan -> module per name and per statement ----
  const modOf = new Map();
  for (const [mod, names] of Object.entries(plan)) {
    for (const n of names) {
      if (modOf.has(n)) throw new Refused(`symbol ${JSON.stringify(n)} is listed twice (${modOf.get(n)}, ${mod})`);
      if (n.includes(".")) throw new Refused(`${JSON.stringify(n)} is not a top-level symbol; only top-level symbols move`);
      if (!byName.has(n)) throw new Refused(`unknown symbol ${JSON.stringify(n)}: not a top-level declaration in ${src}`);
      modOf.set(n, mod);
    }
  }
  const stmtMod = new Map();
  for (const [st, names] of bound) {
    const where = new Set(names.map((n) => modOf.get(n) ?? null));
    if (where.size > 1) {
      const other = names.find((n) => (modOf.get(n) ?? null) !== (modOf.get(names[0]) ?? null));
      throw new Refused(`statement at line ${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1} binds ${JSON.stringify(names[0])} and ${JSON.stringify(other)}, which the plan does not move together`);
    }
    const m = [...where][0];
    if (m !== null) stmtMod.set(st, m);
  }
  for (const [n, sts] of byName) {
    const where = new Set(sts.map((s) => stmtMod.get(s) ?? `${path.basename(src)} (kept)`));
    if (where.size > 1) throw new Refused(`name ${JSON.stringify(n)} is bound by statements going to different places (${[...where].join(", ")})`);
  }
  const moved = stmts.filter((s) => stmtMod.has(s));
  for (const st of moved) {
    if (hasMod(st, K.DefaultKeyword)) throw new Refused(`moved symbol ${bound.get(st)[0]} is an \`export default\`; re-exporting it would change the barrel's shape`);
  }
  const exported = (n) => byName.get(n).some((s) => hasMod(s, K.ExportKeyword) && !hasMod(s, K.DefaultKeyword));
  const typeOnly = (n) => byName.get(n).every((s) => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // ---- reference resolution ----
  const topOf = (n) => { while (n && n.parent && n.parent !== sf) n = n.parent; return n && n.parent === sf ? n : null; };
  const symOf = (id) => {
    const p = id.parent;
    if (p && ts.isShorthandPropertyAssignment(p) && p.name === id) return checker.getShorthandAssignmentValueSymbol(p);
    if (p && ts.isExportSpecifier(p)) {
      if (p.parent?.parent?.moduleSpecifier || id !== (p.propertyName ?? p.name)) return null;
      return checker.getExportSpecifierLocalTargetSymbol(p);
    }
    return checker.getSymbolAtLocation(id);
  };
  /** Every reference in `root` to a top-level name or an import binding: {name} | {imp: decl node, top}. */
  const refs = (root) => {
    const out = [];
    const visit = (n) => {
      if (ts.isIdentifier(n)) {
        const sym = symOf(n);
        for (const d of sym?.declarations ?? []) {
          const top = topOf(d);
          if (!top) continue;
          if (ts.isImportDeclaration(top) || ts.isImportEqualsDeclaration(top)) { out.push({ imp: d, top, node: n }); break; }
          const isDecl = d === top || (ts.isVariableDeclaration(d) && d.parent?.parent === top) || (ts.isBindingElement(d) && topOf(d) === top && ts.isVariableStatement(top));
          if (isDecl && bound.has(top) && bound.get(top).includes(sym.name)) { out.push({ name: sym.name, node: n }); break; }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
  };

  // ---- moved code: module identity, needs, sibling edges ----
  const isRelSpec = (a) => a && ts.isStringLiteralLike(a) && a.text.startsWith(".");
  const needImports = new Map(Object.keys(plan).map((m) => [m, new Map()])); // mod -> import top -> Set(decl)
  const sibling = new Map(Object.keys(plan).map((m) => [m, new Map()])); // mod -> other mod -> Set(name)
  for (const st of moved) {
    const mod = stmtMod.get(st), who = bound.get(st)[0];
    const identity = (n) => {
      if (ts.isMetaProperty(n) && n.keywordToken === K.ImportKeyword) throw new Refused(`moved symbol ${who} uses import.meta, which names the module`);
      if (ts.isIdentifier(n) && (n.text === "__dirname" || n.text === "__filename") && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) throw new Refused(`moved symbol ${who} uses module-identity global ${n.text}`);
      if (ts.isCallExpression(n) && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && isRelSpec(n.arguments[0])) {
        throw new Refused(`moved symbol ${who} loads ${JSON.stringify(n.arguments[0].text)} relative to the module at line ${line(n)}`);
      }
      ts.forEachChild(n, identity);
    };
    identity(st);
    for (const r of refs(st)) {
      if (r.imp) {
        const m = needImports.get(mod);
        if (!m.has(r.top)) m.set(r.top, new Set());
        m.get(r.top).add(r.imp);
        continue;
      }
      const other = modOf.get(r.name);
      if (other === mod) continue;
      if (other === undefined) throw new Refused(`moved symbol ${who} (-> ${mod}) needs ${JSON.stringify(r.name)}, which stays in ${src} (line ${line(r.node)})`);
      if (!exported(r.name)) throw new Refused(`moved symbol ${who} (-> ${mod}) uses ${JSON.stringify(r.name)} (-> ${other}), which is not exported; exporting it would change its declaration`);
      const s = sibling.get(mod);
      if (!s.has(other)) s.set(other, new Set());
      s.get(other).add(r.name);
    }
  }

  // ---- kept code referencing moved names: the barrel imports them ----
  const keptNeeds = new Map(); // mod -> Set(name)
  for (const st of stmts) {
    if (stmtMod.has(st) || ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) || (ts.isExportDeclaration(st) && st.moduleSpecifier)) continue;
    for (const r of refs(st)) {
      if (!r.name || !modOf.has(r.name)) continue;
      if (!exported(r.name)) throw new Refused(`${JSON.stringify(r.name)} (-> ${modOf.get(r.name)}) is not exported but kept code uses it at line ${line(r.node)}; exporting it would change its declaration`);
      const m = modOf.get(r.name);
      if (!keptNeeds.has(m)) keptNeeds.set(m, new Set());
      keptNeeds.get(m).add(r.name);
    }
  }

  // ---- no cycle between the new modules ----
  const state = new Map();
  const dfs = (m, trail) => {
    if (state.get(m) === 2) return;
    if (state.get(m) === 1) throw new Refused(`plan creates an import cycle: ${[...trail.slice(trail.indexOf(m)), m].join(" -> ")}`);
    state.set(m, 1);
    for (const o of [...sibling.get(m).keys()].sort()) dfs(o, [...trail, m]);
    state.set(m, 2);
  };
  for (const m of Object.keys(plan)) dfs(m, []);

  // ---- package location ----
  const srcDir = path.dirname(src);
  const pkgDir = path.join(srcDir, pkgName);
  if (!extend && existsSync(pkgDir)) throw new Refused(`package path already exists: ${pkgDir}`);
  const files = Object.keys(plan).map((m) => [m, path.join(pkgDir, m + ext)]);
  if (extend) {
    const taken = files.filter(([, f]) => existsSync(f)).map(([m]) => m);
    if (taken.length) throw new Refused(`module already exists in package ${pkgDir}: ${taken.join(", ")}`);
  }

  // ---- specifier style: mirror the source's relative imports ----
  const relSpecs = stmts.filter((s) => (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && isRelSpec(s.moduleSpecifier)).map((s) => s.moduleSpecifier.text);
  const first = relSpecs[0];
  const style = first === undefined ? "own" : /\.(c|m)?tsx?$/.test(first) ? "own" : /\.(c|m)?jsx?$/.test(first) ? "js" : "none";
  const suffix = style === "own" ? ext : style === "js" ? JS_OF[ext] : "";
  const quote = /^\s*import[^'"]*(['"])/m.exec(stmts.filter((s) => ts.isImportDeclaration(s)).map((s) => s.getText(sf)).join("\n"))?.[1] ?? "\"";
  const semi = stmts.some((s) => ts.isImportDeclaration(s)) ? stmts.filter((s) => ts.isImportDeclaration(s)).every((s) => s.getText(sf).trimEnd().endsWith(";")) : true;
  const end = semi ? ";" : "";
  const q = (s) => `${quote}${s}${quote}`;
  const rebase = (spec) => (spec.startsWith(".") ? dotted(posix(path.relative(pkgDir, path.join(srcDir, spec)))) : spec);
  const named = (names) => `{ ${names.map((n) => (typeOnly(n) ? `type ${n}` : n)).join(", ")} }`;
  const srcOrder = (names) => [...names].sort((a, b) => byName.get(a)[0].pos - byName.get(b)[0].pos);

  /** One source import declaration pruned to the used bindings, with its specifier re-based. */
  const importText = (top, used) => {
    if (ts.isImportEqualsDeclaration(top)) {
      const t = top.getText(sf), ref = top.moduleReference;
      if (ts.isExternalModuleReference(ref) && isRelSpec(ref.expression)) {
        const s = ref.expression;
        return t.slice(0, s.getStart(sf) - top.getStart(sf)) + q(rebase(s.text)) + t.slice(s.getEnd() - top.getStart(sf));
      }
      return t;
    }
    const c = top.importClause, parts = [];
    if (c.name && used.has(c)) parts.push(c.name.text);
    const nb = c.namedBindings;
    if (nb && ts.isNamespaceImport(nb) && used.has(nb)) parts.push(`* as ${nb.name.text}`);
    if (nb && ts.isNamedImports(nb)) {
      const els = nb.elements.filter((e) => used.has(e)).map((e) => e.getText(sf));
      if (els.length) parts.push(`{ ${els.join(", ")} }`);
    }
    const attrs = top.attributes ? ` ${top.attributes.getText(sf)}` : "";
    return `import ${c.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${q(rebase(top.moduleSpecifier.text))}${attrs}${end}`;
  };

  // ---- statement spans: leading comments move with the statement; the file header stays ----
  const span = (st) => {
    let from = st.getFullStart();
    if (st === stmts[0]) {
      const trivia = text.slice(from, st.getStart(sf)), cut = trivia.lastIndexOf("\n\n");
      if (cut >= 0) from += cut + 2;
    }
    return [from, st.getEnd()];
  };
  const body = (st) => text.slice(...span(st)).replace(/^(?:[ \t]*\r?\n)+/, "");

  const out = [];
  for (const [mod, file] of files) {
    const lines = [];
    for (const st of stmts) if (needImports.get(mod).has(st)) lines.push(importText(st, needImports.get(mod).get(st)));
    for (const [other, names] of [...sibling.get(mod)].sort((a, b) => Object.keys(plan).indexOf(a[0]) - Object.keys(plan).indexOf(b[0]))) {
      lines.push(`import ${named(srcOrder(names))} from ${q(`./${other}${suffix}`)}${end}`);
    }
    const blocks = moved.filter((s) => stmtMod.get(s) === mod).map(body);
    out.push([file, `${lines.length ? `${lines.join("\n")}\n\n` : ""}${blocks.join("\n\n")}\n`]);
  }

  // ---- the barrel: --src with the moved spans cut and import/re-export lines at the first one ----
  const barrel = [];
  for (const mod of Object.keys(plan)) {
    const spec = q(`./${pkgName}/${mod}${suffix}`);
    const kept = keptNeeds.get(mod);
    if (kept?.size) barrel.push(`import ${named(srcOrder(kept))} from ${spec}${end}`);
    const pub = srcOrder(plan[mod].filter(exported));
    if (pub.length) barrel.push(`export ${named(pub)} from ${spec}${end}`);
  }
  const spans = moved.map(span);
  let shim = "", at = 0;
  spans.forEach(([a, b], i) => {
    shim += text.slice(at, a);
    if (i === 0 && barrel.length) shim += `${a > 0 && text[a - 1] !== "\n" ? "\n" : ""}${barrel.join("\n")}${text[b] === "\n" || b >= text.length ? "" : "\n"}`;
    at = b;
  });
  shim += text.slice(at);
  return { files: out, barrel: [src, shim], pkgDir };
}

function write({ files, barrel, pkgDir }) {
  const createdDir = !existsSync(pkgDir);
  const temps = [];
  try {
    mkdirSync(pkgDir, { recursive: true });
    const all = [...files, barrel];
    for (const [f, t] of all) { const tmp = `${f}.symbol-move-${process.pid}.tmp`; writeFileSync(tmp, t); temps.push([tmp, f]); }
    for (const [tmp, f] of temps) renameSync(tmp, f); // barrel last
  } catch (e) {
    for (const [tmp] of temps) rmSync(tmp, { force: true });
    if (createdDir) rmSync(pkgDir, { recursive: true, force: true });
    throw e;
  }
}

function main(argv) {
  const o = parseArgs(argv);
  if (!o) return usage();
  if (o.src && !existsSync(o.src)) { process.stderr.write(`symbol-move: no such file: ${o.src}\n`); return 2; }
  const tm = loadTsMorph(o.src);
  if (!tm) return emit({ status: "refused", reason: `no codemod tool for ts: ts-morph is not resolvable from ${o.src ? path.dirname(o.src) : "."} or the cwd (install it in the target repo or put it on NODE_PATH)` }), 3;
  if (o.probe) return emit({ status: "ok", tool: "ts-morph" }), 0;
  if (!existsSync(o.plan)) { process.stderr.write(`symbol-move: no such file: ${o.plan}\n`); return 2; }
  try {
    const ext = path.extname(o.src).toLowerCase();
    if (!TS_EXT.includes(ext)) throw new Refused(`source is not a TypeScript file (${TS_EXT.join(", ")}): ${o.src}`);
    const stem = path.basename(o.src, path.extname(o.src));
    const pkg = o.package ?? `${stem}_parts`;
    if (!IDENT.test(pkg)) throw new Refused(`package name ${JSON.stringify(pkg)} is not a valid identifier`);
    const plan = loadPlan(o.plan);
    const built = build(tm, o.src, plan, pkg, o.extend);
    if (!o.dryRun) write(built);
    emit({ status: "ok", package: posix(path.join(path.dirname(o.src), pkg)), modules: plan, shim: o.src });
    return 0;
  } catch (e) {
    if (e instanceof Refused) return emit({ status: "refused", reason: e.message }), 3;
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));

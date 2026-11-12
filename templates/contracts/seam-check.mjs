// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5338: the seam contract checker. Self-contained on purpose (node builtins only): `forgedock interfaces contract`
 * copies this file next to the generated `<id>.contract.test.mjs` files, so a repo's provider and consumer CI both run
 * `node --test contracts/*.contract.test.mjs` with no ForgeDock install and nothing mocked: the check reads the REAL source on both sides
 * of the boundary and compares it with the contract the spike's `Interfaces` row declared.
 *
 * contract = { v:1, id, kind: "symbol"|"route"|"payload", boundary, auth, provider: [anchor], consumer: [anchor],
 *              symbol?: {name, params:[{name, optional, variadic}]}, route?: {method, path}, payload?: {fields:[name]} }
 * Anchors are repo paths, `dir/` prefixes or globs. checkSeam is pure over { read(path), list() }.
 * Returns { findings: [{side, file, line, detail}] } or { unchecked: reason } when a side has no files to read.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const clean = (a) => String(a).replace(/^\.\//, "").replace(/^\/+/, "");
const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
/** Same rule as bin/lean/decisions.mjs anchorMatches (a parity test pins them together). */
export function anchorMatches(anchor, path) {
  const a = clean(anchor), p = clean(path);
  if (!a || !p) return false;
  if (a.endsWith("/")) return p.startsWith(a);
  return a === p || globRe(a).test(p) || p.startsWith(`${a}/`);
}

const SOURCE = /\.(py|mjs|cjs|js|jsx|ts|tsx|mts|cts|go|rb|java|kt|rs|php|cs)$/i;
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const isId = (c) => /[A-Za-z0-9_$]/.test(c ?? "");

/** Index of the `)` closing the `(` at `open`, skipping strings; -1 when unbalanced. */
function closeParen(text, open) {
  let depth = 0, q = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Top-level comma split of an argument/parameter list. */
function splitTop(s) {
  const out = []; let depth = 0, q = null, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if ("([{<".includes(c) && !(c === "<" && !/[A-Za-z]$/.test(cur.trim()))) depth++;
    else if (")]}>".includes(c) && !(c === ">" && s[i - 1] === "=")) depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The parameters a definition declares: [{name, optional, variadic}] (self/cls dropped; a destructured object is one param). */
function declaredParams(text) {
  const out = [];
  for (const raw of splitTop(text)) {
    if (raw === "*" || raw === "/") continue;
    const variadic = /^(\*\*?|\.\.\.)/.test(raw);
    const body = raw.replace(/^(\*\*?|\.\.\.)/, "");
    if (body.startsWith("{") || body.startsWith("[")) { out.push({ name: "{}", optional: /=/.test(raw), variadic }); continue; }
    const m = /^([A-Za-z_$][\w$]*)(\?)?/.exec(body);
    if (!m || m[1] === "self" || m[1] === "cls") continue;
    out.push({ name: m[1], optional: Boolean(m[2]) || /(^|[^=!<>])=(?!=)/.test(body) || variadic, variadic });
  }
  return out;
}

/** Definitions of `name` in a source text: [{line, params}]. */
function definitions(text, name) {
  const out = [], re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}\\s*\\(`, "g");
  for (let m; (m = re.exec(text));) {
    const open = m.index + m[0].length - 1, close = closeParen(text, open);
    if (close < 0) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index), after = text.slice(close + 1, close + 80);
    const def = /(\bdef|\bfunction\s*\*?|\bfunc|\bfn)\s+$/.test(before)
      || (/(^|\n)[ \t]*(?:(?:public|private|protected|static|async|export|get|set)\s+)*$/.test(before) && /^\s*(?::[^{;=]*)?\{/.test(after));
    if (def) out.push({ line: lineOf(text, m.index), params: declaredParams(text.slice(open + 1, close)) });
  }
  const bound = new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$")}\\s*[:=]\\s*(?:async\\s*)?(?:function\\s*\\*?\\s*[\\w$]*\\s*)?\\(`, "g");
  for (let m; (m = bound.exec(text));) {
    const open = m.index + m[0].length - 1, close = closeParen(text, open);
    if (close < 0 || !/^\s*(?::[^=]*)?(=>|\{)/.test(text.slice(close + 1, close + 60))) continue;
    out.push({ line: lineOf(text, m.index), params: declaredParams(text.slice(open + 1, close)) });
  }
  return out;
}

/** Call sites of `name` in a source text: [{line, positional, keywords, dynamic}]; definitions and imports are skipped. */
function calls(text, name) {
  const out = [], re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}\\s*\\(`, "g");
  for (let m; (m = re.exec(text));) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (/(\bdef|\bfunction\s*\*?|\bfunc|\bfn|\bnew|\bimport|\bfrom)\s+$/.test(before) || /(^|\n)[ \t]*(?:(?:public|private|protected|static|async|get|set)\s+)*$/.test(before) && /^\s*(?::[^{;=]*)?\{/.test(text.slice(closeParen(text, m.index + m[0].length - 1) + 1).slice(0, 80))) continue;
    const open = m.index + m[0].length - 1, close = closeParen(text, open);
    if (close < 0) continue;
    const args = splitTop(text.slice(open + 1, close));
    let positional = 0, dynamic = false;
    const keywords = [];
    for (const a of args) {
      if (/^(\*\*?|\.\.\.)/.test(a)) { dynamic = true; continue; }
      const kw = /^([A-Za-z_][\w]*)\s*=(?!=)/.exec(a);
      if (kw) keywords.push(kw[1]); else positional++;
    }
    out.push({ line: lineOf(text, m.index), positional, keywords, dynamic });
  }
  return out;
}

const names = (ps) => ps.map((p) => p.name).join(", ");

function checkSymbol(c, provider, consumer) {
  const findings = [], want = c.symbol.params ?? [], wantNames = want.filter((p) => !p.variadic).map((p) => p.name);
  let found = false;
  for (const f of provider) {
    for (const d of definitions(f.text, c.symbol.name)) {
      found = true;
      const have = d.params.filter((p) => !p.variadic);
      const prefixOk = wantNames.every((n, i) => have[i]?.name === n);
      const extraRequired = have.slice(wantNames.length).filter((p) => !p.optional);
      if (!prefixOk || extraRequired.length) {
        findings.push({ side: "provider", file: f.path, line: d.line, detail: `${c.symbol.name}(${names(d.params)}) does not match the declared ${c.symbol.name}(${names(want)}): a caller using the contract signature raises TypeError` });
      }
    }
  }
  if (!found) findings.push({ side: "provider", file: null, line: null, detail: `no definition of ${c.symbol.name}(...) under the provider anchors` });
  for (const f of consumer) {
    for (const k of calls(f.text, c.symbol.name)) {
      if (k.dynamic) continue;
      const slots = wantNames, byPos = slots.slice(0, k.positional), covered = new Set([...byPos, ...k.keywords]);
      const missing = want.filter((p) => !p.optional && !p.variadic && !covered.has(p.name)).map((p) => p.name);
      const unknown = k.keywords.filter((n) => !slots.includes(n) && !want.some((p) => p.variadic));
      const tooMany = k.positional > slots.length && !want.some((p) => p.variadic);
      if (missing.length || unknown.length || tooMany) {
        findings.push({ side: "consumer", file: f.path, line: k.line, detail: `call ${c.symbol.name}(${k.positional} positional${k.keywords.length ? `, ${k.keywords.join("=, ")}=` : ""}) does not fit the declared ${c.symbol.name}(${names(want)})${missing.length ? `: missing ${missing.join(", ")}` : ""}${unknown.length ? `: unknown ${unknown.join(", ")}` : ""}${tooMany ? ": too many arguments" : ""}` });
      }
    }
  }
  return findings;
}

const WILD = "[^/\"'`\\s?#]+";
const pathPattern = (p) => p.split("/").map((seg) => (/^(\{[^}]+\}|:[\w-]+|\[[^\]]+\])$/.test(seg) ? WILD : seg.replace(/[.+^${}()|[\]\\*?]/g, "\\$&"))).join("/");

/** auth mode of an Interfaces row: api-key (an API key and no session/cookie/JWT), session, or other. */
export function authMode(auth) {
  const t = String(auth ?? "").replace(/\b(?:no|not|never|without|except|instead of)\b[^,;.|]*/gi, " ");
  const key = /api[\s_-]?key/i.test(t), session = /session|cookie|jwt|oauth/i.test(t);
  return key && !session ? "api-key" : session ? "session" : "other";
}

const SESSION_LEAKS = [
  [/credentials\s*:\s*["']include["']/, "sends credentials: include (the browser session cookie)"],
  [/(headers\s*(?:\.get\s*\(|\[)\s*|["'`])cookie["'`]?\s*[:\])]/i, "forwards a Cookie header"],
  [/\b(?:req|request|ctx)\.(?:headers\.cookie|cookies)\b|\bcookies\s*\(\s*\)/, "reads the request cookies"],
  [/\bget(?:Server)?Session\s*\(|\bsession\.(?:access_?[tT]oken|token|jwt)\b|\bsession\[["'](?:access_?token|token|jwt)["']\]/, "reads the user session token"],
  [/Bearer\s*\$\{[^}]*(?:session|jwt|access_?token|id_?token)[^}]*\}/i, "sends the session JWT as the Bearer credential"],
];
const KEY_SEND = /x-api-key|api[_-]?key|API_KEY/i;

function checkRoute(c, provider, consumer) {
  const findings = [], { method, path } = c.route, pat = new RegExp(pathPattern(path)), verb = method.toLowerCase();
  const segs = path.split("/").filter(Boolean);
  const handled = provider.some((f) => {
    for (const m of f.text.matchAll(new RegExp(`["'\`]${pathPattern(path)}/?["'\`]`, "g"))) {
      const around = f.text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 120);
      if (new RegExp(`\\b${verb}\\b|["']${method}["']`, "i").test(around)) return true;
    }
    const dir = f.path.replace(/\/route\.[mc]?[jt]sx?$/, "");
    return dir !== f.path && segs.every((s) => /^(\{[^}]+\}|:[\w-]+|\[[^\]]+\])$/.test(s) || dir.split("/").includes(s.replace(/^\[|\]$/g, ""))) && new RegExp(`export\\s+(?:async\\s+function|const)\\s+${method}\\b`).test(f.text);
  });
  if (!handled) findings.push({ side: "provider", file: null, line: null, detail: `no handler for ${method} ${path} under the provider anchors` });
  if (authMode(c.auth) === "api-key") {
    for (const f of consumer) {
      if (!pat.test(f.text)) continue;
      for (const [re, why] of SESSION_LEAKS) {
        const m = re.exec(f.text);
        if (m) findings.push({ side: "consumer", file: f.path, line: lineOf(f.text, m.index), detail: `${method} ${path} is ${c.auth || "API-key only"} but this caller ${why}` });
      }
      if (!KEY_SEND.test(f.text)) findings.push({ side: "consumer", file: f.path, line: lineOf(f.text, f.text.search(pat)), detail: `${method} ${path} needs an API key but this caller never sends one` });
    }
  }
  return findings;
}

function checkPayload(c, provider, consumer) {
  const findings = [];
  for (const [side, files] of [["provider", provider], ["consumer", consumer]]) {
    const text = files.map((f) => f.text).join("\n");
    for (const field of c.payload.fields) {
      if (!new RegExp(`(?<![\\w$])${field.replace(/[$]/g, "\\$")}(?![\\w$])`).test(text)) findings.push({ side, file: null, line: null, detail: `payload field "${field}" never appears under the ${side} anchors: it is accepted on one side and dropped on the other` });
    }
  }
  return findings;
}

/** Pure check of one contract against the repo files. */
export function checkSeam(contract, { read, list }) {
  const all = list().map(clean).filter((p) => SOURCE.test(p));
  const side = (anchors) => all.filter((p) => (anchors ?? []).some((a) => anchorMatches(a, p))).map((p) => ({ path: p, text: String(read(p) ?? "") }));
  const provider = side(contract.provider), consumer = side(contract.consumer);
  if (!provider.length || !consumer.length) return { findings: [], unchecked: `${contract.id}: no source files under the ${provider.length ? "consumer" : "provider"} anchors (declare both sides as \`provider:<path>\` and \`consumer:<path>\` in the Anchors cell)` };
  const run = { symbol: checkSymbol, route: checkRoute, payload: checkPayload }[contract.kind];
  if (!run || !contract[contract.kind]) return { findings: [], unchecked: `${contract.id}: unknown contract kind ${contract.kind}` };
  return { findings: run(contract, provider, consumer) };
}

/** Repo files: git's tracked and untracked-not-ignored list, else a directory walk. */
export function repoFiles(root) {
  try { return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean); } catch { /* not a git checkout */ }
  const out = [], walk = (dir, rel) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), p); else out.push(p);
    }
  };
  walk(".", "");
  return out;
}

/** checkSeam over the real files under `root` (what the generated tests call). */
export function checkSeamAt(contract, root) {
  return checkSeam(contract, { list: () => repoFiles(root), read: (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } } });
}

export const formatFindings = (findings) => findings.map((f) => `${f.side}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.detail}`).join("\n");

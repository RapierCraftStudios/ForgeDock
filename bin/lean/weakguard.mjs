// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5752: weak vs strong fix guards. A guard test that only asserts "this literal exists" in a file's text is weak: breaking it is
 * a review note, not a park. A behavioural test (inputs -> outputs) stays strong. Deterministic source analysis of the base test
 * body (0 LLM calls); anything the classifier cannot prove weak is strong, so a misread never weakens a behavioural guard.
 * Weak only when the file reads file text, imports no local non-test module, runs no process, has at least one assertion and
 * every assertion is a literal-presence form.
 */

const PY_RE = /\.py$/i;
const TESTISH_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|__tests__|fixtures?)\/|(?:^|\/)_[\w-]*\.[cm]?[jt]s$)/;
const JS_READ_RE = /\breadFileSync\s*\(|\breadFile\s*\(|\bBun\.file\s*\(/;
const JS_PROC_RE = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(|\bfetch\s*\(/;
const PY_READ_RE = /\.read_text\s*\(|\bopen\s*\([^)]*\)[\s\S]{0,80}?\.read(?:lines)?\s*\(/;
const PY_PROC_RE = /\bsubprocess\b|\bos\.system\s*\(|\bos\.popen\s*\(|\brequests\.|\burllib\b/;
const PY_SAFE_MODS = new Set(["os", "re", "pathlib", "sys", "json", "pytest", "unittest", "io", "typing", "textwrap", "glob", "__future__"]);

/** Strip comments (keeping strings), so a commented-out assertion or import counts for nothing. */
function stripJsComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "\"" || c === "'" || c === "`") { const s = i; i++; while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1; out += src.slice(s, i + 1); i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Index just past the `)` matching the `(` at `open`, skipping strings; -1 when unbalanced. */
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\"" || c === "'" || c === "`") { i++; while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

// A regex literal body is escapes or non-`/`, non-`\` chars: `\` must not match both branches (CodeQL js/redos, exponential backtracking).
const PRESENCE_ARG_RE = /^\s*!?\s*(?:[\w$.[\]"'`]+(?:\([^()]*\))?)\.includes\s*\(|^\s*!?\s*\/(?:\\.|[^/\\\n])+\/[a-z]*\.test\s*\(/;

/** JS/TS: every assertion's literal-presence verdict, or null when the file has none. */
function jsAssertions(src) {
  const verdicts = [];
  for (const m of src.matchAll(/\bassert(?:\.(\w+))?\s*\(/g)) {
    const open = m.index + m[0].length - 1, end = closeParen(src, open);
    const method = m[1] ?? "ok";
    if (method === "match" || method === "doesNotMatch") verdicts.push(true);
    else if (method === "ok") verdicts.push(end > 0 && PRESENCE_ARG_RE.test(src.slice(open + 1, end - 1)));
    else verdicts.push(false);
  }
  for (const m of src.matchAll(/\bexpect\s*\(/g)) {
    const open = m.index + m[0].length - 1, end = closeParen(src, open);
    const tail = end > 0 ? src.slice(end, end + 40) : "";
    verdicts.push(/^\s*(?:\.not)?\s*\.(?:toContain|toMatch)\s*\(/.test(tail));
  }
  return verdicts.length ? verdicts : null;
}

/** JS/TS: true when some import/require names a local module that is not a test helper or fixture. */
function jsImportsLocal(src) {
  const specs = [...src.matchAll(/\bimport\s+(?:[^"'`;]*?\s+from\s+)?["'`]([^"'`]+)["'`]|\bimport\s*\(\s*["'`]([^"'`]+)["'`]|\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return specs.some((s) => (s.startsWith(".") || s.startsWith("/")) && !TESTISH_RE.test(s));
}

/** Python: every assertion's literal-presence verdict, or null when the file has none. */
function pyAssertions(src) {
  const verdicts = [];
  for (const m of src.matchAll(/^[ \t]*assert\s+(.+)$/gm)) {
    const e = m[1].split(/,\s*["'f]/)[0];
    verdicts.push(/^\s*(?:[rbuf]?["'][^"']*["'])\s+(?:not\s+)?in\s+[\w.()[\]"']+\s*$/.test(e) || /^\s*(?:not\s+)?re\.(?:search|match|fullmatch)\s*\(/.test(e));
  }
  for (const m of src.matchAll(/\bself\.assert(\w+)\s*\(/g)) verdicts.push(["In", "NotIn", "Regex", "NotRegex"].includes(m[1]));
  return verdicts.length ? verdicts : null;
}

/** Python: true when some import is not a known stdlib/test module (a relative import or the project's package). */
function pyImportsLocal(src) {
  for (const m of src.matchAll(/^[ \t]*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w., ]+))/gm)) {
    if (m[1] !== undefined) { if (m[1].startsWith(".") || !PY_SAFE_MODS.has(m[1].split(".")[0])) return true; continue; }
    if (m[2].split(",").some((x) => !PY_SAFE_MODS.has(x.trim().split(/[.\s]/)[0]))) return true;
  }
  return false;
}

/** True when the test source only asserts that literals exist in file text (a weak guard); false for anything else. */
export function isWeakGuardTest(source, path = "") {
  const raw = String(source ?? "");
  if (!raw.trim()) return false;
  if (PY_RE.test(String(path))) {
    const src = raw.replace(/^[ \t]*#.*$/gm, "");
    if (!PY_READ_RE.test(src) || PY_PROC_RE.test(src) || pyImportsLocal(src)) return false;
    const v = pyAssertions(src);
    return Boolean(v) && v.every(Boolean);
  }
  const src = stripJsComments(raw);
  if (!JS_READ_RE.test(src) || JS_PROC_RE.test(src) || jsImportsLocal(src)) return false;
  const v = jsAssertions(src);
  return Boolean(v) && v.every(Boolean);
}

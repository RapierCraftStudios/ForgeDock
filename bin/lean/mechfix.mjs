// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mechanical fixes (#5348): the enumerating-test and duplicate-export gates already name the exact change, so the engine
 * applies it itself and re-runs the detector; a model session starts only for what is left. No model, never throws.
 * Both functions return {applied, remaining} over the findings they were given; `remaining` keeps the unproven ones.
 */
import fs from "node:fs";
import { join, posix } from "node:path";

const STR = /(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g;
const ALL_STRINGS = /^\s*(?:(["'`])(?:(?!\1)[^\\\n]|\\.)*\1\s*(?:,\s*|$))+$/;

/** Spans of every `[...]` in `text` (string literals skipped): [{start, end}] with `end` the index of the `]`. */
function arraySpans(text) {
  const spans = [], stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { // skip a string literal
      for (i++; i < text.length && text[i] !== c && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
    } else if (c === "[") stack.push(i);
    else if (c === "]" && stack.length) spans.push({ start: stack.pop(), end: i });
  }
  return spans;
}

const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

/**
 * Add `symbols` to the array literal of string literals that covers 1-based `line` of `text`. Only an unambiguous list
 * (2+ elements, strings only) is edited; the new entry copies the neighbours' quote and layout.
 * @returns {{text: string, inserted: string[]}} `inserted` is empty when the list was not recognised.
 */
export function insertIntoList(text, line, symbols) {
  const span = arraySpans(text)
    .filter((s) => lineOf(text, s.start) <= line && line <= lineOf(text, s.end))
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))
    .find((s) => ALL_STRINGS.test(text.slice(s.start + 1, s.end)) && [...text.slice(s.start + 1, s.end).matchAll(STR)].length >= 2);
  if (!span) return { text, inserted: [] };
  const body = text.slice(span.start + 1, span.end);
  const items = [...body.matchAll(STR)];
  const have = new Set(items.map((m) => m[0].slice(1, -1)));
  const quote = items[0][0][0];
  const fresh = [...new Set(symbols)].filter((s) => !have.has(s) && !/[\\"'`\n]/.test(s));
  if (!fresh.length) return { text, inserted: [] };
  const lit = (s) => `${quote}${s}${quote}`;
  const last = items[items.length - 1], lastEnd = span.start + 1 + last.index + last[0].length;
  const trailing = /^\s*,/.exec(text.slice(lastEnd)); // a comma after the last element
  const at = trailing ? lastEnd + trailing[0].length : lastEnd;
  let add;
  if (body.includes("\n")) {
    const ls = text.lastIndexOf("\n", lastEnd) + 1, indent = /^\s*/.exec(text.slice(ls, lastEnd))[0];
    add = trailing ? fresh.map((s) => `\n${indent}${lit(s)},`).join("") : fresh.map((s) => `,\n${indent}${lit(s)}`).join("");
  } else add = trailing ? fresh.map((s) => ` ${lit(s)},`).join("") : fresh.map((s) => `, ${lit(s)}`).join("");
  return { text: text.slice(0, at) + add + text.slice(at), inserted: fresh };
}

/**
 * Enumerating tests: write every missing symbol into the list its test keeps. @param missing [{symbol, module, test, line}]
 * @returns {{applied: object[], remaining: object[]}}
 */
export function applyEnumerating({ missing = [], cwd, fsx = fs } = {}) {
  const applied = [], remaining = [];
  const byTest = new Map();
  for (const m of missing) { if (!byTest.has(m.test)) byTest.set(m.test, []); byTest.get(m.test).push(m); }
  for (const [test, rows] of byTest) {
    let text;
    try { text = fsx.readFileSync(join(cwd, test), "utf8"); } catch { remaining.push(...rows); continue; }
    const groups = new Map();
    for (const m of rows) { const k = `${m.line}\0${m.module}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    let changed = false;
    const mine = []; // this test's applied rows: a failed write moves only these, never another test's
    // bottom-up: an insertion only shifts the lines below it, so the detector's line numbers stay valid
    for (const g of [...groups.values()].sort((a, b) => b[0].line - a[0].line)) {
      const r = insertIntoList(text, g[0].line, g.map((m) => m.symbol));
      const done = new Set(r.inserted);
      for (const m of g) (done.has(m.symbol) ? mine : remaining).push(m);
      if (r.inserted.length) { text = r.text; changed = true; }
    }
    if (changed) { try { fsx.writeFileSync(join(cwd, test), text); } catch { remaining.push(...mine); continue; } }
    applied.push(...mine);
  }
  return { applied, remaining };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pascal = (s) => String(s).split(/[^A-Za-z0-9]+/).filter(Boolean).map(cap).join("");

/** `<AppPrefix><Symbol>`: the prefix is the declaring file's directory (its stem for an index file), cased like the symbol. */
export function renamedExport(symbol, path) {
  const stem = posix.basename(path).replace(/\.[^.]+$/, "");
  const dir = posix.basename(posix.dirname(path));
  const prefix = pascal(stem === "index" || stem === "mod" ? dir : stem) || pascal(dir);
  if (!prefix) return null;
  const lower = /^[a-z]/.test(symbol);
  return lower ? `${prefix.charAt(0).toLowerCase()}${prefix.slice(1)}${cap(symbol)}` : `${prefix}${cap(symbol)}`;
}

const word = (s) => new RegExp(`(?<![\\w$])${s.replace(/[\\$]/g, "\\$&")}(?![\\w$])`, "g");

/** True when `text` binds `name` from another module (ES import / `export {..} from`, python from-import): such a file references the lane's export, it does not merely declare its own. */
function importsName(text, name) {
  const clauses = [...text.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?([^;"'`]*?)\s*from\s*["'][^"']*["']/gm), ...text.matchAll(/^\s*from\s+\S+\s+import\s+(.*)$/gm)];
  return clauses.some((m) => word(name).test(m[1]));
}

/**
 * Duplicate exports: rename the lane's new export to `<AppPrefix><Symbol>` when the name occurs only in its declaring file and the
 * other files that declare it themselves (`others`; so no importer, registry or test keyed by the name can be left behind) and never as a property, string or label.
 * @param dups [{symbol, path, others}]; `git(args)` returns stdout
 * @returns {Promise<{applied: object[], remaining: object[]}>}
 */
export async function renameDuplicates({ dups = [], cwd, git, fsx = fs } = {}) {
  const applied = [], remaining = [];
  const grep = async (name) => { try { return String(await git(["-c", "core.quotepath=off", "grep", "-l", "-w", "-e", name])).split("\n").map((l) => l.trim()).filter(Boolean); } catch { return []; } };
  for (const d of dups) {
    try {
      const next = renamedExport(d.symbol, d.path);
      if (!next || next === d.symbol || (await grep(next)).length) { remaining.push(d); continue; }
      const files = await grep(d.symbol);
      const others = d.others ?? [];
      const reads = (f) => { try { return fsx.readFileSync(join(cwd, f), "utf8"); } catch { return null; } };
      // the detector's others declare the name themselves, so they cannot import ours; a barrel (import then export) is listed as a declarer but does import it
      if (others.some((f) => { const t = reads(f); return t === null || importsName(t, d.symbol); })) { remaining.push(d); continue; }
      const ours = new Set([d.path, ...others]);
      if (!files.includes(d.path) || files.some((f) => !ours.has(f))) { remaining.push(d); continue; }
      const text = fsx.readFileSync(join(cwd, d.path), "utf8");
      const re = word(d.symbol);
      const bad = [...text.matchAll(re)].some((m) => /[.'"`]$/.test(text.slice(Math.max(0, m.index - 1), m.index)) || /^\s*[:'"`]/.test(text.slice(m.index + d.symbol.length, m.index + d.symbol.length + 2)));
      if (bad) { remaining.push(d); continue; }
      fsx.writeFileSync(join(cwd, d.path), text.replace(re, next));
      applied.push({ ...d, renamedTo: next });
    } catch { remaining.push(d); }
  }
  return { applied, remaining };
}

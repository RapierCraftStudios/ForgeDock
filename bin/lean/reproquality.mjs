// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Repro quality (#5446): a repro_test that is red on base and green on head can still prove nothing about the bug. Two cheap,
 * deterministic checks (0 LLM calls): a patch-echo heuristic (assertions only compare literals the same diff introduced) and
 * a targeted mutation of the fix's added lines (the repro must fail on at least one). Result: behavioural | patch_echo |
 * mutation_survivor | none.
 */
import { isTestPath } from "./conformance.mjs";

export const REPRO_QUALITY = ["behavioural", "patch_echo", "mutation_survivor", "none"];
const SRC_EXT = /\.(?:m?[jt]sx?|cjs|py|go)$/i;
const ASSERT_RE = /\b(?:assert\w*|expect|should|self\.assert\w*|t\.(?:Error|Fatal)f?)\b/;
const LIT_RE = /"(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|`(?:[^`\\]|\\.)+`|\b\d+(?:\.\d+)?\b/g;

/** Added lines per file of a unified diff: [{file, line (new-file number), text}]. */
export function addedLines(diff) {
  const out = [];
  let file = null, n = 0;
  for (const l of String(diff ?? "").split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); if (file === "/dev/null") file = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { n = Number(h[1]); continue; }
    if (!file || l.startsWith("---")) continue;
    if (l.startsWith("+")) { out.push({ file, line: n, text: l.slice(1) }); n++; }
    else if (!l.startsWith("-") && !l.startsWith("\\")) n++;
  }
  return out;
}

const literals = (s) => (String(s).match(LIT_RE) ?? []).filter((x) => x.length > 2 || /^\d/.test(x));

/**
 * True when the added test assertions only compare against literals that the non-test diff introduced and no assertion
 * calls anything or reads an output (no call on the asserted subject beyond property access).
 */
export function patchEcho({ testDiff = "", srcDiff = "" } = {}) {
  const asserts = addedLines(testDiff).filter((a) => isTestPath(a.file) && ASSERT_RE.test(a.text));
  if (!asserts.length) return false;
  const srcLits = new Set(addedLines(srcDiff).filter((a) => !isTestPath(a.file)).flatMap((a) => literals(a.text)));
  if (!srcLits.size) return false;
  return asserts.every((a) => {
    const lits = literals(a.text);
    if (!lits.length || !lits.every((x) => srcLits.has(x))) return false;
    const body = a.text.replace(LIT_RE, "").replace(/\b(?:self\.)?(?:assert\w*|expect|should)(?:\.\w+)*\s*\(/, "(");
    return !/\w\s*\(/.test(body); // a call left on the asserted subject is behaviour (output of a function)
  });
}

/** Up to `max` mutations of added non-test lines: negate a condition, return early, drop a call statement. */
export function mutationsOf(srcDiff, max = 3) {
  const cands = addedLines(srcDiff).filter((a) => !isTestPath(a.file) && SRC_EXT.test(a.file) && a.text.trim() && !/^\s*(?:\/\/|#|\*|\/\*)/.test(a.text));
  const out = [];
  const py = (f) => /\.py$/i.test(f);
  for (const a of cands) {
    if (out.length >= max) break;
    const ind = /^\s*/.exec(a.text)[0];
    let m = /^(\s*(?:\}\s*else\s+)?(?:if|while))\s*\((.*)\)\s*(\{?)\s*$/.exec(a.text);
    if (m) { out.push({ ...a, kind: "flip", to: `${m[1]} (!(${m[2]})) ${m[3]}`.trimEnd() }); continue; }
    m = /^(\s*(?:elif|if|while))\s+(.*):\s*$/.exec(a.text);
    if (m && py(a.file)) { out.push({ ...a, kind: "flip", to: `${m[1]} not (${m[2]}):` }); continue; }
    if (/^\s*(?:[\w.$]+\s*\(.*\)|await\s+[\w.$]+\s*\(.*\))\s*;?\s*$/.test(a.text)) { out.push({ ...a, kind: "drop", to: py(a.file) ? `${ind}pass` : `${ind}/* dropped */;` }); continue; }
  }
  for (const a of cands) { // early return as the last resort, on a statement line
    if (out.length >= max) break;
    if (out.some((o) => o.file === a.file && o.line === a.line)) continue;
    if (/^\s*(?:return\b.*|[\w.$]+\s*=.*)$/.test(a.text) && !/[{(,]\s*$/.test(a.text)) {
      const ind = /^\s*/.exec(a.text)[0];
      out.push({ ...a, kind: "return", to: py(a.file) ? `${ind}return None` : `${ind}return;` });
    }
  }
  return out.slice(0, max);
}

/**
 * Run the repro once per mutation on a clean tree; restore with reset --hard + clean in a finally (fail closed when the tree
 * is still dirty). Each result: {kind, file, line, status: killed|survived|skipped}.
 */
export async function runReproMutations({ mutations = [], command, git, runCommand, cwd, env, readFile, writeFile, capMs = 120000, now = Date.now } = {}) {
  const results = [], t0 = now();
  if (!mutations.length) return { results, skipped: "no mutable line" };
  if (String(await git(["status", "--porcelain"]).catch(() => "x")).trim()) return { results, skipped: "working tree not clean" };
  const files = [...new Set(mutations.map((m) => m.file))];
  try {
    for (const m of mutations) {
      const left = capMs - (now() - t0);
      if (left <= 0) { results.push({ ...m, status: "skipped" }); continue; }
      try {
        const lines = String(await readFile(`${cwd}/${m.file}`)).split("\n");
        if (lines[m.line - 1] !== m.text) { results.push({ ...m, status: "skipped" }); continue; }
        lines[m.line - 1] = m.to;
        await writeFile(`${cwd}/${m.file}`, lines.join("\n"));
        let r;
        try { r = await runCommand({ command, cwd, timeoutMs: left, env }); } catch { r = { rc: 127 }; }
        r = r?.r ?? r;
        const rc = Number.isInteger(r?.rc) ? r.rc : 1;
        results.push({ ...m, status: rc === 124 || rc === 127 ? "skipped" : rc === 0 ? "survived" : "killed" });
      } finally {
        await git(["checkout", "-q", "HEAD", "--", m.file]).catch(() => {});
      }
    }
  } finally {
    const dirty = String(await git(["status", "--porcelain", "--", ...files]).catch(() => "unreadable")).trim();
    if (dirty) throw new Error(`repro mutation left the tree dirty: ${dirty.slice(0, 200)}`);
  }
  return { results, skipped: "" };
}

/** repro_quality for a frozen repro_test: none (no repro), patch_echo, mutation_survivor (every run mutation survived), else behavioural. */
export function classifyRepro({ repro_test, echo = false, mutations = [] } = {}) {
  if (!repro_test || typeof repro_test !== "object") return "none";
  if (echo) return "patch_echo";
  const ran = mutations.filter((m) => m.status !== "skipped");
  if (ran.length && ran.every((m) => m.status === "survived")) return "mutation_survivor";
  return "behavioural";
}

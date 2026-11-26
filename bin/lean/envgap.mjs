// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: BUSL-1.1
// #6106: deterministic classification of environment gaps. A missing tool, binary, interpreter, recipe, package or sandbox
// capability is an `env.*` outcome that recovers on its own, never ci.red or a human block. Genuine human reasons stay human.
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

/** A check command's output that says the tool (not the change) is what failed. */
export const CHECK_TOOL_GAP_RE = /PATH pass-through wrapper with no real binary|command not found|(?:^|\n)\s*(?:\S+:\s*)?(?:sh|bash|zsh): (?:\d+: )?\S+: not found|not found in PATH|: No such file or directory[^\n]*node_modules\/\.bin|\bENOENT\b[^\n]{0,60}spawn|no module named|ModuleNotFoundError|cannot connect to the docker daemon|no docker daemon/i;

/** Words that make a block a real human decision, whatever else it says. */
const HUMAN_SIGNAL_RE = /\bapprov|sign[- ]?off|\bspend\b|\bbudget\b|purchase|\bpayment|\bcustomer|\blegal\b|\bsecrets?\b|password|passphrase|api[- ]?key|\btoken\b|\bcredentials?\b|\bpricing\b|owner (?:decision|call)|which (?:option|approach|product)/i;

const SANDBOX_CAP_RE = /\bsandbox\b[^.\n]{0,80}\b(?:lacks?|missing|has no|without|cannot|can't|does not have|doesn't have|no access)\b|\b(?:lacks?|missing|no|without)\b[^.\n]{0,40}\bsandbox (?:capabilit|access|network|docker|gpu)/i;
const TOOL_GAP_BLOCK_RE = [
  /\b(?:no|missing|lacks?|without|not (?:installed|available|found)|only)\b[^.\n]{0,60}\b(?:interpreter|python\s?3\.\d+|python\s?\d|node(?:\.js)?\s?\d+|binary|binaries|toolchain|runtime|docker|compiler|executable)\b/i,
  /\b(?:interpreter|binary|executable|toolchain)\b[^.\n]{0,60}\b(?:not (?:installed|available|found)|missing|absent|only)\b/i,
  /\blane[-_ ]?tools?\b|\brecipes?\b/i,
  /\b(?:package|module|library|dependency|dependencies)\b[^.\n]{0,60}\b(?:not installed|missing|not found|cannot be installed|unavailable)\b/i,
  /\b(?:not installed|command not found|no module named|ModuleNotFoundError)\b/i,
];

/**
 * The env code for a builder block whose declared reason is a human one, or null to keep it human.
 * @param {string} why     the block's typed reason ("product-decision", "credentials", ...)
 * @param {string} text    the builder's summary/reason
 * @returns {string|null}  OUTCOME_CODES.ENV_TOOL_MISSING | ENV_CAPABILITY_REMOTE | null
 */
export function envGapBlockCode(why, text) {
  if (!["product-decision", "credentials"].includes(String(why))) return null;
  const s = String(text ?? "");
  if (!s || HUMAN_SIGNAL_RE.test(s)) return null;
  if (SANDBOX_CAP_RE.test(s)) return OUTCOME_CODES.ENV_CAPABILITY_REMOTE;
  if (TOOL_GAP_BLOCK_RE.some((re) => re.test(s))) return OUTCOME_CODES.ENV_TOOL_MISSING;
  return null;
}

/** The failed check results (`{command, rc, output}`) whose output names a missing tool. */
export function toolGapFailures(failed = []) {
  return failed.filter((f) => CHECK_TOOL_GAP_RE.test(String(f?.output ?? "")));
}

/**
 * Package directories a check command line works in (`cd web && ...`, `--prefix web`, `-C web`, `--cwd web`, `web/node_modules/.bin/x`)
 * that carry a package.json but no installed node_modules: dependencies to prepare before the checks run.
 * @param {string[]} commands
 * @param {(rel: string) => boolean} exists  path relative to the worktree
 */
export function packageDirsMissingDeps(commands = [], exists = () => false) {
  const dirs = new Set();
  const add = (d) => {
    const dir = String(d ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!dir || dir.startsWith("/") || dir.split("/").includes("..") || /[$`*]/.test(dir)) return;
    dirs.add(dir);
  };
  for (const c of commands) {
    const s = String(c ?? "");
    for (const m of s.matchAll(/(?:^|[\s;&|(])cd\s+([^\s;&|)]+)/g)) add(m[1]);
    for (const m of s.matchAll(/(?:--prefix|--cwd|-C|--dir)[ =]([^\s;&|)]+)/g)) add(m[1]);
    for (const m of s.matchAll(/(?:^|[\s"'])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*?)\/node_modules\/\.bin\//g)) add(m[1]);
  }
  return [...dirs].filter((d) => exists(`${d}/package.json`) && !exists(`${d}/node_modules`));
}

// #6094: test-file names in check output. A linear token scan (split on non-path characters, then an anchored test of each
// basename): the earlier single regex nested quantifiers over overlapping classes and backtracked exponentially on long
// path-like output, which froze the lane (and the test suite) in a microtask-free spin.
const TEST_BASENAME_RES = [/^[\w@.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/, /^(?:test_[\w-]+|[\w-]+_test)\.(?:py|go|rb|rs)$/, /^[\w-]+Tests?\.(?:java|kt|cs)$/];
const MAX_SCAN_CHARS = 512 * 1024, MAX_TOKEN_CHARS = 400;
function testFilesNamed(output) {
  const text = String(output ?? "");
  const out = new Set();
  for (const raw of (text.length > MAX_SCAN_CHARS ? text.slice(-MAX_SCAN_CHARS) : text).split(/[^\w@./-]+/)) {
    if (!raw || raw.length > MAX_TOKEN_CHARS) continue;
    const tok = raw.replace(/^[./]+(?=[\w@])/, "").replace(/[.]+$/, "");
    const slash = tok.lastIndexOf("/");
    const base = slash < 0 ? tok : tok.slice(slash + 1);
    if (base && TEST_BASENAME_RES.some((re) => re.test(base))) out.add(tok);
  }
  return [...out];
}

/**
 * #6094: a failing check whose output names test files and none of them is in the diff is not caused by the change: the lane
 * reruns it once before treating it as red. Returns false when the output names no test file (cannot tell: not unrelated).
 * @param {string} output
 * @param {string[]} changed  files the lane's diff touches
 */
export function failureOutsideDiff(output, changed = []) {
  const named = testFilesNamed(output);
  if (!named.length) return false;
  const touched = (p) => changed.some((c) => c === p || c.endsWith(`/${p}`) || p.endsWith(`/${c}`) || c.split("/").pop() === p.split("/").pop());
  return !named.some(touched);
}

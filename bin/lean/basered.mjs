// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Base red (#5239): a still-failing repo-wide guard command (verify.invariants) is run once on the merge base. Failing there
 * too means the base is already red: the lane is deferred (`base.red`) behind the commit that broke it, never sent
 * needs-human; failing only on the lane tree blocks the merge. Attribution is deterministic (git log on the files the
 * failure names, then the issue number in the commit message), 0 LLM calls.
 */
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_RC = 124, MISSING_RC = 127;
const FILE_RE = /(?:^|[\s"'`(=:])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:py|mjs|cjs|js|jsx|ts|tsx|go|rs|rb|sh|ya?ml|json))\b/g;
const TEST_RE = /(?:^|[/_.-])(?:tests?|spec)(?:[/_.-]|$)/i;

/** Split failed `{command, rc}` rows by their base run `{command, rc}`: base red only when the base run itself failed (a timeout or missing runner is no evidence, so the failure stays the lane's). */
export function classifyBaseRed({ failed = [], baseRuns = [] } = {}) {
  const byCmd = new Map((baseRuns ?? []).map((b) => [b?.command, b]));
  const laneOwn = [], baseRed = [];
  for (const f of failed ?? []) {
    const b = byCmd.get(f.command), rc = Number(b?.rc);
    (b && Number.isInteger(rc) && rc !== 0 && rc !== TIMEOUT_RC && rc !== MISSING_RC ? baseRed : laneOwn).push(f);
  }
  return { laneOwn, baseRed };
}

/** Repo-relative file paths named in a command and its failure output, non-test paths first (the guarded code, not the guard). */
export function baseRedPaths(rows = []) {
  const seen = new Set(), src = [], tests = [];
  for (const r of rows) {
    for (const text of [r?.command, String(r?.output ?? "").slice(-20000)]) {
      for (const m of String(text ?? "").matchAll(FILE_RE)) {
        const p = m[1].replace(/^\.\//, "");
        if (p.startsWith("/") || p.startsWith("..") || seen.has(p)) continue;
        seen.add(p); (TEST_RE.test(p) ? tests : src).push(p);
      }
    }
  }
  return { src: src.slice(0, 20), tests: tests.slice(0, 20) };
}

/** Issue number a commit stands for: a closing keyword, else an `issue-N` branch name (merge commit), else the last `(#N)` of the subject. */
export function issueOf(subject = "", body = "") {
  const text = `${subject}\n${body}`;
  const close = [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].pop();
  if (close) return Number(close[1]);
  const br = text.match(/\bissue-(\d+)\b/);
  if (br) return Number(br[1]);
  const sub = [...String(subject).matchAll(/\(#(\d+)\)/g)].pop();
  return sub ? Number(sub[1]) : null;
}

/** The newest commit on `base` touching a file the failures name (guarded code first, else the tests): {sha, subject, issue, files} or null. Never throws. */
export async function attribute({ failed = [], git, base } = {}) {
  try {
    const { src, tests } = baseRedPaths(failed);
    for (const files of [src, tests]) {
      if (!files.length) continue;
      const out = String(await git(["log", "-1", "--format=%H%x1f%s%x1f%b", base, "--", ...files]).catch(() => "")).trim();
      const [sha, subject = "", body = ""] = out.split("\x1f");
      if (/^[0-9a-f]{40}$/.test(sha ?? "")) return { sha, subject, issue: issueOf(subject, body), files };
    }
  } catch { /* unattributable */ }
  return null;
}

/** Run each command once on a detached worktree of `mergeBase`, returning `[{command, rc}]`; removed afterwards. Empty when the worktree cannot be made (every failure then stays the lane's). */
export async function runOnBase({ commands = [], git, runCommand, mergeBase, cwd, env, timeoutMs, fs = nodeFs } = {}) {
  let dir = null;
  const out = [];
  try {
    dir = fs.mkdtempSync(join(tmpdir(), "basered-"));
    await git(["worktree", "add", "--detach", dir, mergeBase]);
    try { if (fs.existsSync(join(cwd, "node_modules"))) fs.symlinkSync(join(cwd, "node_modules"), join(dir, "node_modules")); } catch { /* best effort */ }
    for (const command of commands) {
      let r;
      try { r = await runCommand({ command, cwd: dir, timeoutMs, env }); } catch (e) { r = { rc: MISSING_RC, output: String(e?.message ?? e) }; }
      out.push({ command, rc: Number.isInteger(r?.rc) ? r.rc : 1 });
    }
  } catch { /* no base tree: no verdict */ } finally {
    if (dir) {
      try { await git(["worktree", "remove", "--force", dir]); } catch { /* best effort */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  return out;
}

/** Comment body that marks the introducing issue (or the new tracking issue) as the cause of a red base. */
export function baseRedNote({ base, att, laneIssue, commands }) {
  const cmds = commands.map((c) => `- \`${c}\``).join("\n");
  return `<!-- FORGE:BASE_RED -->\n## Base is red\nThese guard command(s) fail on \`${base}\`${att ? ` at \`${att.sha.slice(0, 12)}\` or earlier; last change to the files they name: \`${att.sha.slice(0, 12)}\` ${att.subject}` : ""}:\n${cmds}\n\nLane #${laneIssue} is deferred behind the fix; it is not needs-human. Fix the base (or reopen this issue) and the lane resumes.`;
}

/**
 * File or reopen against the introducing issue. `ghc(args)` runs gh (writes retried by the caller's wrapper). An attributed
 * issue gets a comment and is reopened when closed; no issue number files a new `base-red` tracking issue. Returns the
 * issue number, or null when GitHub could not be written (the lane still defers).
 */
export async function reportBaseRed({ ghc, repo, base, att, laneIssue, commands }) {
  const body = baseRedNote({ base, att, laneIssue, commands });
  try {
    if (att?.issue) {
      let state = "";
      try { state = String(await ghc(["issue", "view", String(att.issue), "-R", repo, "--json", "state", "-q", ".state"])).trim().toUpperCase(); } catch { /* comment anyway */ }
      if (state === "CLOSED") await ghc(["issue", "reopen", String(att.issue), "-R", repo]);
      await ghc(["issue", "comment", String(att.issue), "-R", repo, "--body", body]);
      return att.issue;
    }
    const url = String(await ghc(["issue", "create", "-R", repo, "--title", `fix: ${base} is red on guard command ${commands[0] ?? ""}`.slice(0, 120), "--body", body])).trim();
    const n = url.match(/\/issues\/(\d+)/);
    return n ? Number(n[1]) : null;
  } catch { return null; }
}

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
import { ensureFiledIssueDetailed, findFiledIssues } from "./filed-issue.mjs";

const TIMEOUT_RC = 124, MISSING_RC = 127;
const FILE_RE = /(?:^|[\s"'`(=:])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:py|mjs|cjs|js|jsx|ts|tsx|go|rs|rb|sh|ya?ml|json))\b/g;
const ENV_RE = /ModuleNotFoundError|ImportError|fail(?:s|ed)? closed|unknown revision|bad revision|not a valid ref|Needed a single revision/i;
const OUTPUT_TAIL = 4096, DAY_MS = 86400000;
const TEST_RE = /(?:^|[/_.-])(?:tests?|spec)(?:[/_.-]|$)/i;

/** Split failed `{command, rc}` rows by their base run `{command, rc}`: base red only when the base run itself failed (a timeout or missing runner is no evidence, so the failure stays the lane's). */
export function classifyBaseRed({ failed = [], baseRuns = [] } = {}) {
  const byCmd = new Map((baseRuns ?? []).map((b) => [b?.command, b]));
  const laneOwn = [], baseRed = [], env = [];
  for (const f of failed ?? []) {
    const b = byCmd.get(f.command), rc = Number(b?.rc);
    if (!(b && Number.isInteger(rc) && rc !== 0 && rc !== TIMEOUT_RC && rc !== MISSING_RC)) laneOwn.push(f);
    else (ENV_RE.test(String(b.output ?? "")) ? env : baseRed).push(f); // an environment signature in the base output is no evidence the base is red
  }
  return { laneOwn, baseRed, env };
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

/** #5913: true when the lane's changed files include a file the failing guard names (guarded code first, else its tests): the lane is then the base fix, not a bystander. */
export function diffTouchesGuard({ changed = [], failed = [] } = {}) {
  const { src, tests } = baseRedPaths(failed);
  const have = new Set((changed ?? []).map((f) => String(f).trim().replace(/^\.\//, "")).filter(Boolean));
  return [...src, ...tests].some((p) => have.has(p));
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

/** Run each command once on a detached worktree of `mergeBase`, returning `[{command, rc, output}]` (output: ~4KB tail), with BASE_SHA and LANE_CHECK_BASE set to the merge base sha so diff-scoped guards see an empty diff; removed afterwards. Empty when the worktree cannot be made (every failure then stays the lane's). */
export async function runOnBase({ commands = [], git, runCommand, mergeBase, cwd, env, timeoutMs, fs = nodeFs } = {}) {
  let dir = null;
  const out = [];
  try {
    dir = fs.mkdtempSync(join(tmpdir(), "basered-"));
    await git(["worktree", "add", "--detach", dir, mergeBase]);
    let sha = ""; try { sha = String(await git(["rev-parse", mergeBase])).trim(); } catch { /* fall back to the ref */ }
    env = { ...(env ?? {}), BASE_SHA: sha || mergeBase, LANE_CHECK_BASE: sha || mergeBase };
    try { if (fs.existsSync(join(cwd, "node_modules"))) fs.symlinkSync(join(cwd, "node_modules"), join(dir, "node_modules")); } catch { /* best effort */ }
    for (const command of commands) {
      let r;
      try { r = await runCommand({ command, cwd: dir, timeoutMs, env }); } catch (e) { r = { rc: MISSING_RC, output: String(e?.message ?? e) }; }
      out.push({ command, rc: Number.isInteger(r?.rc) ? r.rc : 1, output: String(r?.output ?? "").slice(-OUTPUT_TAIL) });
    }
  } catch { /* no base tree: no verdict */ } finally {
    if (dir) {
      try { await git(["worktree", "remove", "--force", dir]); } catch { /* best effort */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  return out;
}

/** Dedupe key line (base + sha12) searched for before a new issue is filed. */
export function baseRedKey(base, sha) { return sha ? `<!-- FORGE:BASE_RED_KEY ${base}@${String(sha).slice(0, 12)} -->` : ""; }

/** Comment body that marks the introducing issue (or the new tracking issue) as the cause of a red base; `outputs` maps command to the base run's output tail. */
export function baseRedNote({ base, att, laneIssue, commands, outputs = {}, sha }) {
  const cmds = commands.map((c) => `- \`${c}\``).join("\n");
  const tails = commands.filter((c) => outputs?.[c]).map((c) => `Base output of \`${c}\` (tail):\n\`\`\`\n${String(outputs[c]).slice(-OUTPUT_TAIL).replace(/```/g, "’’’")}\n\`\`\``).join("\n\n");
  const key = baseRedKey(base, att?.sha ?? sha);
  return `<!-- FORGE:BASE_RED -->\n${key ? `${key}\n` : ""}## Base is red\nThese guard command(s) fail on \`${base}\`${att ? ` at \`${att.sha.slice(0, 12)}\` or earlier; last change to the files they name: \`${att.sha.slice(0, 12)}\` ${att.subject}` : ""}:\n${cmds}\n\n${tails ? `${tails}\n\n` : ""}Lane #${laneIssue} is deferred behind the fix; it is not needs-human. Fix the base (or reopen this issue) and the lane resumes.`;
}

/**
 * File or reopen against the introducing issue. `ghc(args)` runs gh (writes retried by the caller's wrapper). An attributed
 * issue gets a comment and is reopened when closed; no issue number files a new `base-red` tracking issue. Returns the
 * issue number, or null when GitHub could not be written (the lane still defers).
 */
export async function reportBaseRed({ ghc, repo, base, att, laneIssue, commands, outputs, baseSha, commitDate }) {
  return fileBaseRed({ ghc, repo, att, key: baseRedKey(base, att?.sha ?? baseSha), commitDate, body: baseRedNote({ base, att, laneIssue, commands, outputs, sha: baseSha }), title: `fix: ${base} is red on guard command ${commands[0] ?? ""}` });
}

/**
 * #5838: the merge train found `checks` red on the bare `base` tip `baseSha` while bisecting batch `batch`: a red base, not a
 * culprit, so no PR is handed back. Filed through the same red-base path (a `base-red` tracking issue); returns its number or null.
 */
export async function reportTrainBaseRed({ ghc, repo, base, baseSha, checks = [], batch }) {
  const list = checks.map((c) => `- \`${c.name}\`${c.url ? ` ${c.url}` : ""}`).join("\n");
  const key = baseRedKey(base, baseSha);
  const body = `<!-- FORGE:BASE_RED -->\n${key ? `${key}\n` : ""}## Base is red\nThese required check(s) fail on the bare \`${base}\` tip \`${String(baseSha ?? "").slice(0, 12)}\`, found while bisecting merge-train batch ${batch}:\n${list}\n\nNo PR of the batch is handed back; they stay in the train and merge once the base is fixed.`;
  return fileBaseRed({ ghc, repo, att: null, key, body, title: `fix: ${base} is red on required check ${checks[0]?.name ?? ""}` });
}

/** Issues carrying `key`, newest first: [{number, state, closedAt, createdAt}]. Local marker filter over the issue list (#6238); empty on any failure. */
const findKeyed = findFiledIssues;

async function fileBaseRed({ ghc, repo, att, body, title, key, commitDate }) {
  try {
    if (att?.issue) {
      let state = "";
      try { state = String(await ghc(["issue", "view", String(att.issue), "-R", repo, "--json", "state", "-q", ".state"])).trim().toUpperCase(); } catch { /* comment anyway */ }
      if (state === "CLOSED") await ghc(["issue", "reopen", String(att.issue), "-R", repo]);
      await ghc(["issue", "comment", String(att.issue), "-R", repo, "--body", body]);
      return att.issue;
    }
    if (key) {
      const hits = await findKeyed({ ghc, repo, key }), cut = Date.parse(commitDate ?? "");
      const open = hits.find((h) => String(h.state).toUpperCase() === "OPEN");
      const reopen = !open && hits.find((h) => Number.isFinite(cut) && Date.parse(h.closedAt) > cut);
      const recent = !open && !reopen && hits.find((h) => Date.now() - Date.parse(h.createdAt) < DAY_MS); // at most one new issue per base+SHA per day
      const hit = open ?? reopen ?? recent;
      if (hit) {
        if (hit === reopen) await ghc(["issue", "reopen", String(hit.number), "-R", repo]);
        await ghc(["issue", "comment", String(hit.number), "-R", repo, "--body", body]);
        return Number(hit.number);
      }
    }
    const url = String(await ghc(["issue", "create", "-R", repo, "--title", title.slice(0, 120), "--body", body])).trim();
    const n = url.match(/\/issues\/(\d+)/);
    return n ? Number(n[1]) : null;
  } catch { return null; }
}

// #5992: one red-base verdict per (repo, base ref), valid for BASE_PROBE_TTL_MS and only while the base sha is unchanged.
export const BASE_PROBE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map();
const probeKey = (repo, base) => `${repo ?? ""}\u0000${base}`;

/** Cached verdict `{red, sha, att, commands, outputs}` for (repo, base) at `sha`; null on a miss, an expired entry or a moved sha. */
export function cachedBaseVerdict({ repo, base, sha, now = Date.now(), ttlMs = BASE_PROBE_TTL_MS } = {}) {
  const e = probeCache.get(probeKey(repo, base));
  if (!e || !sha || e.sha !== sha || now - e.at >= ttlMs) return null;
  return e.verdict;
}

/** Record a verdict for (repo, base) at `sha` (a lane's guardRed shares its red result so later lanes and the dispatcher skip the probe). */
export function recordBaseVerdict({ repo, base, sha, red, att = null, commands = [], outputs = {}, now = Date.now() } = {}) {
  if (!sha) return null;
  const verdict = { red: !!red, sha, att, commands, outputs };
  probeCache.set(probeKey(repo, base), { sha, at: now, verdict });
  return verdict;
}

export function clearBaseVerdicts() { probeCache.clear(); }

/**
 * #5992: the dispatcher's one probe per (repo, base sha). `readSha()` gives the current base sha; a fresh cache entry for it is
 * returned as is, otherwise `commands` run once on the base (runOnBase) and the verdict, with its attribution, is cached.
 * Never throws; null when the sha or the base run gives no evidence (a timeout or env failure is not a red base).
 */
export async function probeBase({ repo, base, commands = [], readSha, git, runCommand, cwd, env, timeoutMs, now = Date.now(), ttlMs = BASE_PROBE_TTL_MS, fs = nodeFs } = {}) {
  try {
    if (!commands.length) return null;
    const sha = String((await readSha()) ?? "").trim();
    if (!sha) return null;
    const hit = cachedBaseVerdict({ repo, base, sha, now, ttlMs });
    if (hit) return hit;
    const baseRuns = await runOnBase({ commands, git, runCommand, mergeBase: sha, cwd, env, timeoutMs, fs });
    const { baseRed } = classifyBaseRed({ failed: commands.map((command) => ({ command })), baseRuns });
    if (!baseRuns.length) return null;
    const cmds = baseRed.map((f) => f.command);
    const att = cmds.length ? await attribute({ failed: baseRuns.filter((b) => cmds.includes(b.command)), git, base: sha }) : null;
    const outputs = Object.fromEntries(baseRuns.filter((b) => cmds.includes(b.command)).map((b) => [b.command, b.output]));
    return recordBaseVerdict({ repo, base, sha, red: cmds.length > 0, att, commands: cmds, outputs, now });
  } catch { return null; }
}

/**
 * #5992: a lane that touches none of the files the red guard names (the attributed `att.files`) may bypass the base.red hold;
 * the guard is re-run on the merged tree at merge. False without both a known surface and a known lane diff (never guess a bypass).
 */
export function bypassesGuard({ laneFiles = [], att = null } = {}) {
  const surface = (att?.files ?? []).map((f) => String(f).replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  const lane = (laneFiles ?? []).map((f) => String(f).trim().replace(/^\.\//, "")).filter(Boolean);
  if (!surface.length || !lane.length) return false;
  return !lane.some((f) => surface.some((s) => f === s || f.startsWith(`${s}/`)));
}

/**
 * #6049: one issue per required release check the lane cannot run (lane-check parity gap), deduped by a hidden marker
 * keyed on the context name: an open or recent issue gets no second copy. Never throws; returns the issue numbers filed.
 */
export async function reportParityGaps({ ghc, repo, release, gaps = [] }) {
  const filed = [];
  for (const g of gaps) {
    const key = `<!-- FORGE:PARITY_GAP ${String(g.context).replace(/[^\w .:/()-]/g, "_")} -->`;
    try {
      const body = `${key}\n## Lane-check parity gap\nThe required check \`${g.context}\` on \`${release}\` has no lane equivalent, so a lane cannot catch its failures before the release PR: ${g.reason}.`;
      const r = await ensureFiledIssueDetailed({ ghc, repo, key, body, title: `ci: required release check ${g.context} has no lane pre-PR check`, occurrence: "" });
      if (r.created && r.number) filed.push(r.number);
    } catch { /* best effort */ }
  }
  return filed;
}

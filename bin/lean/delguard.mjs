// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5819: the checkpoint's deletion guard. A checkpoint stages everything (`git add -A`), so anything that removed files from
 * the worktree behind the builder's back (a failed dependency-cache publish, a stray recursive delete) would be committed and
 * pushed to the PR branch. Before the commit, the staged deletions of files the base tracks are compared with the contract's
 * deliverables: deletions outside them (more than `max`, default 0) are unstaged and restored in the worktree, and the caller
 * refuses to push. Deliverable deletions, and deletions of files the lane itself added, commit as before. Git is injected:
 * `git(args) -> stdout`, throws on failure.
 */
export const MAX_FOREIGN_DELETIONS_ENV = "FORGE_CHECKPOINT_MAX_DELETIONS";

/** The tolerated number of non-deliverable deletions: `FORGE_CHECKPOINT_MAX_DELETIONS` (a non-negative integer), else 0. */
export function maxForeignDeletions(env = process.env) {
  const v = String(env?.[MAX_FOREIGN_DELETIONS_ENV] ?? "").trim();
  return /^\d+$/.test(v) ? Number(v) : 0;
}

const CHUNK = 200;
const chunks = (l) => { const out = []; for (let i = 0; i < l.length; i += CHUNK) out.push(l.slice(i, i + CHUNK)); return out; };
const clean = (p) => String(p ?? "").trim().replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * Staged deletions as {path, to}: `to` is the rename destination (null for a plain deletion). Plumbing (`diff-index`), so a
 * porcelain diff config never changes the format. Entries with a newline are not git -z output and are ignored.
 */
export function parseStagedDeletions(out) {
  const f = String(out ?? "").split("\0");
  const res = [];
  for (let i = 0; i < f.length;) {
    const st = f[i++];
    if (!st) continue;
    if (/^R\d*$/.test(st)) { const path = f[i++], to = f[i++]; if (path && to && !/\n/.test(path + to)) res.push({ path, to }); }
    else if (st === "D") { const path = f[i++]; if (path && !/\n/.test(path)) res.push({ path, to: null }); }
    else return res; // not --name-status -z output (an injected fake): nothing parsed past it
  }
  return res;
}

/** Is `p` a deliverable (an exact path, or under a deliverable directory)? */
const covered = (p, keep) => keep.some((k) => k && (p === k || p.startsWith(`${k}/`)));

/**
 * After `git add -A`, before the checkpoint commit. Returns {refused, deleted, foreign, restored}: `foreign` are the staged
 * deletions of base-tracked files outside `keep` (contract deliverable paths). When there are more than `max` of them they are
 * unstaged and checked out again (refused: true, restored: whether every one is back on disk per git). Never throws: a git
 * failure while listing is a refusal-free pass (nothing parsed), a failure while restoring is reported in `error`.
 */
export async function guardStagedDeletions({ git, base = null, keep = [], max = 0 }) {
  const want = (keep ?? []).map(clean).filter(Boolean);
  let dels = [];
  try { dels = parseStagedDeletions(await git(["diff-index", "--cached", "--name-status", "-z", "-M", "--diff-filter=DR", "HEAD"])); } catch { return { refused: false, deleted: [], foreign: [] }; }
  if (!dels.length) return { refused: false, deleted: [], foreign: [] };
  // A rename into or out of a deliverable is the lane's own move; any other rename still removes the original path.
  const cands = dels.filter((d) => !covered(d.path, want) && !(d.to && covered(d.to, want))).map((d) => d.path);
  let foreign = cands;
  if (base && cands.length) { // files the lane added itself (absent on the base) are its own to delete
    try {
      const onBase = new Set();
      for (const c of chunks(cands)) for (const p of String(await git(["ls-tree", "-r", "--name-only", "-z", base, "--", ...c])).split("\0")) if (p) onBase.add(p);
      foreign = cands.filter((p) => onBase.has(p));
    } catch { foreign = cands; } // unreadable base: every candidate counts
  }
  const deleted = dels.map((d) => d.path);
  if (foreign.length <= max) return { refused: false, deleted, foreign };
  // Unstage the whole rename (both sides), then bring the originals back from HEAD.
  const renamedTo = dels.filter((d) => d.to && foreign.includes(d.path)).map((d) => d.to);
  try {
    for (const c of chunks([...foreign, ...renamedTo])) await git(["reset", "-q", "--", ...c]);
    for (const c of chunks(foreign)) await git(["checkout", "-q", "HEAD", "--", ...c]);
    let still = [];
    try { still = String(await git(["ls-files", "--deleted", "-z"])).split("\0").filter((p) => p && foreign.includes(p)); } catch { /* unverified */ }
    return { refused: true, deleted, foreign, restored: still.length === 0 };
  } catch (e) {
    return { refused: true, deleted, foreign, restored: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** One-line evidence for the run log, the trajectory and the engine-error detail. */
export function deletionEvidence(g, reason = "checkpoint") {
  const sample = g.foreign.slice(0, 8).map((p) => `\`${p}\``).join(", ");
  return `${reason}: the staged diff deleted ${g.foreign.length} tracked file(s) outside the contract deliverables (${sample}${g.foreign.length > 8 ? ", ..." : ""}); `
    + `${g.restored ? "they were restored in the worktree" : `restoring them failed${g.error ? ` (${g.error})` : ""}`} and nothing was pushed (#5819)`;
}

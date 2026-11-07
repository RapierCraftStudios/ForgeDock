// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5202: the engine pushes a `wip(forge): checkpoint` commit mid-run (context ceiling, timeout, turn budget). A fresh builder
 * session may then amend or squash it locally, so origin/<branch> is no longer an ancestor of HEAD and the next plain push is
 * rejected non-fast-forward. Before a push, when every remote-only commit is such a checkpoint that this worktree produced or
 * held (it is in the local reflog), it is merged in with `-s ours`: HEAD keeps the lane's own newer tree, the checkpoint stays in
 * history (never lost) and the push stays a plain fast-forward (never force). Deterministic, 0 LLM calls; never throws.
 */
const CHECKPOINT_PREFIX = "wip(forge): checkpoint";
const SEP = "\x1f";

/**
 * @param {object} o
 * @param {(args: string[]) => Promise<string>} o.git runs git in the lane worktree
 * @param {string} o.branch the lane's own branch
 * @returns {Promise<{state: "none"|"ok"|"reconciled"|"foreign"|"error", commits?: {sha: string, subject: string}[], sha?: string, error?: string}>}
 */
export async function reconcileCheckpoints({ git, branch }) {
  const out = async (args) => String(await git(args) ?? "").trim();
  const ok = async (args) => { try { await git(args); return true; } catch { return false; } };
  try {
    try { await git(["fetch", "origin", branch]); } catch { /* offline or not pushed yet: the tracking ref we have decides */ }
    const remote = `refs/remotes/origin/${branch}`;
    if (!(await ok(["rev-parse", "--verify", "-q", remote]))) return { state: "none" };
    if (await ok(["merge-base", "--is-ancestor", remote, "HEAD"])) return { state: "ok" };
    const commits = (await out(["log", `--format=%H${SEP}%s`, `HEAD..${remote}`])).split("\n").filter(Boolean).map((l) => {
      const [sha, subject = ""] = l.split(SEP);
      return { sha: sha.trim(), subject };
    });
    if (!commits.length) return { state: "ok" };
    const known = new Set();
    for (const ref of [`refs/heads/${branch}`, "HEAD"]) {
      try { for (const s of (await out(["log", "-g", "--format=%H", ref])).split("\n")) if (s.trim()) known.add(s.trim()); } catch { /* no reflog */ }
    }
    if (commits.some((c) => !c.subject.startsWith(CHECKPOINT_PREFIX) || !known.has(c.sha))) return { state: "foreign", commits };
    const tip = await out(["rev-parse", remote]);
    await git(["merge", "-s", "ours", "--no-edit", "-m", `merge(forge): keep pushed checkpoint ${tip.slice(0, 10)} in history`, remote]);
    return { state: "reconciled", commits, sha: tip };
  } catch (e) {
    return { state: "error", error: String(e?.stderr ?? e?.message ?? e).slice(0, 300) };
  }
}

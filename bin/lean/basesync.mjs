// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Base sync of a parked PR (#4525): a lane that ended needs-human leaves its PR open and nothing owns the branch, so it
 * rots as the base moves. `syncParked` merges the base into the PR branch in a throwaway worktree. A clean merge, or one
 * whose only conflicts are hunks where both sides purely added lines in a file matching `base_sync.union_globs`
 * (`unionResolve`: keep both), is pushed as a plain merge commit (never forced). Any other conflict is aborted and its
 * paths returned, the branch untouched. Deterministic (git only, no LLM); sequence/journal files are never resolved here
 * (they belong to sequence.mjs). Never throws.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { seqNumber } from "./sequence.mjs";

const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

/** Glob (`*` within a segment, `**` across, `?`) to a RegExp; a pattern with no `/` matches the file name anywhere. */
const globRe = (g) => {
  const body = String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*");
  return new RegExp(`^${String(g).includes("/") ? "" : "(?:.*/)?"}${body}$`);
};
export const matchesGlobs = (path, globs = []) => globs.some((g) => String(g).trim() && globRe(String(g).trim()).test(String(path)));

/** Never resolved here: a migration journal and numbered sequence files are sequence.mjs's. */
export const isSequenceFile = (path) => basename(String(path)) === "_journal.json" || seqNumber(path) !== null;

/**
 * Resolve a diff3-style conflicted text (`<<<<<<<` ours, `|||||||` base, `=======` theirs, `>>>>>>>`): a hunk resolves
 * only when its base section is empty (both sides only added lines), keeping ours then theirs. Returns the resolved
 * text, or null when the text has no conflict, no base section, or a hunk where either side changed or removed base lines.
 */
export function unionResolve(text) {
  const src = String(text ?? "").split("\n");
  const out = [];
  let i = 0, hunks = 0;
  while (i < src.length) {
    if (!src[i].startsWith("<<<<<<<")) { out.push(src[i++]); continue; }
    const ours = [], base = [], theirs = [];
    let part = ours, hasBase = false, closed = false;
    for (i++; i < src.length; i++) {
      const l = src[i];
      if (l.startsWith("|||||||")) { part = base; hasBase = true; } else if (l.startsWith("=======") && part !== theirs) part = theirs;
      else if (l.startsWith(">>>>>>>") && part === theirs) { closed = true; i++; break; } else part.push(l);
    }
    if (!closed || !hasBase || base.length) return null;
    out.push(...ours, ...theirs); hunks++;
  }
  return hunks ? out.join("\n") : null;
}

/**
 * @param {{git:(args:string[], o?:{cwd?:string})=>Promise<string>, base:string, branch:string, unionGlobs?:string[], last?:?string, tmp?:string}} p
 *   `git` runs in the repo checkout and throws on failure; `last` is the base sha already handled for this PR.
 * @returns {Promise<{status:"unchanged"|"up-to-date"|"merged"|"conflict"|"error", base?:string, paths?:string[], detail?:string}>}
 */
export async function syncParked({ git, base, branch, unionGlobs = [], last = null, tmp = tmpdir() }) {
  let wt = null, baseSha;
  try {
    await git(["fetch", "origin", base, branch]);
    baseSha = String(await git(["rev-parse", `origin/${base}`])).trim();
    if (last && last === baseSha) return { status: "unchanged", base: baseSha };
    try { await git(["merge-base", "--is-ancestor", `origin/${base}`, `origin/${branch}`]); return { status: "up-to-date", base: baseSha }; } catch { /* behind */ }
    wt = mkdtempSync(join(tmp, "basesync-"));
    await git(["worktree", "add", "--detach", wt, `origin/${branch}`]);
    const g = (a) => git(a, { cwd: wt });
    const ident = String(await g(["config", "user.email"]).catch(() => "")).trim() ? [] : ["-c", "user.name=ForgeDock", "-c", "user.email=forgedock@users.noreply.github.com"];
    let clean = true;
    try { await g([...ident, "merge", "--no-edit", `origin/${base}`]); } catch { clean = false; }
    if (!clean) {
      const conflicted = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=U"]).catch(() => ""));
      const stages = new Map();
      for (const l of lines(await g(["-c", "core.quotepath=off", "ls-files", "-u"]).catch(() => ""))) {
        const m = /^\d+ \S+ (\d)\t(.+)$/.exec(l); if (m) stages.set(m[2], (stages.get(m[2]) ?? 0) + (1 << Number(m[1])));
      }
      const fixes = [], refused = [];
      for (const f of conflicted) {
        let resolved = null;
        if (stages.get(f) === 14 && !isSequenceFile(f) && matchesGlobs(f, unionGlobs)) { // stages 1,2,3 present: both sides edited an existing file
          try { await g(["checkout", "--conflict=diff3", "--", f]); resolved = unionResolve(readFileSync(join(wt, f), "utf8")); } catch { resolved = null; }
        }
        if (resolved === null) refused.push(f); else fixes.push([f, resolved]);
      }
      if (!conflicted.length || refused.length) {
        await g(["merge", "--abort"]).catch(() => {});
        return { status: "conflict", base: baseSha, paths: refused.length ? refused : ["(unknown files)"] };
      }
      for (const [f, text] of fixes) { writeFileSync(join(wt, f), text); await g(["add", "--", f]); }
      await g([...ident, "commit", "--no-edit"]);
    }
    await git(["push", "origin", `${(await g(["rev-parse", "HEAD"])).trim()}:refs/heads/${branch}`]); // plain push: a rejected race is an error, never forced
    return { status: "merged", base: baseSha };
  } catch (e) {
    return { status: "error", ...(baseSha ? { base: baseSha } : {}), detail: String(e?.message ?? e).split("\n")[0].slice(0, 200) };
  } finally {
    if (wt) { await git(["worktree", "remove", "--force", wt]).catch(() => {}); try { rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

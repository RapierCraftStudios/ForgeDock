// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5979: comment churn per issue. Counts the engine's own comments (a `<!-- FORGE:... -->` marker) on each issue and the
 * repeated failures (the same `sig=<hash>` on more than one NEEDS_HUMAN/PARKED comment), so a noisy issue is visible. Pure,
 * except `readChurn`, which is read-only and best effort.
 */
const FORGE_RE = /<!--\s*FORGE:[A-Z_:-]+/;
const FAIL_RE = /<!--\s*FORGE:(?:NEEDS_HUMAN|PARKED)(?![A-Za-z0-9_])/;
const SIG_RE = /\bsig=([0-9a-f]{12})\b/;

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

/** @param {{issue:number, comments:{body:string}[]}[]} issues @returns {{perIssue:{issue:number, comments:number, repeats:number}[], max:number, median:number, repeated:number}} */
export function churnStats(issues) {
  const perIssue = [];
  for (const it of Array.isArray(issues) ? issues : []) {
    const sigs = new Map();
    let comments = 0;
    for (const c of Array.isArray(it?.comments) ? it.comments : []) {
      const body = String(c?.body ?? "");
      if (!FORGE_RE.test(body)) continue;
      comments++;
      const sig = FAIL_RE.test(body) ? SIG_RE.exec(body)?.[1] : null;
      if (sig) sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
    }
    perIssue.push({ issue: it?.issue, comments, repeats: [...sigs.values()].filter((n) => n > 1).length });
  }
  const counts = perIssue.map((p) => p.comments);
  return { perIssue, max: Math.max(0, ...counts), median: median(counts), repeated: perIssue.reduce((a, p) => a + p.repeats, 0) };
}

/** Report lines; none when there is nothing to count. */
export function formatChurnLines(stats) {
  if (!stats?.perIssue?.length) return [];
  const top = [...stats.perIssue].sort((a, b) => b.comments - a.comments).slice(0, 3).filter((p) => p.comments > 0);
  return [`comments per issue: max ${stats.max}, median ${stats.median}${top.length ? ` (${top.map((p) => `#${p.issue}: ${p.comments}`).join(", ")})` : ""}; repeated failures: ${stats.repeated}`];
}

/** Read the comments of `issues` through `gh` and return the report lines; never throws. */
export async function readChurn({ gh, repo, issues }) {
  try {
    const out = [];
    for (const n of (issues ?? []).slice(0, 50)) {
      try { out.push({ issue: n, comments: JSON.parse(String(await gh(["issue", "view", String(n), "-R", repo, "--json", "comments"])))?.comments ?? [] }); } catch { /* skip an unreadable issue */ }
    }
    return formatChurnLines(churnStats(out));
  } catch { return []; }
}

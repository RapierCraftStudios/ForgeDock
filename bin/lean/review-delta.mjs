// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Delta re-review (#4365). After a review, the engine keeps a checkpoint: the reviewed head and the reviewer's rows. A
 * later review on the same branch (after a FAIL and a builder fix, a base-sync, a CI fix, or a recovery lane in another
 * session) sends only the fix diff `git diff <reviewed> HEAD` with the first verdict and its cited failures; a pure clean
 * base merge since the reviewed head needs no reviewer at all. Plain git only (codebase-agnostic); any doubt is a full review.
 */

const HEX_RE = /^[0-9a-f]{7,64}$/;
const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

/**
 * How HEAD moved since the reviewed head: {kind, reason}. kind: "same" (nothing new), "base-merge" (every first-parent
 * commit is a two-parent merge of base history that `git merge-tree --write-tree` reproduces exactly: the rule of
 * scripts/review-delta.sh), "delta" (anything else), or "full" (no usable checkpoint: missing, not an ancestor, git error).
 * `git(args)` resolves with stdout and rejects on a non-zero exit.
 */
export async function classifyDelta(git, { reviewed, head, base }) {
  const r = (kind, reason) => ({ kind, reason });
  if (!HEX_RE.test(String(reviewed ?? "")) || !head) return r("full", "no reviewed head");
  if (reviewed === head) return r("same", "head is the reviewed head");
  try { await git(["merge-base", "--is-ancestor", reviewed, head]); } catch { return r("full", `reviewed head ${reviewed.slice(0, 12)} is not an ancestor of HEAD`); }
  let chain;
  try { chain = lines(await git(["rev-list", "--first-parent", `${reviewed}..${head}`])); } catch { return r("full", "rev-list failed"); }
  if (!chain.length) return r("delta", "no first-parent commits listed");
  for (const c of chain) {
    let parents;
    try { parents = String(await git(["rev-list", "--parents", "-n", "1", c])).trim().split(/\s+/); } catch { return r("full", `cannot read the parents of ${c.slice(0, 12)}`); }
    if (parents.length !== 3) return r("delta", `${c.slice(0, 12)} is not a merge`);
    try { await git(["merge-base", "--is-ancestor", parents[2], base]); } catch { return r("delta", `${c.slice(0, 12)} does not merge base history`); }
    let tree = "", want = "";
    try {
      tree = String(await git(["merge-tree", "--write-tree", parents[1], parents[2]])).split("\n")[0].trim();
      want = String(await git(["rev-parse", `${c}^{tree}`])).trim();
    } catch { return r("delta", `${c.slice(0, 12)} is not a clean merge`); }
    if (!tree || tree !== want) return r("delta", `${c.slice(0, 12)} resolves conflicts or edits the merge`);
  }
  return r("base-merge", `${chain.length} clean base merge(s) since the reviewed head`);
}

/**
 * The fix diff since the reviewed head, limited to the PR's files (`files`: the current changed files plus those the
 * reviewed head changed), so a base merge never brings the base's own changes into the prompt. {files, diff, stat}.
 */
export async function deltaDiff(git, { reviewed, base, files = [], ignore = [], statOver = Infinity }) {
  let prior = [];
  try { prior = lines(await git(["diff", "--name-only", `${base}...${reviewed}`])); } catch { /* the current files only */ }
  const scope = [...new Set([...files, ...prior])].filter((f) => !ignore.some((pre) => f.startsWith(pre)));
  if (!scope.length) return { files: [], diff: "", stat: "" };
  const changed = lines(await git(["diff", "--name-only", reviewed, "HEAD", "--", ...scope]));
  const diff = changed.length ? String(await git(["diff", reviewed, "HEAD", "--", ...changed])) : "";
  const stat = Buffer.byteLength(diff, "utf-8") > statOver ? String(await git(["diff", "--stat=200", reviewed, "HEAD", "--", ...changed]).catch(() => "")) : "";
  return { files: changed, diff, stat };
}

/** The contract ids a failure cites (`R1 partial: ...`, `P1 violated ...`), a scope file, or "issue_coverage". */
export function citedIds(failures = [], contract = {}) {
  const ids = new Set([...(contract.requirements ?? []), ...(contract.preserve ?? [])].map((x) => x.id));
  const out = new Set();
  for (const f of failures) {
    const d = String(f?.detail ?? "");
    const id = /^(\S+)\s/.exec(d)?.[1];
    if (id && ids.has(id)) out.add(id);
    else if (/^issue requirement /.test(d)) out.add("issue_coverage");
    else if (/^[^\s:]+:/.test(d) && f?.code === "conformance.scope_creep") out.add(d.slice(0, d.indexOf(":")));
  }
  return out;
}

/**
 * The delta skeleton: of the full skeleton, only the rows the cited failures name, scope rows for the files the fix
 * diff touches, issue_coverage only when an omission is cited, and empty regressions and verdict to fill.
 */
export function deltaSkeleton(full, { cited, files = [] }) {
  return {
    ...(cited.has("issue_coverage") ? { issue_coverage: full.issue_coverage } : {}),
    requirements: (full.requirements ?? []).filter((r) => cited.has(r.id)),
    scope: (full.scope ?? []).filter((s) => files.includes(s.file) || cited.has(s.file)),
    preserve: (full.preserve ?? []).filter((p) => cited.has(p.id)),
    regressions: [], verdict: "", summary: "",
  };
}

/**
 * The first review's rows with a delta reply applied: a reply row replaces the row with the same id (scope: file), rows
 * not in the reply stay; `regressions` is replaced, never appended (a fixed regression goes away; a reply without the
 * list leaves it unanswered so the review is incomplete); verdict and summary come from the reply only. null without a reply.
 */
export function mergeDeltaRows(prior, reply) {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return null;
  const out = { ...(prior && typeof prior === "object" ? prior : {}) };
  for (const [k, key] of [["requirements", "id"], ["preserve", "id"], ["scope", "file"]]) {
    const rows = Array.isArray(out[k]) ? out[k].filter((x) => !x?.filled) : [];
    for (const r of Array.isArray(reply[k]) ? reply[k] : []) { const i = rows.findIndex((x) => x?.[key] === r?.[key]); if (i >= 0) rows[i] = r; else rows.push(r); }
    out[k] = rows;
  }
  if (Array.isArray(reply.issue_coverage) && reply.issue_coverage.length) out.issue_coverage = reply.issue_coverage;
  out.regressions = Array.isArray(reply.regressions) ? reply.regressions : "unanswered";
  out.verdict = reply.verdict ?? "";
  out.summary = reply.summary ?? "";
  return out;
}

/** Above this many characters the rows are left off the FORGE:REVIEW checkpoint (the next session reviews in full). */
export const CHECKPOINT_ROWS_MAX = 30000;
const HEAD_RE = /\*\*Reviewed head:\*\* `([0-9a-f]{40}|[0-9a-f]{64})`(?: \(verdict ([a-z.-]+)\))?/;
const ROWS_RE = /<summary>review rows[^<]*<\/summary>\s*```json\n([\s\S]*?)\n```/;

/** The FORGE:REVIEW checkpoint lines: the reviewed head and verdict, then the rows (left off when over the cap). */
export function renderCheckpoint({ head, verdict = "conforms", rows = null } = {}) {
  if (!head) return "";
  const json = rows ? JSON.stringify(rows) : "";
  const block = json && json.length <= CHECKPOINT_ROWS_MAX ? `\n<details><summary>review rows (reviewed head ${String(head).slice(0, 12)})</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>` : "";
  return `\n\n**Reviewed head:** \`${head}\` (verdict ${verdict})${block}`;
}

/** {head, verdict, rows|null} from a FORGE:REVIEW body; null when it records no full 40/64-hex reviewed head. */
export function parseReviewCheckpoint(body) {
  const s = String(body ?? "");
  const m = HEAD_RE.exec(s);
  if (!m) return null;
  let rows = null;
  const j = ROWS_RE.exec(s)?.[1];
  if (j) { try { const v = JSON.parse(j); rows = v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { rows = null; } }
  return { head: m[1], verdict: m[2] ?? null, rows };
}

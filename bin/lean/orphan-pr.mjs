// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Orphan-PR sweep (#5505). A lane PR targets the lane base (`staging`), so GitHub never links it to its issue
 * (`closingIssuesReferences` is empty) and nothing closed it when the issue was resolved another way. The issue → PR link is
 * derived here from the lane branch `feat/issue-<n>-lean` or a `FORGE:ISSUE_PR` marker in the PR body, never from GitHub's link.
 * Deterministic, no model call. Each open PR whose issue is closed is classified, in order:
 *   backport-pending (kept) > not_planned > duplicate > superseded > undelivered.
 */
export const BACKPORT_LABEL = "backport-pending";
export const ALERT_AGE_MS = 24 * 3600 * 1000;
const MARK = (n) => `<!-- FORGE:ISSUE_PR issue=${n} -->`;

/** Issue number a PR was built for, or null (not a ForgeDock PR). */
export function parseIssueLink(pr) {
  const m = /^feat\/issue-(\d+)-lean$/.exec(String(pr?.headRefName ?? "")) ?? /FORGE:ISSUE_PR issue=(\d+)/.exec(String(pr?.body ?? ""));
  return m ? Number(m[1]) : null;
}
export const issuePrMarker = MARK;

/** Pure: `{ kind, detail }` for one open PR whose issue is closed. `ctx`: { issue:{stateReason,labels}, preferred, merged, onBase, base }. */
export function classifyOrphanPr(pr, ctx) {
  const labels = (ctx.issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
  if (labels.includes(BACKPORT_LABEL)) return { kind: "backport-pending", detail: "the backport is still pending" };
  if (/^(not_planned|duplicate)$/i.test(String(ctx.issue?.stateReason ?? ""))) return { kind: "not_planned", detail: "the issue was closed as not planned" };
  if (ctx.merged) return { kind: "duplicate", detail: `PR #${ctx.merged} for the same issue is merged` };
  if (ctx.preferred && ctx.preferred !== pr.number) return { kind: "duplicate", detail: `PR #${ctx.preferred} is the preferred PR for the same issue` };
  if (ctx.onBase) return { kind: "superseded", detail: `an equivalent change is already on \`${ctx.base}\` (${ctx.onBase})` };
  return { kind: "undelivered", detail: `the change is not on \`${ctx.base}\`` };
}

/** `{ count, oldestAgeMs, alert }` over rows with an `ageMs`; alert when any orphan is older than 24h. Kept PRs (backport-pending) and cleanup rows (backport-merged) do not count. */
const NOT_ORPHAN_KINDS = new Set(["backport-pending", "backport-merged"]);
export function orphanTelemetry(rows) {
  const r = (rows ?? []).filter((x) => x.kind && !NOT_ORPHAN_KINDS.has(x.kind));
  const oldestAgeMs = r.reduce((m, x) => Math.max(m, x.ageMs ?? 0), 0);
  return { count: r.length, oldestAgeMs, alert: r.length > 0 && oldestAgeMs > ALERT_AGE_MS };
}

const json = async (io, args) => { try { const v = JSON.parse(String(await io.gh(args)) || "null"); return v; } catch { return null; } };

/** Open PRs (other than `exceptPr`) built for `issue`; empty when the close is `not planned`/`duplicate` or gh fails (fail open). */
export async function openPrBlockingClose({ repo, io, issue, reason = "completed", exceptPr = null }) {
  if (/not.?planned|duplicate/i.test(reason)) return [];
  const prs = await json(io, ["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,headRefName,body"]);
  return (prs ?? []).filter((p) => p.number !== exceptPr && parseIssueLink(p) === issue).map((p) => p.number);
}

/** One live PR per issue: close every other open PR of `issue` as superseded by `newPr`. Returns the closed numbers. */
export async function supersedeOlderPrs({ repo, io, issue, newPr, dryRun = false }) {
  const prs = await json(io, ["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,headRefName,body"]);
  const old = (prs ?? []).filter((p) => p.number !== newPr && parseIssueLink(p) === issue).map((p) => p.number);
  if (!dryRun) for (const n of old) await io.gh(["pr", "close", String(n), "-R", repo, "--comment", `Superseded by #${newPr}: one live PR per issue (#${issue}).`]);
  return old;
}

/** Sweep every open PR to `base` whose issue is closed; one row per PR. Never throws; an unreadable PR is an `error` row. */
export async function sweepOrphanPrs({ repo, cwd = process.cwd(), io, base = "staging", dryRun = false, onResult = null } = {}) {
  const now = io.now?.() ?? Date.now();
  const rows = [];
  const open = await json(io, ["pr", "list", "-R", repo, "--state", "open", "--base", base, "--limit", "200", "--json", "number,headRefName,body,createdAt"]);
  const merged = await json(io, ["pr", "list", "-R", repo, "--state", "merged", "--base", base, "--limit", "200", "--json", "number,headRefName,body"]);
  const byIssue = new Map();
  for (const p of open ?? []) { const n = parseIssueLink(p); if (n) byIssue.set(n, [...(byIssue.get(n) ?? []), p]); }
  const mergedFor = new Map();
  for (const p of merged ?? []) { const n = parseIssueLink(p); if (n && !mergedFor.has(n)) mergedFor.set(n, p.number); }
  for (const [issue, prs] of [...byIssue].sort((a, b) => a[0] - b[0])) {
    const iss = await json(io, ["issue", "view", String(issue), "-R", repo, "--json", "state,stateReason,labels"]);
    if (!iss || String(iss.state).toUpperCase() !== "CLOSED") continue;
    const preferred = Math.max(...prs.map((p) => p.number));
    for (const pr of prs.sort((a, b) => a.number - b.number)) {
      let row = { pr: pr.number, issue, kind: null, ageMs: Math.max(0, now - Date.parse(pr.createdAt ?? now)) };
      try {
        let onBase = null;
        try {
          await io.git(["fetch", "-q", "origin", base, pr.headRefName], { cwd });
          const cherry = String(await io.git(["cherry", `origin/${base}`, `origin/${pr.headRefName}`], { cwd })).split("\n").filter(Boolean);
          if (!cherry.some((l) => l.startsWith("+"))) onBase = String(await io.git(["rev-parse", "--short=12", `origin/${base}`], { cwd })).trim();
        } catch { onBase = null; } // unknown: never close as superseded on a git failure
        const c = classifyOrphanPr(pr, { issue: iss, preferred, merged: mergedFor.get(issue), onBase, base });
        row = { ...row, ...c };
        if (c.kind !== "backport-pending" && !dryRun) {
          let note = `Closing: issue #${issue} is closed and this PR is orphaned (${c.kind}): ${c.detail}.`;
          if (c.kind === "undelivered") {
            const marker = `FORGE:ORPHAN_PR pr=${pr.number}`;
            const found = await json(io, ["issue", "list", "-R", repo, "--state", "all", "--search", `"${marker}" in:body`, "--json", "number"]);
            let ref = found?.[0]?.number ? `#${found[0].number}` : null;
            if (!ref) { const out = String(await io.gh(["issue", "create", "-R", repo, "--title", `Follow-up: undelivered work from PR #${pr.number} (issue #${issue})`, "--body", `PR #${pr.number} (branch \`${pr.headRefName}\`) was never merged and issue #${issue} is closed. Its change is not on \`${base}\`.\n\n<!-- ${marker} -->`])).trim(); ref = /(\d+)$/.test(out) ? `#${/(\d+)$/.exec(out)[1]}` : out; }
            row.followup = ref;
            note += ` Follow-up filed: ${ref} (branch \`${pr.headRefName}\` is kept).`;
          }
          await io.gh(["pr", "close", String(pr.number), "-R", repo, "--comment", note]);
          row.closed = true;
        }
      } catch (e) { row = { ...row, kind: "error", detail: String(e?.message ?? e).slice(0, 160) }; }
      rows.push(row);
      try { if (!dryRun) await onResult?.(row); } catch { /* an event sink never fails the sweep */ }
    }
  }
  if (!dryRun) await clearBackportPending({ repo, io, rows });
  return rows;
}

/** A closed issue labelled `backport-pending` whose backport PR (a `hotfix/*` or `backport/*` head naming it) is merged and none open: unlabel and close it. */
async function clearBackportPending({ repo, io, rows }) {
  const issues = await json(io, ["issue", "list", "-R", repo, "--state", "all", "--label", BACKPORT_LABEL, "--limit", "100", "--json", "number,state"]);
  for (const i of issues ?? []) {
    try {
      const prs = (await json(io, ["pr", "list", "-R", repo, "--state", "all", "--search", `#${i.number} in:title,body`, "--limit", "20", "--json", "number,state,headRefName"])) ?? [];
      const bp = prs.filter((p) => /^(hotfix|backport)\//.test(p.headRefName));
      if (!bp.length || bp.some((p) => p.state === "OPEN") || !bp.some((p) => p.state === "MERGED")) continue;
      await io.gh(["issue", "edit", String(i.number), "-R", repo, "--remove-label", BACKPORT_LABEL]);
      if (String(i.state).toUpperCase() === "OPEN") await io.gh(["issue", "close", String(i.number), "-R", repo, "--reason", "completed", "--comment", `The backport merged (PR #${bp.find((p) => p.state === "MERGED").number}); closing.`]);
      rows.push({ issue: i.number, kind: "backport-merged", detail: "label cleared" });
    } catch { /* retried on the next sweep */ }
  }
}

/** One line, e.g. `orphan PRs: closed 2 (superseded #4); ALERT oldest 30h`; "" when nothing orphaned. */
export function formatOrphanSummary(rows) {
  const t = orphanTelemetry(rows);
  const closed = (rows ?? []).filter((r) => r.closed);
  if (!t.count && !closed.length) return "";
  return `orphan PRs: ${t.count} found, ${closed.length} closed${closed.length ? ` (${closed.map((r) => `${r.kind} #${r.pr}`).join(", ")})` : ""}${t.alert ? `; ALERT oldest ${Math.round(t.oldestAgeMs / 3600000)}h` : ""}`;
}

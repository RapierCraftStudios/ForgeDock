// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Merge verification for `forgedock issue-watch`: an issue the watch claimed counts as verified only when its result
 * checks out after it closed, not because it closed. Checks, in order: a PR from `feat/issue-<n>-lean` merged into the
 * issue's lane; the PR does not carry `review-degraded`; the issue's latest trusted FORGE:REVIEW passed (enforced
 * `CONFORMS`, shadow `would PASS`, or a `review.trigger` skip; a shadow `would BLOCK` fails); every required check of the
 * lane is green on the merged head; the merge commit is on the lane; no check on the merge commit failed
 * (`forgedock/verify` is report-only). A failure reopens the issue with `needs-human` and the evidence; nothing is
 * reverted, a human decides. No LLM calls.
 */
import { isTrustedIssueComment } from "./prefilter.mjs";
import { requiredChecksFor } from "./effects.mjs";

export const VERIFY_MARKER = "FORGE:WATCH_VERIFY";
const OK_STATES = new Set(["success", "neutral", "skipped"]);
const REPORT_ONLY_CHECKS = new Set(["forgedock/verify"]);
const labelNames = (x) => new Set((x?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean));

/** Latest state per check name on `sha`: check runs (newest run per name) plus commit statuses. Unreadable = none. */
export async function checkStates({ gh, repo, sha }) {
  const runs = new Map();
  try {
    const out = String(await gh(["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs[] | [.id, .name, .status, (.conclusion // \"\")] | @tsv"]));
    for (const line of out.split("\n").filter(Boolean)) {
      const [id, name, status, conclusion] = line.split("\t");
      const prev = runs.get(name);
      if (!prev || Number(id) > prev.id) runs.set(name, { id: Number(id), name, state: status === "completed" ? conclusion || "failure" : "pending" });
    }
  } catch { /* none readable */ }
  try {
    const out = String(await gh(["api", `repos/${repo}/commits/${sha}/status`, "--jq", ".statuses[] | [.context, .state] | @tsv"]));
    for (const line of out.split("\n").filter(Boolean)) {
      const [name, s] = line.split("\t");
      if (!runs.has(name)) runs.set(name, { id: 0, name, state: s === "error" ? "failure" : s });
    }
  } catch { /* none readable */ }
  return [...runs.values()].map(({ name, state }) => ({ name, state }));
}

/** The latest trusted FORGE:REVIEW's verdict: pass | block | null (no review record). An unrecognised verdict is a block. */
export function reviewVerdict(comments = []) {
  const body = String(comments.filter((c) => isTrustedIssueComment(c) && /<!--\s*FORGE:REVIEW\b/.test(String(c?.body ?? ""))).at(-1)?.body ?? "");
  if (!body) return null;
  if (/would BLOCK|\*\*Verdict:\*\*\s*(?:NON-?CONFORM|BLOCK|FAIL)/i.test(body)) return "block";
  if (/\*\*Verdict:\*\*\s*CONFORMS|would PASS|Skipped by `review\.trigger/.test(body)) return "pass";
  return "block";
}

/**
 * `{status: verified|failed|pending|unmerged, evidence: [lines], pr?, sha?}` for closed issue `issue` on `lane`.
 * `unmerged`: no merged lane PR (closed as invalid, already fixed, decomposed). `pending`: a read failed or the merge
 * commit's CI is still running; the caller turns a pending older than its wait into failed.
 */
export async function verifyMerge({ gh, repo, lane, issue, comments, requiredChecks = (l) => requiredChecksFor({ gh, repo, lane: l }) }) {
  const ev = [], fail = (why, extra = {}) => ({ status: "failed", evidence: [...ev, `FAIL: ${why}`], ...extra });
  let prs;
  try { prs = JSON.parse(String(await gh(["pr", "list", "-R", repo, "--head", `feat/issue-${issue}-lean`, "--state", "merged", "--json", "number,baseRefName,headRefOid,mergeCommit,labels", "--limit", "5"])) || "[]"); }
  catch (e) { return { status: "pending", evidence: [`PR lookup failed: ${String(e?.message ?? e).split("\n")[0]}`] }; }
  const pr = prs.find((p) => p.baseRefName === lane) ?? prs[0];
  if (!pr) return { status: "unmerged", evidence: [`no merged PR from feat/issue-${issue}-lean`] };
  const sha = pr.mergeCommit?.oid ?? "";
  ev.push(`PR #${pr.number} merged into ${pr.baseRefName} at ${sha.slice(0, 12) || "?"}`);
  if (pr.baseRefName !== lane) return fail(`PR #${pr.number} targets ${pr.baseRefName}, not ${lane}`, { pr: pr.number });
  if (labelNames(pr).has("review-degraded")) return fail(`PR #${pr.number} merged with an incomplete review (review-degraded)`, { pr: pr.number });
  const verdict = reviewVerdict(comments);
  if (verdict !== "pass") return fail(verdict === "block" ? "the latest FORGE:REVIEW did not pass (a shadow-mode `would BLOCK` merges anyway)" : "no trusted FORGE:REVIEW on the issue", { pr: pr.number });
  ev.push("FORGE:REVIEW passed");
  let required = [];
  try { required = (await requiredChecks(lane)) ?? []; } catch { required = []; }
  if (required.length && pr.headRefOid) {
    const at = await checkStates({ gh, repo, sha: pr.headRefOid });
    const stateOf = (n) => at.find((x) => x.name === n)?.state ?? "missing";
    const bad = required.filter((n) => !OK_STATES.has(stateOf(n)));
    if (bad.length) return fail(`required check(s) not green on the merged head ${pr.headRefOid.slice(0, 12)}: ${bad.map((n) => `${n}=${stateOf(n)}`).join(", ")}`, { pr: pr.number });
    ev.push(`required checks green on the head: ${required.join(", ")}`);
  } else ev.push("no required checks on the lane");
  if (!sha) return fail("merged PR has no merge commit", { pr: pr.number });
  let rel = "";
  try { rel = String(await gh(["api", `repos/${repo}/compare/${lane}...${sha}`, "--jq", ".status"])).trim(); } catch { rel = ""; }
  if (!rel) return { status: "pending", evidence: [...ev, `could not compare ${lane} with ${sha.slice(0, 12)}`], pr: pr.number, sha };
  if (rel !== "behind" && rel !== "identical") return fail(`merge commit ${sha.slice(0, 12)} is not on ${lane} (compare: ${rel})`, { pr: pr.number, sha });
  ev.push(`merge commit is on ${lane}`);
  const post = (await checkStates({ gh, repo, sha })).filter((x) => !REPORT_ONLY_CHECKS.has(x.name));
  const red = post.filter((x) => !OK_STATES.has(x.state) && x.state !== "pending");
  if (red.length) return fail(`${lane} CI red on the merge commit: ${red.map((x) => `${x.name}=${x.state}`).join(", ")}`, { pr: pr.number, sha });
  const pending = post.filter((x) => x.state === "pending");
  if (pending.length) return { status: "pending", evidence: [...ev, `${lane} CI pending: ${pending.map((x) => x.name).join(", ")}`], pr: pr.number, sha };
  ev.push(post.length ? `${lane} CI green on the merge commit (${post.length} check(s))` : "no CI ran on the merge commit");
  return { status: "verified", evidence: ev, pr: pr.number, sha };
}

/** The verification record posted on the issue. */
export const verifyComment = (r, ts) => r.status === "verified"
  ? `<!-- ${VERIFY_MARKER} ${JSON.stringify({ result: "verified", pr: r.pr, sha: r.sha, ts })} -->\n## Issue watch: merge verified\n${r.evidence.map((l) => `- ${l}`).join("\n")}`
  : `<!-- ${VERIFY_MARKER} ${JSON.stringify({ result: "failed", pr: r.pr ?? null, ts })} -->\n## Issue watch: merge NOT verified\nThe lane merged, but its result did not check out. Nothing was reverted; a human decides (revert, follow-up fix, or accept).\n${r.evidence.map((l) => `- ${l}`).join("\n")}`;

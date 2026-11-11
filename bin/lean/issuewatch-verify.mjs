// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Merge verification for `forgedock issue-watch`: an issue the watch claimed counts as verified only when its result
 * checks out after it closed, not because it closed. Checks, in order: a PR from `feat/issue-<n>-lean` merged into the
 * issue's lane; the PR does not carry `review-degraded`; the issue's latest trusted FORGE:REVIEW passed (enforced
 * `CONFORMS`, shadow `would PASS`, or a `review.trigger` skip; an enforced NONCONFORMING/BLOCK/FAIL fails; a shadow
 * `would BLOCK` is advisory, as its label says: the lane merges by design, so it is recorded in the evidence, not reopened); every required check of the
 * lane is green on the merged head; the merge commit is on the lane; no check on the merge commit failed
 * (`forgedock/verify` is report-only; a `cancelled`/`stale` check, superseded by a newer run, is resolved against the newest
 * descendant run of the same check on the lane). A failure reopens the issue with `needs-human` and the evidence; nothing is
 * reverted, a human decides. No LLM calls.
 */
import { isTrustedIssueComment } from "./prefilter.mjs";
import { requiredChecksFor } from "./effects.mjs";

export const VERIFY_MARKER = "FORGE:WATCH_VERIFY";
const OK_STATES = new Set(["success", "neutral", "skipped"]);
const SUPERSEDED_STATES = new Set(["cancelled", "stale"]);
const DESCENDANTS_READ = 10;
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

/**
 * Settle superseded (`cancelled`/`stale`) checks of `sha` against the lane's newer commits: per check name the newest
 * descendant that ran it decides. Returns `{green: [evidence], red: [name=state@sha], pending: [name]}`; a name no descendant
 * has run yet is pending. Unreadable descendants = none.
 */
async function resolveSuperseded({ gh, repo, lane, sha, names }) {
  const out = { green: [], red: [], pending: [] };
  if (!names.length) return out;
  let desc = [];
  try { desc = String(await gh(["api", `repos/${repo}/compare/${sha}...${lane}`, "--jq", ".commits[].sha"])).split("\n").map((x) => x.trim()).filter(Boolean).reverse().slice(0, DESCENDANTS_READ); } catch { desc = []; }
  const open = new Set(names);
  for (const d of desc) {
    if (!open.size) break;
    const at = await checkStates({ gh, repo, sha: d });
    for (const n of [...open]) {
      const x = at.find((c) => c.name === n);
      if (!x || SUPERSEDED_STATES.has(x.state)) continue;
      open.delete(n);
      if (OK_STATES.has(x.state)) out.green.push(`${n} superseded by a ${x.state} run on ${d.slice(0, 12)}`);
      else if (x.state === "pending") out.pending.push(n);
      else out.red.push(`${n}=${x.state} on ${d.slice(0, 12)}`);
    }
  }
  out.pending.push(...open);
  return out;
}

/** The latest trusted FORGE:REVIEW's verdict: pass | shadow-block | block | null (no review record). An unrecognised verdict is a block. */
export function reviewVerdict(comments = []) {
  const body = String(comments.filter((c) => isTrustedIssueComment(c) && /<!--\s*FORGE:REVIEW\b/.test(String(c?.body ?? ""))).at(-1)?.body ?? "");
  if (!body) return null;
  if (/\*\*Verdict:\*\*\s*(?:NON-?CONFORM|BLOCK|FAIL)/i.test(body)) return "block";
  if (/would BLOCK/i.test(body)) return "shadow-block";
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
  if (verdict !== "pass" && verdict !== "shadow-block") return fail(verdict === "block" ? "the latest FORGE:REVIEW did not pass (enforced NONCONFORMING)" : "no trusted FORGE:REVIEW on the issue", { pr: pr.number });
  ev.push(verdict === "pass" ? "FORGE:REVIEW passed" : "FORGE:REVIEW shadow `would BLOCK` (advisory: shadow mode does not enforce; see the review comment)");
  let required = [];
  try { required = (await requiredChecks(lane)) ?? []; } catch { required = []; }
  if (required.length && pr.headRefOid) {
    const at = await checkStates({ gh, repo, sha: pr.headRefOid });
    const stateOf = (n) => at.find((x) => x.name === n)?.state ?? "missing";
    let bad = required.filter((n) => !OK_STATES.has(stateOf(n)));
    const sup = bad.filter((n) => SUPERSEDED_STATES.has(stateOf(n)));
    if (sup.length && sha) {
      const r = await resolveSuperseded({ gh, repo, lane, sha, names: sup });
      bad = bad.filter((n) => !sup.includes(n) || r.pending.includes(n) || r.red.some((x) => x.startsWith(`${n}=`)));
      if (r.pending.length) return { status: "pending", evidence: [...ev, `required check(s) cancelled on the head, no newer ${lane} run finished: ${r.pending.join(", ")}`], pr: pr.number, sha };
      ev.push(...r.green);
    }
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
  const red = post.filter((x) => !OK_STATES.has(x.state) && x.state !== "pending" && !SUPERSEDED_STATES.has(x.state));
  if (red.length) return fail(`${lane} CI red on the merge commit: ${red.map((x) => `${x.name}=${x.state}`).join(", ")}`, { pr: pr.number, sha });
  const sup = await resolveSuperseded({ gh, repo, lane, sha, names: post.filter((x) => SUPERSEDED_STATES.has(x.state)).map((x) => x.name) });
  if (sup.red.length) return fail(`${lane} CI red: a cancelled check on the merge commit was superseded by a failing run: ${sup.red.join(", ")}`, { pr: pr.number, sha });
  ev.push(...sup.green);
  const pending = [...post.filter((x) => x.state === "pending"), ...sup.pending.map((name) => ({ name }))];
  if (pending.length) return { status: "pending", evidence: [...ev, `${lane} CI pending: ${pending.map((x) => x.name).join(", ")}`], pr: pr.number, sha };
  ev.push(post.length ? `${lane} CI green on the merge commit (${post.length} check(s))` : "no CI ran on the merge commit");
  return { status: "verified", evidence: ev, pr: pr.number, sha };
}

/** The verification record posted on the issue. */
export const verifyComment = (r, ts) => r.status === "verified"
  ? `<!-- ${VERIFY_MARKER} ${JSON.stringify({ result: "verified", pr: r.pr, sha: r.sha, ts })} -->\n## Issue watch: merge verified\n${r.evidence.map((l) => `- ${l}`).join("\n")}`
  : `<!-- ${VERIFY_MARKER} ${JSON.stringify({ result: "failed", pr: r.pr ?? null, ts })} -->\n## Issue watch: merge NOT verified\nThe lane merged, but its result did not check out. Nothing was reverted; a human decides (revert, follow-up fix, or accept).\n${r.evidence.map((l) => `- ${l}`).join("\n")}`;

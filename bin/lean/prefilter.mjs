// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Already-fixed pre-filter (#4123): cheap checks before any lane starts, so an issue that a merged PR or a later green
 * CI run already resolved does not cost a worktree, a lease and a builder session.
 *   1. merged PRs (and lane commits) that claim to fix #N  -> candidate
 *   2. auto-filed CI-failure issue whose workflow is green again on the failing branch -> closed with the run link,
 *      unless it is flaky (#4305): flaky wording or label, a reopen after an earlier pre-filter close, or a failed run
 *      of the workflow at the green run's SHA. Then the shortcut is skipped and the issue goes on as normal.
 *   3. every repo path the issue names is gone from origin/<lane> -> candidate
 * A candidate gets ONE read-only, single-turn validation on a small model in the main checkout (no worktree). Only an
 * ALREADY-FIXED/INVALID verdict with evidence closes the issue; everything else, and every error, goes to the normal lane.
 * Post-deploy gate (#4389), with `defaultBranch`: a `FORGE:DEFERRED_FROM: #P` follow-up whose checklist items are all
 * post-deploy is parked (`parked: true`, label `awaiting-promotion`, no lane) while a merge SHA of #P is not an ancestor
 * of origin/<default>, or while forge.yaml `post_deploy.precondition_cmd` exits 1. Anything unresolvable fails open.
 * All effects are injected (gh, git, runner, transitionLabel, projector?, execCode?) so it is unit-testable.
 */
import { execFile } from "node:child_process";
import { capComment, sanitizeMd, noComments } from "./render.mjs";
import { PREFILTER_SYSTEM, prefilterPrompt, parsePrefilterVerdict } from "./prompts.mjs";
import { isTrustedComment } from "../engine/phases.mjs";
import { APP_SLUG } from "../init-repo.mjs";
import { probeResultOf } from "./probe.mjs";

export const DEFAULT_PREFILTER_MODEL = "claude-haiku-5-5";
export const PREFILTER_MARKER = "FORGE:PREFILTER";
/** Spend avoided per pre-filter close when the batch has no full-lane invalid run to average (#4123: ~$13 / 21 lanes). */
export const DEFAULT_AVOIDED_USD = 0.62;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `Fixes #N`, `closes owner/repo#N`, `resolved: #N`, or a lean-style title/subject ending `(#N)`. */
export function claimsFix(text, n) {
  const s = String(text ?? "");
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b:?\\s+(?:[\\w.-]+/[\\w.-]+)?#${n}(?!\\d)`, "i").test(s)
    || new RegExp(`\\(#${n}\\)\\s*$`, "m").test(s);
}

const RUN_URL_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/;
const CI_FAIL_RE = /\b(?:fail(?:s|ed|ing|ure)?|broken|red)\b/i;
/** The failing Actions run of an auto-filed CI-failure issue: failure wording plus a run link in the title or body. */
export function ciFailureRun(iss) {
  const text = `${iss.title ?? ""}\n${iss.body ?? ""}`;
  const m = RUN_URL_RE.exec(text);
  return m && CI_FAIL_RE.test(text) ? { repo: m[1], id: Number(m[2]) } : null;
}

// #4316: a bare "sometimes" is ordinary prose; only "fails sometimes" / "sometimes fails" says the failure is intermittent
const FLAKY_RE = /\b(?:intermittent\w*|flaky|flak(?:e|es|iness)|fail(?:s|ed|ing)?\s+sometimes|sometimes\s+fail(?:s|ed|ing)?|non-?deterministic\w*)\b/i;
const loginOf = (c) => String(c?.author?.login ?? c?.user?.login ?? "");
const trusted = (c) => {
  const login = loginOf(c);
  return isTrustedComment({ author_association: c?.authorAssociation ?? c?.author_association, user: { login, type: c?.user?.type ?? (/\[bot\]$|^app\//.test(login) ? "Bot" : "User") } });
};
/** #4315: a login compared as the engine posts it: lowercased, without `app/` or a `[bot]` suffix (`gh issue view` drops both). */
const bareLogin = (l) => String(l ?? "").trim().toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");
const isMarked = (c) => String(c?.body ?? "").trimStart().startsWith(`<!-- ${PREFILTER_MARKER} -->`);
/**
 * #4315: the logins the engine posts as: the ForgeDock App (`gh issue view` reports it as `rapiercraft-forgedock` with
 * CONTRIBUTOR, never `[bot]`) plus the token's own user (`gh api user`; an App installation token cannot read it).
 */
export async function ownLogins(gh) {
  return (await resolveOwnLogins(gh)).logins;
}
/**
 * #4318: {logins, resolved}. When `gh api user` fails (an App installation token), the App's own slug from `gh api app`
 * (a differently named App); `resolved` is false when neither lookup answered, so the batch memo may ask once more.
 */
export async function resolveOwnLogins(gh) {
  const out = new Set([bareLogin(APP_SLUG)]);
  let resolved = false;
  try { const me = bareLogin(await gh(["api", "user", "--jq", ".login"])); if (me) { out.add(me); resolved = true; } } catch { /* installation token */ }
  if (!resolved) {
    try { const slug = bareLogin(await gh(["api", "app", "--jq", ".slug"])); if (slug) { out.add(slug); resolved = true; } } catch { /* the App slug only */ }
  }
  return { logins: [...out], resolved };
}
/**
 * #4305: why one green run is no proof for this issue, without an API call: flaky wording or a `flaky` label, or an
 * earlier pre-filter close by the pipeline (the issue is open again, so an operator reopened it). {reason, why} or null.
 * #4315: a marker comment is the pipeline's own when it is trusted or written by one of `own` (bare logins).
 */
export function flakyReason(iss, own = [bareLogin(APP_SLUG)]) {
  if (FLAKY_RE.test(`${iss.title ?? ""}\n${noComments(String(iss.body ?? ""), " ")}`)) return { reason: "flaky", why: "issue says the failure is intermittent" };
  if ((iss.labels ?? []).some((l) => String(l?.name ?? l).toLowerCase() === "flaky")) return { reason: "flaky", why: "flaky label" };
  const mine = new Set((own ?? []).map(bareLogin));
  // #4399: the latest pipeline FORGE:PROBE result is a fail: the fix did not hold in production, so no already-fixed close
  const probe = (iss.comments ?? []).filter((c) => probeResultOf(c?.body) && (trusted(c) || mine.has(bareLogin(loginOf(c))))).at(-1);
  if (probe && probeResultOf(probe.body).result === "fail") return { reason: "probe-failed", why: "acceptance probe failed after promotion" };
  if ((iss.comments ?? []).some((c) => isMarked(c) && (trusted(c) || mine.has(bareLogin(loginOf(c)))))) return { reason: "reopened", why: "reopened after a pre-filter close" };
  return null;
}
/** The own logins, looked up only when an otherwise-untrusted marker comment needs them (no call for most issues). */
const ownFor = async (iss, resolve) => ((iss.comments ?? []).some((c) => (isMarked(c) || probeResultOf(c?.body)) && !trusted(c)) ? resolve() : undefined);
const selfResolver = (selfLogins, gh) => (typeof selfLogins === "function" ? selfLogins : selfLogins ? async () => selfLogins : () => ownLogins(gh));

const PATH_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8})(?::\d+(?:-\d+)?)?(?=$|[\s`'"),.:;\]])/gm;
/** Repo-relative file paths the issue names (`dir/file.ext`, optionally `:line`); URLs and HTML comments are ignored. */
export function namedPaths(text) {
  const s = noComments(sanitizeMd(text), " ").replace(/\b[a-z]+:\/\/\S+/gi, " ");
  return [...new Set([...s.matchAll(PATH_RE)].map((m) => m[1].replace(/^\.\//, "")).filter((p) => !p.startsWith("/") && !p.startsWith("../")))];
}

/**
 * @returns {Promise<{prs:object[], commits:object[], ci:?object, ciSkip?:{reason:string, why:string}, missingPaths:string[], namedPaths:string[]}>}
 */
export async function collectSignals({ iss, repo, lane, io, cwd, selfLogins = null }) {
  const n = iss.number;
  const sig = { prs: [], commits: [], ci: null, missingPaths: [], namedPaths: [] };
  try {
    const found = JSON.parse(String(await io.gh(["search", "prs", `#${n}`, "--repo", repo, "--merged", "--json", "number,title,body,url", "--limit", "20"])) || "[]");
    sig.prs = found.filter((p) => claimsFix(p.title, n) || claimsFix(p.body, n));
  } catch { /* search unavailable: no PR signal */ }
  try {
    const log = String(await io.git(["log", `origin/${lane}`, "--max-count=50", "-E", `--grep=#${n}([^0-9]|$)`, "--format=%H%x09%s"], { cwd }));
    sig.commits = log.split("\n").map((l) => l.split("\t")).filter(([h, s]) => h && s && !/^Merge /.test(s) && claimsFix(s, n)).map(([sha, subject]) => ({ sha, subject }));
  } catch { /* no lane ref: no commit signal */ }
  const run = ciFailureRun(iss);
  if (run && run.repo.toLowerCase() === repo.toLowerCase()) {
    try {
      const failed = JSON.parse(String(await io.gh(["api", `repos/${repo}/actions/runs/${run.id}`])));
      const branch = failed.head_branch || lane;
      const latest = JSON.parse(String(await io.gh(["api", `repos/${repo}/actions/workflows/${failed.workflow_id}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=1`])))?.workflow_runs?.[0];
      if (latest && latest.id !== failed.id && latest.conclusion === "success" && Date.parse(latest.created_at) > Date.parse(failed.created_at)) {
        const sha = latest.head_sha ?? "";
        // #4305: a workflow that failed and passed at the same SHA is flaky; the lookup is any branch (PR run vs push)
        // and only made when the issue itself gave no reason. An unreadable lookup throws: no CI signal.
        const own = await ownFor(iss, selfResolver(selfLogins, io.gh));
        let skip = flakyReason(iss, own);
        const same = { reason: "same-sha", why: `failed and passed at ${sha.slice(0, 12)}` };
        if (!skip && sha && failed.head_sha === sha) skip = same;
        if (!skip && sha) {
          const atSha = JSON.parse(String(await io.gh(["api", `repos/${repo}/actions/workflows/${failed.workflow_id}/runs?head_sha=${sha}&status=completed&per_page=100`])))?.workflow_runs ?? [];
          if (atSha.some((r) => r?.conclusion === "failure")) skip = same;
        }
        if (skip) sig.ciSkip = skip;
        else sig.ci = { workflow: failed.name ?? latest.name ?? String(failed.workflow_id), branch, failedUrl: failed.html_url, greenUrl: latest.html_url, greenSha: sha };
      }
    } catch { /* run unreadable: no CI signal */ }
  }
  sig.namedPaths = namedPaths(iss.body);
  if (sig.namedPaths.length) {
    const missing = [];
    for (const p of sig.namedPaths.slice(0, 20)) {
      try { await io.git(["cat-file", "-e", `origin/${lane}:${p}`], { cwd }); } catch { missing.push(p); }
    }
    if (missing.length === Math.min(sig.namedPaths.length, 20)) sig.missingPaths = missing; // all gone: the code moved or was removed
  }
  return sig;
}

// #4389: post-deploy precondition gate. A follow-up filed by scripts/file-deferred-followups.sh whose items are all
// post-deploy checks cannot be done before its parent's fix is on the default branch: a git fact, so no lane learns it.
export const PRECONDITION_MARKER = "FORGE:PRECONDITION";
export const AWAITING_PROMOTION_LABEL = "awaiting-promotion";
const DEFERRED_FROM_RE = /<!--\s*FORGE:DEFERRED_FROM:\s*#(\d+)\s*-->/;
/** The parent #P of a deferred follow-up (`<!-- FORGE:DEFERRED_FROM: #P -->`), or null. */
export function deferredFrom(body) {
  const m = DEFERRED_FROM_RE.exec(String(body ?? ""));
  return m ? Number(m[1]) : null;
}
const CHECK_RE = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/;
/** True when the body has checklist items and every one is a ``- [ ] `R#: …` — post-deploy: why`` line (conformance followupItems). */
export function postDeployOnly(body) {
  const items = noComments(String(body ?? ""), " ").split("\n").map((l) => CHECK_RE.exec(l)?.[1]).filter((x) => x != null);
  return items.length > 0 && items.every((t) => /^`[^`]*`\s+(?:\*\*known-flaw\*\*\s+)?[—-]+\s*post-deploy:/.test(t));
}
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/**
 * #4467: an issue comment the engine may trust, in REST shape (`user.type`) or `gh issue view` shape (`author.login`,
 * `authorAssociation`): what isTrustedComment trusts, or the ForgeDock App, which `gh issue view` reports as a bare
 * `rapiercraft-forgedock` CONTRIBUTOR with no type and no `[bot]` suffix (#4315).
 */
export const isTrustedIssueComment = (c) => Boolean(c) && (trusted(c) || bareLogin(loginOf(c)) === bareLogin(APP_SLUG));
/** Merge commits of the merged PRs that claim to fix #parent; else the `merged at <sha>` of its trusted FORGE:TRAJECTORY. */
export async function parentMergeShas({ parent, repo, io }) {
  const shas = new Set();
  try {
    const prs = JSON.parse(String(await io.gh(["pr", "list", "-R", repo, "--state", "merged", "--search", `#${parent}`, "--json", "number,title,body,mergeCommit", "--limit", "20"])) || "[]");
    for (const p of prs) if ((claimsFix(p.title, parent) || claimsFix(p.body, parent)) && SHA_RE.test(p.mergeCommit?.oid ?? "")) shas.add(p.mergeCommit.oid);
  } catch { /* unreadable: try the trajectory */ }
  if (!shas.size) {
    try {
      const v = JSON.parse(String(await io.gh(["issue", "view", String(parent), "-R", repo, "--json", "comments"])));
      for (const c of v.comments ?? []) {
        const b = String(c?.body ?? "");
        const m = b.includes("FORGE:TRAJECTORY") && isTrustedIssueComment(c) ? /merged at `?([0-9a-f]{7,40})\b/i.exec(b) : null;
        if (m) shas.add(m[1]);
      }
    } catch { /* unreadable: no SHA */ }
  }
  return [...shas];
}
/** Default `io.execCode`: the exit code of an argv-only child (-1 when it could not run or timed out). */
function execCode(cmd, args, opts) {
  return new Promise((res) => {
    try { execFile(cmd, args, opts, (err) => res(err ? (typeof err.code === "number" ? err.code : -1) : 0)); } catch { res(-1); }
  });
}
/**
 * #4389: never throws, no model call. `defaultBranch` is a name or an (async) function resolving it (and fetching it).
 * @returns {Promise<{state:"not-applicable"|"unresolved"|"awaiting-promotion"|"awaiting-precondition"|"ready", parent:?number, shas:string[], default?:string, detail:string}>}
 * Fail-open: no merge SHA, a git answer other than yes/no, an unknown default branch or a hook error give "unresolved".
 */
export async function postDeployGate({ iss, repo, lane, defaultBranch, cwd, io, preconditionCmd = null }) {
  const parent = deferredFrom(iss?.body);
  const res = (state, detail, extra = {}) => ({ state, parent, shas: [], detail, ...extra });
  if (!parent || !postDeployOnly(iss.body)) return res("not-applicable", "");
  try {
    const def = typeof defaultBranch === "function" ? await defaultBranch() : defaultBranch;
    if (!def) return res("unresolved", "default branch unknown");
    const shas = await parentMergeShas({ parent, repo, io });
    if (!shas.length) return res("unresolved", `no merge SHA found for #${parent}`);
    const off = [];
    for (const sha of shas) {
      let on;
      try { await io.git(["merge-base", "--is-ancestor", sha, `origin/${def}`], { cwd }); on = true; } catch (e) { on = e?.code === 1 ? false : null; }
      if (on === null) return res("unresolved", `${sha.slice(0, 12)} unknown to git`, { shas, default: def });
      if (!on) off.push(sha);
    }
    if (off.length) return res("awaiting-promotion", `fix ${off.map((s) => s.slice(0, 12)).join(", ")} of #${parent} is not on ${def}${lane ? ` (lane ${lane})` : ""}`, { shas, default: def });
    if (preconditionCmd) {
      const code = await (io.execCode ?? execCode)("sh", ["-c", preconditionCmd, "precondition", String(iss.number)],
        { cwd, timeout: 60000, env: { ...process.env, FORGE_ISSUE: String(iss.number) } });
      if (code === 1) return res("awaiting-precondition", `fix of #${parent} is on ${def}; post_deploy.precondition_cmd says not ready`, { shas, default: def });
      if (code !== 0) return res("unresolved", `post_deploy.precondition_cmd exited ${code}`, { shas, default: def });
    }
    return res("ready", `fix of #${parent} is on ${def}`, { shas, default: def });
  } catch (e) {
    return res("unresolved", `gate error (${String(e?.message ?? e).slice(0, 120)})`);
  }
}
/**
 * #4389: the default branch for the gate, resolved and fetched once, only when a gated issue asks: forge.yaml
 * `branches.default`, else GitHub's default branch. Null when neither answers (the gate then fails open).
 */
export function lazyDefaultBranch({ io, repo, cwd, configured = null }) {
  let p = null;
  return () => (p ??= (async () => {
    let name = configured;
    if (!name) { try { name = String(await io.gh(["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim() || null; } catch { name = null; } }
    if (name) { try { await io.git(["fetch", "origin", name], { cwd }); } catch { /* offline: use the local ref */ } }
    return name;
  })());
}
/** #4389: label and explain a parked issue once (the comment only when the label was not there yet); best effort. */
async function markParked({ issue, repo, io, had, gate }) {
  const edit = () => io.gh(["issue", "edit", String(issue), "-R", repo, "--add-label", AWAITING_PROMOTION_LABEL]);
  try { await edit(); } catch {
    try {
      await io.gh(["label", "create", AWAITING_PROMOTION_LABEL, "-R", repo, "--force", "--color", "C5DEF5", "--description", "Post-deploy follow-up parked until its parent fix reaches the default branch. Managed by ForgeDock."]);
      await edit();
    } catch { /* the comment and the report still show it */ }
  }
  if (had) return;
  const what = gate.state === "awaiting-promotion" ? "awaiting promotion" : "awaiting its post-deploy precondition";
  const body = `<!-- ${PRECONDITION_MARKER} -->\n## Parked: ${what}\n${sanitizeMd(gate.detail)}.\n\nEvery item here is a post-deploy check, so no lane was started. The next orchestrate or triage run checks again and launches this issue once the precondition holds.`;
  try { await io.gh(["issue", "comment", String(issue), "-R", repo, "--body", capComment(body)]); } catch { /* the label still shows it */ }
}

/** #4389 batch-report lines: one `awaiting promotion:` line (and one `awaiting precondition:` line) for the parked rows, or "". */
export function formatParkedLine(rows) {
  const parked = (rows ?? []).filter((r) => r?.prefilter?.parked);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const out = [];
  const promo = parked.filter((r) => r.prefilter.kind === "awaiting-promotion");
  if (promo.length) {
    const lanes = uniq(promo.map((r) => r.prefilter.lane)), defs = uniq(promo.map((r) => r.prefilter.default));
    out.push(`awaiting promotion: ${promo.map((r) => `#${r.issue}`).join(" ")} (fixes on ${lanes.join(", ") || "the lane"}, not on ${defs.join(", ") || "the default branch"})`);
  }
  const pre = parked.filter((r) => r.prefilter.kind === "awaiting-precondition");
  if (pre.length) out.push(`awaiting precondition: ${pre.map((r) => `#${r.issue}`).join(" ")} (post_deploy.precondition_cmd not ready)`);
  return out.join("\n");
}

/**
 * Pre-filter one issue. Never throws.
 * @returns {Promise<{issue:number, closed:boolean, kind:?string, candidate:boolean, verdict:?string, cost_usd:number, detail:string}>}
 */
export async function prefilterIssue({ issue, repo, lane, cwd, io, model = DEFAULT_PREFILTER_MODEL, dryRun = false, agentId = null, maxMinutes = 5, selfLogins = null, defaultBranch = null, preconditionCmd = null }) {
  const out = { issue, closed: false, kind: null, candidate: false, verdict: null, cost_usd: 0, detail: "" };
  try {
    const iss = JSON.parse(String(await io.gh(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,labels,comments"])));
    if (String(iss.state).toUpperCase() !== "OPEN") return { ...out, detail: "not open" };
    const names = (iss.labels ?? []).map((l) => l?.name ?? l);
    const labelled = names.some((l) => ["needs-human", "workflow:merged"].includes(l));
    // #4389: a post-deploy follow-up is gated even when an earlier lane escalated it (needs-human); nothing else changes.
    const gated = !!defaultBranch && !names.includes("workflow:merged") && deferredFrom(iss.body) != null && postDeployOnly(iss.body);
    if (labelled && !gated) return { ...out, detail: "labelled, left to the lane" };
    if (io.projector) {
      let st = null;
      try { st = await io.projector.readState(issue); } catch { /* unreadable: proceed */ }
      if (st?.lease && st.lease.until > Date.now() && st.lease.by !== agentId) return { ...out, detail: `leased by ${st.lease.by}` };
    }
    if (gated) {
      const gate = await postDeployGate({ iss, repo, lane, defaultBranch, cwd, io, preconditionCmd });
      const had = names.includes(AWAITING_PROMOTION_LABEL);
      if (gate.state === "awaiting-promotion" || gate.state === "awaiting-precondition") {
        if (!dryRun) await markParked({ issue, repo, io, had, gate });
        return { ...out, parked: true, kind: gate.state, parent: gate.parent, lane, default: gate.default, detail: gate.detail };
      }
      if (gate.state === "ready" && had && !dryRun) {
        try { await io.gh(["issue", "edit", String(issue), "-R", repo, "--remove-label", AWAITING_PROMOTION_LABEL]); } catch { /* best effort */ }
      }
      if (labelled) return { ...out, detail: `labelled, left to the lane (post-deploy gate: ${gate.state}${gate.detail ? `, ${gate.detail}` : ""})` };
    }
    // #4399: an issue reopened by a failed acceptance probe goes to a lane, never back to an already-fixed close
    if ((iss.comments ?? []).some((c) => probeResultOf(c?.body)?.result === "fail")
      && flakyReason({ comments: iss.comments }, await ownFor(iss, selfResolver(selfLogins, io.gh)))?.reason === "probe-failed") {
      return { ...out, detail: "acceptance probe failed after promotion (FORGE:PROBE): no already-fixed close; lane" };
    }
    const sig = await collectSignals({ iss, repo, lane, io, cwd, selfLogins });
    const close = async (kind, body, detail) => {
      let note = "";
      if (!dryRun) {
        // #4315: close first: the marker is posted only on an issue that was closed, so it always means "reopened" later
        await io.gh(["issue", "close", String(issue), "-R", repo, "--reason", "not planned"]);
        // #4314: the issue IS closed from here on: the result is closed:true whatever the comment does, so no lane starts on it.
        // The comment is retried once, then a marker-only comment (a second, tiny payload) keeps the #4305 reopen guard working.
        const comment = (text) => io.gh(["issue", "comment", String(issue), "-R", repo, "--body", text]);
        const full = capComment(`<!-- ${PREFILTER_MARKER} -->\n<!-- FORGE:VALIDATE -->\n${body}`);
        const minimal = `<!-- ${PREFILTER_MARKER} -->\nClosed by the pre-filter (${kind}); the explanation comment could not be posted. Reopen if this is wrong.`;
        let posted = false;
        for (const text of [full, full, minimal]) {
          try { await comment(text); posted = true; break; } catch { /* next attempt */ }
        }
        if (!posted) note = " (closed, but no marker comment could be posted: a reopen is not recognised)";
        try { await io.transitionLabel?.(issue, "invalid"); } catch { /* labels are best effort */ }
      }
      return { ...out, closed: !dryRun, kind, detail: `${detail}${note}` };
    };

    // #4305: a skipped CI-green shortcut is named in every non-closing detail line that follows (#4316: with its reason).
    const keep = (detail) => ({ ...out, detail: sig.ciSkip ? `skipped CI-green shortcut: ${sig.ciSkip.reason} (${sig.ciSkip.why}); ${detail}` : detail });
    if (sig.ci) {
      out.candidate = true;
      const c = sig.ci;
      return await close("ci-green", `## Pre-filter: CI failure no longer reproduces\n**Workflow:** ${c.workflow} on \`${c.branch}\`\n**Failing run:** ${c.failedUrl}\n**Latest run (green):** ${c.greenUrl}${c.greenSha ? ` at \`${c.greenSha.slice(0, 12)}\`` : ""}\n\nClosed without a lane. Reopen if the failure comes back.`,
        `CI green again: ${c.greenUrl}`);
    }
    if (!sig.prs.length && !sig.commits.length && !sig.missingPaths.length) return keep("no already-fixed signal");
    out.candidate = true;
    const why = [...sig.prs.map((p) => `PR #${p.number}`), ...sig.commits.map((c) => c.sha.slice(0, 12)), ...(sig.missingPaths.length ? ["named paths missing"] : [])].join(", ");
    if (dryRun) return keep(`candidate: ${why}`);
    let r;
    try {
      r = await io.runner({ role: "prefilter", issue, cwd, model, resume: null, system: PREFILTER_SYSTEM, readOnly: true,
        prompt: prefilterPrompt({ issue: iss, lane, signals: sig }), maxMs: Math.round(maxMinutes * 60000) });
    } catch (e) { return keep(`validation failed (${String(e?.message ?? e).slice(0, 120)}): lane`); }
    out.cost_usd = Number.isFinite(r?.costUsd) ? r.costUsd : 0;
    const v = parsePrefilterVerdict(r?.text);
    out.verdict = v?.verdict ?? null;
    if (!v || v.verdict === "CONFIRMED" || !v.evidence.length) return keep(`candidate (${why}) ${v ? (v.verdict === "CONFIRMED" ? "confirmed" : "without evidence") : "unparseable verdict"}: lane`);
    const ev = v.evidence.map((x) => `- ${sanitizeMd(x).replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    return await close("validated", `## Pre-filter: ${v.verdict}\n**Signal:** ${why}\n**Summary:** ${sanitizeMd(v.summary).replace(/\s+/g, " ").slice(0, 600) || "not reported"}\n\n**Evidence:**\n${ev}\n\nValidated by a single read-only check (${model}), without a lane. Reopen if this is wrong.`,
      `${v.verdict.toLowerCase()} (${why})`);
  } catch (e) {
    return { ...out, detail: `pre-filter error (${String(e?.message ?? e).slice(0, 120)}): lane` };
  }
}

/** Per-issue hook for `orchestrate({ prefilter })`; `lane` is the issue's own resolved lane (#4125). */
export function makePrefilter(opts) {
  // #4315: one identity lookup per batch, and only when a marker comment needs it; #4318: an unresolved one is retried once
  let own = null, tries = 0;
  const selfLogins = opts.selfLogins ?? (() => (own ??= (async () => {
    tries++;
    const r = await resolveOwnLogins(opts.io.gh);
    if (!r.resolved && tries < 2) own = null;
    return r.logins;
  })()));
  return (issue, lane) => prefilterIssue({ ...opts, selfLogins, issue, ...(lane ? { lane } : {}) });
}

/** One report line: how many the pre-filter checked, flagged and closed, what validation cost, and the spend avoided. */
export function formatPrefilterSummary(rows) {
  const pf = rows.filter((r) => r?.prefilter);
  if (!pf.length) return "";
  const closed = pf.filter((r) => r.prefilter.closed);
  const lanes = rows.filter((r) => r && !r.prefilter?.closed && r.outcome === "invalid" && (r.cost_usd ?? 0) > 0);
  const per = lanes.length ? lanes.reduce((a, r) => a + r.cost_usd, 0) / lanes.length : DEFAULT_AVOIDED_USD;
  const spent = pf.reduce((a, r) => a + (r.prefilter.cost_usd ?? 0), 0);
  const ci = closed.filter((r) => r.prefilter.kind === "ci-green").length;
  return `pre-filter: ${pf.length} checked, ${pf.filter((r) => r.prefilter.candidate).length} candidate(s), ${closed.length} closed without a lane (${ci} CI green, ${closed.length - ci} validated); validation $${spent.toFixed(2)}, spend avoided ~$${Math.max(0, closed.length * per - spent).toFixed(2)} (${lanes.length ? "batch invalid-lane average" : "default"} $${per.toFixed(2)}/lane)`;
}

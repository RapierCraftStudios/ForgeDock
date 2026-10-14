// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Already-fixed pre-filter (#4123): cheap checks before any lane starts, so an issue that a merged PR or a later green
 * CI run already resolved does not cost a worktree, a lease and a builder session.
 *   1. merged PRs (and lane commits) that claim to fix #N  -> candidate
 *   2. auto-filed CI-failure issue whose workflow is green again on the failing branch -> closed with the run link
 *   3. every repo path the issue names is gone from origin/<lane> -> candidate
 * A candidate gets ONE read-only, single-turn validation on a small model in the main checkout (no worktree). Only an
 * ALREADY-FIXED/INVALID verdict with evidence closes the issue; everything else, and every error, goes to the normal lane.
 * All effects are injected (gh, git, runner, transitionLabel, projector?) so it is unit-testable.
 */
import { capComment, sanitizeMd } from "./render.mjs";
import { PREFILTER_SYSTEM, prefilterPrompt, parsePrefilterVerdict } from "./prompts.mjs";

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

const PATH_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8})(?::\d+(?:-\d+)?)?(?=$|[\s`'"),.:;\]])/gm;
/** Repo-relative file paths the issue names (`dir/file.ext`, optionally `:line`); URLs and HTML comments are ignored. */
export function namedPaths(text) {
  const s = sanitizeMd(text).replace(/<!--[\s\S]*?-->/g, " ").replace(/\b[a-z]+:\/\/\S+/gi, " ");
  return [...new Set([...s.matchAll(PATH_RE)].map((m) => m[1].replace(/^\.\//, "")).filter((p) => !p.startsWith("/") && !p.startsWith("../")))];
}

/**
 * @returns {Promise<{prs:object[], commits:object[], ci:?object, missingPaths:string[], namedPaths:string[]}>}
 */
export async function collectSignals({ iss, repo, lane, io, cwd }) {
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
        sig.ci = { workflow: failed.name ?? latest.name ?? String(failed.workflow_id), branch, failedUrl: failed.html_url, greenUrl: latest.html_url, greenSha: latest.head_sha ?? "" };
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

/**
 * Pre-filter one issue. Never throws.
 * @returns {Promise<{issue:number, closed:boolean, kind:?string, candidate:boolean, verdict:?string, cost_usd:number, detail:string}>}
 */
export async function prefilterIssue({ issue, repo, lane, cwd, io, model = DEFAULT_PREFILTER_MODEL, dryRun = false, agentId = null, maxMinutes = 5 }) {
  const out = { issue, closed: false, kind: null, candidate: false, verdict: null, cost_usd: 0, detail: "" };
  try {
    const iss = JSON.parse(String(await io.gh(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,labels"])));
    if (String(iss.state).toUpperCase() !== "OPEN") return { ...out, detail: "not open" };
    if ((iss.labels ?? []).some((l) => ["needs-human", "workflow:merged"].includes(l?.name ?? l))) return { ...out, detail: "labelled, left to the lane" };
    if (io.projector) {
      let st = null;
      try { st = await io.projector.readState(issue); } catch { /* unreadable: proceed */ }
      if (st?.lease && st.lease.until > Date.now() && st.lease.by !== agentId) return { ...out, detail: `leased by ${st.lease.by}` };
    }
    const sig = await collectSignals({ iss, repo, lane, io, cwd });
    const close = async (kind, body, detail) => {
      if (!dryRun) {
        await io.gh(["issue", "comment", String(issue), "-R", repo, "--body", capComment(`<!-- ${PREFILTER_MARKER} -->\n<!-- FORGE:VALIDATE -->\n${body}`)]);
        await io.gh(["issue", "close", String(issue), "-R", repo, "--reason", "not planned"]);
        try { await io.transitionLabel?.(issue, "invalid"); } catch { /* labels are best effort */ }
      }
      return { ...out, closed: !dryRun, kind, detail };
    };

    if (sig.ci) {
      out.candidate = true;
      const c = sig.ci;
      return await close("ci-green", `## Pre-filter: CI failure no longer reproduces\n**Workflow:** ${c.workflow} on \`${c.branch}\`\n**Failing run:** ${c.failedUrl}\n**Latest run (green):** ${c.greenUrl}${c.greenSha ? ` at \`${c.greenSha.slice(0, 12)}\`` : ""}\n\nClosed without a lane. Reopen if the failure comes back.`,
        `CI green again: ${c.greenUrl}`);
    }
    if (!sig.prs.length && !sig.commits.length && !sig.missingPaths.length) return { ...out, detail: "no already-fixed signal" };
    out.candidate = true;
    const why = [...sig.prs.map((p) => `PR #${p.number}`), ...sig.commits.map((c) => c.sha.slice(0, 12)), ...(sig.missingPaths.length ? ["named paths missing"] : [])].join(", ");
    if (dryRun) return { ...out, detail: `candidate: ${why}` };
    let r;
    try {
      r = await io.runner({ role: "prefilter", issue, cwd, model, resume: null, system: PREFILTER_SYSTEM, readOnly: true,
        prompt: prefilterPrompt({ issue: iss, lane, signals: sig }), maxMs: Math.round(maxMinutes * 60000) });
    } catch (e) { return { ...out, detail: `validation failed (${String(e?.message ?? e).slice(0, 120)}): lane` }; }
    out.cost_usd = Number.isFinite(r?.costUsd) ? r.costUsd : 0;
    const v = parsePrefilterVerdict(r?.text);
    out.verdict = v?.verdict ?? null;
    if (!v || v.verdict === "CONFIRMED" || !v.evidence.length) return { ...out, detail: `candidate (${why}) ${v ? (v.verdict === "CONFIRMED" ? "confirmed" : "without evidence") : "unparseable verdict"}: lane` };
    const ev = v.evidence.map((x) => `- ${sanitizeMd(x).replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    return await close("validated", `## Pre-filter: ${v.verdict}\n**Signal:** ${why}\n**Summary:** ${sanitizeMd(v.summary).replace(/\s+/g, " ").slice(0, 600) || "not reported"}\n\n**Evidence:**\n${ev}\n\nValidated by a single read-only check (${model}), without a lane. Reopen if this is wrong.`,
      `${v.verdict.toLowerCase()} (${why})`);
  } catch (e) {
    return { ...out, detail: `pre-filter error (${String(e?.message ?? e).slice(0, 120)}): lane` };
  }
}

/** Per-issue hook for `orchestrate({ prefilter })`. */
export function makePrefilter(opts) {
  return (issue) => prefilterIssue({ ...opts, issue });
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

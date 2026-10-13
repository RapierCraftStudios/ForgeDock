// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Core work-on: ONE plain builder session does the work, ONE read-only reviewer answers two questions, and
 * ForgeDock registers everything on GitHub (labels, one register comment, PR, merge). No investigation, synthesis,
 * severity taxonomy, risk tiers or local CI gates. All effects are injected through `io` so it is unit-testable.
 */
import { join } from "node:path";
import { appendEvent } from "../engine/runlog.mjs";
import { codeForTerminalReason, OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { ciPollDelayMs, ENGINE_VERSION } from "../engine.mjs";
import { openDependency } from "../engine/phases.mjs";
import { renderInvestigation, renderPlan, renderImplementation, renderReview, renderPrBody, renderTrajectory, capComment, sanitizeMd } from "./render.mjs";
import { REVIEWER_SYSTEM, LEAN_DIR, RESULT_FILE, INVESTIGATION_FILE, PLAN_FILE, IMPLEMENTATION_FILE, builderPrompt, resumeBuilderPrompt, reviewerPrompt, parseVerdict } from "./prompts.mjs";

export const DEFAULT_REVIEWER_MODEL = "claude-sonnet-5-5";
export const REGISTER_MARKER = "FORGE:WORK-ON"; // alias marker carried by the FORGE:TRAJECTORY comment
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * @param {object} o
 * @param {number} o.issue
 * @param {string} o.repo            "owner/repo"
 * @param {string} o.lane            base branch (staging|main)
 * @param {string} o.cwd             main checkout (worktrees are added from here)
 * @param {string} o.dir             run-log dir
 * @param {object} o.io              injected effects: gh, git, runner, waitCiGreen, transitionLabel, fs, projector?, now?, sleep?
 * @param {string} [o.builderModel]  default: CLI default
 * @param {string} [o.reviewerModel] default claude-sonnet-5-5
 * @param {number} [o.ciMaxMinutes]  remote-CI wait budget (default 360); exhaustion is NOT needs-human
 */
export async function runCore(o) {
  const { issue, repo, lane, cwd, dir, io, builderModel = null, reviewerModel = DEFAULT_REVIEWER_MODEL,
    ciMaxMinutes = 360, mergeWait = "required", onProgress = () => {}, emitTelemetry = null, random = Math.random } = o;
  const now = io.now ?? (() => Date.now());
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = `origin/${lane}`;
  const branch = `feat/issue-${issue}-lean`;
  const wt = join(o.worktreeRoot ?? join(cwd, ".claude", "worktrees"), `lean-${issue}`);
  const t0 = now();
  const usage = { cost_usd: 0, input: 0, output: 0, cache: 0 };
  let sessionId = null;

  const ev = (e) => appendEvent(dir, issue, e);
  const emit = async (rec) => { try { await emitTelemetry?.({ ...rec, issue }); } catch { /* never fails a run */ } };
  const ghc = (args) => io.gh(args);
  const git = (args) => io.git(args, { cwd: wt });

  async function attempt(phase, n, r) {
    const rec = { event: "PHASE_ATTEMPT_USAGE", phase, attempt: n, usage: r?.usage ?? null, duration_ms: num(r?.durationMs) ?? 0,
      cost_usd: num(r?.costUsd), model: r?.model ?? null, turns: num(r?.turns) };
    ev(rec); await emit(rec);
    const u = r?.usage ?? {};
    usage.cost_usd += r?.costUsd ?? 0;
    usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0;
    usage.cache += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  const post = async (marker, body) => {
    const marks = (Array.isArray(marker) ? marker : [marker]).map((m) => `<!-- ${m} -->`).join("\n");
    const out = String(await ghc(["issue", "comment", String(issue), "-R", repo, "--body", capComment(`${marks}\n${body}`)])).trim();
    return /https?:\/\/\S+/.exec(out)?.[0] ?? null;
  };
  const label = async (state) => { try { await io.transitionLabel(issue, state); } catch { /* labels are best effort */ } };
  const usageLine = () => `cost $${usage.cost_usd.toFixed(4)}, tokens ${usage.input} in / ${usage.output} out / ${usage.cache} cache, wall ${Math.round((now() - t0) / 60000 * 10) / 10} min`;

  // ---- lease (same FORGE:STATE lease the full path uses) ----
  const agentId = o.agentId ?? `core_${process.pid}`;
  const leaseTtlMs = o.leaseTtlMs ?? 25 * 60000; // below the projector's 30 min honour cap
  let leaseState = null, leaseTimer = null;
  const writeLease = (lease, extra = {}) => io.projector.writeState(issue, { ...leaseState, ...extra, lease });
  const renew = async () => { if (io.projector && leaseState) { try { await writeLease({ by: agentId, until: now() + leaseTtlMs }); } catch { /* best effort */ } } };
  async function releaseLease(reason) {
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    if (!io.projector || !leaseState) return;
    const terminal = ["merged", "invalid", "needs-human", "engine-error"].includes(reason);
    try { await writeLease(null, terminal ? { terminal: true, terminalReason: reason } : {}); } catch { /* best effort */ }
  }

  // Pipeline trajectory (posted once at the end): phase rows, decisions, anomalies.
  const T = { issue, validate: null, plan: null, implement: null, review: null, pr: null, merge: null, close: null, decisions: [], anomalies: [] };
  let done = null, wtCreated = false;
  async function finish(reason, detail = "", extra = {}, codeOverride = null) {
    if (done) return done; // idempotent: exactly one RUN_TERMINAL and one telemetry emit
    const code = codeOverride ?? codeForTerminalReason(reason);
    ev({ event: "RUN_TERMINAL", reason, code });
    await emit({ event: "RUN_TERMINAL", reason, code });
    if (["needs-human", "engine-error"].includes(reason)) {
      const wf = ["investigating", "building", "in-review"].map((x) => `workflow:${x}`).join(",");
      try { await ghc(["issue", "edit", String(issue), "-R", repo, "--remove-label", wf]); } catch { /* best effort */ }
    }
    if (["merged", "invalid", "needs-human"].includes(reason)) {
      if (reason === "merged") T.close = ["issue closed (completed)", "label workflow:merged"];
      else if (reason === "invalid") T.close = ["issue closed (not planned)", "label workflow:invalid"];
      else { T.close = ["left open", "label needs-human"]; T.anomalies.push(`needs-human: ${String(detail).split("\n")[0].slice(0, 300)}`); }
      try { await post(["FORGE:TRAJECTORY", REGISTER_MARKER], renderTrajectory({ ...T, usage: usageLine() })); } catch { /* best effort */ }
    }
    await releaseLease(reason);
    if (wtCreated) {
      try { await io.git(["worktree", "remove", "--force", wt], { cwd }); } catch { /* best effort */ }
      if (reason === "invalid" && !extra.pr) { try { await io.git(["branch", "-D", branch], { cwd }); } catch { /* best effort */ } }
    }
    done = { terminalReason: reason, detail, branch, worktree: wt, cost_usd: usage.cost_usd, tokens: { input: usage.input, output: usage.output, cache: usage.cache }, wall_ms: now() - t0, ...extra };
    return done;
  }
  async function needsHuman(why, code = OUTCOME_CODES.ENGINE_ERROR) {
    try {
      await post("FORGE:NEEDS_HUMAN", `## Needs human\n${why}\n\n_${usageLine()}_`);
      await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]);
    } catch { /* best effort */ }
    return finish("needs-human", why, { code }, code);
  }

  // ---- stage notes: investigation.md, plan.md, implementation.md become their own comments ----
  const STAGES = [
    { key: "investigation", file: INVESTIGATION_FILE, marker: ["FORGE:INVESTIGATION", "FORGE:VALIDATE"], render: (md, ctx) => renderInvestigation(md, ctx.result) },
    { key: "plan", file: PLAN_FILE, marker: ["FORGE:PLAN"], render: (md, ctx) => renderPlan(md, ctx.result, ctx.files) },
    { key: "implementation", file: IMPLEMENTATION_FILE, marker: ["FORGE:IMPLEMENTATION"], render: (md, ctx) => renderImplementation(md, ctx.result, { branch, files: ctx.files }) },
  ];
  const posted = {}; // key -> comment url (or "" when posted without a link)
  const readStage = async (st) => { try { return await io.fs.read(`${wt}/${st.file}`); } catch { return null; } };
  const usableMd = (md) => sanitizeMd(md).replace(/\s+/g, " ").length >= 20;
  const stageFiles = async () => {
    const out = String(await git(["diff", "--name-only", `${base}...HEAD`]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean);
    if (out.length) return out;
    return String(await git(["diff", "--name-only", "HEAD"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean);
  };
  async function postStage(st, result, md) {
    const files = st.key === "implementation" ? await stageFiles() : [];
    const url = await post(st.marker, st.render(md, { result, files }));
    posted[st.key] = url ?? "";
  }
  /** Post stage notes in order that exist, are stable (mtime unchanged for stableMs) and not yet posted. */
  const seen = {};
  async function livePoll() {
    for (const st of STAGES) {
      if (st.key in posted) continue;
      let m = null;
      try { m = await io.fs.stat(`${wt}/${st.file}`); } catch { m = null; }
      if (!m) return;
      const e = seen[st.key];
      if (!e || e.mtime !== m.mtimeMs) { seen[st.key] = { mtime: m.mtimeMs, since: Date.now() }; return; }
      if (Date.now() - e.since < (o.stableMs ?? 2000)) return;
      const md = await readStage(st);
      if (!usableMd(md)) return;
      try { await postStage(st, null, md); } catch { return; }
    }
  }
  /** Post whatever was not posted live, in order; a missing file falls back to the result.json fields. */
  async function flushStages(result, keys) {
    for (const st of STAGES) {
      if (!keys.includes(st.key) || st.key in posted) continue;
      const md = await readStage(st);
      if (!usableMd(md)) {
        if (!result && st.key === "investigation") continue; // nothing to render
        T.anomalies.push(`${st.file} missing or empty: rendered from result.json`);
      }
      await postStage(st, result, md);
    }
  }

  async function builder(n, prompt, resume, live = false) {
    onProgress({ event: "phase_enter", phase: "build" });
    await renew();
    const call = Promise.resolve(io.runner({ role: "builder", issue, cwd: wt, model: builderModel, resume, system: "", prompt }));
    let r;
    if (live && io.fs.stat) {
      let settled = false;
      const tracked = call.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
      tracked.catch(() => {});
      while (!settled) {
        let t;
        await Promise.race([tracked.catch(() => {}), new Promise((res) => { t = setTimeout(res, o.livePollMs ?? 1000); })]);
        clearTimeout(t);
        if (!settled) { try { await livePoll(); } catch { /* live posting is best effort */ } }
      }
      r = await tracked;
    } else r = await call;
    await renew();
    if (r?.sessionId) sessionId = r.sessionId;
    await attempt("implement", n, r);
    onProgress({ event: "phase_exit", phase: "build", status: "committed" });
    return r;
  }
  const readResult = async () => { try { const j = JSON.parse(await io.fs.read(`${wt}/${RESULT_FILE}`)); return j && typeof j === "object" ? j : null; } catch { return null; } };

  // ---- admission: Depends-on refusal, then lease ----
  {
    let dep = null;
    try { dep = await openDependency(issue, io); } catch (e) { dep = { unreadable: true, detail: `issue ${issue} **Depends on** check failed: ${e?.message || e}` }; }
    if (dep?.unreadable) return { terminalReason: "dependency-unreadable", code: OUTCOME_CODES.DEPENDENCY_UNREADABLE, detail: dep.detail };
    if (dep?.open?.length) {
      return { terminalReason: "dependency-open", code: OUTCOME_CODES.DEPENDENCY_OPEN, dependencies: dep.open,
        detail: `issue ${issue} **Depends on** ${dep.open.map((n) => `#${n}`).join(", ")} which is still open; re-run once it is closed` };
    }
  }
  if (io.projector) {
    let st = null;
    try { st = await io.projector.readState(issue); } catch { /* unreadable: proceed */ }
    if (st?.lease && st.lease.until > now() && st.lease.by !== agentId) {
      return { terminalReason: "deferred", code: "lease-held", detail: `issue ${issue} leased by ${st.lease.by} until ${new Date(st.lease.until).toISOString()}`, branch, worktree: wt };
    }
    leaseState = { ...(st ?? { v: 1, run: `core_${issue}`, issue, lane, committed: [], phase: null, branch: null, pr: null, terminalReason: null }), terminal: false };
    try { await writeLease({ by: agentId, until: now() + leaseTtlMs }); } catch { /* best effort */ }
    leaseTimer = setInterval(() => { writeLease({ by: agentId, until: now() + leaseTtlMs }).catch(() => {}); }, o.leaseRenewMs ?? 120000);
    leaseTimer.unref?.();
  }

  ev({ event: "RUN_START", run: `core_${issue}_${t0}`, issue, lane, path: "core", version: ENGINE_VERSION, forge_version: ENGINE_VERSION, repo });
  let iss;
  try {
    iss = JSON.parse(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state"]));
  } catch (e) { return finish("engine-error", `cannot read issue: ${e.message}`); }
  if (String(iss.state).toUpperCase() === "CLOSED") return finish("invalid", "issue already closed");

  try {
    // ---- 1. claim ----
    await label("investigating");
    await post("FORGE:STARTED", `Started work on #${issue} (base \`${lane}\`).`);

    // ---- 2. worktree (resume an open PR / remote branch) ----
    try { await io.git(["fetch", "origin", lane], { cwd }); } catch { /* offline: use the local ref */ }
    let resumed = null;
    try {
      const prs = JSON.parse(String(await ghc(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number,headRefOid"])) || "[]");
      const remote = String(await io.git(["ls-remote", "--heads", "origin", branch], { cwd })).trim();
      if (prs.length || remote) resumed = { pr: prs[0]?.number ?? null };
    } catch { /* no resume info: start fresh */ }
    try { await io.git(["worktree", "remove", "--force", wt], { cwd }); } catch { /* none */ }
    try { await io.git(["worktree", "prune"], { cwd }); } catch { /* best effort */ }
    if (resumed) {
      await io.git(["fetch", "origin", branch], { cwd });
      await io.git(["worktree", "add", "-B", branch, wt, `origin/${branch}`], { cwd });
    } else {
      await io.git(["worktree", "add", "-B", branch, wt, base], { cwd });
    }
    wtCreated = true;
    const excl = String(await git(["rev-parse", "--git-path", "info/exclude"])).trim();
    await io.fs.append(excl.startsWith("/") ? excl : `${wt}/${excl}`, `\n${LEAN_DIR}/\n`);
    const changedFiles = async () => String(await git(["diff", "--name-only", `${base}...HEAD`])).split("\n").map((s) => s.trim()).filter(Boolean);

    // ---- 3. builder ----
    let result = null, attemptN = 0, reviewN = 0;
    if (!(resumed && (await changedFiles()).length > 0)) {
      await label("building");
      await builder(++attemptN, builderPrompt(issue), null, true);
      result = await readResult();
      const files0 = await changedFiles();
      const evidence = (Array.isArray(result?.evidence) ? result.evidence : []).filter((x) => typeof x === "string" && x.trim());
      const closing = ["invalid", "already-fixed"].includes(result?.status);
      await flushStages(result, ["investigation"]); // first stage note: the evidence comment for invalid/already-fixed
      T.validate = [result ? (result.status === "fixed" ? "CONFIRMED" : String(result.status).toUpperCase()) : "no result.json", `${evidence.length} evidence item(s)`];
      T.decisions.push(`Builder verdict: ${result?.status ?? "none"}`);
      if (closing && !evidence.length) return await needsHuman(`Builder reported "${result.status}" without evidence, so the issue is not closed automatically.\n\n${result.summary ?? "(no summary)"}`, OUTCOME_CODES.BUILDER_NO_EVIDENCE);
      if (closing) {
        T.plan = "skipped"; T.implement = "skipped"; T.review = "skipped"; T.pr = "none"; T.merge = "n/a";
        await ghc(["issue", "close", String(issue), "-R", repo, "--reason", "not planned"]);
        await label("invalid");
        return await finish("invalid", result.summary ?? result.status);
      }
      if (result?.status === "blocked") return await needsHuman(`Builder is blocked: ${result.summary ?? "(no summary)"}`, OUTCOME_CODES.BUILDER_BLOCKED);
      if (!files0.length) return await needsHuman(`Builder made no commit${result ? ` (status "${result.status}")` : " and wrote no result.json"}.\n\n${result?.summary ?? ""}`, OUTCOME_CODES.BUILDER_NO_COMMIT);
      await flushStages(result, ["plan", "implementation"]);
      T.plan = "posted"; T.implement = [`${files0.length} file(s)`, branch];
    } else {
      T.validate = "resumed (existing branch)"; T.plan = "skipped (resumed)"; T.implement = ["existing commits", branch];
      T.decisions.push("Open PR or remote branch found: builder skipped, reviewing existing commits");
    }

    // ---- 4. review (one retry through the same builder session) ----
    await label("in-review");
    let review = null;
    const doReview = async () => {
      for (let t = 0; t < 2; t++) {
        const diff = String(await git(["diff", `${base}...HEAD`]));
        await renew();
        const rr = await io.runner({ role: "reviewer", issue, cwd: wt, model: reviewerModel, resume: null, system: REVIEWER_SYSTEM, readOnly: true,
          prompt: reviewerPrompt({ issue: iss, diff }) });
        await renew();
        await attempt("review", ++reviewN, rr);
        const v = parseVerdict(rr?.text);
        if (v) return v;
      }
      return null;
    };
    review = await doReview();
    if (!review) return await needsHuman("Reviewer returned no parseable verdict twice.", OUTCOME_CODES.REVIEW_NO_VERDICT);
    if (review.fail) {
      if (!sessionId) return await needsHuman(`Review FAIL and the builder session id is unknown, cannot resume: ${review.reason}`, OUTCOME_CODES.REVIEW_FAILED);
      T.decisions.push(`Review FAIL (round 1): builder resumed with the reason: ${String(review.reason).slice(0, 200)}`);
      await builder(++attemptN, resumeBuilderPrompt(review.reason), sessionId);
      result = (await readResult()) ?? result;
      review = await doReview();
      if (!review) return await needsHuman("Reviewer returned no parseable verdict twice (re-review).", OUTCOME_CODES.REVIEW_NO_VERDICT);
      if (review.fail) return await needsHuman(`Review FAIL twice. Last reason: ${review.reason}`, OUTCOME_CODES.REVIEW_FAILED);
    }
    T.review = [review.verdict, `${reviewN} reviewer run(s), ${attemptN > 1 ? "2 rounds" : "1 round"}`];
    await post("FORGE:REVIEW", renderReview(review));
    ev({ event: "PHASE_COMMIT", phase: "review" });

    // ---- 5. push + PR ----
    const files = await changedFiles();
    await git(["push", "-u", "origin", branch]);
    const prOut = resumed?.pr ? `/pull/${resumed.pr}` : String(await ghc(["pr", "create", "-R", repo, "--base", lane, "--head", branch,
      "--title", `${iss.title} (#${issue})`, "--body", renderPrBody({ issue, investigation: await readStage(STAGES[0]), plan: await readStage(STAGES[1]), implementation: await readStage(STAGES[2]), result, gitFiles: files })])).trim();
    const pr = Number(/\/pull\/(\d+)/.exec(prOut)?.[1] ?? /(\d+)\s*$/.exec(prOut)?.[1]);
    if (!Number.isInteger(pr)) return await needsHuman(`Could not parse the PR number from: ${prOut.slice(0, 200)}`);
    ev({ event: "PR_OPENED", pr });
    T.pr = [`#${pr}`, resumed?.pr ? "existing" : "opened"];
    const prUrl = /https?:\/\/\S+/.exec(prOut)?.[0] ?? `https://github.com/${repo}/pull/${pr}`;
    const localHead = String(await git(["rev-parse", "HEAD"])).trim();

    // ---- 6. the register comment ----
    // merge policy: required (default) | all | none
    let policy = mergeWait, required = [];
    if (mergeWait === "required") {
      try { required = (await io.requiredChecks?.(lane)) ?? []; } catch { required = []; }
    }
    const policyText = mergeWait === "required" ? (required.length ? `required (${required.join(", ")})` : "required (no required checks: merged right after review)") : mergeWait;
    T.merge = [policyText, "waiting"];
    T.decisions.push(`merge_wait=${mergeWait}: ${policyText}`);

    // ---- 7. wait per policy, merge at the reviewed head ----
    if (policy === "none" || (policy === "required" && !required.length)) {
      // merge right after review
      T.merge = [policyText, "merged right after review"];
    } else {
      const startedAt = now();
      let pollIndex = 0, gateHead = null;
      for (;;) {
        await renew();
        if (policy === "all") {
          const w = await io.waitCiGreen(pr, repo, 0).catch(() => ({ rc: 2, text: "" }));
          if (w.rc === 0) { gateHead = /CI_GATE_HEAD:\s*([0-9a-f]{7,40})/.exec(w.text ?? "")?.[1] ?? null; break; }
          if (w.rc === 1) return await needsHuman(`Remote CI failed on PR #${pr}:\n${String(w.text).slice(-2000)}`, OUTCOME_CODES.CI_RED);
        } else {
          let states = [];
          try { states = (await io.checkStates(pr)) ?? []; } catch { states = []; }
          const st = (n) => states.find((x) => x.name === n)?.state ?? "pending";
          const failed = required.filter((n) => st(n) === "failure");
          if (failed.length) return await needsHuman(`Required check(s) failed on PR #${pr}: ${failed.join(", ")}`, OUTCOME_CODES.CI_RED);
          if (required.every((n) => st(n) === "success")) break;
        }
        if (now() - startedAt >= ciMaxMinutes * 60000) {
          // Slow CI is never a needs-human: leave the PR open and resumable.
          ev({ event: "CI_PENDING_WAIT", state: "end", pr, result: "timeout" });
          T.anomalies.push("CI still pending at the wait budget");
          return await finish("ci-pending", `PR #${pr} still waiting on CI after ${ciMaxMinutes} min`, { pr });
        }
        onProgress({ event: "phase_paused", phase: "merge", detail: `CI pending on PR #${pr}` });
        await sleep(ciPollDelayMs(pollIndex++, random));
      }
      if (gateHead && !(localHead.startsWith(gateHead) || gateHead.startsWith(localHead))) {
        return await needsHuman(`CI passed for ${gateHead.slice(0, 12)} but the reviewed head is ${localHead.slice(0, 12)}; refusing to merge an unreviewed head.`, OUTCOME_CODES.MERGE_HEAD_MISMATCH);
      }
    }
    T.merge = [policyText, `merged at ${localHead.slice(0, 12)}`];
    await ghc(["pr", "merge", String(pr), "-R", repo, "--merge", "--match-head-commit", localHead]);
    await ghc(["issue", "close", String(issue), "-R", repo, "--reason", "completed"]).catch(() => {});
    await label("merged");
    return await finish("merged", `PR #${pr}`, { pr });
  } catch (e) {
    return finish("engine-error", e?.message ?? String(e));
  }
}

export const runLean = runCore;

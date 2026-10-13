// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lean path (#4081): validate -> architect -> implement in ONE warm builder session, deterministic gates,
 * one independent reviewer (plus a security reviewer on risky paths), then deterministic merge and close.
 * Every stage is posted to the issue as a structured FORGE:* comment. All effects are injected through `io`
 * (gh, git, runner, ciLocal, waitCiGreen, transitionLabel, fs, sleep) so the module is fully unit-testable.
 */
import { join } from "node:path";
import { appendEvent } from "../engine/runlog.mjs";
import { codeForTerminalReason } from "../engine/outcome-codes.mjs";
import { ciPollDelayMs } from "../engine.mjs";
import { riskTier, isDocsOnly, isTestFile, isLargeDiff, isBlocking, parseFindings } from "./risk.mjs";
import { BUILDER_SYSTEM, REVIEWER_SYSTEM, SECURITY_REVIEWER_SYSTEM, LEAN_DIR, builderPrompt, resumeGatePrompt, resumeReviewPrompt, reviewerPrompt } from "./prompts.mjs";

export const MAX_ROUNDS = 2;
export const DEFAULT_REVIEWER_MODEL = "claude-sonnet-5-5";
const NS = "lean";

const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * @param {object} o
 * @param {number} o.issue
 * @param {string} o.repo            "owner/repo"
 * @param {string} o.lane            base branch (staging|main)
 * @param {string} o.cwd             main checkout (worktrees are added from here)
 * @param {string} o.dir             run-log dir
 * @param {object} o.io              injected effects
 * @param {"lean"|"auto"} [o.path]
 * @param {string} [o.builderModel]  default: CLI default
 * @param {string} [o.reviewerModel] default claude-sonnet-5-5
 * @param {number} [o.ciMaxMinutes]  remote-CI wait budget (default 360); exhaustion is NOT needs-human
 */
export async function runLean(o) {
  const { issue, repo, lane, cwd, dir, io, path = "lean", builderModel = null, reviewerModel = DEFAULT_REVIEWER_MODEL,
    ciMaxMinutes = 360, onProgress = () => {}, emitTelemetry = null, random = Math.random } = o;
  const now = io.now ?? (() => Date.now());
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = `origin/${lane}`;
  const branch = `feat/issue-${issue}-lean`;
  const wt = join(o.worktreeRoot ?? join(cwd, ".claude", "worktrees"), `lean-${issue}`);
  const t0 = now();
  const links = {};
  let sessionId = null;
  const usageTotal = { cost_usd: 0 };

  const ev = (e) => appendEvent(dir, issue, e);
  const emit = async (rec) => { try { await emitTelemetry?.({ ...rec, issue }); } catch { /* never fails a run */ } };
  const ghc = (args) => io.gh(args);
  const git = (args) => io.git(args, { cwd: wt });
  const file = (n) => `${wt}/${LEAN_DIR}/${n}`;

  async function attempt(phase, n, r) {
    const rec = { event: "PHASE_ATTEMPT_USAGE", phase, attempt: n, usage: r?.usage ?? null, duration_ms: num(r?.durationMs) ?? 0,
      cost_usd: num(r?.costUsd), model: r?.model ?? null, turns: num(r?.turns) };
    ev(rec); await emit(rec);
    usageTotal.cost_usd += r?.costUsd ?? 0;
  }
  async function commit(phase) { ev({ event: "PHASE_COMMIT", phase }); onProgress({ event: "phase_exit", phase, status: "committed" }); }

  async function post(marker, title, body, attrs = "") {
    const text = `<!-- ${marker} ${NS} v1${attrs} -->\n## ${marker}\n${title ? `${title}\n\n` : ""}${body}`;
    const out = String(await ghc(["issue", "comment", String(issue), "-R", repo, "--body", text])).trim();
    const url = /https?:\/\/\S+/.exec(out)?.[0] ?? null;
    if (url) (links[marker] ??= []).push(url);
    return url;
  }

  async function finish(reason, detail = "", extra = {}) {
    const code = codeForTerminalReason(reason);
    ev({ event: "RUN_TERMINAL", reason, code });
    await emit({ event: "RUN_TERMINAL", reason, code });
    return { terminalReason: reason, detail, branch, worktree: wt, cost_usd: usageTotal.cost_usd, wall_ms: now() - t0, ...extra };
  }
  async function needsHuman(why) {
    try { await post("FORGE:NEEDS_HUMAN", "", why); await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]); } catch { /* best effort */ }
    return finish("needs-human", why);
  }
  async function label(state) { try { await io.transitionLabel(issue, state); } catch { /* labels are best effort */ } }

  async function builder(phase, n, prompt, resume) {
    onProgress({ event: "phase_enter", phase });
    const r = await io.runner({ role: "builder", issue, cwd: wt, model: builderModel, resume,
      system: resume ? "" : BUILDER_SYSTEM, prompt });
    if (r?.sessionId) sessionId = r.sessionId;
    return r;
  }
  const readJson = async (n) => { try { return JSON.parse(await io.fs.read(file(n))); } catch { return null; } };

  ev({ event: "RUN_START", run: `lean_${issue}_${t0}`, issue, lane, path: "lean" });
  let iss;
  try {
    iss = JSON.parse(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state"]));
  } catch (e) { return finish("engine-error", `cannot read issue: ${e.message}`); }
  if (String(iss.state).toUpperCase() === "CLOSED") return finish("invalid", "issue already closed");

  try {
    await label("investigating");
    try { await io.git(["fetch", "origin", lane], { cwd }); } catch { /* offline: use the local ref */ }
    await io.git(["worktree", "add", "-b", branch, wt, base], { cwd });
    const excl = String(await git(["rev-parse", "--git-path", "info/exclude"])).trim();
    await io.fs.append(excl.startsWith("/") ? excl : `${wt}/${excl}`, `\n${LEAN_DIR}/\n`);

    // ---- builder: validate + architect + implement in one session ----
    let r = await builder("validate", 1, builderPrompt({ issue: iss, base: lane, branch }), null);
    const validate = await readJson("validate.json");
    await attempt("validate", 1, r);
    if (!validate) return await needsHuman("builder did not write validate.json");
    await post("FORGE:VALIDATE", `**Status:** ${validate.status}`, "```json\n" + JSON.stringify(validate, null, 2) + "\n```");
    if (validate.status !== "valid") {
      await commit("validate");
      await ghc(["issue", "close", String(issue), "-R", repo, "--reason", "not planned"]);
      await label("invalid");
      return await finish("invalid", validate.summary ?? validate.status);
    }
    await commit("validate");
    await label("building");

    const planMd = await io.fs.read(file("plan.md")).catch(() => null);
    await attempt("architect", 1, null);
    if (!planMd) return await needsHuman("builder did not write plan.md");
    await post("FORGE:PLAN", "", planMd);
    await commit("architect");

    let implRound = 1;
    const postImpl = async () => {
      const impl = await readJson("implement.json");
      await post("FORGE:IMPLEMENT", impl ? `**Round:** ${implRound}` : "**implement.json missing**", "```json\n" + JSON.stringify(impl ?? {}, null, 2) + "\n```", ` round=${implRound}`);
      return impl;
    };
    let impl = await postImpl();
    await attempt("implement", 1, null);
    await commit("implement");

    // ---- deterministic gates, resuming the same session on failure ----
    const diffStats = async () => {
      const files = String(await git(["diff", "--name-only", `${base}...HEAD`])).split("\n").map((s) => s.trim()).filter(Boolean);
      let lines = 0;
      for (const l of String(await git(["diff", "--numstat", `${base}...HEAD`])).split("\n")) {
        const [a, d] = l.split("\t"); lines += (Number(a) || 0) + (Number(d) || 0);
      }
      return { files, lines };
    };
    const gateFailure = async () => {
      const { files } = await diffStats();
      if (files.length === 0) return { kind: "no-commit", tail: "No commit on the branch relative to the base. Commit your change." };
      if (!(await readJson("implement.json"))) return { kind: "implement-json", tail: `${LEAN_DIR}/implement.json is missing or invalid JSON.` };
      if (!isDocsOnly(files) && !files.some(isTestFile)) {
        return { kind: "missing-test", tail: "No test file changed. Add a regression test that fails without the fix (and passes with it)." };
      }
      const ci = await io.ciLocal({ cwd: wt, base });
      if (ci.result === "FAIL") return { kind: "ci-local", tail: ci.tail ?? "" };
      return null;
    };
    let gateRounds = 0;
    const runGates = async () => {
      for (;;) {
        const f = await gateFailure();
        if (!f) return true;
        if (gateRounds >= MAX_ROUNDS) { await needsHuman(`gate ${f.kind} still failing after ${MAX_ROUNDS} resume rounds:\n\n${String(f.tail).slice(-3000)}`); return false; }
        gateRounds++; implRound++;
        if (!sessionId) { await needsHuman(`gate ${f.kind} failed and the builder session id is unknown, cannot resume`); return false; }
        const rr = await builder("implement", implRound, resumeGatePrompt(f), sessionId);
        await attempt("implement", implRound, rr);
        await postImpl();
      }
    };
    if (!(await runGates())) return await finish("needs-human", "gates");

    // ---- auto path: risky AND large escalates to the full pipeline ----
    const st = await diffStats();
    const risk = riskTier(st.files, `${iss.title}\n${iss.body ?? ""}`);
    if (path === "auto" && risk.tier === "high" && isLargeDiff({ files: st.files.length, lines: st.lines })) {
      await post("FORGE:ROUTE", "", `Risk tier high (${risk.reasons.slice(0, 5).join(", ")}) and diff large (${st.files.length} files, ${st.lines} lines): routing to the full pipeline.`);
      return await finish("route-full", "risk high and diff large");
    }

    // ---- review loop ----
    await label("in-review");
    let reviewRound = 0, reviewedHead = null, prior = null, reviewAttempt = 0;
    const review = async (role, system, delta) => {
      for (let tryN = 0; tryN < 2; tryN++) {
        const diff = String(await git(["diff", delta ? `${reviewedHead}..HEAD` : `${base}...HEAD`]));
        const rr = await io.runner({ role, issue, cwd: wt, model: reviewerModel, resume: null, system,
          prompt: reviewerPrompt({ issue: iss, plan: planMd, diff, prior, delta }) });
        await attempt("review", ++reviewAttempt, rr);
        const f = parseFindings(rr?.text);
        if (f) return f.map((x) => ({ ...x, reviewer: role }));
      }
      return null;
    };
    for (;;) {
      const head = String(await git(["rev-parse", "HEAD"])).trim();
      const delta = reviewedHead !== null;
      const roles = [["reviewer", REVIEWER_SYSTEM]];
      if (risk.tier === "high") roles.push(["security-reviewer", SECURITY_REVIEWER_SYSTEM]);
      const all = [];
      for (const [role, system] of roles) {
        const f = await review(role, system, delta);
        if (f === null) return await needsHuman(`${role} returned no parseable findings twice`);
        all.push(...f);
      }
      reviewedHead = head;
      const blocking = all.filter(isBlocking);
      const notes = all.filter((x) => !isBlocking(x));
      const row = (x) => `- **${x.severity}/${x.confidence}** ${x.file ?? "?"}:${x.line ?? "?"} (${x.scope ?? "introduced"}, ${x.reviewer}) ${x.title ?? ""}${x.failure_scenario ? ` — ${x.failure_scenario}` : ""}`;
      await post("FORGE:REVIEW", `**Verdict:** ${blocking.length ? "BLOCKING" : "APPROVED"} | round ${reviewRound} | reviewed ${head.slice(0, 12)}${delta ? " (delta)" : ""} | risk ${risk.tier}`,
        `### Blocking (${blocking.length})\n${blocking.map(row).join("\n") || "none"}\n\n### Notes (${notes.length}, not filed as issues)\n${notes.map(row).join("\n") || "none"}\n\n\`\`\`json\n${JSON.stringify(all, null, 2)}\n\`\`\``);
      await commit("review");
      if (!blocking.length) break;
      if (reviewRound >= MAX_ROUNDS) return await needsHuman(`${blocking.length} blocking finding(s) after ${MAX_ROUNDS} fix rounds`);
      if (!sessionId) return await needsHuman("blocking findings and the builder session id is unknown, cannot resume");
      reviewRound++; implRound++; prior = blocking;
      const rr = await builder("implement", implRound, resumeReviewPrompt({ findings: blocking }), sessionId);
      await attempt("implement", implRound, rr);
      await postImpl();
      if (!(await runGates())) return await finish("needs-human", "gates after review fix");
    }

    // ---- merge and close (no model) ----
    await git(["push", "-u", "origin", branch]);
    const final = await diffStats();
    const linkLines = Object.entries(links).map(([k, v]) => `- ${k}: ${v.join(", ")}`).join("\n");
    const prOut = String(await ghc(["pr", "create", "-R", repo, "--base", lane, "--head", branch,
      "--title", `${(validate.title ?? iss.title)} (#${issue})`,
      "--body", `Closes #${issue}\n\nLean path run. Knowledge graph:\n${linkLines}\n\nFiles: ${final.files.length}, lines: ${final.lines}`])).trim();
    const pr = Number(/\/pull\/(\d+)/.exec(prOut)?.[1] ?? /(\d+)\s*$/.exec(prOut)?.[1]);
    if (!Number.isInteger(pr)) return await needsHuman(`could not parse PR number from: ${prOut.slice(0, 200)}`);
    ev({ event: "PR_OPENED", pr });

    const startedAt = now();
    let pollIndex = 0, gateHead = null;
    for (;;) {
      const w = await io.waitCiGreen(pr, repo, 0).catch(() => ({ rc: 2, text: "" }));
      if (w.rc === 0) { gateHead = /CI_GATE_HEAD:\s*([0-9a-f]{7,40})/.exec(w.text ?? "")?.[1] ?? null; break; }
      if (w.rc === 1) return await needsHuman(`remote CI failed on PR #${pr}:\n${String(w.text).slice(-2000)}`);
      if (now() - startedAt >= ciMaxMinutes * 60000) {
        // Slow CI is never a needs-human: leave the PR open and resumable.
        ev({ event: "CI_PENDING_WAIT", state: "end", pr, result: "timeout" });
        return await finish("ci-pending", `PR #${pr} still waiting on CI after ${ciMaxMinutes} min`, { pr });
      }
      onProgress({ event: "phase_paused", phase: "merge", detail: `CI pending on PR #${pr}` });
      await sleep(ciPollDelayMs(pollIndex++, random));
    }
    const localHead = String(await git(["rev-parse", "HEAD"])).trim();
    await ghc(["pr", "merge", String(pr), "-R", repo, "--merge", "--match-head-commit", gateHead ?? localHead]);
    await post("FORGE:CLOSE", "", `Merged PR #${pr} at ${(gateHead ?? localHead).slice(0, 12)}.\n\n- Review rounds: ${reviewRound}\n- Gate rounds: ${gateRounds}\n- Cost: $${usageTotal.cost_usd.toFixed(4)}\n- Wall: ${Math.round((now() - t0) / 1000)}s\n${linkLines}`);
    await ghc(["issue", "close", String(issue), "-R", repo, "--reason", "completed"]).catch(() => {});
    await label("merged");
    return await finish("merged", `PR #${pr}`, { pr });
  } catch (e) {
    return finish("engine-error", e?.message ?? String(e));
  }
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Review and fix steps of `forgedock release` (#5208 part 2, #5212). `reviewStep` runs the staging panel the way an operator
 * session would (commands/review-pr-staging.md) but as one job: pre-dispatch, one isolated runner session per brief plus the
 * spec-owned panel, the /test-gate output, a head check (a moved head is a `--delta` pass, never a finalize), finalize with
 * one re-ask of reviewers whose findings block is missing, filing, NOTEs in the PR body, then `--summary`. `fixStep` starts a
 * fix lane per blocking finding on the staging branch and re-reviews the delta, bounded like lanes. Every effect goes through
 * a seam (`ctx.io.review`, default `realSeam`) so the steps are unit-tested without gh, git or a model.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHostPreflight } from "./release-preflight.mjs";
import { reviewStagingJson, reviewStagingIo, CI_EXCLUDED_CHECKS } from "../review-staging.mjs";
import { pickFixes, recut } from "./release-snapshot.mjs";

/** Delta passes after a head move, and fix-lane rounds: past either the job blocks for the manual path. */
export const MAX_DELTA_PASSES = 2;
export const MAX_FIX_ROUNDS = 2;
const REVIEW_MS = 45 * 60_000, LANE_MS = 3 * 60 * 60_000;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SEVERE = new Set(["CRITICAL", "HIGH"]);
const MANUAL = "use the manual path: forgedock review-staging <PR> (commands/review-pr-staging.md)";
const blocked = (why) => ({ blocked: true, reason: `${why}; ${MANUAL}` });

/**
 * scripts/issue-create.sh (programmatic mode) refuses a body file without exactly one `FORGE:BODY-INTEGRITY` marker, so a
 * finding body gets one appended unless it already carries exactly one. The id is reduced to the marker's allowed chars.
 */
export function withIntegrityMarker(body, id) {
  const text = String(body ?? "");
  const n = (text.match(/<!-- FORGE:BODY-INTEGRITY:[^>]+ -->/g) ?? []).length;
  if (n === 1) return text;
  const clean = text.replace(/<!-- FORGE:BODY-INTEGRITY:[^>]+ -->\n?/g, "").trimEnd();
  const tag = String(id ?? "finding").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "finding";
  return `${clean}\n\n<!-- FORGE:BODY-INTEGRITY:${tag} -->\n`;
}

/** Reviewers whose prompts are prose in the spec (not briefed by the pre-dispatch): marker domain -> spec phase. */
export const SPEC_PANEL = [
  { domain: "material-change", phase: "Phase 2 (material-change)" },
  { domain: "bug-hunter-general", phase: "Phase 3 (bug hunters)" },
  { domain: "code-quality", phase: "Phase 4 (code-quality)" },
  { domain: "regression-risk", phase: "Phase 6 (regression-risk)" },
];

const specPrompt = (p, m, def) => [
  `You are the ${p.domain} reviewer of the staging -> ${def} release review of PR #${m.pr}, head ${m.headSha}.`,
  `Read commands/review-pr-staging.md, ${p.phase}, and do exactly what that phase asks for this PR (bundle PRs: ${(m.bundle ?? []).join(" ") || "none"}; scope mode ${m.scopeMode}; the scope lists are in ${m.pr}_scope.json next to ${m.contextFile}).`,
  `Post your own comment on the PR with \`gh pr comment\`: it starts with \`<!-- FORGE:REVIEW-AGENT:${p.domain} -->\`, then the line \`Reviewed-SHA: ${m.headSha}\`, and ends with the structured findings block (REVIEW-FINDINGS-START/END, FINDING markers; an empty block when nothing is found).`,
  "Read-only git rule: never checkout, switch, reset, stash or merge in the shared checkout.",
].join("\n\n");

/** `Reviewers` named by a finalize stop: delivery (`missing findings comment(s) for: a b`) or extract (`no structured findings block from: a, b.`). */
export function missingReviewers(lines) {
  const t = (lines ?? []).join("\n");
  const m = /missing findings comment\(s\) for:\s*([^\n]+)/.exec(t) ?? /no structured findings block from:\s*([^\n]+?)\.?(?:\s+Re-dispatch|\n|$)/.exec(t);
  return m ? m[1].split(/[\s,]+/).filter((d) => /^[a-z0-9-]+$/.test(d)) : [];
}
/** A reviewer session's failure as one line: exit status and the last lines of what it said. */
const sessionFailure = (e) => {
  const out = String(e?.stderr || e?.message || e || "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  return `exit ${e?.code ?? e?.status ?? e?.exitCode ?? "?"}: ${out}`;
};
const failureNote = (failures) => (failures.size ? `; session failures: ${[...failures].map(([d, f]) => `${d} (${f})`).join("; ")}` : "");
const headMoved = (lines) => /head moved since/.test((lines ?? []).join("\n"));

/** One review round at the current head: dispatch, test gate, head check, finalize. @returns {{moved: string}|{fail}|{ok}} */
async function reviewRound({ seam, pr, def, delta }) {
  const pre = await seam.pre({ pr, delta });
  const m = pre.data;
  if (pre.code !== 0 || !m?.headSha) return { fail: `the pre-dispatch stopped (exit ${pre.code}): ${(pre.lines ?? []).slice(-2).join(" | ").slice(0, 300)}` };
  m.pr ??= pr;
  // A delta pass credits the spec panel from the earlier pass: only the briefs the delta touches are dispatched.
  const agents = [
    ...m.briefs.map((b) => ({ domain: b.domain, prompt: () => seam.readFile(b.path) })),
    ...(m.delta ? [] : SPEC_PANEL.map((p) => ({ domain: p.domain, prompt: () => specPrompt(p, m, def) }))),
  ];
  const prompts = new Map(agents.map((a) => [a.domain, a.prompt()]));
  seam.markLaunched(m.launchedFile, agents.map((a) => a.domain), m.headSha);
  const send = (domain, note = "") => seam.runAgent({ role: `release-review-${domain}`, issue: pr, prompt: note ? `${prompts.get(domain)}\n\n${note}` : prompts.get(domain) });
  const failures = new Map();
  const attempt = (domain, note) => send(domain, note).catch((e) => { failures.set(domain, sessionFailure(e)); return null; });
  await Promise.all(agents.map((a) => attempt(a.domain)));
  const gate = await seam.runAgent({ role: "release-test-gate", issue: pr, prompt: `/test-gate --prs "${(m.bundle ?? []).join(" ")}" --base ${def}\n\nPrint the complete gate output, ending with its FORGE:TEST_GATE:RESULT= marker.` });
  const gateFile = seam.saveTestGate(pr, gate?.text ?? "");

  // The head moved while the panel ran: finalize would refuse, and must never run at the moved head. Delta from what was reviewed.
  if ((await seam.headOf(pr)) !== m.headSha) return { moved: m.headSha };
  let fin = await seam.finalize({ pr, testGateOutput: gateFile });
  if (fin.code !== 0 || !fin.data) {
    if (headMoved(fin.lines)) return { moved: m.headSha };
    const missing = missingReviewers(fin.lines).filter((d) => prompts.has(d));
    if (!missing.length) return { fail: `finalize stopped (exit ${fin.code}): ${(fin.lines ?? []).slice(-2).join(" | ").slice(0, 300)}${failureNote(failures)}` };
    // once: the same brief with the note the spec prescribes; a second miss is a degraded panel
    await Promise.all(missing.map((d) => attempt(d, "structured findings block required: post your findings comment again, ending with the REVIEW-FINDINGS-START/END block.")));
    fin = await seam.finalize({ pr, testGateOutput: gateFile });
    if (fin.code !== 0 || !fin.data) {
      if (headMoved(fin.lines)) return { moved: m.headSha };
      return { fail: `reviewer findings block still missing after one re-ask (${missing.join(", ")}): degraded panel${failureNote(failures)}` };
    }
  }
  return { ok: fin.data };
}

/** The whole review of PR `pr`: rounds until one finalizes at its own head. @returns the step result or `{blocked}`. */
async function runReview({ seam, pr, def, delta = null }) {
  let st = null;
  for (let pass = 0; ; pass++) {
    const r = await reviewRound({ seam, pr, def, delta });
    if (r.fail) return blocked(r.fail);
    if (r.ok) { st = r.ok; break; }
    if (pass >= MAX_DELTA_PASSES) return blocked(`head of #${pr} kept moving during the review (${MAX_DELTA_PASSES} delta passes)`);
    delta = r.moved;
  }
  const filed = [], blocking = [];
  for (const item of st.toFile ?? []) {
    const n = await seam.fileIssue({ item, pr, head: st.head });
    if (!n) return blocked(`could not file the finding "${item.title ?? item.id}"`);
    filed.push(n);
    if (SEVERE.has(String(item.severity ?? "").toUpperCase())) blocking.push(n);
  }
  if ((st.notes ?? []).length) await seam.addNotes(pr, st.notes);
  const sum = await seam.summary({ pr, filed });
  if (!sum.data) return blocked(`the gate summary was not posted (exit ${sum.code}): ${(sum.lines ?? []).slice(-1).join("").slice(0, 200)}`);
  return { pr, head: st.head, verdict: sum.data.verdict, marker: sum.data.marker, ciFailing: sum.data.ciFailing, filed, blocking, delta: st.delta?.from ?? null };
}

/** Review step. @returns {{pr, head, verdict, marker, filed, blocking}|{blocked: true, reason: string}} */
export async function reviewStep(ctx) {
  const pr = ctx.state?.steps?.["release-pr"]?.result?.pr;
  if (!pr) return blocked("no release PR recorded by the release-pr step");
  return runReview({ seam: seamOf(ctx), pr, def: ctx.def });
}

/** Fix step: nothing to do on GATE_PASS; else a lane per blocking issue on the staging branch, then a delta review, up to MAX_FIX_ROUNDS. */
export async function fixStep(ctx) {
  let r = ctx.state?.steps?.review?.result;
  if (!r?.pr) return blocked("no review result recorded by the review step");
  const seam = seamOf(ctx);
  for (let round = 0; r.marker !== "FORGE:GATE_PASS"; round++) {
    if (round >= MAX_FIX_ROUNDS) return blocked(`still ${r.verdict} after ${MAX_FIX_ROUNDS} fix round(s)`);
    // Blocking findings are already filed issues; red CI has none, so it gets one issue naming the failing checks.
    const issues = [...(r.blocking ?? [])];
    if (r.ciFailing > 0) {
      const n = await seam.fileCiIssue({ pr: r.pr, head: r.head });
      if (!n) return blocked(`could not file an issue for the red CI of #${r.pr}`);
      issues.push(n);
    }
    if (!issues.length) return blocked(`${r.verdict} with neither a blocking finding nor red CI to fix`);
    for (const issue of issues) {
      const lane = await seam.runLane({ issue, lane: ctx.staging });
      if (lane?.terminalReason !== "merged") return blocked(`fix lane for #${issue} ended ${lane?.terminalReason ?? "without a result"}`);
    }
    // Snapshot mode (#5276): the fixes are merged on staging; bring exactly those onto release/<id> (or recut it) before the delta review.
    if (ctx.config?.mode === "snapshot") {
      const moved = ctx.config.fixMode === "recut" ? await recut(ctx) : await pickFixes(ctx, { issues });
      if (moved.err) return blocked(moved.err);
    }
    // The host preflight re-runs on the head the fixes produced, before the delta review (the draft PR has no Actions CI yet, #5277).
    if (ctx.config?.preflight) {
      const pf = await runHostPreflight(ctx, { head: await seam.headOf(r.pr), pr: r.pr });
      if (!pf.ok && pf.blocking) return blocked(`host preflight failed at ${pf.head} after the fix round (release-blocker #${pf.issue})`);
    }
    const next = await runReview({ seam, pr: r.pr, def: ctx.def, delta: r.head });
    if (next.blocked) return next;
    r = next;
    ctx.state.steps.review = { ...ctx.state.steps.review, result: r };
    ctx.save();
  }
  return { verdict: r.verdict, head: r.head };
}

const seamOf = (ctx) => ctx.io.review ?? (ctx.seam ??= realSeam(ctx));

/** Real effects of the review steps: the review-staging library, the engine runner, the filing scripts, gh and a lane process. */
export function realSeam({ repo, def, env = process.env, cwd = process.cwd(), makeRunner = null }) {
  const rs = { ...reviewStagingIo(), cwd, env };
  const sd = env.FORGE_SCRATCHPAD || join(cwd, ".forge-scratch");
  let runner = null, shimEnv = null;
  // Reviewer briefs say `forgedock ...`: pin that name to this release job's own build, whatever is installed globally.
  const pinnedEnv = () => {
    if (shimEnv) return shimEnv;
    const dir = mkdtempSync(join(tmpdir(), "release-forgedock-"));
    writeFileSync(join(dir, "forgedock"), `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "bin", "forgedock.mjs")}" "$@"\n`, { mode: 0o755 });
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    return (shimEnv = { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ""}` });
  };
  const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 << 20, env });
  return {
    pre: ({ pr, delta }) => reviewStagingJson([String(pr), ...(delta ? ["--delta", delta] : [])], rs),
    finalize: ({ pr, testGateOutput }) => reviewStagingJson([String(pr), "--finalize", "--test-gate-output", testGateOutput], rs),
    summary: ({ pr, filed }) => reviewStagingJson([String(pr), "--summary", ...(filed.length ? ["--filed", filed.join(",")] : [])], rs),
    headOf: (pr) => gh(["pr", "view", String(pr), "-R", repo, "--json", "headRefOid", "--jq", ".headRefOid"]).trim(),
    readFile: (p) => readFileSync(p, "utf8"),
    markLaunched: (file, domains, head) => { appendFileSync(file, domains.map((d) => `${d}\n`).join("")); writeFileSync(`${file}.head`, `${head}\n`); },
    saveTestGate: (pr, text) => { mkdirSync(sd, { recursive: true }); const f = join(sd, `${pr}_test_gate_output.txt`); writeFileSync(f, text); return f; },
    runAgent: async ({ role, issue, prompt }) => {
      runner ??= makeRunner ? makeRunner() : (await import("./effects.mjs")).makeLeanRunner();
      // not readOnly: each reviewer posts its own PR comment
      return runner({ role, issue, cwd, env: pinnedEnv(), prompt, system: "You are an isolated reviewer of one release PR. Do only what the prompt asks.", maxMs: REVIEW_MS, idleMs: 10 * 60_000 });
    },
    async fileCiIssue({ pr, head }) {
      const rows = JSON.parse(gh(["pr", "checks", String(pr), "-R", repo, "--json", "name,bucket"]));
      const names = rows.filter((c) => c.bucket === "fail" && !CI_EXCLUDED_CHECKS.includes(c.name)).map((c) => c.name);
      return this.fileIssue({ item: { title: `Release PR #${pr}: CI red at ${head.slice(0, 7)}`, severity: "HIGH", body: `Failing required checks on the release PR #${pr} at ${head}:\n${names.map((n) => `- ${n}`).join("\n")}\n\nFix them on the staging branch.` }, pr });
    },
    fileIssue: async ({ item, pr }) => {
      const dir = mkdtempSync(join(tmpdir(), "release-finding-"));
      try {
        const body = item.body ?? [`Found by the staging review of PR #${pr}.`, ...Object.entries(item).filter(([k, v]) => k !== "title" && ["string", "number"].includes(typeof v)).map(([k, v]) => `- **${k}**: ${v}`)].join("\n");
        const bodyFile = join(dir, "body.md");
        writeFileSync(bodyFile, withIntegrityMarker(body, `release-${pr}-${item.id ?? item.title ?? "finding"}`));
        let out = "";
        try { out = execFileSync("bash", [join(ROOT, "scripts", "issue-create.sh"), "--title", item.title, "--body-file", bodyFile, "--label", "review-finding", "--label", "staging-review", "--repo", repo], { encoding: "utf8", cwd, env }); } catch (e) { out = String(e.stdout ?? ""); }
        try {
          return Number(/ISSUE_NUM=(\d+)/.exec(execFileSync("bash", [join(ROOT, "scripts", "review-finalize.sh"), "file-verify", "--pr", String(pr), "--repo", repo, "--context", join(sd, `review-ctx-${pr}.json`)], { encoding: "utf8", input: out, cwd, env }))?.[1]) || null;
        } catch { return null; }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    addNotes: async (pr, notes) => {
      const body = JSON.parse(gh(["pr", "view", String(pr), "-R", repo, "--json", "body"])).body ?? "";
      const list = notes.map((n) => (n.startsWith("-") ? n : `- ${n}`)).join("\n");
      const next = body.includes("## Non-blocking notes") ? `${body.trimEnd()}\n${list}\n` : `${body.trimEnd()}\n\n## Non-blocking notes\n${list}\n`;
      gh(["pr", "edit", String(pr), "-R", repo, "--body-file", "-"], next);
    },
    runLane: ({ issue, lane }) => new Promise((resolve) => {
      const dir = mkdtempSync(join(tmpdir(), "release-lane-"));
      const rf = join(dir, "result.json");
      const child = spawn(process.execPath, [join(ROOT, "bin", "forgedock.mjs"), "run-issue", String(issue), "--lane", lane, "--result-file", rf], { cwd, env, stdio: "ignore" });
      const timer = setTimeout(() => child.kill("SIGTERM"), LANE_MS);
      const done = () => { clearTimeout(timer); let r = null; try { r = JSON.parse(readFileSync(rf, "utf8")); } catch { /* no result */ } rmSync(dir, { recursive: true, force: true }); resolve(r); };
      child.on("error", done); child.on("exit", done);
    }),
  };
}

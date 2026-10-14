// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { runCore } from "./lean.mjs";
import { renderInvestigation, renderPlan, renderImplementation, renderReview, renderPrBody, renderTrajectory, sanitizeMd, capComment, section, cell, NR, MAX_COMMENT_CHARS } from "./render.mjs";
import { orchestrate, parseDeps, formatTable } from "./orchestrate.mjs";
import { REVIEWER_SYSTEM, approxTokens, builderPrompt, reviewerPrompt, parseVerdict } from "./prompts.mjs";
import { mapRecord } from "../engine/telemetry-seam.mjs";
import { readLog } from "../engine/runlog.mjs";
import { makeRunTmp, wrapLaneLimits, systemdRunAvailable, makeLeanRunner } from "./effects.mjs";
import { retrying, PUSH_TRANSIENT_RE } from "./retry.mjs";
import { checkAdmission } from "./admission.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { readAdmission } from "../engine-cli.mjs";
import { runFromCli, orchestrateFromCli, ENGINE_PATHS } from "../engine-cli.mjs";

const WT = "/wt/lean-7";
const STAGE_MD = {
  investigation: "**Verdict**: CONFIRMED\n**Confidence**: high\n**Severity**: medium\n**Task Type**: bug\n\n### What Was Claimed\nfoo breaks\n\n### What We Found\n- src/foo.js:3 derefs null\n\n### Root Cause\nfoo derefs null at src/foo.js:3\n\n### Affected Files\n- src/foo.js: add guard\n\n### Sibling Sweep\n- src/bar.js:8 same guard\n\n### History\nintroduced in abc123\n\n### Recommendation\nguard null\n\n### Related Issues\nnone",
  plan: "### Approach\nguard null in foo\n\n### Deliverables\n| File | Change | Why |\n| --- | --- | --- |\n| src/foo.js | add guard | avoid crash |\n\n### Acceptance Criteria\n- [ ] foo handles null\n\n### Implementation Order\n1. guard\n\n### Out of Scope\nrefactor: later\n\n### Risk Assessment\n| Risk | Severity | Mitigation |\n| --- | --- | --- |\n| none | low | test |",
  implementation: "### Approach\nadded a guard\n\n### Changes\n- src/foo.js: guard\n\n### Acceptance Criteria Status\n- ✅ foo handles null\n\n### Verification\n- node --test test/foo.test.js: pass, fails without fix: yes\n\n### Notes\nnone",
};
const ok = (extra = {}) => "```json\n" + JSON.stringify({ verdict: "PASS", fixes_issue: true, regression: false, reason: "src/foo.js:3 fixed", ...extra }) + "\n```";
const bad = (reason = "src/foo.js:9 still wrong") => ok({ verdict: "FAIL", fixes_issue: false, reason });

/** In-memory world with fake gh, git, fs and runner. */
function world(o = {}) {
  const w = {
    comments: [], labels: [], closed: [], edits: [], prs: [], merges: [], calls: [], telemetry: [], files: {}, head: "aaaa1111aaaa1111",
    changed: o.changed ?? ["src/foo.js", "test/foo.test.js"], reviews: [...(o.reviews ?? [])], waits: [...(o.waits ?? [])], clock: 0,
    result: o.result ?? { status: "fixed", summary: "fixed foo", evidence: [], tests: ["test/foo.test.js"] },
    prList: o.prList ?? [], remote: o.remote ?? "", resumeResult: o.resumeResult, seq: [], mtimes: {}, envs: [], pushes: 0, pushErrors: [...(o.pushErrors ?? [])], commentErrors: [...(o.commentErrors ?? [])], dirty: o.dirty ?? false, lastSubject: o.lastSubject ?? "", prView: [...(o.prView ?? [])], mergeResults: [...(o.mergeResults ?? [])], mergeErrors: [...(o.mergeErrors ?? [])], conflictFiles: [], mergeInProgress: false, markers: false, mergeAttempts: 0,
    stages: { ...STAGE_MD, ...(o.stages ?? {}) },
  };
  const put = (name, text) => { const p = `${WT}/.forge-lean/${name}`; if (w.files[p] !== text) w.mtimes[p] = Date.now(); w.files[p] = text; };
  const writeStages = (keys) => { for (const k of keys) if (w.stages[k] != null) put(`${k}.md`, w.stages[k]); };
  w.writeStages = writeStages;
  w.io = {
    now: () => w.clock, sleep: async (ms) => { w.clock += ms; },
    gh: async (a) => {
      const k = a.slice(0, 2).join(" ");
      if (a[0] === "api") return "";
      if (k === "pr list") return JSON.stringify(w.prList);
      if (k === "issue view") return JSON.stringify({ number: 7, title: "foo breaks", body: "Bug in foo", state: "OPEN" });
      if (k === "issue comment" && w.commentErrors.length) throw new Error(w.commentErrors.shift());
      if (k === "issue comment") { w.comments.push(a[a.indexOf("--body") + 1]); w.seq.push("comment"); return `https://github.com/o/r/issues/7#issuecomment-${w.comments.length}\n`; }
      if (k === "issue close") { w.closed.push(a); w.seq.push("close"); return ""; }
      if (k === "issue edit") { w.edits.push(a); return ""; }
      if (k === "pr create") { w.prs.push(a); w.seq.push("pr"); return "https://github.com/o/r/pull/77\n"; }
      if (k === "pr view" && a.includes("mergeable,mergeStateStatus")) { const v = w.prView.length > 1 ? w.prView.shift() : (w.prView[0] ?? { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }); return JSON.stringify(v); }
      if (k === "pr merge" && w.mergeErrors.length) { w.mergeAttempts++; throw new Error(w.mergeErrors.shift()); }
      if (k === "pr merge") { w.mergeAttempts++; }
      if (k === "pr merge") { w.merges.push(a); w.seq.push("merge"); return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (a) => {
      w.calls.push(["git", ...a]);
      if (a[0] === "worktree" && a[1] === "add" && (w.lockFails ?? 0) > 0) {
        w.lockFails--; const e = new Error("git failed"); e.stderr = "error: could not lock config file .git/config: File exists"; throw e;
      }
      if (a[0] === "rev-parse" && a[1] === "--git-path") return "/repo/.git/info/exclude";
      if (a[0] === "status" && a[1] === "--porcelain") return w.dirty ? " M src/foo.js\n" : "";
      if (a[0] === "log" && a.includes("--format=%s")) return w.lastSubject;
      if (a[0] === "push") { w.pushes++; if (w.pushErrors.length) { const m = w.pushErrors.shift(); throw Object.assign(new Error(m), { stderr: m }); } }
      if (a[0] === "merge" && a[1] === "--no-edit") {
        const r = w.mergeResults.shift() ?? "clean";
        if (r === "clean") { w.head = `cccc${w.calls.length}`.padEnd(16, "0"); return ""; }
        w.conflictFiles = o.conflictFiles ?? ["src/foo.js"]; w.mergeInProgress = true; throw new Error("CONFLICT (content): Merge conflict in src/foo.js");
      }
      if (a[0] === "rev-parse" && a.includes("MERGE_HEAD")) return w.mergeInProgress ? "deadbeef" : "";
      if (a[0] === "diff" && a.includes("--diff-filter=U")) return w.conflictFiles.join("\n");
      if (a[0] === "diff" && a[1] === "--check") return "";
      if (a[0] === "grep") return w.markers ? "src/foo.js:3:<<<<<<< HEAD" : "";
      if (a[0] === "merge" && a[1] === "--abort") { w.mergeInProgress = false; return ""; }
      if (a[0] === "rev-parse") return w.head;
      if (a[0] === "diff" && a[1] === "--name-only") return w.changed.join("\n");
      if (a[0] === "diff") return "diff --git a/src/foo.js b/src/foo.js\n+fix";
      if (a[0] === "ls-remote") return w.remote;
      if (a[0] === "push") w.seq.push("push");
      return "";
    },
    runner: async (c) => {
      w.calls.push(["runner", c.role, c.resume ?? null, c.model ?? null, c.prompt, c.readOnly ?? false, c.system]);
      w.seq.push(c.role + (c.resume ? "-resume" : ""));
      w.envs.push(c.env ?? null);
      if (c.role === "builder") {
        const r = c.resume ? (w.resumeResult ?? w.result) : w.result;
        if (o.live) await o.live(w, put);
        else if (!c.resume && !o.noStages) writeStages(["investigation", "plan", "implementation"]);
        if (r) put("result.json", JSON.stringify(r));
        if (c.resume || /Merging origin\//.test(c.prompt)) { w.head = `bbbb${w.calls.length}`.padEnd(16, "0"); if (!o.leaveConflicts) { w.conflictFiles = []; w.mergeInProgress = false; } }
        return { text: "done", sessionId: "sess-1", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, costUsd: 0.1, durationMs: 1000, turns: 3, model: "default" };
      }
      return { text: w.reviews.length ? w.reviews.shift() : ok(), sessionId: "rev", usage: { input_tokens: 4, output_tokens: 2 }, costUsd: 0.05, durationMs: 500, turns: 2, model: c.model };
    },
    waitCiGreen: async () => (w.waits.length ? w.waits.shift() : { rc: 0, text: `CI_GATE_HEAD: ${w.head}` }),
    transitionLabel: async (n, s) => { w.labels.push(s); w.seq.push(`label:${s}`); },
    fs: { stat: async (p) => (p in w.files ? { mtimeMs: w.mtimes[p] ?? 1 } : null), read: async (p) => { if (!(p in w.files)) throw new Error("ENOENT"); return w.files[p]; }, append: async (p, t) => { w.files[p] = (w.files[p] ?? "") + t; } },
  };
  return w;
}
const run = (w, extra = {}) => runCore({ issue: 7, repo: "o/r", lane: "staging", cwd: "/repo", worktreeRoot: "/wt", dir: tmpDir("core-"),
  io: w.io, emitTelemetry: async (r) => w.telemetry.push(r), random: () => 0.5, ...extra });
const builders = (w) => w.calls.filter((c) => c[0] === "runner" && c[1] === "builder");
const reviewers = (w) => w.calls.filter((c) => c[0] === "runner" && c[1] === "reviewer");
const traj = (w) => w.comments.filter((c) => c.includes("<!-- FORGE:TRAJECTORY -->"));
const markerOf = (c) => /<!-- (FORGE:[A-Z_-]+) -->/.exec(c)[1];

describe("core work-on", () => {
  it("happy path: investigation, plan, implementation, review, trajectory in order; merge at the reviewed head", async () => {
    const w = world();
    const dir = tmpDir("core-");
    const r = await run(w, { dir });
    assert.equal(r.terminalReason, "merged");
    assert.equal(r.pr, 77);
    assert.deepEqual(w.comments.map(markerOf), ["FORGE:STARTED", "FORGE:INVESTIGATION", "FORGE:PLAN", "FORGE:IMPLEMENTATION", "FORGE:REVIEW", "FORGE:TRAJECTORY"]);
    assert.match(w.comments[1], /<!-- FORGE:VALIDATE -->/, "VALIDATE stays as an alias marker");
    assert.match(w.comments[1], /^<!-- FORGE:INVESTIGATION -->\n<!-- FORGE:VALIDATE -->\n## Investigation Report\n\*\*Verdict\*\*: CONFIRMED/);
    assert.match(w.comments[2], /## Implementation Plan\n### Approach/);
    assert.match(w.comments[3], /## Implementation Complete\n\*\*Branch:\*\* `feat\/issue-7-lean`\n\*\*Files changed:\*\*\n- `src\/foo.js`\n- `test\/foo.test.js`/);
    assert.match(w.comments[4], /## Review\n\*\*Verdict:\*\* PASS/);
    assert.match(w.comments[4], /Fixes the issue:\*\* yes \(src\/foo.js:3 fixed\)/);
    const t = traj(w);
    assert.equal(t.length, 1);
    assert.match(t[0], /<!-- FORGE:TRAJECTORY -->\n<!-- FORGE:WORK-ON -->\n## Pipeline Trajectory — #7/);
    for (const needle of ["| Validate | CONFIRMED |", "| Plan | posted |", "| Implement |", "| Review | PASS |", "| PR | #77 |", "| Merge |", "| Close | issue closed (completed) |", "**Decisions**", "**Anomalies**", "cost $0.1500", "tokens 14 in / 7 out / 100 cache", "wall"]) {
      assert.ok(t[0].includes(needle), `trajectory lacks ${needle}:\n${t[0]}`);
    }
    const body = w.prs[0][w.prs[0].indexOf("--body") + 1];
    assert.match(body, /## Root cause\nfoo derefs null at src\/foo.js:3/);
    assert.match(body, /## Deliverables\n\| File \| Change \| Why \|/);
    assert.match(body, /## Verification\n- node --test/);
    assert.match(body, /Closes #7$/);
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
    assert.equal(w.closed.length, 1);
    assert.equal(builders(w).length, 1);
    assert.equal(reviewers(w).length, 1);
    const ev = readLog(dir, 7).map((e) => e.event);
    assert.equal(ev[0], "RUN_START"); assert.equal(ev.at(-1), "RUN_TERMINAL");
  });

  it("investigation and plan comments are posted before the reviewer runs and before the in-review label", async () => {
    const w = world();
    await run(w);
    const idx = []; w.seq.forEach((x, i) => { if (x === "comment") idx.push(i); });
    const rv = w.seq.indexOf("reviewer");
    assert.ok(idx[1] < rv && idx[2] < rv && idx[3] < rv, "investigation, plan, implementation precede the reviewer");
    assert.ok(idx[3] < w.seq.indexOf("label:in-review"));
    assert.ok(idx[4] > rv, "review comment follows the reviewer");
  });

  it("labels transition in order, and register is posted after the PR and before the merge", async () => {
    const w = world();
    await run(w);
    assert.deepEqual(w.labels, ["investigating", "building", "in-review", "merged"]);
    const order = w.seq.filter((s) => ["label:investigating", "label:building", "builder", "label:in-review", "reviewer", "push", "pr", "merge", "label:merged"].includes(s));
    assert.deepEqual(order, ["label:investigating", "label:building", "builder", "label:in-review", "reviewer", "push", "pr", "merge", "label:merged"]);
    assert.ok(w.seq.lastIndexOf("comment") > w.seq.indexOf("merge"), "the trajectory is posted last");
  });

  it("emits phase_attempt for builder and reviewer plus run_terminal, stats-compatible", async () => {
    const w = world();
    await run(w);
    const mapped = w.telemetry.map((t) => mapRecord(t, 5)).filter(Boolean);
    assert.deepEqual(mapped.filter((m) => m.event === "phase_attempt").map((m) => m.phase), ["implement", "review"]);
    assert.equal(mapped[0].payload.input_tokens, 10);
    assert.equal(mapped.at(-1).event, "run_terminal");
    assert.equal(mapped.at(-1).payload.reason, "merged");
  });

  it("invalid with evidence: the investigation is the evidence comment, closes, trajectory rows", async () => {
    const w = world({ changed: [], stages: { investigation: "**Verdict**: INVALID\n**Confidence**: high\n\n### What We Found\n- src/foo.js:3 already guards null\n\n### Root Cause\nnone, not a bug" },
      result: { status: "invalid", summary: "not a bug", evidence: ["src/foo.js:3 already guards null"], tests: [] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "invalid");
    assert.deepEqual(w.labels, ["investigating", "building", "invalid"]);
    assert.deepEqual(w.comments.map(markerOf), ["FORGE:STARTED", "FORGE:INVESTIGATION", "FORGE:TRAJECTORY"]);
    assert.match(w.comments[1], /Verdict\*\*: INVALID/);
    assert.match(w.comments[1], /src\/foo.js:3 already guards null/);
    const t = traj(w)[0];
    for (const needle of ["| Validate | INVALID |", "| Plan | skipped |", "| Implement | skipped |", "| Review | skipped |", "| PR | none |", "| Close | issue closed (not planned) |"]) assert.ok(t.includes(needle), needle);
    assert.equal(w.closed.length, 1);
    assert.equal(w.prs.length, 0);
    assert.equal(reviewers(w).length, 0);
  });

  it("already-fixed with evidence also closes", async () => {
    const w = world({ changed: [], result: { status: "already-fixed", summary: "done upstream", evidence: ["a.js:1"], tests: [] } });
    assert.equal((await run(w)).terminalReason, "invalid");
  });

  it("invalid without evidence goes to needs-human and does not close", async () => {
    const w = world({ changed: [], result: { status: "invalid", summary: "trust me", evidence: [], tests: [] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(w.closed.length, 0);
    assert.ok(w.edits.some((e) => e.includes("needs-human")));
    assert.ok(w.comments.some((c) => c.includes("FORGE:NEEDS_HUMAN") && c.includes("without evidence")));
    const t = traj(w)[0];
    assert.match(t, /\| Close \| left open \| label needs-human \|/);
    assert.match(t, /\*\*Anomalies\*\*\n- needs-human: Builder reported "invalid" without evidence/);
    assert.match(t, /\| Plan \| not reached \|/);
  });

  it("review FAIL -> builder resumed via --resume with the reason -> re-review PASS -> merge", async () => {
    const w = world({ reviews: [bad("src/foo.js:9 still wrong"), ok()] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const b = builders(w);
    assert.equal(b.length, 2);
    assert.equal(b[1][2], "sess-1");
    assert.match(b[1][4], /src\/foo.js:9 still wrong/);
    assert.equal(reviewers(w).length, 2);
    assert.equal(w.prs.length, 1);
    assert.equal(traj(w).length, 1);
    assert.match(traj(w)[0], /2 rounds/);
    assert.match(traj(w)[0], /Review FAIL \(round 1\)/);
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
  });

  it("review FAIL twice -> needs-human, no PR", async () => {
    const w = world({ reviews: [bad(), bad("still bad")] });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(builders(w).length, 2);
    assert.equal(w.prs.length, 0);
    assert.equal(w.merges.length, 0);
    assert.ok(w.edits.some((e) => e.includes("needs-human")));
  });

  it("a FAIL verdict with fixes_issue true and no regression is not a failure", async () => {
    const w = world({ reviews: [ok({ verdict: "FAIL" })] });
    assert.equal((await run(w)).terminalReason, "merged");
    assert.equal(builders(w).length, 1);
  });

  it("builder blocked on a typed human reason, or no commit, is needs-human", async () => {
    assert.equal((await run(world({ result: { status: "blocked", summary: "need creds", block: { kind: "human", why: "credentials" } } }))).terminalReason, "needs-human");
    assert.equal((await run(world({ changed: [] }))).terminalReason, "needs-human");
  });

  // #4124: a builder block is typed; only kind "human" with an allowed reason may reach needs-human.
  const depWorld = (o, deps) => {
    const w = world(o);
    const gh = w.io.gh;
    w.created = [];
    w.io.gh = async (a) => {
      if (a[0] === "issue" && a[1] === "view" && deps[a[2]]) return JSON.stringify(deps[a[2]]);
      if (a[0] === "issue" && a[1] === "create") { w.created.push(a); return `https://github.com/o/r/issues/${200 + w.created.length}\n`; }
      return gh(a);
    };
    return w;
  };
  const noNeedsHuman = (w) => {
    assert.ok(!w.edits.some((e) => e.includes("--add-label") && e.includes("needs-human")), JSON.stringify(w.edits));
    assert.ok(!w.comments.some((c) => c.includes("FORGE:NEEDS_HUMAN")));
  };

  it("#4124 a builder block naming an open issue ends dependency-open with dependencies, not needs-human", async () => {
    const w = depWorld({ changed: [], result: { status: "blocked", summary: "needs #34927 first", block: { kind: "dependency", issues: ["#3", 7] } } },
      { 3: { state: "OPEN", labels: [] } });
    const dir = tmpDir("lean-dep-");
    const r = await run(w, { dir });
    assert.equal(r.terminalReason, "dependency-open");
    assert.equal(r.code, "dependency.open");
    assert.deepEqual(r.dependencies, [3]);
    assert.equal(readLog(dir, 7).find((e) => e.event === "RUN_TERMINAL").code, "dependency.open");
    assert.ok(w.comments.some((c) => c.includes("FORGE:DEPENDENCY") && c.includes("#3")));
    assert.ok(w.edits.some((e) => e.includes("--remove-label")), "workflow labels are cleared");
    assert.equal(builders(w).length, 1);
    noNeedsHuman(w);
  });

  it("#4124 an open dependency that is itself needs-human ends dependency-blocked; this issue is not labelled needs-human", async () => {
    const w = depWorld({ changed: [], result: { status: "blocked", summary: "upstream", block: { kind: "dependency", issues: [3] } } },
      { 3: { state: "OPEN", labels: [{ name: "needs-human" }] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "dependency-blocked");
    assert.equal(r.code, "dependency.blocked");
    assert.deepEqual(r.blockers, [3]);
    noNeedsHuman(w);
  });

  it("#4124 split-required files sub-issues with Parent / Depends-on lines and ends decomposed", async () => {
    const w = depWorld({ changed: [], result: { status: "blocked", summary: "epic", block: { kind: "split-required", subissues: [
      { title: "part A", body: "do A" }, { title: "part B", body: "do B", depends_on: [0] }] } } }, {});
    const r = await run(w);
    assert.equal(r.terminalReason, "decomposed");
    assert.deepEqual(r.subissues, [201, 202]);
    const bodyB = w.created[1][w.created[1].indexOf("--body") + 1];
    assert.match(bodyB, /^\*\*Parent\*\*: #7$/m);
    assert.match(bodyB, /^\*\*Depends on\*\*: #201$/m);
    assert.ok(w.labels.includes("decomposed"));
    noNeedsHuman(w);
  });

  it("#4124 a prod-data (non-human) or untyped block gets one corrective resume; a builder that then proceeds merges", async () => {
    const w = world({ result: { status: "blocked", summary: "needs live wire capture and prod baselines", block: { kind: "human", why: "prod-data" } },
      resumeResult: { status: "fixed", summary: "captured via read-only monitoring", evidence: [], tests: [] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const resumed = builders(w).filter((c) => c[2]);
    assert.equal(resumed.length, 1);
    assert.match(resumed[0][4], /not a block that needs a human/);
    noNeedsHuman(w);
  });

  it("#4124 a block that stays untyped after the correction is needs-human with builder.block_untyped; a closed dependency is not a block", async () => {
    const w = depWorld({ changed: [], result: { status: "blocked", summary: "upstream", block: { kind: "dependency", issues: [3] } } },
      { 3: { state: "CLOSED", labels: [] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(r.code, "builder.block_untyped");
    assert.equal(builders(w).filter((c) => c[2]).length, 1);
  });

  it("worktree add retries a concurrent .git lock collision, then gives up after 5 tries", async () => {
    const w = world(); w.lockFails = 2;
    assert.equal((await run(w)).terminalReason, "merged");
    assert.equal(w.calls.filter((c) => c[1] === "worktree" && c[2] === "add").length, 3);
    const w2 = world(); w2.lockFails = 99;
    assert.notEqual((await run(w2)).terminalReason, "merged");
    assert.equal(w2.calls.filter((c) => c[1] === "worktree" && c[2] === "add").length, 5);
  });

  it("needs-human terminals carry a specific outcome code, never unclassified", async () => {
    const code = async (w, extra) => {
      const dir = tmpDir("lean-code-");
      const r = await run(w, { dir, ...extra });
      const term = readLog(dir, 7).filter((e) => e.event === "RUN_TERMINAL");
      assert.equal(term.length, 1);
      assert.equal(term[0].code, r.code);
      return term[0].code;
    };
    assert.equal(await code(world({ result: { status: "blocked", summary: "need creds", block: { kind: "human", why: "credentials" } } })), "builder.blocked");
    assert.equal(await code(world({ result: { status: "blocked", summary: "need creds" } })), "builder.block_untyped");
    assert.equal(await code(world({ changed: [] })), "builder.no_commit");
    assert.equal(await code(world({ waits: [{ rc: 1, text: "lint failed" }] }), { mergeWait: "all" }), "ci.red");
  });

  it("red remote CI is needs-human; slow CI polls with backoff and ends ci-pending, never needs-human", async () => {
    const w = world({ waits: [{ rc: 1, text: "lint failed" }] });
    assert.equal((await run(w, { mergeWait: "all" })).terminalReason, "needs-human");
    const w2 = world({ waits: Array(500).fill({ rc: 2, text: "" }) });
    const r2 = await run(w2, { ciMaxMinutes: 10, mergeWait: "all" });
    assert.equal(r2.terminalReason, "ci-pending");
    assert.equal(w2.edits.length, 0);
    const w3 = world({ waits: [{ rc: 2, text: "" }, { rc: 2, text: "" }] });
    assert.equal((await run(w3, { mergeWait: "all" })).terminalReason, "merged");
  });

  it("refuses merge when the CI-gated head differs from the reviewed head", async () => {
    const w = world({ waits: [{ rc: 0, text: "CI_GATE_HEAD: deadbeefdead" }] });
    assert.equal((await run(w, { mergeWait: "all" })).terminalReason, "needs-human");
    assert.equal(w.merges.length, 0);
  });

  it("an open Depends-on dependency refuses the run before any label or worktree", async () => {
    const w = world();
    const gh = w.io.gh;
    w.io.gh = async (a) => {
      if (a[0] === "api" && /issues\/7$/.test(a[1])) return JSON.stringify({ body: "**Depends on**: #3", user: { login: "x" }, author_association: "OWNER" });
      if (a[0] === "api" && /issues\/3$/.test(a[1])) return JSON.stringify({ state: "open" });
      return gh(a);
    };
    const r = await run(w);
    assert.ok(["dependency-open", "dependency-unreadable"].includes(r.terminalReason));
    assert.equal(w.labels.length, 0);
    assert.equal(w.calls.filter((c) => c[1] === "worktree").length, 0);
  });

  it("an open PR / remote branch resumes: worktree from the branch, builder skipped, review then merge", async () => {
    const w = world({ prList: [{ number: 77, headRefOid: "x" }], remote: "abc\trefs/heads/feat/issue-7-lean" });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.equal(builders(w).length, 0);
    assert.equal(w.prs.length, 0);
    assert.ok(w.calls.some((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add" && c.includes("origin/feat/issue-7-lean")));
  });

  it("builder uses the CLI default model; reviewer is read-only Sonnet unless configured", async () => {
    const w = world(); await run(w);
    assert.equal(builders(w)[0][3], null);
    assert.equal(builders(w)[0][5], false);
    assert.equal(reviewers(w)[0][3], "claude-sonnet-5-5");
    assert.equal(reviewers(w)[0][5], true);
    const w2 = world(); await run(w2, { reviewerModel: "my-model" });
    assert.equal(reviewers(w2)[0][3], "my-model");
  });
});

describe("comment templates", () => {
  const rv = { verdict: "PASS", fixes_issue: true, regression: false, reason: "src/foo.js:3 ok", evidence: "src/foo.js:3 guard", checked: "callers of foo, test/foo.test.js" };
  const result = { status: "fixed", summary: "fixed foo", evidence: ["src/foo.js:3 null deref"], root_cause: "derefs null at src/foo.js:3", changes: [{ file: "src/foo.js", change: "add guard", why: "avoid crash" }],
    tests: [{ command: "node --test test/foo.test.js", result: "pass", fails_without_fix: true }], risks: ["none"], follow_ups: ["audit baz"], approach: "guard null" };

  it("renders builder-written files under the fixed headings", () => {
    assert.match(renderInvestigation(STAGE_MD.investigation, null), /^## Investigation Report\n\*\*Verdict\*\*: CONFIRMED/);
    assert.match(renderPlan(STAGE_MD.plan, null), /^## Implementation Plan\n### Approach/);
    const im = renderImplementation(STAGE_MD.implementation, null, { branch: "b", files: ["a.js"] });
    assert.match(im, /^## Implementation Complete\n\*\*Branch:\*\* `b`\n\*\*Files changed:\*\*\n- `a.js`\n\n### Approach/);
    const r = renderReview(rv);
    assert.match(r, /^## Review\n\*\*Verdict:\*\* PASS/);
    assert.match(r, /Fixes the issue:\*\* yes \(src\/foo.js:3 guard\)/);
    assert.match(r, /Regression check:\*\* no regression \(checked: callers of foo, test\/foo.test.js\)/);
    assert.match(r, /Notes:\*\* src\/foo.js:3 ok/);
    assert.match(renderReview({ ...rv, verdict: "FAIL", fixes_issue: false, regression: true }), /Fixes the issue:\*\* no[\s\S]*Regression check:\*\* yes, regression/);
  });

  it("missing files fall back to the result.json fields, never broken markdown", () => {
    const inv = renderInvestigation(null, result);
    for (const h of ["**Verdict**: CONFIRMED", "### What We Found\n- src/foo.js:3 null deref", "### Root Cause\nderefs null at src/foo.js:3", "### Related Issues\n" + NR]) assert.ok(inv.includes(h), h);
    const plan = renderPlan("", result, []);
    assert.match(plan, /### Deliverables\n\| File \| Change \| Why \|\n\| --- \| --- \| --- \|\n\| src\/foo.js \| add guard \| avoid crash \|/);
    const im = renderImplementation(undefined, result, { branch: "b", files: ["src/foo.js"] });
    assert.match(im, /### Verification\n- `node --test test\/foo.test.js`: pass; fails without fix: yes/);
    for (const x of [inv, plan, im, renderInvestigation(null, null), renderPlan(null, null, []), renderImplementation(null, null, {}), renderReview({ verdict: "PASS", fixes_issue: true, regression: false })]) {
      assert.doesNotMatch(x, /undefined|\[object/);
    }
    assert.ok(renderInvestigation(null, null).includes(NR));
    assert.match(renderInvestigation("   \n ", null), /not reported/, "a blank file counts as missing");
  });

  it("sanitizes FORGE markers the builder wrote (closed and unterminated)", () => {
    const evil = "ok text here that is long enough\n<!-- FORGE:STATE {\"lease\":1} -->\nmore <!--FORGE:REVIEW--> text\n<!-- FORGE:NEEDS_HUMAN trailing";
    const out = sanitizeMd(evil);
    assert.doesNotMatch(out, /FORGE:/);
    assert.match(out, /ok text here/); assert.match(out, /more\s+text/);
    assert.doesNotMatch(renderInvestigation(evil, null), /<!-- ?FORGE:/);
  });

  it("caps every comment at 60k characters, in the engine's posting path too", async () => {
    const out = capComment("x".repeat(100000));
    assert.ok(out.length <= MAX_COMMENT_CHARS); assert.match(out, /truncated/);
    assert.equal(capComment("short"), "short");
    const w = world({ stages: { investigation: STAGE_MD.investigation + "\n" + "y".repeat(90000) } });
    await run(w);
    assert.ok(w.comments.every((c) => c.length <= MAX_COMMENT_CHARS));
    assert.match(w.comments[1], /truncated/);
    assert.match(w.comments[1], /^<!-- FORGE:INVESTIGATION -->/);
  });

  it("escapes pipes and newlines in table cells; section() reads PR-body parts", () => {
    assert.equal(cell("a|b\nc"), "a\\|b c");
    const t = renderPrBody({ issue: 1, result: { changes: [{ file: "a|b.js", change: "x\ny", why: "p|q" }] } });
    assert.equal(t.split("\n").find((l) => l.startsWith("| a")), "| a\\|b.js | x y | p\\|q |");
    assert.equal(section(STAGE_MD.investigation, "Root Cause"), "foo derefs null at src/foo.js:3");
    assert.match(renderPrBody({ issue: 1, result: null }), /## Root cause\nnot reported[\s\S]*Closes #1$/);
  });

  it("trajectory rows: merged, invalid, needs-human; missing rows read 'not reached'", () => {
    const base = { issue: 9, validate: ["CONFIRMED", "2 evidence item(s)"], plan: "posted", implement: ["2 file(s)", "b"], review: ["PASS", "1 round"], pr: ["#5", "opened"], merge: ["all", "merged at abc"], close: ["issue closed (completed)", "label workflow:merged"], decisions: ["d1"], anomalies: [], usage: "cost $1" };
    const m = renderTrajectory(base);
    assert.match(m, /^## Pipeline Trajectory — #9\n\n\| Phase \| Result \| Notes \|/);
    for (const row of ["| Validate | CONFIRMED | 2 evidence item(s) |", "| Review | PASS | 1 round |", "| PR | #5 | opened |", "| Merge | all | merged at abc |", "| Close | issue closed (completed) | label workflow:merged |", "- d1", "- none", "_cost $1_"]) assert.ok(m.includes(row), row);
    const nh = renderTrajectory({ issue: 9, validate: "CONFIRMED", anomalies: ["needs-human: Review FAIL twice"], close: ["left open", "label needs-human"] });
    assert.match(nh, /\| Implement \| not reached \| - \|/);
    assert.match(nh, /\*\*Anomalies\*\*\n- needs-human: Review FAIL twice/);
    assert.match(renderTrajectory({ issue: 9, validate: ["a|b", "x\ny"] }), /\| Validate \| a\\\|b \| x y \|/);
  });

  it("a merged run's trajectory and a needs-human run's trajectory carry the right rows", async () => {
    const w = world({ reviews: [bad(), bad("still bad")] });
    await run(w);
    const t = traj(w)[0];
    assert.match(t, /\| Validate \| CONFIRMED \|/);
    assert.match(t, /\| Plan \| posted \|/);
    assert.match(t, /\| Review \| not reached \|/);
    assert.match(t, /\| Close \| left open \| label needs-human \|/);
    assert.match(t, /Review FAIL twice/);
  });

  it("missing stage files in a real run are rendered from result.json and noted as anomalies", async () => {
    const w = world({ noStages: true, result: { status: "fixed", summary: "fixed foo", evidence: ["src/foo.js:3 x"], root_cause: "bad at src/foo.js:3", changes: [{ file: "src/foo.js", change: "guard", why: "w" }], tests: [{ command: "t", result: "pass", fails_without_fix: false }] } });
    await run(w);
    assert.deepEqual(w.comments.map(markerOf), ["FORGE:STARTED", "FORGE:INVESTIGATION", "FORGE:PLAN", "FORGE:IMPLEMENTATION", "FORGE:REVIEW", "FORGE:TRAJECTORY"]);
    assert.match(w.comments[1], /Root Cause\nbad at src\/foo.js:3/);
    assert.match(w.comments[3], /fails without fix: no/);
    assert.match(traj(w)[0], /investigation.md missing or empty: rendered from result.json/);
    for (const c of w.comments) assert.doesNotMatch(c, /undefined|\[object/);
  });

  it("live posting: stage notes appear while the builder session is still running", async () => {
    const w = world({ live: async (wd, put) => {
      const until = async (marker) => { for (let i = 0; i < 300 && !wd.comments.some((c) => c.includes(`<!-- ${marker} -->`)); i++) await new Promise((r) => setTimeout(r, 10)); return wd.comments.map(markerOf); };
      wd.liveSeen = {};
      put("investigation.md", STAGE_MD.investigation); wd.liveSeen.afterInvestigation = await until("FORGE:INVESTIGATION");
      put("plan.md", STAGE_MD.plan); wd.liveSeen.afterPlan = await until("FORGE:PLAN");
      put("implementation.md", STAGE_MD.implementation); wd.liveSeen.afterImplementation = await until("FORGE:IMPLEMENTATION");
    } });
    const r = await run(w, { livePollMs: 10, stableMs: 30 });
    assert.equal(r.terminalReason, "merged");
    assert.ok(w.liveSeen.afterInvestigation.includes("FORGE:INVESTIGATION"), "investigation posted before the session ended");
    assert.ok(w.liveSeen.afterPlan.includes("FORGE:PLAN"));
    assert.ok(w.liveSeen.afterImplementation.includes("FORGE:IMPLEMENTATION"));
    assert.deepEqual(w.comments.map(markerOf), ["FORGE:STARTED", "FORGE:INVESTIGATION", "FORGE:PLAN", "FORGE:IMPLEMENTATION", "FORGE:REVIEW", "FORGE:TRAJECTORY"], "each posted exactly once, in order");
  });

  it("a file still being written is not posted until its mtime is stable", async () => {
    let seenEarly = null;
    const w = world({ live: async (wd, put) => {
      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 6; i++) { put("investigation.md", STAGE_MD.investigation + "\n".repeat(i)); await sleepMs(15); }
      seenEarly = wd.comments.map(markerOf);
      await sleepMs(900);
    } });
    await run(w, { livePollMs: 10, stableMs: 400 });
    assert.ok(!seenEarly.includes("FORGE:INVESTIGATION"), "not posted while the file keeps changing");
    assert.equal(w.comments.filter((c) => c.includes("FORGE:INVESTIGATION")).length, 1);
  });

  it("builder prompt (three stage templates) stays within 2.5k tokens", () => {
    const p = builderPrompt(7);
    assert.ok(approxTokens(p) <= 2500, `builder prompt is ${approxTokens(p)} tokens`);
    for (const h of ["### What Was Claimed", "### What We Found", "### Root Cause", "### Affected Files", "### Sibling Sweep", "### History", "### Recommendation", "### Related Issues",
      "### Approach", "### Deliverables", "### Acceptance Criteria", "### Implementation Order", "### Out of Scope", "### Risk Assessment", "### Changes", "### Acceptance Criteria Status", "### Verification", "### Notes",
      "investigation.md", "plan.md", "implementation.md", "result.json", "BEFORE coding", "BEFORE editing code"]) assert.ok(p.includes(h), h);
  });
});

describe("merge_wait policy", () => {
  const states = (o) => Object.entries(o).map(([name, state]) => ({ name, state }));
  it("required with no protection (empty) merges immediately without polling", async () => {
    const w = world(); let polled = 0;
    w.io.requiredChecks = async () => []; w.io.checkStates = async () => { polled++; return []; };
    w.io.waitCiGreen = async () => { polled++; return { rc: 2, text: "" }; };
    const r = await run(w);
    assert.equal(r.terminalReason, "merged"); assert.equal(polled, 0);
    assert.match(traj(w)[0], /\| Merge \| required \(no required checks: merged right after review\) \|/);
  });
  it("required with a pending required check waits (backoff) then merges", async () => {
    const w = world(); const seqs = [states({ build: "pending" }), states({ build: "pending" }), states({ build: "success", other: "failure" })]; let sleeps = 0;
    w.io.requiredChecks = async () => ["build"]; w.io.checkStates = async () => seqs.shift();
    const s = w.io.sleep; w.io.sleep = async (ms) => { sleeps++; return s(ms); };
    const r = await run(w);
    assert.equal(r.terminalReason, "merged"); assert.equal(sleeps, 2);
    assert.match(traj(w)[0], /\| Merge \| required \(build\) \|/);
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
  });
  it("required with a failing required check is needs-human; slow required check is ci-pending", async () => {
    const w = world(); w.io.requiredChecks = async () => ["build"]; w.io.checkStates = async () => states({ build: "failure" });
    assert.equal((await run(w)).terminalReason, "needs-human"); assert.equal(w.merges.length, 0);
    const w2 = world(); w2.io.requiredChecks = async () => ["build"]; w2.io.checkStates = async () => states({ build: "pending" });
    assert.equal((await run(w2, { ciMaxMinutes: 5 })).terminalReason, "ci-pending");
  });
  it("all waits for every check (waitCiGreen); none merges immediately", async () => {
    const w = world({ waits: [{ rc: 2, text: "" }] }); let req = 0; w.io.requiredChecks = async () => { req++; return []; };
    assert.equal((await run(w, { mergeWait: "all" })).terminalReason, "merged");
    assert.equal(w.waits.length, 0); assert.equal(req, 0);
    assert.match(traj(w)[0], /\| Merge \| all \|/);
    const w2 = world({ waits: [{ rc: 1, text: "red" }] });
    assert.equal((await run(w2, { mergeWait: "none" })).terminalReason, "merged");
    assert.equal(w2.waits.length, 1); assert.deepEqual(w2.merges[0].slice(-2), ["--match-head-commit", w2.head]);
  });
});

describe("prompts", () => {
  it("builder prompt keeps the short developer opening and the no-push rule", () => {
    const p = builderPrompt(7);
    assert.match(p, /Resolve issue #7 \(read it with gh issue view 7 --comments\)/);
    assert.match(p, /Do not push or touch GitHub/);
    assert.match(p, /result\.json/);
  });

  it("reviewer system prompt is at most 1.5k tokens and holds only the two questions", () => {
    assert.ok(approxTokens(REVIEWER_SYSTEM) <= 1500);
    assert.match(REVIEWER_SYSTEM, /Does this change fix the issue as described\?/);
    assert.match(REVIEWER_SYSTEM, /introduce a regression/);
    for (const banned of [/edge/i, /style/i, /harden/i, /nice.to.have/i, /severity/i, /nit/i, /optional/i, /refactor/i, /naming/i, /performance/i, /security/i]) {
      assert.doesNotMatch(REVIEWER_SYSTEM, banned);
    }
    assert.equal((REVIEWER_SYSTEM.match(/^\d\. /gm) ?? []).length, 2);
  });

  it("the full reviewer prompt for a typical diff stays under 1.5k tokens of instructions plus content", () => {
    const p = reviewerPrompt({ issue: { number: 7, title: "t", body: "b" }, diff: "x".repeat(2000) });
    assert.match(p, /<diff>/);
    assert.ok(approxTokens(REVIEWER_SYSTEM) + approxTokens(reviewerPrompt({ issue: { number: 7, title: "t", body: "b" }, diff: "" })) <= 1500);
  });

  it("parseVerdict: flags decide, garbage is null", () => {
    assert.equal(parseVerdict(ok({ evidence: "a.js:1", checked: "c" })).evidence, "a.js:1");
    assert.equal(parseVerdict(ok()).fail, false);
    assert.equal(parseVerdict(ok({ regression: true })).fail, true);
    assert.equal(parseVerdict(bad()).fail, true);
    assert.equal(parseVerdict("no json"), null);
    assert.equal(parseVerdict('{"verdict":"FAIL","reason":"x"}').fail, true);
  });
});

describe("run-issue routing", () => {
  const mk = () => { const seen = {}; return { seen, dir: tmpDir("core-cli-"), emitTelemetry: async () => {}, leanIo: {}, io: { gh: async () => "o/r\n" },
    leanModule: { runCore: async (o) => { seen.core = o.path; return { terminalReason: "merged" }; } }, runIssue: async () => { seen.full = true; return { terminalReason: "merged" }; } }; };
  const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

  it("default (no --path) runs the core work-on", async () => {
    const d = mk();
    await quiet(() => runFromCli(["7", "--lane", "staging", "--repo", "o/r"], d));
    assert.equal(d.seen.core, "core"); assert.ok(!d.seen.full);
  });

  it("--path lean and --path auto are aliases of the core", async () => {
    for (const p of ["lean", "auto", "core"]) {
      const d = mk();
      await quiet(() => runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--path", p], d));
      assert.ok(d.seen.core && !d.seen.full, p);
    }
  });

  it("--path full still routes to the old engine", async () => {
    const d = mk();
    await quiet(() => runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--path", "full"], d));
    assert.ok(d.seen.full); assert.equal(d.seen.core, undefined);
  });

  it("bad --path errors; --retry is rejected on the core path", async () => {
    await assert.rejects(runFromCli(["7", "--lane", "staging", "--path", "bogus"], mk()), /--path must be/);
    await assert.rejects(runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--retry"], mk()), /not supported with the core path/);
    assert.deepEqual(ENGINE_PATHS, ["core", "full", "lean", "auto"]);
  });
});

describe("orchestrate", () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const harness = (bodies, outcomes = {}) => {
    const log = { starts: [], ends: [], active: 0, maxActive: 0 };
    return { log,
      readBody: async (n) => bodies[n] ?? "",
      runOne: async (n) => {
        log.starts.push(n); log.active++; log.maxActive = Math.max(log.maxActive, log.active);
        await tick(); await tick();
        log.active--; log.ends.push(n);
        const reason = outcomes[n] ?? "merged";
        return { terminalReason: reason, pr: reason === "merged" ? 100 + n : null, cost_usd: 0.5, detail: reason };
      } };
  };

  it("parseDeps reads Depends-on lines and ignores self references", () => {
    assert.deepEqual(parseDeps("x\n**Depends on**: #4\n**Depends on**: #7\n", 7), [4]);
  });

  it("runs at most K at once", async () => {
    const h = harness({});
    const rows = await orchestrate({ issues: [1, 2, 3, 4, 5, 6], parallel: 2, ...h });
    assert.equal(h.log.maxActive, 2);
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.outcome === "merged"));
  });

  it("default style K=3 runs three in parallel", async () => {
    const h = harness({});
    await orchestrate({ issues: [1, 2, 3, 4], parallel: 3, ...h });
    assert.equal(h.log.maxActive, 3);
  });

  it("a dependent waits until its dependency has merged", async () => {
    const h = harness({ 2: "**Depends on**: #1" });
    await orchestrate({ issues: [2, 1, 3], parallel: 3, ...h });
    assert.ok(h.log.ends.indexOf(1) < h.log.starts.indexOf(2), JSON.stringify(h.log));
  });

  it("a dependent is skipped, without running, when its dependency ends needs-human (transitively)", async () => {
    const h = harness({ 2: "**Depends on**: #1", 3: "**Depends on**: #2" }, { 1: "needs-human" });
    const rows = await orchestrate({ issues: [1, 2, 3, 4], parallel: 3, ...h });
    assert.deepEqual(rows.map((r) => r.outcome), ["needs-human", "skipped", "skipped", "merged"]);
    assert.ok(!h.log.starts.includes(2) && !h.log.starts.includes(3));
    assert.match(rows[1].detail, /#1/);
  });

  it("#4124 dependency-open requeues the issue behind an out-of-set dependency and does not skip its dependents", async () => {
    const log = [];
    let firstRun = true;
    const rows = await orchestrate({ issues: [1, 2], parallel: 2,
      readBody: async (n) => (n === 2 ? "**Depends on**: #1" : ""),
      runOne: async (n) => {
        log.push(n);
        if (n === 1 && firstRun) { firstRun = false; return { terminalReason: "dependency-open", dependencies: [9], detail: "depends on #9" }; }
        return { terminalReason: "merged", pr: 100 + n };
      } });
    assert.deepEqual(log, [1, 9, 1, 2]);
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"], [9, "merged"]]);
  });

  it("#4124 a repeated dependency-open stops after the requeue cap", async () => {
    const h = harness({}, { 1: "dependency-open" });
    let runs = 0;
    const rows = await orchestrate({ issues: [1], readBody: h.readBody,
      runOne: async (n) => { if (n === 1) { runs++; return { terminalReason: "dependency-open", dependencies: [5] }; } return { terminalReason: "merged" }; } });
    assert.equal(runs, 3);
    assert.equal(rows[0].outcome, "dependency-open");
  });

  it("#4124 decomposed runs its sub-issues and the parent's dependents wait on them", async () => {
    const log = [];
    const rows = await orchestrate({ issues: [1, 2], parallel: 3,
      readBody: async (n) => ({ 2: "**Depends on**: #1", 12: "**Parent**: #1\n**Depends on**: #11" })[n] ?? "",
      runOne: async (n) => {
        log.push(`start ${n}`); await new Promise((r) => setImmediate(r)); log.push(`end ${n}`);
        return n === 1 ? { terminalReason: "decomposed", subissues: [11, 12] } : { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[1, "decomposed"], [2, "merged"], [11, "merged"], [12, "merged"]]);
    assert.ok(log.indexOf("end 11") < log.indexOf("start 12"));
    assert.ok(log.indexOf("end 12") < log.indexOf("start 2"));
  });

  it("a dependency that closed as invalid does not block", async () => {
    const h = harness({ 2: "**Depends on**: #1" }, { 1: "invalid" });
    const rows = await orchestrate({ issues: [1, 2], parallel: 2, ...h });
    assert.equal(rows[1].outcome, "merged");
  });

  it("a dependency cycle is skipped rather than hanging; a thrown run is an engine-error row", async () => {
    const h = harness({ 1: "**Depends on**: #2", 2: "**Depends on**: #1" });
    const rows = await orchestrate({ issues: [1, 2], parallel: 2, ...h });
    assert.ok(rows.every((r) => r.outcome === "skipped"));
    const rows2 = await orchestrate({ issues: [9], runOne: async () => { throw new Error("boom"); }, readBody: async () => "" });
    assert.equal(rows2[0].outcome, "engine-error");
  });

  it("#4122 same-file issues run in parallel; a needs-human peer does not skip them", async () => {
    const h = harness({ 1: "Fix `app/scrape_phases.py` retry", 2: "Also touches `app/scrape_phases.py`", 3: "See app/scrape_phases.py" }, { 1: "needs-human" });
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 3, ...h });
    assert.equal(h.log.maxActive, 3);
    assert.deepEqual(rows.map((r) => r.outcome), ["needs-human", "merged", "merged"]);
  });

  it("#4122 /orchestrate spec builds no blocking edge from file overlap and skips only through explicit/logical edges", async () => {
    const { readFileSync } = await import("node:fs");
    const spec = readFileSync(new URL("../../commands/orchestrate.md", import.meta.url), "utf8");
    assert.doesNotMatch(spec, /\*\*Conflict:\*\*/);
    assert.doesNotMatch(spec, /run one after the\s+other/);
    assert.match(spec, /File overlap is \*\*never\*\* an edge/);
    assert.match(spec, /needs-human[\s\S]*Only\s+explicit or logical edges skip a dependent/);
  });

  it("formatTable prints issue, outcome, PR, cost, minutes", () => {
    const t = formatTable([{ issue: 1, outcome: "merged", pr: 101, cost_usd: 0.5, minutes: 3.2 }, { issue: 2, outcome: "skipped", pr: null, cost_usd: 0, minutes: 0, detail: "dependency #1 ended needs-human" }]);
    assert.match(t, /issue\s+outcome\s+PR\s+cost\s+min/);
    assert.match(t, /#1\s+merged\s+#101\s+\$0\.50\s+3\.2/);
    assert.match(t, /skipped \(dependency #1/);
  });

  it("orchestrateFromCli wires parallel, lane and prints the table", async () => {
    const seen = [];
    const logs = [];
    const l = console.log; console.log = (s) => logs.push(String(s));
    try {
      const res = await orchestrateFromCli(["1", "2", "--parallel", "2", "--lane", "main", "--repo", "o/r"], {
        dir: tmpDir("core-orch-"), emitTelemetry: async () => {}, io: { gh: async () => "o/r\n" },
        leanIo: { gh: async () => JSON.stringify({ body: "" }) },
        leanModule: { runCore: async (o) => { seen.push([o.issue, o.lane, o.repo]); return { terminalReason: "merged", pr: 50 + o.issue, cost_usd: 1, wall_ms: 1 }; } } });
      assert.equal(res.ok, true);
    } finally { console.log = l; }
    assert.deepEqual(seen.sort(), [[1, "main", "o/r"], [2, "main", "o/r"]]);
    assert.ok(logs.some((s) => /issue\s+outcome/.test(s)));
    await assert.rejects(orchestrateFromCli([], {}), /usage/);
  });
});

describe("runCliBackendAsync", () => {
  it("returns the same envelope as runCliBackend, without blocking the event loop", async () => {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const { runCliBackend, runCliBackendAsync } = await import("../runner.mjs");
    const d = tmpDir("core-async-");
    const bin = `${d}/fake-claude`;
    writeFileSync(bin, '#!/bin/sh\nsleep 0.3\necho \'{"result":"hello","session_id":"s-1","total_cost_usd":0.25,"num_turns":2,"duration_ms":300,"usage":{"input_tokens":3,"output_tokens":4}}\'\n');
    chmodSync(bin, 0o755);
    const base = { spec: { name: "t" }, userMessage: "go", systemPrompt: "sys", args: ["1"], cwd: d, bin, logger: { log() {} } };
    let ticks = 0; const iv = setInterval(() => { ticks++; }, 20);
    const a = await runCliBackendAsync(base);
    clearInterval(iv);
    const s = runCliBackend(base);
    assert.ok(ticks >= 5, `event loop kept turning (${ticks} ticks)`);
    assert.deepEqual({ ...a, durationMs: 0 }, { ...s, durationMs: 0 });
    assert.equal(a.sessionId, "s-1"); assert.equal(a.text, "hello"); assert.equal(a.costUsd, 0.25);
  });

  it("surfaces a failing CLI as the same CLI_BACKEND_FAILED error", async () => {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const { runCliBackendAsync } = await import("../runner.mjs");
    const d = tmpDir("core-async-");
    writeFileSync(`${d}/bad`, "#!/bin/sh\necho boom >&2\nexit 3\n"); chmodSync(`${d}/bad`, 0o755);
    await assert.rejects(runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin: `${d}/bad`, logger: { log() {} } }), (e) => e.code === "CLI_BACKEND_FAILED" && /boom/.test(e.message));
  });
});

describe("base-sync (#4100)", () => {
  const CONFLICTING = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  const OKSTATE = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  const gitCalls = (w) => w.calls.filter((c) => c[0] === "git").map((c) => c.slice(1));
  const noRebaseNoForce = (w) => {
    for (const g of gitCalls(w)) {
      assert.notEqual(g[0], "rebase");
      if (g[0] === "push") assert.ok(!g.some((x) => /^(--force|-f$|\+)/.test(x)), `force push: ${g.join(" ")}`);
    }
  };
  const syncComment = (w) => w.comments.find((c) => c.includes("<!-- FORGE:BASE_SYNC -->"));

  it("conflicting PR, clean merge: fetch, merge, push, merge the PR at the new head; no re-review", async () => {
    const w = world({ prView: [CONFLICTING, OKSTATE], mergeResults: ["clean"] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.equal(reviewers(w).length, 1, "no re-review for a conflict-free base merge");
    assert.equal(builders(w).length, 1);
    const g = gitCalls(w);
    assert.ok(g.some((x) => x[0] === "fetch" && x[1] === "origin" && x[2] === "staging"));
    assert.ok(g.some((x) => x[0] === "merge" && x[1] === "--no-edit" && x[2] === "origin/staging"));
    assert.equal(g.filter((x) => x[0] === "push").length, 2, "initial push plus the sync push");
    assert.match(syncComment(w), /## Base Sync[\s\S]*clean merge[\s\S]*not required \(conflict-free base merge\)/);
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
    assert.match(traj(w)[0], /\| Base Sync \| 1 sync\(s\) \|/);
    noRebaseNoForce(w);
  });

  it("no conflict: no Base Sync row detail and no sync comment", async () => {
    const w = world();
    await run(w);
    assert.ok(!syncComment(w));
    assert.match(traj(w)[0], /\| Base Sync \| not needed \| - \|/);
  });

  it("conflicting PR, real conflict: builder resumed with the files, reviewer PASS on the full diff, merge", async () => {
    const w = world({ prView: [CONFLICTING, OKSTATE], mergeResults: ["conflict"], reviews: [ok(), ok()] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const b = builders(w);
    assert.equal(b.length, 2);
    assert.equal(b[1][2], "sess-1", "same session resumed");
    assert.match(b[1][4], /Merging origin\/staging into this branch conflicts in: src\/foo\.js\. Resolve the conflicts preserving both this fix's intent and the base's changes, run the relevant tests, and commit the merge\. Do not push\./);
    assert.equal(reviewers(w).length, 2, "re-review after the conflict resolution");
    assert.match(syncComment(w), /conflicts in `src\/foo\.js`[\s\S]*builder resolved 1 conflicted file[\s\S]*Re-review:\*\* PASS/);
    assert.equal(w.merges.length, 1);
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
    noRebaseNoForce(w);
  });

  it("conflict resolution that the re-review FAILs gets one retry then merges on PASS", async () => {
    const w = world({ prView: [CONFLICTING, OKSTATE], mergeResults: ["conflict"], reviews: [ok(), bad("src/foo.js:4 lost base change"), ok()] });
    assert.equal((await run(w)).terminalReason, "merged");
    assert.equal(reviewers(w).length, 3);
    assert.equal(builders(w).length, 3);
  });

  it("still conflicting after 2 base-syncs ends needs-human with base.conflict, never engine-error", async () => {
    const w = world({ prView: [CONFLICTING], mergeResults: ["clean", "clean", "clean"] });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(r.code, "base.conflict");
    assert.equal(gitCalls(w).filter((x) => x[0] === "merge" && x[1] === "--no-edit").length, 2, "at most 2 base-syncs");
    assert.equal(w.merges.length, 0);
    assert.ok(w.edits.some((e) => e.includes("needs-human")));
  });

  it("unresolved conflict markers after the builder ends needs-human with base.conflict", async () => {
    const w = world({ prView: [CONFLICTING], mergeResults: ["conflict"] });
    w.markers = true;
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human"); assert.equal(r.code, "base.conflict");
    assert.equal(w.merges.length, 0);
    assert.ok(gitCalls(w).some((x) => x[0] === "merge" && x[1] === "--abort"));
  });

  it("a gh pr merge conflict error triggers base-sync, then the merge is retried", async () => {
    const w = world({ prView: [OKSTATE], mergeErrors: ["GraphQL: Pull request is not mergeable (mergePullRequest)"], mergeResults: ["clean"] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.equal(w.mergeAttempts, 2);
    assert.match(syncComment(w), /gh pr merge reported a conflict/);
    noRebaseNoForce(w);
  });

  it("an unrelated gh pr merge error is not a base-sync", async () => {
    const w = world({ mergeErrors: ["GraphQL: validation failed (422)"] });
    const r = await run(w);
    assert.equal(r.terminalReason, "engine-error");
    assert.ok(!syncComment(w));
  });

  it("a resumed run with a conflicting PR syncs (fresh builder when the conflict needs resolving)", async () => {
    const w = world({ prList: [{ number: 77, headRefOid: "x" }], remote: "abc\trefs/heads/feat/issue-7-lean", prView: [CONFLICTING, OKSTATE], mergeResults: ["conflict"], reviews: [ok(), ok()] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const b = builders(w);
    assert.equal(b.length, 1);
    assert.equal(b[0][2], null, "no session id on resume: a fresh builder");
    assert.match(b[0][4], /Merging origin\/staging into this branch conflicts in: src\/foo\.js/);
    assert.equal(w.prs.length, 0);
    noRebaseNoForce(w);
  });

  it("UNKNOWN mergeability with nothing to merge is not treated as a conflict", async () => {
    const w = world({ prView: [{ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, OKSTATE], mergeResults: ["clean"] });
    // a clean merge that changes head would count; here make the merge a no-op by pinning the head
    const orig = w.io.git;
    w.io.git = async (a, o2) => { const r = await orig(a, o2); if (a[0] === "merge" && a[1] === "--no-edit") w.head = "aaaa1111aaaa1111"; return r; };
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.ok(!syncComment(w));
  });
});

describe("usage limit, lease takeover, worktree setup, run tmp (#4101-#4104)", () => {
  const limitErr = (extra) => Object.assign(new Error("claude CLI exited with status 1. You've hit your session limit"), { code: "CLI_BACKEND_FAILED", usageLimit: true, ...extra });
  const failFirstBuilder = (w, err, times = 1) => { const orig = w.io.runner; let n = 0; w.io.runner = async (c) => { if (c.role === "builder" && n++ < times) throw err; return orig(c); }; };
  const projector = (w, lease) => { w.leaseWrites = []; w.io.projector = { readState: async () => (lease ? { v: 1, lease } : null), writeState: async (_i, st) => { w.leaseWrites.push(st); } }; };

  it("#4101 a usage limit with a near reset pauses until the reset, then resumes the same step", async () => {
    const w = world(); const sleeps = [];
    const s0 = w.io.sleep; w.io.sleep = async (ms) => { sleeps.push(ms); return s0(ms); };
    failFirstBuilder(w, limitErr({ resetAtEpochMs: 90000, resetAt: "8:30pm" }));
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.ok(sleeps.includes(90000), `slept until the reset: ${sleeps}`);
    assert.equal(builders(w).length, 1);
  });

  it("#4101 a usage limit with a far reset ends deferred/rate_limited with the reset time, lease released, no needs-human", async () => {
    const w = world(); projector(w, null);
    failFirstBuilder(w, limitErr({ resetAtEpochMs: 3 * 3600 * 1000, resetAt: "8:30pm (Asia/Kolkata)" }));
    const r = await run(w);
    assert.equal(r.terminalReason, "deferred");
    assert.equal(r.code, "rate_limited");
    assert.match(r.detail, /resets at 8:30pm \(Asia\/Kolkata\)/);
    assert.equal(w.edits.some((e) => e.includes("needs-human")), false);
    assert.equal(traj(w).length, 0, "no trajectory comment for a deferral");
    assert.equal(w.leaseWrites.at(-1).lease, null, "lease released");
    assert.equal(w.merges.length, 0);
  });

  it("#4101 unknown reset pauses a bounded number of times, then defers", async () => {
    const w = world(); let sleeps = 0;
    const s0 = w.io.sleep; w.io.sleep = async (ms) => { sleeps++; return s0(ms); };
    failFirstBuilder(w, limitErr(), 99);
    const r = await run(w, { maxSessionLimitPauses: 2 });
    assert.equal(r.terminalReason, "deferred"); assert.equal(r.code, "rate_limited");
    assert.equal(sleeps, 2);
    assert.match(r.detail, /resets at unknown/);
  });

  it("#4101 a non-limit runner error is still engine-error", async () => {
    const w = world(); failFirstBuilder(w, new Error("boom"));
    assert.equal((await run(w)).terminalReason, "engine-error");
  });

  it("#4102 a same-host holder whose pid is gone is taken over immediately; a live one or another host is not", async () => {
    const future = Date.now() + 1e6;
    const dead = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const w = world(); projector(w, { by: "core_4242", until: future, host: "h1", pid: 4242 });
    const r = await run(w, { hostName: "h1", killFn: () => { throw dead; } });
    assert.equal(r.terminalReason, "merged");
    assert.ok(w.leaseWrites.some((x) => x.lease?.host === "h1" && Number.isSafeInteger(x.lease?.pid)), "lease records host and pid");
    const w2 = world(); projector(w2, { by: "core_4242", until: 1e12, host: "h1", pid: 4242 });
    assert.equal((await run(w2, { hostName: "h1", killFn: () => true })).terminalReason, "deferred");
    const w3 = world(); projector(w3, { by: "core_4242", until: 1e12, host: "other-host", pid: 4242 });
    assert.equal((await run(w3, { hostName: "h1", killFn: () => { throw dead; } })).terminalReason, "deferred");
    assert.equal(builders(w3).length, 0);
  });

  it("#4103 a leftover unregistered worktree dir is removed (only this issue's lean dir) before add", async () => {
    const w = world(); const removed = [];
    w.io.fs.exists = async (p) => p === "/wt/lean-7"; w.io.fs.rmdir = async (p) => { removed.push(p); };
    await run(w);
    assert.deepEqual(removed, ["/wt/lean-7"]);
    // a registered worktree dir is left to `git worktree remove`
    const w2 = world(); const removed2 = [];
    w2.io.fs.exists = async () => true; w2.io.fs.rmdir = async (p) => { removed2.push(p); };
    const g = w2.io.git; w2.io.git = async (a, o2) => (a[0] === "worktree" && a[1] === "list" ? "worktree /wt/lean-7\nHEAD abc\n" : g(a, o2));
    await run(w2);
    assert.deepEqual(removed2, []);
    // a worktree root that is not the lean root never deletes anything
    const w3 = world(); const removed3 = [];
    w3.io.fs.exists = async () => true; w3.io.fs.rmdir = async (p) => { removed3.push(p); };
    await run(w3, { worktreeRoot: "/wt" , issue: 7 });
    assert.ok(removed3.every((p) => p === "/wt/lean-7"));
  });

  it("#4103 'already exists' on add cleans the leftover and retries; index.lock and packed-refs.lock are retried", async () => {
    for (const msg of ["fatal: '/wt/lean-7' already exists", "fatal: Unable to create '/r/.git/index.lock': File exists.", "error: cannot lock ref: Unable to create '/r/.git/packed-refs.lock': File exists", "fatal: could not lock config file /r/.git/config: File exists"]) {
      const w = world(); let failed = false; const removed = [];
      w.io.fs.exists = async (p) => failed && p === "/wt/lean-7"; w.io.fs.rmdir = async (p) => { removed.push(p); };
      const g = w.io.git;
      w.io.git = async (a, o2) => { if (a[0] === "worktree" && a[1] === "add" && !failed) { failed = true; throw Object.assign(new Error(msg), { stderr: msg }); } return g(a, o2); };
      const r = await run(w);
      assert.equal(r.terminalReason, "merged", msg);
      if (/already exists/.test(msg)) assert.deepEqual(removed, ["/wt/lean-7"]);
    }
  });

  it("#4104 the builder and reviewer run with a per-run TMPDIR that is removed on every terminal", async () => {
    const mk = (w) => { w.tmpMade = []; w.tmpRemoved = []; w.io.runTmp = { prune: async () => { w.pruned = true; }, make: async (i, id) => { const d = `/home/x/.forge/tmp/runs/${id}`; w.tmpMade.push(d); return d; }, remove: async (d) => { w.tmpRemoved.push(d); } }; };
    const cases = {
      merged: (w) => w,
      "needs-human": (w) => { w.reviews.push(bad(), bad()); return w; },
      "engine-error": (w) => { failFirstBuilder(w, new Error("boom")); return w; },
      deferred: (w) => { failFirstBuilder(w, limitErr({ resetAtEpochMs: 3 * 3600 * 1000 })); return w; },
    };
    for (const [reason, prep] of Object.entries(cases)) {
      const w = world(); mk(w); prep(w);
      const r = await run(w);
      assert.equal(r.terminalReason, reason);
      assert.equal(w.pruned, true);
      assert.equal(w.tmpMade.length, 1);
      assert.match(w.tmpMade[0], /\/\.forge\/tmp\/runs\/7-/);
      assert.deepEqual(w.tmpRemoved, w.tmpMade, `${reason}: removed`);
      for (const e of w.envs) assert.equal(e?.TMPDIR, w.tmpMade[0]);
      if (["merged", "needs-human"].includes(reason)) assert.ok(w.envs.length >= 1);
    }
  });

  it("#4104 makeRunTmp: removes only its own dirs; prune takes only old dirs with a dead owner and our marker", async () => {
    const { mkdirSync, writeFileSync, existsSync, utimesSync } = await import("node:fs");
    const root = tmpDir("core-runs-");
    let t = 1_000_000_000_000;
    const rt = makeRunTmp({ root, now: () => t, host: "h", alive: (pid) => pid === 111 });
    const mine = await rt.make(7, "7-1");
    assert.ok(existsSync(mine));
    assert.equal(await rt.remove(mine), true); assert.ok(!existsSync(mine));
    assert.equal(await rt.remove(`${root}/not-made`), false);
    const outside = tmpDir("core-outside-"); writeFileSync(`${outside}/f`, "x");
    assert.equal(await rt.remove(outside), false); assert.ok(existsSync(outside));
    const own = (name, o2) => { mkdirSync(`${root}/${name}`); writeFileSync(`${root}/${name}/.forge-run-owner`, JSON.stringify({ host: "h", ...o2 })); };
    own("old-dead", { pid: 999, created: t - 7 * 3600 * 1000 });
    own("old-alive", { pid: 111, created: t - 7 * 3600 * 1000 });
    own("fresh-dead", { pid: 999, created: t - 3600 * 1000 });
    own("old-otherhost", { pid: 999, host: "zzz", created: t - 7 * 3600 * 1000 });
    mkdirSync(`${root}/foreign`); writeFileSync(`${root}/foreign/data`, "not ours");
    t += 1;
    const removed = await rt.prune();
    assert.deepEqual(removed.sort(), ["old-dead"]);
    for (const keep of ["old-alive", "fresh-dead", "foreign"]) assert.ok(existsSync(`${root}/${keep}`), keep);
  });

  it("#4104 runCliBackend applies the per-run env to the child", async () => {
    const { runCliBackend } = await import("../runner.mjs");
    let seen;
    runCliBackend({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: tmpDir("core-env-"), logger: { log() {} }, env: { TMPDIR: "/x/run-tmp", CLAUDE_CODE_TMPDIR: "/x/run-tmp" },
      spawnFn: (_b, _a, o2) => { seen = o2.env; return { status: 0, stdout: "{}", stderr: "" }; } });
    assert.equal(seen.TMPDIR, "/x/run-tmp"); assert.equal(seen.CLAUDE_CODE_TMPDIR, "/x/run-tmp");
    assert.equal(seen.ANTHROPIC_API_KEY, undefined);
  });
});

describe("host admission (#4105)", () => {
  const host = (o = {}) => ({ memAvailableMb: () => o.mem ?? 8192, freeMb: async (p) => (o.free ?? { "/tmp": 8192, "/home/x/.forge/tmp": 8192 })[p], loadAvg1: () => o.load ?? 1, cores: () => o.cores ?? 8, tmpPaths: () => ["/home/x/.forge/tmp", "/tmp"] });
  const withHost = (w, h) => { w.io.host = h; w.ghCalls = 0; w.leaseWrites = []; w.io.projector = { readState: async () => { w.leaseReads = (w.leaseReads ?? 0) + 1; return null; }, writeState: async (_i, st) => { w.leaseWrites.push(st); } };
    const g = w.io.gh; w.io.gh = async (a) => { w.ghCalls++; return g(a); }; return w; };

  it("the outcome code is registered", async () => {
    assert.equal(OUTCOME_CODES.HOST_BUSY, "host.busy");
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(new URL("../../docs/OUTCOME-CODES.md", import.meta.url), "utf8"), /`host\.busy`/);
  });

  it("passes with headroom and runs normally", async () => {
    const w = withHost(world(), host());
    assert.equal((await run(w)).terminalReason, "merged");
    assert.ok(w.ghCalls > 0);
  });

  it("low memory: deferred host.busy, no lease, no GitHub call, no worktree", async () => {
    const w = withHost(world(), host({ mem: 1228 }));
    const r = await run(w);
    assert.equal(r.terminalReason, "deferred"); assert.equal(r.code, "host.busy");
    assert.equal(r.detail, "host busy: mem 1.2G < 2G; retry in 60s");
    assert.equal(w.ghCalls, 0); assert.equal(w.leaseWrites.length, 0); assert.equal(w.leaseReads ?? 0, 0);
    assert.equal(w.calls.length, 0, "no git or runner calls");
    assert.deepEqual(w.labels, []);
  });

  it("low tmp space on the run TMPDIR filesystem or on /tmp is deferred host.busy", async () => {
    for (const free of [{ "/tmp": 8192, "/home/x/.forge/tmp": 512 }, { "/tmp": 100, "/home/x/.forge/tmp": 8192 }]) {
      const w = withHost(world(), host({ free }));
      const r = await run(w);
      assert.equal(r.code, "host.busy"); assert.match(r.detail, /tmp \S+ \S+G < 1G/);
      assert.equal(w.ghCalls, 0);
    }
  });

  it("high load per core is deferred; disabled admission runs even on a starved host", async () => {
    const wl = withHost(world(), host({ load: 40, cores: 8 }));
    assert.match((await run(wl)).detail, /load 5\.0\/core > 4/);
    const wd = withHost(world(), host({ mem: 1, free: { "/tmp": 1, "/home/x/.forge/tmp": 1 }, load: 99 }));
    assert.equal((await run(wd, { admission: { enabled: false } })).terminalReason, "merged");
  });

  it("thresholds are configurable; a failing probe does not block", async () => {
    assert.equal((await checkAdmission({ cfg: { min_free_mem_mb: 100 }, host: host({ mem: 500 }) })).ok, true);
    assert.equal((await checkAdmission({ cfg: { min_free_mem_mb: 1000 }, host: host({ mem: 500 }) })).ok, false);
    assert.equal((await checkAdmission({ host: { memAvailableMb: () => { throw new Error("x"); }, tmpPaths: () => { throw new Error("y"); } } })).ok, true);
  });

  it("forge.yaml engine.admission is read (nested or flat) and the CLI prints the deferral as the last line", async () => {
    const { writeFileSync } = await import("node:fs");
    const d = tmpDir("core-adm-");
    writeFileSync(`${d}/forge.yaml`, "engine:\n  admission:\n    enabled: false\n    min_free_mem_mb: 4096\n");
    const a = readAdmission(d);
    assert.equal(a.enabled, false); assert.equal(a.min_free_mem_mb, 4096);
    const lines = []; const l = console.log; console.log = (x) => lines.push(String(x));
    try {
      await runFromCli(["7", "--lane", "staging", "--repo", "o/r"], { dir: tmpDir("core-adm-"), emitTelemetry: async () => {}, leanIo: {}, io: { gh: async () => "o/r\n" },
        leanModule: { runCore: async () => ({ terminalReason: "deferred", code: "host.busy", detail: "host busy: mem 1.2G < 2G; retry in 60s" }) } });
    } finally { console.log = l; }
    assert.equal(lines.at(-1), "issue #7 → deferred (host busy: mem 1.2G < 2G; retry in 60s)");
  });

  it("/orchestrate spec requeues host-busy lanes with a lower K and pauses on rate_limited", async () => {
    const { readFileSync } = await import("node:fs");
    const spec = readFileSync(new URL("../../commands/orchestrate.md", import.meta.url), "utf8");
    assert.match(spec, /host busy[\s\S]*lower the effective K by\s+1 for the next 5 minutes, never below 1/);
    assert.match(spec, /rate_limited[\s\S]*stop launching\s+new lanes until that reset time/);
  });
});

describe("batch robustness (#4112-#4115)", () => {
  const mergeCount = (w) => w.merges.length;

  // ---- #4115 ----
  it("#4115a the builder prompt pins targeted tests, no extra checkouts, no browsers, scratch in $TMPDIR (within budget)", () => {
    const p = builderPrompt(7);
    for (const needle of ["run only targeted tests", "never the full suite", "Never create extra checkouts, copies or base clones", "git show or git diff origin/<base>", "Never install browsers", "$TMPDIR"]) assert.ok(p.includes(needle), needle);
    assert.ok(approxTokens(p) <= 2800, `builder prompt is ${approxTokens(p)} tokens`);
  });

  it("#4115b lane limits wrap the spawn in systemd-run; unset or invalid limits do not", () => {
    const w = wrapLaneLimits("claude", ["--print", "x"], { memory_max: "3G", cpu_quota: "150%" });
    assert.deepEqual(w, { bin: "systemd-run", args: ["--user", "--scope", "-q", "-p", "MemoryMax=3G", "-p", "CPUQuota=150%", "--", "claude", "--print", "x"] });
    assert.deepEqual(wrapLaneLimits("claude", ["a"], null), { bin: "claude", args: ["a"] });
    assert.deepEqual(wrapLaneLimits("claude", ["a"], { memory_max: "lots; rm -rf /", cpu_quota: "x" }), { bin: "claude", args: ["a"] });
    assert.equal(wrapLaneLimits("claude", ["a"], { memory_max: "1G" }).args.includes("CPUQuota=150%"), false);
  });

  it("#4115b the runner wraps only when limits are set AND systemd-run probes available (clean fallback)", async () => {
    const seen = [];
    const runCli = async (o) => { seen.push(o.wrap ? o.wrap("claude", ["a"]).bin : null); return { text: "", usage: null, costUsd: 0, durationMs: 0, turns: 0, sessionId: "s" }; };
    const base = { role: "builder", issue: 1, cwd: process.cwd(), prompt: "p", system: "" };
    await makeLeanRunner({ runCli, probe: () => true })({ ...base, laneLimits: { memory_max: "3G" } });
    await makeLeanRunner({ runCli, probe: () => false })({ ...base, laneLimits: { memory_max: "3G" } });
    await makeLeanRunner({ runCli, probe: () => true })({ ...base });
    assert.deepEqual(seen, ["systemd-run", null, null]);
  });

  it("#4115b integration: a lane under systemd-run --scope really runs in a capped scope (skipped without systemd-run)", { skip: !systemdRunAvailable() }, async () => {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const { runCliBackendAsync } = await import("../runner.mjs");
    const d = tmpDir("core-scope-");
    writeFileSync(`${d}/fake-claude`, '#!/bin/sh\nprintf \'{"result":"%s"}\\n\' "$(cat /proc/self/cgroup | tr -d \'\\n\' | tr / :)"\n'); chmodSync(`${d}/fake-claude`, 0o755);
    const r = await runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin: `${d}/fake-claude`, logger: { log() {} }, wrap: (b, a) => wrapLaneLimits(b, a, { memory_max: "512M", cpu_quota: "100%" }) });
    assert.match(r.text, /\.scope/);
  });

  const hostFor = (state) => ({ memAvailableMb: () => 99999, freeMb: async () => 99999, tmpPaths: () => ["/t"], loadAvg1: () => state.load(), cores: () => 2 });
  const slowBuilder = (w, ms, hook) => { const orig = w.io.runner; w.io.runner = async (c) => { if (c.role !== "builder") return orig(c); hook?.(c); await new Promise((r) => setTimeout(r, ms)); return orig(c); }; };

  it("#4115c the governor pauses the builder's process group over the ceiling and resumes under it; never pauses past the max", async () => {
    const w = world(); const calls = [];
    let load = 20;
    w.io.host = hostFor({ load: () => load });
    slowBuilder(w, 400, (c) => { c.control.pause = () => { calls.push("pause"); return true; }; c.control.resume = () => { calls.push("resume"); load = 1; return true; }; setTimeout(() => { load = 1; }, 150); });
    // host starts under the ceiling at admission, then goes over while the builder runs
    let first = true; const lf = w.io.host.loadAvg1; w.io.host.loadAvg1 = () => { if (first) { first = false; return 1; } return lf(); };
    const r = await run(w, { governorPollMs: 20, admission: { max_load_per_core: 4 } });
    assert.equal(r.terminalReason, "merged");
    assert.deepEqual(calls.slice(0, 2), ["pause", "resume"]);
    // max pause: stays over the whole time; resumed anyway after maxPauseMs and not re-paused
    const w2 = world(); const calls2 = [];
    w2.io.host = hostFor({ load: () => 20 }); let f2 = true; const l2 = w2.io.host.loadAvg1; w2.io.host.loadAvg1 = () => { if (f2) { f2 = false; return 1; } return l2(); };
    slowBuilder(w2, 500, (c) => { c.control.pause = () => { calls2.push("pause"); return true; }; c.control.resume = () => { calls2.push("resume"); return true; }; });
    await run(w2, { governorPollMs: 20, maxPauseMs: 100, admission: { max_load_per_core: 4 } });
    assert.deepEqual(calls2, ["pause", "resume"], "one pause, one forced resume, no flapping");
  });

  it("#4115c 3 CPU-heavy lanes on a 2-core host: admission refuses the third, the governor pauses/resumes the running ones, load stays bounded", async () => {
    const st = { running: 0, paused: 0, peak: 0 };
    const load = () => (st.running - st.paused) * 1.5; // each active lane adds 1.5 load; 2 cores; ceiling 1.0 per core
    const lane = async (i) => {
      const w = world(); w.io.host = hostFor({ load });
      w.io.runner = (orig => async (c) => {
        if (c.role !== "builder") return orig(c);
        st.running++; let paused = false;
        c.control.pause = () => { if (paused) return false; paused = true; st.paused++; return true; };
        c.control.resume = () => { if (!paused) return false; paused = false; st.paused--; return true; };
        st.peak = Math.max(st.peak, load());
        await new Promise((r) => setTimeout(r, 300));
        if (paused) { paused = false; st.paused--; }
        st.running--;
        return orig(c);
      })(w.io.runner);
      return { w, r: await run(w, { issue: 7, governorPollMs: 80, maxPauseMs: 60, admission: { max_load_per_core: 1 } }) };
    };
    const a = lane(1); await new Promise((r) => setTimeout(r, 20)); const b = lane(2); await new Promise((r) => setTimeout(r, 20)); const c = lane(3);
    const res = await Promise.all([a, b, c]);
    assert.equal(res[2].r.code, "host.busy", "third lane refused at admission while two run");
    assert.deepEqual(res.slice(0, 2).map((x) => x.r.terminalReason), ["merged", "merged"]);
    assert.ok(st.peak <= 2 * 1.0 + 1.0, `observed load stays near the ceiling (${st.peak})`);
  });

  // ---- #4113 ----
  it("#4113 a merge failing once with 'Base branch was modified' then succeeding ends merged in a single run", async () => {
    const w = world({ mergeErrors: ["GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)"] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.equal(w.mergeAttempts, 2);
    assert.match(traj(w)[0], /gh pr merge transient failure/);
  });

  it("#4113 persistent transient merge failures end deferred merge.transient, never engine-error", async () => {
    const w = world({ mergeErrors: Array(20).fill("HTTP 502: Bad Gateway") });
    const r = await run(w, { maxMergeRetries: 3 });
    assert.equal(r.terminalReason, "deferred"); assert.equal(r.code, "merge.transient");
    assert.equal(w.mergeAttempts, 4);
    assert.equal(w.edits.some((e) => e.includes("needs-human")), false);
  });

  it("#4113 conflicts still route through base-sync", async () => {
    const w = world({ prView: [{ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }], mergeErrors: ["GraphQL: Pull request is not mergeable (mergePullRequest)"], mergeResults: ["clean"] });
    assert.equal((await run(w)).terminalReason, "merged");
    assert.ok(w.comments.some((c) => c.includes("FORGE:BASE_SYNC")));
  });

  // ---- #4114 ----
  it("#4114 a push failing once with 'remote unpack failed' then succeeding completes the run", async () => {
    const w = world({ pushErrors: ["error: remote unpack failed: unable to create temporary object directory"] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.equal(w.pushes, 2);
  });

  it("#4114 exhausted push retries end deferred push.transient after 4 attempts", async () => {
    const w = world({ pushErrors: Array(10).fill("fatal: the remote end hung up unexpectedly\nerror: RPC failed; HTTP 503") });
    const r = await run(w);
    assert.equal(r.terminalReason, "deferred"); assert.equal(r.code, "push.transient");
    assert.equal(w.pushes, 4);
    assert.equal(w.prs.length, 0);
  });

  it("#4114 a protected-branch or permission rejection fails immediately with no retries", async () => {
    for (const msg of ["remote: error: GH006: Protected branch update failed for refs/heads/x", "fatal: unable to access: The requested URL returned error: 403", "! [remote rejected] x -> x (pre-receive hook declined)"]) {
      const w = world({ pushErrors: [msg, msg, msg] });
      const r = await run(w);
      assert.equal(w.pushes, 1, msg);
      assert.equal(r.terminalReason, "needs-human");
    }
  });

  it("#4118 GitHub's transient '[remote rejected] ... (failed)' and pack write errors are retried, then merge", async () => {
    for (const msg of ["To github.com:o/r.git\n ! [remote rejected] feat/issue-7-lean -> feat/issue-7-lean (failed)",
      "remote: error: unable to write file ./objects/pack/pack-1.pack: No such file or directory\n ! [remote rejected] x -> x (failed)"]) {
      const w = world({ pushErrors: [msg] });
      assert.equal((await run(w)).terminalReason, "merged", msg);
      assert.equal(w.pushes, 2, msg);
    }
  });

  it("#4118 a rerun reuses a local lane branch with unpushed commits instead of resetting it to the base", async () => {
    const w = world();
    const git0 = w.io.git;
    w.io.git = async (a, o) => (a[0] === "rev-list" && a[1] === "--count" && String(a[2]).includes("refs/heads/feat/issue-7-lean")) ? "1\n" : git0(a, o);
    await run(w);
    const adds = w.calls.filter((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add");
    assert.ok(adds.length >= 1);
    assert.ok(adds.every((c) => !c.includes("-B")), JSON.stringify(adds));
    assert.ok(w.calls.some((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add" && c.at(-1) === "feat/issue-7-lean"));
  });

  it("#4114 gh writes (comment) retry on 5xx and secondary rate limits; non-transient errors do not", async () => {
    const w = world({ commentErrors: ["HTTP 502: Bad Gateway", "You have exceeded a secondary rate limit. Please wait a few minutes"] });
    assert.equal((await run(w)).terminalReason, "merged");
    assert.ok(w.comments.length >= 5);
    let n = 0;
    await assert.rejects(retrying(async () => { n++; throw new Error("HTTP 404 Not Found"); }, { transient: PUSH_TRANSIENT_RE, attempts: 4, sleep: async () => {} }), /404/);
    assert.equal(n, 1);
  });

  // ---- #4112 ----
  const fakeCli = async (name, body) => {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const d = tmpDir("core-cli-"); writeFileSync(`${d}/${name}`, `#!/bin/sh\n${body}\n`); chmodSync(`${d}/${name}`, 0o755);
    return { d, bin: `${d}/${name}` };
  };
  const TOOL = `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pytest -x"}}]}}'`;
  const RESULT = `echo '{"type":"result","result":"all done","session_id":"s-9","total_cost_usd":0.5,"num_turns":3,"usage":{"input_tokens":1,"output_tokens":2}}'`;

  it("#4112 no stream activity past the idle threshold is killed as CLI_IDLE; the last tool call and live children are recorded", async () => {
    const { runCliBackendAsync } = await import("../runner.mjs");
    const { d, bin } = await fakeCli("idle", `${TOOL}\nsleep 30 &\nwait`);
    const t0 = Date.now();
    await assert.rejects(runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin, logger: { log() {} }, stream: true, idleMs: 400, maxMs: 20000 }), (e) => {
      assert.equal(e.code, "CLI_IDLE");
      assert.equal(e.lastTool.name, "Bash"); assert.match(e.lastTool.input, /pytest -x/);
      assert.ok(e.children.some((c) => /sleep 30/.test(c.cmd)), JSON.stringify(e.children));
      return true;
    });
    assert.ok(Date.now() - t0 < 8000, "killed promptly, not at the ceiling");
  });

  it("#4112 a session that keeps making progress is not idle-killed; the final stream result is the envelope", async () => {
    const { runCliBackendAsync } = await import("../runner.mjs");
    const { d, bin } = await fakeCli("busy", `for i in 1 2 3 4 5 6 7 8; do ${TOOL}; sleep 0.15; done\n${RESULT}`);
    const r = await runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin, logger: { log() {} }, stream: true, idleMs: 500, maxMs: 20000 });
    assert.equal(r.text, "all done"); assert.equal(r.sessionId, "s-9"); assert.equal(r.costUsd, 0.5);
  });

  it("#4112 the absolute ceiling still kills a session that never goes idle (CLI_TIMEOUT)", async () => {
    const { runCliBackendAsync } = await import("../runner.mjs");
    const { d, bin } = await fakeCli("forever", `while true; do ${TOOL}; sleep 0.1; done`);
    await assert.rejects(runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin, logger: { log() {} }, stream: true, idleMs: 800, maxMs: 700 }), (e) => e.code === "CLI_TIMEOUT");
  });

  it("#4112 idle kill: uncommitted work is checkpointed and pushed, the builder retries once from the checkpoint, run log names the last tool", async () => {
    const w = world({ dirty: true }); const dir = tmpDir("core-idle-");
    const orig = w.io.runner; let n = 0;
    w.io.runner = async (c) => { if (c.role === "builder" && n++ === 0) throw Object.assign(new Error("idle"), { code: "CLI_IDLE", lastTool: { name: "Bash", input: "pytest" }, children: [{ pid: 9, cmd: "pytest" }] }); return orig(c); };
    const r = await run(w, { dir });
    assert.equal(r.terminalReason, "merged");
    const g = w.calls.filter((c) => c[0] === "git").map((c) => c.slice(1));
    assert.ok(g.some((x) => x[0] === "add" && x[1] === "-A"));
    assert.ok(g.some((x) => x[0] === "commit" && x.includes("wip(forge): checkpoint after idle timeout")));
    assert.ok(w.pushes >= 2, "checkpoint push plus the final push");
    assert.match(builders(w)[0][4], /Continue from it/);
    const killEv = readLog(dir, 7).find((e) => e.event === "CLI_IDLE_KILL");
    assert.equal(killEv.lastTool.name, "Bash"); assert.equal(killEv.children[0].cmd, "pytest");
    assert.match(traj(w)[0], /builder idle timeout: checkpointed, retried once/);
  });

  it("#4112 a second idle or timeout kill ends deferred with cli.idle / cli.timeout (not engine-error), work checkpointed", async () => {
    for (const [code, expected] of [["CLI_IDLE", "cli.idle"], ["CLI_TIMEOUT", "cli.timeout"]]) {
      const w = world({ dirty: true });
      w.io.runner = async (c) => { if (c.role === "builder") throw Object.assign(new Error(code), { code }); return { text: "" }; };
      const r = await run(w);
      assert.equal(r.terminalReason, "deferred", code); assert.equal(r.code, expected);
      assert.equal(w.edits.some((e) => e.includes("needs-human")), false);
      assert.ok(w.pushes >= 1);
    }
  });

  it("#4112 a rerun resumes from the checkpoint branch and tells the builder to continue", async () => {
    const w = world({ prList: [], remote: "abc\trefs/heads/feat/issue-7-lean", lastSubject: "wip(forge): checkpoint after idle timeout" });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.equal(builders(w).length, 1, "builder runs again (a checkpoint is not finished work)");
    assert.match(builders(w)[0][4], /Continue from it/);
    assert.ok(w.calls.some((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add" && c.includes("origin/feat/issue-7-lean")));
  });
});

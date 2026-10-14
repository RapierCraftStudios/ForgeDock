// forge#3833: closed outcome-code enum carried on PHASE_FAILED / blocked PHASE_COMMIT / RUN_TERMINAL.
import { tmpDir } from "./_tmp.mjs";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runIssue } from "../engine.mjs";
import { readLog, deriveState } from "../engine/runlog.mjs";
import { PHASES } from "../engine/phases.mjs";
import { parseState } from "../engine/state.mjs";
import {
  OUTCOME_CODES, OUTCOME_CODES_VERSION, ALL_OUTCOME_CODES, UNCLASSIFIED,
  isOutcomeCode, normalizeCode, codeForRunnerError, codeForTerminalReason } from "../engine/outcome-codes.mjs";
import { SEP, trusted, jsonLines, asComments, inv, builder, remediation, remediationBody } from "./helpers/comments.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
let dir;
beforeEach(() => { dir = tmpDir("fd-codes-"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeWorktreeList(text) {
  const out = ["worktree /repo\nHEAD 0000000\nbranch refs/heads/main\n"];
  for (const m of String(text).matchAll(/\*\*Branch\*\*:\s*`([^`]+)`/g))
    out.push(`worktree /repo/.claude/worktrees/${m[1].replace(/\//g, "-")}\nHEAD 1111111\nbranch refs/heads/${m[1]}\n`);
  return out.join("\n");
}

function fakeWorld() {
  const w = { markers: "", pr: null, prMerged: false, prNeedsHuman: false, issueState: "OPEN", labels: [], commitsAhead: 0, body: "Issue." };
  const io = {
    gh: async (args) => {
      const a = args.join(" ");
      if (a.startsWith("repo view")) return "acme/widgets";
      if (a.startsWith("api ") && a.includes("/comments")) return asComments(w.markers);
      if (a.startsWith("issue comment")) { w.markers += SEP + args[args.indexOf("--body") + 1]; return ""; }
      if (a.startsWith("api graphql")) return JSON.stringify({ data: { repository: { issue: { body: w.body, authorAssociation: "NONE", author: { login: "forge[bot]", __typename: "Bot" }, editor: null } } } });
      if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
      if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
      if (a.startsWith("issue edit")) {
        const i = args.indexOf("--body"); if (i >= 0) w.body = args[i + 1];
        const j = args.indexOf("--add-label"); if (j >= 0) w.labels.push(args[j + 1]);
        return "";
      }
      if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
      if (a.startsWith("pr view")) return JSON.stringify({ number: w.pr, state: w.prMerged ? "MERGED" : "OPEN", mergedAt: w.prMerged ? "t" : null, labels: w.prNeedsHuman ? [{ name: "needs-human" }] : [] });
      return "";
    },
    git: async (args) => (args[0] === "worktree" ? fakeWorktreeList(w.markers) : String(w.commitsAhead)),
  };
  return { w, io };
}
const run = (extra) => runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", now: () => 1000, maxAttempts: 2, ...extra });
const events = (name) => readLog(dir, 42).filter((e) => e.event === name);
const REVIEW_NEXT = "REVIEW_RESULT:\n  status: NEXT\n  next: remediate\n  remediation: inpr-fix\n";

// Every enum code and how this suite covers it. Reserved codes have no structured evidence source yet
// (see docs/OUTCOME-CODES.md) so only the enum membership is asserted for them.
const COVERAGE = {
  "review.changes_requested": "review.detectOutcome", "review.escalated": "review.detectOutcome",
  "review.rereview_skipped": "reserved", "review.blocking_issue": "review.detectOutcome", "review.pr_open": "review.detectOutcome", "review.ci_pending_timeout": "engine", "build.acceptance_failed": "build.detectOutcome",
  "build.acceptance_malformed": "reserved", "build.size_over_gate": "reserved",
  "build.cohesive": "reserved", "remediate.no_marker": "remediate.detectOutcome",
  "remediate.deferred_live_run": "remediate.detectOutcome", "remediate.re_escalated": "remediate.detectOutcome",
  "remediate.unfixable": "remediate.detectOutcome", "remediate.inpr_requested": "remediate.detectOutcome", "infra.cli_spawn_transient": "engine", "cli.timeout": "engine", "cli.spawn_failed": "lean", "ci.red": "reserved", "ci.timeout": "reserved",
  "base.conflict": "reserved", "rate_limited": "engine", "host.busy": "lean", "merge.transient": "lean", "push.transient": "lean", "cli.idle": "lean", "path.switch_conflict": "engine", "engine.error": "engine", "infra.disk_quota": "engine", "lease.held": "engine",
  "dependency.open": "engine", "dependency.unreadable": "engine", "dependency.blocked": "lean",
  "lane.mismatch": "lean", "lane.default_branch": "lean", "lane.branch_missing": "lean", "lane.unresolved": "lean",
  "invalid": "engine", "decomposed": "investigate.detectOutcome", "completed": "engine",
  "builder.blocked": "lean", "builder.block_untyped": "lean", "builder.no_evidence": "lean", "builder.no_commit": "lean",
  "review.failed": "lean", "review.no_verdict": "lean", "merge.head_mismatch": "lean",
  "awaiting_merge": "codeForTerminalReason", "unclassified": "engine",
};

describe("outcome-codes module", () => {
  it("is a frozen, versioned closed enum with the documented fallback", () => {
    assert.equal(OUTCOME_CODES_VERSION, 1);
    assert.ok(Object.isFrozen(OUTCOME_CODES));
    assert.equal(UNCLASSIFIED, "unclassified");
    assert.ok(isOutcomeCode("ci.red"));
    assert.ok(!isOutcomeCode("made.up") && !isOutcomeCode(undefined) && !isOutcomeCode(7));
  });
  it("normalizeCode maps absent/unknown to unclassified and never throws", () => {
    for (const bad of [undefined, null, "", "nope", 3, {}]) assert.equal(normalizeCode(bad), "unclassified");
    assert.equal(normalizeCode("build.cohesive"), "build.cohesive");
  });
  it("every enum code has a declared coverage entry (no code ships untested)", () => {
    assert.deepEqual([...ALL_OUTCOME_CODES].sort(), Object.keys(COVERAGE).sort());
  });
  it("codeForRunnerError uses err.code / session-limit evidence only", () => {
    for (const code of ["NO_API_KEY", "NO_SDK", "CLI_BACKEND_FAILED", "PHASE_ARGS_INVALID", "CLI_MAX_TURNS"])
      assert.equal(codeForRunnerError({ code, message: "rate limit hit" }), "engine.error");
    assert.equal(codeForRunnerError({ code: "CLI_BACKEND_FAILED", usageLimit: true }), "rate_limited");
    assert.equal(codeForRunnerError({ code: "CLI_BACKEND_FAILED", resetAtEpochMs: 5 }), "rate_limited");
    assert.equal(codeForRunnerError({ code: "CLI_SPAWN_FAILED", spawnErrno: "E2BIG" }), "cli.spawn_failed");
    assert.equal(codeForRunnerError(new Error("x")), "unclassified");
    assert.equal(codeForRunnerError(null), "unclassified");
  });
  it("codeForTerminalReason maps single-cause reasons and leaves needs-human unclassified", () => {
    assert.equal(codeForTerminalReason("merged"), "completed");
    assert.equal(codeForTerminalReason("awaiting-merge"), "awaiting_merge");
    assert.equal(codeForTerminalReason("invalid"), "invalid");
    assert.equal(codeForTerminalReason("decomposed"), "decomposed");
    assert.equal(codeForTerminalReason("engine-error"), "engine.error");
    assert.equal(codeForTerminalReason("deferred"), "lease.held");
    assert.equal(codeForTerminalReason("dependency-open"), "dependency.open");
    assert.equal(codeForTerminalReason("dependency-unreadable"), "dependency.unreadable");
    assert.equal(codeForTerminalReason("dependency-blocked"), "dependency.blocked");
    assert.equal(codeForTerminalReason("needs-human"), "unclassified");
  });
  it("docs/OUTCOME-CODES.md and the enum agree in both directions, and carry the version", () => {
    const doc = readFileSync(join(__dirname, "../../docs/OUTCOME-CODES.md"), "utf8");
    const documented = [...doc.matchAll(/^\|\s*`([a-z_.]+)`\s*\|/gm)].map((m) => m[1]);
    assert.deepEqual([...documented].sort(), [...ALL_OUTCOME_CODES].sort());
    assert.ok(doc.includes(`version ${OUTCOME_CODES_VERSION}`) || doc.includes(`Version: ${OUTCOME_CODES_VERSION}`));
  });
});

describe("detectOutcome carries codes from structured evidence", () => {
  const base = { v: 0, run: "r", issue: 42, lane: "staging", committed: [], phase: null, branch: null, pr: null, terminal: false, terminalReason: null, lease: null };
  const phase = (id) => PHASES.find((p) => p.id === id);
  const ioWith = (...cs) => ({ gh: async () => jsonLines(cs.map((c) => (typeof c === "string" ? trusted(c) : c))), git: async () => "0" });
  const gate = (result) => `<!-- FORGE:DIFF_SIZE -->\n## Diff Size\n\nresult: ${result}\n### Split Proposal\n- **A** — a.mjs\n`;

  it("investigate: INVALID -> invalid, decomposed -> decomposed", async () => {
    const inv1 = await phase("investigate").detectOutcome(base, ioWith(inv("INVALID").slice(1)));
    assert.equal(inv1.code, "invalid");
    const body = inv("COMPLETE", { decompose: true }).slice(1);
    const o = await phase("investigate").detectOutcome(base, { gh: async (args) => (args.join(" ").includes("/comments") ? jsonLines([trusted(body)]) : JSON.stringify({ body: "Issue." })), git: async () => "0" });
    assert.equal(o.code, "decomposed");
  });
  it("build: a blocked acceptance gate -> build.acceptance_failed", async () => {
    const o = await phase("build").detectOutcome({ ...base, committed: ["investigate"] }, ioWith("<!-- FORGE:ACCEPTANCE_GATE -->\nx\n<!-- FORGE:ACCEPTANCE_GATE:FAILED -->"));
    assert.equal(o.status, "failed");
    assert.equal(o.code, "build.acceptance_failed");
  });
  it("build: OVER + Split Proposal never routes to decompose (forge#3862)", async () => {
    const o = await phase("build").detectOutcome({ ...base, committed: ["investigate"] }, ioWith("<!-- FORGE:INVESTIGATOR -->", gate("OVER")));
    assert.notEqual(o.terminalReason, "decomposed");
    assert.notEqual(o.code, "build.size_over_gate");
  });
  it("remediate: no marker, deferral, RE-ESCALATED, UNFIXABLE", async () => {
    const r = phase("remediate");
    const st = { ...base, pr: 7 };
    assert.equal((await r.detectOutcome(st, ioWith("nothing"))).code, "remediate.no_marker");
    const deferred = "<!-- FORGE:REMEDIATION_DEFERRED -->\n## Remediation Deferred\n\npr=7\nkind=lease";
    const d = await r.detectOutcome(st, ioWith(deferred));
    assert.equal(d.reason, "deferred");
    assert.equal(d.code, "remediate.deferred_live_run");
    assert.equal((await r.detectOutcome(st, ioWith(remediationBody("RE-ESCALATED to human")))).code, "remediate.re_escalated");
    assert.equal((await r.detectOutcome(st, ioWith(remediationBody("UNFIXABLE")))).code, "remediate.unfixable");
  });
  it("remediate: an unrecognized re-gate outcome carries no code (engine records unclassified)", async () => {
    const o = await phase("remediate").detectOutcome({ ...base, pr: 7 }, ioWith(remediationBody("WEIRD")));
    assert.equal(o.status, "failed");
    assert.equal(o.code, undefined);
  });
});

describe("runIssue records codes on the run log and FORGE:STATE", () => {
  it("runner throwing NO_API_KEY: PHASE_FAILED-free fail-fast terminal is engine.error and persisted", async () => {
    const { w, io } = fakeWorld();
    const runner = async () => { throw Object.assign(new Error("no key"), { code: "NO_API_KEY" }); };
    const res = await run({ io, runner });
    assert.equal(res.terminalReason, "engine-error");
    assert.equal(res.code, "engine.error");
    const t = events("RUN_TERMINAL").at(-1);
    assert.equal(t.code, "engine.error");
    assert.equal(deriveState(readLog(dir, 42)).outcomeCode, "engine.error");
    assert.equal(parseState(w.body).outcomeCode, "engine.error");
  });
  it("a session limit that outlasts the pause budget terminates as rate_limited", async () => {
    const { io } = fakeWorld();
    const runner = async () => { throw Object.assign(new Error("limit"), { code: "CLI_BACKEND_FAILED", usageLimit: true }); };
    const res = await run({ io, runner, maxSessionLimitPauses: 0 });
    assert.equal(res.code, "rate_limited");
    assert.equal(events("RUN_TERMINAL").at(-1).code, "rate_limited");
  });
  it("runner throwing a plain error on every attempt: attempts are unclassified, the exhausted terminal is engine.error", async () => {
    const { io } = fakeWorld();
    const runner = async () => { throw new Error("flaky"); };
    const res = await run({ io, runner });
    assert.equal(res.code, "engine.error");
    const failed = events("PHASE_FAILED");
    assert.ok(failed.length >= 1);
    for (const f of failed) assert.equal(f.code, "unclassified"); // a plain Error has no err.code evidence
  });
  it("investigate INVALID terminates with code invalid", async () => {
    const { w, io } = fakeWorld();
    const runner = async () => { w.markers += inv("INVALID"); return { status: "complete" }; };
    const res = await run({ io, runner });
    assert.equal(res.terminalReason, "invalid");
    assert.equal(events("RUN_TERMINAL").at(-1).code, "invalid");
  });
  it("review handoff and remediate failure: codes on PHASE_COMMIT, PHASE_FAILED and the needs-human terminal", async () => {
    const { w, io } = fakeWorld();
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") w.markers += inv("COMPLETE");
      if (commandName === "work-on/build") { w.markers += builder("fix/b"); w.commitsAhead = 2; }
      if (commandName === "work-on/review") { w.pr = 7; return { status: "complete", text: REVIEW_NEXT }; }
      return { status: "complete" };
    };
    const res = await run({ io, runner });
    assert.equal(res.terminalReason, "needs-human");
    const handoff = events("PHASE_COMMIT").find((e) => e.phase === "review");
    assert.equal(handoff.terminalReason, "needs-human");
    assert.equal(handoff.code, "review.changes_requested");
    const failed = events("PHASE_FAILED").filter((e) => e.phase === "remediate");
    assert.ok(failed.length > 0);
    for (const f of failed) { assert.equal(f.code, "remediate.no_marker"); assert.match(f.reason, /marker/); }
    assert.equal(res.code, "remediate.no_marker");
    assert.equal(events("RUN_TERMINAL").at(-1).code, "remediate.no_marker");
    assert.ok(w.labels.includes("needs-human"));
    assert.equal(parseState(w.body).outcomeCode, "remediate.no_marker");
  });
  it("label-driven review escalation is review.escalated", async () => {
    const { w, io } = fakeWorld();
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") w.markers += inv("COMPLETE");
      if (commandName === "work-on/build") { w.markers += builder("fix/b"); w.commitsAhead = 2; }
      if (commandName === "work-on/review") { w.pr = 7; w.prNeedsHuman = true; }
      return { status: "complete" };
    };
    await run({ io, runner });
    assert.equal(events("PHASE_COMMIT").find((e) => e.phase === "review").code, "review.escalated");
  });
  it("unmapped failure: unclassified code with the raw reason retained", async () => {
    const { w, io } = fakeWorld();
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") w.markers += inv("COMPLETE");
      if (commandName === "work-on/build") { w.markers += builder("fix/b"); w.commitsAhead = 2; }
      return { status: "complete" }; // review never opens a PR
    };
    const res = await run({ io, runner });
    assert.equal(res.terminalReason, "needs-human");
    const f = events("PHASE_FAILED").filter((e) => e.phase === "review");
    assert.ok(f.length > 0);
    for (const e of f) { assert.equal(e.code, "unclassified"); assert.equal(e.reason, "no PR created"); }
    const t = events("RUN_TERMINAL").at(-1);
    assert.equal(t.code, "unclassified");
    assert.match(t.detail, /failed after/);
  });
  it("a made-up code from a detector is rewritten to unclassified", async () => {
    const { w, io } = fakeWorld();
    const review = PHASES.find((p) => p.id === "review");
    const orig = review.detectOutcome;
    review.detectOutcome = async () => ({ status: "failed", detail: "weird", code: "totally.made_up", retryable: false });
    try {
      const runner = async ({ commandName }) => {
        if (commandName === "work-on/investigate") w.markers += inv("COMPLETE");
        if (commandName === "work-on/build") { w.markers += builder("fix/b"); w.commitsAhead = 2; }
        return { status: "complete" };
      };
      await run({ io, runner });
    } finally { review.detectOutcome = orig; }
    const f = events("PHASE_FAILED").find((e) => e.phase === "review");
    assert.equal(f.code, "unclassified");
    assert.equal(f.reason, "weird");
  });
  it("deriveState round-trips the code through commit, terminal and reopen", () => {
    const evs = [
      { seq: 1, event: "RUN_START", issue: 1, run: "r", lane: "staging" },
      { seq: 2, event: "PHASE_COMMIT", phase: "review", outputs: { pr: 7 }, terminalReason: "needs-human", code: "review.escalated" },
      { seq: 3, event: "RUN_TERMINAL", reason: "engine-error", code: "engine.error" },
    ];
    assert.equal(deriveState(evs).outcomeCode, "engine.error");
    assert.equal(deriveState(evs.slice(0, 2)).outcomeCode, "review.escalated");
    assert.equal(deriveState([...evs, { seq: 4, event: "RUN_REOPEN" }]).outcomeCode, "review.escalated");
    assert.equal(deriveState([...evs, { seq: 4, event: "RUN_NEXT_CYCLE" }]).outcomeCode, null);
  });
  it("a healthy run ends with code completed", async () => {
    const { w, io } = fakeWorld();
    const runner = async ({ commandName }) => {
      if (commandName === "work-on/investigate") w.markers += inv("COMPLETE");
      if (commandName === "work-on/build") { w.markers += builder("fix/b"); w.commitsAhead = 2; }
      if (commandName === "work-on/review") { w.pr = 7; w.prMerged = true; }
      if (commandName === "work-on/close") { w.issueState = "CLOSED"; w.labels.push("workflow:merged"); }
      return { status: "complete" };
    };
    const res = await run({ io, runner });
    assert.equal(res.terminalReason, "merged");
    assert.equal(events("RUN_TERMINAL").at(-1).code, "completed");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHASES, pickPhase, closeUnbalancedFence } from "../engine/phases.mjs";
import { appendEvent } from "../engine/runlog.mjs";
import { loadInvariants, assertCloseInvariants } from "../engine/invariants.mjs";

const base = { v: 0, run: "r1", issue: 42, lane: "staging", committed: [], phase: null,
  branch: null, pr: null, terminal: false, terminalReason: null, lease: null };

describe("pickPhase", () => {
  it("returns the first uncommitted phase whose entryCondition holds", () => {
    assert.equal(pickPhase(base).id, "investigate");
    assert.equal(pickPhase({ ...base, committed: ["investigate"] }).id, "context");
  });

  it("returns null once all phases are committed", () => {
    const all = PHASES.map(p => p.id);
    assert.equal(pickPhase({ ...base, committed: all }), null);
  });

  it("returns null when the state is already terminal", () => {
    assert.equal(pickPhase({ ...base, terminal: true, terminalReason: "invalid" }), null);
  });

  // forge#2379: decompose/remediate coverage.
  it("returns 'decompose' when investigate committed with terminalReason 'decomposed'", () => {
    const state = { ...base, committed: ["investigate"], terminalReason: "decomposed" };
    assert.equal(pickPhase(state).id, "decompose");
  });

  it("does NOT return 'decompose' when investigate committed but terminalReason is unset (normal happy path)", () => {
    const state = { ...base, committed: ["investigate"], terminalReason: null };
    assert.equal(pickPhase(state).id, "context");
  });

  it("returns 'remediate' when review committed with terminalReason 'needs-human'", () => {
    const state = {
      ...base,
      committed: ["investigate", "context", "architect", "build", "review"],
      terminalReason: "needs-human",
    };
    assert.equal(pickPhase(state).id, "remediate");
  });

  it("does NOT return 'remediate' when review committed but terminalReason is unset (normal happy path)", () => {
    const state = {
      ...base,
      committed: ["investigate", "context", "architect", "build", "review"],
      terminalReason: null,
    };
    assert.equal(pickPhase(state).id, "close");
  });

  it("build.detectOutcome fails when there are no commits ahead of base (encodes #1305)", async () => {
    const build = PHASES.find(p => p.id === "build");
    const io = {
      gh: async () => JSON.stringify([{ body: "<!-- FORGE:BUILDER --> done <!-- FORGE:BUILDER:COMPLETE -->" }]),
      git: async () => "0", // rev-list count = 0 commits ahead
    };
    const outcome = await build.detectOutcome({ ...base, branch: "fix/x-42" }, io);
    assert.equal(outcome.status, "failed");
  });

  it("build.detectOutcome commits when :COMPLETE marker present AND commits exist", async () => {
    const build = PHASES.find(p => p.id === "build");
    const io = {
      gh: async () => JSON.stringify([{ body: "<!-- FORGE:BUILDER:COMPLETE -->" }]),
      git: async () => "2",
    };
    const outcome = await build.detectOutcome({ ...base, branch: "fix/x-42" }, io);
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.outputs.branch, "fix/x-42");
  });

  it("close.detectOutcome does not throw on malformed gh response and reports failed", async () => {
    const close = PHASES.find(p => p.id === "close");
    const io = {
      gh: async () => "not json {{{",
      git: async () => "0",
    };
    const outcome = await close.detectOutcome({ ...base }, io);
    assert.equal(outcome.status, "failed");
  });

  describe("investigate.detectOutcome", () => {
    const investigate = PHASES.find(p => p.id === "investigate");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    it("INVALID marker -> committed, terminalReason invalid", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith("INVESTIGATION:INVALID"));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("DECOMPOSE:YES -> committed, terminalReason decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith("DECOMPOSE:YES"));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("INVESTIGATION:COMPLETE only -> committed, no terminalReason", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith("INVESTIGATION:COMPLETE"));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, undefined);
    });

    it("no markers -> failed", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith("nothing relevant here"));
      assert.equal(outcome.status, "failed");
    });

    // forge#2387: deterministic scope classification, parsed from the
    // completion comment alongside the verdict.
    it("INVESTIGATION:COMPLETE with **Complexity**: trivial -> outputs.complexity = 'trivial'", async () => {
      const outcome = await investigate.detectOutcome(
        base,
        ioWith("<!-- FORGE:INVESTIGATOR -->\n**Complexity**: trivial\nINVESTIGATION:COMPLETE"),
      );
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.complexity, "trivial");
    });

    it("INVESTIGATION:COMPLETE with **Complexity**: complex -> outputs.complexity = 'complex'", async () => {
      const outcome = await investigate.detectOutcome(
        base,
        ioWith("<!-- FORGE:INVESTIGATOR -->\n**Complexity**: complex\nINVESTIGATION:COMPLETE"),
      );
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.complexity, "complex");
    });

    it("INVESTIGATION:COMPLETE with no **Complexity** field -> outputs.complexity is null (never invented)", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith("INVESTIGATION:COMPLETE"));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.complexity, null);
    });

    it("INVESTIGATION:COMPLETE with an unrecognized complexity value -> outputs.complexity is null", async () => {
      const outcome = await investigate.detectOutcome(
        base,
        ioWith("<!-- FORGE:INVESTIGATOR -->\n**Complexity**: extreme\nINVESTIGATION:COMPLETE"),
      );
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.complexity, null);
    });
  });

  // forge#2387: deterministic scope classification — context/architect
  // reconcile() trivial-skip, checked via reconcile() rather than
  // detectOutcome() because a satisfied reconcile() bypasses runner()
  // entirely (see bin/engine.mjs's runIssue()) — the actual zero-LLM-cost
  // mechanism this issue requires.
  describe("context.reconcile / architect.reconcile — trivial-complexity scope skip (forge#2387)", () => {
    const context = PHASES.find(p => p.id === "context");
    const architect = PHASES.find(p => p.id === "architect");
    const ioNoMarkers = { gh: async () => "", git: async () => "0" };

    it("context.reconcile: state.complexity === 'trivial' -> satisfied with a visible skip reason, no gh call needed", async () => {
      const r = await context.reconcile({ ...base, complexity: "trivial" }, ioNoMarkers);
      assert.equal(r.satisfied, true);
      assert.equal(r.outputs.skipped, true);
      assert.equal(r.outputs.which, "context");
      assert.ok(typeof r.outputs.reason === "string" && r.outputs.reason.length > 0, "skip must carry a non-empty reason — never silent");
    });

    it("architect.reconcile: state.complexity === 'trivial' -> satisfied with a visible skip reason, no gh call needed", async () => {
      const r = await architect.reconcile({ ...base, complexity: "trivial" }, ioNoMarkers);
      assert.equal(r.satisfied, true);
      assert.equal(r.outputs.skipped, true);
      assert.equal(r.outputs.which, "architect");
      assert.ok(typeof r.outputs.reason === "string" && r.outputs.reason.length > 0, "skip must carry a non-empty reason — never silent");
    });

    it("context.reconcile: state.complexity === 'standard' -> falls through to the normal marker-based check (not satisfied without the marker)", async () => {
      const r = await context.reconcile({ ...base, complexity: "standard" }, ioNoMarkers);
      assert.equal(r.satisfied, false);
    });

    it("context.reconcile: state.complexity === 'complex' -> falls through to the normal marker-based check", async () => {
      const r = await context.reconcile({ ...base, complexity: "complex" }, ioNoMarkers);
      assert.equal(r.satisfied, false);
    });

    it("context.reconcile: state.complexity === null (unclassified) -> falls through, fail-safe (no skip)", async () => {
      const r = await context.reconcile({ ...base, complexity: null }, ioNoMarkers);
      assert.equal(r.satisfied, false);
    });

    it("architect.reconcile: state.complexity undefined (base has no such property) -> falls through, fail-safe (no skip)", async () => {
      assert.equal("complexity" in base, false, "sanity: the shared base fixture has no complexity property");
      const r = await architect.reconcile(base, ioNoMarkers);
      assert.equal(r.satisfied, false);
    });

    it("context.reconcile: trivial skip takes priority over an already-posted FORGE:CONTEXT:COMPLETE marker (no gh call is even made)", async () => {
      let ghCalled = false;
      const io = { gh: async () => { ghCalled = true; return "<!-- FORGE:CONTEXT:COMPLETE -->"; }, git: async () => "0" };
      const r = await context.reconcile({ ...base, complexity: "trivial" }, io);
      assert.equal(r.satisfied, true);
      assert.equal(r.outputs.skipped, true);
      assert.equal(ghCalled, false, "the trivial-complexity fast path must return before any gh call — genuinely zero cost");
    });
  });

  // forge#2387 guardrails: "review is never skippable" and "complex ->
  // decompose evaluation is unaffected by complexity classification".
  describe("forge#2387 guardrails — review is never complexity-skippable; decompose is unaffected", () => {
    const review = PHASES.find(p => p.id === "review");
    const decompose = PHASES.find(p => p.id === "decompose");

    it("review.reconcile ignores state.complexity entirely — a trivial classification with no PR still yields not-satisfied", async () => {
      const io = {
        gh: async (args) => (args.join(" ").startsWith("pr list") ? "[]" : ""),
        git: async () => "0",
      };
      const r = await review.reconcile({ ...base, complexity: "trivial", branch: null }, io);
      assert.equal(r.satisfied, false, "review must never be bypassed by complexity — only an actual PR can satisfy it");
    });

    it("decompose.entryCondition is unaffected by state.complexity (still gated solely on terminalReason)", () => {
      assert.equal(
        decompose.entryCondition({ ...base, complexity: "complex", terminalReason: "decomposed" }),
        true,
      );
      assert.equal(
        decompose.entryCondition({ ...base, complexity: "trivial", terminalReason: "decomposed" }),
        true,
        "even a (contradictory-in-practice) trivial+decomposed combination must still route to decompose — complexity never gates this phase",
      );
      assert.equal(
        decompose.entryCondition({ ...base, complexity: "complex", terminalReason: null }),
        false,
      );
    });
  });

  // forge#2379: decompose is now a real phase (previously investigate's
  // "decomposed" terminalReason short-circuited before this phase could ever
  // run — see bin/engine.mjs's isDecomposeHandoff exemption).
  describe("decompose.detectOutcome", () => {
    const decompose = PHASES.find(p => p.id === "decompose");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    it("FORGE:DECOMPOSED:COMPLETE present -> committed, terminalReason decomposed", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith("<!-- FORGE:DECOMPOSED --> spawned sub-issues <!-- FORGE:DECOMPOSED:COMPLETE -->"));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("bare FORGE:DECOMPOSED (no :COMPLETE) -> failed", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith("<!-- FORGE:DECOMPOSED --> in progress"));
      assert.equal(outcome.status, "failed");
    });

    it("no marker at all -> failed", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith("nothing relevant here"));
      assert.equal(outcome.status, "failed");
    });

    it("entryCondition fires only when terminalReason is 'decomposed'", () => {
      assert.equal(decompose.entryCondition({ ...base, terminalReason: "decomposed" }), true);
      assert.equal(decompose.entryCondition({ ...base, terminalReason: null }), false);
      assert.equal(decompose.entryCondition({ ...base, terminalReason: "invalid" }), false);
    });

    it("is always terminal after committing", () => {
      assert.equal(decompose.isTerminalAfter({ ...base, terminalReason: "decomposed" }), true);
    });
  });

  // forge#2379: remediate is now a registered phase — see bin/engine/phases.mjs's
  // "remediate" entry doc comment for the documented limitation that a single
  // continuous runIssue() walk cannot reach it today (review's "blocked"
  // outcome + the needs-human divergence-guard pause both terminate first).
  // These tests exercise detectOutcome/entryCondition directly, which is the
  // acceptance criterion ("pickPhase covers remediate") this issue targets.
  describe("remediate.detectOutcome", () => {
    const remediate = PHASES.find(p => p.id === "remediate");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });
    const remediateBody = (outcome) =>
      `<!-- FORGE:REMEDIATION -->\n**Re-gate outcome**: ${outcome} to staging\n<!-- FORGE:REMEDIATION:COMPLETE -->`;

    it("AUTO-LANDED -> committed, terminalReason merged", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("AUTO-LANDED")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
      assert.equal(outcome.outputs.reGateOutcome, "AUTO-LANDED");
    });

    it("HELD-AWAITING-MERGE -> committed, terminalReason awaiting-merge", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("HELD-AWAITING-MERGE")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "awaiting-merge");
    });

    it("RE-ESCALATED -> committed, terminalReason needs-human", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("RE-ESCALATED")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "needs-human");
    });

    it("UNFIXABLE -> committed, terminalReason needs-human", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("UNFIXABLE")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "needs-human");
    });

    it("FORGE:REMEDIATION:COMPLETE present but Re-gate outcome unrecognized -> failed", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("SOMETHING-ELSE")));
      assert.equal(outcome.status, "failed");
    });

    it("no FORGE:REMEDIATION:COMPLETE marker -> failed", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith("nothing relevant here"));
      assert.equal(outcome.status, "failed");
    });

    it("entryCondition requires review committed AND terminalReason needs-human", () => {
      const reviewCommitted = { ...base, committed: ["build", "review"] };
      assert.equal(remediate.entryCondition({ ...reviewCommitted, terminalReason: "needs-human" }), true);
      assert.equal(remediate.entryCondition({ ...reviewCommitted, terminalReason: null }), false);
      assert.equal(remediate.entryCondition({ ...base, terminalReason: "needs-human" }), false); // review not committed
    });

    it("is always terminal after committing", () => {
      assert.equal(remediate.isTerminalAfter({ ...base, terminalReason: "needs-human" }), true);
    });
  });

  describe("review.detectOutcome", () => {
    const review = PHASES.find(p => p.id === "review");
    const reviewState = { ...base, branch: "fix/x-42" };

    function ioFor({ prList, prView }) {
      return {
        gh: async (args) => {
          const cmd = args.join(" ");
          if (cmd.startsWith("pr list")) return prList;
          if (cmd.startsWith("pr view")) return prView;
          throw new Error(`unexpected gh call: ${cmd}`);
        },
        git: async () => "0",
      };
    }

    it("no PR -> failed", async () => {
      const io = ioFor({ prList: "[]", prView: "" });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "failed");
    });

    it("PR merged -> committed with outputs.pr", async () => {
      const io = ioFor({
        prList: JSON.stringify([{ number: 7 }]),
        prView: JSON.stringify({ number: 7, state: "MERGED", mergedAt: "t", labels: [] }),
      });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.pr, 7);
    });

    it("PR open with needs-human label -> blocked", async () => {
      const io = ioFor({
        prList: JSON.stringify([{ number: 7 }]),
        prView: JSON.stringify({ number: 7, state: "OPEN", mergedAt: null, labels: [{ name: "needs-human" }] }),
      });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
    });
  });

  // forge#2382: engine-native PR creation — review.reconcile now creates a PR
  // itself (io.gh(["pr", "create", ...])) when none exists yet, instead of
  // leaving that entirely to the review-phase LLM.
  describe("review.reconcile — engine-native PR creation (forge#2382)", () => {
    const review = PHASES.find(p => p.id === "review");
    const reviewState = { ...base, branch: "fix/x-42", lane: "staging" };

    /** A scriptable fake GitHub world for the review.reconcile PR-creation path. */
    function fakeGh({ existingPrList = "[]", createOut = "https://github.com/o/r/pull/99", createThrows = false, labels = [] } = {}) {
      const calls = [];
      const gh = async (args) => {
        calls.push(args.join(" "));
        const a = args.join(" ");
        if (a.startsWith("pr list")) return existingPrList;
        if (a.startsWith("pr create")) {
          if (createThrows) throw new Error("pr create rejected");
          return createOut;
        }
        if (a.startsWith("api ")) return JSON.stringify([{ body: "<!-- FORGE:BUILDER:COMPLETE --> did the thing" }]);
        if (a.startsWith("issue view") && a.includes("title,body")) return JSON.stringify({ title: "Fix: thing", body: "Problem description.\nMore." });
        if (a.startsWith("issue view") && a.includes("labels")) return JSON.stringify({ labels: labels.map((n) => ({ name: n })) });
        if (a.startsWith("issue edit")) return "";
        throw new Error(`unexpected gh call: ${a}`);
      };
      const gitCalls = [];
      const git = async (args) => { gitCalls.push(args.join(" ")); return ""; };
      return { gh, git, calls, gitCalls };
    }

    it("adopts an existing PR without creating a new one or pushing", async () => {
      const { gh, git, calls, gitCalls } = fakeGh({ existingPrList: JSON.stringify([{ number: 7 }]) });
      const result = await review.reconcile(reviewState, { gh, git });
      assert.equal(result.outputs.pr, 7);
      assert.ok(!calls.some((c) => c.startsWith("pr create")), "must not create a PR when one is already adopted");
      assert.equal(gitCalls.length, 0, "must not push when adopting an existing PR");
    });

    it("creates a PR when none exists: pushes the branch, calls gh pr create, and sets workflow:in-review", async () => {
      const { gh, git, calls, gitCalls } = fakeGh({ createOut: "https://github.com/o/r/pull/123" });
      const result = await review.reconcile(reviewState, { gh, git });
      assert.equal(result.outputs.pr, 123);
      assert.ok(gitCalls.some((c) => c.startsWith("push origin fix/x-42:fix/x-42")), "must push the branch before creating the PR");
      const createCall = calls.find((c) => c.startsWith("pr create"));
      assert.ok(createCall, "must call gh pr create");
      assert.ok(createCall.includes("--base staging"), "PR base must be the run's lane");
      assert.ok(createCall.includes("--head fix/x-42"));
      assert.ok(calls.some((c) => c.includes("--add-label workflow:in-review")), "must set workflow:in-review once the PR is created");
    });

    it("PR body includes the Closes footer and FORGE:BUILDER content", async () => {
      let capturedBody = null;
      const gh = async (args) => {
        const a = args.join(" ");
        if (a.startsWith("pr list")) return "[]";
        if (a.startsWith("pr create")) {
          const bi = args.indexOf("--body");
          capturedBody = args[bi + 1];
          return "https://github.com/o/r/pull/5";
        }
        if (a.startsWith("api ")) return JSON.stringify([{ body: "<!-- FORGE:BUILDER:COMPLETE --> implemented the fix" }]);
        if (a.startsWith("issue view") && a.includes("title,body")) return JSON.stringify({ title: "Fix: thing", body: "Problem." });
        if (a.startsWith("issue view") && a.includes("labels")) return JSON.stringify({ labels: [] });
        if (a.startsWith("issue edit")) return "";
        throw new Error(`unexpected gh call: ${a}`);
      };
      const git = async () => "";
      const result = await review.reconcile(reviewState, { gh, git });
      assert.equal(result.outputs.pr, 5);
      assert.match(capturedBody, /Closes #42/);
      assert.match(capturedBody, /implemented the fix/);
    });

    it("falls through to null (no PR) when the push fails — LLM-driven path is the safety net", async () => {
      const { gh, calls } = fakeGh();
      const git = async () => { throw new Error("push rejected"); };
      const result = await review.reconcile(reviewState, { gh, git });
      assert.equal(result.satisfied, false);
      assert.equal(result.outputs, undefined);
      assert.ok(!calls.some((c) => c.startsWith("pr create")), "must not attempt PR creation when the push failed");
    });

    it("falls through to null (no PR) when gh pr create itself throws", async () => {
      const { gh, git } = fakeGh({ createThrows: true });
      const result = await review.reconcile(reviewState, { gh, git });
      assert.equal(result.satisfied, false);
      assert.equal(result.outputs, undefined);
    });

    it("does nothing when state.branch is unresolved", async () => {
      const gh = async () => { throw new Error("no gh call should be made"); };
      const git = async () => { throw new Error("no git call should be made"); };
      const result = await review.reconcile({ ...base, branch: null }, { gh, git });
      assert.equal(result.satisfied, false);
      assert.equal(result.outputs, undefined);
    });
  });

  describe("close.detectOutcome", () => {
    const close = PHASES.find(p => p.id === "close");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    // forge#2353: a bare CLOSED state (no workflow:merged label) is NOT proof
    // a PR actually merged — the divergence guard (forge#2352, bin/engine.mjs)
    // can route a closed-as-invalid or otherwise closed-not-merged issue into
    // this phase, and reporting "merged" for that case would inflate
    // run-log/telemetry merge-rate consumers with runs that never shipped a
    // PR. Only workflow:merged (set by the review phase's own merge flow) is
    // proof of an actual merge.
    it("issue CLOSED without workflow:merged label -> committed, terminalReason invalid (#2353)", async () => {
      const io = ioWith(JSON.stringify({ state: "CLOSED", labels: [] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("issue CLOSED with workflow:invalid label (no workflow:merged) -> committed, terminalReason invalid (#2353)", async () => {
      const io = ioWith(JSON.stringify({ state: "CLOSED", labels: [{ name: "workflow:invalid" }] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("workflow:merged label -> committed, terminalReason merged", async () => {
      const io = ioWith(JSON.stringify({ state: "OPEN", labels: [{ name: "workflow:merged" }] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
    });

    it("issue CLOSED AND workflow:merged label -> committed, terminalReason merged", async () => {
      const io = ioWith(JSON.stringify({ state: "CLOSED", labels: [{ name: "workflow:merged" }] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
    });

    it("open + no label -> failed", async () => {
      const io = ioWith(JSON.stringify({ state: "OPEN", labels: [] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "failed");
    });
  });

  // forge#2381: close.execute() — engine-native close, zero LLM tokens.
  describe("close.execute", () => {
    const close = PHASES.find(p => p.id === "close");

    /** A scriptable fake GitHub world recording every gh call made. */
    function fakeGh(initialBody = "Issue.") {
      const w = { body: initialBody, labels: [], issueState: "OPEN", closed: false, calls: [] };
      const gh = async (args) => {
        w.calls.push(args.join(" "));
        const a = args.join(" ");
        if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
        if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels.map(n => ({ name: n })) });
        if (a.startsWith("issue edit")) {
          const bi = args.indexOf("--body"); if (bi >= 0) w.body = args[bi + 1];
          const li = args.indexOf("--add-label"); if (li >= 0) w.labels.push(args[li + 1]);
          return "";
        }
        if (a.startsWith("issue close")) { w.issueState = "CLOSED"; w.closed = true; return ""; }
        if (a.startsWith("issue comment")) return "";
        return "";
      };
      return { w, io: { gh, git: async () => "0" } };
    }

    it("happy path: closes the issue, sets workflow:merged, posts a trajectory comment — no ctx.dir means invariant check is skipped (fail-open)", async () => {
      const { w, io } = fakeGh();
      const state = { ...base, committed: ["investigate", "context", "architect", "build", "review"], pr: 7, branch: "feat/x-1" };
      const outcome = await close.execute(state, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
      assert.equal(w.closed, true);
      assert.ok(w.labels.includes("workflow:merged"));
      assert.ok(w.calls.some(c => c.startsWith("issue comment") ), "posts a FORGE:TRAJECTORY comment");
    });

    it("checks off remaining checklist items in the issue body before closing", async () => {
      const { w, io } = fakeGh("## Acceptance Criteria\n- [ ] one\n- [x] two\n- [ ] three\n");
      const outcome = await close.execute(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(w.body, "## Acceptance Criteria\n- [x] one\n- [x] two\n- [x] three\n");
    });

    it("updates the parent tracker checkbox and closes the parent once all sub-issues are checked", async () => {
      const { w: subW, io: subIo } = fakeGh("**Parent**: #100");
      // Parent world: separate fake, wired so the sub-issue's io.gh routes
      // "issue view 100"/"issue edit 100"/"issue close 100" to the parent state.
      const parent = { body: "- [x] #41\n- [ ] #42\n", labels: [], issueState: "OPEN", closed: false };
      const combinedGh = async (args) => {
        const a = args.join(" ");
        if (a.includes(" 100 ") || a.endsWith(" 100")) {
          if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: parent.body });
          if (a.startsWith("issue edit")) { const bi = args.indexOf("--body"); if (bi >= 0) parent.body = args[bi + 1];
            const li = args.indexOf("--add-label"); if (li >= 0) parent.labels.push(args[li + 1]); return ""; }
          if (a.startsWith("issue close")) { parent.closed = true; parent.issueState = "CLOSED"; return ""; }
        }
        return subIo.gh(args);
      };
      const state = { ...base, issue: 42, committed: ["investigate", "context", "architect", "build", "review"] };
      const outcome = await close.execute(state, { gh: combinedGh, git: async () => "0" });
      assert.equal(outcome.status, "committed");
      assert.equal(parent.body, "- [x] #41\n- [x] #42\n");
      assert.equal(parent.closed, true, "parent closes once every sub-issue checkbox is checked");
    });

    it("does not update the parent tracker when the parent's checklist has no matching sub-issue line", async () => {
      const { w: subW, io: subIo } = fakeGh("**Parent**: #200");
      const parent = { body: "- [ ] #999\n", edited: false };
      const combinedGh = async (args) => {
        const a = args.join(" ");
        if (a.includes(" 200 ") || a.endsWith(" 200")) {
          if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: parent.body });
          if (a.startsWith("issue edit")) { parent.edited = true; return ""; }
        }
        return subIo.gh(args);
      };
      const state = { ...base, issue: 42, committed: ["investigate", "context", "architect", "build", "review"] };
      const outcome = await close.execute(state, { gh: combinedGh, git: async () => "0" });
      assert.equal(outcome.status, "committed");
      assert.equal(parent.edited, false, "no matching '- [ ] #42' line in parent — nothing to update");
    });

    it("project-board sync is a no-op that never throws or blocks the close", async () => {
      const { w, io } = fakeGh();
      const outcome = await close.execute(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
    });

    // forge#2381 (review finding): the invariant check must be a REAL gate, not a
    // vacuous one. An earlier revision appended a synthetic RUN_TERMINAL event
    // before calling assertCloseInvariants(), which guaranteed the only
    // functioning close-scope assertion always passed — the gate could never
    // block anything. These tests pin the honest behavior: real event list,
    // structurally-unsatisfiable assertions excluded by id (not fabricated away).
    describe("close.execute — invariant gate (ctx.dir path)", () => {
      it("run_log_terminal_at_close genuinely FAILS on a real run-log with no RUN_TERMINAL — proving the assertion works and is not inert", () => {
        const results = assertCloseInvariants(loadInvariants(), [{ seq: 1, event: "RUN_START", issue: 42 }]);
        const terminalCheck = results.find((r) => r.id === "run_log_terminal_at_close");
        assert.ok(terminalCheck, "the assertion must exist in forge-invariants.yaml");
        assert.equal(terminalCheck.ok, false, "it must flag a run-log with no RUN_TERMINAL event");
      });

      it("close.execute does NOT block on that same run-log — run_log_terminal_at_close is deliberately excluded, not silently passed", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fd-close-exec-"));
        try {
          // A real, healthy pre-close run-log: RUN_TERMINAL is genuinely absent
          // (engine.mjs writes it only AFTER close commits), which is exactly the
          // state the assertion above flags. execute() must still proceed — via
          // the documented id-based exclusion, NOT via a fabricated event.
          appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
          appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "review", outputs: { pr: 7 } });
          const { w, io } = fakeGh();
          const state = { ...base, committed: ["investigate", "context", "architect", "build", "review"], pr: 7 };
          const outcome = await close.execute(state, io, { dir });
          assert.equal(outcome.status, "committed");
          assert.equal(w.issueState, "CLOSED");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("a violated close-scope assertion returns blocked and performs NO mutating gh call (issue stays OPEN, no workflow:merged)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fd-close-exec-"));
        try {
          // A run-log with NO RUN_TERMINAL, plus an injected assertion carrying
          // the `run_log_terminal_at_close` evaluator id but a DIFFERENT
          // registry id — so it is not excluded, is genuinely evaluated against
          // the real event list, and genuinely fails. This is the violation path
          // a production close would take if any evaluated assertion failed.
          appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
          const { w, io } = fakeGh();
          const failing = [{
            id: "run_log_terminal_at_close",
            scope: "close",
            proposition: "run-log must contain RUN_TERMINAL before close trajectory is posted",
            enforcement: "close",
          }];
          // Sanity: this assertion really does fail on this event list.
          const direct = assertCloseInvariants(failing, [{ seq: 1, event: "RUN_START" }]);
          assert.equal(direct[0].ok, false, "precondition: the injected assertion must fail on a RUN_TERMINAL-less log");

          // ...but execute() excludes it by id, so it must NOT block. Proves the
          // exclusion set is what's doing the work — not a fabricated event.
          const passing = await close.execute(base, io, { dir, invariants: failing });
          assert.equal(passing.status, "committed", "excluded-by-id assertion must not block");

          // Now the SAME assertion with the exclusion lifted: it is evaluated
          // against the real event list, genuinely fails, and must block —
          // before any mutating call. (Overriding the exclusion set is a test
          // seam; production never passes it.)
          const { w: w2, io: io2 } = fakeGh();
          const blocked = await close.execute(base, io2, { dir, invariants: failing, excludeInvariants: new Set() });
          assert.equal(blocked.status, "blocked");
          assert.match(blocked.detail, /close invariant violation/);
          assert.equal(w2.issueState, "OPEN", "issue must NOT be closed when an invariant is violated");
          assert.ok(!w2.labels.includes("workflow:merged"), "workflow:merged must NOT be set when an invariant is violated");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    it("a checklist-edit failure (io.gh throws on 'issue edit') does not block the close — best-effort", async () => {
      const { w, io } = fakeGh("- [ ] one\n");
      const origGh = io.gh;
      io.gh = async (args) => {
        if (args.join(" ").startsWith("issue edit") && args.includes("--body")) throw new Error("transient failure");
        return origGh(args);
      };
      const outcome = await close.execute(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
      assert.equal(w.closed, true, "the load-bearing close still happens despite the checklist-edit failure");
    });
  });

  // Regression tests for #1669: reconcile must require :COMPLETE markers, not bare annotation openers.
  describe("context.reconcile — requires FORGE:CONTEXT:COMPLETE (not bare FORGE:CONTEXT)", () => {
    const context = PHASES.find(p => p.id === "context");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    it("bare FORGE:CONTEXT (partial annotation) -> not satisfied", async () => {
      const r = await context.reconcile(base, ioWith("<!-- FORGE:CONTEXT -->"));
      assert.equal(r.satisfied, false);
    });

    it("FORGE:CONTEXT:COMPLETE present -> satisfied", async () => {
      const r = await context.reconcile(base, ioWith("<!-- FORGE:CONTEXT -->\n<!-- FORGE:CONTEXT:COMPLETE -->"));
      assert.equal(r.satisfied, true);
    });

    it("no marker at all -> not satisfied", async () => {
      const r = await context.reconcile(base, ioWith("nothing here"));
      assert.equal(r.satisfied, false);
    });
  });

  describe("architect.reconcile — requires FORGE:ARCHITECT:COMPLETE (not bare FORGE:ARCHITECT)", () => {
    const architect = PHASES.find(p => p.id === "architect");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    it("bare FORGE:ARCHITECT (partial annotation) -> not satisfied", async () => {
      const r = await architect.reconcile(base, ioWith("<!-- FORGE:ARCHITECT -->"));
      assert.equal(r.satisfied, false);
    });

    it("FORGE:ARCHITECT:COMPLETE present -> satisfied", async () => {
      const r = await architect.reconcile(base, ioWith("<!-- FORGE:ARCHITECT -->\n<!-- FORGE:ARCHITECT:COMPLETE -->"));
      assert.equal(r.satisfied, true);
    });

    it("no marker at all -> not satisfied", async () => {
      const r = await architect.reconcile(base, ioWith("nothing here"));
      assert.equal(r.satisfied, false);
    });
  });

  describe("architect.detectOutcome — requires FORGE:ARCHITECT:COMPLETE (not bare FORGE:ARCHITECT)", () => {
    const architect = PHASES.find(p => p.id === "architect");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    it("bare FORGE:ARCHITECT (partial annotation) -> failed", async () => {
      const outcome = await architect.detectOutcome(base, ioWith("<!-- FORGE:ARCHITECT -->"));
      assert.equal(outcome.status, "failed");
    });

    it("FORGE:ARCHITECT:COMPLETE present -> committed", async () => {
      const outcome = await architect.detectOutcome(base, ioWith("<!-- FORGE:ARCHITECT:COMPLETE -->"));
      assert.equal(outcome.status, "committed");
    });
  });

  // Regression tests for #2193: within-comment `**Branch**:` field match order is
  // first-match, by design (see phases.mjs parseBranchFromMarkers doc comment).
  // Comment-level last-match (#2184) is unaffected/untouched by these tests.
  describe("build — within-comment **Branch** field match order (#2193)", () => {
    const build = PHASES.find(p => p.id === "build");

    it("uses the FIRST **Branch** field when a single eligible comment contains two", async () => {
      // Synthetic: no real pipeline path produces this today, but the function's
      // documented behavior must stay pinned to first-match for such an input.
      const body = "<!-- FORGE:BUILDER --> **Branch**: `fix/first-branch` some notes " +
        "**Branch**: `fix/second-branch` <!-- FORGE:BUILDER:COMPLETE -->";
      const io = {
        gh: async () => JSON.stringify([{ body }]),
        git: async () => "3",
      };
      const outcome = await build.detectOutcome({ ...base, branch: null }, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.branch, "fix/first-branch");
    });

    it("comment-level last-match (#2184) still wins over field-level ordering", async () => {
      // Two eligible comments; the LAST comment's (only) field must be used,
      // even though its **Branch** value differs from the earlier comment's.
      const older = "<!-- FORGE:BUILDER --> **Branch**: `fix/old-attempt` <!-- FORGE:BUILDER:COMPLETE -->";
      const newer = "<!-- FORGE:BUILDER --> **Branch**: `fix/retry-attempt` <!-- FORGE:BUILDER:COMPLETE -->";
      const io = {
        gh: async () => JSON.stringify([{ body: older }, { body: newer }]),
        git: async () => "1",
      };
      const outcome = await build.detectOutcome({ ...base, branch: null }, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.branch, "fix/retry-attempt");
    });
  });

  // Regression tests for #2194: FORGE:BUILDER:COMPLETE eligibility is a plain
  // substring test, consistent with every other marker check in this file
  // (see phases.mjs `has()` doc comment for the accepted-risk reasoning).
  describe("build — FORGE:BUILDER:COMPLETE substring eligibility (#2194)", () => {
    const build = PHASES.find(p => p.id === "build");

    it("a comment merely mentioning the marker text (not HTML-comment-wrapped) still counts as eligible", async () => {
      // Documents current, intentional substring behavior: this is not scoped
      // to the `<!-- FORGE:BUILDER:COMPLETE -->` HTML-comment shape specifically.
      const body = "**Branch**: `fix/plain-mention` this text contains FORGE:BUILDER:COMPLETE inline";
      const io = {
        gh: async () => JSON.stringify([{ body }]),
        git: async () => "2",
      };
      const outcome = await build.detectOutcome({ ...base, branch: null }, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.branch, "fix/plain-mention");
    });

    it("a comment without the marker text anywhere is never eligible", async () => {
      const body = "**Branch**: `fix/no-marker-here` build in progress, not done yet";
      const io = {
        gh: async () => JSON.stringify([{ body }]),
        git: async () => "2",
      };
      const outcome = await build.detectOutcome({ ...base, branch: null }, io);
      assert.equal(outcome.status, "failed");
    });
  });
});

// forge#2545: closeUnbalancedFence tracks GFM fence delimiters as whole
// line-anchored tokens instead of counting raw ``` substring occurrences,
// so it isn't fooled by 4+-backtick fences wrapping a literal ``` inside.
describe("closeUnbalancedFence", () => {
  it("closes a genuinely-unclosed 3-backtick fence (forge#2510 regression guard)", () => {
    const text = "```js\nfoo";
    assert.equal(closeUnbalancedFence(text), "```js\nfoo\n```");
  });

  it("leaves a balanced 4-backtick fence wrapping a literal ``` unchanged (forge#2545)", () => {
    const text = "````js\nfoo\n```\nbar\n````";
    assert.equal(closeUnbalancedFence(text), text);
  });

  it("closes a genuinely-unclosed 4-backtick fence with a matching 4-backtick closer", () => {
    const text = "````js\nfoo\n```\nbar";
    assert.equal(closeUnbalancedFence(text), "````js\nfoo\n```\nbar\n````");
  });

  it("is a no-op when no fence is present", () => {
    const text = "just a plain issue body\nwith no code fences at all";
    assert.equal(closeUnbalancedFence(text), text);
  });

  it("closes a balanced 3-backtick fence unchanged (even-count happy path)", () => {
    const text = "```js\nfoo\n```";
    assert.equal(closeUnbalancedFence(text), text);
  });
});

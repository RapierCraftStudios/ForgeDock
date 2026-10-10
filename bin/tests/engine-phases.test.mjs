import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { PHASES, pickPhase } from "../engine/phases.mjs";
import { RESERVED_TYPES } from "../../packages/protocol/src/types.js";

const base = { v: 0, run: "r1", issue: 42, lane: "staging", committed: [], phase: null,
  branch: null, pr: null, terminal: false, terminalReason: null, lease: null };

describe("pickPhase", () => {
  it("returns the first uncommitted phase whose entryCondition holds", () => {
    assert.equal(pickPhase(base).id, "investigate");
    assert.equal(pickPhase({ ...base, committed: ["investigate"] }).id, "build");
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
    assert.equal(pickPhase(state).id, "build");
  });

  it("returns 'remediate' when review committed with terminalReason 'needs-human'", () => {
    const state = {
      ...base,
      committed: ["investigate", "build", "review"],
      pr: 7,
      terminalReason: "needs-human",
    };
    assert.equal(pickPhase(state).id, "remediate");
  });

  it("does NOT return 'remediate' when review committed but terminalReason is unset (normal happy path)", () => {
    const state = {
      ...base,
      committed: ["investigate", "build", "review"],
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
  describe("remediate.buildArgs bound marker (forge#3530)", () => {
    const remediate = PHASES.find(p => p.id === "remediate");
    const st = { ...base, issue: 42, pr: 7, committed: ["investigate", "build", "review"], terminalReason: "needs-human" };
    const mk = (existing = "", fail = false) => {
      const posted = [];
      return { posted, io: { gh: async (a) => {
        if (a[0] === "issue" && a[1] === "comment") { if (fail) throw new Error("boom"); posted.push(a[a.indexOf("--body") + 1]); return ""; }
        return existing;
      }, git: async () => "" } };
    };
    const ctx = { repo: "acme/widgets" };

    for (const [kind, name] of [["ci-gate", "CI_REMEDIATION"], ["inpr-fix", "INPR_REMEDIATION"], ["base-sync", "BASESYNC_REMEDIATION"]]) {
      it(`${kind} -> posts <!-- FORGE:${name}: pr=7 -->`, async () => {
        const { io, posted } = mk();
        const args = await remediate.buildArgs({ ...st, remediationKind: kind }, ctx, io);
        assert.equal(args[0], "7");
        assert.equal(posted.length, 1);
        assert.ok(posted[0].startsWith(`<!-- FORGE:${name}: pr=7 -->`));
      });
    }

    it("resume: an existing marker for this PR+kind is not re-posted", async () => {
      const { io, posted } = mk(JSON.stringify(["<!-- FORGE:BASESYNC_REMEDIATION: pr=7 -->"]));
      await remediate.buildArgs({ ...st, remediationKind: "base-sync" }, ctx, io);
      assert.equal(posted.length, 0);
    });

    it("unknown kind throws PhaseArgsError and posts nothing", async () => {
      const { io, posted } = mk();
      await assert.rejects(remediate.buildArgs({ ...st, remediationKind: "unknown" }, ctx, io), { code: "PHASE_ARGS_INVALID" });
      assert.equal(posted.length, 0);
    });

    it("post failure throws PhaseArgsError (remediation not invoked)", async () => {
      const { io } = mk("", true);
      await assert.rejects(remediate.buildArgs({ ...st, remediationKind: "ci-gate" }, ctx, io), { code: "PHASE_ARGS_INVALID" });
    });

    it("no kind (legacy label-fallback handoff) dispatches without a marker", async () => {
      const { io, posted } = mk();
      const args = await remediate.buildArgs({ ...st, remediationKind: null }, ctx, io);
      assert.equal(args[0], "7");
      assert.equal(posted.length, 0);
    });
  });

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

    // forge#3530: the NEWEST completed trail wins, not the oldest.
    it("two trails: newest RE-ESCALATED beats older HELD-AWAITING-MERGE -> needs-human", async () => {
      const io = { gh: async () => JSON.stringify([remediateBody("HELD-AWAITING-MERGE"), "unrelated", remediateBody("RE-ESCALATED")]), git: async () => "0" };
      const outcome = await remediate.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "needs-human");
      assert.equal(outcome.outputs.reGateOutcome, "RE-ESCALATED");
    });

    it("paginated gh output (one JSON string per line) is parsed per comment, newest last", async () => {
      const io = { gh: async () => [remediateBody("RE-ESCALATED"), "other", remediateBody("AUTO-LANDED")].map((b) => JSON.stringify(b)).join("\n"), git: async () => "0" };
      const outcome = await remediate.detectOutcome(base, io);
      assert.equal(outcome.outputs.reGateOutcome, "AUTO-LANDED");
    });

    it("a stale trail is not read from a later comment lacking the completion marker", async () => {
      const io = { gh: async () => JSON.stringify([remediateBody("HELD-AWAITING-MERGE"), "**Re-gate outcome**: RE-ESCALATED (no completion marker)"]), git: async () => "0" };
      const outcome = await remediate.detectOutcome(base, io);
      assert.equal(outcome.outputs.reGateOutcome, "HELD-AWAITING-MERGE");
    });

    it("FORGE:REMEDIATION:COMPLETE present but Re-gate outcome unrecognized -> failed", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("SOMETHING-ELSE")));
      assert.equal(outcome.status, "failed");
    });

    it("no FORGE:REMEDIATION:COMPLETE marker -> failed", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith("nothing relevant here"));
      assert.equal(outcome.status, "failed");
    });

    // forge#2450: drift guard. RESERVED_TYPES.REMEDIATION.reGateOutcomeValues
    // (packages/protocol/src/types.js) and this switch statement are two
    // independent declarations of the same outcome vocabulary — nothing
    // structurally ties them together. This test fails loudly if a future
    // edit adds/removes/renames an outcome on one side without the other.
    it("drift guard: switch case values match RESERVED_TYPES.REMEDIATION.reGateOutcomeValues exactly", async () => {
      // Direction 1: every registry value must be recognized by the switch
      // (not fall through to the `default:` "failed" branch).
      for (const registryOutcome of RESERVED_TYPES.REMEDIATION.reGateOutcomeValues) {
        const outcome = await remediate.detectOutcome(base, ioWith(remediateBody(registryOutcome)));
        assert.notEqual(
          outcome.status,
          "failed",
          `Registry outcome "${registryOutcome}" is not recognized by phases.mjs's remediate switch — the two declarations have drifted`,
        );
      }

      // Direction 2: the switch must not handle any outcome absent from the
      // registry (parsed directly from source text, since the switch's case
      // labels aren't otherwise exposed as data).
      const phasesSrc = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../engine/phases.mjs"),
        "utf8",
      );
      const remediateStart = phasesSrc.indexOf('id: "remediate"');
      const remediateEnd = phasesSrc.indexOf("isTerminalAfter", remediateStart);
      const switchSection = phasesSrc.slice(remediateStart, remediateEnd);
      const caseValues = [...new Set([...switchSection.matchAll(/case\s+"([A-Z-]+)":/g)].map((m) => m[1]))];

      assert.deepEqual(
        caseValues.sort(),
        [...RESERVED_TYPES.REMEDIATION.reGateOutcomeValues].sort(),
        "phases.mjs's remediate switch case values must exactly match RESERVED_TYPES.REMEDIATION.reGateOutcomeValues",
      );
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

    function ioFor({ prList, prView, issueLabels }) {
      return {
        gh: async (args) => {
          const cmd = args.join(" ");
          if (cmd.startsWith("issue view") && issueLabels)
            return JSON.stringify({ state: "OPEN", labels: issueLabels.map((name) => ({ name })) });
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

    const openUnlabelled = {
      prList: JSON.stringify([{ number: 7 }]),
      prView: JSON.stringify({ number: 7, state: "OPEN", mergedAt: null, labels: [] }),
    };
    const rr = (body) => ({ text: `done\nREVIEW_RESULT:\n${body}\n` });

    it("forge#3521: needs-human on the issue only (PR unlabelled) -> blocked with outputs.pr", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: ["workflow:in-review", "needs-human"] });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
    });

    it("forge#3521: REVIEW_RESULT next: remediate with no labels -> blocked with outputs.pr", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      const outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: remediate\n  remediation: inpr-fix\n  pr_number: 7"));
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
    });

    it("forge#3530: carries a valid remediation kind; unknown kind recorded as the sentinel, never raw text", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      for (const kind of ["ci-gate", "inpr-fix", "base-sync"]) {
        const o = await review.detectOutcome(reviewState, io, rr(`  status: NEXT\n  next: remediate\n  remediation: ${kind}\n  pr_number: 7`));
        assert.equal(o.outputs.remediation, kind);
      }
      const bad = await review.detectOutcome(reviewState, io, rr("  status: NEXT\n  next: remediate\n  remediation: $(evil)\n  pr_number: 7"));
      assert.equal(bad.status, "blocked");
      assert.equal(bad.outputs.remediation, "unknown");
    });

    it("forge#3521: non-digit pr_number is ignored; openPrFor number wins when they disagree", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      let outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: remediate\n  pr_number: 7; rm -rf /"));
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
      outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: remediate\n  pr_number: 99"));
      assert.equal(outcome.outputs.pr, 7);
    });

    it("forge#3521: a non-remediate NEXT is not a handoff; no signal -> failed/non-retryable carrying outputs.pr", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      const outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: close\n  pr_number: 7"));
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.retryable, false);
      assert.equal(outcome.outputs.pr, 7);
      const noText = await review.detectOutcome(reviewState, io);
      assert.equal(noText.status, "failed");
    });

    it("forge#3521: only the last REVIEW_RESULT block counts; issue-read failure does not throw", async () => {
      const io = ioFor(openUnlabelled); // issue view throws
      const outcome = await review.detectOutcome(reviewState, io, {
        text: "REVIEW_RESULT:\n  status: NEXT\n  next: remediate\nlater\nREVIEW_RESULT:\n  status: BLOCKED\n  pr_number: 7\n",
      });
      assert.equal(outcome.status, "failed");
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

  // forge#3499: context/architect are no longer engine phases — work-on/build owns
  // them. Their markers survive as NON-BLOCKING sub-evidence on build's outcome.
  describe("build.detectOutcome — context/architect sub-evidence is non-blocking (forge#3499)", () => {
    const build = PHASES.find(p => p.id === "build");
    const withComments = (...bodies) => ({
      gh: async () => JSON.stringify(bodies),
      git: async () => "2",
    });
    const builder = "<!-- FORGE:BUILDER:COMPLETE -->";

    it("context/architect are not engine phases", () => {
      assert.equal(PHASES.find(p => p.id === "context"), undefined);
      assert.equal(PHASES.find(p => p.id === "architect"), undefined);
    });

    it("records complete markers without requiring them", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:CONTEXT:COMPLETE -->", "<!-- FORGE:ARCHITECT:COMPLETE -->", builder));
      assert.equal(o.status, "committed");
      assert.equal(o.outputs.context, "complete");
      assert.equal(o.outputs.architect, "complete");
    });

    it("bare/partial annotations are reported as absent, never as complete", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:CONTEXT -->", "<!-- FORGE:ARCHITECT:PARTIAL -->", builder));
      assert.equal(o.status, "committed");
      assert.equal(o.outputs.context, "absent");
      assert.equal(o.outputs.architect, "absent");
    });

    it("TRIVIAL fast-path band is recorded as skipped-trivial", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: TRIVIAL", builder));
      assert.equal(o.outputs.context, "skipped-trivial");
      assert.equal(o.outputs.architect, "skipped-trivial");
    });

    it("a malformed band (lowercase) is not treated as TRIVIAL", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: trivial", builder));
      assert.equal(o.outputs.context, "absent");
    });

    it("never fails build for a missing context/architect marker", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" }, withComments(builder));
      assert.equal(o.status, "committed");
    });
  });

  // Regression tests for #2193: within-comment `**Branch**:` field match order is
  // first-match, by design (see phases.mjs parseBranchFromMarkers doc comment).
  // Comment-level last-match (#2184) is unaffected/untouched by these tests.
  // NEEDS_DECOMPOSE routing: build.md B5.5 size-gate exit posts FORGE:DIFF_SIZE
  // (result: OVER + ### Split Proposal) and no FORGE:BUILDER:COMPLETE.
  describe("build.detectOutcome — size-gate NEEDS_DECOMPOSE routes to decompose", () => {
    const build = PHASES.find(p => p.id === "build");
    const withComments = (...bodies) => ({ gh: async () => JSON.stringify(bodies), git: async () => "0" });
    const gate = (result, proposal = true) =>
      `<!-- FORGE:DIFF_SIZE -->\n## Diff Size\n\ndiff_lines: 1906\nexcluded_lines: 0\nthreshold: 1000\nresult: ${result}\n` +
      (proposal ? "### Split Proposal\n- **A** — a.mjs\n" : "");
    const override = "<!-- FORGE:SIZE_OVERRIDE -->\nJustified: generated bulk.";
    const st = { ...base, committed: ["investigate"] };

    it("OVER + Split Proposal -> committed, decomposed, non-retryable", async () => {
      const o = await build.detectOutcome(st, withComments("<!-- FORGE:INVESTIGATOR -->", gate("OVER")));
      assert.equal(o.status, "committed");
      assert.equal(o.terminalReason, "decomposed");
      assert.equal(o.retryable, undefined);
    });

    it("pickPhase selects decompose after the build commit", () => {
      const s = { ...base, committed: ["investigate", "build"], terminalReason: "decomposed" };
      assert.equal(pickPhase(s).id, "decompose");
    });

    it("OVER followed by FORGE:SIZE_OVERRIDE does not route", async () => {
      const o = await build.detectOutcome(st, withComments(gate("OVER"), override));
      assert.equal(o.status, "failed");
      assert.equal(o.terminalReason, undefined);
    });

    it("an override posted BEFORE the latest OVER does not suppress it", async () => {
      const o = await build.detectOutcome(st, withComments(override, gate("OVER")));
      assert.equal(o.terminalReason, "decomposed");
    });

    it("OVER without Split Proposal (loop-guard Blocked exit) falls through to the failure", async () => {
      const o = await build.detectOutcome(st, withComments(gate("OVER", false)));
      assert.equal(o.status, "failed");
    });

    it("OK, OVERRIDDEN, malformed and absent DIFF_SIZE fall through", async () => {
      for (const c of [gate("OK"), gate("OVERRIDDEN"), "<!-- FORGE:DIFF_SIZE -->\nresult: OVERFLOW\n### Split Proposal", "nothing"]) {
        const o = await build.detectOutcome(st, withComments(c));
        assert.equal(o.status, "failed", c);
      }
    });

    it("only the latest DIFF_SIZE counts (OVER then refreshed OK)", async () => {
      const o = await build.detectOutcome(st, withComments(gate("OVER"), gate("OK")));
      assert.equal(o.status, "failed");
    });

    it("a posted FORGE:BUILDER:COMPLETE with commits wins over a stale OVER", async () => {
      const o = await build.detectOutcome({ ...st, branch: "fix/x-42" },
        { gh: async () => JSON.stringify([gate("OVER"), "<!-- FORGE:BUILDER:COMPLETE -->"]), git: async () => "2" });
      assert.equal(o.status, "committed");
      assert.equal(o.terminalReason, undefined);
    });
  });

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

  // forge#3506: close must never derive `merged` from a non-merged handoff reason.
  describe("close.buildArgs fail-closed", () => {
    const close = PHASES.find(p => p.id === "close");
    const st = (terminalReason) => ({ ...base, committed: ["review"], pr: 7, terminalReason });
    const io = { gh: async () => "", git: async () => "" };
    const ctx = { repo: "acme/widgets" };
    for (const reason of ["needs-human", "awaiting-merge", "engine-error"]) {
      it(`${reason} throws instead of defaulting to merged`, async () => {
        await assert.rejects(() => close.buildArgs(st(reason), ctx, io), /refusing close/);
      });
    }
    for (const [reason, expected] of [[null, "merged"], ["merged", "merged"], ["decomposed", "decomposed"], ["invalid", "invalid"]]) {
      it(`${reason} still maps to ${expected}`, async () => {
        const args = await close.buildArgs(st(reason), ctx, io);
        assert.equal(args[args.indexOf("--terminal-state") + 1], expected);
      });
    }
  });
});

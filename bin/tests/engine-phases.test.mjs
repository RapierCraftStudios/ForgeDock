import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PHASES, pickPhase } from "../engine/phases.mjs";

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

  describe("close.detectOutcome", () => {
    const close = PHASES.find(p => p.id === "close");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    it("issue CLOSED -> committed, terminalReason merged", async () => {
      const io = ioWith(JSON.stringify({ state: "CLOSED", labels: [] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
    });

    it("workflow:merged label -> committed, terminalReason merged", async () => {
      const io = ioWith(JSON.stringify({ state: "OPEN", labels: [{ name: "workflow:merged" }] }));
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

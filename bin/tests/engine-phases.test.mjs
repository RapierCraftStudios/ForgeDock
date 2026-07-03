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
});

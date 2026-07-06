import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileState } from "../engine/reconcile.mjs";

const mk = (v, phase) => ({ v, run: "r1", issue: 42, lane: "staging",
  committed: [], phase, branch: null, pr: null, terminal: false, terminalReason: null, lease: null });

describe("reconcileState (GitHub wins)", () => {
  it("no remote, no local → fresh", () => {
    assert.equal(reconcileState(null, null).action, "fresh");
  });
  it("no local, remote present → hydrate from remote", () => {
    const r = reconcileState(null, mk(3, "build"));
    assert.equal(r.action, "hydrate"); assert.equal(r.state.phase, "build");
  });
  it("remote ahead of local → GitHub wins (hydrate), discard local", () => {
    const r = reconcileState(mk(3, "build"), mk(5, "review"));
    assert.equal(r.action, "hydrate"); assert.equal(r.state.v, 5);
  });
  it("local ahead of remote → keep local, re-mirror", () => {
    const r = reconcileState(mk(5, "review"), mk(3, "build"));
    assert.equal(r.action, "remirror"); assert.equal(r.state.v, 5);
  });
  it("in sync → keep local", () => {
    const r = reconcileState(mk(3, "build"), mk(3, "build"));
    assert.equal(r.action, "local"); assert.equal(r.state.v, 3);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeState, parseState, upsertStateBlock } from "../engine/state.mjs";

const idx = { v: 7, run: "r1", issue: 42, lane: "staging",
  committed: ["investigate", "build"], phase: "review", branch: "fix/x-42",
  pr: null, terminal: false, terminalReason: null, lease: { by: "a7", until: 1000 } };

describe("state codec", () => {
  it("round-trips through serialize/parse", () => {
    const body = "Some issue text.\n\n" + serializeState(idx);
    const got = parseState(body);
    assert.deepEqual(got, idx);
  });

  it("parseState returns null when no block present", () => {
    assert.equal(parseState("no state here"), null);
  });

  it("upsertStateBlock replaces an existing block in place (no duplicate)", () => {
    let body = "Header\n\n" + serializeState(idx) + "\n\nFooter";
    body = upsertStateBlock(body, { ...idx, phase: "close", committed: [...idx.committed, "review"], v: 9 });
    assert.equal((body.match(/FORGE:STATE/g) || []).length, 1);
    assert.equal(parseState(body).phase, "close");
    assert.match(body, /Header/); assert.match(body, /Footer/);
  });

  it("upsertStateBlock appends a block when none exists", () => {
    const body = upsertStateBlock("Just text", idx);
    assert.equal(parseState(body).v, 7);
  });
});

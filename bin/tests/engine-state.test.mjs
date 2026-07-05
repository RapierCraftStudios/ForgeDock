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

  it("round-trips state containing --> in string values (HTML comment injection guard)", () => {
    // A terminalReason or branch containing "-->" must not close the HTML comment early.
    const poison = { ...idx, terminalReason: "step --> done --> ok", branch: "fix/-->-42" };
    const body = "prefix\n\n" + serializeState(poison);
    // The raw serialized form must NOT contain the literal "-->" sequence inside the payload
    const rawPayload = body.match(/<!-- FORGE:STATE\n([\s\S]*?)\n-->/)?.[1] ?? "";
    assert.ok(!rawPayload.includes("-->"), "payload must not contain raw --> (would close HTML comment early)");
    // But round-tripping through parseState must restore the original values
    const got = parseState(body);
    assert.deepEqual(got, poison);
  });

  it("round-trips state containing --!> in string values (HTML comment injection guard)", () => {
    // "--!>" is an alternate HTML comment terminator that JSON.stringify does not
    // escape; it must not appear raw in the payload (CodeQL js/bad-tag-filter).
    const poison = { ...idx, terminalReason: "abort --!> now", branch: "fix/--!>-42" };
    const body = "prefix\n\n" + serializeState(poison);
    const rawPayload = body.match(/<!-- FORGE:STATE\n([\s\S]*?)\n-->/)?.[1] ?? "";
    assert.ok(!rawPayload.includes("--!>"), "payload must not contain raw --!> (HTML comment terminator)");
    assert.ok(!rawPayload.includes("-->"), "payload must not contain raw --> either");
    const got = parseState(body);
    assert.deepEqual(got, poison);
  });

  it("upsertStateBlock handles $ replacement patterns in JSON values", () => {
    // Create an index with $ replacement patterns in serialized values
    const idx1 = { v: 1, run: "r1", issue: 42, lane: "staging",
      committed: ["investigate"], phase: "build", branch: null,
      pr: null, terminal: false, terminalReason: "step $1 of $` and $$ done",
      lease: null };
    // Create another index also with $ patterns
    const idx2 = { v: 2, run: "r1", issue: 42, lane: "staging",
      committed: ["investigate", "build"], phase: "review", branch: "fix/$1-weird",
      pr: null, terminal: false, terminalReason: "another $& test",
      lease: null };
    // Serialize idx1 into a body with surrounding text
    let body = "Header\n\n" + serializeState(idx1) + "\n\nFooter";
    // Upsert with idx2 (which also has $ patterns)
    body = upsertStateBlock(body, idx2);
    // Should have exactly one block
    assert.equal((body.match(/FORGE:STATE/g) || []).length, 1);
    // Parsed result should exactly match idx2 (no corruption)
    assert.deepEqual(parseState(body), idx2);
    // Preserved surrounding text
    assert.match(body, /Header/);
    assert.match(body, /Footer/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeProjector } from "../engine/projector.mjs";
import { serializeState } from "../engine/state.mjs";

// Fake gh: records calls, serves a scripted issue body.
function fakeGh(body) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body });
    if (args[0] === "issue" && args[1] === "edit") { body = argValue(args, "--body"); return ""; }
    return "";
  };
  return { gh, calls, getBody: () => body };
}
function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

const idx = { v: 3, run: "r1", issue: 42, lane: "staging", committed: ["investigate"],
  phase: "build", branch: null, pr: null, terminal: false, terminalReason: null, lease: null };

describe("projector", () => {
  it("readState returns null when the issue has no block", async () => {
    const f = fakeGh("plain body");
    const p = makeProjector({ gh: f.gh });
    assert.equal(await p.readState(42), null);
  });

  it("writeState upserts the block, readState reads it back", async () => {
    const f = fakeGh("Issue description.");
    const p = makeProjector({ gh: f.gh });
    await p.writeState(42, idx);
    assert.match(f.getBody(), /Issue description\./);       // original text preserved
    assert.deepEqual(await p.readState(42), idx);
  });

  it("setLabel calls gh issue edit --add-label", async () => {
    const f = fakeGh("x");
    const p = makeProjector({ gh: f.gh });
    await p.setLabel(42, "needs-human");
    assert.ok(f.calls.some(c => c.includes("--add-label") && c.includes("needs-human")));
  });
});

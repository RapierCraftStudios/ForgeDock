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

  // forge#2382: engine-native workflow:* state machine — in-process port of
  // scripts/transition-label.sh.
  describe("setWorkflowLabel", () => {
    /** A scriptable fake GitHub label world: tracks the issue's current labels. */
    function fakeLabelGh(initialLabels = []) {
      const labels = [...initialLabels];
      const calls = [];
      const gh = async (args) => {
        calls.push(args);
        if (args[0] === "issue" && args[1] === "view") {
          return JSON.stringify({ labels: labels.map((name) => ({ name })) });
        }
        if (args[0] === "issue" && args[1] === "edit") {
          const add = argValue(args, "--add-label");
          if (add && !labels.includes(add)) labels.push(add);
          const remove = argValue(args, "--remove-label");
          if (remove) {
            for (const name of remove.split(",")) {
              const i = labels.indexOf(name);
              if (i >= 0) labels.splice(i, 1);
            }
          }
          return "";
        }
        return "";
      };
      return { gh, calls, labels };
    }

    it("throws synchronously on an unrecognized target state — no gh call is made", async () => {
      const world = fakeLabelGh([]);
      const p = makeProjector({ gh: world.gh });
      await assert.rejects(() => p.setWorkflowLabel(42, "bogus-state"), /unknown target state/);
      assert.equal(world.calls.length, 0, "no gh call should be made for an invalid target state");
    });

    it("adds the target label and removes every other stale workflow:* label present", async () => {
      const world = fakeLabelGh(["workflow:ready-to-build", "priority:P2"]);
      const p = makeProjector({ gh: world.gh });
      await p.setWorkflowLabel(42, "building");
      assert.ok(world.labels.includes("workflow:building"));
      assert.ok(!world.labels.includes("workflow:ready-to-build"), "stale workflow:* label must be removed");
      assert.ok(world.labels.includes("priority:P2"), "non-workflow labels must be left untouched");
    });

    it("is idempotent — calling it twice with the same target leaves state unchanged", async () => {
      const world = fakeLabelGh(["workflow:building"]);
      const p = makeProjector({ gh: world.gh });
      await p.setWorkflowLabel(42, "building");
      await p.setWorkflowLabel(42, "building");
      assert.deepEqual(world.labels.sort(), ["workflow:building"]);
    });

    it("clears needs-human ONLY when targetState is awaiting-merge", async () => {
      const world = fakeLabelGh(["workflow:in-review", "needs-human"]);
      const p = makeProjector({ gh: world.gh });
      await p.setWorkflowLabel(42, "awaiting-merge");
      assert.ok(!world.labels.includes("needs-human"), "awaiting-merge must clear needs-human");
    });

    it("does NOT clear needs-human for any other target state", async () => {
      const world = fakeLabelGh(["workflow:ready-to-build", "needs-human"]);
      const p = makeProjector({ gh: world.gh });
      await p.setWorkflowLabel(42, "building");
      assert.ok(world.labels.includes("needs-human"), "needs-human is sticky outside the awaiting-merge exception");
    });

    it("adds the target label even when the stale-label read-back fails (best-effort removal)", async () => {
      const calls = [];
      const gh = async (args) => {
        calls.push(args);
        if (args[0] === "issue" && args[1] === "edit" && args.includes("--add-label")) return "";
        if (args[0] === "issue" && args[1] === "view") throw new Error("transient network error");
        return "";
      };
      const p = makeProjector({ gh });
      await assert.doesNotReject(() => p.setWorkflowLabel(42, "merged"));
      assert.ok(calls.some((c) => c.includes("--add-label") && c.includes("workflow:merged")));
    });
  });
});

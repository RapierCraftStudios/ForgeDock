import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { scanStalls, resumeStalledFromCli } from "../engine-cli.mjs";

describe("scanStalls", () => {
  it("flags issues whose lease expired and state is non-terminal", () => {
    const now = 10_000;
    const states = {
      42: { terminal: false, lease: { by: "a1", until: 5_000 } },   // expired → stalled
      43: { terminal: false, lease: { by: "a2", until: 20_000 } },  // live → ok
      44: { terminal: true,  lease: null },                          // done → ok
    };
    const io = { readState: async (i) => states[i] };
    return scanStalls([42, 43, 44], io, now).then((stalled) => {
      assert.deepEqual(stalled, [42]);
    });
  });

  it("returns empty when all leases are active", () => {
    const now = 1_000;
    const states = {
      10: { terminal: false, lease: { by: "a1", until: 5_000 } },
    };
    const io = { readState: async (i) => states[i] };
    return scanStalls([10], io, now).then((stalled) => {
      assert.deepEqual(stalled, []);
    });
  });

  it("skips issues with null state (no FORGE:STATE block)", () => {
    const io = { readState: async () => null };
    return scanStalls([99], io, 10_000).then((stalled) => {
      assert.deepEqual(stalled, []);
    });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanStalls } from "../engine-cli.mjs";

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

  it("returns empty array when issue list is empty", () => {
    const io = { readState: async () => { throw new Error("should not be called"); } };
    return scanStalls([], io, 10_000).then((stalled) => {
      assert.deepEqual(stalled, []);
    });
  });

  it("returns empty array when readState returns null for all issues", () => {
    const io = { readState: async () => null };
    return scanStalls([1, 2, 3], io, 10_000).then((stalled) => {
      assert.deepEqual(stalled, []);
    });
  });

  it("returns empty array when all leases are still valid (no stalls)", () => {
    const now = 10_000;
    const io = {
      readState: async (i) => ({
        terminal: false,
        lease: { by: `agent-${i}`, until: 20_000 },  // all leases expire after now
      }),
    };
    return scanStalls([10, 11, 12], io, now).then((stalled) => {
      assert.deepEqual(stalled, []);
    });
  });

  it("flags multiple stalled issues when several leases have expired", () => {
    const now = 10_000;
    const states = {
      50: { terminal: false, lease: { by: "a1", until: 1_000 } },  // expired → stalled
      51: { terminal: false, lease: { by: "a2", until: 2_000 } },  // expired → stalled
      52: { terminal: false, lease: { by: "a3", until: 15_000 } }, // live → ok
    };
    const io = { readState: async (i) => states[i] };
    return scanStalls([50, 51, 52], io, now).then((stalled) => {
      assert.deepEqual(stalled, [50, 51]);
    });
  });

  it("does not flag terminal issues even when their lease has expired", () => {
    const now = 10_000;
    const states = {
      60: { terminal: true, lease: { by: "a1", until: 1_000 } },  // expired but terminal → ok
      61: { terminal: true, lease: null },                          // terminal, no lease → ok
    };
    const io = { readState: async (i) => states[i] };
    return scanStalls([60, 61], io, now).then((stalled) => {
      assert.deepEqual(stalled, []);
    });
  });

  it("does not flag issues with missing lease field", () => {
    const now = 10_000;
    const states = {
      70: { terminal: false, lease: null },       // lease is null → not stalled
      71: { terminal: false, lease: undefined },  // lease is undefined → not stalled
      72: { terminal: false },                    // lease key absent → not stalled
    };
    const io = { readState: async (i) => states[i] };
    return scanStalls([70, 71, 72], io, now).then((stalled) => {
      assert.deepEqual(stalled, []);
    });
  });

  it("propagates readState rejection", () => {
    const boom = new Error("storage failure");
    const io = { readState: async () => { throw boom; } };
    return assert.rejects(scanStalls([99], io, 10_000), boom);
  });
});

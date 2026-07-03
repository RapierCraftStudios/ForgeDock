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
});

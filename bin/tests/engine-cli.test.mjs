import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { scanStalls, resumeStalledFromCli } from "../engine-cli.mjs";
import { serializeState } from "../engine/state.mjs";

/** Builds a fake io.gh that serves `issue list` (only for `label`) and `issue view` (state) calls. */
function makeFakeIo(states, { fanOutLabel = "workflow:building" } = {}) {
  return {
    gh: async (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        const label = args[args.indexOf("--label") + 1];
        if (label === fanOutLabel) {
          return JSON.stringify(Object.keys(states).map((n) => ({ number: Number(n) })));
        }
        return JSON.stringify([]);
      }
      if (args[0] === "issue" && args[1] === "view") {
        const issue = Number(args[2]);
        return JSON.stringify({ body: serializeState(states[issue]) });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  };
}

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

describe("resumeStalledFromCli", () => {
  it("throws when --lane is not provided", () => {
    return assert.rejects(resumeStalledFromCli([]), /--lane is required/);
  });

  it("continues dispatching remaining issues after one issue's dispatch rejects", async () => {
    const states = {
      100: { terminal: false, lease: { by: "a", until: 1_000 } },
      101: { terminal: false, lease: { by: "b", until: 1_000 } },
      102: { terminal: false, lease: { by: "c", until: 1_000 } },
    };
    const io = makeFakeIo(states);

    const attempted = [];
    const dispatch = mock.fn(async (argv) => {
      const issue = Number(argv[0]);
      attempted.push(issue);
      if (issue === 101) throw new Error("NO_API_KEY: missing ANTHROPIC_API_KEY");
      return { terminalReason: "workflow:merged" };
    });

    const result = await resumeStalledFromCli(["--lane", "staging"], { io, dispatch });

    assert.deepEqual(result.stalled, [100, 101, 102]);
    assert.deepEqual(result.dispatched, [100, 102]);
    assert.deepEqual(result.failed, [{ issue: 101, error: "NO_API_KEY: missing ANTHROPIC_API_KEY" }]);
    // All three issues were attempted — #101's failure did not abort the batch.
    assert.deepEqual(attempted, [100, 101, 102]);
    assert.equal(dispatch.mock.callCount(), 3);
  });

  it("returns an empty failed array when every issue dispatches successfully", async () => {
    const states = {
      200: { terminal: false, lease: { by: "a", until: 1_000 } },
      201: { terminal: false, lease: { by: "b", until: 1_000 } },
    };
    const io = makeFakeIo(states);
    const dispatch = async () => ({ terminalReason: "workflow:merged" });

    const result = await resumeStalledFromCli(["--lane", "staging"], { io, dispatch });

    assert.deepEqual(result.dispatched, [200, 201]);
    assert.deepEqual(result.failed, []);
  });

  it("returns failed: [] and skips dispatch entirely on --dry-run", async () => {
    const states = {
      300: { terminal: false, lease: { by: "a", until: 1_000 } },
    };
    const io = makeFakeIo(states);
    const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

    const result = await resumeStalledFromCli(["--lane", "staging", "--dry-run"], { io, dispatch });

    assert.deepEqual(result, { stalled: [300], dispatched: [], failed: [] });
    assert.equal(dispatch.mock.callCount(), 0);
  });

  it("returns failed: [] when no in-flight issues are found", async () => {
    const io = { gh: async () => JSON.stringify([]) };
    const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

    const result = await resumeStalledFromCli(["--lane", "staging"], { io, dispatch });

    assert.deepEqual(result, { stalled: [], dispatched: [], failed: [] });
    assert.equal(dispatch.mock.callCount(), 0);
  });
});

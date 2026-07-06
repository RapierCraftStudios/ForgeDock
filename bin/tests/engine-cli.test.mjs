import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { scanStalls, resumeStalledFromCli, runFromCli } from "../engine-cli.mjs";
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

  // forge#1631: --repo must be validated once at the resumeStalledFromCli level,
  // not once per dispatched issue — the default dispatch re-uses the verified io
  // and sets repoVerified:true so runFromCli skips the redundant gh repo view call.
  describe("--repo targeting guard", () => {
    /** Fake gh that answers `repo view` with `currentRepo` and everything else with empty results. */
    function makeRepoAwareIo(currentRepo) {
      const calls = [];
      return {
        calls,
        gh: async (args) => {
          calls.push(args);
          if (args[0] === "repo" && args[1] === "view") return `${currentRepo}\n`;
          if (args[0] === "issue" && args[1] === "list") return JSON.stringify([]);
          throw new Error(`unexpected gh call: ${args.join(" ")}`);
        },
      };
    }

    it("throws before any issue enumeration when --repo mismatches the cwd-resolved repo", async () => {
      const io = makeRepoAwareIo("acme/other-repo");
      const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

      await assert.rejects(
        resumeStalledFromCli(["--lane", "staging", "--repo", "acme/target-repo"], { io, dispatch }),
        /does not match the current repo/,
      );

      // Only the `repo view` verification call happened — no enumeration, no dispatch.
      assert.deepEqual(io.calls.map((c) => c.slice(0, 2)), [["repo", "view"]]);
      assert.equal(dispatch.mock.callCount(), 0);
    });

    it("proceeds normally when --repo matches the cwd-resolved repo", async () => {
      const io = makeRepoAwareIo("acme/target-repo");
      const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

      const result = await resumeStalledFromCli(
        ["--lane", "staging", "--repo", "acme/target-repo"],
        { io, dispatch },
      );

      assert.deepEqual(result, { stalled: [], dispatched: [], failed: [] });
    });

    it("accepts --repo with different casing than the cwd-resolved repo (case-insensitive)", async () => {
      // GitHub repo identifiers are case-insensitive — "Acme/Target-Repo" and "acme/target-repo"
      // refer to the same repo. The guard must not reject case variants.
      const io = makeRepoAwareIo("acme/target-repo");
      const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

      const result = await resumeStalledFromCli(
        ["--lane", "staging", "--repo", "Acme/Target-Repo"],
        { io, dispatch },
      );

      assert.deepEqual(result, { stalled: [], dispatched: [], failed: [] });
    });

    it("accepts --repo with incidental trailing whitespace (whitespace-tolerant)", async () => {
      // User-supplied --repo may have incidental surrounding whitespace from shell quoting
      // or copy-paste. The guard must not reject values that differ only in whitespace.
      const io = makeRepoAwareIo("acme/target-repo");
      const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

      const result = await resumeStalledFromCli(
        ["--lane", "staging", "--repo", "acme/target-repo "],
        { io, dispatch },
      );

      assert.deepEqual(result, { stalled: [], dispatched: [], failed: [] });
    });

    it("does not call `gh repo view` at all when --repo is omitted", async () => {
      const io = makeRepoAwareIo("acme/target-repo");
      const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

      await resumeStalledFromCli(["--lane", "staging"], { io, dispatch });

      assert.ok(!io.calls.some((c) => c[0] === "repo" && c[1] === "view"));
    });

    it("calls gh repo view exactly once for a batch of N stalled issues (not N+1)", async () => {
      // Three stalled issues — without the fix, the default dispatch would trigger
      // assertRepoMatchesCwd inside runFromCli for each issue (3 extra repo view calls).
      // With the fix, the default dispatch passes repoVerified:true and re-uses the
      // already-verified io — gh repo view is called exactly once, in resumeStalledFromCli.
      const states = {
        400: { terminal: false, lease: { by: "a", until: 1_000 } },
        401: { terminal: false, lease: { by: "b", until: 1_000 } },
        402: { terminal: false, lease: { by: "c", until: 1_000 } },
      };

      const repoViewCalls = [];
      const io = {
        calls: [],
        gh: async (args) => {
          io.calls.push(args);
          if (args[0] === "repo" && args[1] === "view") {
            repoViewCalls.push(args);
            return "acme/target-repo\n";
          }
          if (args[0] === "issue" && args[1] === "list") {
            const label = args[args.indexOf("--label") + 1];
            if (label === "workflow:building") {
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

      const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

      const result = await resumeStalledFromCli(
        ["--lane", "staging", "--repo", "acme/target-repo"],
        {
          io,
          dispatch: (argv) => runFromCli(argv, { io, repoVerified: true, runIssue }),
        },
      );

      assert.deepEqual(result.stalled, [400, 401, 402]);
      assert.deepEqual(result.dispatched, [400, 401, 402]);
      assert.equal(repoViewCalls.length, 1,
        `Expected 1 gh repo view call, got ${repoViewCalls.length} — N+1 redundancy not fixed`);
    });
  });
});

describe("runFromCli --repo targeting guard", () => {
  /** Fake gh that answers `repo view` with `currentRepo`. */
  function makeRepoAwareIo(currentRepo) {
    return {
      gh: async (args) => {
        if (args[0] === "repo" && args[1] === "view") return `${currentRepo}\n`;
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    };
  }

  it("throws before invoking runIssue when --repo mismatches the cwd-resolved repo", async () => {
    const io = makeRepoAwareIo("acme/other-repo");
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

    await assert.rejects(
      runFromCli(["42", "--lane", "staging", "--repo", "acme/target-repo"], { io, runIssue }),
      /does not match the current repo/,
    );
    assert.equal(runIssue.mock.callCount(), 0);
  });

  it("invokes runIssue when --repo matches the cwd-resolved repo", async () => {
    const io = makeRepoAwareIo("acme/target-repo");
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

    const res = await runFromCli(["42", "--lane", "staging", "--repo", "acme/target-repo"], { io, runIssue });

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
  });

  it("accepts --repo with different casing than the cwd-resolved repo (case-insensitive)", async () => {
    // GitHub repo identifiers are case-insensitive — the guard must not reject case variants.
    const io = makeRepoAwareIo("acme/target-repo");
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

    const res = await runFromCli(["42", "--lane", "staging", "--repo", "Acme/Target-Repo"], { io, runIssue });

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
  });

  it("skips the repo-view check entirely when --repo is omitted", async () => {
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

    const res = await runFromCli(["42", "--lane", "staging"], { io, runIssue });

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
  });

  it("skips the repo-view check when repoVerified:true is set (caller already verified)", async () => {
    // Simulates resumeStalledFromCli's default dispatch passing repoVerified:true.
    // The gh mock throws if repo view is called — proves the guard is skipped.
    const io = { gh: async (args) => { throw new Error(`unexpected gh call: ${args.join(" ")}`); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

    const res = await runFromCli(
      ["42", "--lane", "staging", "--repo", "acme/target-repo"],
      { io, runIssue, repoVerified: true },
    );

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
  });
});

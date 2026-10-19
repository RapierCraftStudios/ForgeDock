import { tmpDir } from "./_tmp.mjs";
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { scanStalls, resumeStalledFromCli, runFromCli, countEngineActivity, lastLocalRun, formatTerminalDiagnostics, aggregateUsage, formatUsageLine } from "../engine-cli.mjs";
import { serializeState } from "../engine/state.mjs";
import { appendEvent } from "../engine/runlog.mjs";

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
      if (args[0] === "api" && args[1] === "graphql") {
        const issue = Number(args[args.indexOf("-F", args.indexOf("name={repo}")) + 1].replace("number=", ""));
        return JSON.stringify({ data: { repository: { issue: { body: serializeState(states[issue]), authorAssociation: "NONE", author: { login: "forge[bot]", __typename: "Bot" }, editor: null } } } });
      }
      if (args[0] === "issue" && args[1] === "view") {
        const issue = Number(args[2]);
        return JSON.stringify({ body: serializeState(states[issue]) });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    } };
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
  it("#4125 refuses --lane main (the default branch) before enumerating or dispatching", async () => {
    const calls = [];
    const io = { gh: async (args) => { calls.push(args); if (args.includes("defaultBranchRef")) return "main\n"; throw new Error(`unexpected gh call: ${args.join(" ")}`); } };
    const dispatch = mock.fn(async () => ({}));
    await assert.rejects(resumeStalledFromCli(["--lane", "main"], { io, dispatch }), /lane\.default_branch/);
    assert.equal(dispatch.mock.callCount(), 0);
    assert.ok(!calls.some((c) => c[0] === "issue"));
  });

  it("#4125 without --lane, each stalled issue is re-dispatched without one (its lane is worked out from the issue)", async () => {
    const io = makeFakeIo({ 100: { terminal: false, lease: { by: "a", until: 1_000 } } });
    const dispatch = mock.fn(async () => ({ terminalReason: "merged" }));
    const l = console.log; console.log = () => {};
    try { await resumeStalledFromCli([], { io, dispatch }); } finally { console.log = l; }
    assert.deepEqual(dispatch.mock.calls.map((c) => c.arguments[0]), [["100"]]);
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

  // forge#1593: --repo must be validated against the cwd-resolved repo before
  // any state I/O — otherwise it silently reads/writes FORGE:STATE in the
  // wrong repo (only the `issue list` enumeration ever honored --repo).
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

    it("does not call `gh repo view` at all when --repo is omitted", async () => {
      const io = makeRepoAwareIo("acme/target-repo");
      const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));

      await resumeStalledFromCli(["--lane", "staging"], { io, dispatch });

      // The cross-repo check (nameWithOwner) is skipped; only the #4125 default-branch read may run.
      assert.ok(!io.calls.some((c) => c[0] === "repo" && c[1] === "view" && !c.includes("defaultBranchRef")));
    });
  });
});

describe("countEngineActivity (re-entry dashboard, #1945)", () => {
  it("returns zeros when no issues carry any active workflow label", async () => {
    const io = { gh: async () => JSON.stringify([]) };
    const result = await countEngineActivity(io, null, 10_000);
    assert.deepEqual(result, { total: 0, inFlight: 0, stalled: 0 });
  });

  it("classifies in-flight vs stalled using the same lease-expiry rule as scanStalls", async () => {
    const states = {
      400: { terminal: false, lease: { by: "a", until: 1_000 } },  // expired → stalled
      401: { terminal: false, lease: { by: "b", until: 20_000 } }, // live → in-flight
      402: { terminal: false, lease: { by: "c", until: 20_000 } }, // live → in-flight
    };
    const io = makeFakeIo(states, { fanOutLabel: "workflow:building" });
    const result = await countEngineActivity(io, null, 10_000);
    assert.deepEqual(result, { total: 3, inFlight: 2, stalled: 1 });
  });

  it("threads --repo through to the issue-list enumeration", async () => {
    const calls = [];
    const io = {
      gh: async (args) => {
        calls.push(args);
        if (args[0] === "issue" && args[1] === "list") return JSON.stringify([]);
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    };
    await countEngineActivity(io, "acme/target-repo", 10_000);
    assert.ok(calls.every((c) => c.includes("--repo") && c.includes("acme/target-repo")));
  });

  it("treats a gh failure on one label as zero matches for that label, not a thrown error", async () => {
    const io = {
      gh: async (args) => {
        const label = args[args.indexOf("--label") + 1];
        if (label === "workflow:building") throw new Error("gh: transient failure");
        return JSON.stringify([]);
      },
    };
    const result = await countEngineActivity(io, null, 10_000);
    assert.deepEqual(result, { total: 0, inFlight: 0, stalled: 0 });
  });
});

describe("lastLocalRun (re-entry dashboard, #1945)", () => {
  it("returns null when the runs dir does not exist", () => {
    assert.equal(lastLocalRun(join(os.tmpdir(), "fd-nonexistent-runs-dir-xyz")), null);
  });

  it("returns null when the runs dir has no .jsonl files", () => {
    const dir = tmpDir("fd-runs-empty-");
    try {
      writeFileSync(join(dir, "notes.txt"), "not a run log");
      assert.equal(lastLocalRun(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the most recently modified run's summary", () => {
    const dir = tmpDir("fd-runs-multi-");
    try {
      writeFileSync(join(dir, "100.jsonl"), JSON.stringify({ seq: 1, event: "RUN_START", run: "r1", issue: 100 }) + "\n");
      // Write the second file after a tick so its mtime is newer.
      const later = Date.now() + 1000;
      writeFileSync(join(dir, "200.jsonl"), JSON.stringify({ seq: 1, event: "RUN_START", run: "r2", issue: 200 }) + "\n" +
        JSON.stringify({ seq: 2, event: "RUN_TERMINAL", reason: "workflow:merged" }) + "\n");
      // Force mtimes explicitly (avoids flakiness on fast filesystems where both writes land in the same tick).
      utimesSync(join(dir, "100.jsonl"), new Date(1000), new Date(1000));
      utimesSync(join(dir, "200.jsonl"), new Date(later), new Date(later));

      const result = lastLocalRun(dir);
      assert.deepEqual(result, { issue: 200, terminal: true, terminalReason: "workflow:merged" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a corrupt newest file and falls back to the next-newest readable one", () => {
    const dir = tmpDir("fd-runs-corrupt-");
    try {
      writeFileSync(join(dir, "300.jsonl"), JSON.stringify({ seq: 1, event: "RUN_START", run: "r3", issue: 300 }) + "\n");
      writeFileSync(join(dir, "301.jsonl"), "{not valid json at all");
      utimesSync(join(dir, "300.jsonl"), new Date(1000), new Date(1000));
      utimesSync(join(dir, "301.jsonl"), new Date(2000), new Date(2000)); // newest, but corrupt

      const result = lastLocalRun(dir);
      // 301.jsonl's single line fails to parse; readLog() tolerates a malformed
      // *final* line (crash-mid-write case) by silently dropping it, yielding an
      // empty event list — lastLocalRun() treats "no events" the same as
      // "unreadable" and falls back to the next-newest file (300).
      assert.deepEqual(result, { issue: 300, terminal: false, terminalReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      runFromCli(["42", "--lane", "staging", "--path", "full", "--repo", "acme/target-repo"], { io, runIssue }),
      /does not match the current repo/,
    );
    assert.equal(runIssue.mock.callCount(), 0);
  });

  it("invokes runIssue when --repo matches the cwd-resolved repo", async () => {
    const io = makeRepoAwareIo("acme/target-repo");
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    // forge#2175: an injected dir keeps the terminal-diagnostics read (triggered
    // here since the mocked terminalReason isn't the literal "merged") off the
    // real ~/.forge/runs directory.
    const dir = tmpDir("engine-cli-test-");

    const res = await runFromCli(["42", "--lane", "staging", "--path", "full", "--repo", "acme/target-repo"], { io, runIssue, dir });

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips the repo-view check entirely when --repo is omitted", async () => {
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    const dir = tmpDir("engine-cli-test-");

    const res = await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
    rmSync(dir, { recursive: true, force: true });
  });
});

// forge#4157: a failed `gh repo view` (a timeout under host load) is transient: retried with backoff, and a lane
// that still cannot verify --repo ends `deferred` gh.unavailable (not engine-error, so the batch breaker never sees it).
describe("runFromCli --repo verification when gh is unavailable", () => {
  /** gh whose `repo view` throws `failures` times, then answers `currentRepo`. */
  function makeFlakyIo(currentRepo, failures) {
    let left = failures;
    const gh = mock.fn(async (args) => {
      if (args[0] === "repo" && args[1] === "view") {
        if (left-- > 0) throw new Error("Command failed: gh repo view (timed out)");
        return `${currentRepo}\n`;
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    return { gh };
  }

  it("retries `gh repo view` with increasing backoff and runs when it recovers", async () => {
    const io = makeFlakyIo("acme/target-repo", 2);
    const sleep = mock.fn(async () => {});
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    const dir = tmpDir("engine-cli-test-");
    try {
      const res = await runFromCli(["42", "--lane", "staging", "--path", "full", "--repo", "acme/target-repo"], { io, runIssue, dir, sleep });
      assert.equal(runIssue.mock.callCount(), 1);
      assert.equal(res.terminalReason, "workflow:merged");
      const delays = sleep.mock.calls.map((c) => c.arguments[0]);
      assert.equal(delays.length, 2);
      assert.ok(delays[0] > 0 && delays[1] > delays[0], `backoff must increase: ${delays}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("defers with gh.unavailable (and reports it through --result-file) when gh never answers", async () => {
    const io = makeFlakyIo("acme/target-repo", Infinity);
    const sleep = mock.fn(async () => {});
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    const runCore = mock.fn(async () => ({ terminalReason: "merged" }));
    const dir = tmpDir("engine-cli-test-");
    const rf = join(dir, "lanes", "42.json");
    try {
      for (const path of ["full", "core"]) {
        rmSync(rf, { force: true });
        const res = await runFromCli(["42", "--lane", "staging", "--path", path, "--repo", "acme/target-repo", "--result-file", rf],
          { io, runIssue, dir, sleep, leanModule: { runCore }, leanIo: {}, emitTelemetry: async () => {} });
        assert.equal(res.terminalReason, "deferred");
        assert.equal(res.code, "gh.unavailable");
        assert.equal(res.retryInSeconds, 60);
        assert.match(res.detail, /could not be determined/);
        const written = JSON.parse(readFileSync(rf, "utf8"));
        assert.equal(written.terminalReason, "deferred");
        assert.equal(written.code, "gh.unavailable");
      }
      assert.equal(runIssue.mock.callCount(), 0);
      assert.equal(runCore.mock.callCount(), 0);
      assert.ok(sleep.mock.callCount() >= 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("resume-stalled still refuses when gh never answers (no lane result to report)", async () => {
    const io = makeFlakyIo("acme/target-repo", Infinity);
    const dispatch = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    await assert.rejects(
      resumeStalledFromCli(["--lane", "staging", "--repo", "acme/target-repo"], { io, dispatch, sleep: async () => {} }),
      /could not be determined/,
    );
    assert.equal(dispatch.mock.callCount(), 0);
    assert.equal(io.gh.mock.callCount(), 3);
  });
});

describe("runFromCli OpenCode runtime guard", () => {
  it("refuses before repo checks, run-log output, or engine dispatch", async () => {
    const previousRuntime = process.env.FORGE_RUNTIME;
    process.env.FORGE_RUNTIME = "opencode";
    const gh = mock.fn(async () => "unexpected");
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    try {
      await assert.rejects(
        runFromCli(["42", "--lane", "staging", "--path", "full"], { io: { gh }, runIssue }),
        (error) => error.code === "FORGE_OPENCODE_CAPABILITY_ERROR" &&
          error.message.startsWith("FORGE_OPENCODE_CAPABILITY_ERROR: forgedock run-issue"),
      );
    } finally {
      if (previousRuntime === undefined) delete process.env.FORGE_RUNTIME;
      else process.env.FORGE_RUNTIME = previousRuntime;
    }
    assert.equal(gh.mock.callCount(), 0);
    assert.equal(runIssue.mock.callCount(), 0);
  });
});

describe("runFromCli phase progress output (forge#2240)", () => {
  it("prints the run-log path at start, before runIssue is even invoked", async () => {
    const dir = tmpDir("engine-cli-test-");
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const logs = [];
    let runLogPrintedBeforeRunIssue = false;
    const runIssue = mock.fn(async () => {
      // At the moment runIssue is invoked, the run-log line must already be there.
      runLogPrintedBeforeRunIssue = logs.some((l) => l.includes("run-log:"));
      return { terminalReason: "merged" };
    });

    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(runLogPrintedBeforeRunIssue, "run-log path must be printed before runIssue starts, not only in a completion summary");
    assert.ok(logs.some((l) => l.includes(`run-log: ${join(dir, "42.jsonl")}`)));
  });

  it("emits a stdout line for each phase_enter/phase_exit onProgress event from runIssue", async () => {
    const dir = tmpDir("engine-cli-test-");
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async ({ onProgress }) => {
      // Simulate a multi-phase run in flight — more than the startup banner.
      onProgress({ event: "phase_enter", phase: "investigate" });
      onProgress({ event: "phase_exit", phase: "investigate", status: "committed" });
      onProgress({ event: "phase_enter", phase: "build" });
      onProgress({ event: "phase_exit", phase: "build", status: "blocked", detail: "no commits yet" });
      return { terminalReason: "needs-human" };
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const output = logs.join("\n");
    assert.match(output, /phase investigate started/);
    assert.match(output, /phase investigate committed/);
    assert.match(output, /phase build started/);
    assert.match(output, /phase build blocked: no commits yet/);
    // A run in flight for longer than one phase produces more than just the
    // run-log line and the final summary line — the explicit regression this
    // issue targets.
    assert.ok(logs.length > 2, "expected more than just the run-log line and the completion summary");
  });
});

describe("runFromCli --backend/--model forwarding (forge#2028)", () => {
  it("forwards --backend and --model to runIssue when both are supplied", async () => {
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    const dir = tmpDir("engine-cli-test-");

    const res = await runFromCli(
      ["42", "--lane", "staging", "--path", "full", "--backend", "cli", "--model", "claude-test-model"],
      { io, runIssue, dir },
    );

    assert.equal(runIssue.mock.callCount(), 1);
    const callArgs = runIssue.mock.calls[0].arguments[0];
    assert.equal(callArgs.backend, "cli");
    assert.equal(callArgs.model, "claude-test-model");
    assert.equal(res.terminalReason, "workflow:merged");
    rmSync(dir, { recursive: true, force: true });
  });

  it("omits backend/model keys from the runIssue call when neither flag is supplied", async () => {
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    const dir = tmpDir("engine-cli-test-");

    await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });

    assert.equal(runIssue.mock.callCount(), 1);
    const callArgs = runIssue.mock.calls[0].arguments[0];
    assert.ok(!("backend" in callArgs), "backend key must be absent when --backend is not passed");
    assert.ok(!("model" in callArgs), "model key must be absent when --model is not passed");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("formatTerminalDiagnostics (forge#2175)", () => {
  it("renders phase, attempt/max, reason, state, and run-log path from a run-log with a PHASE_FAILED event", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      appendEvent(dir, 29241, { event: "RUN_START", issue: 29241, run: "r_29241_staging", lane: "staging" });
      appendEvent(dir, 29241, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
      appendEvent(dir, 29241, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
      appendEvent(dir, 29241, { event: "PHASE_COMMIT", phase: "architect", outputs: {} });
      appendEvent(dir, 29241, { event: "PHASE_START", phase: "build", attempt: 1 });
      appendEvent(dir, 29241, { event: "PHASE_FAILED", phase: "build", attempt: 1, reason: "builder complete=true commitsAhead=0" });
      appendEvent(dir, 29241, { event: "PHASE_START", phase: "build", attempt: 2 });
      appendEvent(dir, 29241, { event: "PHASE_FAILED", phase: "build", attempt: 2, reason: "builder complete=true commitsAhead=0" });
      appendEvent(dir, 29241, { event: "PHASE_START", phase: "build", attempt: 3 });
      appendEvent(dir, 29241, { event: "PHASE_FAILED", phase: "build", attempt: 3, reason: "builder complete=true commitsAhead=0" });
      appendEvent(dir, 29241, { event: "RUN_TERMINAL", reason: "needs-human" });

      const out = formatTerminalDiagnostics(dir, 29241);

      assert.match(out, /phase:\s+build \(failed 3\/3 attempts\)/);
      assert.match(out, /reason:\s+builder complete=true commitsAhead=0/);
      assert.match(out, /state:\s+committed=\[investigate,context,architect\] branch=null pr=null/);
      assert.match(out, new RegExp(`run-log:\\s+.*29241\\.jsonl`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the run's effective maxAttempts (forge#2226) rather than the DEFAULT_MAX_ATTEMPTS constant", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      appendEvent(dir, 30001, { event: "RUN_START", issue: 30001, run: "r_30001_staging", lane: "staging" });
      appendEvent(dir, 30001, { event: "PHASE_START", phase: "build", attempt: 1 });
      appendEvent(dir, 30001, { event: "PHASE_FAILED", phase: "build", attempt: 1, reason: "transient", maxAttempts: 5 });
      appendEvent(dir, 30001, { event: "PHASE_START", phase: "build", attempt: 2 });
      appendEvent(dir, 30001, { event: "PHASE_FAILED", phase: "build", attempt: 2, reason: "transient", maxAttempts: 5 });
      appendEvent(dir, 30001, { event: "RUN_TERMINAL", reason: "needs-human" });

      const out = formatTerminalDiagnostics(dir, 30001);

      assert.match(out, /phase:\s+build \(failed 2\/5 attempts\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to DEFAULT_MAX_ATTEMPTS for legacy run-logs whose PHASE_FAILED events predate the maxAttempts field (forge#2226)", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      appendEvent(dir, 30002, { event: "RUN_START", issue: 30002, run: "r_30002_staging", lane: "staging" });
      appendEvent(dir, 30002, { event: "PHASE_START", phase: "build", attempt: 1 });
      // Legacy event shape — no maxAttempts field at all.
      appendEvent(dir, 30002, { event: "PHASE_FAILED", phase: "build", attempt: 1, reason: "legacy failure" });
      appendEvent(dir, 30002, { event: "RUN_TERMINAL", reason: "needs-human" });

      const out = formatTerminalDiagnostics(dir, 30002);

      assert.match(out, /phase:\s+build \(failed 1\/3 attempts\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits the phase/reason lines but still prints state and run-log path when there is no PHASE_FAILED event", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      appendEvent(dir, 55, { event: "RUN_START", issue: 55, run: "r_55_staging", lane: "staging" });
      appendEvent(dir, 55, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
      appendEvent(dir, 55, { event: "RUN_TERMINAL", reason: "decomposed" });

      const out = formatTerminalDiagnostics(dir, 55);

      assert.ok(!out.includes("phase:"), "must not print a phase: line when no PHASE_FAILED exists");
      assert.ok(!out.includes("reason:"), "must not print a reason: line when no PHASE_FAILED exists");
      assert.match(out, /state:\s+committed=\[investigate\] branch=null pr=null/);
      assert.match(out, /run-log:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints only the run-log path when the log is empty/nonexistent (e.g. a deferred early return)", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      const out = formatTerminalDiagnostics(dir, 999);
      assert.ok(!out.includes("phase:"));
      assert.ok(!out.includes("state:"));
      assert.match(out, /run-log:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to a safe placeholder without touching the filesystem when issue is not an integer (forge#2190)", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      for (const invalid of [NaN, "not-a-number", undefined, null, 1.5]) {
        const out = formatTerminalDiagnostics(dir, invalid);
        assert.ok(!out.includes("phase:"), `must not print a phase: line for invalid issue ${invalid}`);
        assert.ok(!out.includes("state:"), `must not print a state: line for invalid issue ${invalid}`);
        assert.match(out, /run-log:\s+<invalid issue:/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends an aggregate usage line when at least one PHASE_COMMIT/PHASE_FAILED event carries usage (forge#2399)", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      appendEvent(dir, 40001, { event: "RUN_START", issue: 40001, run: "r_40001_staging", lane: "staging" });
      appendEvent(dir, 40001, { event: "PHASE_COMMIT", phase: "investigate", outputs: {}, usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 } });
      appendEvent(dir, 40001, { event: "PHASE_COMMIT", phase: "context", outputs: {}, usage: { input_tokens: 30, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 15 } });
      appendEvent(dir, 40001, { event: "RUN_TERMINAL", reason: "needs-human" });

      const out = formatTerminalDiagnostics(dir, 40001);

      assert.match(out, /usage:\s+130 in \/ 30 out \(65 cache-read \/ 5 cache-write\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits the usage line entirely (no misleading 0 tokens line) when no event carries usage data (forge#2399)", () => {
    const dir = tmpDir("engine-cli-test-");
    try {
      appendEvent(dir, 40002, { event: "RUN_START", issue: 40002, run: "r_40002_staging", lane: "staging" });
      appendEvent(dir, 40002, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
      appendEvent(dir, 40002, { event: "RUN_TERMINAL", reason: "needs-human" });

      const out = formatTerminalDiagnostics(dir, 40002);

      assert.ok(!out.includes("usage:"), "must not print a usage: line when no event carries usage");
      assert.ok(!/\b0\s*(tokens|in)\b/i.test(out), "must not print a misleading zero-token line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aggregateUsage / formatUsageLine (forge#2399)", () => {
  it("sums usage across PHASE_COMMIT and PHASE_FAILED events, guarding each field with ?? 0", () => {
    const events = [
      { event: "RUN_START" },
      { event: "PHASE_COMMIT", usage: { input_tokens: 10, output_tokens: 5 } },
      { event: "PHASE_FAILED", usage: { input_tokens: 3, cache_read_input_tokens: 7 } },
      { event: "PHASE_START" }, // no usage field — must not throw or be counted
    ];
    const total = aggregateUsage(events);
    assert.deepEqual(total, { input_tokens: 13, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 });
  });

  it("returns null when no event carries a non-null usage object", () => {
    const events = [
      { event: "RUN_START" },
      { event: "PHASE_COMMIT", outputs: {} },
      { event: "PHASE_COMMIT", usage: null },
      { event: "PHASE_FAILED", reason: "x" },
    ];
    assert.equal(aggregateUsage(events), null);
  });

  it("forge#3696: sums only PHASE_ATTEMPT_USAGE for a phase that has them (cumulative PHASE_COMMIT not double counted)", () => {
    const events = [
      { event: "PHASE_ATTEMPT_USAGE", phase: "build", attempt: 1, usage: { input_tokens: 10, output_tokens: 1 } },
      { event: "PHASE_FAILED", phase: "build", attempt: 1, usage: { input_tokens: 10, output_tokens: 1 } },
      { event: "PHASE_ATTEMPT_USAGE", phase: "build", attempt: 2, usage: { input_tokens: 5, output_tokens: 2 } },
      { event: "PHASE_COMMIT", phase: "build", usage: { input_tokens: 15, output_tokens: 3 } },
      // legacy phase (no attempt events) still uses COMMIT + FAILED
      { event: "PHASE_FAILED", phase: "review", usage: { input_tokens: 4 } },
      { event: "PHASE_COMMIT", phase: "review", usage: { input_tokens: 6 } },
      // thrown attempt: null usage adds nothing
      { event: "PHASE_ATTEMPT_USAGE", phase: "close", attempt: 1, usage: null },
    ];
    assert.deepEqual(aggregateUsage(events),
      { input_tokens: 25, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  });

  it("ignores usage on event types other than PHASE_COMMIT/PHASE_FAILED", () => {
    const events = [{ event: "RUN_TERMINAL", usage: { input_tokens: 999 } }];
    assert.equal(aggregateUsage(events), null);
  });

  it("formatUsageLine renders '' for null usage and a formatted line otherwise", () => {
    assert.equal(formatUsageLine(null), "");
    assert.match(
      formatUsageLine({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }),
      /usage:\s+1 in \/ 2 out \(4 cache-read \/ 3 cache-write\)/
    );
  });
});

describe("runFromCli terminal diagnostics (forge#2175)", () => {
  it("prints the diagnostic block after a needs-human termination", async () => {
    const dir = tmpDir("engine-cli-test-");
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async ({ dir: d, issue }) => {
      appendEvent(d, issue, { event: "RUN_START", issue, run: `r_${issue}_staging`, lane: "staging" });
      appendEvent(d, issue, { event: "PHASE_START", phase: "build", attempt: 1 });
      appendEvent(d, issue, { event: "PHASE_FAILED", phase: "build", attempt: 1, reason: "builder complete=true commitsAhead=0" });
      appendEvent(d, issue, { event: "RUN_TERMINAL", reason: "needs-human" });
      return { terminalReason: "needs-human" };
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const res = await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });
      assert.equal(res.terminalReason, "needs-human");
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const output = logs.join("\n");
    assert.match(output, /issue #42 → needs-human/);
    assert.match(output, /phase:\s+build \(failed 1\/3 attempts\)/);
    assert.match(output, /reason:\s+builder complete=true commitsAhead=0/);
    assert.match(output, /run-log:/);
  });

  it("does NOT print the post-completion diagnostic block after a merged termination", async () => {
    const dir = tmpDir("engine-cli-test-");
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "merged" }));

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const output = logs.join("\n");
    assert.match(output, /issue #42 → merged/);
    // forge#2240: the run-log path is now always printed once at run START
    // (so a caller knows where to look immediately, not only on failure) —
    // that single startup line is expected here. What must NOT appear is the
    // post-completion diagnostic BLOCK (phase:/reason: lines), which stays
    // gated to non-merged terminations (forge#2175's original intent).
    const runLogLines = logs.filter((l) => l.includes("run-log:"));
    assert.equal(runLogLines.length, 1, "run-log path should be printed exactly once (at start), not again in a diagnostic block");
    assert.ok(!output.includes("phase:"), "no diagnostic block should be printed on a merged termination");
    assert.ok(!output.includes("reason:"), "no diagnostic block should be printed on a merged termination");
  });

  it("prints the aggregate usage line on a merged termination when the run-log carries usage data (forge#2399)", async () => {
    const dir = tmpDir("engine-cli-test-");
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async ({ dir: d, issue }) => {
      appendEvent(d, issue, { event: "RUN_START", issue, run: `r_${issue}_staging`, lane: "staging" });
      appendEvent(d, issue, { event: "PHASE_COMMIT", phase: "build", outputs: {}, usage: { input_tokens: 42, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
      appendEvent(d, issue, { event: "RUN_TERMINAL", reason: "merged" });
      return { terminalReason: "merged" };
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const output = logs.join("\n");
    assert.match(output, /issue #42 → merged/);
    assert.match(output, /usage:\s+42 in \/ 8 out \(0 cache-read \/ 0 cache-write\)/);
    assert.ok(!output.includes("phase:"), "the phase/reason diagnostic block must still stay gated to non-merged terminations");
  });

  it("prints no usage line on a merged termination when the run-log carries no usage data (forge#2399)", async () => {
    const dir = tmpDir("engine-cli-test-");
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async ({ dir: d, issue }) => {
      appendEvent(d, issue, { event: "RUN_START", issue, run: `r_${issue}_staging`, lane: "staging" });
      appendEvent(d, issue, { event: "PHASE_COMMIT", phase: "build", outputs: {} });
      appendEvent(d, issue, { event: "RUN_TERMINAL", reason: "merged" });
      return { terminalReason: "merged" };
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir });
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    const output = logs.join("\n");
    assert.match(output, /issue #42 → merged/);
    assert.ok(!output.includes("usage:"), "must not print a usage line when no usage data exists");
  });
});

describe("runFromCli — forge#3574 deferred output, agentId, --wait-lease", () => {
  const io = { gh: async () => { throw new Error("should not be called"); } };
  const capture = async (fn) => {
    const lines = []; const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await fn(); } finally { console.log = orig; }
    return lines.join("\n");
  };

  it("deferred prints the reason and skips empty-log diagnostics", async () => {
    const dir = tmpDir("engine-cli-test-");
    const detail = "issue 42 leased by cli_h_9 until 2026-10-10T16:20:14.000Z";
    const runIssue = mock.fn(async () => ({ terminalReason: "deferred", detail }));
    let res;
    const out = await capture(async () => { res = await runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir }); });
    assert.equal(res.terminalReason, "deferred");
    assert.ok(out.includes(detail));
    assert.equal((out.match(/run-log:/g) || []).length, 1, "run-log path printed once (start only)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("agentId is cli_<hostname>_<pid> and round-trips through parseLeaseHolder", async () => {
    const dir = tmpDir("engine-cli-test-");
    const runIssue = mock.fn(async () => ({ terminalReason: "merged" }));
    await capture(() => runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir }));
    const { agentId } = runIssue.mock.calls[0].arguments[0];
    const { parseLeaseHolder } = await import("../engine.mjs");
    assert.equal(parseLeaseHolder(agentId)?.pid, process.pid);
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards --wait-lease only at a flag position", async () => {
    const dir = tmpDir("engine-cli-test-");
    const runIssue = mock.fn(async () => ({ terminalReason: "merged" }));
    await capture(() => runFromCli(["42", "--lane", "staging", "--path", "full", "--wait-lease"], { io, runIssue, dir }));
    assert.equal(runIssue.mock.calls[0].arguments[0].waitLease, true);
    await capture(() => runFromCli(["42", "--lane", "staging", "--path", "full"], { io, runIssue, dir }));
    assert.ok(!("waitLease" in runIssue.mock.calls[1].arguments[0]));
    rmSync(dir, { recursive: true, force: true });
  });
});

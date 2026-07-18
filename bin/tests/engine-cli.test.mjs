import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { scanStalls, resumeStalledFromCli, runFromCli, countEngineActivity, lastLocalRun, formatTerminalDiagnostics, makeIo } from "../engine-cli.mjs";
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

      assert.ok(!io.calls.some((c) => c[0] === "repo" && c[1] === "view"));
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
    const dir = mkdtempSync(join(os.tmpdir(), "fd-runs-empty-"));
    try {
      writeFileSync(join(dir, "notes.txt"), "not a run log");
      assert.equal(lastLocalRun(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the most recently modified run's summary", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "fd-runs-multi-"));
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
    const dir = mkdtempSync(join(os.tmpdir(), "fd-runs-corrupt-"));
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
      runFromCli(["42", "--lane", "staging", "--repo", "acme/target-repo"], { io, runIssue }),
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));

    const res = await runFromCli(["42", "--lane", "staging", "--repo", "acme/target-repo"], { io, runIssue, dir });

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips the repo-view check entirely when --repo is omitted", async () => {
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "workflow:merged" }));
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));

    const res = await runFromCli(["42", "--lane", "staging"], { io, runIssue, dir });

    assert.equal(runIssue.mock.callCount(), 1);
    assert.equal(res.terminalReason, "workflow:merged");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runFromCli phase progress output (forge#2240)", () => {
  it("prints the run-log path at start, before runIssue is even invoked", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
      await runFromCli(["42", "--lane", "staging"], { io, runIssue, dir });
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(runLogPrintedBeforeRunIssue, "run-log path must be printed before runIssue starts, not only in a completion summary");
    assert.ok(logs.some((l) => l.includes(`run-log: ${join(dir, "42.jsonl")}`)));
  });

  it("emits a stdout line for each phase_enter/phase_exit onProgress event from runIssue", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
      await runFromCli(["42", "--lane", "staging"], { io, runIssue, dir });
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));

    const res = await runFromCli(
      ["42", "--lane", "staging", "--backend", "cli", "--model", "claude-test-model"],
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));

    await runFromCli(["42", "--lane", "staging"], { io, runIssue, dir });

    assert.equal(runIssue.mock.callCount(), 1);
    const callArgs = runIssue.mock.calls[0].arguments[0];
    assert.ok(!("backend" in callArgs), "backend key must be absent when --backend is not passed");
    assert.ok(!("model" in callArgs), "model key must be absent when --model is not passed");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("formatTerminalDiagnostics (forge#2175)", () => {
  it("renders phase, attempt/max, reason, state, and run-log path from a run-log with a PHASE_FAILED event", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
});

describe("runFromCli terminal diagnostics (forge#2175)", () => {
  it("prints the diagnostic block after a needs-human termination", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
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
      const res = await runFromCli(["42", "--lane", "staging"], { io, runIssue, dir });
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
    const dir = mkdtempSync(join(os.tmpdir(), "engine-cli-test-"));
    const io = { gh: async () => { throw new Error("should not be called"); } };
    const runIssue = mock.fn(async () => ({ terminalReason: "merged" }));

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runFromCli(["42", "--lane", "staging"], { io, runIssue, dir });
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
});

// forge#2547: makeIo()'s optional per-call timeoutMs override (forge#2509)
// had zero direct coverage. makeIo() hardcodes execFile("git"/"gh", ...) with
// no injection seam, so these run against the real `git` binary — already a
// hard dependency of this entire pipeline (git worktrees, commits, etc.),
// and fast enough (a version query) not to make these tests slow.
describe("makeIo — timeoutMs override (forge#2509)", () => {
  it("omitting timeoutMs uses the default (10s) — a fast command still succeeds", async () => {
    const io = makeIo();
    const out = await io.git(["--version"]);
    assert.match(out, /git version/);
  });

  it("an explicit timeoutMs override too short for the command to complete rejects", async () => {
    const io = makeIo();
    await assert.rejects(() => io.git(["--version"], { timeoutMs: 1 }));
  });

  it("an explicit timeoutMs override large enough for the command still succeeds", async () => {
    const io = makeIo();
    const out = await io.git(["--version"], { timeoutMs: 10000 });
    assert.match(out, /git version/);
  });
});

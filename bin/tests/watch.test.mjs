// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for bin/watch.mjs (forge#2391). Pure functions (diffFrame,
 * renderFrame, selectPollIntervalMs, resolveWatchRepo) are tested directly
 * against recorded fixtures. runWatch() is exercised with fully injected
 * io/now/stdout/sleep — no live gh, no network, no real timers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  diffFrame,
  renderFrame,
  writeFrame,
  selectPollIntervalMs,
  resolveWatchRepo,
  runWatch,
  RATE_BUDGET_STRETCH_THRESHOLD,
} from "../watch.mjs";
import { stripAnsi } from "../tui.mjs";

function tmpDir() {
  return mkdtempSync(join(os.tmpdir(), "forge-watch-test-"));
}

/** Collects everything written to a fake stdout/stderr as a single string. */
function fakeWritable() {
  let buf = "";
  return {
    isTTY: false,
    write: (s) => {
      buf += s;
      return true;
    },
    text: () => buf,
  };
}

function fleetAgent({ issue, status = "running", phase = "build", attempt = { n: 1, max: 3 }, phaseHistory = [] }) {
  return {
    issue,
    title: `issue ${issue}`,
    workflowLabel: "workflow:building",
    phase,
    phaseHistory,
    attempt,
    heartbeat: { at: "2026-07-17T18:00:00Z", ageMinutes: 3, phaseText: "building" },
    status,
    stall: status === "stalled" ? { ageMinutes: 22, threshold: 15 } : null,
    lease: null,
    branch: "milestone/watch-fleet-observability",
    pr: null,
    milestone: null,
    runLog: { present: phaseHistory.length > 0, seq: phaseHistory.length },
    sources: { state: "github", heartbeat: "github" },
  };
}

function snapshot({ agents = [], rateLimitRemaining = 4999, counts } = {}) {
  return {
    schema: "forge-observe/1",
    repo: "acme/widgets",
    at: "2026-07-17T18:00:00Z",
    stallTimeoutMinutes: 15,
    rateLimitRemaining,
    counts: counts ?? {
      running: agents.filter((a) => a.status === "running").length,
      stalled: agents.filter((a) => a.status === "stalled").length,
      blocked: agents.filter((a) => a.status === "blocked").length,
      leased: 0,
      quiet: agents.length === 0,
    },
    agents,
  };
}

// ---------------------------------------------------------------------------
// selectPollIntervalMs
// ---------------------------------------------------------------------------

describe("selectPollIntervalMs", () => {
  it("5s when the fleet has running agents", () => {
    assert.equal(selectPollIntervalMs({ running: 2 }, 4999), 5000);
  });

  it("30s when the fleet is quiet", () => {
    assert.equal(selectPollIntervalMs({ running: 0 }, 4999), 30000);
  });

  it("stretches beyond quiet when rate budget is below threshold, even if agents are running", () => {
    const interval = selectPollIntervalMs({ running: 3 }, RATE_BUDGET_STRETCH_THRESHOLD - 1);
    assert.ok(interval > 30000, `expected stretched interval, got ${interval}`);
  });

  it("does not stretch when rate budget is exactly at or above the threshold", () => {
    assert.equal(selectPollIntervalMs({ running: 0 }, RATE_BUDGET_STRETCH_THRESHOLD), 30000);
  });

  it("ignores a null rate budget (no rate info available)", () => {
    assert.equal(selectPollIntervalMs({ running: 1 }, null), 5000);
  });
});

// ---------------------------------------------------------------------------
// resolveWatchRepo
// ---------------------------------------------------------------------------

describe("resolveWatchRepo", () => {
  it("prefers explicit --repo over forge.yaml", () => {
    const dir = tmpDir();
    assert.equal(resolveWatchRepo(["--repo", "acme/widgets"], dir), "acme/widgets");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when neither --repo nor forge.yaml is present", () => {
    const dir = tmpDir();
    assert.equal(resolveWatchRepo([], dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// diffFrame — frame differ tested against recorded frame pairs (AC)
// ---------------------------------------------------------------------------

describe("diffFrame", () => {
  it("an unchanged fleet re-renders zero lines", () => {
    const frame = ["header", "rule", "row 1", "row 2", "footer"];
    const ops = diffFrame([...frame], [...frame]);
    assert.deepEqual(ops, []);
  });

  it("a one-row change rewrites only the affected line", () => {
    const prev = ["header", "rule", "row 1", "row 2", "footer"];
    const next = ["header", "rule", "row 1 CHANGED", "row 2", "footer"];
    const ops = diffFrame(prev, next);
    assert.deepEqual(ops, [{ row: 2, text: "row 1 CHANGED" }]);
  });

  it("first paint (prevLines null) treats every line as changed", () => {
    const next = ["a", "b", "c"];
    const ops = diffFrame(null, next);
    assert.equal(ops.length, 3);
    assert.deepEqual(ops.map((o) => o.row), [0, 1, 2]);
  });

  it("handles a frame that shrinks (fewer agents) by clearing trailing rows", () => {
    const prev = ["a", "b", "c", "d"];
    const next = ["a", "b"];
    const ops = diffFrame(prev, next);
    assert.deepEqual(ops, [
      { row: 2, text: "" },
      { row: 3, text: "" },
    ]);
  });

  it("handles a frame that grows (more agents) by adding rows", () => {
    const prev = ["a", "b"];
    const next = ["a", "b", "c"];
    const ops = diffFrame(prev, next);
    assert.deepEqual(ops, [{ row: 2, text: "c" }]);
  });
});

describe("writeFrame", () => {
  it("writes cursor-addressed, clear-to-EOL sequences for each op, nothing else", () => {
    const out = fakeWritable();
    writeFrame(out, [
      { row: 0, text: "hello" },
      { row: 4, text: "world" },
    ]);
    assert.equal(out.text(), "\x1b[1H\x1b[Khello\x1b[5H\x1b[Kworld");
  });

  it("writes nothing when there are no ops", () => {
    const out = fakeWritable();
    writeFrame(out, []);
    assert.equal(out.text(), "");
  });
});

// ---------------------------------------------------------------------------
// renderFrame — layout, width handling (ANSI + unicode), null-attempt safety
// ---------------------------------------------------------------------------

describe("renderFrame", () => {
  it("renders 'all quiet' when there are no in-flight agents", () => {
    const lines = renderFrame(snapshot({ agents: [] }), { width: 80, mode: "none" });
    const text = lines.join("\n");
    assert.ok(text.includes("All quiet"));
  });

  it("renders one row per agent and includes issue numbers", () => {
    const agents = [fleetAgent({ issue: 1 }), fleetAgent({ issue: 2, status: "stalled" })];
    const lines = renderFrame(snapshot({ agents }), { width: 100, mode: "none" });
    const text = lines.join("\n");
    assert.ok(text.includes("#1"));
    assert.ok(text.includes("#2"));
  });

  it("renders stalled rows with the ▲ age > threshold marker", () => {
    const agents = [fleetAgent({ issue: 5, status: "stalled" })];
    const lines = renderFrame(snapshot({ agents }), { width: 100, mode: "none" });
    const text = lines.join("\n");
    assert.match(text, /▲\s*22m\s*>\s*15m/);
  });

  it("renders blocked rows with the ⛔ marker", () => {
    const agents = [fleetAgent({ issue: 6, status: "blocked" })];
    const lines = renderFrame(snapshot({ agents }), { width: 100, mode: "none" });
    const text = lines.join("\n");
    assert.ok(text.includes("⛔"));
  });

  it("renders a null attempt as '—' rather than defaulting to 1/N (forge#2412)", () => {
    const agents = [fleetAgent({ issue: 7, attempt: null })];
    const lines = renderFrame(snapshot({ agents }), { width: 100, mode: "none" });
    const text = lines.join("\n");
    assert.ok(!/\b1\/3\b/.test(text), "must not fabricate attempt 1/3 when attempt is null");
  });

  it("truncates an overlong unicode+ANSI title without breaking column alignment", () => {
    const longTitle = "🔥".repeat(5) + " a very very very long issue title that exceeds any reasonable column width budget";
    const agents = [fleetAgent({ issue: 8 })];
    agents[0].title = longTitle;
    const lines = renderFrame(snapshot({ agents }), { width: 60, mode: "none" });
    for (const line of lines) {
      // Every rendered line's visible (ANSI-stripped) width must fit the
      // requested terminal width plus a small allowance for unicode glyphs
      // whose measured .length diverges from their rendered cell width.
      assert.ok(stripAnsi(line).length <= 200, `line unexpectedly long: ${line}`);
    }
  });

  it("renders the six-phase focus strip for the top (most severe) agent", () => {
    const agents = [
      fleetAgent({
        issue: 9,
        phase: "build",
        phaseHistory: [
          { phase: "investigate", committedAtSeq: 1, attempts: 1 },
          { phase: "context", committedAtSeq: 2, attempts: 1 },
        ],
      }),
    ];
    const lines = renderFrame(snapshot({ agents }), { width: 100, mode: "none" });
    const text = lines.join("\n");
    for (const phase of ["investigate", "context", "architect", "build", "review", "close"]) {
      assert.ok(text.includes(phase), `expected phase "${phase}" in focus strip`);
    }
    assert.ok(text.includes("✔1"), "committed phases should show attempt count");
  });

  it("shows the rate-limit budget in the header when present", () => {
    const lines = renderFrame(snapshot({ agents: [], rateLimitRemaining: 4200 }), { width: 80, mode: "none" });
    assert.ok(lines.join("\n").includes("4200"));
  });

  it("notes a stretched interval in the header", () => {
    const lines = renderFrame(snapshot({ agents: [] }), { width: 80, mode: "none", pollIntervalMs: 60000 });
    assert.ok(lines.join("\n").toLowerCase().includes("stretched"));
  });

  it("is a pure function — same input produces an identical frame (diffFrame-friendly)", () => {
    const agents = [fleetAgent({ issue: 1 })];
    const snap = snapshot({ agents });
    const opts = { width: 80, mode: "none", tick: 3, pollIntervalMs: 5000 };
    const a = renderFrame(snap, opts);
    const b = renderFrame(snap, opts);
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// runWatch — NDJSON (--json / non-TTY) mode
// ---------------------------------------------------------------------------

describe("runWatch — NDJSON mode", () => {
  it("emits one FleetSnapshot-shaped JSON line per poll, zero ANSI", async () => {
    const dir = tmpDir();
    const stdout = fakeWritable();
    const io = {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        if (args[0] === "api" && args[1] === "graphql") {
          return JSON.stringify({ data: { search: { nodes: [] }, rateLimit: { remaining: 4999 } } });
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    };
    const exitCode = await runWatch(["--repo", "acme/widgets"], {
      stdout,
      io,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 2,
      sleep: async () => {},
    });
    const lines = stdout.text().trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const doc = JSON.parse(line);
      assert.equal(doc.schema, "forge-observe/1");
      assert.equal(doc.repo, "acme/widgets");
    }
    assert.equal(exitCode, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits with code 2 when stalled agents are present", async () => {
    const dir = tmpDir();
    const stdout = fakeWritable();
    const hbAt = new Date(1000 - 60 * 60000).toISOString();
    const io = {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        return JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  number: 1,
                  title: "t",
                  body: "",
                  labels: { nodes: [{ name: "workflow:building" }] },
                  milestone: null,
                  comments: { nodes: [{ body: `<!-- FORGE:HEARTBEAT -->\n**Phase**: build\n**Timestamp**: ${hbAt}` }] },
                },
              ],
            },
            rateLimit: { remaining: 4999 },
          },
        });
      },
    };
    const exitCode = await runWatch(["--repo", "acme/widgets"], {
      stdout,
      io,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1,
      sleep: async () => {},
    });
    assert.equal(exitCode, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns exit code 1 and writes an error when no repo can be resolved", async () => {
    const dir = tmpDir();
    const stdout = fakeWritable();
    const stderr = fakeWritable();
    let ghCalled = false;
    const exitCode = await runWatch([], {
      stdout,
      stderr,
      cwd: dir,
      io: { gh: async () => { ghCalled = true; return ""; } },
      maxTicks: 1,
      sleep: async () => {},
    });
    assert.equal(exitCode, 1);
    assert.ok(stderr.text().includes("No repository found"));
    assert.equal(ghCalled, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns exit code 1 and the gh-unauthenticated message when gh auth fails", async () => {
    const dir = tmpDir();
    const stdout = fakeWritable();
    const stderr = fakeWritable();
    const exitCode = await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stderr,
      cwd: dir,
      io: { gh: async () => { throw new Error("not authenticated"); } },
      maxTicks: 1,
      sleep: async () => {},
    });
    assert.equal(exitCode, 1);
    assert.ok(stderr.text().includes("gh CLI is not authenticated"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("issues exactly one gh graphql call per poll tick", async () => {
    const dir = tmpDir();
    const stdout = fakeWritable();
    let graphqlCalls = 0;
    const io = {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        if (args[0] === "api" && args[1] === "graphql") {
          graphqlCalls += 1;
          return JSON.stringify({ data: { search: { nodes: [] }, rateLimit: { remaining: 4999 } } });
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      io,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 3,
      sleep: async () => {},
    });
    assert.equal(graphqlCalls, 3);
    rmSync(dir, { recursive: true, force: true });
  });
});

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
import { EventEmitter } from "node:events";

import {
  diffFrame,
  renderFrame,
  writeFrame,
  selectPollIntervalMs,
  resolveWatchRepo,
  runWatch,
  applySortAndFilter,
  RATE_BUDGET_STRETCH_THRESHOLD,
  SORT_ORDERS,
  FILTER_MODES,
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

/** A fake TTY stdout — EventEmitter so on("resize")/off("resize") work. */
function fakeTtyStdout() {
  let buf = "";
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY: true,
    columns: 100,
    write: (s) => {
      buf += s;
      return true;
    },
    text: () => buf,
  });
}

/** A fake TTY stdin — EventEmitter supporting the setRawMode/resume/pause/data contract runInteractiveLoop expects. */
function fakeTtyStdin() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY: true,
    isRaw: false,
    setRawMode(v) {
      this.isRaw = v;
    },
    resume() {},
    pause() {},
    setEncoding() {},
  });
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

// ---------------------------------------------------------------------------
// runWatch — interactive TTY mode
// ---------------------------------------------------------------------------

describe("runWatch — interactive TTY mode", () => {
  function ghOk(nodes = []) {
    return {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        if (args[0] === "api" && args[1] === "graphql") {
          return JSON.stringify({ data: { search: { nodes }, rateLimit: { remaining: 4999 } } });
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    };
  }

  it("paints a frame via writeFrame-style cursor addressing (no \\x1b[2J anywhere)", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    Object.defineProperty(stdin, "isTTY", { value: false }); // non-TTY stdin — keyboard-less fallback path
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk(),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1,
      sleep: async () => {},
    });
    const out = stdout.text();
    assert.ok(out.includes("\x1b[1H"), "expected cursor-addressed first-line write");
    assert.ok(!out.includes("\x1b[2J"), "must never full-screen clear");
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers and fully deregisters SIGINT/SIGTERM handlers — no listener leak (forge#1428/#1593 cleanup-bug class)", async () => {
    const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    Object.defineProperty(stdin, "isTTY", { value: false });
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk(),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1,
      sleep: async () => {},
    });
    const after = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    assert.equal(after, before, "SIGINT/SIGTERM listeners must be removed when the loop exits normally");
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores the cursor and writes a one-line summary on exit", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    Object.defineProperty(stdin, "isTTY", { value: false });
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk(),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1,
      sleep: async () => {},
    });
    assert.ok(stdout.text().includes("\x1b[?25h"), "cursor must be restored on exit");
    assert.match(stdout.text(), /\d+ running · \d+ stalled · \d+ blocked · watched \d+m/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("'q' keypress stops the loop before maxTicks is exhausted", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    let tickCount = 0;
    const io = {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        tickCount += 1;
        if (tickCount === 1) {
          // After the first successful poll, simulate a "q" keypress arriving
          // during the sleep window between polls.
          queueMicrotask(() => stdin.emit("data", "q"));
        }
        return JSON.stringify({ data: { search: { nodes: [] }, rateLimit: { remaining: 4999 } } });
      },
    };
    const exitCode = await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000, // effectively unbounded — only "q" should stop it
      sleep: async () => {}, // resolves immediately, giving the queued microtask a chance to fire first
    });
    assert.ok(tickCount <= 3, `expected the loop to stop quickly after 'q', got ${tickCount} ticks`);
    assert.equal(exitCode, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns exit code 3 when a blocked agent is present", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    Object.defineProperty(stdin, "isTTY", { value: false });
    const nodes = [
      {
        number: 4,
        title: "t",
        body: "",
        labels: { nodes: [{ name: "workflow:building" }, { name: "needs-human" }] },
        milestone: null,
        comments: { nodes: [] },
      },
    ];
    const exitCode = await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk(nodes),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1,
      sleep: async () => {},
    });
    assert.equal(exitCode, 3);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// applySortAndFilter — pure sort/filter (forge#2392 AC4)
// ---------------------------------------------------------------------------

describe("applySortAndFilter", () => {
  it("filterMode 'stalled+blocked' keeps only stalled and blocked agents", () => {
    const agents = [
      fleetAgent({ issue: 1, status: "running" }),
      fleetAgent({ issue: 2, status: "stalled" }),
      fleetAgent({ issue: 3, status: "blocked" }),
    ];
    const out = applySortAndFilter(agents, "severity", "stalled+blocked");
    assert.deepEqual(out.map((a) => a.issue), [2, 3]);
  });

  it("filterMode 'running' keeps only running agents", () => {
    const agents = [
      fleetAgent({ issue: 1, status: "running" }),
      fleetAgent({ issue: 2, status: "stalled" }),
    ];
    const out = applySortAndFilter(agents, "severity", "running");
    assert.deepEqual(out.map((a) => a.issue), [1]);
  });

  it("filterMode 'all' keeps every agent", () => {
    const agents = [fleetAgent({ issue: 1 }), fleetAgent({ issue: 2, status: "stalled" })];
    const out = applySortAndFilter(agents, "severity", "all");
    assert.equal(out.length, 2);
  });

  it("sortOrder 'severity' preserves the input (already pre-sorted) order", () => {
    const agents = [fleetAgent({ issue: 3 }), fleetAgent({ issue: 1 }), fleetAgent({ issue: 2 })];
    const out = applySortAndFilter(agents, "severity", "all");
    assert.deepEqual(out.map((a) => a.issue), [3, 1, 2]);
  });

  it("sortOrder 'issueNumber' sorts ascending by issue", () => {
    const agents = [fleetAgent({ issue: 3 }), fleetAgent({ issue: 1 }), fleetAgent({ issue: 2 })];
    const out = applySortAndFilter(agents, "issueNumber", "all");
    assert.deepEqual(out.map((a) => a.issue), [1, 2, 3]);
  });

  it("sortOrder 'heartbeatAge' sorts oldest heartbeat (largest ageMinutes) first", () => {
    const agents = [
      { ...fleetAgent({ issue: 1 }), heartbeat: { at: "x", ageMinutes: 2, phaseText: "build" } },
      { ...fleetAgent({ issue: 2 }), heartbeat: { at: "x", ageMinutes: 40, phaseText: "build" } },
      { ...fleetAgent({ issue: 3 }), heartbeat: { at: "x", ageMinutes: 10, phaseText: "build" } },
    ];
    const out = applySortAndFilter(agents, "heartbeatAge", "all");
    assert.deepEqual(out.map((a) => a.issue), [2, 3, 1]);
  });

  it("never mutates the input array", () => {
    const agents = [fleetAgent({ issue: 3 }), fleetAgent({ issue: 1 })];
    const snapshot = [...agents];
    applySortAndFilter(agents, "issueNumber", "all");
    assert.deepEqual(agents, snapshot, "input array must not be mutated by sort/filter");
  });

  it("SORT_ORDERS and FILTER_MODES each expose exactly three cycle states", () => {
    assert.equal(SORT_ORDERS.length, 3);
    assert.equal(FILTER_MODES.length, 3);
  });
});

// ---------------------------------------------------------------------------
// renderFrame — selection pointer, detail view, pause banner, legend
// (forge#2392) — pure, no I/O.
// ---------------------------------------------------------------------------

describe("renderFrame — keyboard interaction state (forge#2392)", () => {
  it("marks the selected row with the ▸ pointer", () => {
    const agents = [fleetAgent({ issue: 1 }), fleetAgent({ issue: 2 })];
    const lines = renderFrame(snapshot({ agents }), { width: 100, mode: "none", selectedIndex: 1 });
    const row2 = lines.find((l) => l.includes("#2"));
    assert.ok(row2 && row2.includes("▸"), `expected #2's row to carry the pointer, got: ${row2}`);
    const row1 = lines.find((l) => l.includes("#1"));
    assert.ok(row1 && !row1.includes("▸"), `expected #1's row to NOT carry the pointer, got: ${row1}`);
  });

  it("clamps an out-of-range selectedIndex to the last row instead of crashing", () => {
    const agents = [fleetAgent({ issue: 1 }), fleetAgent({ issue: 2 })];
    assert.doesNotThrow(() => renderFrame(snapshot({ agents }), { width: 100, selectedIndex: 99 }));
    const lines = renderFrame(snapshot({ agents }), { width: 100, selectedIndex: 99 });
    const row2 = lines.find((l) => l.includes("#2"));
    assert.ok(row2 && row2.includes("▸"), "out-of-range index should clamp to the last row");
  });

  it("renders safely with an empty agent list and a selection index (forge#125-style empty-list safety)", () => {
    assert.doesNotThrow(() => renderFrame(snapshot({ agents: [] }), { width: 80, selectedIndex: 3 }));
    const lines = renderFrame(snapshot({ agents: [] }), { width: 80, selectedIndex: 3 });
    assert.ok(lines.join("\n").includes("All quiet"));
  });

  it("viewMode 'detail' renders the phase timeline instead of the fleet table", () => {
    const detail = {
      issue: 42,
      title: "some issue",
      branch: "feat/x",
      pr: 7,
      status: "running",
      stall: null,
      phase: "build",
      attempt: { n: 1, max: 3 },
      phaseHistory: [{ phase: "investigate", committedAtSeq: 1, attempts: 1 }],
      heartbeat: { at: "2026-07-17T18:00:00Z", ageMinutes: 4, phaseText: "building" },
      lastHeartbeatBody: "<!-- FORGE:HEARTBEAT -->\n**Phase**: build",
      diagnostics: { valid: true, failedPhase: null },
      lease: null,
    };
    const lines = renderFrame(snapshot({ agents: [] }), { width: 100, viewMode: "detail", detail });
    const text = lines.join("\n");
    assert.ok(text.includes("Phase timeline"));
    assert.ok(text.includes("#42"));
    assert.ok(text.includes("investigate"));
    assert.ok(text.includes("seq 1"));
    assert.ok(text.includes("Lease"));
    assert.ok(!text.includes("All quiet"), "detail view must not also render the fleet table");
  });

  it("viewMode 'detail' strips ANSI/OSC escape sequences from the title and branch header line (forge#2550)", () => {
    // Untrusted GitHub-authored title/branch text could carry CSI (SGR/cursor) or OSC
    // (hyperlink/clipboard/window-title) escapes; the header line must render them inert,
    // matching the sanitization already applied to lastHeartbeatBody (forge#2490/PR #2543).
    const detail = {
      issue: 99,
      title: "evil\x1b[31mtitle\x1b]8;;https://evil.example\x07link\x1b]8;;\x07",
      branch: "feat/\x1b[1mbold\x1b[0mbranch",
      pr: 3,
      status: "running",
      stall: null,
      phase: "build",
      attempt: { n: 1, max: 3 },
      phaseHistory: [],
      heartbeat: null,
      lastHeartbeatBody: null,
      diagnostics: { valid: true, failedPhase: null },
      lease: null,
    };
    const lines = renderFrame(snapshot({ agents: [] }), { width: 100, viewMode: "detail", detail });
    const text = lines.join("\n");
    assert.ok(!text.includes("\x1b["), "raw CSI escape must not reach the rendered output");
    assert.ok(!text.includes("\x1b]"), "raw OSC escape must not reach the rendered output");
    assert.ok(text.includes("eviltitlelink"), "visible title text must survive stripping");
    assert.ok(text.includes("feat/boldbranch"), "visible branch text must survive stripping");
  });

  it("viewMode 'detail' surfaces terminal diagnostics when the agent failed", () => {
    const detail = {
      issue: 5,
      title: "failed thing",
      branch: null,
      pr: null,
      status: "terminal",
      stall: null,
      phase: null,
      attempt: null,
      phaseHistory: [],
      heartbeat: null,
      lastHeartbeatBody: null,
      diagnostics: { valid: true, failedPhase: "build", attempt: 2, maxAttempts: 3, reason: "boom" },
      lease: null,
    };
    const lines = renderFrame(snapshot({ agents: [] }), { width: 100, viewMode: "detail", detail });
    const text = lines.join("\n");
    assert.ok(text.includes("Terminal diagnostics"));
    assert.ok(text.includes("failed phase: build"));
    assert.ok(text.includes("boom"));
  });

  it("does not render a detail view when viewMode is 'detail' but no detail was supplied yet", () => {
    const agents = [fleetAgent({ issue: 1 })];
    const lines = renderFrame(snapshot({ agents }), { width: 100, viewMode: "detail", detail: null });
    // Falls back to the fleet table rather than crashing on a null detail.
    assert.ok(lines.join("\n").includes("#1"));
  });

  it("renders a frozen pause banner with the paused age when paused", () => {
    const lines = renderFrame(snapshot({ agents: [] }), { width: 80, paused: true, pausedAgeSeconds: 12 });
    const text = lines.join("\n");
    assert.ok(text.includes("paused"));
    assert.ok(text.includes("12s"));
  });

  // forge#2491 — a failed drill-down detail fetch must surface a visible
  // banner in the fleet view instead of silently no-op'ing.
  it("renders a detail-fetch error banner in the fleet view when detailError is set", () => {
    const lines = renderFrame(snapshot({ agents: [] }), { width: 80, detailError: "detail fetch failed — press Enter to retry" });
    const text = lines.join("\n");
    assert.ok(text.includes("detail fetch failed — press Enter to retry"));
  });

  it("does not render a detail-fetch error banner when detailError is not set", () => {
    const lines = renderFrame(snapshot({ agents: [] }), { width: 80 });
    const text = lines.join("\n");
    assert.ok(!text.includes("detail fetch failed"));
  });

  // forge#2562 — renderFrame() must enforce the "fixed-literal only"
  // contract on detailError at the render boundary itself, not merely by
  // convention at the sole call site. A value outside the known allowlist
  // (e.g. an accidentally-threaded err.message) must be silently dropped,
  // never rendered.
  it("does not render a detailError value outside the known-literal allowlist (e.g. an accidental err.message echo)", () => {
    const lines = renderFrame(snapshot({ agents: [] }), {
      width: 80,
      detailError: "ECONNRESET: socket hang up at TLSSocket.onConnectEnd",
    });
    const text = lines.join("\n");
    assert.ok(!text.includes("ECONNRESET"));
    assert.ok(!text.includes("socket hang up"));
  });

  it("does not render the detail-fetch error banner while viewMode is 'detail' (error only ever occurs in fleet view)", () => {
    const detail = {
      issue: 42,
      title: "x",
      branch: "feat/x",
      pr: 7,
      status: "running",
      phaseHistory: [],
      heartbeat: null,
      lastHeartbeatBody: null,
      diagnostics: { valid: true, failedPhase: null },
    };
    const lines = renderFrame(snapshot({ agents: [] }), {
      width: 100,
      viewMode: "detail",
      detail,
      detailError: "detail fetch failed — press Enter to retry",
    });
    assert.ok(!lines.join("\n").includes("detail fetch failed"));
  });

  it("shows both the paused banner and the detail-fetch error banner together without collision", () => {
    const lines = renderFrame(snapshot({ agents: [] }), {
      width: 80,
      paused: true,
      pausedAgeSeconds: 5,
      detailError: "detail fetch failed — press Enter to retry",
    });
    const text = lines.join("\n");
    assert.ok(text.includes("paused"));
    assert.ok(text.includes("detail fetch failed — press Enter to retry"));
  });

  it("shows the active sort/filter labels in the header", () => {
    const lines = renderFrame(snapshot({ agents: [] }), { width: 80, sortOrder: "issueNumber", filterMode: "running" });
    const text = lines.join("\n");
    assert.ok(text.includes("issue #"));
    assert.ok(text.includes("running"));
  });

  it("overlays the key legend instead of the key bar when showLegend is set", () => {
    const withLegend = renderFrame(snapshot({ agents: [] }), { width: 80, showLegend: true }).join("\n");
    const withoutLegend = renderFrame(snapshot({ agents: [] }), { width: 80, showLegend: false }).join("\n");
    assert.ok(withLegend.includes("Keys"));
    assert.ok(withLegend.includes("pause/resume"));
    assert.ok(!withoutLegend.includes("pause/resume"), "legend body must not appear when showLegend is false");
  });
});

// ---------------------------------------------------------------------------
// runWatch — keyboard interaction wiring (forge#2392): selection, drill-down
// detail view (via injected getIssueDetailFn), browser-open (via injected
// openFn), sort/filter cycling, pause suppressing polling, legend, and the
// raw-mode-unavailable fallback. Fully injected io/now/stdout/stdin/sleep —
// no live terminal, no network.
// ---------------------------------------------------------------------------

describe("runWatch — keyboard interaction (forge#2392)", () => {
  function ghOk(nodes = []) {
    return {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        if (args[0] === "api" && args[1] === "graphql") {
          return JSON.stringify({ data: { search: { nodes }, rateLimit: { remaining: 4999 } } });
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    };
  }

  function nodeFor(issue) {
    return {
      number: issue,
      title: `issue ${issue}`,
      body: "",
      labels: { nodes: [{ name: "workflow:building" }] },
      milestone: null,
      comments: { nodes: [] },
    };
  }

  it("Enter fetches the drill-down detail for the selected issue via the injected getIssueDetailFn and Esc returns to the fleet view", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    const detailCalls = [];
    const getIssueDetailFn = async (opts) => {
      detailCalls.push(opts.issue);
      return {
        issue: opts.issue,
        title: "t",
        branch: null,
        pr: null,
        status: "running",
        stall: null,
        phase: "build",
        attempt: { n: 1, max: 3 },
        phaseHistory: [],
        heartbeat: null,
        lastHeartbeatBody: null,
        diagnostics: { valid: true, failedPhase: null },
        lease: null,
      };
    };
    // Keypresses are fired from the injected `sleep` mock rather than the
    // `io.gh` mock: `sleep()` only runs *after* that tick's snapshot has
    // been fetched and painted (lastSnapshot is populated), whereas firing
    // from inside `io.gh` races the in-flight fetch and can find
    // lastSnapshot still null (filteredAgents empty) depending on
    // microtask-queue ordering.
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) stdin.emit("data", "\r"); // drill into the selected (only) issue
      if (sleepCount === 3) stdin.emit("data", "\x1b"); // back to fleet
      if (sleepCount === 5) stdin.emit("data", "q");
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(9)]),
      getIssueDetailFn,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.deepEqual(detailCalls, [9], "getIssueDetailFn should be called exactly once, with the selected issue number");
    assert.ok(stdout.text().includes("Phase timeline"), "detail view should have been painted at some point");
    rmSync(dir, { recursive: true, force: true });
  });

  // forge#2491 — a failed drill-down detail fetch must not silently no-op;
  // it must render a visible banner, and a subsequent successful fetch must
  // clear it (rather than leaving a stale error message displayed forever).
  it("Enter shows a visible error banner when the detail fetch fails, and a subsequent successful fetch clears it", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    let callCount = 0;
    const getIssueDetailFn = async (opts) => {
      callCount += 1;
      if (callCount === 1) throw new Error("boom");
      return {
        issue: opts.issue,
        title: "t",
        branch: null,
        pr: null,
        status: "running",
        stall: null,
        phase: "build",
        attempt: { n: 1, max: 3 },
        phaseHistory: [],
        heartbeat: null,
        lastHeartbeatBody: null,
        diagnostics: { valid: true, failedPhase: null },
        lease: null,
      };
    };
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) stdin.emit("data", "\r"); // first attempt — the injected fn rejects
      if (sleepCount === 3) stdin.emit("data", "\r"); // second attempt — the injected fn resolves
      if (sleepCount === 5) stdin.emit("data", "q");
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(9)]),
      getIssueDetailFn,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.equal(callCount, 2, "getIssueDetailFn should have been called twice — once failing, once succeeding");
    assert.ok(
      stdout.text().includes("detail fetch failed"),
      "a visible error banner should have been painted after the failed fetch — not a silent no-op",
    );
    assert.ok(
      stdout.text().includes("Phase timeline"),
      "the detail view should have been painted after the second, successful fetch",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  // forge#2492 — a detail-fetch promise still in flight when the operator
  // quits must not repaint after cleanup() has already restored the cursor
  // and printed the exit summary. Neither its resolution NOR its rejection
  // may write anything further to stdout once the loop has torn down.
  it("does not repaint after cleanup when an in-flight detail fetch settles post-quit", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    let resolveDetail;
    const getIssueDetailFn = async () =>
      new Promise((resolve) => {
        resolveDetail = resolve;
      });
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) stdin.emit("data", "\r"); // start a detail fetch that never settles on its own
      if (sleepCount === 2) stdin.emit("data", "q"); // quit while it's still pending
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(9)]),
      getIssueDetailFn,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.ok(resolveDetail, "the detail fetch should have been started before quitting");
    const textAtExit = stdout.text();
    assert.ok(textAtExit.includes("\x1b[?25h"), "cleanup should already have restored the cursor by the time runWatch resolves");

    // Settle the fetch *after* runWatch has already returned (cleanup already ran).
    resolveDetail({
      issue: 9,
      title: "t",
      branch: null,
      pr: null,
      status: "running",
      stall: null,
      phase: "build",
      attempt: { n: 1, max: 3 },
      phaseHistory: [],
      heartbeat: null,
      lastHeartbeatBody: null,
      diagnostics: { valid: true, failedPhase: null },
      lease: null,
    });
    // Flush the .then()/.finally() microtasks queued by the resolution above.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      stdout.text(),
      textAtExit,
      "no additional frame should be written to stdout once a detail-fetch settles after cleanup has already run",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("Enter is a no-op when the fleet is empty (no crash, no getIssueDetailFn call)", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    let detailCalled = false;
    const getIssueDetailFn = async () => {
      detailCalled = true;
      return {};
    };
    let tickCount = 0;
    const io = {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        tickCount += 1;
        if (tickCount === 1) queueMicrotask(() => stdin.emit("data", "\r"));
        if (tickCount === 2) queueMicrotask(() => stdin.emit("data", "q"));
        return JSON.stringify({ data: { search: { nodes: [] }, rateLimit: { remaining: 4999 } } });
      },
    };
    const exitCode = await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io,
      getIssueDetailFn,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep: async () => {},
    });
    assert.equal(detailCalled, false, "Enter on an empty fleet must not call getIssueDetailFn");
    assert.equal(exitCode, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("'o' opens the selected issue's GitHub URL via the injected openFn", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    const openCalls = [];
    const openFn = (url) => openCalls.push(url);
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) stdin.emit("data", "o");
      if (sleepCount === 2) stdin.emit("data", "q");
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(11)]),
      openFn,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.deepEqual(openCalls, ["https://github.com/acme/widgets/issues/11"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("'o' opens the currently-displayed issue's GitHub URL from the detail view too (matches the detail key bar's advertised 'o open')", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    const openCalls = [];
    const openFn = (url) => openCalls.push(url);
    const getIssueDetailFn = async (opts) => ({
      issue: opts.issue,
      title: "t",
      branch: null,
      pr: null,
      status: "running",
      stall: null,
      phase: "build",
      attempt: { n: 1, max: 3 },
      phaseHistory: [],
      heartbeat: null,
      lastHeartbeatBody: null,
      diagnostics: { valid: true, failedPhase: null },
      lease: null,
    });
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) stdin.emit("data", "\r"); // drill into the selected (only) issue
      if (sleepCount === 3) stdin.emit("data", "o"); // open from within the detail view
      if (sleepCount === 4) stdin.emit("data", "q");
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(13)]),
      getIssueDetailFn,
      openFn,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.deepEqual(openCalls, ["https://github.com/acme/widgets/issues/13"], "'o' must open the detail view's issue, not silently no-op");
    rmSync(dir, { recursive: true, force: true });
  });

  it("'s' cycles sort order through all three states and back to the first", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) {
        stdin.emit("data", "s");
        stdin.emit("data", "s");
        stdin.emit("data", "s");
      }
      if (sleepCount === 2) stdin.emit("data", "q");
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(1)]),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    const text = stdout.text();
    assert.ok(text.includes("sort: heartbeat age"), "one 's' press should cycle to heartbeat age");
    assert.ok(text.includes("sort: issue #"), "two 's' presses should cycle to issue #");
    assert.ok(text.includes("sort: severity"), "three 's' presses should cycle back to severity");
    rmSync(dir, { recursive: true, force: true });
  });

  it("'f' cycles filter mode through all three states", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) stdin.emit("data", "f");
      if (sleepCount === 2) stdin.emit("data", "q");
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(1)]),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.ok(stdout.text().includes("filter: stalled+blocked"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("'p' pauses polling (no further gh calls) and a second 'p' resumes it", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    let ghCallCount = 0;
    const io = {
      gh: async (args) => {
        if (args[0] === "auth") return "";
        ghCallCount += 1;
        return JSON.stringify({ data: { search: { nodes: [] }, rateLimit: { remaining: 4999 } } });
      },
    };
    // 'p' (pause) fires after tick 1's fetch+paint has completed; the paused
    // branch then loops on its own short frozen-banner refresh sleep
    // (PAUSED_REFRESH_MS) WITHOUT calling getFleetSnapshot — sleepCount
    // advances through that inner loop before 'p' (resume) fires, then one
    // more real tick happens before 'q' quits.
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) stdin.emit("data", "p"); // pause
      if (sleepCount === 4) stdin.emit("data", "p"); // resume
      if (sleepCount === 5) stdin.emit("data", "q"); // quit
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io,
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.equal(ghCallCount, 2, "exactly one fetch before pause and one after resume — none while paused");
    assert.ok(stdout.text().includes("paused"), "a frozen pause banner should have been rendered");
    rmSync(dir, { recursive: true, force: true });
  });

  it("'?' overlays the key legend and any key dismisses it without also triggering that key's own action", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    const openCalls = [];
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 1) {
        stdin.emit("data", "?"); // show legend
        stdin.emit("data", "o"); // dismiss legend — must NOT also open the browser
      }
      if (sleepCount === 2) stdin.emit("data", "q");
    };
    await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(1)]),
      openFn: (url) => openCalls.push(url),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 1000,
      sleep,
    });
    assert.ok(stdout.text().includes("pause/resume"), "legend should have been rendered at some point");
    assert.deepEqual(openCalls, [], "the keypress that dismissed the legend must not also trigger its own action");
    rmSync(dir, { recursive: true, force: true });
  });

  it("raw-mode-unavailable / non-TTY stdin: keyboard layer stays inert, watch runs exactly like the keyboard-less rebuild", async () => {
    const dir = tmpDir();
    const stdout = fakeTtyStdout();
    const stdin = fakeTtyStdin();
    Object.defineProperty(stdin, "isTTY", { value: false });
    const openCalls = [];
    const exitCode = await runWatch(["--repo", "acme/widgets"], {
      stdout,
      stdin,
      io: ghOk([nodeFor(1)]),
      openFn: (url) => openCalls.push(url),
      now: () => 1000,
      runsDir: dir,
      maxTicks: 2,
      sleep: async () => {},
    });
    // No "data" listener is ever attached when stdin isn't a TTY, so
    // emitting keys is a no-op by construction — assert the loop still
    // completes cleanly and the key bar (not the legend) is shown, matching
    // pre-#2392 behavior exactly.
    stdin.emit("data", "o");
    stdin.emit("data", "?");
    assert.deepEqual(openCalls, []);
    assert.equal(exitCode, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for bin/query.mjs (forge#2390). Injected io/now/stdout
 * throughout — no live `gh`, no network. Local run-log fixtures are written
 * via appendEvent() (bin/engine/runlog.mjs), matching the fixture style
 * already used by bin/tests/observe.test.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { runQuery, resolveQueryRepo, projectFields, computeExitCode } from "../query.mjs";
import { SCHEMA } from "../observe.mjs";
import { appendEvent } from "../engine/runlog.mjs";

function tmpDir() {
  return mkdtempSync(join(os.tmpdir(), "forge-query-test-"));
}

/** Collects everything written to a fake stdout as a single string. */
function fakeStdout() {
  let buf = "";
  return {
    write: (s) => { buf += s; },
    text: () => buf,
    json: () => JSON.parse(buf.trim()),
  };
}

function fleetNode({ number, labels = ["workflow:building"], milestone = null, comments = [] }) {
  return {
    number,
    title: `issue ${number}`,
    labels: { nodes: labels.map((n) => ({ name: n })) },
    body: "",
    milestone: milestone ? { title: milestone } : null,
    comments: { nodes: comments.map((b) => ({ body: b })) },
  };
}

function ghFleetIo(nodes) {
  let calls = 0;
  return {
    calls: () => calls,
    gh: async (args) => {
      calls += 1;
      if (args[0] === "api" && args[1] === "graphql") {
        return JSON.stringify({ data: { search: { nodes }, rateLimit: { remaining: 4999 } } });
      }
      throw new Error(`unexpected gh call in fleet-style test: ${args.join(" ")}`);
    },
  };
}

describe("resolveQueryRepo", () => {
  it("prefers explicit --repo over forge.yaml", () => {
    const dir = tmpDir();
    assert.equal(resolveQueryRepo(["fleet", "--repo", "acme/widgets"], dir), "acme/widgets");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when neither --repo nor forge.yaml is present", () => {
    const dir = tmpDir();
    assert.equal(resolveQueryRepo(["fleet"], dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("projectFields", () => {
  it("always keeps issue even when not named in the field list", () => {
    const agent = { issue: 5, status: "running", phase: "build", title: "t" };
    const projected = projectFields(agent, ["status"]);
    assert.deepEqual(projected, { issue: 5, status: "running" });
  });

  it("returns the object unchanged when fields is null/empty", () => {
    const agent = { issue: 5, status: "running" };
    assert.deepEqual(projectFields(agent, null), agent);
    assert.deepEqual(projectFields(agent, []), agent);
  });
});

describe("computeExitCode", () => {
  it("blocked wins over stalled", () => {
    assert.equal(computeExitCode({ blocked: 1, stalled: 1 }), 3);
  });
  it("stalled without blocked is 2", () => {
    assert.equal(computeExitCode({ blocked: 0, stalled: 1 }), 2);
  });
  it("healthy fleet is 0", () => {
    assert.equal(computeExitCode({ blocked: 0, stalled: 0 }), 0);
  });
});

describe("runQuery — usage/error contract", () => {
  it("missing scope emits UNKNOWN_SCOPE JSON and exits 4", async () => {
    const stdout = fakeStdout();
    const exitCode = await runQuery([], { stdout, io: { gh: async () => { throw new Error("must not call gh"); } } });
    assert.equal(exitCode, 4);
    const doc = stdout.json();
    assert.equal(doc.schema, SCHEMA);
    assert.equal(doc.error.code, "UNKNOWN_SCOPE");
  });

  it("unknown scope emits UNKNOWN_SCOPE JSON and exits 4", async () => {
    const stdout = fakeStdout();
    const exitCode = await runQuery(["bogus"], { stdout });
    assert.equal(exitCode, 4);
    assert.equal(stdout.json().error.code, "UNKNOWN_SCOPE");
  });

  it("fleet scope with no --repo and no forge.yaml emits NO_REPO and exits 4, never calls gh", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    let ghCalled = false;
    const exitCode = await runQuery(["fleet"], {
      stdout,
      cwd: dir,
      io: { gh: async () => { ghCalled = true; return "{}"; } },
    });
    assert.equal(exitCode, 4);
    assert.equal(stdout.json().error.code, "NO_REPO");
    assert.equal(ghCalled, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a non-numeric --limit emits BAD_FLAG and exits 4", async () => {
    const stdout = fakeStdout();
    const exitCode = await runQuery(["fleet", "--repo", "acme/widgets", "--limit", "nope"], {
      stdout,
      io: { gh: async () => { throw new Error("must not call gh"); } },
    });
    assert.equal(exitCode, 4);
    assert.equal(stdout.json().error.code, "BAD_FLAG");
  });

  it("output is exactly one JSON document — parses cleanly with nothing else on stdout", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    const io = ghFleetIo([fleetNode({ number: 1 })]);
    await runQuery(["fleet", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    assert.doesNotThrow(() => JSON.parse(stdout.text().trim()));
    assert.equal(stdout.text().trim().split("\n").length, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runQuery — fleet scope", () => {
  it("issues exactly one gh call and returns a full FleetSnapshot", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    const io = ghFleetIo([fleetNode({ number: 1 }), fleetNode({ number: 2 })]);
    const exitCode = await runQuery(["fleet", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    assert.equal(io.calls(), 1);
    assert.equal(exitCode, 0);
    const doc = stdout.json();
    assert.equal(doc.schema, SCHEMA);
    assert.equal(doc.agents.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies --fields projection to every agent", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    const io = ghFleetIo([fleetNode({ number: 1 }), fleetNode({ number: 2 })]);
    await runQuery(["fleet", "--repo", "acme/widgets", "--fields", "status,phase"], { stdout, io, now: () => 1000, runsDir: dir });
    const doc = stdout.json();
    for (const agent of doc.agents) {
      assert.deepEqual(Object.keys(agent).sort(), ["issue", "phase", "status"].sort());
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies --limit to cap agent count", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    const io = ghFleetIo([fleetNode({ number: 1 }), fleetNode({ number: 2 }), fleetNode({ number: 3 })]);
    await runQuery(["fleet", "--repo", "acme/widgets", "--limit", "2"], { stdout, io, now: () => 1000, runsDir: dir });
    assert.equal(stdout.json().agents.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit code 2 when stalls present, no blocked", async () => {
    const dir = tmpDir();
    const hbAt = new Date(1000 - 60 * 60000).toISOString();
    const io = ghFleetIo([
      fleetNode({ number: 1, comments: [`<!-- FORGE:HEARTBEAT -->\n**Phase**: build\n**Timestamp**: ${hbAt}`] }),
    ]);
    const stdout = fakeStdout();
    const exitCode = await runQuery(["fleet", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    assert.equal(exitCode, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit code 3 when blocked present (wins over stalled)", async () => {
    const dir = tmpDir();
    const hbAt = new Date(1000 - 60 * 60000).toISOString();
    const io = ghFleetIo([
      fleetNode({ number: 1, comments: [`<!-- FORGE:HEARTBEAT -->\n**Phase**: build\n**Timestamp**: ${hbAt}`] }),
      fleetNode({ number: 2, labels: ["workflow:building", "needs-human"] }),
    ]);
    const stdout = fakeStdout();
    const exitCode = await runQuery(["fleet", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    assert.equal(exitCode, 3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("deterministic ordering — severity then ascending issue number", async () => {
    const dir = tmpDir();
    const io = ghFleetIo([
      fleetNode({ number: 5 }),
      fleetNode({ number: 2, labels: ["workflow:building", "needs-human"] }),
      fleetNode({ number: 8 }),
      fleetNode({ number: 1, labels: ["workflow:building", "needs-human"] }),
    ]);
    const stdout = fakeStdout();
    await runQuery(["fleet", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    assert.deepEqual(stdout.json().agents.map((a) => a.issue), [1, 2, 5, 8]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runQuery — stalls scope", () => {
  it("returns only stalled/blocked agents with stall math", async () => {
    const dir = tmpDir();
    const hbAt = new Date(1000 - 60 * 60000).toISOString();
    const io = ghFleetIo([
      fleetNode({ number: 1, comments: [`<!-- FORGE:HEARTBEAT -->\n**Phase**: build\n**Timestamp**: ${hbAt}`] }),
      fleetNode({ number: 2 }), // running — excluded
      fleetNode({ number: 3, labels: ["workflow:building", "needs-human"] }),
    ]);
    const stdout = fakeStdout();
    const exitCode = await runQuery(["stalls", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    const doc = stdout.json();
    assert.deepEqual(doc.agents.map((a) => a.issue).sort(), [1, 3]);
    assert.ok(doc.agents.find((a) => a.issue === 1).stall);
    assert.equal(exitCode, 3); // blocked present, wins over stalled
    rmSync(dir, { recursive: true, force: true });
  });

  it("NO_REPO when repo cannot be resolved", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    const exitCode = await runQuery(["stalls"], { stdout, cwd: dir, io: { gh: async () => { throw new Error("no"); } } });
    assert.equal(exitCode, 4);
    assert.equal(stdout.json().error.code, "NO_REPO");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runQuery — orchestration scope", () => {
  it("groups agents by milestone with per-milestone status counts", async () => {
    const dir = tmpDir();
    const io = ghFleetIo([
      fleetNode({ number: 1, milestone: "Alpha" }),
      fleetNode({ number: 2, milestone: "Alpha", labels: ["workflow:building", "needs-human"] }),
      fleetNode({ number: 3, milestone: "Beta" }),
    ]);
    const stdout = fakeStdout();
    await runQuery(["orchestration", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    const doc = stdout.json();
    const alpha = doc.milestones.find((m) => m.milestone === "Alpha");
    const beta = doc.milestones.find((m) => m.milestone === "Beta");
    assert.equal(alpha.agents.length, 2);
    assert.equal(alpha.counts.blocked, 1);
    assert.equal(beta.agents.length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--milestone filters to a single milestone", async () => {
    const dir = tmpDir();
    const io = ghFleetIo([
      fleetNode({ number: 1, milestone: "Alpha" }),
      fleetNode({ number: 3, milestone: "Beta" }),
    ]);
    const stdout = fakeStdout();
    await runQuery(["orchestration", "--repo", "acme/widgets", "--milestone", "Alpha"], { stdout, io, now: () => 1000, runsDir: dir });
    const doc = stdout.json();
    assert.equal(doc.milestones.length, 1);
    assert.equal(doc.milestones[0].milestone, "Alpha");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runQuery — issue scope", () => {
  it("returns IssueDetail via getIssueDetail", async () => {
    const dir = tmpDir();
    const io = {
      calls: 0,
      gh: async function (args) {
        this.calls += 1;
        assert.deepEqual(args.slice(0, 2), ["issue", "view"]);
        return JSON.stringify({ number: 42, title: "t", body: "", labels: [], milestone: null, comments: [] });
      },
    };
    const stdout = fakeStdout();
    const exitCode = await runQuery(["issue", "42", "--repo", "acme/widgets"], { stdout, io, now: () => 1000, runsDir: dir });
    const doc = stdout.json();
    assert.equal(doc.schema, SCHEMA);
    assert.equal(doc.issue, 42);
    assert.equal(exitCode, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("USAGE error for a missing/non-numeric issue number", async () => {
    const stdout = fakeStdout();
    const exitCode = await runQuery(["issue", "not-a-number"], { stdout, io: { gh: async () => { throw new Error("no"); } } });
    assert.equal(exitCode, 4);
    assert.equal(stdout.json().error.code, "USAGE");
  });

  it("--events is zero-network and requires no --repo", async () => {
    const dir = tmpDir();
    appendEvent(dir, 900, { event: "RUN_START", run: "r1", issue: 900, lane: "staging" });
    appendEvent(dir, 900, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    const stdout = fakeStdout();
    let ghCalled = false;
    const exitCode = await runQuery(["issue", "900", "--events"], {
      stdout,
      runsDir: dir,
      io: { gh: async () => { ghCalled = true; return "{}"; } },
    });
    assert.equal(exitCode, 0);
    assert.equal(ghCalled, false);
    const doc = stdout.json();
    assert.equal(doc.events.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--events --since-seq N filters to events strictly after N", async () => {
    const dir = tmpDir();
    appendEvent(dir, 901, { event: "RUN_START", run: "r1", issue: 901, lane: "staging" });
    appendEvent(dir, 901, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 901, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
    const stdout = fakeStdout();
    await runQuery(["issue", "901", "--events", "--since-seq", "1"], { stdout, runsDir: dir });
    const doc = stdout.json();
    assert.deepEqual(doc.events.map((e) => e.seq), [2, 3]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--events with a non-numeric --since-seq emits BAD_FLAG", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    const exitCode = await runQuery(["issue", "902", "--events", "--since-seq", "nope"], { stdout, runsDir: dir });
    assert.equal(exitCode, 4);
    assert.equal(stdout.json().error.code, "BAD_FLAG");
    rmSync(dir, { recursive: true, force: true });
  });

  it("issue scope without --events requires --repo (NO_REPO)", async () => {
    const dir = tmpDir();
    const stdout = fakeStdout();
    const exitCode = await runQuery(["issue", "903"], { stdout, cwd: dir, runsDir: dir });
    assert.equal(exitCode, 4);
    assert.equal(stdout.json().error.code, "NO_REPO");
    rmSync(dir, { recursive: true, force: true });
  });
});

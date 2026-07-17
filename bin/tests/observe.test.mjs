// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for bin/observe.mjs (forge#2389). Injected io/now throughout —
 * no live `gh`, no network. Local run-log fixtures are written to a temp dir
 * via appendEvent()/rewriteLog() (bin/engine/runlog.mjs), matching the
 * fixture style already used by bin/tests/engine-cli.test.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  SCHEMA,
  PHASE_IDS,
  WATCHED_LABELS,
  resolveStallTimeoutMinutes,
  buildFleetSearchQuery,
  parseFleetSearchResponse,
  deriveAgent,
  getFleetSnapshot,
  getIssueDetail,
  readEvents,
} from "../observe.mjs";
import { appendEvent, readLog } from "../engine/runlog.mjs";
import { serializeState } from "../engine/state.mjs";

function tmpDir() {
  return mkdtempSync(join(os.tmpdir(), "forge-observe-test-"));
}

describe("resolveStallTimeoutMinutes", () => {
  it("returns 15 when forge.yaml is absent", () => {
    const dir = tmpDir();
    assert.equal(resolveStallTimeoutMinutes(dir), 15);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads pipeline.stall_timeout_minutes when present", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "forge.yaml"), "pipeline:\n  stall_timeout_minutes: 42\n");
    assert.equal(resolveStallTimeoutMinutes(dir), 42);
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to 15 on a non-numeric value", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "forge.yaml"), "pipeline:\n  stall_timeout_minutes: not-a-number\n");
    assert.equal(resolveStallTimeoutMinutes(dir), 15);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never throws on a malformed forge.yaml", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "forge.yaml"), "not: [valid: yaml: at: all");
    assert.doesNotThrow(() => resolveStallTimeoutMinutes(dir));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildFleetSearchQuery / parseFleetSearchResponse", () => {
  it("builds one search query containing the repo and every watched label", () => {
    const q = buildFleetSearchQuery("acme", "widgets", WATCHED_LABELS);
    assert.match(q, /repo:acme\/widgets/);
    assert.match(q, /is:open/);
    for (const label of WATCHED_LABELS) {
      assert.ok(q.includes(`label:\\"${label}\\"`), `query should reference label ${label}`);
    }
  });

  it("escapes quotes/backslashes in owner/repo/labels", () => {
    const q = buildFleetSearchQuery('ac"me', "widgets", ['workflow:"weird"']);
    assert.doesNotThrow(() => q); // build never throws
    assert.ok(!q.includes('ac"me')); // raw quote must not appear unescaped
  });

  it("escapes the composed searchQuery exactly once, not twice (regression forge#2411)", () => {
    // Values containing both a quote and a backslash so double-escaping
    // (each backslash introduced by an inner escape pass gets re-escaped by
    // the outer pass) leaves a decodable mismatch if it regresses.
    const owner = 'ac"me';
    const repo = "wid\\gets";
    const labels = ['workflow:"weird"'];
    const q = buildFleetSearchQuery(owner, repo, labels);

    const match = q.match(/query:\s*"((?:[^"\\]|\\.)*)"\)/);
    assert.ok(match, "query: \"...\" literal not found in generated GraphQL document");
    const escapedLiteral = match[1];

    // Reverse escapeGraphQLString's two passes in reverse order (unescape
    // quotes, then unescape backslashes). If the source were escaped twice,
    // one decode pass leaves stray backslashes behind and this equality
    // fails — proving single-level escaping, not merely "no raw quote".
    const decoded = escapedLiteral.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const expected = `repo:${owner}/${repo} is:issue is:open (label:"${labels[0]}")`;
    assert.equal(decoded, expected);
  });

  it("parses nodes and rateLimit.remaining out of a graphql response", () => {
    const json = {
      data: {
        search: { nodes: [{ number: 1 }, null, { number: 2 }] },
        rateLimit: { remaining: 4321 },
      },
    };
    const { nodes, rateLimitRemaining } = parseFleetSearchResponse(json);
    assert.deepEqual(nodes.map((n) => n.number), [1, 2]);
    assert.equal(rateLimitRemaining, 4321);
  });

  it("degrades to empty on a malformed/empty response", () => {
    assert.deepEqual(parseFleetSearchResponse({}), { nodes: [], rateLimitRemaining: null });
    assert.deepEqual(parseFleetSearchResponse(null), { nodes: [], rateLimitRemaining: null });
  });
});

describe("deriveAgent — status derivation", () => {
  const now = Date.parse("2026-07-17T18:42:07Z");

  function node({ labels = [], body = "", comments = [], milestone = null } = {}) {
    return {
      number: 100,
      title: "Test issue",
      labels: { nodes: labels.map((n) => ({ name: n })) },
      body,
      milestone: milestone ? { title: milestone } : null,
      comments: { nodes: comments.map((b) => ({ body: b })) },
    };
  }

  it("is blocked when needs-human label present, regardless of heartbeat age", () => {
    const n = node({ labels: ["workflow:building", "needs-human"] });
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.status, "blocked");
    assert.equal(agent.stall, null);
  });

  it("is running when a recent heartbeat exists", () => {
    const hbAt = new Date(now - 2 * 60000).toISOString();
    const n = node({
      labels: ["workflow:building"],
      comments: [`<!-- FORGE:HEARTBEAT -->\n**Phase**: build\n**Timestamp**: ${hbAt}`],
    });
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.status, "running");
    assert.equal(agent.heartbeat.ageMinutes, 2);
  });

  it("is stalled when heartbeat age >= stallTimeoutMinutes", () => {
    const hbAt = new Date(now - 22 * 60000).toISOString();
    const n = node({
      labels: ["workflow:building"],
      comments: [`<!-- FORGE:HEARTBEAT -->\n**Phase**: build\n**Timestamp**: ${hbAt}`],
    });
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.status, "stalled");
    assert.deepEqual(agent.stall, { ageMinutes: 22, threshold: 15 });
  });

  it("is leased-elsewhere when no local visibility but an active remote lease exists", () => {
    const remoteBody = serializeState({
      v: 3, run: "r1", issue: 100, lane: "staging", committed: ["investigate"],
      phase: null, branch: null, pr: null, terminal: false, terminalReason: null,
      lease: { by: "agent-elsewhere", until: now + 60000 },
    });
    const n = node({ labels: ["workflow:building"], body: remoteBody });
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.status, "leased-elsewhere");
    assert.deepEqual(agent.lease, { by: "agent-elsewhere", until: now + 60000 });
  });

  it("is terminal when the resolved state reports terminal:true", () => {
    const remoteBody = serializeState({
      v: 5, run: "r1", issue: 100, lane: "staging", committed: PHASE_IDS,
      phase: null, branch: "fix/x", pr: 9, terminal: true, terminalReason: "merged",
      lease: null,
    });
    const n = node({ labels: ["workflow:in-review"], body: remoteBody });
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.status, "terminal");
  });

  it("falls back to running when no heartbeat, no lease, no local run-log", () => {
    const n = node({ labels: ["workflow:ready-to-build"] });
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.status, "running");
    assert.equal(agent.heartbeat, null);
  });
});

describe("deriveAgent — phase resolution and GitHub-wins merge", () => {
  const now = 1000;

  it("derives phase from the label when no run-log/remote state exists", () => {
    const n = { number: 1, title: "t", labels: { nodes: [{ name: "workflow:investigating" }] }, body: "", milestone: null, comments: { nodes: [] } };
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.phase, "investigate");
    assert.equal(agent.sources.state, "none");
  });

  it("derives phase from local run-log as first uncommitted phase", () => {
    const dir = tmpDir();
    appendEvent(dir, 200, { event: "RUN_START", run: "r1", issue: 200, lane: "staging" });
    appendEvent(dir, 200, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 200, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
    const events = readLog(dir, 200);
    const n = { number: 200, title: "t", labels: { nodes: [{ name: "workflow:building" }] }, body: "", milestone: null, comments: { nodes: [] } };
    const agent = deriveAgent(n, events, now, 15);
    assert.equal(agent.phase, "architect");
    assert.equal(agent.sources.state, "runlog");
    rmSync(dir, { recursive: true, force: true });
  });

  it("GitHub wins when remote state is ahead of local (hydrate) and records divergence", () => {
    const dir = tmpDir();
    appendEvent(dir, 300, { event: "RUN_START", run: "r1", issue: 300, lane: "staging" });
    appendEvent(dir, 300, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    const events = readLog(dir, 300);

    const remoteBody = serializeState({
      v: 99, run: "r1", issue: 300, lane: "staging", committed: ["investigate", "context", "architect"],
      phase: null, branch: "fix/y", pr: null, terminal: false, terminalReason: null, lease: null,
    });
    const n = { number: 300, title: "t", labels: { nodes: [{ name: "workflow:building" }] }, body: remoteBody, milestone: null, comments: { nodes: [] } };
    const agent = deriveAgent(n, events, now, 15);

    assert.equal(agent.phase, "build"); // first phase not in remote's committed[]
    assert.equal(agent.sources.state, "github+runlog");
    assert.equal(agent.sources.stateDivergence, true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a truncated final run-log line degrades that issue to GitHub-only, never throws", () => {
    const dir = tmpDir();
    appendEvent(dir, 400, { event: "RUN_START", run: "r1", issue: 400, lane: "staging" });
    // Corrupt the file by appending a truncated JSON line.
    appendFileSync(join(dir, "400.jsonl"), '{"seq":2,"event":"PHASE_COMM');
    const events = readLog(dir, 400);
    assert.equal(events.length, 1); // truncated final line ignored, not thrown

    const remoteBody = serializeState({
      v: 1, run: "r1", issue: 400, lane: "staging", committed: [],
      phase: null, branch: null, pr: null, terminal: false, terminalReason: null, lease: null,
    });
    const n = { number: 400, title: "t", labels: { nodes: [{ name: "workflow:investigating" }] }, body: remoteBody, milestone: null, comments: { nodes: [] } };
    assert.doesNotThrow(() => deriveAgent(n, events, now, 15));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("deriveAgent — attempt resolution (currentAttempt)", () => {
  const now = 1000;

  it("attempt is null when the local run-log has events but none for the current phase (regression forge#2412)", () => {
    const dir = tmpDir();
    appendEvent(dir, 600, { event: "RUN_START", run: "r1", issue: 600, lane: "staging" });
    // Commit through "architect" so the first uncommitted phase — and
    // therefore agent.phase — resolves to "build" (mirrors the "derives
    // phase from local run-log as first uncommitted phase" fixture above).
    appendEvent(dir, 600, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 600, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
    appendEvent(dir, 600, { event: "PHASE_COMMIT", phase: "architect", outputs: {} });
    // A PHASE_START exists locally, but only for an already-committed
    // phase — zero events match the current phase ("build"). Before the
    // fix this fell through to a synthesized { n: 1, max } instead of
    // reporting "unknown".
    appendEvent(dir, 600, { event: "PHASE_START", phase: "investigate", attempt: 1 });
    const events = readLog(dir, 600);
    const n = { number: 600, title: "t", labels: { nodes: [{ name: "workflow:building" }] }, body: "", milestone: null, comments: { nodes: [] } };
    const agent = deriveAgent(n, events, now, 15);
    assert.equal(agent.phase, "build");
    assert.equal(agent.attempt, null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("attempt reports {n, max} when the current phase has a matching PHASE_START/PHASE_FAILED event", () => {
    const dir = tmpDir();
    appendEvent(dir, 700, { event: "RUN_START", run: "r1", issue: 700, lane: "staging" });
    appendEvent(dir, 700, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 700, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
    appendEvent(dir, 700, { event: "PHASE_COMMIT", phase: "architect", outputs: {} });
    appendEvent(dir, 700, { event: "PHASE_START", phase: "build", attempt: 1 });
    appendEvent(dir, 700, { event: "PHASE_FAILED", phase: "build", attempt: 1, reason: "x", maxAttempts: 3 });
    appendEvent(dir, 700, { event: "PHASE_START", phase: "build", attempt: 2 });
    const events = readLog(dir, 700);
    const n = { number: 700, title: "t", labels: { nodes: [{ name: "workflow:building" }] }, body: "", milestone: null, comments: { nodes: [] } };
    const agent = deriveAgent(n, events, now, 15);
    assert.equal(agent.phase, "build");
    assert.deepEqual(agent.attempt, { n: 2, max: 3 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("attempt is null when there is no local run-log at all (pre-existing behavior, unchanged)", () => {
    const n = { number: 800, title: "t", labels: { nodes: [{ name: "workflow:building" }] }, body: "", milestone: null, comments: { nodes: [] } };
    const agent = deriveAgent(n, [], now, 15);
    assert.equal(agent.attempt, null);
  });
});

describe("readEvents", () => {
  it("returns the full local event list with no sinceSeq", () => {
    const dir = tmpDir();
    appendEvent(dir, 500, { event: "RUN_START", run: "r1", issue: 500, lane: "staging" });
    appendEvent(dir, 500, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    const events = readEvents({ runsDir: dir, issue: 500 });
    assert.equal(events.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters to events with seq > sinceSeq", () => {
    const dir = tmpDir();
    appendEvent(dir, 501, { event: "RUN_START", run: "r1", issue: 501, lane: "staging" });
    appendEvent(dir, 501, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 501, { event: "PHASE_COMMIT", phase: "context", outputs: {} });
    const events = readEvents({ runsDir: dir, issue: 501, sinceSeq: 1 });
    assert.deepEqual(events.map((e) => e.seq), [2, 3]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("touches no network — pure filesystem read, returns [] for a missing issue", () => {
    const dir = tmpDir();
    assert.deepEqual(readEvents({ runsDir: dir, issue: 999999 }), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("getFleetSnapshot — one GraphQL request regardless of fleet size", () => {
  it("issues exactly one gh call for a 20-agent fleet", async () => {
    let ghCalls = 0;
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1, title: `issue ${i + 1}`,
      labels: { nodes: [{ name: "workflow:building" }] },
      body: "", milestone: null, comments: { nodes: [] },
    }));
    const io = {
      gh: async (args) => {
        ghCalls += 1;
        assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
        return JSON.stringify({ data: { search: { nodes }, rateLimit: { remaining: 4999 } } });
      },
    };
    const dir = tmpDir();
    const snapshot = await getFleetSnapshot({
      repo: "acme/widgets", runsDir: dir, io, now: () => 1000, stallTimeoutMinutes: 15,
    });
    assert.equal(ghCalls, 1);
    assert.equal(snapshot.schema, SCHEMA);
    assert.equal(snapshot.agents.length, 20);
    rmSync(dir, { recursive: true, force: true });
  });

  it("orders agents by severity then ascending issue number", async () => {
    const nodes = [
      { number: 5, title: "running", labels: { nodes: [{ name: "workflow:building" }] }, body: "", milestone: null, comments: { nodes: [] } },
      { number: 2, title: "blocked", labels: { nodes: [{ name: "workflow:building" }, { name: "needs-human" }] }, body: "", milestone: null, comments: { nodes: [] } },
      { number: 8, title: "running-2", labels: { nodes: [{ name: "workflow:building" }] }, body: "", milestone: null, comments: { nodes: [] } },
      { number: 1, title: "blocked-2", labels: { nodes: [{ name: "workflow:building" }, { name: "needs-human" }] }, body: "", milestone: null, comments: { nodes: [] } },
    ];
    const io = { gh: async () => JSON.stringify({ data: { search: { nodes }, rateLimit: { remaining: 100 } } }) };
    const dir = tmpDir();
    const snapshot = await getFleetSnapshot({ repo: "acme/widgets", runsDir: dir, io, now: () => 1000, stallTimeoutMinutes: 15 });
    assert.deepEqual(snapshot.agents.map((a) => a.issue), [1, 2, 5, 8]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit-code-style counts: stalled fleet reflects in counts.stalled/quiet", async () => {
    const hbAt = new Date(1000 - 60 * 60000).toISOString();
    const nodes = [
      { number: 1, title: "stalled", labels: { nodes: [{ name: "workflow:building" }] }, body: "", milestone: null, comments: { nodes: [{ body: `<!-- FORGE:HEARTBEAT -->\n**Phase**: build\n**Timestamp**: ${hbAt}` }] } },
    ];
    const io = { gh: async () => JSON.stringify({ data: { search: { nodes }, rateLimit: { remaining: 100 } } }) };
    const dir = tmpDir();
    const snapshot = await getFleetSnapshot({ repo: "acme/widgets", runsDir: dir, io, now: () => 1000, stallTimeoutMinutes: 15 });
    assert.equal(snapshot.counts.stalled, 1);
    assert.equal(snapshot.counts.running, 0);
    assert.equal(snapshot.counts.quiet, false); // stalled agents are not "quiet"
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("getIssueDetail", () => {
  it("includes structured terminal diagnostics from engine-cli.mjs", async () => {
    const dir = tmpDir();
    appendEvent(dir, 700, { event: "RUN_START", run: "r1", issue: 700, lane: "staging" });
    appendEvent(dir, 700, { event: "PHASE_FAILED", phase: "build", attempt: 3, reason: "quality gate failed", maxAttempts: 3 });

    const io = {
      gh: async (args) => {
        assert.deepEqual(args.slice(0, 2), ["issue", "view"]);
        return JSON.stringify({
          number: 700, title: "t", body: "", labels: [{ name: "needs-human" }],
          milestone: null, comments: [],
        });
      },
    };
    const detail = await getIssueDetail({ repo: "acme/widgets", issue: 700, runsDir: dir, io, now: () => 1000, stallTimeoutMinutes: 15 });
    assert.equal(detail.schema, SCHEMA);
    assert.equal(detail.diagnostics.valid, true);
    assert.equal(detail.diagnostics.failedPhase, "build");
    assert.equal(detail.diagnostics.reason, "quality gate failed");
    assert.equal(detail.status, "blocked");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null lastHeartbeatBody and empty diagnostics.hadEvents when nothing local exists", async () => {
    const dir = tmpDir();
    const io = {
      gh: async () => JSON.stringify({ number: 701, title: "t", body: "", labels: [], milestone: null, comments: [] }),
    };
    const detail = await getIssueDetail({ repo: "acme/widgets", issue: 701, runsDir: dir, io, now: () => 1000, stallTimeoutMinutes: 15 });
    assert.equal(detail.lastHeartbeatBody, null);
    assert.equal(detail.diagnostics.hadEvents, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

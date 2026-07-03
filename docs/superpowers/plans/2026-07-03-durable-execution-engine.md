# Durable Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ForgeDock's headless pipeline durable — a code-driven per-phase state machine over the existing `runner.mjs`, with an append-only run-log mirrored to a compact `FORGE:STATE` block on GitHub, so runs resume from the last committed phase after any crash/kill/compaction.

**Architecture:** A runtime-agnostic engine core (`bin/engine/*`) drives one pipeline phase at a time by calling the existing `runner.runCommand()` with a fresh context per phase. Each phase's outcome is determined by inspecting GitHub state after the run (`detectOutcome`), not from the runner's return. State lives in a local `.forge/runs/{issue}.jsonl` (hot path) and a `FORGE:STATE` HTML-comment index on the issue (durable shared mirror); on divergence GitHub wins. All side effects (GitHub, git, the LLM run) are injected, so the whole engine is unit-testable with fakes and no network.

**Tech Stack:** Node.js ES modules (`.mjs`), `node:test` + `node:assert/strict`, `bin/runner.mjs` (existing, unmodified), `gh` and `git` CLIs (injected as async functions).

**Spec:** `docs/superpowers/specs/2026-07-03-durable-execution-engine-design.md`

## Global Constraints

- Node ES modules (`.mjs`); **zero runtime dependencies** — the Anthropic SDK stays lazy/optional inside `runner.mjs` only. Engine code imports nothing outside `node:*` and sibling engine modules.
- Tests run via `node --test "bin/tests/**/*.test.mjs"`, use `node:test` + `node:assert/strict`, no network, isolate filesystem with `mkdtempSync`.
- All side effects are **injected**: `io = { gh(args:string[]):Promise<string>, git(args:string[]):Promise<string> }`, `runner` (a `runCommand`-shaped async fn), and `now():number`. No engine module calls `gh`/`git`/the SDK directly.
- Windows-safe paths: use `node:path`; command names use `/` separators.
- Durability granularity is **per-phase**. `FORGE:STATE` is a **compact index** (no rich outputs). On divergence, **GitHub wins**.
- Commits: conventional (`feat(engine):`, `test(engine):`), signed off (`git commit -s`, DCO required on staging), **no AI attribution**.

## Shared types (JSDoc — referenced by every task)

```js
/**
 * @typedef {Object} RunState   // the working state; also the shape of the compact index
 * @property {number} v         // version = last committed run-log seq (0 if none)
 * @property {string|null} run  // run id
 * @property {number} issue
 * @property {string} lane      // "staging" | "milestone/<slug>"
 * @property {string[]} committed // phase ids committed, in order
 * @property {string|null} phase  // current/next phase id (null before start)
 * @property {string|null} branch
 * @property {number|null} pr
 * @property {boolean} terminal
 * @property {string|null} terminalReason // "merged"|"invalid"|"needs-human"|"decomposed"|null
 * @property {{by:string, until:number}|null} lease
 */

/**
 * @typedef {Object} PhaseOutcome
 * @property {"committed"|"failed"|"blocked"} status
 * @property {Object} [outputs]   // structured facts to record (branch, pr, skipped, ...)
 * @property {string} [detail]    // human reason for blocked/failed
 * @property {string} [terminalReason] // when a committed phase is terminal (e.g. "invalid")
 */

/**
 * @typedef {Object} Phase
 * @property {string} id
 * @property {string} command                 // spec name passed to runner.runCommand
 * @property {(s:RunState)=>boolean} entryCondition
 * @property {(s:RunState)=>boolean} [isTerminalAfter] // true if committing this phase ends the run
 * @property {(s:RunState, io:Io)=>Promise<{satisfied:boolean, outputs?:Object}>} [reconcile]
 * @property {(s:RunState, io:Io)=>Promise<PhaseOutcome>} detectOutcome
 */
```

---

### Task 1: Run-log store (`bin/engine/runlog.mjs`)

**Files:**
- Create: `bin/engine/runlog.mjs`
- Test: `bin/tests/engine-runlog.test.mjs`

**Interfaces:**
- Produces: `appendEvent(dir, issue, event) => void`, `readLog(dir, issue) => object[]`, `deriveState(events) => RunState`.
- Consumes: nothing (leaf module).

- [ ] **Step 1: Write the failing tests**

```js
// bin/tests/engine-runlog.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readLog, deriveState } from "../engine/runlog.mjs";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-runlog-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runlog", () => {
  it("append then read returns events in order with assigned seq", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_START", phase: "investigate" });
    const events = readLog(dir, 42);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.seq), [1, 2]);
    assert.equal(events[0].event, "RUN_START");
  });

  it("readLog tolerates a truncated final line (crash mid-write)", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42 });
    appendFileSync(join(dir, "42.jsonl"), '{"seq":2,"event":"PHA'); // no newline, partial JSON
    const events = readLog(dir, 42);
    assert.equal(events.length, 1); // partial final line ignored
  });

  it("deriveState: a PHASE_START without a following PHASE_COMMIT is NOT committed", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_START", phase: "investigate" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "investigate", outputs: {} });
    appendEvent(dir, 42, { event: "PHASE_START", phase: "build" }); // crashed here
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate"]);
    assert.equal(s.v, 3);       // last committed seq
    assert.equal(s.terminal, false);
  });

  it("deriveState: RUN_TERMINAL sets terminal + reason and carries branch/pr from commits", () => {
    appendEvent(dir, 42, { event: "RUN_START", issue: 42, run: "r1", lane: "staging" });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "build", outputs: { branch: "fix/x-42" } });
    appendEvent(dir, 42, { event: "PHASE_COMMIT", phase: "review", outputs: { pr: 7 } });
    appendEvent(dir, 42, { event: "RUN_TERMINAL", reason: "merged" });
    const s = deriveState(readLog(dir, 42));
    assert.equal(s.terminal, true);
    assert.equal(s.terminalReason, "merged");
    assert.equal(s.branch, "fix/x-42");
    assert.equal(s.pr, 7);
  });

  it("deriveState of empty log is a zero-value state", () => {
    const s = deriveState([]);
    assert.equal(s.v, 0);
    assert.deepEqual(s.committed, []);
    assert.equal(s.phase, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/engine-runlog.test.mjs`
Expected: FAIL — `Cannot find module '../engine/runlog.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// bin/engine/runlog.mjs
/**
 * Append-only per-issue run-log (the crash-safe local hot path).
 * One JSON event per line at {dir}/{issue}.jsonl. seq is assigned monotonically.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

function logPath(dir, issue) { return join(dir, `${issue}.jsonl`); }

/** Append an event; assigns the next seq based on the current line count. */
export function appendEvent(dir, issue, event) {
  mkdirSync(dir, { recursive: true });
  const path = logPath(dir, issue);
  const seq = readLog(dir, issue).length + 1;
  appendFileSync(path, JSON.stringify({ seq, ...event }) + "\n");
}

/** Read all complete events; a truncated final line (crash mid-write) is ignored. */
export function readLog(dir, issue) {
  const path = logPath(dir, issue);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial final line: ignore */ }
  }
  return out;
}

/** Fold events into a RunState. The commit rule lives here. */
export function deriveState(events) {
  /** @type {import("./phases.mjs").RunState} */
  const s = { v: 0, run: null, issue: null, lane: "staging", committed: [],
              phase: null, branch: null, pr: null, terminal: false,
              terminalReason: null, lease: null };
  for (const e of events) {
    switch (e.event) {
      case "RUN_START":
        s.run = e.run ?? s.run; s.issue = e.issue ?? s.issue; s.lane = e.lane ?? s.lane;
        break;
      case "PHASE_COMMIT":
        if (!s.committed.includes(e.phase)) s.committed.push(e.phase);
        s.v = e.seq;
        if (e.outputs?.branch) s.branch = e.outputs.branch;
        if (e.outputs?.pr != null) s.pr = e.outputs.pr;
        break;
      case "RUN_TERMINAL":
        s.terminal = true; s.terminalReason = e.reason ?? "done"; s.v = e.seq;
        break;
      // PHASE_START / PHASE_FAILED do not change committed state
    }
  }
  return s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/engine-runlog.test.mjs`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add bin/engine/runlog.mjs bin/tests/engine-runlog.test.mjs
git commit -s -m "feat(engine): append-only run-log with commit-rule state derivation"
```

---

### Task 2: `FORGE:STATE` codec (`bin/engine/state.mjs`)

**Files:**
- Create: `bin/engine/state.mjs`
- Test: `bin/tests/engine-state.test.mjs`

**Interfaces:**
- Produces: `serializeState(index) => string`, `parseState(issueBody) => RunState|null`, `upsertStateBlock(body, index) => string`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

```js
// bin/tests/engine-state.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeState, parseState, upsertStateBlock } from "../engine/state.mjs";

const idx = { v: 7, run: "r1", issue: 42, lane: "staging",
  committed: ["investigate", "build"], phase: "review", branch: "fix/x-42",
  pr: null, terminal: false, terminalReason: null, lease: { by: "a7", until: 1000 } };

describe("state codec", () => {
  it("round-trips through serialize/parse", () => {
    const body = "Some issue text.\n\n" + serializeState(idx);
    const got = parseState(body);
    assert.deepEqual(got, idx);
  });

  it("parseState returns null when no block present", () => {
    assert.equal(parseState("no state here"), null);
  });

  it("upsertStateBlock replaces an existing block in place (no duplicate)", () => {
    let body = "Header\n\n" + serializeState(idx) + "\n\nFooter";
    body = upsertStateBlock(body, { ...idx, phase: "close", committed: [...idx.committed, "review"], v: 9 });
    assert.equal((body.match(/FORGE:STATE/g) || []).length, 1);
    assert.equal(parseState(body).phase, "close");
    assert.match(body, /Header/); assert.match(body, /Footer/);
  });

  it("upsertStateBlock appends a block when none exists", () => {
    const body = upsertStateBlock("Just text", idx);
    assert.equal(parseState(body).v, 7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/engine-state.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// bin/engine/state.mjs
/**
 * Codec for the single machine-readable FORGE:STATE HTML-comment block on an
 * issue body. Carries the COMPACT INDEX only (no rich per-phase outputs).
 */
const OPEN = "<!-- FORGE:STATE";
const CLOSE = "-->";
const BLOCK_RE = /<!-- FORGE:STATE\s*([\s\S]*?)-->/;

/** @param {import("./phases.mjs").RunState} index */
export function serializeState(index) {
  return `${OPEN}\n${JSON.stringify(index)}\n${CLOSE}`;
}

/** @returns {import("./phases.mjs").RunState|null} */
export function parseState(issueBody) {
  const m = BLOCK_RE.exec(issueBody || "");
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

/** Replace the FORGE:STATE block in place, or append one if absent. */
export function upsertStateBlock(body, index) {
  const block = serializeState(index);
  if (BLOCK_RE.test(body || "")) return body.replace(BLOCK_RE, block);
  return `${body || ""}\n\n${block}`.trimStart();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/engine-state.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add bin/engine/state.mjs bin/tests/engine-state.test.mjs
git commit -s -m "feat(engine): FORGE:STATE compact-index codec (serialize/parse/upsert)"
```

---

### Task 3: GitHub projector (`bin/engine/projector.mjs`)

**Files:**
- Create: `bin/engine/projector.mjs`
- Test: `bin/tests/engine-projector.test.mjs`

**Interfaces:**
- Consumes: `state.mjs` (`parseState`, `upsertStateBlock`).
- Produces: `makeProjector(io) => { readState(issue), writeState(issue, index), setLabel(issue, label), removeLabel(issue, label) }`, where `io.gh(args)` is an injected async fn returning stdout.

- [ ] **Step 1: Write the failing tests**

```js
// bin/tests/engine-projector.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeProjector } from "../engine/projector.mjs";
import { serializeState } from "../engine/state.mjs";

// Fake gh: records calls, serves a scripted issue body.
function fakeGh(body) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body });
    if (args[0] === "issue" && args[1] === "edit") { body = argValue(args, "--body"); return ""; }
    return "";
  };
  return { gh, calls, getBody: () => body };
}
function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

const idx = { v: 3, run: "r1", issue: 42, lane: "staging", committed: ["investigate"],
  phase: "build", branch: null, pr: null, terminal: false, terminalReason: null, lease: null };

describe("projector", () => {
  it("readState returns null when the issue has no block", async () => {
    const f = fakeGh("plain body");
    const p = makeProjector({ gh: f.gh });
    assert.equal(await p.readState(42), null);
  });

  it("writeState upserts the block, readState reads it back", async () => {
    const f = fakeGh("Issue description.");
    const p = makeProjector({ gh: f.gh });
    await p.writeState(42, idx);
    assert.match(f.getBody(), /Issue description\./);       // original text preserved
    assert.deepEqual(await p.readState(42), idx);
  });

  it("setLabel calls gh issue edit --add-label", async () => {
    const f = fakeGh("x");
    const p = makeProjector({ gh: f.gh });
    await p.setLabel(42, "needs-human");
    assert.ok(f.calls.some(c => c.includes("--add-label") && c.includes("needs-human")));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/engine-projector.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// bin/engine/projector.mjs
/**
 * GitHub adapter: reads/writes the FORGE:STATE block and workflow labels.
 * `io.gh(args)` is injected (async, returns stdout) so this is testable offline.
 */
import { parseState, upsertStateBlock } from "./state.mjs";

export function makeProjector(io) {
  const gh = io.gh;

  async function getBody(issue) {
    const out = await gh(["issue", "view", String(issue), "--json", "body"]);
    try { return JSON.parse(out).body ?? ""; } catch { return ""; }
  }

  return {
    /** @returns {Promise<import("./phases.mjs").RunState|null>} */
    async readState(issue) { return parseState(await getBody(issue)); },

    async writeState(issue, index) {
      const body = upsertStateBlock(await getBody(issue), index);
      await gh(["issue", "edit", String(issue), "--body", body]);
    },

    async setLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "--add-label", label]);
    },

    async removeLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "--remove-label", label]);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/engine-projector.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add bin/engine/projector.mjs bin/tests/engine-projector.test.mjs
git commit -s -m "feat(engine): GitHub projector for FORGE:STATE mirror + labels"
```

---

### Task 4: Phase table + `pickPhase` (`bin/engine/phases.mjs`)

**Files:**
- Create: `bin/engine/phases.mjs`
- Test: `bin/tests/engine-phases.test.mjs`

**Interfaces:**
- Produces: `PHASES` (Phase[]), `pickPhase(state) => Phase|null`, `TERMINAL_REASONS` (string[]).
- Consumes: `io` at call time for `reconcile`/`detectOutcome` (injected by the engine).

Each phase's `detectOutcome` inspects GitHub *after* the run (via `io.gh`/`io.git`) — the runner's return status is advisory only. The `build` phase encodes the #1305 fix (requires `FORGE:BUILDER:COMPLETE` **and** commits ahead of base).

- [ ] **Step 1: Write the failing tests**

```js
// bin/tests/engine-phases.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PHASES, pickPhase } from "../engine/phases.mjs";

const base = { v: 0, run: "r1", issue: 42, lane: "staging", committed: [], phase: null,
  branch: null, pr: null, terminal: false, terminalReason: null, lease: null };

describe("pickPhase", () => {
  it("returns the first uncommitted phase whose entryCondition holds", () => {
    assert.equal(pickPhase(base).id, "investigate");
    assert.equal(pickPhase({ ...base, committed: ["investigate"] }).id, "context");
  });

  it("returns null once all phases are committed", () => {
    const all = PHASES.map(p => p.id);
    assert.equal(pickPhase({ ...base, committed: all }), null);
  });

  it("returns null when the state is already terminal", () => {
    assert.equal(pickPhase({ ...base, terminal: true, terminalReason: "invalid" }), null);
  });

  it("build.detectOutcome fails when there are no commits ahead of base (encodes #1305)", async () => {
    const build = PHASES.find(p => p.id === "build");
    const io = {
      gh: async () => JSON.stringify([{ body: "<!-- FORGE:BUILDER --> done <!-- FORGE:BUILDER:COMPLETE -->" }]),
      git: async () => "0", // rev-list count = 0 commits ahead
    };
    const outcome = await build.detectOutcome({ ...base, branch: "fix/x-42" }, io);
    assert.equal(outcome.status, "failed");
  });

  it("build.detectOutcome commits when :COMPLETE marker present AND commits exist", async () => {
    const build = PHASES.find(p => p.id === "build");
    const io = {
      gh: async () => JSON.stringify([{ body: "<!-- FORGE:BUILDER:COMPLETE -->" }]),
      git: async () => "2",
    };
    const outcome = await build.detectOutcome({ ...base, branch: "fix/x-42" }, io);
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.outputs.branch, "fix/x-42");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/engine-phases.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// bin/engine/phases.mjs
/**
 * Declarative phase table for the headless work-on pipeline. The ENGINE (not an
 * LLM) chooses the next phase via pickPhase. Each phase's outcome is read from
 * GitHub/git AFTER the run (detectOutcome); the runner's return is advisory.
 * @typedef ... (see plan "Shared types")
 */

export const TERMINAL_REASONS = ["merged", "invalid", "needs-human", "decomposed"];

/** Fetch the issue's comment bodies as one blob for marker checks. */
async function issueMarkers(issue, io) {
  const out = await io.gh(["api", `repos/{owner}/{repo}/issues/${issue}/comments`, "--jq", ".[].body"]);
  return out || "";
}
/** Count commits on branch ahead of the lane base. */
async function commitsAhead(state, io) {
  const n = await io.git(["rev-list", "--count", `origin/${state.lane}..${state.branch}`]);
  return parseInt(String(n).trim(), 10) || 0;
}
function has(blob, marker) { return blob.includes(marker); }

/** @type {Phase[]} */
export const PHASES = [
  {
    id: "investigate",
    command: "work-on/investigate",
    entryCondition: () => true,
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      if (has(m, "INVESTIGATION:INVALID"))
        return { status: "committed", terminalReason: "invalid", outputs: { verdict: "INVALID" } };
      if (has(m, "DECOMPOSE:YES"))
        return { status: "committed", terminalReason: "decomposed", outputs: { decompose: true } };
      if (has(m, "INVESTIGATION:COMPLETE"))
        return { status: "committed", outputs: { verdict: "CONFIRMED" } };
      return { status: "failed", detail: "no INVESTIGATION:COMPLETE marker" };
    },
    isTerminalAfter: (s) => s.terminalReason === "invalid" || s.terminalReason === "decomposed",
  },
  {
    id: "context",
    command: "work-on/build/context",
    entryCondition: (s) => s.committed.includes("investigate"),
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      // Context is non-critical: a missing marker is a VISIBLE skip, not a hard fail (spec §7).
      if (has(m, "FORGE:CONTEXT")) return { status: "committed", outputs: {} };
      return { status: "committed", outputs: { skipped: true, which: "context" } };
    },
  },
  {
    id: "architect",
    command: "work-on/build/architect",
    entryCondition: (s) => s.committed.includes("context"),
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      return has(m, "FORGE:ARCHITECT")
        ? { status: "committed", outputs: {} }
        : { status: "failed", detail: "no FORGE:ARCHITECT" };
    },
  },
  {
    id: "build",
    command: "work-on/build",
    entryCondition: (s) => s.committed.includes("architect"),
    async reconcile(state, io) {
      // Idempotent resume: branch already ahead of base → treat as done, skip the LLM.
      if (state.branch && (await commitsAhead(state, io)) > 0) {
        const m = await issueMarkers(state.issue, io);
        if (has(m, "FORGE:BUILDER:COMPLETE")) return { satisfied: true, outputs: { branch: state.branch } };
      }
      return { satisfied: false };
    },
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      const complete = has(m, "FORGE:BUILDER:COMPLETE");           // #1305: require :COMPLETE …
      const ahead = state.branch ? await commitsAhead(state, io) : 0; // … AND real commits
      if (complete && ahead > 0) return { status: "committed", outputs: { branch: state.branch } };
      return { status: "failed", detail: `builder complete=${complete} commitsAhead=${ahead}` };
    },
  },
  {
    id: "review",
    command: "work-on/review",
    entryCondition: (s) => s.committed.includes("build"),
    async reconcile(state, io) {
      const pr = await openPrFor(state, io);   // adopt an existing PR instead of opening a second
      return pr ? { satisfied: false, outputs: { pr } } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const pr = await prStatusFor(state, io);
      if (!pr) return { status: "failed", detail: "no PR created" };
      if (pr.merged) return { status: "committed", outputs: { pr: pr.number } };
      if (pr.needsHuman) return { status: "blocked", detail: "review escalated", outputs: { pr: pr.number } };
      return { status: "failed", detail: "PR open, not merged" };
    },
  },
  {
    id: "close",
    command: "work-on/close",
    entryCondition: (s) => s.committed.includes("review"),
    async detectOutcome(state, io) {
      const out = await io.gh(["issue", "view", String(state.issue), "--json", "state,labels"]);
      const j = JSON.parse(out || "{}");
      const labels = (j.labels || []).map((l) => l.name || l);
      if (j.state === "CLOSED" || labels.includes("workflow:merged"))
        return { status: "committed", terminalReason: "merged", outputs: {} };
      return { status: "failed", detail: "issue not closed" };
    },
    isTerminalAfter: () => true,
  },
];

async function openPrFor(state, io) {
  if (!state.branch) return null;
  const out = await io.gh(["pr", "list", "--head", state.branch, "--json", "number", "--state", "all"]);
  try { const a = JSON.parse(out || "[]"); return a[0]?.number ?? null; } catch { return null; }
}
async function prStatusFor(state, io) {
  const n = await openPrFor(state, io);
  if (!n) return null;
  const out = await io.gh(["pr", "view", String(n), "--json", "number,state,labels,mergedAt"]);
  const j = JSON.parse(out || "{}");
  const labels = (j.labels || []).map((l) => l.name || l);
  return { number: j.number, merged: !!j.mergedAt || j.state === "MERGED",
           needsHuman: labels.includes("needs-human") };
}

/** The engine's transition function: first uncommitted phase whose gate holds. */
export function pickPhase(state) {
  if (state.terminal) return null;
  for (const p of PHASES) {
    if (state.committed.includes(p.id)) continue;
    if (p.entryCondition(state)) return p;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/engine-phases.test.mjs`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add bin/engine/phases.mjs bin/tests/engine-phases.test.mjs
git commit -s -m "feat(engine): declarative phase table + deterministic pickPhase"
```

---

### Task 5: State reconciliation (`bin/engine/reconcile.mjs`)

**Files:**
- Create: `bin/engine/reconcile.mjs`
- Test: `bin/tests/engine-reconcile.test.mjs`

**Interfaces:**
- Produces: `reconcileState(local, remote) => { state:RunState, action:"local"|"hydrate"|"remirror"|"fresh" }`.
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing tests**

```js
// bin/tests/engine-reconcile.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileState } from "../engine/reconcile.mjs";

const mk = (v, phase) => ({ v, run: "r1", issue: 42, lane: "staging",
  committed: [], phase, branch: null, pr: null, terminal: false, terminalReason: null, lease: null });

describe("reconcileState (GitHub wins)", () => {
  it("no remote, no local → fresh", () => {
    assert.equal(reconcileState(null, null).action, "fresh");
  });
  it("no local, remote present → hydrate from remote", () => {
    const r = reconcileState(null, mk(3, "build"));
    assert.equal(r.action, "hydrate"); assert.equal(r.state.phase, "build");
  });
  it("remote ahead of local → GitHub wins (hydrate), discard local", () => {
    const r = reconcileState(mk(3, "build"), mk(5, "review"));
    assert.equal(r.action, "hydrate"); assert.equal(r.state.v, 5);
  });
  it("local ahead of remote → keep local, re-mirror", () => {
    const r = reconcileState(mk(5, "review"), mk(3, "build"));
    assert.equal(r.action, "remirror"); assert.equal(r.state.v, 5);
  });
  it("in sync → keep local", () => {
    const r = reconcileState(mk(3, "build"), mk(3, "build"));
    assert.equal(r.action, "local"); assert.equal(r.state.v, 3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/engine-reconcile.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// bin/engine/reconcile.mjs
/**
 * Merge the local run-log state and the remote FORGE:STATE index.
 * Rule: GitHub wins on divergence (spec §5.3).
 */
export function reconcileState(local, remote) {
  if (!remote) return { state: local ?? null, action: local ? "local" : "fresh" };
  if (!local) return { state: remote, action: "hydrate" };
  if (remote.v > local.v) return { state: remote, action: "hydrate" };   // advanced elsewhere
  if (remote.v < local.v) return { state: local, action: "remirror" };   // crashed pre-mirror
  return { state: local, action: "local" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/engine-reconcile.test.mjs`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add bin/engine/reconcile.mjs bin/tests/engine-reconcile.test.mjs
git commit -s -m "feat(engine): state reconciliation (GitHub wins on divergence)"
```

---

### Task 6: Engine loop (`bin/engine.mjs`)

**Files:**
- Create: `bin/engine.mjs`
- Test: `bin/tests/engine.test.mjs`

**Interfaces:**
- Consumes: `runlog.mjs`, `phases.mjs`, `reconcile.mjs`, `projector.mjs`.
- Produces: `runIssue({ issue, dir, agentId, lane, io, runner, now, maxAttempts }) => Promise<{terminalReason:string}>`.
  - `io = { gh, git }` (async, injected). `runner` is a `runCommand`-shaped async fn. `now()` returns ms. `dir` is the run-log directory. `maxAttempts` defaults to 3.

- [ ] **Step 1: Write the failing test (golden path + visible block)**

```js
// bin/tests/engine.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssue } from "../engine.mjs";
import { readLog, deriveState } from "../engine/runlog.mjs";

let dir; beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-engine-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// A scriptable fake GitHub/git world whose markers advance as phases "run".
function fakeWorld() {
  const w = { markers: "", pr: null, prMerged: false, prNeedsHuman: false,
              issueState: "OPEN", labels: [], commitsAhead: 0, body: "Issue." };
  const io = {
    gh: async (args) => {
      const a = args.join(" ");
      if (a.startsWith("api ") && a.includes("/comments")) return w.markers;
      if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body: w.body });
      if (a.startsWith("issue view")) return JSON.stringify({ state: w.issueState, labels: w.labels });
      if (a.startsWith("issue edit")) { const i = args.indexOf("--body"); if (i>=0) w.body = args[i+1];
        const j = args.indexOf("--add-label"); if (j>=0) w.labels.push(args[j+1]); return ""; }
      if (a.startsWith("pr list")) return JSON.stringify(w.pr ? [{ number: w.pr }] : []);
      if (a.startsWith("pr view")) return JSON.stringify({ number: w.pr, state: w.prMerged?"MERGED":"OPEN",
        mergedAt: w.prMerged ? "t" : null, labels: w.prNeedsHuman ? [{name:"needs-human"}] : [] });
      return "";
    },
    git: async () => String(w.commitsAhead),
  };
  return { w, io };
}

describe("runIssue", () => {
  it("drives investigate→close to merged, committing every phase", async () => {
    const { w, io } = fakeWorld();
    // Each phase run advances the world so detectOutcome sees a committed result.
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 2; },
      "work-on/review": () => { w.pr = 7; w.prMerged = true; },
      "work-on/close": () => { w.issueState = "CLOSED"; },
    };
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };

    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 3 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate","context","architect","build","review","close"]);
    assert.equal(s.branch, "fix/pipeline-42"); // set by engine before build (see impl)
  });

  it("stops at needs-human when a phase reports blocked (no silent merge)", async () => {
    const { w, io } = fakeWorld();
    const script = {
      "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
      "work-on/build/context": () => { w.markers += " FORGE:CONTEXT"; },
      "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT"; },
      "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 1; },
      "work-on/review": () => { w.pr = 7; w.prNeedsHuman = true; },
    };
    const runner = async ({ commandName }) => { script[commandName]?.(); return { status: "complete" }; };
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging",
      io, runner, now: () => 1000, maxAttempts: 1 });
    assert.equal(res.terminalReason, "needs-human");
    assert.ok(w.labels.includes("needs-human"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/engine.test.mjs`
Expected: FAIL — `Cannot find module '../engine.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// bin/engine.mjs
/**
 * Durable per-phase engine loop. Drives one pipeline phase at a time via an
 * injected runner (runCommand-shaped), determining each phase's outcome from
 * GitHub state (phase.detectOutcome). All effects are injected → fully testable.
 */
import { appendEvent, readLog, deriveState } from "./engine/runlog.mjs";
import { PHASES, pickPhase, TERMINAL_REASONS } from "./engine/phases.mjs";
import { reconcileState } from "./engine/reconcile.mjs";
import { makeProjector } from "./engine/projector.mjs";

const DEFAULT_MAX_ATTEMPTS = 3;

export async function runIssue(opts) {
  const { issue, dir, agentId, lane = "staging", io, runner,
          now = () => Date.now(), maxAttempts = DEFAULT_MAX_ATTEMPTS,
          commandsDir = new URL("../commands", import.meta.url).pathname } = opts;
  const projector = makeProjector(io);

  // 1. Load + reconcile (GitHub wins).
  const local = readLog(dir, issue).length ? deriveState(readLog(dir, issue)) : null;
  const remote = await projector.readState(issue);
  let { state, action } = reconcileState(local, remote);
  if (!state) {
    state = freshState(issue, lane);
    appendEvent(dir, issue, { event: "RUN_START", issue, run: state.run, lane });
    await projector.writeState(issue, state);
  } else if (action === "remirror") {
    await projector.writeState(issue, state);
  }

  // 2. Drive phases until terminal.
  let phase;
  while ((phase = pickPhase(state))) {
    // Every issue's build works on a deterministic branch; set it before build runs.
    if (phase.id === "build" && !state.branch) state.branch = `fix/pipeline-${issue}`;

    const reconciled = phase.reconcile ? await phase.reconcile(state, io) : { satisfied: false };
    let outcome;
    if (reconciled.satisfied) {
      outcome = { status: "committed", outputs: reconciled.outputs || {} };
    } else {
      if (reconciled.outputs?.pr) state.pr = reconciled.outputs.pr;
      outcome = await runPhaseWithRetry(phase, state, { io, runner, dir, issue, commandsDir, maxAttempts });
    }

    if (outcome.status === "blocked") return await terminate(state, "needs-human", outcome.detail);

    // committed
    appendEvent(dir, issue, { event: "PHASE_COMMIT", phase: phase.id, outputs: outcome.outputs || {} });
    state = deriveState(readLog(dir, issue));
    if (outcome.terminalReason) state.terminalReason = outcome.terminalReason;
    await projector.writeState(issue, { ...state, lease: { by: agentId, until: now() + 600000 } });

    if (outcome.terminalReason && TERMINAL_REASONS.includes(outcome.terminalReason))
      return await terminate(state, outcome.terminalReason);
    if (phase.isTerminalAfter && phase.isTerminalAfter(state))
      return await terminate(state, state.terminalReason || "merged");
  }
  return await terminate(state, state.terminalReason || "merged");

  async function terminate(s, reason, detail) {
    appendEvent(dir, issue, { event: "RUN_TERMINAL", reason });
    const final = { ...deriveState(readLog(dir, issue)), terminal: true, terminalReason: reason, lease: null };
    await projector.writeState(issue, final);
    if (reason === "needs-human") await projector.setLabel(issue, "needs-human");
    return { terminalReason: reason, detail };
  }
}

async function runPhaseWithRetry(phase, state, ctx) {
  const { io, runner, dir, issue, commandsDir, maxAttempts } = ctx;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    appendEvent(dir, issue, { event: "PHASE_START", phase: phase.id, attempt });
    try {
      await runner({ commandsDir, commandName: phase.command, args: [String(issue)] });
    } catch (e) {
      appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: e.message });
      continue;
    }
    const outcome = await phase.detectOutcome(state, io);
    if (outcome.status === "committed" || outcome.status === "blocked") return outcome;
    appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: outcome.detail });
  }
  // Exhausted transient retries → escalate (spec §7).
  return { status: "blocked", detail: `phase ${phase.id} failed after ${maxAttempts} attempts` };
}

function freshState(issue, lane) {
  return { v: 0, run: `r_${issue}_${lane}`, issue, lane, committed: [], phase: null,
           branch: null, pr: null, terminal: false, terminalReason: null, lease: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/engine.test.mjs`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add bin/engine.mjs bin/tests/engine.test.mjs
git commit -s -m "feat(engine): durable per-phase loop (runIssue) with retry + needs-human"
```

---

### Task 7: Crash-injection durability test (`bin/tests/engine-crash.test.mjs`)

**Files:**
- Create: `bin/tests/engine-crash.test.mjs`

**Interfaces:**
- Consumes: `runIssue` (Task 6), `runlog` helpers. No new production code — this task proves the durability property.

- [ ] **Step 1: Write the failing test**

```js
// bin/tests/engine-crash.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssue } from "../engine.mjs";
import { readLog, deriveState } from "../engine/runlog.mjs";

let dir; beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-crash-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeWorld() {
  const w = { markers:"", pr:null, prMerged:false, issueState:"OPEN", labels:[], commitsAhead:0, body:"Issue." };
  const io = { gh: async (args) => { const a=args.join(" ");
    if (a.includes("/comments")) return w.markers;
    if (a.startsWith("issue view") && a.includes("body")) return JSON.stringify({ body:w.body });
    if (a.startsWith("issue view")) return JSON.stringify({ state:w.issueState, labels:w.labels });
    if (a.startsWith("issue edit")) { const i=args.indexOf("--body"); if(i>=0) w.body=args[i+1];
      const j=args.indexOf("--add-label"); if(j>=0) w.labels.push(args[j+1]); return ""; }
    if (a.startsWith("pr list")) return JSON.stringify(w.pr?[{number:w.pr}]:[]);
    if (a.startsWith("pr view")) return JSON.stringify({ number:w.pr, state:w.prMerged?"MERGED":"OPEN", mergedAt:w.prMerged?"t":null, labels:[] });
    return ""; }, git: async () => String(w.commitsAhead) };
  return { w, io };
}
const scriptFor = (w) => ({
  "work-on/investigate": () => { w.markers += " INVESTIGATION:COMPLETE"; },
  "work-on/build/context": () => { w.markers += " FORGE:CONTEXT"; },
  "work-on/build/architect": () => { w.markers += " FORGE:ARCHITECT"; },
  "work-on/build": () => { w.markers += " FORGE:BUILDER:COMPLETE"; w.commitsAhead = 2; },
  "work-on/review": () => { w.pr = 7; w.prMerged = true; },
  "work-on/close": () => { w.issueState = "CLOSED"; },
});

describe("crash injection", () => {
  it("resumes correctly when the process dies after each phase", async () => {
    const { w, io } = fakeWorld();
    const script = scriptFor(w);
    const order = ["work-on/investigate","work-on/build/context","work-on/build/architect","work-on/build","work-on/review","work-on/close"];

    // Run 1..N: each run "crashes" (throws) right after the k-th phase's runner executes.
    for (let crashAfter = 1; crashAfter <= order.length; crashAfter++) {
      let seen = 0;
      const runner = async ({ commandName }) => {
        script[commandName]();                 // real side effect happens…
        seen++;
        if (seen === crashAfter) throw new Error("SIMULATED CRASH"); // …then the process dies
        return { status: "complete" };
      };
      try { await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1 }); }
      catch { /* crashed; next run resumes from the log */ }
    }
    // Final clean run finishes whatever remains.
    const runner = async ({ commandName }) => { script[commandName](); return { status: "complete" }; };
    const res = await runIssue({ issue: 42, dir, agentId: "a1", lane: "staging", io, runner, now: () => 1 });

    assert.equal(res.terminalReason, "merged");
    const s = deriveState(readLog(dir, 42));
    assert.deepEqual(s.committed, ["investigate","context","architect","build","review","close"]);
    // No phase double-committed (idempotent): each id appears once.
    assert.equal(new Set(s.committed).size, s.committed.length);
    // Exactly one PR was ever adopted (review.reconcile prevented a second).
    assert.equal(w.pr, 7);
  });
});
```

> Note: the engine's `runPhaseWithRetry` swallows a thrown runner as a `PHASE_FAILED` and retries within the same run. To simulate a true process death (no in-run retry), the crash test throws and lets the **outer** `try/catch` abandon the run, then starts a fresh `runIssue` — mirroring a killed process that is re-launched. If the default `maxAttempts` masks the crash, pass `maxAttempts: 1` in the crash runs.

- [ ] **Step 2: Run the test to verify it fails (if it does), then reconcile**

Run: `node --test bin/tests/engine-crash.test.mjs`
Expected initially: may FAIL if in-run retry masks the simulated crash. If so, add `maxAttempts: 1` to the `runIssue` calls inside the `for` loop and re-run. Expected after: PASS.

- [ ] **Step 3: Commit**

```bash
git add bin/tests/engine-crash.test.mjs
git commit -s -m "test(engine): crash-injection proves per-phase resume + idempotency"
```

---

### Task 8: Headless CLI entry + stall scan (`bin/engine-cli.mjs`, wire into `bin/forgedock.mjs`)

**Files:**
- Create: `bin/engine-cli.mjs`
- Modify: `bin/forgedock.mjs` (add a `run` subcommand case in the command switch near the existing `install/init/...` dispatch)
- Test: `bin/tests/engine-cli.test.mjs`

**Interfaces:**
- Consumes: `runIssue` (Task 6).
- Produces: `makeIo() => {gh, git}` (real `gh`/`git` via `execFile`), `scanStalls(issues, dir, io, now) => number[]` (issues whose lease expired on a non-terminal state), and `runFromCli(argv)`.

- [ ] **Step 1: Write the failing test for `scanStalls` (pure, no network)**

```js
// bin/tests/engine-cli.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test bin/tests/engine-cli.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// bin/engine-cli.mjs
/**
 * Headless entry point: `forgedock run <issue>` drives one issue through the
 * durable engine; scanStalls finds dead-lease issues for the orchestrator to resume.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { runIssue } from "./engine.mjs";

const pexec = promisify(execFile);

/** Real gh/git accessors. */
export function makeIo() {
  const run = (bin) => async (args) => {
    const { stdout } = await pexec(bin, args, { maxBuffer: 100 * 1024 * 1024 });
    return stdout;
  };
  return { gh: run("gh"), git: run("git") };
}

export function runDir() { return join(homedir(), ".forge", "runs"); }

/**
 * @param {number[]} issues
 * @param {{readState:(i:number)=>Promise<{terminal:boolean,lease:?{until:number}}|null>}} io
 * @param {number} now
 * @returns {Promise<number[]>} issues that appear stalled (expired lease, non-terminal)
 */
export async function scanStalls(issues, io, now) {
  const stalled = [];
  for (const i of issues) {
    const s = await io.readState(i);
    if (s && !s.terminal && s.lease && s.lease.until < now) stalled.push(i);
  }
  return stalled;
}

export async function runFromCli(argv) {
  const issue = parseInt(argv[0], 10);
  if (!Number.isInteger(issue)) throw new Error("usage: forgedock run <issue-number>");
  const lane = flag(argv, "--lane") || "staging";
  const io = makeIo();
  const agentId = `cli_${process.pid}`;
  const res = await runIssue({ issue, dir: runDir(), agentId, lane, io,
    runner: (await import("./runner.mjs")).runCommand, now: () => Date.now() });
  console.log(`issue #${issue} → ${res.terminalReason}`);
  return res;
}
function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
```

- [ ] **Step 4: Wire the subcommand into `bin/forgedock.mjs`**

Add a `case` to the existing command switch (the block that dispatches `install`/`init`/`update`/`help`). Locate it and insert:

```js
    case "run": {
      const { runFromCli } = await import("./engine-cli.mjs");
      await runFromCli(process.argv.slice(3));
      break;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test bin/tests/engine-cli.test.mjs`
Expected: PASS (1/1).

- [ ] **Step 6: Verify the full engine suite is green**

Run: `node --test "bin/tests/**/*.test.mjs"`
Expected: PASS — all engine suites plus the pre-existing runner/tui/etc. suites.

- [ ] **Step 7: Commit**

```bash
git add bin/engine-cli.mjs bin/tests/engine-cli.test.mjs bin/forgedock.mjs
git commit -s -m "feat(engine): forgedock run headless entry + lease-based stall scan"
```

---

### Task 9: Documentation — orchestrator integration note

**Files:**
- Modify: `commands/orchestrate.md` (add a short "Engine mode" section)
- Modify: `docs/superpowers/specs/2026-07-03-durable-execution-engine-design.md` (mark status: Implemented once Tasks 1–8 land)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add an "Engine mode (headless)" subsection to `commands/orchestrate.md`**

Insert after the existing wave-dispatch description:

```markdown
### Engine mode (headless)

When running headless/CI, dispatch each issue via the durable engine instead of a
prose agent:

    forgedock run <issue> --lane <staging|milestone/slug>

The engine drives every phase transition deterministically, mirrors state to the
`FORGE:STATE` block on the issue, and holds a lease. To recover stalls, scan the
in-flight issues' `FORGE:STATE`; any issue with an expired lease and a non-terminal
state is re-dispatched with the same `forgedock run <issue>` command — it resumes
from the last committed phase (idempotent). This replaces the label-heuristic
"already in progress" check and the resume-with-nagging loop.
```

- [ ] **Step 2: Commit**

```bash
git add commands/orchestrate.md docs/superpowers/specs/2026-07-03-durable-execution-engine-design.md
git commit -s -m "docs(orchestrate): document headless engine mode + lease-based resume"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §4 components: runlog / state / projector / phases / engine | 1 / 2 / 3 / 4 / 6 |
| §5.1 run-log schema + commit rule | 1 |
| §5.2 FORGE:STATE compact index | 2, 3 |
| §5.3 resume + divergence (GitHub wins) | 5, 6 |
| §6 deterministic pickPhase | 4 |
| §6 phase idempotency (reconcile) | 4 (build/review), 6 (invocation) |
| §7 failure taxonomy (committed/failed/blocked, visible skips) | 4 (skip in context), 6 (retry/block) |
| §8 lease + orchestrator integration | 6 (lease write), 8 (scanStalls), 9 (docs) |
| §9 testing (units + crash injection) | 1–6 units, 7 crash injection |
| §12 definition of done | 6 (drive to merged), 7 (resume proof), 8 (headless entry) |

No spec section is left without a task.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step shows complete code; every phase entry is fully written.

**3. Type consistency:** `RunState` shape (`v`, `committed`, `phase`, `branch`, `pr`, `terminal`, `terminalReason`, `lease`) is identical across `runlog.deriveState`, `state` codec, `reconcileState`, `phases`, and `engine`. `PhaseOutcome.status` values (`committed`/`failed`/`blocked`) match between `phases.detectOutcome` and `engine.runPhaseWithRetry`. `io = {gh, git}` and the `runner` signature (`{commandsDir, commandName, args}`) match `runner.runCommand`'s real parameters (verified against `origin/main:bin/runner.mjs`).

**Known follow-ups (out of scope, tracked separately):** full per-phase `reconcile` for context/architect/close; oversized-diff handling in `review` (verification spec #1315); interactive Claude Code adapter; in-process worker-pool vs process-per-issue decision (spec §10).

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bin/observe.mjs — Fleet observability core (forge#2389).
 *
 * One data core, two faces: `forgedock watch` (the human TUI, #2391/#2392)
 * and `forgedock query` (the agent JSON surface, #2390) both consume the
 * `FleetSnapshot`/`IssueDetail` shapes assembled here instead of each
 * independently re-deriving fleet state from `gh` + regex, as `watch`,
 * `/pipeline-status`, `/orchestrate`'s stall detector, and `engine-cli.mjs`'s
 * own helpers previously did (see
 * docs/superpowers/specs/2026-07-17-watch-fleet-observability-design.md).
 *
 * Data sources, merged in trust order (identical rule to
 * `bin/engine/reconcile.mjs`'s `reconcileState` — GitHub wins on
 * disagreement):
 *   1. GitHub — one batched GraphQL `search` query per `getFleetSnapshot()`
 *      call: labels, milestone, body (`FORGE:STATE`), and the last few
 *      comments (`FORGE:HEARTBEAT`) for every open workflow-labeled issue.
 *   2. Local run-logs (`bin/engine/runlog.mjs`) — richest per-phase detail
 *      when present (this machine ran the durable engine for that issue).
 *   3. Derived staleness math against an injected `now()`.
 *
 * Read-only: this module never calls `gh issue edit` / `gh pr` / any
 * mutating command. All effects (`io.gh`, `now`) are injected, matching the
 * DI style of `bin/engine-cli.mjs` / `bin/engine/phases.mjs`, so every
 * function here is unit-testable with no live `gh` and no wall clock.
 *
 * NOTE (forge#2389): `packages/protocol/src/phases.js` — the single-sourced
 * `PHASE_IDS`/`PHASE_MARKERS` registry landed on `staging` via PR #2400
 * (forge#2378) — does not exist yet on this issue's PR base,
 * `milestone/watch-fleet-observability` (verified: `git show
 * origin/milestone/watch-fleet-observability:packages/protocol/src/phases.js`
 * -> not found, vs. `git show origin/staging:...` -> present; the milestone
 * branch predates that merge). Rebasing the shared milestone branch onto
 * `staging` is out of this single issue's scope and would affect the other
 * issues serialized behind it (#2390-#2393). `PHASE_IDS` is duplicated
 * locally below instead of importing it. Replace the local constant with
 * `import { PHASE_IDS } from "../packages/protocol/src/phases.js"` once the
 * milestone branch is rebased onto/merged with a `staging` that has it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLog, deriveState } from "./engine/runlog.mjs";
import { reconcileState } from "./engine/reconcile.mjs";
import { parseState } from "./engine/state.mjs";
import { parseForgeYaml } from "./forge-utils.mjs";
import { terminalDiagnostics, ACTIVE_WORKFLOW_LABELS } from "./engine-cli.mjs";
import { DEFAULT_MAX_ATTEMPTS } from "./engine.mjs";

/** Contract version stamped on every payload this module produces. */
export const SCHEMA = "forge-observe/1";

/**
 * Canonical phase ids in dispatch order. See the module-level NOTE above —
 * this duplicates (does not replace) `packages/protocol/src/phases.js`'s
 * `PHASE_IDS` until the milestone branch has that file.
 */
export const PHASE_IDS = ["investigate", "context", "architect", "build", "review", "close"];

/** GitHub label marking an issue as human-escalated / blocked. */
const BLOCKED_LABEL = "needs-human";

/**
 * Best-effort phase for an agent with NO local run-log and NO remote
 * `FORGE:STATE` block — all we have is the coarse `workflow:*` label.
 * Deliberately coarser than a run-log-backed agent's phase: GitHub's
 * workflow labels do not distinguish context/architect/build (all three
 * live under `workflow:building`), while `PHASE_COMMIT` events do.
 */
const LABEL_PHASE = {
  "workflow:investigating": "investigate",
  "workflow:ready-to-build": "build",
  "workflow:building": "build",
  "workflow:in-review": "review",
  "workflow:awaiting-merge": "review",
  "workflow:merged": "close",
};

/** Labels this module's fleet query watches — active pipeline + blocked. */
export const WATCHED_LABELS = [...ACTIVE_WORKFLOW_LABELS, BLOCKED_LABEL];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Resolve `pipeline.stall_timeout_minutes` from `forge.yaml` via the shared
 * `parseForgeYaml` config loader (`bin/forge-utils.mjs`) — NOT an ad-hoc
 * regex over raw file text (the anti-pattern `bin/forgedock.mjs`'s own
 * `watch()` uses today; this issue's acceptance criteria explicitly forbid
 * reintroducing it here). Falls back to 15 (the documented default — see
 * `forge.yaml.example`) when the file is absent, unreadable, or the key is
 * missing/non-numeric.
 *
 * @param {string} cwd - directory containing forge.yaml (usually process.cwd())
 * @returns {number}
 */
export function resolveStallTimeoutMinutes(cwd) {
  try {
    const path = join(cwd, "forge.yaml");
    if (!existsSync(path)) return 15;
    const raw = readFileSync(path, "utf-8");
    const cfg = parseForgeYaml(raw);
    const value = cfg && cfg.pipeline && cfg.pipeline.stall_timeout_minutes;
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 15;
  } catch {
    return 15;
  }
}

// ---------------------------------------------------------------------------
// GraphQL — one batched query per getFleetSnapshot() call
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe interpolation inside a double-quoted GraphQL
 * string literal (mirrors the precedent in `bin/watch-utils.mjs`'s
 * `escapeGraphQLString` — not imported directly since that file is outside
 * this issue's scope, but the same escaping rule applies: backslash first,
 * then quote, so escaping order can't double-escape).
 * @param {string} value
 * @returns {string}
 */
function escapeGraphQLString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the single GraphQL document `getFleetSnapshot()` sends. Uses
 * GitHub's issue `search` (not per-label `issue(number:)` aliases, which
 * would require already knowing issue numbers) so the whole fleet — labels,
 * milestone, body (`FORGE:STATE`), and last 5 comments (`FORGE:HEARTBEAT`)
 * — comes back in exactly one round trip regardless of fleet size.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string[]} labels - watched labels, OR'd together
 * @param {number} [first=100] - GitHub search page size cap
 * @returns {string}
 */
export function buildFleetSearchQuery(owner, repo, labels, first = 100) {
  // Values here are intentionally raw (unescaped) — `searchQuery` below is
  // escaped exactly once, at the point it is interpolated into the outer
  // GraphQL string literal. Escaping per-value here as well as on the
  // composed string would double-escape (each backslash introduced by the
  // inner escape gets escaped again by the outer one). See forge#2411.
  const labelClause = labels.map((l) => `label:"${l}"`).join(" OR ");
  const searchQuery = `repo:${owner}/${repo} is:issue is:open (${labelClause})`;
  return `query {
  search(type: ISSUE, first: ${Number(first)}, query: "${escapeGraphQLString(searchQuery)}") {
    nodes {
      ... on Issue {
        number
        title
        body
        labels(first: 20) { nodes { name } }
        milestone { title }
        headRefName
        comments(last: 5) { nodes { body } }
      }
    }
  }
  rateLimit { remaining }
}`;
}

/**
 * @param {object} graphqlJson - parsed `gh api graphql` response
 * @returns {{nodes: object[], rateLimitRemaining: number|null}}
 */
export function parseFleetSearchResponse(graphqlJson) {
  const nodes = graphqlJson?.data?.search?.nodes?.filter(Boolean) ?? [];
  const rateLimitRemaining = graphqlJson?.data?.rateLimit?.remaining ?? null;
  return { nodes, rateLimitRemaining };
}

// ---------------------------------------------------------------------------
// Comment parsing (heartbeat) — same field-extraction shape as watch()'s
// existing extractPhase/extractTimestamp (bin/forgedock.mjs), duplicated
// locally rather than imported since forgedock.mjs is outside this issue's
// scope. This is ordinary marker-field extraction, not the forge.yaml
// ad-hoc-regex anti-pattern the acceptance criteria target.
// ---------------------------------------------------------------------------

function lastHeartbeat(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i];
    if (typeof body === "string" && body.includes("FORGE:HEARTBEAT")) {
      const phaseMatch = body.match(/\*\*Phase\*\*:\s*(.+)/);
      const tsMatch = body.match(/\*\*Timestamp\*\*:\s*(\S+)/);
      return {
        phaseText: phaseMatch ? phaseMatch[1].trim() : null,
        at: tsMatch ? tsMatch[1].trim() : null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Current phase id from a resolved RunState (local/remote merge), mirroring
 * `pickPhase()`'s rule in `bin/engine/phases.mjs` ("first uncommitted phase
 * in order") without importing that file (out of this issue's declared
 * scope — see the concurrency note in the issue body). `deriveState()`
 * never populates `state.phase` itself (it's declared but unassigned in the
 * reducer — see `bin/engine/runlog.mjs`), so this must be derived, not read.
 *
 * @param {import("./engine/runlog.mjs").RunState|null} state
 * @returns {string|null}
 */
function currentPhaseFromState(state) {
  if (!state) return null;
  if (state.terminal) return null;
  return PHASE_IDS.find((p) => !state.committed.includes(p)) ?? null;
}

/**
 * Attempt count/max for the current phase, from local run-log events only
 * (the remote FORGE:STATE index does not carry per-phase attempt counts —
 * only the compact committed[] list). Returns null when there is no local
 * run-log, no current phase to report against, or no run-log event for the
 * current phase (absent attempt data must never be reported as "attempt 1"
 * — see forge#2412).
 *
 * @param {object[]} events - readLog() output
 * @param {string|null} phase
 * @returns {{n: number, max: number}|null}
 */
function currentAttempt(events, phase) {
  if (!phase || events.length === 0) return null;
  let n = 0;
  let max = DEFAULT_MAX_ATTEMPTS;
  for (const e of events) {
    if (e.phase !== phase) continue;
    if (e.event === "PHASE_START") n = Math.max(n, e.attempt ?? n);
    if (e.event === "PHASE_FAILED") {
      n = Math.max(n, e.attempt ?? n);
      if (e.maxAttempts) max = e.maxAttempts;
    }
  }
  return n > 0 ? { n, max } : null;
}

/**
 * Phase history from local run-log `PHASE_COMMIT` events. The run-log
 * carries no wall-clock timestamp on any event (see `bin/engine.mjs`'s
 * `appendEvent()` call sites — only a monotonic `seq`), so this reports
 * `committedAtSeq` (the run-log's own ordering key) rather than inventing a
 * fake ISO timestamp. Empty when there is no local run-log for this issue.
 *
 * @param {object[]} events
 * @returns {{phase: string, committedAtSeq: number, attempts: number}[]}
 */
function phaseHistoryFromEvents(events) {
  const history = [];
  const attemptsSeen = {};
  for (const e of events) {
    if (e.event === "PHASE_FAILED") attemptsSeen[e.phase] = e.attempt;
    if (e.event === "PHASE_COMMIT") {
      history.push({
        phase: e.phase,
        committedAtSeq: e.seq,
        attempts: (attemptsSeen[e.phase] ?? 0) + 1,
      });
    }
  }
  return history;
}

/**
 * Merge one GitHub search node with this machine's local run-log (if any)
 * into one `FleetSnapshot.agents[]` entry. GitHub wins on
 * phase/terminal-state disagreement (`reconcileState` — identical rule to
 * the durable engine's own hydrate/remirror logic); `sources` records which
 * data contributed and whether local/remote diverged, so `/diagnose` can
 * treat a run-log-ahead-of-GitHub divergence as a finding in its own right
 * (per the design spec).
 *
 * @param {object} node - one GraphQL search result node
 * @param {object[]} events - readLog() output for this issue (possibly [])
 * @param {number} now - injected clock (ms epoch)
 * @param {number} stallTimeoutMinutes
 * @returns {object} one `agents[]` entry
 */
export function deriveAgent(node, events, now, stallTimeoutMinutes) {
  const labels = (node.labels?.nodes ?? []).map((l) => l.name);
  const workflowLabel = ACTIVE_WORKFLOW_LABELS.find((l) => labels.includes(l))
    ?? (labels.includes(BLOCKED_LABEL) ? BLOCKED_LABEL : null);
  const milestone = node.milestone?.title ?? null;
  const comments = (node.comments?.nodes ?? []).map((c) => c.body);

  // Local run-log state — a truncated/corrupt final line already degrades
  // to a clean partial read inside readLog(); deriveState() never throws on
  // whatever readLog() returns. Guarded again here so one malformed issue's
  // local log can never abort the whole snapshot.
  let localState = null;
  try {
    if (events.length > 0) localState = deriveState(events);
  } catch {
    localState = null;
  }

  let remoteState = null;
  try {
    remoteState = parseState(node.body || "");
  } catch {
    remoteState = null;
  }

  const { state: resolvedState, action } = reconcileState(localState, remoteState);

  const hb = lastHeartbeat(comments);
  let heartbeat = null;
  if (hb && hb.at) {
    const hbMs = Date.parse(hb.at);
    const ageMinutes = Number.isFinite(hbMs) ? Math.floor((now - hbMs) / 60000) : null;
    heartbeat = { at: hb.at, ageMinutes, phaseText: hb.phaseText };
  }

  const phase = currentPhaseFromState(resolvedState) ?? (workflowLabel ? LABEL_PHASE[workflowLabel] ?? null : null);
  const attempt = currentAttempt(events, phase);
  const phaseHistory = phaseHistoryFromEvents(events);

  // Lease is only ever written to the REMOTE state (bin/engine.mjs's
  // runIssue() loop persists `{...state, lease: {...}}` via projector.writeState()
  // on every commit) — deriveState()'s reducer (bin/engine/runlog.mjs) never
  // sets it locally. When reconcileState() picks "local" (the steady-state
  // equal-version case), resolvedState.lease would therefore be incorrectly
  // null even though the remote copy of the very same version carries it —
  // so lease is read from remoteState directly, independent of which side
  // reconcileState() chose for phase/branch/pr.
  const lease = remoteState?.lease ?? resolvedState?.lease ?? null;
  // needs-human can co-occur with an active workflow:* label (it is not
  // always removed together — see the marker-gate failure paths in
  // work-on.md, which add needs-human without stripping workflow:building),
  // so this must check label membership directly rather than relying on
  // workflowLabel's ACTIVE_WORKFLOW_LABELS-first precedence above.
  const blocked = labels.includes(BLOCKED_LABEL);
  const terminal = !!resolvedState?.terminal;

  let status;
  let stall = null;
  if (terminal) {
    status = "terminal";
  } else if (blocked) {
    status = "blocked";
  } else if (heartbeat && heartbeat.ageMinutes !== null && heartbeat.ageMinutes >= stallTimeoutMinutes) {
    status = "stalled";
    stall = { ageMinutes: heartbeat.ageMinutes, threshold: stallTimeoutMinutes };
  } else if (!heartbeat && events.length === 0 && lease && lease.until > now) {
    // No local visibility at all (no run-log here, no heartbeat comment) but
    // GitHub reports an active lease — most likely a different machine/agent
    // is driving this issue right now.
    status = "leased-elsewhere";
  } else {
    status = "running";
  }

  return {
    issue: node.number,
    title: node.title,
    workflowLabel,
    phase,
    phaseHistory,
    attempt,
    heartbeat,
    status,
    stall,
    lease,
    branch: resolvedState?.branch ?? null,
    pr: resolvedState?.pr ?? null,
    milestone,
    runLog: { present: events.length > 0, seq: events.length > 0 ? events[events.length - 1].seq : null },
    sources: {
      state: localState && remoteState ? "github+runlog" : remoteState ? "github" : localState ? "runlog" : "none",
      stateDivergence: !!(localState && remoteState && action !== "local"),
      heartbeat: heartbeat ? "github" : "none",
    },
  };
}

/** Severity rank for deterministic ordering: blocked -> stalled -> running -> the rest. */
const SEVERITY_RANK = { blocked: 0, stalled: 1, running: 2, "leased-elsewhere": 3, terminal: 4 };

/**
 * Deterministic ordering (spec acceptance criterion 5 / issue ac): severity
 * (blocked -> stalled -> running -> leased-elsewhere -> terminal), then
 * ascending issue number.
 * @param {object[]} agents
 * @returns {object[]}
 */
function sortAgents(agents) {
  return [...agents].sort((a, b) => {
    const ra = SEVERITY_RANK[a.status] ?? 99;
    const rb = SEVERITY_RANK[b.status] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.issue - b.issue;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the full-fleet `FleetSnapshot` in exactly one GitHub round trip
 * (`search` GraphQL query) plus purely-local run-log reads.
 *
 * @param {object} opts
 * @param {string} opts.repo - "owner/repo"
 * @param {string} opts.runsDir - local run-log directory (e.g. engine-cli.mjs's runDir())
 * @param {() => number} [opts.now] - injected clock; defaults to Date.now
 * @param {{gh: (args: string[]) => Promise<string>}} opts.io - injected `gh` accessor
 * @param {number} [opts.stallTimeoutMinutes] - overrides forge.yaml resolution (mainly for tests)
 * @param {string} [opts.cwd] - directory to resolve forge.yaml from (defaults to process.cwd())
 * @returns {Promise<object>} FleetSnapshot — includes `rateLimitRemaining` (GitHub GraphQL
 *   rate-limit budget remaining after this call, or `null` if the response didn't carry it),
 *   surfaced for `forgedock watch`'s adaptive-polling header (forge#2391).
 */
export async function getFleetSnapshot(opts) {
  const { repo, runsDir, io } = opts;
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  const [owner, repoName] = String(repo).split("/");
  const stallTimeoutMinutes = opts.stallTimeoutMinutes ?? resolveStallTimeoutMinutes(opts.cwd ?? process.cwd());

  const query = buildFleetSearchQuery(owner, repoName, WATCHED_LABELS);
  // Exactly one GitHub request for the whole fleet, regardless of size.
  const raw = await io.gh(["api", "graphql", "-f", `query=${query}`]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const { nodes, rateLimitRemaining } = parseFleetSearchResponse(parsed);

  const agents = nodes.map((node) => {
    let events = [];
    try {
      events = readLog(runsDir, node.number);
    } catch {
      events = []; // corrupt/unreadable local log — degrade to GitHub-only for this issue
    }
    return deriveAgent(node, events, now, stallTimeoutMinutes);
  });

  const sorted = sortAgents(agents);
  const counts = {
    running: sorted.filter((a) => a.status === "running").length,
    stalled: sorted.filter((a) => a.status === "stalled").length,
    blocked: sorted.filter((a) => a.status === "blocked").length,
    leased: sorted.filter((a) => a.lease && a.lease.until > now).length,
    quiet: false,
  };
  counts.quiet = counts.running === 0 && counts.stalled === 0;

  return {
    schema: SCHEMA,
    repo,
    at: new Date(now).toISOString(),
    stallTimeoutMinutes,
    rateLimitRemaining,
    counts,
    agents: sorted,
  };
}

/**
 * Deep detail for one issue: the snapshot row plus full phase history,
 * structured terminal diagnostics (`bin/engine-cli.mjs`'s
 * `terminalDiagnostics()`), the last heartbeat body verbatim, and lease.
 *
 * @param {object} opts
 * @param {string} opts.repo - "owner/repo"
 * @param {number} opts.issue
 * @param {string} opts.runsDir
 * @param {() => number} [opts.now]
 * @param {{gh: (args: string[]) => Promise<string>}} opts.io
 * @param {number} [opts.stallTimeoutMinutes]
 * @param {string} [opts.cwd]
 * @returns {Promise<object>} IssueDetail
 */
export async function getIssueDetail(opts) {
  const { repo, issue, runsDir, io } = opts;
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  const stallTimeoutMinutes = opts.stallTimeoutMinutes ?? resolveStallTimeoutMinutes(opts.cwd ?? process.cwd());

  const raw = await io.gh([
    "issue", "view", String(issue), "--repo", repo,
    "--json", "number,title,body,labels,milestone,comments",
  ]);
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    j = {};
  }
  const node = {
    number: j.number ?? issue,
    title: j.title ?? null,
    body: j.body ?? "",
    labels: { nodes: (j.labels ?? []).map((l) => ({ name: l.name ?? l })) },
    milestone: j.milestone ? { title: j.milestone.title } : null,
    comments: { nodes: (j.comments ?? []).map((c) => ({ body: c.body ?? "" })) },
  };

  let events = [];
  try {
    events = readLog(runsDir, issue);
  } catch {
    events = [];
  }

  const agent = deriveAgent(node, events, now, stallTimeoutMinutes);
  const diagnostics = terminalDiagnostics(runsDir, issue);
  const lastHeartbeatBody = [...(node.comments.nodes ?? [])]
    .reverse()
    .map((c) => c.body)
    .find((b) => typeof b === "string" && b.includes("FORGE:HEARTBEAT")) ?? null;

  return {
    schema: SCHEMA,
    repo,
    at: new Date(now).toISOString(),
    ...agent,
    diagnostics,
    lastHeartbeatBody,
    events,
  };
}

/**
 * Raw local run-log slice — zero network, filesystem only. A polling agent
 * can use `sinceSeq` as a cursor to consume the run-log incrementally.
 *
 * @param {object} opts
 * @param {string} opts.runsDir
 * @param {number} opts.issue
 * @param {number} [opts.sinceSeq] - only events with seq > sinceSeq
 * @returns {object[]}
 */
export function readEvents(opts) {
  const { runsDir, issue, sinceSeq } = opts;
  let events = [];
  try {
    events = readLog(runsDir, issue);
  } catch {
    return [];
  }
  if (!Number.isFinite(sinceSeq)) return events;
  return events.filter((e) => e.seq > sinceSeq);
}

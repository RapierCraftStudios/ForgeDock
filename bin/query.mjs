// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bin/query.mjs — `forgedock query <scope>` (forge#2390).
 *
 * The agent-facing CLI face over `bin/observe.mjs`'s data core (forge#2389).
 * A thin dispatcher only: this module never calls `gh`/GraphQL/JSONL
 * directly — it exclusively consumes `getFleetSnapshot()`, `getIssueDetail()`,
 * and `readEvents()` from `./observe.mjs` ("one parser, one truth" — see
 * docs/superpowers/specs/2026-07-17-watch-fleet-observability-design.md
 * §"Face 2 — forgedock query").
 *
 * Usage:
 *   forgedock query fleet                                 # FleetSnapshot
 *   forgedock query issue <n>                              # IssueDetail
 *   forgedock query issue <n> --events [--since-seq N]     # raw run-log slice (local, zero network)
 *   forgedock query stalls                                 # only stalled/blocked agents
 *   forgedock query orchestration [--milestone M]          # fleet grouped by milestone
 *
 * Flags:
 *   --fields <csv>     Project each agent object to the named top-level fields (plus `issue`)
 *   --limit N          Cap the number of agents/events returned
 *   --since-seq N      (issue --events only) events strictly after seq N
 *   --repo owner/repo  Same resolution as `watch`: explicit flag, else forge.yaml
 *
 * Contract: exactly one JSON document on stdout, nothing else — errors too
 * (`{"schema":"forge-observe/1","error":{"code":…,"message":…}}`). Exit
 * codes are signals an agent can branch on without parsing:
 *   0 = healthy fleet, 2 = stalls present, 3 = blocked present (wins over 2),
 *   4 = query/usage error.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SCHEMA, getFleetSnapshot, getIssueDetail, readEvents } from "./observe.mjs";

const pexec = promisify(execFile);

// ---------------------------------------------------------------------------
// Repo resolution — mirrors bin/forgedock.mjs's private resolveLabelsRepo()
// (not exported from that module, so the same two-step resolution is
// duplicated here rather than reaching across module boundaries for a
// private helper): explicit --repo flag first, then forge.yaml in cwd.
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv - args after "query <scope>"
 * @param {string} [cwd]
 * @returns {string|null} "owner/repo" or null
 */
export function resolveQueryRepo(argv, cwd = process.cwd()) {
  const idx = argv.indexOf("--repo");
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];

  const forgeYamlPath = join(cwd, "forge.yaml");
  if (existsSync(forgeYamlPath)) {
    try {
      const raw = readFileSync(forgeYamlPath, "utf-8");
      const ownerMatch = raw.match(/^\s*owner:\s*["']?([^\s"'#]+)["']?/m);
      const repoMatch = raw.match(/^\s*repo:\s*["']?([^\s"'#]+)["']?/m);
      if (ownerMatch && repoMatch) return `${ownerMatch[1]}/${repoMatch[1]}`;
    } catch {
      // fall through to null
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default io — a plain `gh` shell-out matching observe.mjs's expected
// `io.gh(args) => Promise<string>` shape. No shell interpolation: argv array
// only, passed straight to execFile (see forge#1586 precedent in report.mjs).
// ---------------------------------------------------------------------------

function defaultIo() {
  return {
    gh: async (args) => {
      const { stdout } = await pexec("gh", args, { maxBuffer: 100 * 1024 * 1024, timeout: 10000 });
      return stdout;
    },
  };
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function flagValue(argv, name) {
  const idx = argv.indexOf(name);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : null;
}

/**
 * Parse an integer-valued flag. Returns `{ ok: true, value }` when absent
 * (value: null) or a valid non-negative integer, `{ ok: false }` when the
 * flag is present but not a valid non-negative integer.
 */
function parseIntFlag(argv, name) {
  const raw = flagValue(argv, name);
  if (raw === null) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

function parseFields(argv) {
  const raw = flagValue(argv, "--fields");
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Projection / ordering helpers
// ---------------------------------------------------------------------------

/**
 * Project one agent object to the named top-level fields plus `issue`
 * (always kept, per contract: "plus issue").
 * @param {object} agent
 * @param {string[]|null} fields
 * @returns {object}
 */
export function projectFields(agent, fields) {
  if (!fields || fields.length === 0) return agent;
  const out = { issue: agent.issue };
  for (const f of fields) {
    if (f === "issue") continue;
    if (Object.prototype.hasOwnProperty.call(agent, f)) out[f] = agent[f];
  }
  return out;
}

function applyLimit(list, limit) {
  if (limit === null || limit === undefined) return list;
  return list.slice(0, limit);
}

/**
 * Exit code from FleetSnapshot-style counts: blocked wins over stalled.
 * @param {{blocked: number, stalled: number}} counts
 * @returns {number}
 */
export function computeExitCode(counts) {
  if (counts && counts.blocked > 0) return 3;
  if (counts && counts.stalled > 0) return 2;
  return 0;
}

function errorDoc(code, message) {
  return { schema: SCHEMA, error: { code, message } };
}

function write(stdout, doc) {
  stdout.write(JSON.stringify(doc) + "\n");
}

// ---------------------------------------------------------------------------
// Scope handlers
// ---------------------------------------------------------------------------

async function handleFleet({ argv, io, now, runsDir, cwd, stdout }) {
  const repo = resolveQueryRepo(argv, cwd);
  if (!repo) {
    write(stdout, errorDoc("NO_REPO", "No repository found. Pass --repo owner/repo or run from a directory with forge.yaml."));
    return 4;
  }
  const limitParsed = parseIntFlag(argv, "--limit");
  if (!limitParsed.ok) {
    write(stdout, errorDoc("BAD_FLAG", "--limit must be a non-negative integer"));
    return 4;
  }
  const fields = parseFields(argv);

  const snapshot = await getFleetSnapshot({ repo, runsDir, io, now, cwd });
  let agents = applyLimit(snapshot.agents, limitParsed.value);
  if (fields) agents = agents.map((a) => projectFields(a, fields));
  const doc = { ...snapshot, agents };
  write(stdout, doc);
  return computeExitCode(snapshot.counts);
}

async function handleStalls({ argv, io, now, runsDir, cwd, stdout }) {
  const repo = resolveQueryRepo(argv, cwd);
  if (!repo) {
    write(stdout, errorDoc("NO_REPO", "No repository found. Pass --repo owner/repo or run from a directory with forge.yaml."));
    return 4;
  }
  const limitParsed = parseIntFlag(argv, "--limit");
  if (!limitParsed.ok) {
    write(stdout, errorDoc("BAD_FLAG", "--limit must be a non-negative integer"));
    return 4;
  }
  const fields = parseFields(argv);

  const snapshot = await getFleetSnapshot({ repo, runsDir, io, now, cwd });
  let agents = snapshot.agents.filter((a) => a.status === "stalled" || a.status === "blocked");
  agents = applyLimit(agents, limitParsed.value);
  if (fields) agents = agents.map((a) => projectFields(a, fields));
  const doc = {
    schema: snapshot.schema,
    repo: snapshot.repo,
    at: snapshot.at,
    stallTimeoutMinutes: snapshot.stallTimeoutMinutes,
    agents,
  };
  write(stdout, doc);
  return computeExitCode(snapshot.counts);
}

async function handleOrchestration({ argv, io, now, runsDir, cwd, stdout }) {
  const repo = resolveQueryRepo(argv, cwd);
  if (!repo) {
    write(stdout, errorDoc("NO_REPO", "No repository found. Pass --repo owner/repo or run from a directory with forge.yaml."));
    return 4;
  }
  const limitParsed = parseIntFlag(argv, "--limit");
  if (!limitParsed.ok) {
    write(stdout, errorDoc("BAD_FLAG", "--limit must be a non-negative integer"));
    return 4;
  }
  const fields = parseFields(argv);
  const milestoneFilter = flagValue(argv, "--milestone");

  const snapshot = await getFleetSnapshot({ repo, runsDir, io, now, cwd });
  let agents = snapshot.agents;
  if (milestoneFilter) agents = agents.filter((a) => a.milestone === milestoneFilter);
  agents = applyLimit(agents, limitParsed.value);

  // Group by milestone. observe.mjs's FleetSnapshot/agent shape carries no
  // separate "wave" concept (verified against bin/observe.mjs — see
  // FORGE:ARCHITECT risk assessment) — group strictly by the one grouping
  // key that exists (agent.milestone) and report per-milestone status
  // counts as the progress proxy the design spec's "per-wave progress"
  // prose calls for.
  const groups = new Map();
  for (const a of agents) {
    const key = a.milestone ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fields ? projectFields(a, fields) : a);
  }
  const milestones = [...groups.entries()]
    .sort((x, y) => {
      const kx = x[0] ?? "";
      const ky = y[0] ?? "";
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    })
    .map(([milestone, groupAgents]) => {
      const counts = {
        running: groupAgents.filter((a) => a.status === "running").length,
        stalled: groupAgents.filter((a) => a.status === "stalled").length,
        blocked: groupAgents.filter((a) => a.status === "blocked").length,
        terminal: groupAgents.filter((a) => a.status === "terminal").length,
      };
      return { milestone, counts, agents: groupAgents };
    });

  const doc = {
    schema: snapshot.schema,
    repo: snapshot.repo,
    at: snapshot.at,
    stallTimeoutMinutes: snapshot.stallTimeoutMinutes,
    milestones,
  };
  write(stdout, doc);
  return computeExitCode(snapshot.counts);
}

async function handleIssue({ argv, io, now, runsDir, cwd, stdout }) {
  const issueRaw = argv[1];
  const issue = Number(issueRaw);
  if (!issueRaw || !Number.isInteger(issue) || issue <= 0) {
    write(stdout, errorDoc("USAGE", "issue scope requires a positive integer issue number: forgedock query issue <n>"));
    return 4;
  }

  const eventsMode = argv.includes("--events");

  if (eventsMode) {
    // Zero-network scope — MUST be routed before any repo resolution/NO_REPO
    // check below. readEvents() is filesystem-only (see observe.mjs).
    const sinceSeqParsed = parseIntFlag(argv, "--since-seq");
    if (!sinceSeqParsed.ok) {
      write(stdout, errorDoc("BAD_FLAG", "--since-seq must be a non-negative integer"));
      return 4;
    }
    const limitParsed = parseIntFlag(argv, "--limit");
    if (!limitParsed.ok) {
      write(stdout, errorDoc("BAD_FLAG", "--limit must be a non-negative integer"));
      return 4;
    }
    let events = readEvents({ runsDir, issue, sinceSeq: sinceSeqParsed.value ?? undefined });
    events = applyLimit(events, limitParsed.value ?? 50);
    write(stdout, { schema: SCHEMA, issue, sinceSeq: sinceSeqParsed.value, events });
    return 0;
  }

  const repo = resolveQueryRepo(argv, cwd);
  if (!repo) {
    write(stdout, errorDoc("NO_REPO", "No repository found. Pass --repo owner/repo or run from a directory with forge.yaml."));
    return 4;
  }
  const fields = parseFields(argv);

  const detail = await getIssueDetail({ repo, issue, runsDir, io, now, cwd });
  const doc = fields ? { ...projectFields(detail, fields), schema: detail.schema } : detail;
  write(stdout, doc);
  return detail.status === "blocked" ? 3 : detail.status === "stalled" ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv - args after "query" (e.g. ["fleet"], ["issue", "42", "--events"])
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.stdout]
 * @param {{gh: (args: string[]) => Promise<string>}} [opts.io]
 * @param {() => number} [opts.now]
 * @param {string} [opts.runsDir]
 * @param {string} [opts.cwd]
 * @returns {Promise<number>} exit code
 */
export async function runQuery(argv, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const io = opts.io ?? defaultIo();
  const now = opts.now ?? (() => Date.now());
  const runsDir = opts.runsDir ?? join(homedir(), ".forge", "runs");
  const cwd = opts.cwd ?? process.cwd();

  const scope = argv[0];
  const ctx = { argv, io, now, runsDir, cwd, stdout };

  try {
    switch (scope) {
      case "fleet":
        return await handleFleet(ctx);
      case "issue":
        return await handleIssue(ctx);
      case "stalls":
        return await handleStalls(ctx);
      case "orchestration":
        return await handleOrchestration(ctx);
      default:
        write(
          stdout,
          errorDoc(
            "UNKNOWN_SCOPE",
            `Unknown scope: ${scope ?? "(none)"}. Expected one of: fleet, issue <n>, stalls, orchestration.`,
          ),
        );
        return 4;
    }
  } catch (err) {
    write(stdout, errorDoc("QUERY_ERROR", err && err.message ? err.message : String(err)));
    return 4;
  }
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bin/watch.mjs — `forgedock watch` (forge#2391).
 *
 * The human-facing face over `bin/observe.mjs`'s data core (forge#2389),
 * rebuilding the flicker-prone, N+1-polling, hand-rolled-ANSI `watch()` that
 * previously lived inline in `bin/forgedock.mjs` (see
 * docs/superpowers/specs/2026-07-17-watch-fleet-observability-design.md
 * §"Face 1"). This module never talks to `gh`/GraphQL directly — it
 * exclusively consumes `getFleetSnapshot()` from `./observe.mjs`, exactly
 * one call per poll tick.
 *
 * All ANSI/color/box-drawing comes from `./tui.mjs` and `./cinema.mjs` — no
 * raw ANSI escape literals anywhere in this file except the cursor-addressing
 * sequences in `writeFrame()`, which are inherent to the frame-diff redraw
 * technique itself (there is no `tui.mjs` primitive for "move cursor to row
 * N and clear to end of line" — that IS this file's contribution).
 *
 * Keyboard interaction beyond `q`/Ctrl+C exit (selection, drill-down,
 * sort/filter/pause, the `?` legend) is explicitly out of scope for this
 * issue — see forge#2392, serialized behind this one.
 *
 * Screen model: no alternate screen buffer (cinema.mjs:283 rule). Flicker is
 * eliminated via cursor-addressed per-line diff redraw instead of `\x1b[2J`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getFleetSnapshot, PHASE_IDS } from "./observe.mjs";
import { stripAnsi, truncateVisible, dim, bold } from "./tui.mjs";
import { renderMark, colorMode } from "./cinema.mjs";

const pexec = promisify(execFile);

// ---------------------------------------------------------------------------
// Polling ladder (design spec §"Performance & rate-limit budget")
// ---------------------------------------------------------------------------

const POLL_ACTIVE_MS = 5000; // counts.running > 0
const POLL_QUIET_MS = 30000; // fleet quiet
const POLL_STRETCHED_MS = 60000; // remaining GraphQL rate budget below threshold
export const RATE_BUDGET_STRETCH_THRESHOLD = 500;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Adaptive poll interval selection (design spec: 5s active / 30s quiet /
 * stretched when the GraphQL rate-limit budget runs low, independent of the
 * running/quiet state — a low budget always wins, since burning through the
 * remainder of it faster only makes things worse).
 *
 * @param {{running: number}} counts
 * @param {number|null} rateLimitRemaining
 * @returns {number} milliseconds
 */
export function selectPollIntervalMs(counts, rateLimitRemaining) {
  if (typeof rateLimitRemaining === "number" && rateLimitRemaining < RATE_BUDGET_STRETCH_THRESHOLD) {
    return POLL_STRETCHED_MS;
  }
  return counts && counts.running > 0 ? POLL_ACTIVE_MS : POLL_QUIET_MS;
}

// ---------------------------------------------------------------------------
// Repo resolution + default io — mirrors bin/query.mjs's resolveQueryRepo /
// defaultIo (bin/forgedock.mjs's own resolveLabelsRepo() is private and not
// exported, so the same two-step resolution is duplicated here rather than
// reaching across module boundaries — identical precedent to query.mjs).
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {string|null} "owner/repo" or null
 */
export function resolveWatchRepo(argv, cwd = process.cwd()) {
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

function defaultIo() {
  return {
    gh: async (args) => {
      const { stdout } = await pexec("gh", args, { maxBuffer: 100 * 1024 * 1024, timeout: 10000 });
      return stdout;
    },
  };
}

/**
 * Preserves today's exact `gh auth status` pre-flight check and error
 * message (AC: no regression in the gh-unauthenticated error path).
 * @param {{gh: (args: string[]) => Promise<string>}} io
 * @returns {Promise<boolean>}
 */
async function checkGhAuth(io) {
  try {
    await io.gh(["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatElapsedMinutes(minutes) {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatAttempt(attempt) {
  if (!attempt) return "—";
  return `${attempt.n}/${attempt.max}`;
}

const STATUS_LABEL = {
  running: "● running",
  stalled: "▲ STALLED",
  blocked: "⛔ BLOCKED",
  "leased-elsewhere": "◌ leased",
  terminal: "✔ done",
};

function formatStatus(agent) {
  if (agent.status === "stalled" && agent.stall) {
    return `▲ ${agent.stall.ageMinutes}m > ${agent.stall.threshold}m`;
  }
  return STATUS_LABEL[agent.status] ?? agent.status;
}

// ---------------------------------------------------------------------------
// Pure frame construction — no I/O. Returns string[] (one entry per screen
// row), so diffFrame()/writeFrame() can redraw only the rows that changed.
// ---------------------------------------------------------------------------

/**
 * @param {object[]} agents - already severity-sorted (observe.mjs's
 *   getFleetSnapshot always returns agents pre-sorted blocked->stalled->
 *   running->leased-elsewhere->terminal, then ascending issue number — this
 *   function does not re-sort).
 * @param {number} width
 * @returns {string[]}
 */
function renderFleetTable(agents, width) {
  if (agents.length === 0) {
    return [dim("  No in-flight issues. All quiet.")];
  }

  const header = ["#", "TITLE", "PHASE", "ATTEMPT", "HEARTBEAT", "STATUS"];
  const rows = agents.map((a) => [
    `#${a.issue}`,
    a.title ?? "",
    a.phase ?? "—",
    formatAttempt(a.attempt),
    a.heartbeat && a.heartbeat.ageMinutes !== null ? `${a.heartbeat.ageMinutes}m ago` : "—",
    formatStatus(a),
  ]);

  const colCount = header.length;
  const rawWidths = Array.from({ length: colCount }, (_, c) =>
    Math.max(
      stripAnsi(header[c]).length,
      ...rows.map((r) => stripAnsi(String(r[c] ?? "")).length),
    ),
  );

  // Title column absorbs any overflow so the table never exceeds terminal
  // width — the same truncateVisible/stripAnsi-based width discipline the
  // design spec requires for resize reflow.
  const fixedWidth = rawWidths.reduce((sum, w, i) => (i === 1 ? sum : sum + w + 2), 0);
  const titleBudget = Math.max(8, width - fixedWidth - 2);
  const widths = rawWidths.map((w, i) => (i === 1 ? Math.min(w, titleBudget) : w));

  function renderRow(cells, isHeader) {
    return cells
      .map((cell, c) => {
        const text = c === 1 ? truncateVisible(String(cell ?? ""), widths[c]) : String(cell ?? "");
        const visual = stripAnsi(text).length;
        const pad = " ".repeat(Math.max(0, widths[c] - visual)) + (c < cells.length - 1 ? "  " : "");
        const formatted = isHeader ? bold(dim(text)) : text;
        return formatted + pad;
      })
      .join("")
      .trimEnd();
  }

  const lines = [renderRow(header, true)];
  for (const row of rows) lines.push(renderRow(row, false));
  return lines;
}

/**
 * The selected agent's six-phase pipeline, rendered from local run-log
 * data only (no network) — `phaseHistory`/`phase`/`attempt` are already
 * assembled by `observe.mjs`'s `deriveAgent()`.
 * @param {object} agent
 * @param {string} spinnerChar
 * @returns {string[]}
 */
function renderFocusStrip(agent, spinnerChar) {
  if (!agent) return [];

  const committed = new Map();
  for (const h of agent.phaseHistory ?? []) committed.set(h.phase, h.attempts);

  const pieces = PHASE_IDS.map((phase) => {
    const isCurrent = agent.phase === phase;
    let marker;
    if (committed.has(phase)) {
      marker = `${phase} ✔${committed.get(phase)}`;
    } else if (isCurrent) {
      marker = `${phase} ${spinnerChar} ${formatAttempt(agent.attempt)}`;
    } else {
      marker = `${phase} ○`;
    }
    return isCurrent ? `▸ ${bold(marker)}` : `  ${marker}`;
  });

  const header = `#${agent.issue} · ${agent.branch ?? "—"} · PR ${agent.pr ?? "—"}`;
  const lastEvent =
    agent.runLog && agent.runLog.present
      ? `last event  seq ${agent.runLog.seq}`
      : "no local run-log for this issue — phase derived from GitHub labels only";

  return [dim(`  ${header}`), `  ${pieces.join("   ")}`, dim(`  ${lastEvent}`)];
}

/**
 * Build the full frame (header, rule, fleet table, focus strip, key bar) as
 * a flat array of lines — pure, no I/O, so it's directly unit-testable and
 * feeds `diffFrame()`.
 *
 * @param {object} snapshot - FleetSnapshot from getFleetSnapshot()
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {'truecolor'|'256'|'none'} [opts.mode='none']
 * @param {number} [opts.tick=0] - poll tick counter, drives the spinner frame
 * @param {number} [opts.pollIntervalMs=5000]
 * @param {boolean} [opts.paused=false]
 * @returns {string[]}
 */
export function renderFrame(snapshot, opts = {}) {
  const width = opts.width ?? 80;
  const mode = opts.mode ?? "none";
  const tick = opts.tick ?? 0;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_ACTIVE_MS;
  const paused = !!opts.paused;
  const spinnerChar = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];

  const mark = renderMark("compact", mode);
  const budgetLabel =
    typeof snapshot.rateLimitRemaining === "number" ? `api ${snapshot.rateLimitRemaining} left` : "api —";
  const pollLabel = paused ? "paused" : `poll ${Math.round(pollIntervalMs / 1000)}s`;
  const stretched = pollIntervalMs >= POLL_STRETCHED_MS ? " (rate-limited, interval stretched)" : "";

  const headerLines = [
    `${mark[0]}  ${bold("FORGEDOCK watch")}  —  ${dim(snapshot.repo ?? "")}`,
    `${mark[1]}  ${dim(`${spinnerChar} ${pollLabel}${stretched} · ${budgetLabel}`)}`,
    `${mark[2] ?? ""}`,
    `${mark[3] ?? ""}`,
  ];

  const rule = dim("─".repeat(Math.max(10, width)));
  const table = renderFleetTable(snapshot.agents ?? [], width);
  const focused = (snapshot.agents ?? [])[0] ?? null;
  const focusStrip = renderFocusStrip(focused, spinnerChar);
  const keyBar = dim("  q / Ctrl+C  quit");

  const lines = [...headerLines, rule, ...table];
  if (focusStrip.length > 0) {
    lines.push(rule, ...focusStrip);
  }
  lines.push(rule, keyBar);
  return lines;
}

// ---------------------------------------------------------------------------
// Frame-diff redraw — cursor-addressed per-line rewrite, no \x1b[2J, no alt
// screen (design spec: "Screen model" decision + cinema.mjs:283 rule).
// ---------------------------------------------------------------------------

/**
 * @param {string[]|null} prevLines - null forces every line to be treated
 *   as changed (first paint)
 * @param {string[]} nextLines
 * @returns {{row: number, text: string}[]} only the rows that changed
 */
export function diffFrame(prevLines, nextLines) {
  const ops = [];
  const prevLen = prevLines ? prevLines.length : 0;
  const maxLen = Math.max(prevLen, nextLines.length);
  for (let i = 0; i < maxLen; i++) {
    const prev = prevLines ? prevLines[i] : undefined;
    const next = nextLines[i] ?? "";
    if (prev !== next) ops.push({ row: i, text: next });
  }
  return ops;
}

/**
 * Write only the changed rows via cursor addressing (`\x1b[{row}H`) +
 * clear-to-end-of-line (`\x1b[K`) — the technique that replaces `\x1b[2J`
 * full-screen clear. This is the one place raw ANSI cursor-addressing
 * literals are allowed in this file (no `tui.mjs` primitive covers
 * per-line cursor addressing — see module docblock).
 *
 * @param {NodeJS.WritableStream} stdout
 * @param {{row: number, text: string}[]} ops
 */
export function writeFrame(stdout, ops) {
  for (const { row, text } of ops) {
    stdout.write(`\x1b[${row + 1}H\x1b[K${text}`);
  }
}

// ---------------------------------------------------------------------------
// NDJSON mode (non-TTY / --json) — one FleetSnapshot per poll, zero ANSI.
// Replaces the old plain-text non-TTY fallback per the design spec.
// ---------------------------------------------------------------------------

async function runNdjsonLoop({ repo, io, now, runsDir, cwd, stdout, maxTicks, sleep }) {
  let ticks = 0;
  let exitCode = 0;
  while (maxTicks === undefined || ticks < maxTicks) {
    const snapshot = await getFleetSnapshot({ repo, runsDir, io, now, cwd });
    stdout.write(JSON.stringify(snapshot) + "\n");
    exitCode = snapshot.counts.blocked > 0 ? 3 : snapshot.counts.stalled > 0 ? 2 : 0;
    ticks += 1;
    if (maxTicks !== undefined && ticks >= maxTicks) break;
    const interval = selectPollIntervalMs(snapshot.counts, snapshot.rateLimitRemaining);
    await sleep(interval);
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// Interactive TTY loop
// ---------------------------------------------------------------------------

async function runInteractiveLoop({ repo, io, now, runsDir, cwd, stdout, stdin, maxTicks, sleep }) {
  const mode = colorMode(process.env, stdout);
  const width = stdout.columns ?? 80;
  let prevLines = null;
  let tick = 0;
  let stopped = false;

  function paint(snapshot, pollIntervalMs) {
    const lines = renderFrame(snapshot, { width: stdout.columns ?? width, mode, tick, pollIntervalMs });
    const ops = diffFrame(prevLines, lines);
    if (ops.length > 0) writeFrame(stdout, ops);
    prevLines = lines;
  }

  // Resize forces a full repaint on the next tick (width may have changed,
  // and stale content from a wider/narrower previous frame must be cleared).
  const onResize = () => {
    prevLines = null;
  };
  if (typeof stdout.on === "function") stdout.on("resize", onResize);

  let cleanedUp = false;
  function cleanup(summary) {
    if (cleanedUp) return;
    cleanedUp = true;
    stopped = true;
    if (typeof stdout.off === "function") stdout.off("resize", onResize);
    if (stdout.isTTY) stdout.write("\x1b[?25h\n"); // restore cursor
    if (summary) stdout.write(summary + "\n");
  }

  if (stdout.isTTY) stdout.write("\x1b[?25l"); // hide cursor

  let onKey = null;
  let wasRaw = false;
  if (stdin && stdin.isTTY) {
    wasRaw = !!stdin.isRaw;
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf-8");
      onKey = (key) => {
        // "q" or Ctrl+C (charCode 3, ETX) checked by code point rather than
        // an embedded raw control-character literal, for source clarity.
        if (key === "q" || (key.length === 1 && key.charCodeAt(0) === 3)) {
          stopped = true;
        }
      };
      stdin.on("data", onKey);
    } catch {
      // Terminal doesn't support raw mode — keyboard-less, matches today's
      // fallback behavior (design spec: "Raw-mode input follows the exact
      // setRawMode try/catch ... pattern of tui.mjs select()").
      onKey = null;
    }
  }

  const started = typeof now === "function" ? now() : Date.now();
  let lastCounts = { running: 0, stalled: 0, blocked: 0 };

  try {
    while (!stopped && (maxTicks === undefined || tick < maxTicks)) {
      const snapshot = await getFleetSnapshot({ repo, runsDir, io, now, cwd });
      lastCounts = snapshot.counts;
      const interval = selectPollIntervalMs(snapshot.counts, snapshot.rateLimitRemaining);
      paint(snapshot, interval);
      tick += 1;
      if (stopped) break;
      await sleep(interval);
    }
  } finally {
    if (onKey && stdin) {
      try {
        stdin.off("data", onKey);
        stdin.setRawMode(wasRaw);
        stdin.pause();
      } catch {
        // ignore
      }
    }
    const nowMs = typeof now === "function" ? now() : Date.now();
    const watchedMin = Math.max(0, Math.round((nowMs - started) / 60000));
    cleanup(
      `${lastCounts.running} running · ${lastCounts.stalled} stalled · ${lastCounts.blocked} blocked · watched ${watchedMin}m`,
    );
  }

  return lastCounts.blocked > 0 ? 3 : lastCounts.stalled > 0 ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv - args after "watch"
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.stdout]
 * @param {NodeJS.ReadableStream} [opts.stdin]
 * @param {NodeJS.WritableStream} [opts.stderr]
 * @param {{gh: (args: string[]) => Promise<string>}} [opts.io]
 * @param {() => number} [opts.now]
 * @param {string} [opts.runsDir]
 * @param {string} [opts.cwd]
 * @param {number} [opts.maxTicks] - bound the poll loop (tests only)
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injected timer (tests only)
 * @returns {Promise<number>} exit code
 */
export async function runWatch(argv, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const stdin = opts.stdin ?? process.stdin;
  const io = opts.io ?? defaultIo();
  const now = opts.now ?? (() => Date.now());
  const runsDir = opts.runsDir ?? join(homedir(), ".forge", "runs");
  const cwd = opts.cwd ?? process.cwd();
  // The scheduling timer is deliberately left ref'd (default Node behavior)
  // — it is the only thing keeping the event loop alive between polls. An
  // unref'd timer would let the process exit after the first frame despite
  // printing "polling" text (forge#1593).
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const repo = resolveWatchRepo(argv, cwd);
  if (!repo) {
    stderr.write("No repository found.\n  Run from a directory with forge.yaml, or pass --repo owner/repo.\n");
    return 1;
  }

  const authed = await checkGhAuth(io);
  if (!authed) {
    stderr.write("gh CLI is not authenticated.\n  Fix: run `gh auth login` then retry.\n");
    return 1;
  }

  const jsonMode = argv.includes("--json") || stdout.isTTY !== true;
  if (jsonMode) {
    return runNdjsonLoop({ repo, io, now, runsDir, cwd, stdout, maxTicks: opts.maxTicks, sleep });
  }
  return runInteractiveLoop({ repo, io, now, runsDir, cwd, stdout, stdin, maxTicks: opts.maxTicks, sleep });
}

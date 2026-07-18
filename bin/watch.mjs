// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bin/watch.mjs — `forgedock watch` (forge#2391, forge#2392).
 *
 * The human-facing face over `bin/observe.mjs`'s data core (forge#2389),
 * rebuilding the flicker-prone, N+1-polling, hand-rolled-ANSI `watch()` that
 * previously lived inline in `bin/forgedock.mjs` (see
 * docs/superpowers/specs/2026-07-17-watch-fleet-observability-design.md
 * §"Face 1"). This module never talks to `gh`/GraphQL directly — it
 * exclusively consumes `getFleetSnapshot()`/`getIssueDetail()` from
 * `./observe.mjs`.
 *
 * All ANSI/color/box-drawing comes from `./tui.mjs` and `./cinema.mjs` — no
 * raw ANSI escape literals anywhere in this file except the cursor-addressing
 * sequences in `writeFrame()`, which are inherent to the frame-diff redraw
 * technique itself (there is no `tui.mjs` primitive for "move cursor to row
 * N and clear to end of line" — that IS this file's contribution).
 *
 * Keyboard interaction (forge#2392): ↑/↓ (or j/k) move a selection that
 * drives the focus strip; Enter opens a drill-down detail view sourced from
 * `getIssueDetail()`, Esc returns; `o` opens the selected issue in the
 * browser via `journey.mjs`'s `openUrl()`; `s`/`f` cycle sort/filter; `p`
 * pauses/resumes polling with a frozen banner (no `gh` calls while paused);
 * `?` overlays the key legend; `q`/Ctrl+C exit unchanged. All of this lives
 * inside `runInteractiveLoop()` only — the NDJSON/`--json` path
 * (`runNdjsonLoop()`) never activates the keyboard layer.
 *
 * Note on "timestamps": the local run-log carries no wall-clock timestamp
 * on any event, only a monotonic `seq` (see `observe.mjs`'s
 * `phaseHistoryFromEvents()` docblock) — the detail view reports
 * `committedAtSeq` per phase, mirroring `renderFocusStrip()`'s existing
 * "last event seq N" convention, and surfaces the one real wall-clock value
 * that IS available (the GitHub-sourced heartbeat timestamp) separately,
 * rather than fabricating per-phase durations the data doesn't support.
 *
 * Screen model: no alternate screen buffer (cinema.mjs:283 rule). Flicker is
 * eliminated via cursor-addressed per-line diff redraw instead of `\x1b[2J`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getFleetSnapshot, getIssueDetail, PHASE_IDS } from "./observe.mjs";
import { stripAnsi, truncateVisible, dim, bold, yellow } from "./tui.mjs";
import { renderMark, colorMode } from "./cinema.mjs";
import { openUrl } from "./journey.mjs";

const pexec = promisify(execFile);

// ---------------------------------------------------------------------------
// Polling ladder (design spec §"Performance & rate-limit budget")
// ---------------------------------------------------------------------------

const POLL_ACTIVE_MS = 5000; // counts.running > 0
const POLL_QUIET_MS = 30000; // fleet quiet
const POLL_STRETCHED_MS = 60000; // remaining GraphQL rate budget below threshold
export const RATE_BUDGET_STRETCH_THRESHOLD = 500;

// Frozen-banner refresh cadence while paused — deliberately short so 'p'/'q'
// stay responsive, but this never triggers a getFleetSnapshot()/gh call.
const PAUSED_REFRESH_MS = 1000;

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
// Keyboard interaction state helpers (forge#2392) — sort/filter cycling and
// the sort/filter application itself. All keyed by internal, fixed enum
// values only (never a GitHub-sourced string), so no plain-object lookup
// table here is exposed to the prototype-leak pattern from #1955/#1969.
// ---------------------------------------------------------------------------

export const SORT_ORDERS = ["severity", "heartbeatAge", "issueNumber"];
export const FILTER_MODES = ["all", "stalled+blocked", "running"];

const SORT_LABELS = { severity: "severity", heartbeatAge: "heartbeat age", issueNumber: "issue #" };
const FILTER_LABELS = { all: "all", "stalled+blocked": "stalled+blocked", running: "running" };

function nextInCycle(list, current) {
  const idx = list.indexOf(current);
  return list[(idx + 1) % list.length];
}

/**
 * Sort/filter a *copy* of the fleet's agent list — never mutates the input
 * array, since `snapshot.agents` is relied on elsewhere (poll-loop
 * bookkeeping) in its original, severity-pre-sorted order.
 *
 * @param {object[]} agents
 * @param {string} sortOrder - one of SORT_ORDERS
 * @param {string} filterMode - one of FILTER_MODES
 * @returns {object[]}
 */
export function applySortAndFilter(agents, sortOrder, filterMode) {
  let list = (agents ?? []).slice();

  if (filterMode === "stalled+blocked") {
    list = list.filter((a) => a.status === "stalled" || a.status === "blocked");
  } else if (filterMode === "running") {
    list = list.filter((a) => a.status === "running");
  }

  if (sortOrder === "heartbeatAge") {
    list = list.slice().sort((a, b) => {
      const ax = a.heartbeat && typeof a.heartbeat.ageMinutes === "number" ? a.heartbeat.ageMinutes : -1;
      const bx = b.heartbeat && typeof b.heartbeat.ageMinutes === "number" ? b.heartbeat.ageMinutes : -1;
      return bx - ax; // oldest heartbeat (largest age) first
    });
  } else if (sortOrder === "issueNumber") {
    list = list.slice().sort((a, b) => a.issue - b.issue);
  }
  // sortOrder === "severity" (default): agents arrive pre-sorted by
  // getFleetSnapshot (blocked -> stalled -> running -> leased-elsewhere ->
  // terminal, then ascending issue number) — filtering above preserves that
  // relative order, so no re-sort is needed.

  return list;
}

// ---------------------------------------------------------------------------
// Pure frame construction — no I/O. Returns string[] (one entry per screen
// row), so diffFrame()/writeFrame() can redraw only the rows that changed.
// ---------------------------------------------------------------------------

/**
 * @param {object[]} agents - already sorted/filtered by the caller
 *   (renderFrame applies applySortAndFilter() before calling this).
 * @param {number} width
 * @param {number} [selectedIdx=-1] - row to mark with the `▸` pointer;
 *   -1 marks no row.
 * @returns {string[]}
 */
function renderFleetTable(agents, width, selectedIdx = -1) {
  if (agents.length === 0) {
    return [dim("  No in-flight issues. All quiet.")];
  }

  const header = [" ", "#", "TITLE", "PHASE", "ATTEMPT", "HEARTBEAT", "STATUS"];
  const rows = agents.map((a, i) => [
    i === selectedIdx ? "▸" : " ",
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

  // Title column (index 2 — pointer and # now precede it) absorbs any
  // overflow so the table never exceeds terminal width — the same
  // truncateVisible/stripAnsi-based width discipline the design spec
  // requires for resize reflow.
  const fixedWidth = rawWidths.reduce((sum, w, i) => (i === 2 ? sum : sum + w + 2), 0);
  const titleBudget = Math.max(8, width - fixedWidth - 2);
  const widths = rawWidths.map((w, i) => (i === 2 ? Math.min(w, titleBudget) : w));

  function renderRow(cells, isHeader) {
    return cells
      .map((cell, c) => {
        const text =
          c === 2 ? truncateVisible(stripAnsi(String(cell ?? "")), widths[c]) : String(cell ?? "");
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
 * Drill-down detail view (forge#2392 AC2) — rendered from `observe.mjs`'s
 * `getIssueDetail()` (`IssueDetail`: `deriveAgent()`'s agent fields spread
 * in, plus `diagnostics`, `lastHeartbeatBody`, `events`). Per-phase entries
 * report `committedAtSeq` rather than a wall-clock duration — see this
 * file's module docblock "Note on timestamps".
 *
 * @param {object|null} detail - IssueDetail from getIssueDetail()
 * @returns {string[]}
 */
function renderDetailView(detail) {
  if (!detail) return [dim("  No detail available.")];

  const lines = [];
  lines.push(`  ${bold(`#${detail.issue} · ${stripAnsi(detail.title ?? "")}`)}`);
  lines.push(dim(`  ${stripAnsi(detail.branch ?? "—")} · PR ${detail.pr ?? "—"} · ${formatStatus(detail)}`));
  lines.push("");

  lines.push(`  ${bold("Phase timeline")}`);
  const committed = new Map();
  for (const h of detail.phaseHistory ?? []) committed.set(h.phase, h);
  for (const phase of PHASE_IDS) {
    const isCurrent = detail.phase === phase;
    if (committed.has(phase)) {
      const h = committed.get(phase);
      lines.push(`    ✔ ${phase}  attempts ${h.attempts}  committed @ seq ${h.committedAtSeq}`);
    } else if (isCurrent) {
      lines.push(`  ▸ ${bold(phase)}  attempt ${formatAttempt(detail.attempt)}  (in progress)`);
    } else {
      lines.push(dim(`    ○ ${phase}  not started`));
    }
  }
  lines.push("");

  lines.push(`  ${bold("Last heartbeat")}`);
  if (detail.heartbeat && detail.heartbeat.at) {
    const age = typeof detail.heartbeat.ageMinutes === "number" ? `${detail.heartbeat.ageMinutes}m ago` : "—";
    lines.push(`    ${detail.heartbeat.phaseText ?? "—"} · ${detail.heartbeat.at} (${age})`);
  } else {
    lines.push(dim("    No heartbeat recorded."));
  }
  if (detail.lastHeartbeatBody) {
    const bodyLines = String(detail.lastHeartbeatBody).split("\n").slice(0, 6);
    for (const l of bodyLines) lines.push(dim(`    ${stripAnsi(l)}`));
  }
  lines.push("");

  if (detail.status === "terminal" && detail.diagnostics && detail.diagnostics.failedPhase) {
    lines.push(`  ${bold("Terminal diagnostics")}`);
    lines.push(`    failed phase: ${detail.diagnostics.failedPhase}`);
    lines.push(`    attempt: ${detail.diagnostics.attempt ?? "—"}/${detail.diagnostics.maxAttempts ?? "—"}`);
    lines.push(`    reason: ${detail.diagnostics.reason ?? "—"}`);
    lines.push("");
  }

  lines.push(`  ${bold("Lease")}`);
  lines.push(detail.lease ? `    held until ${detail.lease.until ?? "—"}` : dim("    none"));

  return lines;
}

/**
 * Static key legend overlay (forge#2392 AC6). Pure, no I/O.
 * @returns {string[]}
 */
function renderKeyLegend() {
  return [
    `  ${bold("Keys")}`,
    "  ↑/↓ (j/k)  move selection      Enter  detail view",
    "  Esc        back to fleet       o      open in browser",
    "  s          cycle sort          f      cycle filter",
    "  p          pause/resume        ?      dismiss this legend",
    "  q / Ctrl+C quit",
  ];
}

// detailError is meant to be a closed set of fixed-literal status strings,
// never free text — see the `opts.detailError` JSDoc below and the sole
// writer in runInteractiveLoop(). KNOWN_DETAIL_ERRORS is the render-boundary
// enforcement of that contract: renderFrame() only renders a detailError
// value that is a member of this set, so a future call site that
// accidentally threads external/caught-error text (e.g. `err.message`)
// through this parameter is silently not rendered rather than leaking
// unsanitized content into the fleet view (forge#2562, hardening the
// convention documented but not enforced since forge#2491).
const DETAIL_FETCH_FAILED_MESSAGE = "detail fetch failed — press Enter to retry";
const KNOWN_DETAIL_ERRORS = new Set([DETAIL_FETCH_FAILED_MESSAGE]);

/**
 * Build the full frame (header, rule, fleet table or detail view, focus
 * strip, key bar / legend) as a flat array of lines — pure, no I/O, so it's
 * directly unit-testable and feeds `diffFrame()`.
 *
 * @param {object} snapshot - FleetSnapshot from getFleetSnapshot()
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {'truecolor'|'256'|'none'} [opts.mode='none']
 * @param {number} [opts.tick=0] - poll tick counter, drives the spinner frame
 * @param {number} [opts.pollIntervalMs=5000]
 * @param {boolean} [opts.paused=false]
 * @param {number} [opts.pausedAgeSeconds] - seconds since pause started, shown in the frozen banner
 * @param {'fleet'|'detail'} [opts.viewMode='fleet']
 * @param {object|null} [opts.detail] - IssueDetail, required when viewMode==='detail'
 * @param {string} [opts.sortOrder='severity'] - one of SORT_ORDERS
 * @param {string} [opts.filterMode='all'] - one of FILTER_MODES
 * @param {number} [opts.selectedIndex=0] - index into the sorted/filtered agent list
 * @param {boolean} [opts.showLegend=false]
 * @param {string|null} [opts.detailError] - fixed-literal message shown as a
 *   one-line banner in the fleet view when a drill-down detail fetch fails
 *   (forge#2491); never echoes external/caught-error content verbatim.
 *   Enforced at render time — only rendered when it is a member of
 *   KNOWN_DETAIL_ERRORS (forge#2562), so a value outside that closed set is
 *   silently not rendered rather than leaking unsanitized content.
 * @returns {string[]}
 */
export function renderFrame(snapshot, opts = {}) {
  const width = opts.width ?? 80;
  const mode = opts.mode ?? "none";
  const tick = opts.tick ?? 0;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_ACTIVE_MS;
  const paused = !!opts.paused;
  const viewMode = opts.viewMode === "detail" ? "detail" : "fleet";
  const sortOrder = SORT_ORDERS.includes(opts.sortOrder) ? opts.sortOrder : "severity";
  const filterMode = FILTER_MODES.includes(opts.filterMode) ? opts.filterMode : "all";
  const showLegend = !!opts.showLegend;
  const spinnerChar = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];

  const mark = renderMark("compact", mode);
  const budgetLabel =
    typeof snapshot.rateLimitRemaining === "number" ? `api ${snapshot.rateLimitRemaining} left` : "api —";
  const pollLabel = paused ? "paused" : `poll ${Math.round(pollIntervalMs / 1000)}s`;
  const stretched = pollIntervalMs >= POLL_STRETCHED_MS ? " (rate-limited, interval stretched)" : "";
  const sortFilterLabel = `sort: ${SORT_LABELS[sortOrder]} · filter: ${FILTER_LABELS[filterMode]}`;

  const headerLines = [
    `${mark[0]}  ${bold("FORGEDOCK watch")}  —  ${dim(snapshot.repo ?? "")}`,
    `${mark[1]}  ${dim(`${spinnerChar} ${pollLabel}${stretched} · ${budgetLabel} · ${sortFilterLabel}`)}`,
    `${mark[2] ?? ""}`,
    `${mark[3] ?? ""}`,
  ];

  const rule = dim("─".repeat(Math.max(10, width)));
  const filteredAgents = applySortAndFilter(snapshot.agents ?? [], sortOrder, filterMode);
  const clampedIndex =
    filteredAgents.length > 0
      ? Math.min(Math.max(0, Number.isInteger(opts.selectedIndex) ? opts.selectedIndex : 0), filteredAgents.length - 1)
      : 0;
  const selected = filteredAgents[clampedIndex] ?? null;

  const lines = [...headerLines, rule];

  if (viewMode === "detail" && opts.detail) {
    lines.push(...renderDetailView(opts.detail));
  } else {
    lines.push(...renderFleetTable(filteredAgents, width, clampedIndex));
    const focusStrip = renderFocusStrip(selected, spinnerChar);
    if (focusStrip.length > 0) {
      lines.push(rule, ...focusStrip);
    }
  }

  if (paused) {
    const ageLabel = Number.isFinite(opts.pausedAgeSeconds) ? `${opts.pausedAgeSeconds}s` : "0s";
    lines.push(rule, dim(`  ⏸ paused ${ageLabel} — press p to resume`));
  }

  if (viewMode === "fleet" && opts.detailError && KNOWN_DETAIL_ERRORS.has(opts.detailError)) {
    lines.push(rule, yellow(`  ⚠ ${opts.detailError}`));
  }

  if (showLegend) {
    lines.push(rule, ...renderKeyLegend());
  } else {
    const keyBar =
      viewMode === "detail"
        ? dim("  Esc  back    o  open    ?  legend    q / Ctrl+C  quit")
        : dim("  ↑/↓ select   Enter detail   o open   s sort   f filter   p pause   ?  legend   q / Ctrl+C  quit");
    lines.push(rule, keyBar);
  }

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
// Replaces the old plain-text non-TTY fallback per the design spec. The
// keyboard layer (forge#2392) never activates here.
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

async function runInteractiveLoop({
  repo,
  io,
  now,
  runsDir,
  cwd,
  stdout,
  stdin,
  maxTicks,
  sleep,
  getIssueDetailFn,
  openFn,
}) {
  const mode = colorMode(process.env, stdout);
  const width = stdout.columns ?? 80;
  const getDetail = getIssueDetailFn ?? getIssueDetail;
  const doOpen = openFn ?? openUrl;

  let prevLines = null;
  let tick = 0;
  let stopped = false;

  // Keyboard interaction state (forge#2392) — all internal, fixed-enum
  // state; never keyed by an unsanitized external string (see module
  // docblock re: #1955/#1969 prototype-leak pattern).
  let selectedIndex = 0;
  let viewMode = "fleet"; // "fleet" | "detail"
  let sortOrder = "severity";
  let filterMode = "all";
  let paused = false;
  let pausedAt = null;
  let showLegend = false;
  let detail = null;
  let detailLoading = false;
  let detailError = null; // fixed-literal status string, or null (forge#2491)

  let lastSnapshot = null;
  let lastInterval = POLL_ACTIVE_MS;

  function currentFilteredAgents() {
    return applySortAndFilter(lastSnapshot ? lastSnapshot.agents ?? [] : [], sortOrder, filterMode);
  }

  function paint(snapshot, pollIntervalMs, extra = {}) {
    const lines = renderFrame(snapshot, {
      width: stdout.columns ?? width,
      mode,
      tick,
      pollIntervalMs,
      selectedIndex,
      viewMode,
      sortOrder,
      filterMode,
      paused,
      showLegend,
      detail,
      detailError,
      ...extra,
    });
    const ops = diffFrame(prevLines, lines);
    if (ops.length > 0) writeFrame(stdout, ops);
    prevLines = lines;
  }

  function repaint() {
    // Guards against the detail-fetch `.finally()` (and any other async
    // caller) writing an extra frame to stdout after `cleanup()` has
    // already restored the cursor and printed the exit summary — the
    // in-flight `getIssueDetail()` promise from an Enter-then-quit race
    // is not cancelled, so this is the single choke point every caller
    // goes through (forge#2492, review finding on PR #2482).
    if (cleanedUp) return;
    if (!lastSnapshot) return;
    if (paused && pausedAt !== null) {
      const nowMs = typeof now === "function" ? now() : Date.now();
      paint(lastSnapshot, lastInterval, { pausedAgeSeconds: Math.max(0, Math.round((nowMs - pausedAt) / 1000)) });
    } else {
      paint(lastSnapshot, lastInterval);
    }
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
        // Ctrl+C (charCode 3, ETX) checked by code point rather than an
        // embedded raw control-character literal, for source clarity —
        // always quits immediately, regardless of view/legend state.
        if (key.length === 1 && key.charCodeAt(0) === 3) {
          stopped = true;
          return;
        }

        // The legend overlay swallows the next keypress to dismiss itself —
        // it never also triggers that key's normal action (AC: "any key
        // dismisses it").
        if (showLegend) {
          showLegend = false;
          repaint();
          return;
        }

        if (key === "q") {
          stopped = true;
          return;
        }

        if (key === "?") {
          showLegend = true;
          repaint();
          return;
        }

        if (viewMode === "detail") {
          // Esc (charCode 27, ESC — same code-point-check convention as the
          // Ctrl+C guard above, not an embedded raw control-character
          // literal) returns to the fleet view. 'o' opens the
          // currently-displayed issue in the browser — the detail view's
          // own key bar advertises "o  open", so it must actually be wired
          // here rather than falling through to the fleet-view-only 'o'
          // handler below (which this early return never reaches). All
          // other keys are inert while the detail view is open
          // (q/Ctrl+C/legend already handled above are the exceptions).
          if (key.length === 1 && key.charCodeAt(0) === 27) {
            viewMode = "fleet";
            detail = null;
            repaint();
          } else if (key === "o" && detail) {
            doOpen(`https://github.com/${repo}/issues/${detail.issue}`);
          }
          return;
        }

        // --- fleet view ---
        const filteredAgents = currentFilteredAgents();

        if (key === "\x1b[A" || key === "k") {
          if (filteredAgents.length > 0) {
            selectedIndex = (selectedIndex - 1 + filteredAgents.length) % filteredAgents.length;
            repaint();
          }
          return;
        }
        if (key === "\x1b[B" || key === "j") {
          if (filteredAgents.length > 0) {
            selectedIndex = (selectedIndex + 1) % filteredAgents.length;
            repaint();
          }
          return;
        }
        if (key === "\r" || key === "\n") {
          const target = filteredAgents[selectedIndex];
          if (target && !detailLoading) {
            detailLoading = true;
            getDetail({ repo, issue: target.issue, runsDir, io, now, cwd })
              .then((d) => {
                detail = d;
                detailError = null;
                viewMode = "detail";
              })
              .catch(() => {
                // A detail-fetch failure leaves the fleet view intact
                // rather than crashing the loop, but it must not be
                // silent (forge#2491) — record a fixed-literal status
                // message (never the caught error's own text, to keep
                // rendered state free of unsanitized external content).
                // Sourced from the shared DETAIL_FETCH_FAILED_MESSAGE
                // constant (forge#2562) so this writer and renderFrame()'s
                // KNOWN_DETAIL_ERRORS allowlist can never drift apart.
                detailError = DETAIL_FETCH_FAILED_MESSAGE;
              })
              .finally(() => {
                detailLoading = false;
                repaint();
              });
          }
          return;
        }
        if (key === "o") {
          const target = filteredAgents[selectedIndex];
          if (target) doOpen(`https://github.com/${repo}/issues/${target.issue}`);
          return;
        }
        if (key === "s") {
          sortOrder = nextInCycle(SORT_ORDERS, sortOrder);
          selectedIndex = 0;
          repaint();
          return;
        }
        if (key === "f") {
          filterMode = nextInCycle(FILTER_MODES, filterMode);
          selectedIndex = 0;
          repaint();
          return;
        }
        if (key === "p") {
          paused = !paused;
          pausedAt = paused ? (typeof now === "function" ? now() : Date.now()) : null;
          repaint();
          return;
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

  // The removed inline watch() explicitly registered SIGINT/SIGTERM to
  // restore the hidden cursor on exit (see forge#1428/#1593 — cleanup-on-
  // exit is a recurring bug class in this module). The raw-mode stdin
  // keypress listener above only covers Ctrl+C when stdin IS a TTY; an
  // external SIGTERM (process manager, `kill`), or Ctrl+C when stdin isn't
  // a TTY (piped input, some terminal multiplexers), bypasses it entirely
  // and would otherwise leave the cursor hidden with no cleanup. Handling
  // both signals directly closes that gap regardless of stdin's TTY state.
  const onSignal = () => {
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const started = typeof now === "function" ? now() : Date.now();
  let lastCounts = { running: 0, stalled: 0, blocked: 0 };

  try {
    while (!stopped && (maxTicks === undefined || tick < maxTicks)) {
      if (paused) {
        // Frozen: no getFleetSnapshot()/gh call, no rate-limit spend.
        // Repaint the frozen frame with an updated paused-duration banner
        // and wait in short increments so 'p'/'q' stay responsive without
        // polling GitHub.
        repaint();
        await sleep(Math.min(PAUSED_REFRESH_MS, lastInterval || PAUSED_REFRESH_MS));
        continue;
      }

      const snapshot = await getFleetSnapshot({ repo, runsDir, io, now, cwd });
      lastSnapshot = snapshot;
      lastCounts = snapshot.counts;
      const interval = selectPollIntervalMs(snapshot.counts, snapshot.rateLimitRemaining);
      lastInterval = interval;

      // Re-clamp selection against the freshly-fetched (possibly shrunk)
      // filtered list — a previously-valid index can go stale between
      // polls even without the operator touching sort/filter.
      const filteredAgents = applySortAndFilter(snapshot.agents ?? [], sortOrder, filterMode);
      if (filteredAgents.length === 0) selectedIndex = 0;
      else if (selectedIndex >= filteredAgents.length) selectedIndex = filteredAgents.length - 1;

      paint(snapshot, interval);
      tick += 1;
      if (stopped) break;
      await sleep(interval);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
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
 * @param {(opts: object) => Promise<object>} [opts.getIssueDetailFn] - injected `getIssueDetail` (tests only)
 * @param {(url: string) => void} [opts.openFn] - injected `openUrl` (tests only)
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
  const getIssueDetailFn = opts.getIssueDetailFn ?? getIssueDetail;
  const openFn = opts.openFn ?? openUrl;

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
  return runInteractiveLoop({
    repo,
    io,
    now,
    runsDir,
    cwd,
    stdout,
    stdin,
    maxTicks: opts.maxTicks,
    sleep,
    getIssueDetailFn,
    openFn,
  });
}

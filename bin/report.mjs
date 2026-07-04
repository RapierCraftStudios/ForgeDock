/**
 * bin/report.mjs — ForgeDock pipeline impact report.
 *
 * Usage (via forgedock.mjs router):
 *   npx forgedock report [--days N] [--md] [--json] [--quiet]
 *
 * Reads forge.yaml for owner/repo, queries GitHub via `gh` CLI, and
 * renders a 30-day (configurable) pipeline impact summary.
 *
 * Output modes:
 *   default  compact terminal table
 *   --md     paste-ready Markdown block (for standups / GitHub comments)
 *   --json   machine-readable JSON
 *
 * Degrades gracefully:
 *   - unauthenticated gh  → doctor-style error, exit 1
 *   - missing forge.yaml  → actionable error, exit 1
 *   - no ForgeDock history → "run /work-on on your first issue" pointer
 *
 * Approximate search-index counts are labeled with "~" to match the
 * honesty rules used in the README.
 *
 * SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { parseForgeYaml } from "./forge-utils.mjs";

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute median of a numeric array. Returns null for empty arrays.
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute p90 of a numeric array. Returns null for empty arrays.
 * @param {number[]} values
 * @returns {number|null}
 */
export function p90(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[rank - 1];
}

/**
 * Format minutes into a human-readable string (Xh Ym or Xm).
 * @param {number|null} minutes
 * @returns {string}
 */
export function fmtMinutes(minutes) {
  if (minutes === null || minutes === undefined) return "—";
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/**
 * Format a percentage (0–100). Returns "—" for null.
 * @param {number|null} pct
 * @returns {string}
 */
export function fmtPct(pct) {
  if (pct === null || pct === undefined) return "—";
  return `${Math.round(pct)}%`;
}

/**
 * Check if a PR body contains a closing reference to an issue.
 * Matches: Closes/Fixes/Resolves/close/fix/resolve + #N (case-insensitive).
 * @param {string} body
 * @returns {boolean}
 */
export function hasIssueRef(body) {
  if (!body) return false;
  return /\b(?:closes?|fixes?|resolves?)\s+#\d+/i.test(body);
}

/**
 * Check if a GitHub user login looks like a bot/app (ends in [bot] or is a
 * known automation account).
 * @param {string} login
 * @returns {boolean}
 */
export function isBot(login) {
  if (!login) return false;
  return login.endsWith("[bot]") || login === "github-actions";
}

/**
 * Compute minutes between two ISO timestamps.
 * Returns null if either is missing or invalid.
 * @param {string} created
 * @param {string} closed
 * @returns {number|null}
 */
export function minutesBetween(created, closed) {
  if (!created || !closed) return null;
  const ms = new Date(closed) - new Date(created);
  if (isNaN(ms) || ms < 0) return null;
  return ms / 60000;
}

// ---------------------------------------------------------------------------
// GitHub data fetchers
// ---------------------------------------------------------------------------

/**
 * Run a gh CLI command and return its stdout as a string.
 * Throws on non-zero exit.
 * @param {string[]} args
 * @returns {string}
 */
function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf-8" });
}

/**
 * Fetch closed issues in the window.
 * Returns array of {number, createdAt, closedAt, labels, body, user.login}.
 */
function fetchClosedIssues(repo, since, until) {
  // gh issue list returns up to 1000; for repos with very high volume we
  // paginate 200 at a time. Approximate counts via gh search for totals.
  const raw = gh(
    "issue", "list",
    "-R", repo,
    "--state", "closed",
    "--limit", "1000",
    "--json", "number,createdAt,closedAt,labels,body,author",
    "--search", `closed:${since}..${until}`,
  );
  return JSON.parse(raw);
}

/**
 * Fetch merged PRs in the window.
 * Returns array of {number, mergedAt, body, author}.
 */
function fetchMergedPRs(repo, since, until) {
  const raw = gh(
    "pr", "list",
    "-R", repo,
    "--state", "merged",
    "--limit", "1000",
    "--json", "number,mergedAt,body,author",
    "--search", `merged:${since}..${until}`,
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Stat computation (exported for testing with fixtures)
// ---------------------------------------------------------------------------

/**
 * Compute all report stats from raw issue and PR arrays.
 *
 * @param {Object[]} issues - Closed issues in window
 * @param {Object[]} prs    - Merged PRs in window
 * @param {Object}  opts
 * @param {string}  opts.since  ISO date string (window start)
 * @param {string}  opts.until  ISO date string (window end)
 * @param {number}  opts.days   Window length in days
 * @returns {Object} stats
 */
export function computeStats(issues, prs, { since, until, days } = {}) {
  const totalIssues = issues.length;
  const totalPRs = prs.length;

  // Issues with FORGE annotations
  const withTrajectory = issues.filter(
    (i) => i.body && i.body.includes("FORGE:TRAJECTORY"),
  ).length;
  const withInvestigator = issues.filter(
    (i) => i.body && i.body.includes("FORGE:INVESTIGATOR"),
  ).length;

  // Time-to-close in minutes
  const closeTimes = issues
    .map((i) => minutesBetween(i.createdAt, i.closedAt))
    .filter((t) => t !== null);

  const medianClose = median(closeTimes);
  const p90Close = p90(closeTimes);

  // PRs referencing an issue
  const prsWithRef = prs.filter((p) => hasIssueRef(p.body)).length;
  const prRefRate =
    totalPRs > 0 ? (prsWithRef / totalPRs) * 100 : null;

  // Review-finding issues (carry label "review-finding")
  const reviewFindings = issues.filter((i) =>
    (i.labels || []).some((l) => l.name === "review-finding"),
  ).length;

  // Invalid issues (carry label "workflow:invalid")
  const invalidIssues = issues.filter((i) =>
    (i.labels || []).some((l) => l.name === "workflow:invalid"),
  ).length;

  // Machine-filed (author is bot/app)
  const machineFiled = issues.filter((i) =>
    isBot(i.author?.login || ""),
  ).length;
  const machineShare =
    totalIssues > 0 ? (machineFiled / totalIssues) * 100 : null;

  return {
    days,
    since,
    until,
    totalIssues,
    totalPRs,
    withTrajectory,
    withInvestigator,
    closeTimes,
    medianClose,
    p90Close,
    prsWithRef,
    prRefRate,
    reviewFindings,
    invalidIssues,
    machineFiled,
    machineShare,
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Render stats as a terminal-friendly string.
 */
export function renderTerminal(stats, repo) {
  const hasHistory = stats.totalIssues > 0 || stats.totalPRs > 0;
  const lines = [];

  lines.push(`\nForgeDock pipeline impact — ${repo} — last ${stats.days} days`);
  lines.push(`Window: ${stats.since} → ${stats.until}\n`);

  if (!hasHistory) {
    lines.push(
      "  No ForgeDock activity found in this window.\n" +
        "  Run /work-on on your first issue to start tracking pipeline impact.\n",
    );
    return lines.join("\n");
  }

  lines.push(`  Issues closed:       ${stats.totalIssues}`);
  lines.push(
    `  Pipeline-driven:     ${stats.withTrajectory} (FORGE:TRAJECTORY)`,
  );
  lines.push(
    `  Investigated:        ${stats.withInvestigator} (FORGE:INVESTIGATOR)`,
  );
  lines.push(`  Median close time:   ${fmtMinutes(stats.medianClose)}`);
  lines.push(`  p90 close time:      ${fmtMinutes(stats.p90Close)}`);
  lines.push("");
  lines.push(`  PRs merged:          ${stats.totalPRs}`);
  lines.push(
    `  PRs referencing issue: ${stats.prsWithRef} (${fmtPct(stats.prRefRate)})`,
  );
  lines.push("");
  lines.push(`  Review-finding issues: ${stats.reviewFindings}`);
  lines.push(`  Invalid/discarded:   ${stats.invalidIssues}`);
  lines.push("");
  lines.push(
    `  Machine-filed issues: ~${stats.machineFiled} (~${fmtPct(stats.machineShare)})`,
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Render stats as a Markdown block suitable for GitHub comments or standups.
 */
export function renderMarkdown(stats, repo, { quiet = false } = {}) {
  const hasHistory = stats.totalIssues > 0 || stats.totalPRs > 0;
  const lines = [];

  lines.push(
    `## ForgeDock pipeline impact — \`${repo}\` — last ${stats.days} days`,
  );
  lines.push(`_Window: ${stats.since} → ${stats.until}_\n`);

  if (!hasHistory) {
    lines.push(
      "> No ForgeDock activity found in this window.\n" +
        "> Run `/work-on` on your first issue to start tracking pipeline impact.\n",
    );
    return lines.join("\n");
  }

  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Issues closed | **${stats.totalIssues}** |`);
  lines.push(`| Pipeline-driven (FORGE:TRAJECTORY) | ${stats.withTrajectory} |`);
  lines.push(`| Investigated (FORGE:INVESTIGATOR) | ${stats.withInvestigator} |`);
  lines.push(`| Median close time | ${fmtMinutes(stats.medianClose)} |`);
  lines.push(`| p90 close time | ${fmtMinutes(stats.p90Close)} |`);
  lines.push(`| PRs merged | **${stats.totalPRs}** |`);
  lines.push(
    `| PRs referencing issue | ${stats.prsWithRef} (${fmtPct(stats.prRefRate)}) |`,
  );
  lines.push(`| Review-finding issues | ${stats.reviewFindings} |`);
  lines.push(`| Invalid/discarded | ${stats.invalidIssues} |`);
  lines.push(
    `| Machine-filed issues | ~${stats.machineFiled} (~${fmtPct(stats.machineShare)}) |`,
  );
  lines.push("");

  if (!quiet) {
    lines.push(
      "_Need org-wide, cross-repo dashboards? See [ForgeDock for teams](https://forgedock.com/for-companies)._",
    );
  }

  return lines.join("\n");
}

/**
 * Render stats as JSON.
 */
export function renderJson(stats, repo) {
  return JSON.stringify({ repo, ...stats }, null, 2);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the report command.
 *
 * @param {string[]} args  - CLI args (everything after "report")
 * @param {Object}   ctx   - Context object with stdout/stderr (like forgedock.mjs ctx())
 * @returns {number} exit code
 */
export async function runReport(args, ctx) {
  const out = ctx?.stdout ?? process.stdout;
  const err = ctx?.stderr ?? process.stderr;

  // Parse flags
  let days = 30;
  let outputMd = false;
  let outputJson = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--days" && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (isNaN(n) || n < 1) {
        err.write("ERROR: --days must be a positive integer.\n");
        return 1;
      }
      days = n;
    } else if (arg === "--md") {
      outputMd = true;
    } else if (arg === "--json") {
      outputJson = true;
    } else if (arg === "--quiet") {
      quiet = true;
    }
  }

  // Resolve forge.yaml
  const cwd = ctx?.cwd ?? process.cwd();
  const forgeYamlPath = join(cwd, "forge.yaml");

  if (!existsSync(forgeYamlPath)) {
    err.write(
      "ERROR: forge.yaml not found in the current directory.\n" +
        "  Fix: run `npx forgedock init` to generate one.\n" +
        "  See: docs/site/troubleshooting.md#1-forgeyaml-not-found\n",
    );
    return 1;
  }

  let config;
  try {
    const raw = readFileSync(forgeYamlPath, "utf-8");
    config = parseForgeYaml(raw);
  } catch (e) {
    err.write(`ERROR: Could not parse forge.yaml: ${e.message}\n`);
    return 1;
  }

  const owner = config?.project?.owner;
  const repo = config?.project?.repo;
  if (!owner || !repo) {
    err.write(
      "ERROR: forge.yaml is missing project.owner or project.repo.\n" +
        "  Fix: run `npx forgedock init` to regenerate forge.yaml.\n",
    );
    return 1;
  }
  const ghRepo = `${owner}/${repo}`;

  // Check gh auth
  try {
    execFileSync("gh", ["auth", "status"], { encoding: "utf-8", stdio: "pipe" });
  } catch {
    err.write(
      "ERROR: gh CLI is not authenticated.\n" +
        "  Fix: run `gh auth login` (ensure repo scope), then `gh auth status` to confirm.\n" +
        "  See: docs/site/troubleshooting.md#3-gh-cli-not-authenticated\n",
    );
    return 1;
  }

  // Build window
  const until = new Date();
  const since = new Date(until);
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = until.toISOString().slice(0, 10);

  // Fetch data
  let issues, prs;
  try {
    issues = fetchClosedIssues(ghRepo, sinceStr, untilStr);
  } catch (e) {
    err.write(`ERROR: Failed to fetch issues from GitHub: ${e.message}\n`);
    return 1;
  }
  try {
    prs = fetchMergedPRs(ghRepo, sinceStr, untilStr);
  } catch (e) {
    err.write(`ERROR: Failed to fetch PRs from GitHub: ${e.message}\n`);
    return 1;
  }

  const stats = computeStats(issues, prs, {
    since: sinceStr,
    until: untilStr,
    days,
  });

  // Render
  let output;
  if (outputJson) {
    output = renderJson(stats, ghRepo);
  } else if (outputMd) {
    output = renderMarkdown(stats, ghRepo, { quiet });
  } else {
    output = renderTerminal(stats, ghRepo);
  }

  out.write(output + "\n");
  return 0;
}

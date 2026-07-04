// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bin/report.mjs — ForgeDock pipeline impact report
 *
 * Computes a 30-day (default) summary of pipeline-driven activity for a
 * forge-managed repo:
 *   - Issues closed and share with FORGE annotations
 *   - Median and p90 open→close time
 *   - Merged PR count and share with Closes/Fixes/Resolves cross-references
 *   - review-finding and workflow:invalid issue counts
 *   - Machine-filed intent share (bot/app authored issues)
 *
 * Usage:
 *   npx forgedock report [--days 30] [--md] [--json] [--quiet]
 *
 * Flags:
 *   --days N    Look-back window in days (default: 30)
 *   --md        Emit paste-ready Markdown block instead of terminal summary
 *   --json      Emit raw JSON for scripting (supersedes --md)
 *   --quiet     Suppress the optional ForgeDock fleet pointer in --md output
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Colours (copied from tui.mjs to keep this module self-contained)
// ---------------------------------------------------------------------------
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const dim = (s) => `${DIM}${s}${RESET}`;
const bold = (s) => `${BOLD}${s}${RESET}`;
const green = (s) => `${GREEN}${s}${RESET}`;
const cyan = (s) => `${CYAN}${s}${RESET}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a gh command and return parsed JSON, or null on failure.
 */
function ghJson(cmd) {
  try {
    const out = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

/**
 * Read and parse forge.yaml from cwd, returning the project section.
 * Returns null if not found or unparseable.
 */
function readForgeYaml(cwd) {
  const candidates = [join(cwd, "forge.yaml"), join(cwd, ".forge.yaml")];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        // Minimal inline parser — avoids external deps
        const raw = readFileSync(p, "utf-8");
        const result = {};
        let currentSection = null;
        for (const line of raw.split(/\r?\n/)) {
          if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
          const sectionMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(?:#.*)?$/);
          if (sectionMatch) { currentSection = sectionMatch[1]; result[currentSection] = {}; continue; }
          const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s+"([^"]*)"(?:\s*#.*)?$|^([a-zA-Z_][a-zA-Z0-9_]*):\s+([^#\n]+?)(?:\s*#.*)?$/);
          if (topMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
            const key = topMatch[1] ?? topMatch[3];
            const value = topMatch[2] ?? topMatch[4]?.trim();
            if (key && value !== undefined) { currentSection = null; result[key] = value; }
            continue;
          }
          if (currentSection && /^\s+/.test(line)) {
            const nestedMatch = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s+"([^"]*)"(?:\s*#.*)?$|^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s+([^#\n]+?)(?:\s*#.*)?$/);
            if (nestedMatch) {
              const key = nestedMatch[1] ?? nestedMatch[3];
              const value = nestedMatch[2] ?? nestedMatch[4]?.trim();
              if (key && value !== undefined && typeof result[currentSection] === "object") {
                result[currentSection][key] = value;
              }
            }
          }
        }
        return result;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Compute median of a sorted numeric array.
 */
function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute p90 of a sorted numeric array.
 */
function p90(sorted) {
  if (!sorted.length) return null;
  const idx = Math.ceil(sorted.length * 0.9) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Format minutes as a human-readable duration.
 */
function fmtMinutes(mins) {
  if (mins === null || mins === undefined) return "n/a";
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/**
 * Check whether gh is authenticated.
 */
function isGhAuthenticated() {
  try {
    execSync("gh auth status", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main report computation
// ---------------------------------------------------------------------------

/**
 * Fetch and compute all stats for the given repo and window.
 * Returns a structured result object. Throws on hard failures.
 */
async function computeStats({ owner, repo, days }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const ghRepo = `${owner}/${repo}`;
  const repoFlag = `-R ${ghRepo}`;

  // ---- Closed issues in window ----
  const closedIssues = ghJson(
    `gh issue list ${repoFlag} --state closed --limit 500 --json number,title,body,labels,createdAt,closedAt,author`
  ) ?? [];

  const windowIssues = closedIssues.filter((i) => i.closedAt && i.closedAt >= since);

  // Annotated issues (contain FORGE:INVESTIGATOR or FORGE:TRAJECTORY)
  const annotatedCount = windowIssues.filter(
    (i) => (i.body && (i.body.includes("FORGE:INVESTIGATOR") || i.body.includes("FORGE:TRAJECTORY")))
  ).length;

  // Time-to-close in minutes
  const ttcMinutes = windowIssues
    .filter((i) => i.createdAt && i.closedAt)
    .map((i) => (new Date(i.closedAt) - new Date(i.createdAt)) / 60000)
    .filter((m) => m >= 0)
    .sort((a, b) => a - b);

  const medianTtc = median(ttcMinutes);
  const p90Ttc = p90(ttcMinutes);

  // Machine-filed issues (bot/app authors)
  const machineFiled = windowIssues.filter((i) => {
    const t = (i.author?.type || "").toLowerCase();
    return t === "bot" || t === "app" || (i.author?.login || "").endsWith("[bot]");
  }).length;

  // workflow:invalid issues
  const invalidCount = windowIssues.filter((i) =>
    (i.labels || []).some((l) => l.name === "workflow:invalid")
  ).length;

  // review-finding issues
  const reviewFindingCount = windowIssues.filter((i) =>
    (i.labels || []).some((l) => l.name === "review-finding")
  ).length;

  // ---- Merged PRs in window ----
  const mergedPRs = ghJson(
    `gh pr list ${repoFlag} --state merged --limit 500 --json number,title,body,mergedAt`
  ) ?? [];

  const windowPRs = mergedPRs.filter((p) => p.mergedAt && p.mergedAt >= since);

  // PRs that reference an issue (Closes/Fixes/Resolves #N)
  const linkedPRs = windowPRs.filter((p) =>
    p.body && /(?:closes?|fixes?|resolves?)\s+#\d+/i.test(p.body)
  ).length;

  // Check if counts are approximate (search-indexed — flag if limit was hit)
  const issueApprox = closedIssues.length >= 500;
  const prApprox = mergedPRs.length >= 500;

  return {
    repo: ghRepo,
    days,
    since,
    issues: {
      closed: windowIssues.length,
      approx: issueApprox,
      annotated: annotatedCount,
      annotatedPct: windowIssues.length
        ? Math.round((annotatedCount / windowIssues.length) * 100)
        : 0,
      medianTtc,
      p90Ttc,
      machineFiled,
      machineFiledPct: windowIssues.length
        ? Math.round((machineFiled / windowIssues.length) * 100)
        : 0,
      invalid: invalidCount,
      reviewFindings: reviewFindingCount,
    },
    prs: {
      merged: windowPRs.length,
      approx: prApprox,
      linked: linkedPRs,
      linkedPct: windowPRs.length
        ? Math.round((linkedPRs / windowPRs.length) * 100)
        : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Output renderers
// ---------------------------------------------------------------------------

function renderTerminal(stats) {
  const { repo, days, issues, prs } = stats;
  const approxIssue = issues.approx ? "~" : "";
  const approxPr = prs.approx ? "~" : "";

  const lines = [
    "",
    bold(`  ForgeDock Pipeline Impact Report`),
    dim(`  ${repo} · last ${days} days`),
    "",
    bold("  Issues"),
    `    Closed:           ${green(approxIssue + issues.closed)}`,
    `    Pipeline-driven:  ${approxIssue}${issues.annotated} (${issues.annotatedPct}% carry FORGE annotations)`,
    `    Median time:      ${fmtMinutes(issues.medianTtc)}`,
    `    p90 time:         ${fmtMinutes(issues.p90Ttc)}`,
    `    Machine-filed:    ${issues.machineFiled} (${issues.machineFiledPct}%)`,
    `    Review findings:  ${issues.reviewFindings}`,
    `    Invalid/discarded:${issues.invalid}`,
    "",
    bold("  Pull Requests"),
    `    Merged:           ${green(approxPr + prs.merged)}`,
    `    Linked to issue:  ${approxPr}${prs.linked} (${prs.linkedPct}%)`,
    "",
  ];

  return lines.join("\n");
}

function renderMarkdown(stats, quiet) {
  const { repo, days, issues, prs } = stats;
  const approxIssue = issues.approx ? "~" : "";
  const approxPr = prs.approx ? "~" : "";

  const lines = [
    `## ForgeDock Pipeline Impact — last ${days} days`,
    ``,
    `**Repo:** \`${repo}\``,
    ``,
    `### Issues`,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Closed | ${approxIssue}${issues.closed} |`,
    `| Pipeline-driven (FORGE annotations) | ${approxIssue}${issues.annotated} (${issues.annotatedPct}%) |`,
    `| Median open→close | ${fmtMinutes(issues.medianTtc)} |`,
    `| p90 open→close | ${fmtMinutes(issues.p90Ttc)} |`,
    `| Machine-filed intent | ${issues.machineFiled} (${issues.machineFiledPct}%) |`,
    `| Defects caught by review | ${issues.reviewFindings} |`,
    `| Invalid/discarded | ${issues.invalid} |`,
    ``,
    `### Pull Requests`,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Merged | ${approxPr}${prs.merged} |`,
    `| Linked to issue | ${approxPr}${prs.linked} (${prs.linkedPct}%) |`,
    ``,
  ];

  if (!quiet) {
    lines.push(
      `---`,
      `*Generated by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock). Cross-repo fleet view: [forgedock.com/fleet](https://forgedock.com/fleet)*`,
      ``,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runReport(args) {
  // Parse flags
  let days = 30;
  let mdMode = false;
  let jsonMode = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--days" || a === "-d") { days = parseInt(args[++i], 10) || 30; }
    else if (a.startsWith("--days=")) { days = parseInt(a.slice(7), 10) || 30; }
    else if (a === "--md") { mdMode = true; }
    else if (a === "--json") { jsonMode = true; }
    else if (a === "--quiet" || a === "-q") { quiet = true; }
  }

  // Auth check
  if (!isGhAuthenticated()) {
    process.stderr.write(
      `\n  ${RED}Error: gh CLI is not authenticated.${RESET}\n` +
      `  Fix: run ${cyan("gh auth login")} and try again.\n\n`
    );
    process.exit(1);
  }

  // Resolve owner/repo from forge.yaml
  const config = readForgeYaml(process.cwd());
  if (!config || !config.project) {
    process.stderr.write(
      `\n  ${RED}Error: forge.yaml not found or missing project section.${RESET}\n` +
      `  Fix: run ${cyan("npx forgedock init")} to generate it.\n\n`
    );
    process.exit(1);
  }

  const project = config.project;
  const owner = project.owner;
  const repo = project.repo;

  if (!owner || !repo) {
    process.stderr.write(
      `\n  ${RED}Error: forge.yaml is missing project.owner or project.repo.${RESET}\n` +
      `  Fix: run ${cyan("npx forgedock init")} to regenerate it.\n\n`
    );
    process.exit(1);
  }

  // Check for ForgeDock history
  const testCheck = ghJson(`gh issue list -R ${owner}/${repo} --limit 1 --state closed --json number`) ?? [];
  if (!testCheck.length) {
    process.stdout.write(
      `\n  ${YELLOW}No closed issues found in ${owner}/${repo}.${RESET}\n` +
      `  Run ${cyan("/work-on")} on your first issue to start building a pipeline history.\n\n`
    );
    process.exit(0);
  }

  // Compute stats
  let stats;
  try {
    stats = await computeStats({ owner, repo, days });
  } catch (err) {
    process.stderr.write(`\n  ${RED}Error computing stats: ${err.message}${RESET}\n\n`);
    process.exit(1);
  }

  // Output
  if (jsonMode) {
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
  } else if (mdMode) {
    process.stdout.write(renderMarkdown(stats, quiet) + "\n");
  } else {
    process.stdout.write(renderTerminal(stats) + "\n");
  }
}

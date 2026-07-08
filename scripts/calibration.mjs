#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * calibration.mjs — Confidence calibration from run outcomes.
 *
 * Reads the Forge Ledger (knowledge.jsonl) to extract investigation cards
 * (confidence + task type per issue), then queries GitHub to determine whether
 * each merged issue "survived" — i.e., no review-finding or revert landed on
 * the same files within 14 days of merge.
 *
 * Outputs a per-(task-type × confidence) calibration table as JSON.
 * Optionally publishes the table to the `forge-knowledge` orphan branch at
 * `calibration/table.json` for consumption by pipeline-health and review-pr.
 *
 * Outcome definition (spec: forge#1741):
 *   survived = no review-finding (label: review-finding) OR revert PR touching
 *              overlapping files was created within 14 days of merge.
 *   failed   = at least one review-finding or revert PR touching the same files
 *              was created within 14 days of merge.
 *
 * Usage:
 *   node scripts/calibration.mjs [options]
 *
 * Options:
 *   --repo <owner/repo>            GitHub repository (default: reads forge.yaml)
 *   --index <dir>                  Override index directory (default: ~/.forge/index)
 *   --window <days>                Outcome window in days (default: 14)
 *   --min-samples <n>              Minimum samples before trusting a (task-type × confidence) cell (default: 10)
 *   --provenance                   Also build and (when --publish) publish the provenance table
 *                                  (task-type × normalized-modules) to calibration/provenance.json
 *   --provenance-min-samples <n>   Minimum samples before trusting a provenance cell (default: 5)
 *   --publish                      Publish calibration table (and provenance table when --provenance) to forge-knowledge branch
 *   --no-mirror                    Skip orphan branch mirror when --publish is used
 *   --dry-run                      Compute table(s) but do not write any files
 *   --verbose                      Verbose logging
 *   --issue <number>               Compute outcome for a single issue only (debugging)
 *
 * Exit codes:
 *   0  — success
 *   1  — fatal error (cannot read index, invalid args)
 *   2  — partial (some issues failed but table was produced)
 *
 * @module calibration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_DIR = join(homedir(), '.forge', 'index');
const CARDS_FILE = 'knowledge.jsonl';
const CALIBRATION_DIR = 'calibration';
const TABLE_FILE = 'table.json';
const PROVENANCE_FILE = 'provenance.json';
const MIRROR_BRANCH = 'forge-knowledge';
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_MIN_SAMPLES = 10;
const SCHEMA_VERSION = 1;

// Minimum samples before a provenance cell is trusted for intensity decisions.
// Lower than the confidence table default (10) because the module key-space is
// larger and cells accumulate samples more slowly.
const DEFAULT_PROVENANCE_MIN_SAMPLES = 5;

// Survival rate threshold above which a cell is classified as PROVEN (eligible
// for optional-agent de-escalation).
const PROVENANCE_PROVEN_THRESHOLD = 0.90;

// Survival rate floor below which a NOVEL-tier cell is marked for needs-human.
// Below this threshold the cell has not accumulated enough evidence to trust.
const PROVENANCE_NOVEL_NEEDS_HUMAN_THRESHOLD = 0.70;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const args = {
    repo: null,
    indexDir: DEFAULT_INDEX_DIR,
    windowDays: DEFAULT_WINDOW_DAYS,
    minSamples: DEFAULT_MIN_SAMPLES,
    provenanceMinSamples: DEFAULT_PROVENANCE_MIN_SAMPLES,
    publish: false,
    provenance: false,
    noMirror: false,
    dryRun: false,
    verbose: false,
    issue: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) { args.repo = argv[++i]; }
    else if (arg === '--index' && argv[i + 1]) { args.indexDir = resolve(argv[++i]); }
    else if (arg === '--window' && argv[i + 1]) { args.windowDays = parseInt(argv[++i], 10); }
    else if (arg === '--min-samples' && argv[i + 1]) { args.minSamples = parseInt(argv[++i], 10); }
    else if (arg === '--provenance-min-samples' && argv[i + 1]) { args.provenanceMinSamples = parseInt(argv[++i], 10); }
    else if (arg === '--publish') { args.publish = true; }
    else if (arg === '--provenance') { args.provenance = true; }
    else if (arg === '--no-mirror') { args.noMirror = true; }
    else if (arg === '--dry-run') { args.dryRun = true; }
    else if (arg === '--verbose') { args.verbose = true; }
    else if (arg === '--issue' && argv[i + 1]) { args.issue = parseInt(argv[++i], 10); }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

let _verbose = false;

function log(msg) { process.stderr.write(`[calibration] ${msg}\n`); }
function debug(msg) { if (_verbose) log(msg); }

/**
 * Read forge.yaml to extract repo name.
 * @param {string} repoPath - path to repo root
 * @returns {string|null} repo name (owner/repo) or null
 */
export function readForgeYaml(repoPath) {
  const configPath = join(repoPath, 'forge.yaml');
  if (!existsSync(configPath)) return null;
  try {
    const result = spawnSync('yq', ['-r', '.project.owner + "/" + .project.repo', configPath], {
      encoding: 'utf8', timeout: 5000,
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Call the gh CLI and return parsed JSON, or throw on error.
 * @param {string} apiPath
 * @param {string[]} flags
 * @returns {string} raw stdout
 */
export function ghApi(apiPath, flags = []) {
  const result = spawnSync('gh', ['api', apiPath, ...flags], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${apiPath} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

/**
 * Read a JSONL file and return array of parsed objects.
 * @param {string} filePath
 * @returns {object[]}
 */
export function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch (_) {
      debug(`Skipping malformed JSONL line: ${trimmed.slice(0, 80)}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/**
 * Compute the date that is `days` days after a given ISO date string.
 * @param {string} isoDate
 * @param {number} days
 * @returns {Date}
 */
export function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Check whether two sets of file paths have any overlap.
 * Comparison is case-insensitive and strips leading slashes.
 * @param {string[]} filesA
 * @param {string[]} filesB
 * @returns {boolean}
 */
export function hasFileOverlap(filesA, filesB) {
  if (!filesA || !filesB || filesA.length === 0 || filesB.length === 0) return false;
  const normalize = (f) => f.replace(/^\/+/, '').toLowerCase();
  const setA = new Set(filesA.map(normalize));
  for (const f of filesB) {
    if (setA.has(normalize(f))) return true;
  }
  return false;
}

/**
 * Check if a date string falls within the outcome window.
 * @param {string} dateStr - ISO date string of the candidate event
 * @param {string} mergedAt - ISO date string of the merge
 * @param {number} windowDays - outcome window in days
 * @returns {boolean} true if dateStr is after mergedAt AND within windowDays
 */
export function isWithinWindow(dateStr, mergedAt, windowDays) {
  if (!dateStr || !mergedAt) return false;
  const eventDate = new Date(dateStr);
  const mergeDate = new Date(mergedAt);
  const windowEnd = addDays(mergedAt, windowDays);
  return eventDate > mergeDate && eventDate <= windowEnd;
}

/**
 * Classify a single run as survived or failed.
 *
 * Queries GitHub for:
 * 1. Review-finding issues whose files overlap with the run's files AND
 *    created_at is within windowDays of the run's merge date.
 * 2. PRs with "revert" in the title that touch overlapping files AND
 *    created_at is within windowDays of the merge date.
 *
 * @param {object} params
 * @param {number} params.issueNumber
 * @param {string} params.mergedAt - ISO date string
 * @param {string[]} params.files - files changed in the PR
 * @param {string} params.repo - owner/repo
 * @param {number} params.windowDays
 * @returns {{ outcome: 'survived' | 'failed', reason: string }}
 */
export function classifyOutcome({ issueNumber, mergedAt, files, repo, windowDays }) {
  if (!mergedAt) {
    return { outcome: 'survived', reason: 'no merge date — treated as survived (no outcome data)' };
  }

  const windowEnd = addDays(mergedAt, windowDays);
  const windowEndStr = windowEnd.toISOString().slice(0, 10);
  debug(`Issue #${issueNumber}: checking outcome window ${mergedAt} → ${windowEndStr} (${windowDays} days)`);

  // Check review-finding issues created in the window
  try {
    const raw = ghApi(
      `repos/${repo}/issues?labels=review-finding&state=all&since=${encodeURIComponent(mergedAt)}&per_page=100`
    );
    const reviewFindings = JSON.parse(raw);
    for (const rf of reviewFindings) {
      if (!isWithinWindow(rf.created_at, mergedAt, windowDays)) continue;
      // Fetch PR files to check overlap
      // review-finding issues reference the source PR in their title or body
      const prMatch = (rf.body || rf.title || '').match(/PR #?(\d+)|pull\/(\d+)/i);
      if (prMatch) {
        const prNum = prMatch[1] || prMatch[2];
        try {
          const prFilesRaw = ghApi(`repos/${repo}/pulls/${prNum}/files?per_page=100`);
          const prFiles = JSON.parse(prFilesRaw).map(f => f.filename);
          if (hasFileOverlap(files, prFiles)) {
            return {
              outcome: 'failed',
              reason: `review-finding #${rf.number} created within ${windowDays} days with overlapping files (PR #${prNum})`
            };
          }
        } catch (_) {
          // If we can't get PR files, fall back to checking body for file mentions
          if (files.some(f => (rf.body || '').includes(f))) {
            return {
              outcome: 'failed',
              reason: `review-finding #${rf.number} created within ${windowDays} days (file match via body)`
            };
          }
        }
      } else {
        // No PR reference — check if any of our files are mentioned in the finding body
        if (files.some(f => (rf.body || rf.title || '').includes(f.split('/').pop()))) {
          return {
            outcome: 'failed',
            reason: `review-finding #${rf.number} created within ${windowDays} days (file basename match)`
          };
        }
      }
    }
  } catch (e) {
    debug(`Issue #${issueNumber}: review-finding check failed: ${e.message}`);
  }

  // Check revert PRs created in the window
  try {
    const raw = ghApi(
      `repos/${repo}/pulls?state=all&per_page=50&sort=created&direction=desc`
    );
    const prs = JSON.parse(raw);
    for (const pr of prs) {
      if (!pr.title.toLowerCase().includes('revert')) continue;
      if (!isWithinWindow(pr.created_at, mergedAt, windowDays)) continue;
      try {
        const prFilesRaw = ghApi(`repos/${repo}/pulls/${pr.number}/files?per_page=100`);
        const prFiles = JSON.parse(prFilesRaw).map(f => f.filename);
        if (hasFileOverlap(files, prFiles)) {
          return {
            outcome: 'failed',
            reason: `revert PR #${pr.number} ("${pr.title}") created within ${windowDays} days with overlapping files`
          };
        }
      } catch (_) {
        debug(`Issue #${issueNumber}: could not fetch files for revert PR #${pr.number}`);
      }
    }
  } catch (e) {
    debug(`Issue #${issueNumber}: revert PR check failed: ${e.message}`);
  }

  return { outcome: 'survived', reason: 'no review-finding or revert with overlapping files in window' };
}

// ---------------------------------------------------------------------------
// Table building
// ---------------------------------------------------------------------------

/**
 * Build a per-(task-type × confidence) calibration table from run records.
 *
 * @param {object[]} runs - array of { issueNumber, taskType, confidence, outcome }
 * @param {number} minSamples - minimum samples before trusting a cell
 * @returns {object} calibration table
 */
export function buildTable(runs, minSamples = DEFAULT_MIN_SAMPLES) {
  // Accumulate per-cell counts
  const cells = {};  // key: `${taskType}::${confidence}`

  for (const run of runs) {
    const { taskType, confidence, outcome } = run;
    if (!taskType || !confidence || !outcome) continue;
    const key = `${taskType}::${confidence}`;
    if (!cells[key]) {
      cells[key] = { taskType, confidence, survived: 0, failed: 0, total: 0 };
    }
    cells[key].total++;
    if (outcome === 'survived') cells[key].survived++;
    else cells[key].failed++;
  }

  // Build table rows with survival rates and flags
  const rows = Object.values(cells).map(cell => {
    const survivalRate = cell.total > 0 ? cell.survived / cell.total : null;
    const trusted = cell.total >= minSamples;
    let flag = null;

    if (trusted && survivalRate !== null) {
      if (cell.confidence === 'HIGH' && survivalRate < 0.8) {
        flag = 'overconfidence';  // HIGH confidence but poor survival
      } else if (survivalRate > 0.95) {
        flag = 'overcaution-candidate';  // very high survival — needs-human may be unnecessary
      }
    }

    return {
      taskType: cell.taskType,
      confidence: cell.confidence,
      survivalRate: survivalRate !== null ? Math.round(survivalRate * 1000) / 1000 : null,
      survived: cell.survived,
      failed: cell.failed,
      sampleCount: cell.total,
      trusted,
      flag,
    };
  });

  // Sort by task type, then confidence
  rows.sort((a, b) => {
    const tt = a.taskType.localeCompare(b.taskType);
    if (tt !== 0) return tt;
    return a.confidence.localeCompare(b.confidence);
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    computedAt: new Date().toISOString(),
    windowDays: DEFAULT_WINDOW_DAYS,
    minSamples,
    totalRuns: runs.length,
    rows,
  };
}

/**
 * Lookup a calibration table cell for a specific task type and confidence.
 * Returns null if the cell is absent or not trusted (below minSamples).
 *
 * @param {object} table - calibration table from buildTable()
 * @param {string} taskType
 * @param {string} confidence
 * @returns {object|null} table row or null
 */
export function lookupCell(table, taskType, confidence) {
  if (!table || !Array.isArray(table.rows)) return null;
  const row = table.rows.find(
    r => r.taskType === taskType && r.confidence === confidence
  );
  if (!row || !row.trusted) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Provenance table — (task-type × normalized-modules) survival tracking
// ---------------------------------------------------------------------------

/**
 * Normalize a list of changed file paths into a deterministic module-set key.
 *
 * Normalization rules:
 *   1. Extract the top-level directory prefix for each path (e.g. "commands",
 *      "scripts", "services/api").  For paths that start with a well-known
 *      two-level prefix (services/, apps/, packages/, etc.), include the second
 *      directory segment too.
 *   2. Deduplicate.
 *   3. Sort lexicographically.
 *   4. Join with "|".
 *
 * Example:
 *   ["commands/review-pr.md", "commands/work-on.md", "scripts/calibration.mjs"]
 *   → "commands|scripts"
 *
 *   ["services/api/app/routers/billing.py", "services/worker/tasks/send.py"]
 *   → "services/api|services/worker"
 *
 * @param {string[]} files - list of repo-relative file paths
 * @returns {string} normalized module key
 */
export function normalizeModules(files) {
  if (!files || files.length === 0) return '';

  const TWO_LEVEL_PREFIXES = new Set(['services', 'apps', 'packages', 'clients', 'sdk']);

  const prefixes = new Set();
  for (const f of files) {
    // Strip leading slashes
    const clean = f.replace(/^\/+/, '');
    const parts = clean.split('/');
    if (parts.length === 0 || !parts[0]) continue;

    const top = parts[0];
    if (TWO_LEVEL_PREFIXES.has(top) && parts.length >= 2 && parts[1]) {
      prefixes.add(`${top}/${parts[1]}`);
    } else {
      prefixes.add(top);
    }
  }

  return [...prefixes].sort().join('|');
}

/**
 * Build a per-(task-type × normalized-modules) provenance table from run records.
 *
 * Each cell tracks survival rate for a specific (task-type, module-set) pair.
 * The table is published to calibration/provenance.json on the forge-knowledge
 * branch for consumption by review-pr.md Phase 3B.5.
 *
 * @param {object[]} runs - array of { issueNumber, taskType, files, outcome }
 * @param {number} minSamples - minimum samples before trusting a cell
 * @returns {object} provenance table
 */
export function buildProvenanceTable(runs, minSamples = DEFAULT_PROVENANCE_MIN_SAMPLES) {
  const cells = {};  // key: `${taskType}::${normalizedModules}`

  for (const run of runs) {
    const { taskType, files, outcome } = run;
    if (!taskType || !outcome) continue;
    const modules = normalizeModules(files || []);
    if (!modules) continue;

    const key = `${taskType}::${modules}`;
    if (!cells[key]) {
      cells[key] = { taskType, modules, survived: 0, failed: 0, total: 0 };
    }
    cells[key].total++;
    if (outcome === 'survived') cells[key].survived++;
    else cells[key].failed++;
  }

  const rows = Object.entries(cells).map(([key, cell]) => {
    const survivalRate = cell.total > 0 ? cell.survived / cell.total : null;
    const trusted = cell.total >= minSamples;
    let intensityTier = 'NOVEL';  // default: no trusted data → treat as novel

    if (trusted && survivalRate !== null) {
      if (survivalRate >= PROVENANCE_PROVEN_THRESHOLD) {
        intensityTier = 'PROVEN';
      } else if (survivalRate < PROVENANCE_NOVEL_NEEDS_HUMAN_THRESHOLD) {
        intensityTier = 'NOVEL_NEEDS_HUMAN';
      } else {
        intensityTier = 'NOVEL';
      }
    }

    return {
      key,
      taskType: cell.taskType,
      modules: cell.modules,
      survivalRate: survivalRate !== null ? Math.round(survivalRate * 1000) / 1000 : null,
      survived: cell.survived,
      failed: cell.failed,
      sampleCount: cell.total,
      trusted,
      intensityTier,
    };
  });

  rows.sort((a, b) => {
    const tt = a.taskType.localeCompare(b.taskType);
    if (tt !== 0) return tt;
    return a.modules.localeCompare(b.modules);
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    computedAt: new Date().toISOString(),
    windowDays: DEFAULT_WINDOW_DAYS,
    minSamples,
    provenThreshold: PROVENANCE_PROVEN_THRESHOLD,
    totalRuns: runs.length,
    rows,
  };
}

/**
 * Lookup a provenance table cell for a specific task type and module-set key.
 * Returns null if the cell is absent or not trusted (below minSamples).
 *
 * @param {object} table - provenance table from buildProvenanceTable()
 * @param {string} taskType
 * @param {string} modules - normalized module key from normalizeModules()
 * @returns {object|null} table row or null
 */
export function lookupProvenanceCell(table, taskType, modules) {
  if (!table || !Array.isArray(table.rows)) return null;
  const key = `${taskType}::${modules}`;
  const row = table.rows.find(r => r.key === key);
  if (!row || !row.trusted) return null;
  return row;
}

/**
 * Read the provenance table from the forge-knowledge branch (if it exists).
 * Returns null on any error (fail-safe: caller falls back to SHADOW mode).
 *
 * @param {string} repoPath - absolute path to the git repo
 * @returns {object|null} parsed provenance table or null
 */
export function readPublishedProvenanceTable(repoPath) {
  try {
    const result = spawnSync(
      'git',
      ['show', `${MIRROR_BRANCH}:${CALIBRATION_DIR}/${PROVENANCE_FILE}`],
      { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
    );
    if (result.status !== 0) return null;
    return JSON.parse(result.stdout);
  } catch (_) {
    return null;
  }
}

/**
 * Publish the provenance table to the forge-knowledge orphan branch alongside
 * the existing calibration/table.json. Non-blocking: any failure is logged.
 *
 * @param {object} table - provenance table from buildProvenanceTable()
 * @param {string} repoPath - absolute path to the git repo
 * @param {boolean} dryRun
 */
export function publishProvenanceTable(table, repoPath, dryRun = false) {
  if (dryRun) {
    log('--dry-run: skipping provenance table publish to forge-knowledge branch');
    return;
  }

  try {
    const currentBranchResult = spawnSync('git', ['branch', '--show-current'], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000,
    });
    const currentBranch = (currentBranchResult.stdout || '').trim();

    // Ensure the forge-knowledge branch is present (reuse publishTable's checkout logic)
    const branchCheck = spawnSync('git', ['show-ref', '--quiet', `refs/heads/${MIRROR_BRANCH}`], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000,
    });

    if (branchCheck.status !== 0) {
      spawnSync('git', ['fetch', 'origin', `${MIRROR_BRANCH}:${MIRROR_BRANCH}`], {
        cwd: repoPath, encoding: 'utf8', timeout: 30000,
      });
    }

    // Check again after fetch
    const recheckResult = spawnSync('git', ['show-ref', '--quiet', `refs/heads/${MIRROR_BRANCH}`], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000,
    });
    if (recheckResult.status !== 0) {
      log(`WARNING: ${MIRROR_BRANCH} branch not found after fetch — skipping provenance publish`);
      return;
    }

    spawnSync('git', ['checkout', MIRROR_BRANCH], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });

    const calibDir = join(repoPath, CALIBRATION_DIR);
    mkdirSync(calibDir, { recursive: true });

    const provenanceFile = join(calibDir, PROVENANCE_FILE);
    writeFileSync(provenanceFile, JSON.stringify(table, null, 2) + '\n', 'utf8');

    spawnSync('git', ['add', join(CALIBRATION_DIR, PROVENANCE_FILE)], {
      cwd: repoPath, encoding: 'utf8', timeout: 10000,
    });

    const commitResult = spawnSync('git', [
      'commit', '-m', `chore(calibration): update provenance trust table [skip ci]`,
      '--allow-empty',
    ], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });

    if (commitResult.status === 0) {
      const pushResult = spawnSync('git', ['push', 'origin', MIRROR_BRANCH, '--force-with-lease'], {
        cwd: repoPath, encoding: 'utf8', timeout: 30000,
      });
      if (pushResult.status === 0) {
        log(`Published provenance table to ${MIRROR_BRANCH}:${CALIBRATION_DIR}/${PROVENANCE_FILE}`);
      } else {
        log(`WARNING: Push of provenance table to ${MIRROR_BRANCH} failed — ${pushResult.stderr || ''}`);
      }
    } else {
      log(`WARNING: Commit of provenance table to ${MIRROR_BRANCH} failed — ${commitResult.stderr || ''}`);
    }

    if (currentBranch) {
      spawnSync('git', ['checkout', currentBranch], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
    }
  } catch (e) {
    log(`WARNING: publishProvenanceTable to ${MIRROR_BRANCH} failed: ${e.message} — continuing`);
    try {
      spawnSync('git', ['checkout', '-'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 });
    } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Read calibration table from the forge-knowledge branch (if it exists).
 * Returns null on any error (fail-safe: caller falls back to static behavior).
 *
 * @param {string} repoPath - absolute path to the git repo
 * @returns {object|null} parsed table or null
 */
export function readPublishedTable(repoPath) {
  try {
    const result = spawnSync(
      'git',
      ['show', `${MIRROR_BRANCH}:${CALIBRATION_DIR}/${TABLE_FILE}`],
      { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
    );
    if (result.status !== 0) return null;
    return JSON.parse(result.stdout);
  } catch (_) {
    return null;
  }
}

/**
 * Publish the calibration table to the forge-knowledge orphan branch.
 * Non-blocking: any failure is logged and execution continues.
 *
 * @param {object} table - calibration table
 * @param {string} repoPath - absolute path to the git repo
 * @param {boolean} dryRun
 */
export function publishTable(table, repoPath, dryRun = false) {
  if (dryRun) {
    log('--dry-run: skipping publish to forge-knowledge branch');
    return;
  }

  try {
    // Stash current branch name so we can return
    const currentBranchResult = spawnSync('git', ['branch', '--show-current'], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000,
    });
    const currentBranch = (currentBranchResult.stdout || '').trim();

    // Check if forge-knowledge branch exists locally
    const branchCheck = spawnSync('git', ['show-ref', '--quiet', `refs/heads/${MIRROR_BRANCH}`], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000,
    });

    if (branchCheck.status !== 0) {
      // Try to fetch from remote first
      spawnSync('git', ['fetch', 'origin', `${MIRROR_BRANCH}:${MIRROR_BRANCH}`], {
        cwd: repoPath, encoding: 'utf8', timeout: 30000,
      });
      // Re-check
      const recheckResult = spawnSync('git', ['show-ref', '--quiet', `refs/heads/${MIRROR_BRANCH}`], {
        cwd: repoPath, encoding: 'utf8', timeout: 5000,
      });
      if (recheckResult.status !== 0) {
        // Create orphan branch
        const initResult = spawnSync('git', ['checkout', '--orphan', MIRROR_BRANCH], {
          cwd: repoPath, encoding: 'utf8', timeout: 10000,
        });
        if (initResult.status !== 0) {
          log(`WARNING: Could not create ${MIRROR_BRANCH} branch — skipping publish`);
          return;
        }
        // Remove all tracked files from orphan branch working tree
        spawnSync('git', ['rm', '-rf', '--quiet', '.'], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
        // Create directory structure
        mkdirSync(join(repoPath, CALIBRATION_DIR), { recursive: true });
      } else {
        spawnSync('git', ['checkout', MIRROR_BRANCH], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
      }
    } else {
      spawnSync('git', ['checkout', MIRROR_BRANCH], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
    }

    // Ensure calibration directory exists on the branch
    const calibDir = join(repoPath, CALIBRATION_DIR);
    mkdirSync(calibDir, { recursive: true });

    // Write the table file
    const tableFile = join(calibDir, TABLE_FILE);
    writeFileSync(tableFile, JSON.stringify(table, null, 2) + '\n', 'utf8');

    // Stage and commit
    spawnSync('git', ['add', join(CALIBRATION_DIR, TABLE_FILE)], {
      cwd: repoPath, encoding: 'utf8', timeout: 10000,
    });

    const commitResult = spawnSync('git', [
      'commit', '-m', `chore(calibration): update confidence calibration table [skip ci]`,
      '--allow-empty',
    ], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });

    if (commitResult.status === 0) {
      // Push to remote (non-blocking)
      const pushResult = spawnSync('git', ['push', 'origin', MIRROR_BRANCH, '--force-with-lease'], {
        cwd: repoPath, encoding: 'utf8', timeout: 30000,
      });
      if (pushResult.status === 0) {
        log(`Published calibration table to ${MIRROR_BRANCH}:${CALIBRATION_DIR}/${TABLE_FILE}`);
      } else {
        log(`WARNING: Push to ${MIRROR_BRANCH} failed — ${pushResult.stderr || ''}`);
      }
    } else {
      log(`WARNING: Commit to ${MIRROR_BRANCH} failed — ${commitResult.stderr || ''}`);
    }

    // Return to original branch
    if (currentBranch) {
      spawnSync('git', ['checkout', currentBranch], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
    }
  } catch (e) {
    log(`WARNING: publish to ${MIRROR_BRANCH} failed: ${e.message} — continuing`);
    // Non-blocking: attempt to restore branch
    try {
      spawnSync('git', ['checkout', '-'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 });
    } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Main entry point (exported for testing).
 *
 * @param {object} args - parsed CLI args
 * @param {string} repoPath - repo root path (for forge.yaml + git ops)
 * @returns {object} calibration table
 */
export async function run(args, repoPath) {
  _verbose = args.verbose;

  // Resolve repo name
  const repo = args.repo || readForgeYaml(repoPath);
  if (!repo) {
    throw new Error('Cannot determine repo: no --repo flag and forge.yaml not found or missing project.owner/repo');
  }
  log(`Repository: ${repo}`);

  // Read investigation cards from the knowledge index
  const cardsFile = join(args.indexDir, CARDS_FILE);
  if (!existsSync(cardsFile)) {
    throw new Error(
      `Knowledge index not found at ${cardsFile}. Run: node scripts/build-knowledge-index.mjs --repo ${repo}`
    );
  }

  const allCards = readJsonl(cardsFile);
  const investigationCards = allCards.filter(c => c.kind === 'investigation' && c.verdict && c.confidence);
  log(`Loaded ${allCards.length} cards, ${investigationCards.length} investigation cards`);

  // Filter to single issue if requested
  const targetCards = args.issue
    ? investigationCards.filter(c => c.issue === args.issue)
    : investigationCards;

  if (targetCards.length === 0) {
    log('No investigation cards to process — producing empty table');
    const table = buildTable([], args.minSamples);
    return table;
  }

  // For each investigation card, fetch merge date and changed files from GitHub
  const runs = [];
  let errorCount = 0;

  for (const card of targetCards) {
    const issueNumber = card.issue;
    debug(`Processing issue #${issueNumber} (${card.taskType} / ${card.confidence})`);

    let mergedAt = null;
    let changedFiles = [];

    try {
      // Find the merged PR for this issue
      // Try FORGE:DECISION_RECORD first (most reliable)
      const commentsRaw = ghApi(`repos/${repo}/issues/${issueNumber}/comments?per_page=100`);
      const comments = JSON.parse(commentsRaw);
      const gdrComment = comments.find(c => c.body && c.body.includes('FORGE:DECISION_RECORD'));

      if (gdrComment) {
        // Extract merge_commit and pr from GDR JSON
        const jsonMatch = gdrComment.body.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            const gdr = JSON.parse(jsonMatch[1]);
            mergedAt = gdr.merge && gdr.merge.merged_at;
            const prNum = gdr.pr;
            if (prNum) {
              const prFilesRaw = ghApi(`repos/${repo}/pulls/${prNum}/files?per_page=100`);
              changedFiles = JSON.parse(prFilesRaw).map(f => f.filename);
            }
          } catch (_) { /* fall through */ }
        }
      }

      // Fallback: search for a merged PR that references this issue
      if (!mergedAt) {
        const prsRaw = ghApi(
          `repos/${repo}/pulls?state=closed&per_page=50&sort=updated&direction=desc`
        );
        const prs = JSON.parse(prsRaw);
        for (const pr of prs) {
          if (!pr.merged_at) continue;
          const body = pr.body || '';
          if (body.includes(`#${issueNumber}`) || body.includes(`/${issueNumber}`)) {
            mergedAt = pr.merged_at;
            const prFilesRaw = ghApi(`repos/${repo}/pulls/${pr.number}/files?per_page=100`);
            changedFiles = JSON.parse(prFilesRaw).map(f => f.filename);
            break;
          }
        }
      }

      if (!mergedAt) {
        debug(`Issue #${issueNumber}: no merged PR found — skipping outcome classification`);
        continue;
      }

      // Classify outcome
      const { outcome, reason } = classifyOutcome({
        issueNumber,
        mergedAt,
        files: changedFiles,
        repo,
        windowDays: args.windowDays,
      });

      debug(`Issue #${issueNumber}: ${outcome} — ${reason}`);

      runs.push({
        issueNumber,
        taskType: card.taskType,
        confidence: card.confidence,
        verdict: card.verdict,
        outcome,
        reason,
        mergedAt,
        files: changedFiles,
        filesCount: changedFiles.length,
      });

    } catch (e) {
      log(`WARNING: Failed to process issue #${issueNumber}: ${e.message}`);
      errorCount++;
    }
  }

  log(`Processed ${runs.length} runs (${errorCount} errors)`);

  // Build the calibration table (task-type × confidence)
  const table = buildTable(runs, args.minSamples);
  log(`Calibration table: ${table.rows.length} cells from ${table.totalRuns} runs`);

  // Optionally build the provenance table (task-type × normalized-modules)
  let provenanceTable = null;
  if (args.provenance) {
    provenanceTable = buildProvenanceTable(runs, args.provenanceMinSamples);
    log(`Provenance table: ${provenanceTable.rows.length} cells from ${provenanceTable.totalRuns} runs`);
  }

  return { table, provenanceTable, runs, errorCount };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Guard: only run main() when invoked directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv);
  const repoPath = resolve(__dirname, '..');

  run(args, repoPath)
    .then(result => {
      const table = result.table || result;
      const provenanceTable = result.provenanceTable || null;
      const errorCount = result.errorCount || 0;

      if (args.dryRun) {
        // Print calibration table to stdout
        process.stdout.write(JSON.stringify(table, null, 2) + '\n');
        if (provenanceTable) {
          process.stderr.write('[calibration] Provenance table (dry-run):\n');
          process.stderr.write(JSON.stringify(provenanceTable, null, 2) + '\n');
        }
        log('--dry-run complete — no files written');
        process.exit(0);
      }

      if (args.publish) {
        publishTable(table, repoPath, false);
        if (provenanceTable) {
          publishProvenanceTable(provenanceTable, repoPath, false);
        }
      }

      // Always print calibration table to stdout
      process.stdout.write(JSON.stringify(table, null, 2) + '\n');

      process.exit(errorCount > 0 ? 2 : 0);
    })
    .catch(err => {
      process.stderr.write(`[calibration] FATAL: ${err.message}\n`);
      process.exit(1);
    });
}

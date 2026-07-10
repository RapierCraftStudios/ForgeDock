#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * danger-zones.mjs — Forge Ledger danger-zone + co-change matrix builder.
 *
 * Reads ~/.forge/index/knowledge.jsonl (produced by build-knowledge-index.mjs),
 * aggregates per-file finding counts over a 90-day window, then mines git commit
 * history for co-change statistics using an adjacency JSONL format with a
 * monthly ring buffer.
 *
 * Outputs (written to the same index directory as the Forge Ledger):
 *   - ~/.forge/index/danger-zones.json   — per-file risk summary
 *   - ~/.forge/index/cochange.jsonl      — co-change adjacency matrix
 *
 * Storage format (per FORGE:DESIGN_DECISION on issue #1738):
 *   Adjacency JSONL — one line per file, lexicographic key order, partners as map
 *   with monthly ring-buffer counts [month-2, month-1, month-0]:
 *     {"file":"bin/runner.mjs","n":[3,7,6],"partners":{"bin/engine.mjs":[1,3,2]}}
 *
 * Normalization (per FORGE:DESIGN_DECISION addendum on issue #1738):
 *   Neither file ubiquitous (n/N <= 0.2 both):
 *     couple iff c >= 3 and c/min(n(a),n(b)) >= 0.5
 *   Exactly one ubiquitous (n/N > 0.2):
 *     couple iff c >= 3 and c/n(quiet_side) >= 0.75   [directional confidence]
 *   Both ubiquitous:
 *     couple iff c >= 3 and c/n(a) >= 0.75 and c/n(b) >= 0.75
 *
 *   Ubiquitous pairs are INELIGIBLE for verified-independent downgrade.
 *
 * Cold-start safety: matrix MUST NOT downgrade edges for files with n < 5 in window.
 *
 * Declared companions (forge.yaml → companions) are axiomatic edges (confidence 1.0).
 *
 * Usage:
 *   node scripts/danger-zones.mjs [options]
 *
 * Options:
 *   --repo-path <path>    Path to git repo (default: cwd or git root)
 *   --output <dir>        Override index directory (default: ~/.forge/index)
 *   --incremental         Only process new commits since last run (default)
 *   --full-rebuild        Ignore watermark; rebuild entire matrix from 90d history
 *   --query <file>        Query mode: print danger-zone entry for a single file and exit
 *   --verbose             Verbose logging
 *   --dry-run             Parse and print without writing
 *
 * Exit codes: 0 = success, 1 = fatal error
 *
 * @module danger-zones
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_DIR = join(homedir(), '.forge', 'index');
const CARDS_FILE = 'knowledge.jsonl';
const DANGER_ZONES_FILE = 'danger-zones.json';
const COCHANGE_FILE = 'cochange.jsonl';
const COCHANGE_META_FILE = 'cochange-meta.json';

// 90-day window = 3 monthly buckets
const WINDOW_MONTHS = 3;
const WINDOW_DAYS = 90;

// Coupling thresholds (per FORGE:DESIGN_DECISION on #1738)
const SUPPORT_THRESHOLD = 3;         // c(a,b) >= 3
const CONFIDENCE_STANDARD = 0.5;     // c/min(n(a),n(b)) >= 0.5  (neither ubiquitous)
const CONFIDENCE_DIRECTIONAL = 0.75; // c/n(quiet_side) >= 0.75  (one ubiquitous)
const CONFIDENCE_MUTUAL = 0.75;      // c/n >= 0.75 BOTH sides   (both ubiquitous)
const UBIQUITY_THRESHOLD = 0.2;      // n/N > 0.2 → ubiquitous

// Cold-start: matrix lookups only authoritative for files with n >= MIN_CHANGE_COUNT
const MIN_CHANGE_COUNT = 5;

// Finding-count threshold for danger-zone classification
const FINDING_HOT_THRESHOLD = 3;     // >= 3 findings in 90d → HOT-FINDINGS

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[danger-zones] ${msg}\n`);
}

function debug(msg) {
  if (globalThis._VERBOSE) {
    process.stderr.write(`[danger-zones:debug] ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    repoPath: null,
    outputDir: DEFAULT_INDEX_DIR,
    incremental: true,
    fullRebuild: false,
    query: null,
    verbose: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repo-path':
        args.repoPath = argv[++i];
        break;
      case '--output':
        args.outputDir = argv[++i];
        break;
      case '--incremental':
        args.incremental = true;
        args.fullRebuild = false;
        break;
      case '--full-rebuild':
        args.fullRebuild = true;
        args.incremental = false;
        break;
      case '--query':
        args.query = argv[++i];
        break;
      case '--verbose':
        args.verbose = true;
        globalThis._VERBOSE = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        // Ignore unknown flags for forward compatibility
        break;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (_) {
      // Skip malformed lines
    }
  }
  return records;
}

function writeJsonl(filePath, records) {
  writeFileSync(
    filePath,
    records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Monthly ring-buffer helpers
// ---------------------------------------------------------------------------

/**
 * Return the ISO month string (YYYY-MM) for a date offset by `delta` months
 * from today. delta=0 → current month, delta=-1 → previous month, etc.
 */
function isoMonth(delta = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  return d.toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Return the three bucket labels for the 90-day window:
 * [month-2, month-1, month-0]
 */
function windowBuckets() {
  return [isoMonth(-2), isoMonth(-1), isoMonth(0)];
}

/**
 * Return the bucket index (0=oldest, 1=mid, 2=newest) for a date string,
 * or -1 if the date is outside the 90-day window.
 */
function bucketIndex(dateStr) {
  if (!dateStr) return -1;
  const month = dateStr.slice(0, 7); // YYYY-MM
  const buckets = windowBuckets();
  const idx = buckets.indexOf(month);
  return idx; // -1 if not in window
}

/**
 * Sum the values in a 3-element ring-buffer array.
 */
function sumBuckets(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, v) => s + (v || 0), 0);
}

// ---------------------------------------------------------------------------
// Forge YAML companion reader
// ---------------------------------------------------------------------------

function readCompanions(repoPath) {
  const yamlPath = join(repoPath, 'forge.yaml');
  if (!existsSync(yamlPath)) return [];

  const text = readFileSync(yamlPath, 'utf8');
  const companions = [];

  // Parse companions section: list of [file1, file2] pairs
  // YAML format:
  //   companions:
  //     - [package.json, package-lock.json]
  //     - [forge.yaml, forge.yaml.example]
  const companionsMatch = text.match(/^companions:\s*\n((?:[ \t]+-[ \t]+\[.*\]\s*\n?)*)/m);
  if (!companionsMatch) return [];

  const pairsText = companionsMatch[1];
  const pairRe = /\[\s*([^\],]+?)\s*,\s*([^\]]+?)\s*\]/g;
  let m;
  while ((m = pairRe.exec(pairsText)) !== null) {
    const a = m[1].trim();
    const b = m[2].trim();
    if (a && b) {
      // Store in lexicographic order
      companions.push(a < b ? [a, b] : [b, a]);
    }
  }

  return companions;
}

// ---------------------------------------------------------------------------
// Step 1: Build per-file finding stats from knowledge.jsonl
// ---------------------------------------------------------------------------

/**
 * Read knowledge.jsonl and compute per-file finding counts for the 90d window.
 * Returns: Map<string, { findingCount90d, topPatterns, citedIssues, createdAt[] }>
 */
function buildFileFindingStats(cards) {
  const stats = new Map();
  const buckets = windowBuckets();
  const oldestMonth = buckets[0];

  for (const card of cards) {
    // Only count confirmed investigation and pattern cards
    if (card.kind !== 'investigation' && card.kind !== 'pattern') continue;
    if (card.kind === 'investigation' && card.verdict !== 'CONFIRMED' && card.verdict !== 'PARTIAL') continue;

    // Check 90-day window
    const cardMonth = (card.createdAt || '').slice(0, 7);
    if (cardMonth < oldestMonth) continue; // Too old

    const paths = Array.isArray(card.paths) ? card.paths : [];
    for (const filePath of paths) {
      if (!filePath) continue;

      if (!stats.has(filePath)) {
        stats.set(filePath, {
          findingCount90d: 0,
          topPatterns: [],
          citedIssues: new Set(),
          severity: null,
        });
      }

      const entry = stats.get(filePath);
      entry.findingCount90d += 1;
      entry.citedIssues.add(card.issue);

      // Collect pattern descriptions (top 3)
      if (entry.topPatterns.length < 3 && card.pattern) {
        entry.topPatterns.push(card.pattern.slice(0, 120));
      } else if (entry.topPatterns.length < 3 && card.rootCause) {
        entry.topPatterns.push(card.rootCause.slice(0, 120));
      }

      // Track highest severity seen for this file
      const SEV_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
      const sev = card.severity || 'LOW';
      if (!entry.severity || (SEV_ORDER[sev] || 0) > (SEV_ORDER[entry.severity] || 0)) {
        entry.severity = sev;
      }
    }
  }

  // Convert Sets to arrays for serialization
  const result = new Map();
  for (const [file, entry] of stats) {
    result.set(file, {
      findingCount90d: entry.findingCount90d,
      topPatterns: entry.topPatterns,
      citedIssues: [...entry.citedIssues].sort((a, b) => b - a).slice(0, 10),
      maxSeverity: entry.severity || 'LOW',
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 2: Build co-change matrix from git history
// ---------------------------------------------------------------------------

/**
 * Run git log over the 90-day window and collect per-commit file lists.
 * Returns: Array<{ month: string, files: string[] }>
 */
function collectCommits(repoPath, sinceDate) {
  const since = sinceDate || `${WINDOW_DAYS} days ago`;

  // --name-only: list files changed per commit
  // --pretty=format:COMMIT %H %ai: commit hash + author date (ISO)
  // No pathspec = full repo scan for matrix building (this is intentional —
  // we need the global commit stream to compute n(a) and N correctly)
  // spawnSync with an argument array avoids shell interpolation of repoPath
  // (operator/env-controlled input) — see #1842.
  const result = spawnSync(
    'git',
    ['-C', repoPath, 'log', '--name-only', `--since=${since}`, '--pretty=format:COMMIT %H %ai'],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 60000 },
  );

  if (result.error || result.status !== 0) {
    const reason = result.error
      ? result.error.message
      : `exit code ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`;
    log(`WARNING: git log failed — ${reason}`);
    return [];
  }

  const gitOutput = result.stdout;

  const commits = [];
  let current = null;

  for (const rawLine of gitOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (current && current.files.length > 0) {
        commits.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith('COMMIT ')) {
      if (current && current.files.length > 0) {
        commits.push(current);
      }
      // Parse: COMMIT <hash> <ISO date>
      const parts = line.split(' ');
      const dateStr = parts[2] || ''; // YYYY-MM-DD...
      current = { month: dateStr.slice(0, 7), files: [] };
    } else if (current) {
      // File path line — skip deleted files (no longer exist) or binary markers
      if (!line.startsWith('Binary') && line.length > 0) {
        current.files.push(line);
      }
    }
  }

  if (current && current.files.length > 0) {
    commits.push(current);
  }

  debug(`Collected ${commits.length} commits from git log`);
  return commits;
}

/**
 * Build the adjacency map from commits.
 *
 * adjacency: Map<lexKey, { fileA, fileB, n_a: [b0,b1,b2], n_b: [b0,b1,b2], c: [b0,b1,b2] }>
 * fileCounts: Map<file, [b0,b1,b2]>
 * totalCommits: [b0,b1,b2]  — total commits per bucket
 */
function buildAdjacency(commits) {
  const buckets = windowBuckets();
  const fileCounts = new Map();   // file → [b0, b1, b2]
  const pairCounts = new Map();   // 'fileA\0fileB' → [b0, b1, b2]
  const totalCommits = [0, 0, 0];

  for (const { month, files } of commits) {
    const bIdx = buckets.indexOf(month);
    if (bIdx < 0) continue; // Outside window — should not happen since git --since filters

    totalCommits[bIdx] += 1;

    // Update per-file counts
    const uniqueFiles = [...new Set(files)];
    for (const f of uniqueFiles) {
      if (!fileCounts.has(f)) fileCounts.set(f, [0, 0, 0]);
      fileCounts.get(f)[bIdx] += 1;
    }

    // Update pairwise co-occurrence counts (only pairs where both appear in same commit)
    // For N files in a commit, there are N*(N-1)/2 pairs — cap at 50 files per commit
    // to bound the quadratic cost
    const cappedFiles = uniqueFiles.slice(0, 50);
    for (let i = 0; i < cappedFiles.length; i++) {
      for (let j = i + 1; j < cappedFiles.length; j++) {
        const a = cappedFiles[i];
        const b = cappedFiles[j];
        // Lexicographic order — always store (smaller, larger)
        const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
        if (!pairCounts.has(key)) pairCounts.set(key, [0, 0, 0]);
        pairCounts.get(key)[bIdx] += 1;
      }
    }
  }

  return { fileCounts, pairCounts, totalCommits };
}

/**
 * Convert adjacency maps to the JSONL adjacency format.
 * One record per file, partners as a map.
 *
 * {"file":"bin/runner.mjs","n":[3,7,6],"partners":{"bin/engine.mjs":[1,3,2]}}
 */
function buildCochangeRecords(fileCounts, pairCounts) {
  // Build reverse-lookup: file → { partner → [b0,b1,b2] }
  const filePartners = new Map();

  for (const [key, counts] of pairCounts) {
    if (sumBuckets(counts) === 0) continue;
    const sep = key.indexOf('\0');
    const fileA = key.slice(0, sep);
    const fileB = key.slice(sep + 1);

    if (!filePartners.has(fileA)) filePartners.set(fileA, {});
    filePartners.get(fileA)[fileB] = counts;

    if (!filePartners.has(fileB)) filePartners.set(fileB, {});
    filePartners.get(fileB)[fileA] = counts;
  }

  // Build one record per file, sorted lexicographically
  const records = [];
  const allFiles = new Set([...fileCounts.keys(), ...filePartners.keys()]);

  for (const file of [...allFiles].sort()) {
    const n = fileCounts.get(file) || [0, 0, 0];
    const partners = filePartners.get(file) || {};
    records.push({ file, n, partners });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Step 3: Normalization — coupling verdict
// ---------------------------------------------------------------------------

/**
 * Determine if a file pair is coupled, independent, or unknown.
 *
 * Returns: 'coupled' | 'independent' | 'unknown'
 *
 * 'unknown' means insufficient data (n < MIN_CHANGE_COUNT) — matrix must NOT
 * be used to downgrade Layer 2/4 edges in this case.
 */
function couplingVerdict(nA, nB, cAB, totalN) {
  const sumNA = sumBuckets(nA);
  const sumNB = sumBuckets(nB);
  const sumC  = sumBuckets(cAB);

  // Cold-start: insufficient history → unknown
  if (sumNA < MIN_CHANGE_COUNT || sumNB < MIN_CHANGE_COUNT) {
    return 'unknown';
  }

  // Support threshold: must appear together at least 3 times
  if (sumC < SUPPORT_THRESHOLD) {
    // Zero co-occurrences = verified independent (only when n >= MIN_CHANGE_COUNT)
    if (sumC === 0) return 'independent';
    return 'unknown'; // 1-2 co-occurrences: insufficient support
  }

  // Ubiquity classification
  const ubiqA = totalN > 0 && (sumNA / totalN) > UBIQUITY_THRESHOLD;
  const ubiqB = totalN > 0 && (sumNB / totalN) > UBIQUITY_THRESHOLD;

  if (!ubiqA && !ubiqB) {
    // Standard case: c/min(n(a),n(b)) >= 0.5
    const conf = sumC / Math.min(sumNA, sumNB);
    return conf >= CONFIDENCE_STANDARD ? 'coupled' : 'unknown';
  }

  if (ubiqA && ubiqB) {
    // Both ubiquitous: require mutual near-determinism
    const confA = sumC / sumNA;
    const confB = sumC / sumNB;
    return (confA >= CONFIDENCE_MUTUAL && confB >= CONFIDENCE_MUTUAL) ? 'coupled' : 'unknown';
  }

  // Exactly one ubiquitous: directional confidence from the quiet side
  const quietN = ubiqA ? sumNB : sumNA;
  const conf = sumC / quietN;
  return conf >= CONFIDENCE_DIRECTIONAL ? 'coupled' : 'unknown';
}

/**
 * Returns true if a ubiquity filter applies to this pair (ineligible for
 * verified-independent downgrade, per FORGE:DESIGN_DECISION addendum).
 */
function isUbiquitousPair(nA, nB, totalN) {
  if (totalN === 0) return false;
  const ubiqA = (sumBuckets(nA) / totalN) > UBIQUITY_THRESHOLD;
  const ubiqB = (sumBuckets(nB) / totalN) > UBIQUITY_THRESHOLD;
  return ubiqA || ubiqB;
}

// ---------------------------------------------------------------------------
// Query mode
// ---------------------------------------------------------------------------

/**
 * Print the danger-zone entry and co-change partners for a single file.
 * Used by orchestrate Layer 5 and review-pr CHURN_CONTEXT.
 */
function queryFile(filePath, indexDir, repoPath) {
  const dzPath = join(indexDir, DANGER_ZONES_FILE);
  const ccPath = join(indexDir, COCHANGE_FILE);

  let dz = null;
  let partners = [];

  if (existsSync(dzPath)) {
    try {
      const dzData = JSON.parse(readFileSync(dzPath, 'utf8'));
      dz = dzData.files ? dzData.files[filePath] || null : null;
    } catch (_) {}
  }

  if (existsSync(ccPath)) {
    const records = readJsonl(ccPath);
    // Find record for this file (may be stored as absolute or relative path)
    const rel = repoPath ? relative(repoPath, resolve(filePath)) : filePath;
    const record = records.find(r => r.file === filePath || r.file === rel);
    if (record && record.partners) {
      // Load meta for total commits
      let totalN = 0;
      const metaPath = join(indexDir, COCHANGE_META_FILE);
      if (existsSync(metaPath)) {
        try {
          totalN = JSON.parse(readFileSync(metaPath, 'utf8')).totalCommits || 0;
        } catch (_) {}
      }

      for (const [partner, cCounts] of Object.entries(record.partners)) {
        const partnerRecord = records.find(r => r.file === partner);
        const nB = partnerRecord ? partnerRecord.n : [0, 0, 0];
        const verdict = couplingVerdict(record.n, nB, cCounts, totalN);
        if (verdict !== 'unknown') {
          partners.push({ file: partner, cochange: sumBuckets(cCounts), verdict });
        }
      }
      partners.sort((a, b) => b.cochange - a.cochange);
    }
  }

  const result = {
    file: filePath,
    dangerZone: dz,
    cochangePartners: partners.slice(0, 50),
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  // Resolve repo path
  const repoPath = args.repoPath || (() => {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch (_) {
      return process.cwd();
    }
  })();

  const indexDir = args.outputDir;

  // Query mode — print single-file result and exit
  if (args.query) {
    queryFile(args.query, indexDir, repoPath);
    return;
  }

  // Ensure index directory exists
  if (!args.dryRun) {
    mkdirSync(indexDir, { recursive: true });
  }

  // ------------------------------------------------------------------
  // Step 1: Load knowledge cards and build per-file finding stats
  // ------------------------------------------------------------------

  const cardsPath = join(indexDir, CARDS_FILE);
  if (!existsSync(cardsPath)) {
    log('WARNING: knowledge.jsonl not found — run build-knowledge-index.mjs first');
    log(`Expected path: ${cardsPath}`);
    // Don't exit — we can still build the co-change matrix without the ledger
  }

  const cards = readJsonl(cardsPath);
  log(`Loaded ${cards.length} knowledge cards from ${cardsPath}`);

  const fileFindingStats = buildFileFindingStats(cards);
  log(`Computed finding stats for ${fileFindingStats.size} files`);

  // ------------------------------------------------------------------
  // Step 2: Build co-change matrix from git history
  // ------------------------------------------------------------------

  log(`Mining git history (${WINDOW_DAYS}-day window) for co-change matrix...`);

  // For incremental mode, read the previous total commit count from metadata
  // For full-rebuild, start fresh
  let previousMeta = {};
  const metaPath = join(indexDir, COCHANGE_META_FILE);
  if (!args.fullRebuild && existsSync(metaPath)) {
    try {
      previousMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
      debug(`Loaded previous matrix meta: builtAt=${previousMeta.builtAt}`);
    } catch (_) {}
  }

  // Always scan the full 90-day window to ensure the ring buffer is correct
  // (incremental would need careful bucket rotation logic — simpler to rebuild
  // the 90d window on each run since git log is fast for recent history)
  const commits = collectCommits(repoPath);
  log(`Processed ${commits.length} commits in the 90-day window`);

  const { fileCounts, pairCounts, totalCommits } = buildAdjacency(commits);
  const totalN = sumBuckets(totalCommits);

  log(`Matrix covers ${fileCounts.size} files, ${pairCounts.size} unique pairs, ${totalN} total commits`);

  // Build co-change records
  const cochangeRecords = buildCochangeRecords(fileCounts, pairCounts);

  // ------------------------------------------------------------------
  // Step 3: Apply declared companions (axiomatic edges from forge.yaml)
  // ------------------------------------------------------------------

  const companions = readCompanions(repoPath);
  if (companions.length > 0) {
    log(`Loaded ${companions.length} declared companion pairs from forge.yaml`);
  }

  // We'll store companions in the danger-zones.json metadata (not in cochange.jsonl
  // — companions are axiomatic and bypass the normalization formula)

  // ------------------------------------------------------------------
  // Step 4: Build danger-zones.json
  // ------------------------------------------------------------------

  // Rank files by combined risk: (findingCount90d * 2) + (partnerCount of coupled pairs)
  // This gives finding density priority over co-change connectivity
  const fileRiskMap = new Map();

  for (const [file, stats] of fileFindingStats) {
    fileRiskMap.set(file, {
      findingCount90d: stats.findingCount90d,
      topPatterns: stats.topPatterns,
      citedIssues: stats.citedIssues,
      maxSeverity: stats.maxSeverity,
      hotFindings: stats.findingCount90d >= FINDING_HOT_THRESHOLD,
      coupledPartnerCount: 0,
    });
  }

  // Count coupled partners for each file (for risk scoring)
  for (const record of cochangeRecords) {
    let coupledCount = 0;
    for (const [partner, cCounts] of Object.entries(record.partners || {})) {
      const partnerRecord = cochangeRecords.find(r => r.file === partner);
      const nB = partnerRecord ? partnerRecord.n : [0, 0, 0];
      const verdict = couplingVerdict(record.n, nB, cCounts, totalN);
      if (verdict === 'coupled') coupledCount++;
    }

    if (coupledCount > 0) {
      if (!fileRiskMap.has(record.file)) {
        fileRiskMap.set(record.file, {
          findingCount90d: 0,
          topPatterns: [],
          citedIssues: [],
          maxSeverity: 'LOW',
          hotFindings: false,
          coupledPartnerCount: coupledCount,
        });
      } else {
        fileRiskMap.get(record.file).coupledPartnerCount = coupledCount;
      }
    }
  }

  // Sort files by risk score (descending)
  const rankedFiles = [...fileRiskMap.entries()]
    .map(([file, stats]) => ({
      file,
      riskScore: (stats.findingCount90d * 2) + stats.coupledPartnerCount,
      ...stats,
    }))
    .sort((a, b) => b.riskScore - a.riskScore);

  const dangerZonesData = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    totalFiles: rankedFiles.length,
    findingHotThreshold: FINDING_HOT_THRESHOLD,
    supportThreshold: SUPPORT_THRESHOLD,
    companions: companions.map(([a, b]) => ({ fileA: a, fileB: b })),
    files: Object.fromEntries(rankedFiles.map(({ file, ...rest }) => [file, rest])),
    ranked: rankedFiles.map(r => r.file).slice(0, 50), // Top 50 for quick access
  };

  // ------------------------------------------------------------------
  // Step 5: Write outputs
  // ------------------------------------------------------------------

  if (!args.dryRun) {
    writeFileSync(join(indexDir, DANGER_ZONES_FILE), JSON.stringify(dangerZonesData, null, 2), 'utf8');
    log(`Wrote danger-zones.json (${rankedFiles.length} files)`);

    writeJsonl(join(indexDir, COCHANGE_FILE), cochangeRecords);
    log(`Wrote cochange.jsonl (${cochangeRecords.length} file records)`);

    // Write metadata for incremental runs
    writeFileSync(metaPath, JSON.stringify({
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      totalCommits: totalN,
      totalFiles: fileCounts.size,
      totalPairs: pairCounts.size,
      buckets: windowBuckets(),
    }, null, 2), 'utf8');
    log(`Wrote cochange-meta.json`);
  } else {
    // Dry run: print top 10 danger-zone files
    process.stdout.write('[danger-zones] DRY RUN — top 10 risk files:\n');
    for (const entry of rankedFiles.slice(0, 10)) {
      process.stdout.write(`  ${entry.file}: riskScore=${entry.riskScore} findings=${entry.findingCount90d} coupledPartners=${entry.coupledPartnerCount}\n`);
    }
  }

  const topFiles = rankedFiles.slice(0, 5).map(r => `${r.file} (score=${r.riskScore})`).join(', ');
  log(`Top risk files: ${topFiles || '(none)'}`);
}

main().catch(e => {
  process.stderr.write(`[danger-zones] FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});

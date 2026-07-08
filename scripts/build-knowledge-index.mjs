#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * build-knowledge-index.mjs — Forge Ledger incremental knowledge indexer.
 *
 * Fetches closed GitHub issues since a watermark timestamp, parses FORGE
 * annotations via packages/protocol/src/parse.js, extracts knowledge cards
 * (pattern, investigation, decision), and writes:
 *   - ~/.forge/index/knowledge.jsonl    — card records (one JSON per line)
 *   - ~/.forge/index/postings.json      — BM25-lite inverted index (term → card IDs)
 *   - ~/.forge/index/manifest.json      — issue → content-hash map + watermark
 *   - ~/.forge/index/renames.jsonl      — git rename log entries
 *
 * Also mirrors the index to orphan branch `forge-knowledge` (non-blocking).
 *
 * Card ID scheme: `{issue}/{kind}/{seq}` — provenance-based, never path-based.
 * Paths are attributes maintained by the indexer. Renames are metadata updates.
 *
 * Usage:
 *   node scripts/build-knowledge-index.mjs [options]
 *
 * Options:
 *   --repo <owner/repo>     GitHub repository (default: reads forge.yaml)
 *   --incremental           Only fetch issues updated since watermark (default)
 *   --full-rebuild          Ignore watermark; re-index all closed issues
 *   --issue <number>        Index only a specific issue (for close-phase integration)
 *   --output <dir>          Override index directory (default: ~/.forge/index)
 *   --no-mirror             Skip orphan branch mirror
 *   --dry-run               Parse and output without writing
 *   --verbose               Verbose logging
 *   --with-danger-zones     After indexing, run danger-zones.mjs to refresh risk data (non-blocking)
 *   --pull-feeds            Pull subscribed pattern cards from exchange repos into the local ledger.
 *                           Reads forge.yaml → pattern_feeds. Pinned-ref only — no floating HEAD.
 *                           All imported cards are tagged origin:<feed-slug> and priority:LOW.
 *   --feed <slug>           (with --pull-feeds) Only pull the feed with this slug.
 *
 * Exit codes: 0 = success, 1 = fatal error, 2 = partial (some issues failed)
 *
 * Requires: Node.js >=18, gh CLI authenticated
 *
 * @module build-knowledge-index
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_DIR = join(homedir(), '.forge', 'index');
const CARDS_FILE = 'knowledge.jsonl';
const POSTINGS_FILE = 'postings.json';
const MANIFEST_FILE = 'manifest.json';
const RENAMES_FILE = 'renames.jsonl';
const COST_PRIORS_FILE = 'cost-priors.json'; // economic scheduling — keyed by task_type:module
const MIRROR_BRANCH = 'forge-knowledge';

// Annotation types that produce knowledge cards
const CARD_PRODUCING_TYPES = new Set([
  'INVESTIGATOR',
  'TRAJECTORY',
  'REVIEWER',
  'CONTEXT',
  'ARCHITECT',
  'BUILDER',
]);

// BM25 parameters (per FORGE:DESIGN_DECISION spec)
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    repo: null,
    incremental: true,
    fullRebuild: false,
    issue: null,
    outputDir: DEFAULT_INDEX_DIR,
    noMirror: false,
    dryRun: false,
    verbose: false,
    withDangerZones: false,
    // Pattern exchange subscription pull (forge#1746)
    pullFeeds: false,
    feedFilter: null,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repo':
        args.repo = argv[++i];
        break;
      case '--incremental':
        args.incremental = true;
        args.fullRebuild = false;
        break;
      case '--full-rebuild':
        args.fullRebuild = true;
        args.incremental = false;
        break;
      case '--issue':
        args.issue = parseInt(argv[++i], 10);
        break;
      case '--output':
        args.outputDir = argv[++i];
        break;
      case '--no-mirror':
        args.noMirror = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--with-danger-zones':
        // After indexing completes, run danger-zones.mjs to refresh risk data.
        // Non-blocking: a failure here does not affect the knowledge index.
        args.withDangerZones = true;
        break;
      // Pattern exchange subscription pull (forge#1746)
      case '--pull-feeds':
        args.pullFeeds = true;
        break;
      case '--feed':
        args.feedFilter = argv[++i];
        break;
      default:
        // Ignore unknown flags for forward compatibility
        break;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg, verbose = false) {
  if (!verbose || globalThis._VERBOSE) {
    process.stderr.write(`[ledger] ${msg}\n`);
  }
}

function debug(msg) {
  if (globalThis._VERBOSE) {
    process.stderr.write(`[ledger:debug] ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Forge.yaml reader
// ---------------------------------------------------------------------------

function readForgeYaml(repoPath) {
  const yamlPath = join(repoPath, 'forge.yaml');
  if (!existsSync(yamlPath)) return null;
  try {
    const result = spawnSync('yq', ['-r', '.project.owner + "/" + .project.repo', yamlPath], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch (_) {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Index directory management
// ---------------------------------------------------------------------------

function ensureIndexDir(indexDir) {
  mkdirSync(indexDir, { recursive: true });
}

function readManifest(indexDir) {
  const manifestPath = join(indexDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { watermark: null, issues: {}, schemaVersion: 1 };
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    return { watermark: null, issues: {}, schemaVersion: 1 };
  }
}

function writeManifest(indexDir, manifest) {
  writeFileSync(join(indexDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function ghApi(path, flags = []) {
  const result = spawnSync('gh', ['api', path, ...flags], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${path} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Fetch all closed issues updated since the watermark.
 * Paginates through all pages.
 */
function fetchIssuesSince(repo, since) {
  const issues = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    let url = `repos/${repo}/issues?state=closed&per_page=${perPage}&page=${page}&sort=updated&direction=asc`;
    if (since) {
      url += `&since=${encodeURIComponent(since)}`;
    }

    let raw;
    try {
      raw = ghApi(url);
    } catch (e) {
      log(`WARNING: GitHub API error on page ${page}: ${e.message}`);
      break;
    }

    let batch;
    try {
      batch = JSON.parse(raw);
    } catch (_) {
      break;
    }

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const item of batch) {
      // Filter: only issues (not PRs) — PRs have pull_request field
      if (!item.pull_request) {
        issues.push(item);
      }
    }

    if (batch.length < perPage) break;
    page++;
  }

  return issues;
}

/**
 * Fetch a single issue with its comments.
 */
function fetchIssue(repo, number) {
  let issue;
  try {
    issue = JSON.parse(ghApi(`repos/${repo}/issues/${number}`));
  } catch (e) {
    throw new Error(`Failed to fetch issue #${number}: ${e.message}`);
  }

  let comments = [];
  try {
    const commentsRaw = ghApi(`repos/${repo}/issues/${number}/comments?per_page=100`);
    comments = JSON.parse(commentsRaw);
  } catch (_) {
    // Comments optional
  }

  return { issue, comments };
}

// ---------------------------------------------------------------------------
// Protocol parser (dynamic import to avoid ESM issues with older Node)
// ---------------------------------------------------------------------------

let _parseAnnotation = null;

async function getParser() {
  if (_parseAnnotation) return _parseAnnotation;

  // Resolve the packages/protocol/src/parse.js relative to repo root
  // This script lives at scripts/build-knowledge-index.mjs
  const repoRoot = dirname(__dirname);
  const parsePath = join(repoRoot, 'packages', 'protocol', 'src', 'parse.js');

  try {
    const mod = await import(parsePath);
    _parseAnnotation = mod.parse;
    return _parseAnnotation;
  } catch (e) {
    throw new Error(`Cannot load packages/protocol/src/parse.js: ${e.message}\nEnsure the packages/protocol package is present in the repository.`);
  }
}

// ---------------------------------------------------------------------------
// Card extraction
// ---------------------------------------------------------------------------

/**
 * Extract knowledge cards from a parsed FORGE:INVESTIGATOR annotation.
 *
 * @param {object} annotation - ParsedAnnotation
 * @param {number} issueNumber
 * @param {object} issueData - raw GitHub issue object
 * @returns {Array<object>} cards
 */
function extractInvestigatorCards(annotation, issueNumber, issueData) {
  const cards = [];
  const fields = annotation.fields || {};

  const verdict = fields['Verdict'] || null;
  const confidence = fields['Confidence'] || null;
  const severity = fields['Severity'] || null;
  const taskType = fields['Task Type'] || null;

  // Extract Pattern Metadata blocks from body
  // Pattern blocks appear as: **Pattern**: text, **Root Cause**: text, etc.
  const body = annotation.body || '';

  // Extract root cause section
  const rootCauseMatch = body.match(/### Root Cause\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
  const rootCause = rootCauseMatch ? rootCauseMatch[1].trim().replace(/\n+/g, ' ').slice(0, 400) : null;

  // Extract affected files
  const affectedFilesMatch = body.match(/### Affected Files\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
  const affectedFilesText = affectedFilesMatch ? affectedFilesMatch[1] : '';
  const paths = extractFilePaths(affectedFilesText);

  // Extract prevention/recommendation
  const recommendationMatch = body.match(/### Recommendation\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
  const prevention = recommendationMatch ? recommendationMatch[1].trim().replace(/\n+/g, ' ').slice(0, 400) : null;

  // Extract symbols from History Findings and pickaxe hits
  const symbols = extractSymbols(body);

  if (verdict === 'CONFIRMED' || verdict === 'PARTIAL') {
    const card = {
      schemaVersion: 1,
      id: `${issueNumber}/investigation/0`,
      kind: 'investigation',
      issue: issueNumber,
      pr: null,
      sourceCommentId: null,
      verdict,
      confidence,
      severity,
      taskType,
      rootCause,
      prevention,
      paths,
      symbols,
      anchor: buildAnchor(paths, symbols, issueNumber),
      status: 'fresh',
      outcome: {
        fixMerged: issueData.state === 'closed',
      },
      createdAt: (issueData.updated_at || issueData.created_at || '').slice(0, 10),
    };
    cards.push(card);
  }

  // Extract Pattern Metadata blocks (structured pattern cards)
  const patternBlocks = extractPatternMetadataBlocks(body);
  for (let i = 0; i < patternBlocks.length; i++) {
    const pb = patternBlocks[i];
    const card = {
      schemaVersion: 1,
      id: `${issueNumber}/pattern/${i}`,
      kind: 'pattern',
      issue: issueNumber,
      pr: null,
      sourceCommentId: null,
      pattern: pb.pattern,
      rootCause: pb.rootCause || rootCause,
      prevention: pb.prevention || prevention,
      severity: pb.severity || severity,
      verdict,
      confidence,
      outcome: { fixMerged: issueData.state === 'closed' },
      paths: pb.paths.length > 0 ? pb.paths : paths,
      symbols: pb.symbols.length > 0 ? pb.symbols : symbols,
      anchor: buildAnchor(pb.paths.length > 0 ? pb.paths : paths, pb.symbols.length > 0 ? pb.symbols : symbols, issueNumber),
      status: 'fresh',
      createdAt: (issueData.updated_at || issueData.created_at || '').slice(0, 10),
    };
    cards.push(card);
  }

  return cards;
}

/**
 * Extract knowledge cards from a FORGE:TRAJECTORY annotation.
 */
function extractTrajectoryCards(annotation, issueNumber, issueData) {
  const body = annotation.body || '';

  // Extract decisions from Decisions field
  const decisionsMatch = body.match(/\*\*Decisions\*\*:\s*(.+)/);
  const decisions = decisionsMatch ? decisionsMatch[1].trim() : null;

  if (!decisions || decisions === 'None') return [];

  const card = {
    schemaVersion: 1,
    id: `${issueNumber}/decision/0`,
    kind: 'decision',
    issue: issueNumber,
    pr: null,
    sourceCommentId: null,
    decision: decisions.slice(0, 400),
    anomalies: (body.match(/\*\*Anomalies\*\*:\s*(.+)/) || [])[1]?.trim() || null,
    paths: extractFilePaths(body),
    symbols: extractSymbols(body),
    anchor: buildAnchor(extractFilePaths(body), extractSymbols(body), issueNumber),
    status: 'fresh',
    createdAt: (issueData.updated_at || issueData.created_at || '').slice(0, 10),
  };

  return [card];
}

/**
 * Extract file paths from markdown text.
 * Captures backtick-quoted paths and paths in numbered lists.
 */
function extractFilePaths(text) {
  const paths = new Set();

  // Backtick-quoted paths: `path/to/file.ext`
  const backtickRe = /`([a-zA-Z][^`]*\.[a-zA-Z]{1,6})`/g;
  let m;
  while ((m = backtickRe.exec(text)) !== null) {
    const p = m[1];
    // Filter: must look like a file path (contains / or has extension)
    if (p.includes('/') || /\.[a-zA-Z]{1,6}$/.test(p)) {
      paths.add(p.replace(/^\//, '')); // strip leading slash
    }
  }

  // Numbered list entries: "1. `path/file.py` — ..."
  const listRe = /^\d+\.\s+`([^`]+)`/gm;
  while ((m = listRe.exec(text)) !== null) {
    const p = m[1];
    if (p.includes('/') || /\.[a-zA-Z]{1,6}$/.test(p)) {
      paths.add(p.replace(/^\//, ''));
    }
  }

  return Array.from(paths).slice(0, 20); // cap at 20 paths
}

/**
 * Extract symbol names from text (function names, class names, etc.)
 */
function extractSymbols(text) {
  const symbols = new Set();

  // Bold items often name functions/symbols: **scrubEnv**, **spawnAgent**
  const boldRe = /\*\*([a-zA-Z_][a-zA-Z0-9_]*)\*\*/g;
  let m;
  while ((m = boldRe.exec(text)) !== null) {
    const sym = m[1];
    // Skip common prose words
    if (sym.length >= 3 && !PROSE_WORDS.has(sym.toLowerCase())) {
      symbols.add(sym);
    }
  }

  // Backtick symbols (camelCase or snake_case identifiers without path separators)
  const codeRe = /`([a-zA-Z_][a-zA-Z0-9_]{2,}(?:\(\))?)`/g;
  while ((m = codeRe.exec(text)) !== null) {
    const sym = m[1].replace(/\(\)$/, '');
    if (!sym.includes('/') && !sym.includes('.') && !PROSE_WORDS.has(sym.toLowerCase())) {
      symbols.add(sym);
    }
  }

  return Array.from(symbols).slice(0, 30);
}

const PROSE_WORDS = new Set([
  'the', 'and', 'for', 'not', 'with', 'from', 'that', 'this', 'are', 'was',
  'has', 'have', 'had', 'will', 'can', 'should', 'must', 'may', 'but', 'all',
  'skip', 'note', 'see', 'add', 'run', 'use', 'fix', 'set', 'get', 'new',
  'old', 'any', 'each', 'one', 'two', 'via', 'per', 'its', 'our', 'their',
  'when', 'then', 'else', 'also', 'both', 'only', 'just', 'now', 'here',
  'forge', 'issue', 'phase', 'step', 'file', 'path', 'type', 'name', 'value',
  'none', 'true', 'false', 'null', 'main', 'base', 'head', 'body', 'data',
]);

/**
 * Extract Pattern Metadata blocks from annotation body.
 * These are structured blocks with **Pattern**: / **Root Cause**: / **Prevention**: fields.
 */
function extractPatternMetadataBlocks(body) {
  const blocks = [];

  // Split on "Pattern Metadata" headers or bold Pattern: lines
  const patternRe = /(?:Pattern Metadata|##\s*Pattern)\s*[\n:]+/g;
  const parts = body.split(patternRe);

  for (const part of parts.slice(1)) {
    const patternMatch = part.match(/\*\*Pattern\*\*:\s*(.+)/);
    const rootCauseMatch = part.match(/\*\*Root\s*Cause\*\*:\s*(.+)/);
    const preventionMatch = part.match(/\*\*Prevention\*\*:\s*(.+)/);
    const severityMatch = part.match(/\*\*Severity\*\*:\s*(.+)/);
    const pathsText = (part.match(/\*\*(?:Files?|Paths?)\*\*:\s*([\s\S]*?)(?=\*\*|$)/) || [])[1] || '';
    const symbolsText = (part.match(/\*\*Symbols?\*\*:\s*(.+)/) || [])[1] || '';

    if (patternMatch || rootCauseMatch) {
      blocks.push({
        pattern: (patternMatch?.[1] || '').trim().slice(0, 200),
        rootCause: (rootCauseMatch?.[1] || '').trim().slice(0, 400),
        prevention: (preventionMatch?.[1] || '').trim().slice(0, 400),
        severity: (severityMatch?.[1] || '').trim(),
        paths: extractFilePaths(pathsText),
        symbols: symbolsText ? symbolsText.split(/[,\s]+/).filter(s => s.length >= 2) : [],
      });
    }
  }

  return blocks;
}

/**
 * Build a lightweight anchor for a card.
 * The anchor tracks the primary path and symbol for staleness detection.
 */
function buildAnchor(paths, symbols, issueNumber) {
  if (paths.length === 0 && symbols.length === 0) return null;

  return {
    path: paths[0] || null,
    symbol: symbols[0] || null,
    blobSha: null, // populated during staleness check phase
    snippetHash: null, // populated during staleness check phase
    citedAtIssue: issueNumber,
  };
}

// ---------------------------------------------------------------------------
// Card extraction dispatcher
// ---------------------------------------------------------------------------

async function extractCardsFromIssue(issueNumber, issueData, comments) {
  const parse = await getParser();
  const cards = [];

  const allBodies = [
    issueData.body || '',
    ...comments.map(c => c.body || ''),
  ];

  for (const body of allBodies) {
    if (!body) continue;

    let annotations;
    try {
      annotations = parse(body);
    } catch (_) {
      continue;
    }

    for (const annotation of annotations) {
      if (!CARD_PRODUCING_TYPES.has(annotation.type)) continue;
      if (annotation.sentinelState === 'interrupted') continue; // incomplete

      try {
        switch (annotation.type) {
          case 'INVESTIGATOR': {
            const investigatorCards = extractInvestigatorCards(annotation, issueNumber, issueData);
            cards.push(...investigatorCards);
            break;
          }
          case 'TRAJECTORY': {
            const trajectoryCards = extractTrajectoryCards(annotation, issueNumber, issueData);
            cards.push(...trajectoryCards);
            break;
          }
          // REVIEWER, CONTEXT, ARCHITECT, BUILDER — extract paths/symbols for cross-reference
          default: {
            const paths = extractFilePaths(annotation.body || '');
            const symbols = extractSymbols(annotation.body || '');
            if (paths.length > 0 || symbols.length > 0) {
              // These don't produce first-class cards but enrich path/symbol coverage
              // They are merged into the INVESTIGATOR card paths if one exists
              const existingInvCard = cards.find(c => c.kind === 'investigation' || c.kind === 'pattern');
              if (existingInvCard) {
                const mergedPaths = new Set([...existingInvCard.paths, ...paths]);
                const mergedSymbols = new Set([...existingInvCard.symbols, ...symbols]);
                existingInvCard.paths = Array.from(mergedPaths).slice(0, 20);
                existingInvCard.symbols = Array.from(mergedSymbols).slice(0, 30);
              }
            }
            break;
          }
        }
      } catch (e) {
        debug(`Error extracting cards from ${annotation.type} in issue #${issueNumber}: ${e.message}`);
      }
    }
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

function hashCards(cards) {
  const stable = JSON.stringify(cards.map(c => ({ ...c, status: undefined })).sort((a, b) => a.id < b.id ? -1 : 1));
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------------------

/**
 * Run staleness detection on a card's anchor.
 * Tier 1: blob sha match (cheapest)
 * Tier 2: symbol still present in file
 * Tier 3/4/5: handled offline — mark fresh by default for new cards
 *
 * Decision cards use 'needs-review' (not 'stale') when their anchor is dead —
 * this signals human review is required before the ADR is retired, rather than
 * silently treating the decision as invalidated. <!-- Added: forge#1737 -->
 */
function checkStaleness(card, repoPath) {
  if (!card.anchor) return 'fresh';
  if (!card.anchor.path) return 'fresh';

  const isDecision = card.kind === 'decision';
  const deadStatus = isDecision ? 'needs-review' : 'stale';

  const filePath = join(repoPath, card.anchor.path);
  if (!existsSync(filePath)) {
    return deadStatus; // Anchor file no longer exists
  }

  // Tier 2: symbol check (regex-class, not AST)
  if (card.anchor.symbol) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const symbolRe = new RegExp(`\\b${escapeRegExp(card.anchor.symbol)}\\b`);
      if (!symbolRe.test(content)) {
        return deadStatus; // Anchor symbol no longer present
      }
    } catch (_) {
      // If we can't read the file, assume fresh (don't break on binary files)
    }
  }

  return 'fresh';
}

/**
 * Find the ADR file path for a decision card, if one has been written by close.md Phase C5.3.
 * Returns the repo-relative path (e.g. 'devdocs/decisions/1737-auto-adrs-slug.md') or null.
 * <!-- Added: forge#1737 -->
 */
function findADRPath(issueNumber, repoPath) {
  const decisionsDir = join(repoPath, 'devdocs', 'decisions');
  if (!existsSync(decisionsDir)) return null;

  try {
    const files = readdirSync(decisionsDir);
    const prefix = `${issueNumber}-`;
    const match = files.find(f => f.startsWith(prefix) && f.endsWith('.md'));
    return match ? `devdocs/decisions/${match}` : null;
  } catch (_) {
    return null;
  }
}

/**
 * Update a staleness-detected ADR file's frontmatter status to 'needs-review'.
 * Non-blocking: logs and returns on any error.
 * <!-- Added: forge#1737 -->
 */
function updateADRStatus(adrPath, repoPath) {
  const absPath = join(repoPath, adrPath);
  if (!existsSync(absPath)) return;

  try {
    const content = readFileSync(absPath, 'utf8');
    // Only update if status is currently 'fresh' (avoid overwriting manual changes)
    if (!content.includes('status: fresh')) return;

    const updated = content.replace(/^status: fresh$/m, 'status: needs-review');
    if (updated !== content) {
      writeFileSync(absPath, updated, 'utf8');
      log(`[ADR] Flipped status to needs-review: ${adrPath}`);
    }
  } catch (e) {
    log(`WARNING: Failed to update ADR status for ${adrPath}: ${e.message}`);
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Rename log
// ---------------------------------------------------------------------------

/**
 * Append git rename entries since the watermark commit to renames.jsonl.
 */
function updateRenames(indexDir, repoPath, since) {
  const renamesPath = join(indexDir, RENAMES_FILE);
  let sinceArg = '';
  if (since) {
    // Convert ISO timestamp to a git --after argument
    sinceArg = `--after=${since}`;
  }

  try {
    const result = spawnSync('git', [
      'log',
      '--diff-filter=R',
      '--name-status',
      '--format=%H %ai',
      sinceArg,
      '--',
    ].filter(Boolean), {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 10000,
    });

    if (result.status !== 0) return;

    const lines = result.stdout.split('\n');
    const entries = [];
    let currentCommit = null;
    let currentDate = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      const commitMatch = line.match(/^([a-f0-9]{40})\s+(.+)$/);
      if (commitMatch) {
        currentCommit = commitMatch[1];
        currentDate = commitMatch[2];
        continue;
      }
      const renameMatch = line.match(/^R\d*\t(.+)\t(.+)$/);
      if (renameMatch && currentCommit) {
        entries.push(JSON.stringify({
          commit: currentCommit,
          date: currentDate,
          from: renameMatch[1],
          to: renameMatch[2],
        }));
      }
    }

    if (entries.length > 0) {
      appendFileSync(renamesPath, entries.join('\n') + '\n', 'utf8');
    }
  } catch (_) {
    // Non-blocking
  }
}

// ---------------------------------------------------------------------------
// BM25-lite tokenizer and postings builder
// ---------------------------------------------------------------------------

/**
 * Tokenize text for BM25-lite indexing.
 * - Lowercase
 * - Split on non-alphanumeric
 * - Split camelCase and snake_case (keep both forms)
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  const tokens = new Set();

  // Split on non-alphanumeric, lowercase everything
  const raw = text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 2);

  for (const tok of raw) {
    tokens.add(tok);

    // Split snake_case
    if (tok.includes('_')) {
      for (const part of tok.split('_')) {
        if (part.length >= 2) tokens.add(part);
      }
    }
  }

  // Also split camelCase from original text
  const camelRe = /[A-Z][a-z]+/g;
  const camelMatches = text.match(camelRe) || [];
  for (const part of camelMatches) {
    if (part.length >= 2) tokens.add(part.toLowerCase());
  }

  return Array.from(tokens);
}

/**
 * Compute per-field term frequencies for a card (BM25-lite field weighting).
 *
 * Field weights (per FORGE:DESIGN_DECISION):
 *   pattern field: weight 3
 *   rootCause ∪ symbols: weight 2
 *   paths basenames: weight 2
 *   prevention ∪ prose: weight 1
 *
 * Returns: Map<term, weighted_tf>
 */
function cardFieldTf(card) {
  const tfMap = new Map();

  function addTokens(text, weight) {
    const tokens = tokenize(text || '');
    for (const tok of tokens) {
      tfMap.set(tok, (tfMap.get(tok) || 0) + weight);
    }
  }

  // Weight 3: pattern
  addTokens(card.pattern || '', 3);

  // Weight 2: rootCause + symbols
  addTokens(card.rootCause || '', 2);
  for (const sym of card.symbols || []) {
    addTokens(sym, 2);
  }

  // Weight 2: path basenames
  for (const p of card.paths || []) {
    const basename = p.split('/').pop() || p;
    addTokens(basename, 2);
  }

  // Weight 1: prevention + decision + anomalies
  addTokens(card.prevention || '', 1);
  addTokens(card.decision || '', 1);
  addTokens(card.anomalies || '', 1);
  addTokens(card.verdict || '', 1);
  addTokens(card.taskType || '', 1);

  return tfMap;
}

/**
 * Build BM25-lite postings index from card JSONL.
 *
 * @param {object[]} cards
 * @returns {object} postings — { term: { cardId: weightedTf, ... }, ... }
 */
function buildPostings(cards) {
  const postings = {};

  for (const card of cards) {
    const tfMap = cardFieldTf(card);
    for (const [term, tf] of tfMap) {
      if (!postings[term]) postings[term] = {};
      postings[term][card.id] = tf;
    }
  }

  return postings;
}

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mirror to orphan branch
// ---------------------------------------------------------------------------

function mirrorToOrphanBranch(indexDir, repoPath) {
  try {
    // Check if forge-knowledge branch exists
    const branchCheck = spawnSync('git', ['show-ref', '--quiet', `refs/heads/${MIRROR_BRANCH}`], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
    });

    if (branchCheck.status !== 0) {
      // Create orphan branch
      const initResult = spawnSync('git', ['checkout', '--orphan', MIRROR_BRANCH], {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 10000,
      });
      if (initResult.status !== 0) {
        log(`WARNING: Could not create ${MIRROR_BRANCH} branch — skipping mirror`);
        return;
      }
      // Remove all tracked files from orphan branch working tree
      spawnSync('git', ['rm', '-rf', '--quiet', '.'], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
    } else {
      // Switch to the branch
      spawnSync('git', ['checkout', MIRROR_BRANCH], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
    }

    // Copy index files to repo root (they will be committed to the orphan branch)
    const files = [CARDS_FILE, POSTINGS_FILE, MANIFEST_FILE, RENAMES_FILE];
    for (const f of files) {
      const src = join(indexDir, f);
      if (existsSync(src)) {
        const dest = join(repoPath, f);
        writeFileSync(dest, readFileSync(src));
      }
    }

    // Stage and commit
    spawnSync('git', ['add', ...files.filter(f => existsSync(join(repoPath, f)))], {
      cwd: repoPath, encoding: 'utf8', timeout: 10000,
    });

    const commitResult = spawnSync('git', [
      'commit', '-m', `chore(ledger): update knowledge index [skip ci]`,
      '--allow-empty',
    ], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });

    if (commitResult.status === 0) {
      // Push to remote (non-blocking)
      spawnSync('git', ['push', 'origin', MIRROR_BRANCH, '--force-with-lease'], {
        cwd: repoPath, encoding: 'utf8', timeout: 30000,
      });
      log(`Mirror: pushed to ${MIRROR_BRANCH} branch`);
    }

    // Return to original branch
    spawnSync('git', ['checkout', '-'], { cwd: repoPath, encoding: 'utf8', timeout: 10000 });

  } catch (e) {
    log(`WARNING: Mirror to ${MIRROR_BRANCH} failed: ${e.message} — continuing`);
    // Non-blocking: attempt to restore branch
    try {
      spawnSync('git', ['checkout', '-'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 });
    } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Doctor check — divergence detection
// ---------------------------------------------------------------------------

/**
 * Sample K random indexed issues and recompute their card hashes.
 * Report mismatches (but do not auto-repair — full rebuild is the recovery path).
 *
 * @param {object} manifest
 * @param {string} repo
 * @param {number} k - sample size
 */
async function doctorCheck(manifest, repo, k = 5) {
  const issuePairs = Object.entries(manifest.issues);
  if (issuePairs.length === 0) return;

  const sample = issuePairs.sort(() => Math.random() - 0.5).slice(0, k);
  const mismatches = [];

  for (const [issueNum, storedHash] of sample) {
    try {
      const { issue, comments } = fetchIssue(repo, issueNum);
      const cards = await extractCardsFromIssue(parseInt(issueNum, 10), issue, comments);
      const computedHash = hashCards(cards);
      if (computedHash !== storedHash) {
        mismatches.push({ issue: issueNum, stored: storedHash, computed: computedHash });
      }
    } catch (_) {
      // Skip on API error
    }
  }

  if (mismatches.length > 0) {
    log(`DOCTOR: ${mismatches.length}/${k} sampled issues have hash mismatches — consider --full-rebuild`);
    for (const m of mismatches) {
      log(`  Issue #${m.issue}: stored=${m.stored} computed=${m.computed}`);
    }
  } else {
    log(`DOCTOR: ${k} sampled issues passed divergence check`);
  }
}

// ---------------------------------------------------------------------------
// Cost-prior aggregation (economic scheduling — forge#1743)
// ---------------------------------------------------------------------------

/**
 * Aggregate historical FORGE:CARD spend into cost priors keyed by
 * `task_type:module` (where module = the basename of the primary affected
 * file, lower-cased, without extension).
 *
 * Input: `cards` array from knowledge.jsonl (all cards in the index).
 *   Each card may carry a `costUsd` object (populated by close-phase
 *   indexing of FORGE:TRAJECTORY actual-spend fields):
 *     card.costUsd = { investigation: number|null, build: number|null, review: number|null, total: number|null }
 *
 * Output written to `~/.forge/index/cost-priors.json`:
 * {
 *   schemaVersion: 1,
 *   generatedAt: ISO-string,
 *   sampleCount: N,           // total spend samples across all keys
 *   priors: {
 *     "<task_type>:<module>": {
 *       n: number,            // sample count
 *       mean: number,         // mean total_usd
 *       variance: number,     // sample variance (0 when n<2)
 *       stddev: number,       // sqrt(variance)
 *       min: number,
 *       max: number,
 *       p50: number,          // median
 *     },
 *     ...
 *   }
 * }
 *
 * Cards that have no costUsd total are skipped (counted as absent, not zero).
 * Keys with only 1 sample have variance=0, stddev=0.
 *
 * @param {object[]} cards    — full knowledge card array
 * @param {string}   indexDir — output directory for cost-priors.json
 * @param {boolean}  dryRun   — if true, print priors to stdout, don't write
 */
function aggregateCostPriors(cards, indexDir, dryRun = false) {
  // Group total_usd values by task_type:module key
  // task_type from card.taskType (e.g. "Feature", "Bug Fix", "Refactor")
  // module = basename (no ext, lowercase) of card.paths[0], or "_unknown"
  const buckets = new Map(); // key → number[]

  for (const card of cards) {
    const total = card.costUsd?.total ?? null;
    if (total === null || typeof total !== 'number' || !isFinite(total) || total <= 0) continue;

    const rawTaskType = (card.taskType || 'unknown').trim().toLowerCase().replace(/\s+/g, '-');
    const primaryPath = card.paths?.[0] || '';
    const moduleName = primaryPath
      ? primaryPath.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase() || '_unknown'
      : '_unknown';

    const key = `${rawTaskType}:${moduleName}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(total);
  }

  // Compute statistics per bucket
  const priors = {};
  let totalSampleCount = 0;

  for (const [key, values] of buckets) {
    const n = values.length;
    totalSampleCount += n;

    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const variance = n >= 2
      ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
      : 0;
    const stddev = Math.sqrt(variance);
    const p50 = n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];

    priors[key] = {
      n,
      mean: Math.round(mean * 10000) / 10000,          // 4 decimal places (sub-cent precision)
      variance: Math.round(variance * 10000) / 10000,
      stddev: Math.round(stddev * 10000) / 10000,
      min: Math.round(sorted[0] * 10000) / 10000,
      max: Math.round(sorted[n - 1] * 10000) / 10000,
      p50: Math.round(p50 * 10000) / 10000,
    };
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sampleCount: totalSampleCount,
    priors,
  };

  if (dryRun) {
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return output;
  }

  writeFileSync(join(indexDir, COST_PRIORS_FILE), JSON.stringify(output, null, 2), 'utf8');
  log(`Cost priors: wrote ${Object.keys(priors).length} keys (${totalSampleCount} samples) to ${COST_PRIORS_FILE}`);
  return output;
}

// ---------------------------------------------------------------------------
// Pattern exchange subscription pull (forge#1746)
// Reads forge.yaml → pattern_feeds, fetches subscribed card files from
// exchange repos at pinned refs via gh api, and merges them into the local
// ledger as LOW-priority priors tagged by origin feed slug.
// ---------------------------------------------------------------------------

/** Read a yq scalar from forge.yaml in the repo root. Returns '' on error. */
function yqScalar(repoPath, expr) {
  const result = spawnSync('yq', [expr, join(repoPath, 'forge.yaml')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return '';
}

/** Read a JSON value from forge.yaml via yq -o json. Returns null on error. */
function yqJsonVal(repoPath, expr) {
  const result = spawnSync('yq', ['-o', 'json', expr, join(repoPath, 'forge.yaml')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout.trim() || result.stdout.trim() === 'null') return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

/**
 * Fetch a file from a GitHub repo at a specific pinned ref via gh api.
 * Returns decoded string content, or null on error.
 */
function ghFetchFileContent(repo, ref, filePath) {
  const endpoint = `repos/${repo}/contents/${filePath}?ref=${ref}`;
  try {
    const result = spawnSync('gh', ['api', endpoint, '--jq', '.content'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.status !== 0 || !result.stdout.trim() || result.stdout.trim() === 'null') return null;
    // GitHub encodes content as base64 with embedded newlines
    return Buffer.from(result.stdout.trim().replace(/\n/g, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * List directory contents from a GitHub repo at a pinned ref.
 * Returns array of { path, type } objects, or [] on error.
 */
function ghListContents(repo, ref, dirPath) {
  const endpoint = `repos/${repo}/contents/${dirPath}?ref=${ref}`;
  try {
    const result = spawnSync('gh', ['api', endpoint, '--jq', '[.[] | {path: .path, type: .type}]'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.status !== 0 || !result.stdout.trim() || result.stdout.trim() === 'null') return [];
    return JSON.parse(result.stdout.trim());
  } catch {
    return [];
  }
}

/**
 * Parse a pattern card markdown file from the exchange repo schema.
 * See forge.yaml.example § PATTERN_FEEDS for the card format.
 * Returns a card object or null if malformed.
 */
function parseExchangeCard(markdown, filePath) {
  const lines = markdown.split('\n');

  function extractSection(heading) {
    const start = lines.findIndex(l => l.trim() === `## ${heading}`);
    if (start === -1) return '';
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    const sectionLines = end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end);
    return sectionLines.join('\n').trim();
  }

  const headerLine = lines.find(l => /^#\s+Pattern:\s+\S/.test(l));
  if (!headerLine) {
    log(`Exchange card at ${filePath}: missing "# Pattern: {slug}" header — skipping`);
    return null;
  }
  const slug = headerLine.replace(/^#\s+Pattern:\s+/, '').trim();
  if (!slug) { log(`Exchange card at ${filePath}: empty slug — skipping`); return null; }

  const stacksRaw = extractSection('Stacks');
  const stacks = stacksRaw.split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (stacks.length === 0) {
    log(`Exchange card "${slug}": no stacks — skipping (required by schema)`);
    return null;
  }

  const rootCauseShape = extractSection('Root Cause Shape');
  const prevention     = extractSection('Prevention Rule');
  const summary        = extractSection('Summary');

  // Optional gate.d check template — bash code block under "## gate.d Check Template"
  let gateTemplate = '';
  const gateSectionIdx = lines.findIndex(l => l.trim() === '## gate.d Check Template');
  if (gateSectionIdx !== -1) {
    const codeStart = lines.findIndex((l, i) => i > gateSectionIdx && l.trim() === '```bash');
    if (codeStart !== -1) {
      const codeEnd = lines.findIndex((l, i) => i > codeStart && l.trim() === '```');
      if (codeEnd !== -1) {
        gateTemplate = lines.slice(codeStart + 1, codeEnd).join('\n').trim();
      }
    }
  }

  return { slug, stacks, root_cause_shape: rootCauseShape, prevention, summary, gate_template: gateTemplate };
}

/**
 * Pull all subscribed pattern feeds and merge into the local ledger.
 * Entry point for --pull-feeds mode.
 *
 * Security model:
 *   - Only pinned commit SHAs are accepted as refs (7–40 hex chars)
 *   - Fetched content is stored as data (JSON); never executed at import time
 *   - All imported cards carry origin:<feedSlug> and priority:LOW
 *   - Local validated findings (no origin field) always outrank imported cards
 *   - Unsubscribing from a feed removes stale cards on next run
 */
async function pullFeeds(repoPath, args) {
  log('');
  log('=== build-knowledge-index --pull-feeds ===');
  log(`Run at: ${new Date().toISOString()}`);
  if (args.dryRun)     log('Mode: DRY RUN — no files written');
  if (args.feedFilter) log(`Feed filter: --feed ${args.feedFilter}`);
  log('');

  // Read pattern_feeds config from forge.yaml
  const feedsEnabled = yqScalar(repoPath, '.pattern_feeds.enabled // "false"').toLowerCase();
  if (feedsEnabled !== 'true') {
    log('pattern_feeds.enabled is not true in forge.yaml — nothing to do.');
    log('Set pattern_feeds.enabled: true and configure at least one feed.');
    return;
  }

  const feeds = yqJsonVal(repoPath, '.pattern_feeds.feeds // []');
  if (!Array.isArray(feeds) || feeds.length === 0) {
    log('No feeds in forge.yaml → pattern_feeds.feeds — nothing to do.');
    return;
  }

  const ledgerRelPath = yqScalar(repoPath, '.pattern_feeds.ledger_path // ".forge/ledger"') || '.forge/ledger';
  const LEDGER_ROOT = resolve(repoPath, ledgerRelPath);

  // Discover local validated finding slugs (no origin = local)
  const LOCAL_SLUGS = new Set();
  if (existsSync(LEDGER_ROOT)) {
    try {
      const walkDir = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walkDir(full);
          else if (entry.name.endsWith('.json')) {
            try {
              const data = JSON.parse(readFileSync(full, 'utf8'));
              if ((!data.origin || data.origin === 'local') && data.slug) {
                LOCAL_SLUGS.add(data.slug);
              }
            } catch { /* malformed — skip */ }
          }
        }
      };
      walkDir(LEDGER_ROOT);
    } catch { /* ledger unreadable — ok */ }
  }

  const PINNED_REF_RE = /^[0-9a-f]{7,40}$/i;
  const stats = { feeds_processed: 0, feeds_skipped: 0, cards_imported: 0, cards_skipped: 0, cards_removed: 0, errors: [] };

  for (const feed of feeds) {
    const { slug: feedSlug, repo, ref, path: cardPath = 'cards', stacks: feedStacks } = feed ?? {};

    if (!feedSlug || !repo || !ref) {
      log(`[WARN] Feed entry missing required fields (slug, repo, ref) — skipping: ${JSON.stringify(feed)}`);
      stats.feeds_skipped++;
      continue;
    }

    if (args.feedFilter && feedSlug !== args.feedFilter) {
      debug(`Skipping feed ${feedSlug} (--feed filter)`);
      continue;
    }

    // Security gate: reject floating refs
    if (!PINNED_REF_RE.test(ref)) {
      log(`[WARN] Feed ${feedSlug}: ref "${ref}" is not a pinned commit SHA (7–40 hex chars). Floating refs rejected for supply-chain safety. Update forge.yaml → pattern_feeds.feeds → ref.`);
      stats.feeds_skipped++;
      stats.errors.push(`${feedSlug}: non-pinned ref rejected`);
      continue;
    }

    log(`--- Feed: ${feedSlug} (${repo} @ ${ref.slice(0, 8)}…) ---`);
    stats.feeds_processed++;

    // Discover card files: list subdirectories (stacks), then files within each
    const cardFiles = [];
    const contents = ghListContents(repo, ref, cardPath);

    if (contents.length === 0) {
      log(`Feed ${feedSlug}: empty or inaccessible path ${cardPath} — skipping`);
      stats.feeds_skipped++;
      continue;
    }

    const subdirs = contents.filter(e => e.type === 'dir');
    const topFiles = contents.filter(e => e.type === 'file' && e.path.endsWith('.md'));

    if (subdirs.length === 0) {
      // Flat layout: files directly under cardPath
      cardFiles.push(...topFiles.map(f => f.path));
    } else {
      for (const subdir of subdirs) {
        const stackName = subdir.path.split('/').pop();
        if (feedStacks && Array.isArray(feedStacks) && feedStacks.length > 0) {
          if (!feedStacks.includes(stackName)) {
            debug(`Feed ${feedSlug}: skipping stack dir ${stackName} (not in feed stacks filter)`);
            continue;
          }
        }
        const subContents = ghListContents(repo, ref, subdir.path);
        cardFiles.push(...subContents.filter(e => e.type === 'file' && e.path.endsWith('.md')).map(e => e.path));
      }
    }

    if (cardFiles.length === 0) {
      log(`Feed ${feedSlug}: no card files found — skipping`);
      continue;
    }

    log(`Feed ${feedSlug}: found ${cardFiles.length} card file(s)`);
    const importedSlugs = new Set();

    for (const filePath of cardFiles) {
      const markdown = ghFetchFileContent(repo, ref, filePath);
      if (!markdown) {
        log(`[WARN] Feed ${feedSlug}: could not fetch ${filePath} — skipping`);
        stats.cards_skipped++;
        continue;
      }

      const card = parseExchangeCard(markdown, filePath);
      if (!card) { stats.cards_skipped++; continue; }

      const { slug } = card;

      if (LOCAL_SLUGS.has(slug)) {
        debug(`Feed ${feedSlug}: slug "${slug}" exists as local validated finding — skipping import`);
        stats.cards_skipped++;
        continue;
      }

      // Apply feed-level stack filter at card level
      if (feedStacks && Array.isArray(feedStacks) && feedStacks.length > 0) {
        const overlap = card.stacks.filter(s => feedStacks.includes(s));
        if (overlap.length === 0) {
          debug(`Feed ${feedSlug}: card "${slug}" stacks [${card.stacks}] do not overlap feed filter — skipping`);
          stats.cards_skipped++;
          continue;
        }
      }

      const ledgerEntry = {
        schema_version: '1',
        slug,
        stacks: card.stacks,
        root_cause_shape: card.root_cause_shape,
        prevention: card.prevention,
        summary: card.summary,
        gate_template: card.gate_template || null,
        origin: feedSlug,
        source_repo: repo,
        source_ref: ref,
        source_path: filePath,
        priority: 'LOW',   // always LOW for imported cards — never overridden
        imported_at: new Date().toISOString(),
      };

      const feedLedgerDir = join(LEDGER_ROOT, feedSlug);
      const ledgerFilePath = join(feedLedgerDir, `${slug}.json`);
      importedSlugs.add(slug);

      if (args.dryRun) {
        log(`  DRY RUN: would write ${ledgerFilePath}`);
        if (args.verbose) log(`  ${JSON.stringify(ledgerEntry)}`);
        stats.cards_imported++;
        continue;
      }

      // Idempotency: skip if same ref already imported
      if (existsSync(ledgerFilePath)) {
        try {
          const existing = JSON.parse(readFileSync(ledgerFilePath, 'utf8'));
          if (existing.source_ref === ref && existing.slug === slug) {
            debug(`  SKIP ${slug} — already at ref ${ref.slice(0, 8)}`);
            stats.cards_skipped++;
            continue;
          }
        } catch { /* overwrite malformed */ }
      }

      mkdirSync(feedLedgerDir, { recursive: true });
      writeFileSync(ledgerFilePath, JSON.stringify(ledgerEntry, null, 2) + '\n', 'utf8');
      log(`  IMPORTED ${slug} → ${ledgerFilePath}`);
      stats.cards_imported++;
    }

    // Reconcile: remove cards no longer present upstream (clean unsubscribe)
    if (!args.dryRun) {
      const feedLedgerDir = join(LEDGER_ROOT, feedSlug);
      if (existsSync(feedLedgerDir)) {
        for (const file of readdirSync(feedLedgerDir)) {
          if (!file.endsWith('.json')) continue;
          const existingSlug = file.replace(/\.json$/, '');
          if (!importedSlugs.has(existingSlug)) {
            const { unlinkSync } = await import('node:fs');
            unlinkSync(join(feedLedgerDir, file));
            log(`  REMOVED stale card ${existingSlug} (no longer in upstream @ ${ref.slice(0, 8)})`);
            stats.cards_removed++;
          }
        }
      }
    }
  }

  log('');
  log('=== Pull Feeds Summary ===');
  log(`  Feeds processed: ${stats.feeds_processed}`);
  log(`  Feeds skipped:   ${stats.feeds_skipped}`);
  log(`  Cards imported:  ${stats.cards_imported}`);
  log(`  Cards skipped:   ${stats.cards_skipped}`);
  log(`  Cards removed:   ${stats.cards_removed}`);
  if (stats.errors.length > 0) {
    log(`  Errors (${stats.errors.length}):`);
    for (const e of stats.errors) log(`    - ${e}`);
  }
  if (args.dryRun) log('');
  if (args.dryRun) log('DRY RUN: no files written. Remove --dry-run to apply.');
  log('');

  if (stats.feeds_skipped > 0 && stats.feeds_processed === 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  globalThis._VERBOSE = args.verbose;

  const repoPath = process.env.FORGE_REPO_PATH || resolve(dirname(__dirname));
  const indexDir = resolve(args.outputDir);

  // Pattern exchange feed pull mode (forge#1746)
  // Invoked as: node scripts/build-knowledge-index.mjs --pull-feeds [--dry-run] [--feed <slug>]
  if (args.pullFeeds) {
    await pullFeeds(repoPath, args);
    return;
  }

  // Resolve GitHub repo from args or forge.yaml
  let repo = args.repo;
  if (!repo) {
    repo = readForgeYaml(repoPath);
  }
  if (!repo) {
    process.stderr.write('[ledger] ERROR: Cannot determine GitHub repo. Pass --repo owner/repo or ensure forge.yaml is present.\n');
    process.exit(1);
  }

  log(`Forge Ledger indexer — repo: ${repo}, output: ${indexDir}`);

  if (args.dryRun) {
    log('DRY RUN: will parse and display cards without writing');
  } else {
    ensureIndexDir(indexDir);
  }

  // Load manifest
  const manifest = readManifest(indexDir);
  const watermark = args.fullRebuild ? null : manifest.watermark;

  if (watermark) {
    log(`Incremental: fetching issues updated since ${watermark}`);
  } else {
    log('Full rebuild: fetching all closed issues');
  }

  // Determine which issues to process
  let issuesToProcess = [];

  if (args.issue) {
    // Single-issue mode (close phase integration)
    log(`Single-issue mode: indexing issue #${args.issue}`);
    const { issue, comments } = fetchIssue(repo, args.issue);
    issuesToProcess = [{ issue, comments }];
  } else {
    // Batch mode: fetch issues since watermark
    const rawIssues = fetchIssuesSince(repo, watermark);
    log(`Fetched ${rawIssues.length} issues to process`);

    for (const issue of rawIssues) {
      let comments = [];
      try {
        const commentsRaw = ghApi(`repos/${repo}/issues/${issue.number}/comments?per_page=100`);
        comments = JSON.parse(commentsRaw);
      } catch (_) { /* empty comments */ }
      issuesToProcess.push({ issue, comments });
    }
  }

  // Read existing cards (for non-full-rebuild mode)
  let allCards = args.fullRebuild ? [] : readJsonl(join(indexDir, CARDS_FILE));

  // Track new watermark
  let newWatermark = watermark;

  // Process each issue
  let successCount = 0;
  let errorCount = 0;

  for (const { issue, comments } of issuesToProcess) {
    const issueNumber = issue.number;
    debug(`Processing issue #${issueNumber}: ${issue.title}`);

    try {
      const cards = await extractCardsFromIssue(issueNumber, issue, comments);

      // Run staleness detection and link ADR files for decision cards
      // <!-- Added: forge#1737 — ADR path linking + needs-review for dead-anchor decisions -->
      for (const card of cards) {
        card.status = checkStaleness(card, repoPath);

        if (card.kind === 'decision') {
          // Link the ADR file if one was written by close.md Phase C5.3
          const adrPath = findADRPath(card.issue, repoPath);
          if (adrPath) {
            card.adrPath = adrPath;
          }
          // If anchor is dead, update ADR frontmatter status to needs-review
          if (card.status === 'needs-review' && card.adrPath) {
            updateADRStatus(card.adrPath, repoPath);
          }
        }
      }

      const hash = hashCards(cards);

      if (!args.dryRun) {
        // Remove existing cards for this issue (re-index idempotency)
        allCards = allCards.filter(c => c.issue !== issueNumber);
        allCards.push(...cards);

        // Update manifest
        manifest.issues[String(issueNumber)] = hash;
      } else {
        // Dry run: print cards
        for (const card of cards) {
          process.stdout.write(JSON.stringify(card) + '\n');
        }
        // Accumulate for dry-run cost-prior output (see end of main)
        allCards.push(...cards);
      }

      // Advance watermark
      const updatedAt = issue.updated_at || issue.created_at;
      if (updatedAt && (!newWatermark || updatedAt > newWatermark)) {
        newWatermark = updatedAt;
      }

      successCount++;
      if (cards.length > 0) {
        debug(`Issue #${issueNumber}: extracted ${cards.length} card(s), hash=${hash}`);
      }
    } catch (e) {
      log(`WARNING: Failed to process issue #${issueNumber}: ${e.message}`);
      errorCount++;
    }
  }

  if (!args.dryRun) {
    // Write JSONL
    writeFileSync(
      join(indexDir, CARDS_FILE),
      allCards.map(c => JSON.stringify(c)).join('\n') + (allCards.length > 0 ? '\n' : ''),
      'utf8',
    );

    // Build and write postings
    const postings = buildPostings(allCards);
    writeFileSync(join(indexDir, POSTINGS_FILE), JSON.stringify(postings), 'utf8');

    // Aggregate cost priors for economic scheduling (forge#1743)
    aggregateCostPriors(allCards, indexDir, false);

    // Update watermark in manifest
    manifest.watermark = newWatermark;
    manifest.schemaVersion = 1;
    manifest.lastIndexed = new Date().toISOString();
    manifest.cardCount = allCards.length;
    writeManifest(indexDir, manifest);

    // Update rename log
    updateRenames(indexDir, repoPath, watermark);

    log(`Indexed ${successCount} issues, ${allCards.length} cards total${errorCount > 0 ? ` (${errorCount} errors)` : ''}`);

    // Mirror to orphan branch (non-blocking)
    if (!args.noMirror) {
      log('Mirroring to forge-knowledge branch...');
      mirrorToOrphanBranch(indexDir, repoPath);
    }

    // Update danger-zones index (non-blocking) — refreshes per-file finding stats
    // and co-change matrix so Layer 5 and CHURN_CONTEXT consumers get fresh risk data.
    if (args.withDangerZones) {
      log('Updating danger-zones index (non-blocking)...');
      const dangerZonesScript = join(__dirname, 'danger-zones.mjs');
      if (existsSync(dangerZonesScript)) {
        try {
          const dzResult = spawnSync(
            process.execPath,
            [dangerZonesScript, '--output', indexDir, '--repo-path', repoPath],
            { encoding: 'utf8', timeout: 120000, stdio: 'pipe' },
          );
          if (dzResult.status !== 0) {
            log(`WARNING: danger-zones.mjs exited with ${dzResult.status} — ${dzResult.stderr || dzResult.stdout || '(no output)'}`);
          } else {
            log('danger-zones index updated');
          }
        } catch (e) {
          log(`WARNING: danger-zones.mjs failed to run — ${e.message}`);
        }
      } else {
        log(`WARNING: --with-danger-zones flag set but ${dangerZonesScript} not found — skipping`);
      }
    }
  }

  if (args.dryRun) {
    // Dry run: print cost priors to stdout
    aggregateCostPriors(allCards, indexDir, true);
  }

  if (errorCount > 0 && successCount === 0) {
    process.exit(2);
  }
}

main().catch(e => {
  process.stderr.write(`[ledger] FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});

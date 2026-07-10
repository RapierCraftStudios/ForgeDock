#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bin/recall.mjs — Forge Ledger recall CLI.
 *
 * Queries the local knowledge index (~/.forge/index/) and returns relevant
 * knowledge cards with issue citations.
 *
 * Query modes:
 *   --file <path>     Exact file-path lookup (hash-map, O(1)); repeatable for multi-file union
 *   --symbol <name>   Exact symbol lookup (hash-map, O(1))
 *   free text         BM25-lite ranked search across all card fields
 *
 * Combined queries (--file + free text) take the union with exact-match boost.
 * Multiple --file flags are unioned: cards matching any file receive a boost per
 * matched file; results are deduped by card ID and ranked by combined score.
 *
 * Usage:
 *   forge recall <free-text query> [--file <path>] [--symbol <name>]
 *                [--k 5] [--min-score 0.3] [--kind pattern|investigation|decision]
 *                [--include-stale] [--json]
 *
 * Options:
 *   --file <path>         Exact file path to look up cards for (repeatable — union across files)
 *   --symbol <name>       Exact symbol name to look up
 *   --k <number>          Maximum results to return (default: 5)
 *   --min-score <float>   Minimum BM25 score threshold (default: 0.1)
 *   --kind <type>         Filter by card kind (pattern|investigation|decision)
 *   --include-stale       Include stale cards (excluded by default)
 *   --json                Output JSON array instead of formatted text
 *   --index <dir>         Override index directory (default: ~/.forge/index)
 *   --doctor              Run divergence check (requires GitHub API access)
 *
 * Exit codes:
 *   0  — results found (or empty index, not an error)
 *   1  — fatal error (cannot read index, invalid args)
 *
 * Machine-readable JSON output format (--json):
 *   [{ id, kind, issue, score, paths, symbols, pattern, rootCause, prevention,
 *      decision, verdict, confidence, status, createdAt }]
 *
 * @module recall
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_DIR = join(homedir(), '.forge', 'index');
const CARDS_FILE = 'knowledge.jsonl';
const POSTINGS_FILE = 'postings.json';
const DEFAULT_K = 5;
const DEFAULT_MIN_SCORE = 0.1;
const AGE_DECAY_DAYS = 180;

// BM25 parameters (per FORGE:DESIGN_DECISION spec)
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Score boosts for exact matches (per spec)
const EXACT_FILE_BOOST = 5.0;
const EXACT_SYMBOL_BOOST = 3.0;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    query: [],
    files: [],   // Array — accepts repeated --file flags (union query across multiple file paths)
    symbol: null,
    k: DEFAULT_K,
    minScore: DEFAULT_MIN_SCORE,
    kind: null,
    includeStale: false,
    json: false,
    indexDir: DEFAULT_INDEX_DIR,
    doctor: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file':
        args.files.push(argv[++i]);
        break;
      case '--symbol':
        args.symbol = argv[++i];
        break;
      case '--k':
        args.k = parseInt(argv[++i], 10) || DEFAULT_K;
        break;
      case '--min-score':
        args.minScore = parseFloat(argv[++i]) || DEFAULT_MIN_SCORE;
        break;
      case '--kind':
        args.kind = argv[++i];
        break;
      case '--include-stale':
        args.includeStale = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--index':
        args.indexDir = argv[++i];
        break;
      case '--doctor':
        args.doctor = true;
        break;
      default:
        if (!argv[i].startsWith('--')) {
          args.query.push(argv[i]);
        }
        break;
    }
  }

  args.queryText = args.query.join(' ').trim();
  return args;
}

// ---------------------------------------------------------------------------
// Index loading
// ---------------------------------------------------------------------------

/**
 * Load cards from JSONL file.
 */
function loadCards(indexDir) {
  const cardsPath = join(indexDir, CARDS_FILE);
  if (!existsSync(cardsPath)) return [];

  try {
    return readFileSync(cardsPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch (e) {
    process.stderr.write(`[recall] WARNING: Could not read ${cardsPath}: ${e.message}\n`);
    return [];
  }
}

/**
 * Load postings (inverted) index.
 */
function loadPostings(indexDir) {
  const postingsPath = join(indexDir, POSTINGS_FILE);
  if (!existsSync(postingsPath)) return {};

  try {
    return JSON.parse(readFileSync(postingsPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// BM25-lite tokenizer (must match build-knowledge-index.mjs)
// ---------------------------------------------------------------------------

function tokenize(text) {
  if (!text) return [];
  const tokens = new Set();

  const raw = text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 2);
  for (const tok of raw) {
    tokens.add(tok);
    if (tok.includes('_')) {
      for (const part of tok.split('_')) {
        if (part.length >= 2) tokens.add(part);
      }
    }
  }

  const camelRe = /[A-Z][a-z]+/g;
  const camelMatches = text.match(camelRe) || [];
  for (const part of camelMatches) {
    if (part.length >= 2) tokens.add(part.toLowerCase());
  }

  return Array.from(tokens);
}

// ---------------------------------------------------------------------------
// BM25-lite scoring
// ---------------------------------------------------------------------------

/**
 * Compute BM25-lite score for a set of query terms against the postings index.
 *
 * score = Σ_{t∈q} idf(t) · fieldTf·(k1+1) / (fieldTf + k1·(1−b+b·len/avgLen))
 *         · exp(−ageDays/180)
 *         · (status == "stale" ? 0 : 1)
 *
 * @param {string[]} queryTerms
 * @param {string} cardId
 * @param {object} postings
 * @param {number} N - total card count
 * @param {number} avgLen - average card token count (approximated)
 * @param {number} cardLen - this card's token count (approximated)
 * @param {number} ageDays
 * @param {string} status
 * @returns {number}
 */
function bm25Score(queryTerms, cardId, postings, N, avgLen, cardLen, ageDays, status) {
  if (status === 'stale') return 0;

  let score = 0;
  const dfCache = {};

  for (const term of queryTerms) {
    if (!postings[term]) continue;

    const df = Object.keys(postings[term]).length;
    const fieldTf = postings[term][cardId] || 0;
    if (fieldTf === 0) continue;

    // IDF
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

    // BM25 numerator/denominator
    const norm = fieldTf * (BM25_K1 + 1) / (fieldTf + BM25_K1 * (1 - BM25_B + BM25_B * cardLen / Math.max(avgLen, 1)));
    score += idf * norm;
  }

  // Age decay: exp(−ageDays / 180)
  const decay = Math.exp(-ageDays / AGE_DECAY_DAYS);
  return score * decay;
}

/**
 * Compute card age in days from createdAt field.
 */
function cardAgeDays(card) {
  if (!card.createdAt) return 0;
  try {
    const created = new Date(card.createdAt).getTime();
    const now = Date.now();
    return Math.max(0, (now - created) / (1000 * 60 * 60 * 24));
  } catch (_) {
    return 0;
  }
}

/**
 * Approximate token count for a card (used for BM25 length normalization).
 */
function cardTokenCount(card) {
  const text = [
    card.pattern || '',
    card.rootCause || '',
    card.prevention || '',
    card.decision || '',
    (card.symbols || []).join(' '),
    (card.paths || []).join(' '),
  ].join(' ');
  return tokenize(text).length;
}

// ---------------------------------------------------------------------------
// Rename map application
// ---------------------------------------------------------------------------

/**
 * Load rename log and build a map from old path → current path.
 */
function buildRenameMap(indexDir) {
  const renamesPath = join(indexDir, 'renames.jsonl');
  if (!existsSync(renamesPath)) return {};

  const map = {};
  try {
    const lines = readFileSync(renamesPath, 'utf8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      const entry = JSON.parse(line);
      // One-hop record only (last entry for a given `from` wins, matching
      // append-only log semantics). Multi-hop chains (A->B->C) are resolved
      // transitively at lookup time in applyRenameMap — see below.
      if (entry && entry.from) map[entry.from] = entry.to;
    }
  } catch (_) {
    // Return empty map on error
  }
  return map;
}

/**
 * Apply rename map to query file path.
 * Follows the rename chain to a fixed point so multi-hop renames
 * (e.g. A -> B -> C) resolve to the final current path, not just the
 * first hop. Guards against cycles (e.g. A -> B, B -> A) with a visited
 * set so a malformed/cyclic rename log can't cause an infinite loop.
 */
function applyRenameMap(queryPath, renameMap) {
  let current = queryPath;
  const seen = new Set([current]);
  while (Object.prototype.hasOwnProperty.call(renameMap, current)) {
    const next = renameMap[current];
    if (next === undefined || next === current || seen.has(next)) break;
    current = next;
    seen.add(current);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/**
 * Execute a recall query and return ranked results.
 *
 * @param {object} args - parsed CLI args
 * @param {object[]} cards - all cards
 * @param {object} postings - postings index
 * @returns {Array<{card, score}>}
 */
function executeQuery(args, cards, postings) {
  const renameMap = buildRenameMap(args.indexDir);

  // Normalize all query file paths through rename map (multi-file union support)
  // args.files is an array; each entry may be a single path from repeated --file flags.
  const effectiveFiles = (args.files || []).map(f => ({
    original: f,
    effective: applyRenameMap(f, renameMap),
    basename: (applyRenameMap(f, renameMap).split('/').pop() || f),
  }));

  // Pre-filter cards
  let candidates = cards.filter(card => {
    if (!args.includeStale && card.status === 'stale') return false;
    if (args.kind && card.kind !== args.kind) return false;
    return true;
  });

  // BM25 setup
  const N = candidates.length;
  const tokenCounts = candidates.map(c => cardTokenCount(c));
  const avgLen = tokenCounts.length > 0 ? tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length : 1;

  // Query tokenization: free text + all file paths + symbol
  const queryTerms = args.queryText ? tokenize(args.queryText) : [];
  for (const ef of effectiveFiles) queryTerms.push(...tokenize(ef.effective));
  if (args.symbol) queryTerms.push(...tokenize(args.symbol));

  // Use a Map for dedup: card.id → {card, score}
  // When the same card matches multiple files, accumulate the highest score.
  const hitMap = new Map();

  for (let i = 0; i < candidates.length; i++) {
    const card = candidates[i];
    const ageDays = cardAgeDays(card);
    const cardLen = tokenCounts[i];

    let score = 0;

    // BM25 text score
    if (queryTerms.length > 0) {
      score = bm25Score(queryTerms, card.id, postings, N, avgLen, cardLen, ageDays, card.status);
    }

    // Per-file exact match boost (applied once per matching file — accumulates across files)
    let hasExactMatch = false;
    for (const ef of effectiveFiles) {
      const cardPaths = card.paths || [];
      if (cardPaths.some(p => p === ef.effective || p === ef.original)) {
        score += EXACT_FILE_BOOST;
        hasExactMatch = true;
      } else if (ef.basename && cardPaths.some(p => p.split('/').pop() === ef.basename)) {
        score += EXACT_FILE_BOOST * 0.5; // Partial boost for basename match
        // basename match does not set hasExactMatch (not an exact path match)
      }
    }

    // Exact symbol match boost
    if (args.symbol) {
      const cardSymbols = card.symbols || [];
      if (cardSymbols.some(s => s === args.symbol || s.toLowerCase() === args.symbol.toLowerCase())) {
        score += EXACT_SYMBOL_BOOST;
        hasExactMatch = true;
      }
    }

    // Include if: score > threshold, OR exact file/symbol match (always include even if score=0)
    if (score >= args.minScore || hasExactMatch) {
      const existing = hitMap.get(card.id);
      if (!existing || score > existing.score) {
        hitMap.set(card.id, { card, score });
      }
    }
  }

  const results = Array.from(hitMap.values());

  // Sort by score descending, then by recency
  results.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.001) return b.score - a.score;
    return (b.card.createdAt || '').localeCompare(a.card.createdAt || '');
  });

  return results.slice(0, args.k);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatCard(card, score, showScore = true) {
  const lines = [];
  const cite = `#${card.issue}`;
  const kind = typeof card.kind === 'string' && card.kind ? card.kind.toUpperCase() : 'UNKNOWN';
  const scoreStr = showScore ? ` (score: ${score.toFixed(2)})` : '';
  const staleStr = card.status === 'stale' ? ' [STALE]' : '';

  lines.push(`── ${kind}${staleStr} from ${cite}${scoreStr} ──`);

  if (card.kind === 'pattern') {
    if (card.pattern) lines.push(`Pattern:    ${card.pattern}`);
    if (card.rootCause) lines.push(`Root Cause: ${card.rootCause}`);
    if (card.prevention) lines.push(`Prevention: ${card.prevention}`);
  } else if (card.kind === 'investigation') {
    if (card.rootCause) lines.push(`Root Cause: ${card.rootCause}`);
    if (card.prevention) lines.push(`Fix:        ${card.prevention}`);
    if (card.verdict) lines.push(`Verdict:    ${card.verdict} (${card.confidence || '?'})`);
  } else if (card.kind === 'decision') {
    if (card.decision) lines.push(`Decision:   ${card.decision}`);
    if (card.anomalies && card.anomalies !== 'None') {
      lines.push(`Anomalies:  ${card.anomalies}`);
    }
  }

  if (card.paths && card.paths.length > 0) {
    lines.push(`Files:      ${card.paths.slice(0, 5).join(', ')}${card.paths.length > 5 ? ` +${card.paths.length - 5} more` : ''}`);
  }
  if (card.symbols && card.symbols.length > 0) {
    lines.push(`Symbols:    ${card.symbols.slice(0, 8).join(', ')}${card.symbols.length > 8 ? ` +${card.symbols.length - 8} more` : ''}`);
  }
  if (card.severity) lines.push(`Severity:   ${card.severity}`);
  if (card.createdAt) lines.push(`Date:       ${card.createdAt}`);
  lines.push(`Cite:       https://github.com/issues/${card.issue}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  args.indexDir = resolve(args.indexDir);

  // Validate
  if (!args.queryText && args.files.length === 0 && !args.symbol && !args.doctor) {
    process.stderr.write('Usage: forge recall <query> [--file <path>] [--symbol <name>] [--json] [--k N]\n');
    process.stderr.write('       --file may be repeated for a multi-file union query\n');
    process.stderr.write('       forge recall --doctor   (check index health)\n');
    process.exit(0); // Not an error — just no query
  }

  // Check index exists
  const cardsPath = join(args.indexDir, CARDS_FILE);
  if (!existsSync(cardsPath)) {
    if (args.json) {
      process.stdout.write('[]\n');
    } else {
      process.stderr.write(`[recall] Index not found at ${args.indexDir}\n`);
      process.stderr.write('[recall] Run: node scripts/build-knowledge-index.mjs --full-rebuild\n');
    }
    process.exit(0); // Not an error — index just needs building
  }

  // Load index
  const cards = loadCards(args.indexDir);
  const postings = loadPostings(args.indexDir);

  if (args.doctor) {
    // Doctor mode: show index stats
    const total = cards.length;
    const stale = cards.filter(c => c.status === 'stale').length;
    const byKind = {};
    for (const c of cards) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    const uniqueIssues = new Set(cards.map(c => c.issue)).size;

    process.stdout.write(`Forge Ledger Index Health\n`);
    process.stdout.write(`─────────────────────────\n`);
    process.stdout.write(`Total cards:    ${total}\n`);
    process.stdout.write(`Stale:          ${stale} (${total > 0 ? Math.round(stale / total * 100) : 0}%)\n`);
    process.stdout.write(`Unique issues:  ${uniqueIssues}\n`);
    process.stdout.write(`By kind:        ${JSON.stringify(byKind)}\n`);
    process.stdout.write(`Index dir:      ${args.indexDir}\n`);
    process.exit(0);
  }

  if (cards.length === 0) {
    if (args.json) {
      process.stdout.write('[]\n');
    } else {
      process.stderr.write('[recall] Index is empty. Run: node scripts/build-knowledge-index.mjs --full-rebuild\n');
    }
    process.exit(0);
  }

  // Execute query
  const results = executeQuery(args, cards, postings);

  if (results.length === 0) {
    if (args.json) {
      process.stdout.write('[]\n');
    } else {
      process.stderr.write(`[recall] No results found for query: ${args.queryText || args.files.join(', ') || args.symbol}\n`);
    }
    process.exit(0);
  }

  // Output results
  if (args.json) {
    const output = results.map(({ card, score }) => ({
      id: card.id,
      kind: card.kind,
      issue: card.issue,
      score: Math.round(score * 1000) / 1000,
      paths: card.paths || [],
      symbols: card.symbols || [],
      pattern: card.pattern || null,
      rootCause: card.rootCause || null,
      prevention: card.prevention || null,
      decision: card.decision || null,
      verdict: card.verdict || null,
      confidence: card.confidence || null,
      severity: card.severity || null,
      status: card.status,
      createdAt: card.createdAt || null,
    }));
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    process.stdout.write(`Forge Recall — ${results.length} result(s)\n\n`);
    for (const { card, score } of results) {
      process.stdout.write(formatCard(card, score) + '\n\n');
    }
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`[recall] ERROR: ${e.message}\n`);
  process.exit(1);
}

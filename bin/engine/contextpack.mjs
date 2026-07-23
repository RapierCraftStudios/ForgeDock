/**
 * forge#2701: deterministic (no-LLM) GitHub context miner for the
 * context-pack builder (forge#2680).
 *
 * `mineContext(issueNumber, { io, repo })` pulls the core GitHub state a
 * pipeline phase currently re-derives by hand — issue body/labels/comments,
 * FORGE annotations, linked PRs and their review-finding issues, and
 * knowledge-gist contents — via deterministic `gh` calls. Zero LLM inference
 * anywhere in this module; every field is either raw `gh` output or the
 * result of a regex/registry-driven parse of that output.
 *
 * This is the RAW pre-assembly mined-data object, not a
 * `packages/protocol/src/contextpack-schema.js`-conformant `ContextPack` —
 * turning this into schema-conformant `{schema_version, issue, slices[]}`
 * output is the sibling assembler's job (forge#2702). This module exposes
 * enough structure (parsed affected-file lists, typed FORGE annotations)
 * that the assembler, plus forge#2681 (prior-remediation/failure-history
 * mining, now implemented below) and forge#2682 (sibling in-flight
 * fleet-brief mining, now implemented below) can build on top without
 * re-deriving raw GitHub state themselves.
 *
 * I/O-injection convention (mirrors `bin/engine/phases.mjs`'s
 * `issueMarkers()`/`issueSnapshot()`): every `gh` call goes through an
 * injected `io.gh(args)` async function that returns stdout as a string —
 * this module never shells out itself (no default wiring), so it is
 * unit-testable with a mocked `io.gh` and never makes a live network call in
 * tests. Real wiring is the caller's `bin/engine-cli.mjs`'s `makeIo()`.
 *
 * FORGE annotation/marker parsing goes exclusively through
 * `packages/protocol/src/parse.js` (backed by the `RESERVED_TYPES` registry
 * in `types.js`) — this file declares no inline `<!-- FORGE:X -->` marker
 * regex literals, per the "single-sourced marker registry" rule established
 * in forge#2378/#1669 and enforced structurally in `contextpack-schema.js`
 * and `bin/engine/phases.mjs`.
 *
 * Every fetch that can fail on data absent-for-legitimate-reasons (a
 * deleted/private gist, zero timeline cross-references, zero comments)
 * degrades to an explicit result shape (e.g. `{available: false, error}`)
 * rather than throwing — mirroring the "a transient failure must not be
 * folded into the same result as a genuine empty result" lesson from
 * forge#2211/#2176. The only thrown error is a `TypeError` for a missing/
 * malformed `io.gh`, which is a programmer error, not a runtime-data
 * failure — mirroring `contextpack-schema.js`'s `validateContextPack()` and
 * `parse()`'s own top-level type guards.
 *
 * @license MIT
 */

import { parse } from '../../packages/protocol/src/parse.js';
import { truncateToBytes } from './context-pack.mjs';
import {
  SCHEMA_VERSION,
  PACK_SLICE_NAMES,
  MAX_PACK_BYTES,
  MAX_SLICE_BYTES,
  validateContextPack,
} from '../../packages/protocol/src/contextpack-schema.js';

/** Annotation types whose inline value is a gist/knowledge-index reference
 * (URL). See `packages/protocol/src/types.js` — all three declare
 * `inlineValue: true` and live in `Category.CROSS_ARTIFACT`. `MILESTONE_INDEX`
 * is included because it is documented (`commands/orchestrate/phase-2-triage.md`)
 * as "the milestone index Gist" — though its own protocol fixture shows a
 * non-gist URL is also a legal value; a non-gist URL simply won't match
 * `GIST_ID_RE` below and is reported as `{available:false, error:
 * "unrecognized gist URL shape"}` rather than silently dropped. */
const GIST_ANNOTATION_TYPES = new Set(['KNOWLEDGE_GIST', 'PRIOR_GIST', 'MILESTONE_INDEX']);

/** Annotation types whose body may contain an "## Affected Files" section
 * this module knows how to parse into a file list. Prose-section parsing
 * (markdown headings/list items), NOT FORGE marker parsing — out of
 * `packages/protocol`'s scope, which only owns marker/sentinel syntax. */
const AFFECTED_FILES_SOURCE_TYPES = new Set(['CONTRACT', 'INVESTIGATOR']);

// Matches a "## Affected Files" or "### Affected Files" markdown heading,
// case-sensitive to the exact heading text every FORGE:CONTRACT/INVESTIGATOR
// producer (commands/work-on.md Phase 1C/3C) emits.
const AFFECTED_FILES_HEADING_RE = /^#{2,3}\s*Affected Files\s*$/m;

// Any markdown heading (used as the "next section" boundary when slicing
// the Affected Files section out of a larger annotation body).
const ANY_HEADING_RE = /^#{1,6}\s+\S/m;

// A single affected-file list line, e.g.:
//   1. `bin/engine/contextpack.mjs` (new) — exports mineContext()
//   - `packages/protocol/src/phases.js` — read-only import
// Captures the first backtick-quoted path on the line.
const FILE_LIST_LINE_RE = /^\s*(?:[-*]|\d+[.)])\s+`([^`]+)`/;

// gist.github.com URL → gist id (path segment after the optional username).
// Real gist ids are lowercase hex, but this is deliberately alphanumeric
// (not hex-only) so it doesn't reject a legitimately-shaped gist URL whose
// id happens to use a non-hex character in some future gist ID format.
const GIST_ID_RE = /gist\.github\.com\/(?:[^/\s]+\/)?([0-9a-zA-Z]+)/;

function assertIo(io) {
  if (!io || typeof io.gh !== 'function') {
    throw new TypeError('mineContext() requires opts.io.gh(args) — this module has no default gh wiring');
  }
}

/** Build the trailing `-R {repo}` args, or an empty array when no explicit
 * repo was given (falls back to gh's own cwd-implicit repo resolution). */
function repoArgs(repo) {
  return repo ? ['-R', repo] : [];
}

/**
 * Split a `gh api --paginate --jq '[...]'` stdout blob into its per-page
 * JSON array literals. `--paginate` runs the `--jq` filter once PER page and
 * concatenates each page's output; for an array-producing filter, that
 * yields one top-level `[...]` array literal per page, one after another,
 * with only whitespace (never a delimiter) between them.
 *
 * A naive "split on `][`" fails whenever any non-whitespace text sits
 * between two pages (e.g. a malformed/garbled page) — the boundary pattern
 * simply never occurs, so the whole blob collapses into one unparseable
 * chunk and every page is lost. This instead scans for each top-level `[`
 * and walks forward tracking bracket depth (respecting quoted strings, so a
 * `]`/`[` inside a string value is never mistaken for a structural
 * boundary) until the matching `]`, extracting exactly that substring as one
 * page — regardless of what garbage text, if any, sits between pages.
 *
 * Returns `{pages, hadGapContent}` — `hadGapContent` is true when any
 * non-whitespace text existed outside every extracted array (before the
 * first, between two, or after the last), the signal a caller uses to
 * report a partial-parse-failure without dropping the pages that DID parse.
 */
function extractJsonArrayPages(text) {
  const pages = [];
  let hadGapContent = false;
  const str = String(text || '');
  const n = str.length;
  let i = 0;
  let lastEnd = 0;

  while (i < n) {
    while (i < n && str[i] !== '[') i++;
    if (i >= n) break;
    if (str.slice(lastEnd, i).trim().length > 0) hadGapContent = true;

    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < n; i++) {
      const ch = str[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    pages.push(str.slice(start, i));
    lastEnd = i;
  }

  if (str.slice(lastEnd).trim().length > 0) hadGapContent = true;
  return { pages, hadGapContent };
}

/**
 * Fetch issue core state: number, title, body, labels, state, milestone.
 * Returns `{ok: false}` (never throws) on any fetch/parse failure, mirroring
 * `phases.mjs`'s `issueSnapshot()` fail-open contract.
 */
async function fetchIssueCore(issueNumber, io, repo) {
  let out;
  try {
    out = await io.gh([
      'issue',
      'view',
      String(issueNumber),
      '--json',
      'number,title,body,labels,state,milestone',
      ...repoArgs(repo),
    ]);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
  let json;
  try {
    json = JSON.parse(out || '{}');
  } catch {
    return { ok: false, error: 'unparseable gh issue view output' };
  }
  return {
    ok: true,
    number: json.number ?? issueNumber,
    title: json.title ?? '',
    body: json.body ?? '',
    labels: Array.isArray(json.labels) ? json.labels.map((l) => (typeof l === 'string' ? l : l.name || '')) : [],
    state: json.state ?? null,
    milestone: json.milestone ? json.milestone.title || null : null,
  };
}

/**
 * Fetch ALL comments on the issue, paginating through every page rather than
 * silently stopping at the first ~100 (`gh api --paginate` walks every page;
 * `--jq` runs once PER page and each page's jq output is concatenated, which
 * for an array-producing filter yields one JSON array literal per page back
 * to back on stdout — NOT one big array). Each page's array is parsed
 * independently and flattened, so this is correct regardless of how many
 * pages exist. A page whose output fails to parse is skipped (not fatal —
 * mirrors `issueMarkers()`'s parse-failure fallback) rather than aborting
 * pagination for every other page.
 */
async function fetchAllComments(issueNumber, io, repo) {
  let out;
  try {
    out = await io.gh([
      'api',
      `repos/${repo || '{owner}/{repo}'}/issues/${issueNumber}/comments`,
      '--paginate',
      '--jq',
      '[.[] | {id: .id, author: .user.login, body: .body, createdAt: .created_at}]',
    ]);
  } catch (err) {
    // A genuine fetch failure (auth/rate-limit/network) MUST be distinguishable
    // from a real zero-comment issue — folding both into `comments: []` would
    // silently misreport "no pipeline history" for an issue that actually has
    // extensive history but happened to hit a transient gh failure. The caller
    // (mineContext()) surfaces this via `meta.commentsFetchError`.
    return { comments: [], fetchError: String(err && err.message ? err.message : err) };
  }

  const comments = [];
  let sawParseFailure = false;
  const { pages: pageTexts, hadGapContent } = extractJsonArrayPages(out);
  if (hadGapContent) sawParseFailure = true;

  for (const pageText of pageTexts) {
    try {
      const page = JSON.parse(pageText);
      if (Array.isArray(page)) {
        for (const c of page) {
          comments.push({
            id: c && c.id != null ? c.id : null,
            author: (c && c.author) || '',
            body: (c && c.body) || '',
            createdAt: (c && c.createdAt) || null,
          });
        }
      } else {
        sawParseFailure = true;
      }
    } catch {
      sawParseFailure = true;
    }
  }

  return { comments, ...(sawParseFailure ? { partialParseFailure: true } : {}) };
}

/**
 * Parse every comment's FORGE annotations via `packages/protocol/src/parse.js`
 * and attach the source comment's index/id so downstream consumers can trace
 * an annotation back to the comment that posted it (mirrors the per-comment
 * scoping lesson from forge#2184 — never treat annotations as a
 * blob-wide/unscoped soup).
 */
function parseAnnotations(comments) {
  const annotations = [];
  comments.forEach((comment, commentIndex) => {
    let parsed;
    try {
      parsed = parse(comment.body || '');
    } catch {
      parsed = [];
    }
    for (const annotation of parsed) {
      annotations.push({ ...annotation, commentIndex, commentId: comment.id });
    }
  });
  return annotations;
}

/**
 * Slice the "## Affected Files" section out of an annotation body (from the
 * heading through to the next heading or end-of-body) and extract every
 * backtick-quoted file path from its list items.
 */
function extractAffectedFilesFromBody(body) {
  const headingMatch = AFFECTED_FILES_HEADING_RE.exec(body);
  if (!headingMatch) return [];
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(sectionStart);
  ANY_HEADING_RE.lastIndex = 0;
  const nextHeadingMatch = ANY_HEADING_RE.exec(rest);
  const sectionText = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;

  const files = [];
  for (const line of sectionText.split('\n')) {
    const m = line.match(FILE_LIST_LINE_RE);
    if (m) files.push(m[1]);
  }
  return files;
}

// Matches a "## Deliverables" or "### Deliverables" markdown heading — the
// table every FORGE:CONTRACT producer (commands/work-on.md Phase 3C /
// commands/work-on/build.md Phase B2) emits: `| File | Change | Why |`.
const DELIVERABLES_HEADING_RE = /^#{2,3}\s*Deliverables\s*$/m;

// A markdown table divider row, e.g. `|------|--------|-----|` — every
// character is one of `|`, `-`, `:`, or whitespace.
const TABLE_DIVIDER_RE = /^[\s|:-]+$/;

/**
 * Split a Markdown table row on structural pipes. A pipe is escaped only when
 * preceded by an odd-length backslash run; paired backslashes remain content.
 * The escaping backslash is removed without using a collision-prone sentinel.
 */
export function splitMarkdownTableRow(line) {
  const cells = [];
  let cell = '';
  let backslashRun = 0;

  for (const ch of line) {
    if (ch === '\\') {
      cell += ch;
      backslashRun++;
      continue;
    }

    if (ch === '|') {
      if (backslashRun % 2 === 1) {
        cell = `${cell.slice(0, -1)}|`;
      } else {
        cells.push(cell);
        cell = '';
      }
    } else {
      cell += ch;
    }
    backslashRun = 0;
  }

  return cells;
}

/**
 * Slice the "## Deliverables" section out of a CONTRACT annotation body (the
 * heading through the next heading or end-of-body) and extract each table
 * row's file + change columns. Prose-section (markdown table) parsing, NOT
 * FORGE marker parsing — same out-of-`packages/protocol`-scope precedent as
 * `extractAffectedFilesFromBody()` above (see that function's docblock).
 *
 * Deliberately conservative: any row that doesn't match the strict
 * `| col | col |` shape, the header row (`File` in the first column), or the
 * divider row is skipped rather than guessed at — a partial/malformed table
 * degrades to a shorter (possibly empty) deliverables list, never a crash or
 * a garbled entry (forge#2682's fail-open guard extends to parsing, not just
 * network fetches).
 *
 * @param {string} body
 * @returns {Array<{file: string, change: string}>}
 */
function extractDeliverablesFromBody(body) {
  if (typeof body !== 'string' || !body) return [];
  const headingMatch = DELIVERABLES_HEADING_RE.exec(body);
  if (!headingMatch) return [];
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(sectionStart);
  ANY_HEADING_RE.lastIndex = 0;
  const nextHeadingMatch = ANY_HEADING_RE.exec(rest);
  const sectionText = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;

  const rows = [];
  for (const line of sectionText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const withoutPipes = trimmed.replace(/\|/g, '');
    if (TABLE_DIVIDER_RE.test(withoutPipes) && withoutPipes.includes('-')) continue; // divider row
    const cells = splitMarkdownTableRow(trimmed);
    if (cells.length < 3) continue;
    const file = cells[1].replace(/`/g, '').trim();
    const change = cells[2].trim();
    if (!file || /^file$/i.test(file)) continue; // header row
    rows.push({ file, change });
  }
  return rows;
}

/**
 * Merge affected-file lists from every CONTRACT/INVESTIGATOR annotation
 * found on the issue, de-duplicated and in first-seen order. Later
 * annotations (a re-investigation, a re-contracted scope change) simply add
 * to the set rather than replacing it — this module does not attempt to
 * decide which annotation is "the latest word"; that judgment belongs to a
 * consumer that can see the full annotation list with sentinel state.
 */
function extractAffectedFiles(annotations) {
  const seen = new Set();
  const files = [];
  for (const annotation of annotations) {
    if (!AFFECTED_FILES_SOURCE_TYPES.has(annotation.type)) continue;
    for (const file of extractAffectedFilesFromBody(annotation.body || '')) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

/**
 * Resolve gist references from KNOWLEDGE_GIST/PRIOR_GIST annotations
 * (`inlineValue` carries the gist URL, per the reserved-type registry — see
 * `packages/protocol/src/types.js`) and fetch each gist's content.
 *
 * A gist that is missing, deleted, or otherwise unfetchable is reported as
 * `{available: false, error}` rather than throwing — one bad gist reference
 * must not abort mining of the rest of the issue's context.
 */
async function fetchGists(annotations, io) {
  const urls = [];
  const seen = new Set();
  for (const annotation of annotations) {
    if (!GIST_ANNOTATION_TYPES.has(annotation.type)) continue;
    const url = annotation.inlineValue;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  const results = [];
  for (const url of urls) {
    const idMatch = GIST_ID_RE.exec(url);
    if (!idMatch) {
      results.push({ url, available: false, content: null, error: 'unrecognized gist URL shape' });
      continue;
    }
    const gistId = idMatch[1];
    try {
      const content = await io.gh(['gist', 'view', gistId, '--raw']);
      results.push({ url, gistId, available: true, content, error: null });
    } catch (err) {
      results.push({
        url,
        gistId,
        available: false,
        content: null,
        error: String(err && err.message ? err.message : err),
      });
    }
  }
  return results;
}

/**
 * Resolve every PR cross-referencing this issue via the issue timeline API
 * (`event: "cross-referenced"` entries whose source is a pull request) —
 * NOT `Closes #N` text matching, which both false-negatives (any other
 * closing keyword: `Fixes`, `Resolves`, informal phrasing) and
 * false-positives (a `Closes #N` mention inside an unrelated code block or
 * quoted text). This is the same signal GitHub's own UI uses to render
 * "Development: linked pull requests".
 *
 * Returns an empty array (not an error) when the issue has no linked PRs —
 * that is the overwhelmingly common, entirely legitimate case (a
 * not-yet-built issue), not a failure.
 */
async function fetchLinkedPrNumbers(issueNumber, io, repo) {
  let out;
  try {
    out = await io.gh([
      'api',
      `repos/${repo || '{owner}/{repo}'}/issues/${issueNumber}/timeline`,
      '--paginate',
      '--jq',
      '[.[] | select(.event == "cross-referenced") | select(.source.issue.pull_request != null) | .source.issue.number]',
    ]);
  } catch (err) {
    // A genuine timeline-fetch failure must be distinguishable from the
    // legitimate "no linked PRs yet" case — see fetchAllComments()'s identical
    // fail-open contract above. The caller (mineContext()) surfaces this via
    // `meta.linkedPrsFetchError`.
    return { numbers: [], fetchError: String(err && err.message ? err.message : err) };
  }

  const { pages: pageTexts } = extractJsonArrayPages(out);

  const numbers = new Set();
  for (const pageText of pageTexts) {
    try {
      const page = JSON.parse(pageText);
      if (Array.isArray(page)) {
        for (const n of page) {
          if (typeof n === 'number') numbers.add(n);
        }
      }
    } catch {
      // Skip an unparseable page — best-effort, mirrors fetchAllComments().
    }
  }
  return { numbers: [...numbers] };
}

/**
 * Fetch review-finding issues referencing a given PR number — issues labeled
 * `review-finding` whose body mentions `#{prNumber}` (the format every
 * review-finding producer, `commands/review-pr.md`, emits: "review finding —
 * PR #N" or an equivalent cross-reference).
 */
async function fetchReviewFindingsForPr(prNumber, io, repo) {
  let out;
  try {
    out = await io.gh([
      'issue',
      'list',
      '--label',
      'review-finding',
      '--search',
      `#${prNumber} in:body`,
      '--state',
      'all',
      '--json',
      'number,title',
      ...repoArgs(repo),
    ]);
  } catch (err) {
    // Same fail-open contract as fetchAllComments()/fetchLinkedPrNumbers(): a
    // genuine fetch failure must not collapse into "this PR has zero review
    // findings" — surfaced via meta.reviewFindingsFetchErrors[prNumber].
    return { items: [], fetchError: String(err && err.message ? err.message : err) };
  }
  try {
    const parsed = JSON.parse(out || '[]');
    return { items: Array.isArray(parsed) ? parsed.map((i) => ({ number: i.number, title: i.title })) : [] };
  } catch (err) {
    return { items: [], fetchError: `unparseable gh issue list output: ${String(err && err.message ? err.message : err)}` };
  }
}

/**
 * Maximum number of file-basename search terms `fetchFailureMemory()` will
 * issue `gh issue list --search` calls for. Bounds the fan-out (2 calls per
 * term — review-finding + workflow:invalid) the same way
 * `fetchReviewFindingsForPr()`'s per-PR loop is bounded by the number of
 * linked PRs, not by an explicit cap of its own — here there is no natural
 * cap on `affectedFiles.length`, so one is set explicitly.
 */
const MAX_FAILURE_MEMORY_SEARCH_TERMS = 5;

/** Maximum number of ranked failure-memory items `rankFailureMemory()`
 * returns. Keeps the rendered excerpt bounded before it even reaches
 * `truncateToBytes()` — mirrors `renderLinkedPrsExcerpt()`'s `.slice(0, 10)`
 * per-PR finding cap. */
const MAX_FAILURE_MEMORY_ITEMS = 10;

/**
 * Derive `gh issue list --search` terms from affected-file paths: the
 * basename only (e.g. `bin/engine/contextpack.mjs` -> `contextpack.mjs`),
 * deduplicated, capped to `MAX_FAILURE_MEMORY_SEARCH_TERMS`. Using the
 * basename (not the full path, not a bare extension) keeps search terms
 * specific enough to avoid noisy false-positive matches — a bare `mjs`
 * term would match nearly every issue in a JS-heavy repo.
 */
function deriveFailureMemorySearchTerms(affectedFiles) {
  if (!Array.isArray(affectedFiles)) return [];
  const seen = new Set();
  const terms = [];
  for (const file of affectedFiles) {
    if (typeof file !== 'string' || !file) continue;
    const basename = file.split('/').pop();
    if (!basename || seen.has(basename)) continue;
    seen.add(basename);
    terms.push(basename);
    if (terms.length >= MAX_FAILURE_MEMORY_SEARCH_TERMS) break;
  }
  return terms;
}

/**
 * Run one `gh issue list --state closed --label {label} --search {term}`
 * query and normalize its result. Fail-open per call: a `gh` failure
 * returns `{items: [], fetchError}` rather than throwing or silently
 * reporting zero results — the same contract `fetchReviewFindingsForPr()`
 * establishes (see forge#2715/#2716/#2717, review findings on PR #2713,
 * for the bug class this guards against: a discarded error indistinguishable
 * from a genuine empty result).
 */
async function fetchFailureMemoryForTerm(term, label, io, repo) {
  let out;
  try {
    out = await io.gh([
      'issue',
      'list',
      '--state',
      'closed',
      '--label',
      label,
      '--search',
      term,
      '--json',
      'number,title,body,closedAt',
      ...repoArgs(repo),
    ]);
  } catch (err) {
    return { items: [], fetchError: String(err && err.message ? err.message : err) };
  }
  try {
    const parsed = JSON.parse(out || '[]');
    return {
      items: Array.isArray(parsed)
        ? parsed.map((i) => ({
            number: i.number,
            title: i.title || '',
            body: i.body || '',
            closedAt: i.closedAt || null,
            label,
          }))
        : [],
    };
  } catch (err) {
    return { items: [], fetchError: `unparseable gh issue list output: ${String(err && err.message ? err.message : err)}` };
  }
}

/**
 * Mine prior-failure/finding history for the modules an issue touches:
 * closed `review-finding` issues and closed `workflow:invalid` issues whose
 * title/body/search-index mentions one of `affectedFiles`'s basenames.
 * Deterministic, no-LLM (forge#2681) — every item returned is a raw `gh`
 * result, not a synthesized summary.
 *
 * Fail-open: any single `gh` call failing degrades that call's contribution
 * to an empty list plus a recorded error (surfaced by the caller via
 * `meta.failureMemoryFetchErrors`); it never throws and never blanks items
 * already successfully fetched from other terms/labels.
 *
 * @param {string[]} affectedFiles
 * @param {{gh: Function}} io
 * @param {string} [repo]
 * @returns {Promise<{items: Object[], fetchErrors: string[]}>}
 */
async function fetchFailureMemory(affectedFiles, io, repo) {
  const terms = deriveFailureMemorySearchTerms(affectedFiles);
  if (terms.length === 0) return { items: [], fetchErrors: [] };

  const seen = new Set();
  const items = [];
  const fetchErrors = [];

  for (const term of terms) {
    for (const label of ['review-finding', 'workflow:invalid']) {
      const { items: found, fetchError } = await fetchFailureMemoryForTerm(term, label, io, repo);
      if (fetchError) fetchErrors.push(`${label}/"${term}": ${fetchError}`);
      for (const item of found) {
        if (item.number == null || seen.has(item.number)) continue;
        seen.add(item.number);
        items.push(item);
      }
    }
  }

  return { items, fetchErrors };
}

/**
 * Rank failure-memory items deterministically — same-module hit count
 * (desc) first, tie-broken by recency (closedAt desc). No embedding/LLM
 * similarity scoring anywhere, per forge#2681's explicit "Deterministic
 * ranking (recency × same-module hits) — no embedding/LLM similarity in
 * v1" requirement. Items whose same-module hit count is 0 (matched only by
 * the GitHub search API's own relevance ranking, not an actual basename
 * mention in title/body) are dropped — this is the primary noise filter
 * against overly broad search-API matches.
 *
 * Pure function — no I/O.
 *
 * @param {Object[]} items - raw items from `fetchFailureMemory()`
 * @param {string[]} affectedFiles
 * @returns {Object[]} ranked, filtered, capped to `MAX_FAILURE_MEMORY_ITEMS`
 */
function rankFailureMemory(items, affectedFiles) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const basenames = Array.isArray(affectedFiles)
    ? [...new Set(affectedFiles.map((f) => (typeof f === 'string' ? f.split('/').pop() : '')).filter(Boolean))]
    : [];

  const scored = items.map((item) => {
    const haystack = `${item.title || ''}\n${item.body || ''}`.toLowerCase();
    const hitCount = basenames.reduce((n, b) => (b && haystack.includes(b.toLowerCase()) ? n + 1 : n), 0);
    return { item, hitCount };
  });

  return scored
    .filter((s) => s.hitCount > 0)
    .sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      const aTime = a.item.closedAt ? Date.parse(a.item.closedAt) : 0;
      const bTime = b.item.closedAt ? Date.parse(b.item.closedAt) : 0;
      return bTime - aTime;
    })
    .slice(0, MAX_FAILURE_MEMORY_ITEMS)
    .map((s) => s.item);
}

/**
 * Render ranked failure-memory items as a bounded excerpt: heading + one
 * bullet per item, quoted title + issue number + label only — never
 * synthesized prose, per forge#2681's "Injected content is quoted history
 * with issue/PR links — never synthesized prose — so an agent can verify
 * any claim at the source" safety guard. Returns "" for an empty list.
 *
 * Pure function — no I/O.
 */
function renderFailureMemoryExcerpt(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = ['## Prior Failures / Findings on These Modules'];
  for (const item of items) {
    if (!item || item.number == null) continue;
    const kind = item.label === 'workflow:invalid' ? 'closed as invalid' : 'review finding';
    lines.push(`- #${item.number} (${kind}): ${item.title || ''}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * forge#2682: maximum number of in-flight sibling issues `fetchFleetBrief()`
 * will fetch a contract for. Bounds the fan-out (2 `gh` calls per sibling —
 * issue view + comments) the same way `MAX_FAILURE_MEMORY_SEARCH_TERMS`
 * bounds `fetchFailureMemory()`'s: the caller-supplied `inFlightSiblings`
 * list has no natural cap of its own (an orchestrator dispatching a large
 * milestone could plausibly hand this many more sibling numbers than are
 * worth rendering into one context-pack slice), so one is set explicitly
 * here. Value is the issue's own explicit acceptance criterion ("Size-capped:
 * one line per sibling beyond N=10 siblings; in-band truncation marker" —
 * forge#2682 Safety/scope guards).
 */
const MAX_FLEET_BRIEF_SIBLINGS = 10;

/** Fixed, never-varied trailer appended to every non-empty fleet-brief
 * excerpt — a behavioral-contract disclaimer, not synthesized prose (see
 * `renderFleetBriefExcerpt()`'s docblock for why this must stay a literal
 * constant rather than being composed per-render). */
const FLEET_BRIEF_TRAILER =
  'Snapshot of declared scope from in-flight sibling issues at pack-build time — not a live guarantee. A sibling\'s actual deliverables may change before it merges; do not treat this as a merged/locked contract.';

/**
 * Fetch one in-flight sibling's declared contract surface: issue core
 * (title/labels) + comments -> latest CONTRACT annotation's affected-files
 * and deliverables. Fail-open per sibling (mirrors
 * `fetchFailureMemoryForTerm()`'s per-call contract): a sibling that cannot
 * be fetched, or that has no CONTRACT annotation yet (still investigating,
 * or a TRIVIAL task that skipped the Builder Contract phase entirely — see
 * `commands/work-on.md` Phase 3B), degrades to `{number, contractUnknown:
 * true, ...}` rather than throwing or being silently omitted — the caller
 * (`fetchFleetBrief()`) always gets exactly one result per requested
 * sibling number.
 *
 * @param {number} siblingNumber
 * @param {{gh: Function}} io
 * @param {string} [repo]
 * @returns {Promise<Object>}
 */
async function fetchFleetBriefForSibling(siblingNumber, io, repo) {
  const issue = await fetchIssueCore(siblingNumber, io, repo);
  if (!issue.ok) {
    return { number: siblingNumber, contractUnknown: true, error: issue.error || 'issue fetch failed' };
  }

  const { comments, fetchError: commentsFetchError } = await fetchAllComments(siblingNumber, io, repo);
  if (commentsFetchError) {
    return {
      number: siblingNumber,
      title: issue.title,
      labels: issue.labels,
      contractUnknown: true,
      error: commentsFetchError,
    };
  }

  const annotations = parseAnnotations(comments);
  const contractAnnotations = annotations.filter((a) => a.type === 'CONTRACT');
  // Last-in-comment-order CONTRACT annotation is the current one — mirrors
  // `extractAffectedFiles()`'s "later annotations add to, do not replace"
  // stance being inapplicable here: a fleet brief wants THE current declared
  // scope, not a merged history of every re-contracted revision.
  const latestContract = contractAnnotations.length > 0 ? contractAnnotations[contractAnnotations.length - 1] : null;

  if (!latestContract) {
    return { number: siblingNumber, title: issue.title, labels: issue.labels, contractUnknown: true };
  }

  return {
    number: siblingNumber,
    title: issue.title,
    labels: issue.labels,
    contractUnknown: false,
    affectedFiles: extractAffectedFilesFromBody(latestContract.body || ''),
    deliverables: extractDeliverablesFromBody(latestContract.body || ''),
  };
}

/**
 * Batch-fetch declared contract surfaces for every caller-supplied in-flight
 * sibling issue number. Dedupes, drops a self-reference (a caller
 * accidentally including its own issue number must not turn into a
 * "sibling" of itself), and caps to `MAX_FLEET_BRIEF_SIBLINGS` — tracking
 * how many were dropped by the cap so the render layer can surface an
 * honest "N more omitted" note rather than silently truncating.
 *
 * @param {Array<number|string>} inFlightSiblings - caller-supplied list,
 *   e.g. resolved from `bin/runner.mjs`'s `resolveInFlightSiblings()`.
 * @param {number|string} selfIssueNumber - the issue `mineContext()` is
 *   building a pack for; excluded from the sibling list if present.
 * @param {{gh: Function}} io
 * @param {string} [repo]
 * @returns {Promise<{items: Object[], omittedCount: number}>}
 */
async function fetchFleetBrief(inFlightSiblings, selfIssueNumber, io, repo) {
  if (!Array.isArray(inFlightSiblings) || inFlightSiblings.length === 0) {
    return { items: [], omittedCount: 0 };
  }

  const selfNum = typeof selfIssueNumber === 'number' ? selfIssueNumber : Number(selfIssueNumber);
  const seen = new Set();
  const deduped = [];
  for (const raw of inFlightSiblings) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    // A valid GitHub issue number is a positive integer — `Number('')`/
    // `Number('  ')` both coerce to `0`, which `Number.isFinite()` alone
    // would accept, turning an empty/whitespace token from a caller (e.g.
    // `bin/runner.mjs`'s env-var-parsed list) into a phantom "sibling #0"
    // fetch. Guarding here too (not just at the runner.mjs env-parsing
    // layer) keeps this module correct for any direct caller, not only the
    // one that happens to sanitize first (review finding on PR #2744).
    if (!Number.isInteger(n) || n <= 0 || n === selfNum || seen.has(n)) continue;
    seen.add(n);
    deduped.push(n);
  }

  const omittedCount = Math.max(0, deduped.length - MAX_FLEET_BRIEF_SIBLINGS);
  const capped = deduped.slice(0, MAX_FLEET_BRIEF_SIBLINGS);

  const items = [];
  for (const siblingNumber of capped) {
    try {
      items.push(await fetchFleetBriefForSibling(siblingNumber, io, repo));
    } catch (err) {
      // Defense in depth — fetchFleetBriefForSibling() is itself fail-open,
      // but a bug in it must never abort the batch for every other sibling
      // (mirrors mineContext()'s own per-field try/catch pattern below).
      items.push({ number: siblingNumber, contractUnknown: true, error: String(err && err.message ? err.message : err) });
    }
  }

  return { items, omittedCount };
}

/**
 * Deterministic, ascending-issue-number ordering. No relevance ranking is
 * needed here (unlike `rankFailureMemory()`'s hit-count/recency scoring) —
 * the sibling list is already caller-curated (an orchestrator's own
 * dependency/dispatch set), so the only ordering question is "what's a
 * stable, predictable order to render them in", and issue number satisfies
 * that trivially. Pure function — no I/O.
 *
 * @param {Object[]} items
 * @returns {Object[]}
 */
function rankFleetBrief(items) {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => (a && a.number != null ? a.number : 0) - (b && b.number != null ? b.number : 0));
}

/**
 * Render ranked fleet-brief items as a bounded excerpt: heading + one entry
 * per sibling (declared deliverables as a nested list when known, an
 * explicit "contract unknown" note otherwise) + an omitted-count note when
 * the cap dropped any + a fixed behavioral-contract trailer. Never
 * synthesizes prose about a sibling's intent — only quoted title, quoted
 * file paths, and quoted change descriptions already present in that
 * sibling's own CONTRACT annotation, mirroring
 * `renderFailureMemoryExcerpt()`'s "quoted history, never synthesized
 * prose" safety guard. Returns "" for an empty item list.
 *
 * Pure function — no I/O.
 *
 * @param {Object[]} items
 * @param {number} [omittedCount]
 * @returns {string}
 */
function renderFleetBriefExcerpt(items, omittedCount = 0) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const ranked = rankFleetBrief(items);
  const lines = ['## In-Flight Sibling Contracts (Fleet Brief)'];
  for (const item of ranked) {
    if (!item || item.number == null) continue;
    const titleSuffix = item.title ? `: ${item.title}` : '';
    if (item.contractUnknown) {
      lines.push(`- #${item.number}${titleSuffix} — contract unknown${item.error ? ` (${item.error})` : ''}`);
      continue;
    }
    lines.push(`- #${item.number}${titleSuffix}`);
    if (Array.isArray(item.deliverables) && item.deliverables.length > 0) {
      for (const d of item.deliverables.slice(0, 10)) {
        if (d && d.file) lines.push(`  - \`${d.file}\` — ${d.change || ''}`);
      }
    } else if (Array.isArray(item.affectedFiles) && item.affectedFiles.length > 0) {
      for (const f of item.affectedFiles.slice(0, 10)) {
        lines.push(`  - \`${f}\``);
      }
    }
  }
  if (omittedCount > 0) {
    lines.push(`- _(${omittedCount} additional in-flight sibling(s) omitted — fleet brief capped at ${MAX_FLEET_BRIEF_SIBLINGS})_`);
  }
  lines.push('');
  lines.push(`> ${FLEET_BRIEF_TRAILER}`);
  return lines.join('\n');
}

/**
 * Mine deterministic, structured GitHub context for `issueNumber`. Zero LLM
 * calls — every field below is either raw `gh` output or a regex/registry
 * parse of that output.
 *
 * @param {number|string} issueNumber
 * @param {{io: {gh: Function}, repo?: string, inFlightSiblings?: Array<number|string>}} opts -
 *   `io.gh(args)` is REQUIRED (no default wiring — see module docblock).
 *   `repo` is an optional explicit `owner/repo` string threaded to every
 *   `gh` call via `-R`, which is what makes this module work correctly for
 *   satellite (`forge.yaml → repos.satellites`) issues regardless of the
 *   caller's cwd — the caller is responsible for resolving a `<prefix>:N`
 *   reference to its satellite's `repo` before calling `mineContext()`. When
 *   omitted, `gh`'s own cwd-implicit repo resolution is used.
 *   `inFlightSiblings` (forge#2682) is an optional list of other issue
 *   numbers currently in-flight in the same dispatch batch (e.g. an
 *   `/orchestrate` run's sibling issues); when omitted or empty, `fleetBrief`
 *   resolves to `{items: [], omittedCount: 0}` and today's exact output is
 *   unchanged.
 * @returns {Promise<Object>} raw pre-assembly mined-data object — NOT a
 *   `packages/protocol/src/contextpack-schema.js`-conformant `ContextPack`.
 */
export async function mineContext(issueNumber, opts = {}) {
  const { io, repo, inFlightSiblings = [] } = opts;
  assertIo(io);

  const issue = await fetchIssueCore(issueNumber, io, repo);
  const { comments, fetchError: commentsFetchError, partialParseFailure } = await fetchAllComments(
    issueNumber,
    io,
    repo,
  );
  const annotations = parseAnnotations(comments);
  const affectedFiles = extractAffectedFiles(annotations);
  const gists = await fetchGists(annotations, io);

  const { numbers: prNumbers, fetchError: linkedPrsFetchError } = await fetchLinkedPrNumbers(
    issueNumber,
    io,
    repo,
  );
  const linkedPrs = [];
  const reviewFindingsFetchErrors = {};
  for (const prNumber of prNumbers) {
    const { items: reviewFindings, fetchError: reviewFindingsFetchError } = await fetchReviewFindingsForPr(
      prNumber,
      io,
      repo,
    );
    if (reviewFindingsFetchError) reviewFindingsFetchErrors[prNumber] = reviewFindingsFetchError;
    linkedPrs.push({ number: prNumber, reviewFindings });
  }

  // forge#2681: prior-remediation/failure-history mining. Wrapped in its own
  // try/catch even though `fetchFailureMemory()` is internally fail-open —
  // defense in depth, matching the existing per-field pattern above: a bug
  // in the new mining path must never propagate out of `mineContext()` and
  // blank fields (issue, comments, annotations, ...) that were already
  // successfully mined.
  let failureMemory = [];
  let failureMemoryFetchErrors = [];
  try {
    const result = await fetchFailureMemory(affectedFiles, io, repo);
    failureMemory = result.items;
    failureMemoryFetchErrors = result.fetchErrors;
  } catch (err) {
    failureMemoryFetchErrors = [String(err && err.message ? err.message : err)];
  }

  // forge#2682: in-flight sibling fleet-brief mining. Wrapped in its own
  // try/catch — same defense-in-depth rationale as failureMemory above: a
  // bug in the new mining path must never propagate out of mineContext() and
  // blank fields that were already successfully mined.
  let fleetBrief = { items: [], omittedCount: 0 };
  let fleetBriefFetchErrors = [];
  try {
    fleetBrief = await fetchFleetBrief(inFlightSiblings, issueNumber, io, repo);
    fleetBriefFetchErrors = fleetBrief.items
      .filter((item) => item && item.error)
      .map((item) => `#${item.number}: ${item.error}`);
  } catch (err) {
    fleetBriefFetchErrors = [String(err && err.message ? err.message : err)];
  }

  return {
    issue,
    comments,
    annotations,
    affectedFiles,
    linkedPrs,
    gists,
    failureMemory,
    fleetBrief,
    meta: {
      issueNumber: typeof issueNumber === 'number' ? issueNumber : Number(issueNumber),
      repo: repo || null,
      commentCount: comments.length,
      // Every *Error field below distinguishes "we tried and gh failed" from a
      // genuinely empty/legitimate result — see fetchAllComments()'s docblock
      // for the fail-open contract this mirrors throughout the module. Fields
      // are only present when the corresponding failure actually occurred, so
      // a clean mine (the overwhelmingly common case) has a lean meta object.
      ...(commentsFetchError ? { commentsFetchError } : {}),
      ...(partialParseFailure ? { partialParseFailure: true } : {}),
      ...(linkedPrsFetchError ? { linkedPrsFetchError } : {}),
      ...(Object.keys(reviewFindingsFetchErrors).length > 0 ? { reviewFindingsFetchErrors } : {}),
      ...(failureMemoryFetchErrors.length > 0 ? { failureMemoryFetchErrors } : {}),
      ...(fleetBriefFetchErrors.length > 0 ? { fleetBriefFetchErrors } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// forge#2702: schema-conformant per-phase pack assembler
// ---------------------------------------------------------------------------
//
// The functions below turn `mineContext()`'s raw pre-assembly output into a
// `packages/protocol/src/contextpack-schema.js`-conformant `ContextPack`
// (`assemblePack()`) and flatten that pack into the plain string
// `bin/runner.mjs`'s pre-existing `opts.contextPack` injection point expects
// (`renderPackAsText()`). Neither function performs any I/O — both are pure
// given `minedData` (already fetched by `mineContext()`), mirroring the
// "assembly is pure, fetching happens in the caller" split established by
// `bin/engine/context-pack.mjs`'s `buildContextPack()` (forge#2383).
//
// This is a SEPARATE pack from forge#2383's `context-pack.mjs`/
// `buildContextPack()`, which remains live, unconditional, and un-schema'd.
// The two must never collide — see `bin/runner.mjs`'s `context_packs.enabled`
// wiring (forge#2702), which only builds this pack when the caller has not
// already supplied a `contextPack` string (i.e. when forge#2383's engine
// dispatch path hasn't already populated one).

/**
 * Maps an engine phase id (`packages/protocol/src/phases.js`'s `PHASE_IDS`)
 * to the narrower `PACK_SLICE_NAMES` set this schema defines
 * (`investigate`/`build`/`review`). Not every phase id has a natural slice:
 * `decompose` and `close` produce no pack (there is no meaningful
 * "prior context" a decomposition or close phase needs beyond what its own
 * spec already tells it to fetch), so `assemblePack()` returns `null` for
 * those — the caller's fail-open contract treats `null` identically to "no
 * pack was requested", which is exactly today's behavior for those phases.
 * `context`/`architect` map onto the `investigate`/`build` slices they most
 * resemble (context-gathering augments an investigation; architecture
 * planning precedes and feeds a build) rather than getting their own
 * PACK_SLICE_NAMES entries — the schema deliberately does not grow a slice
 * name per engine phase id (see contextpack-schema.js's PACK_SLICE_NAMES
 * doc comment: "expected to grow independently of the phase table").
 * `remediate` maps onto `review` — a remediation is itself a follow-up
 * review round.
 */
const PHASE_TO_SLICE = {
  investigate: 'investigate',
  context: 'investigate',
  architect: 'build',
  build: 'build',
  review: 'review',
  remediate: 'review',
};

/** Annotation types (see `packages/protocol/src/types.js`'s `RESERVED_TYPES`)
 * whose body is relevant to each pack slice. Kept as an explicit allowlist
 * (rather than "every annotation on the issue") so a slice stays focused on
 * the annotations a phase at that point in the pipeline would actually have
 * produced/consumed — mirrors `AFFECTED_FILES_SOURCE_TYPES`'s narrow-scope
 * precedent above. */
const SLICE_ANNOTATION_TYPES = {
  investigate: new Set(['INVESTIGATOR', 'CONTRACT']),
  build: new Set(['CONTRACT', 'CONTEXT', 'ARCHITECT']),
  review: new Set(['BUILDER', 'REVIEWER']),
};

/** Render one annotation's body as a bounded excerpt: type header + body,
 * trimmed. Callers cap the overall slice size via `truncateToBytes()`, so
 * this only trims leading/trailing whitespace — it does not itself enforce
 * a byte budget per annotation. */
function renderAnnotationExcerpt(annotation) {
  if (!annotation || typeof annotation.body !== 'string') return '';
  const body = annotation.body.trim();
  if (!body) return '';
  // Deliberately does NOT reconstruct the literal "FORGE:" marker prefix —
  // this module declares no inline FORGE marker literals in executable code
  // (see the module docblock and this file's own structural test,
  // `contextpack.mine.test.mjs`'s "no inline FORGE marker literals" check).
  // "annotation type" alone (e.g. "CONTRACT annotation") is unambiguous
  // pack content without reproducing marker syntax at runtime.
  return `### ${annotation.type} annotation (comment #${annotation.commentIndex})\n\n${body}`;
}

/** Render the affected-files list as a markdown bullet list, or "" if empty. */
function renderAffectedFilesExcerpt(affectedFiles) {
  if (!Array.isArray(affectedFiles) || affectedFiles.length === 0) return '';
  return ['## Known Affected Files', ...affectedFiles.map((f) => `- \`${f}\``)].join('\n');
}

/** Render linked PRs and their review findings as a compact summary, or ""
 * if there are no linked PRs. */
function renderLinkedPrsExcerpt(linkedPrs) {
  if (!Array.isArray(linkedPrs) || linkedPrs.length === 0) return '';
  const lines = ['## Linked PRs'];
  for (const pr of linkedPrs) {
    if (!pr) continue;
    const findingCount = Array.isArray(pr.reviewFindings) ? pr.reviewFindings.length : 0;
    lines.push(`- PR #${pr.number} — ${findingCount} review finding(s)`);
    if (Array.isArray(pr.reviewFindings)) {
      for (const finding of pr.reviewFindings.slice(0, 10)) {
        if (finding && finding.number != null) {
          lines.push(`  - #${finding.number}: ${finding.title || ''}`);
        }
      }
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/** Render the issue's title/body as a markdown section, or "" if both are
 * empty (e.g. `fetchIssueCore()` failed — see its `{ok: false}` contract). */
function renderIssueExcerpt(issue) {
  if (!issue || (!issue.title && !issue.body)) return '';
  return `## Issue #${issue.number}: ${issue.title || ''}\n\n${issue.body || ''}`.trim();
}

/**
 * Build one slice's raw (pre-truncation) content by concatenating the
 * sections relevant to `sliceName`, in a fixed, deterministic order: issue
 * summary, affected files, relevant annotations (in mined comment order,
 * i.e. oldest first), linked PRs. A slice with nothing to say (every section
 * empty — e.g. a brand-new issue with no annotations yet) returns "".
 */
function renderSliceContent(sliceName, minedData) {
  const annotationTypes = SLICE_ANNOTATION_TYPES[sliceName] || new Set();
  const relevantAnnotations = Array.isArray(minedData.annotations)
    ? minedData.annotations.filter((a) => a && annotationTypes.has(a.type))
    : [];

  // forge#2681: failure-memory (prior review-findings / closed-as-invalid
  // history on overlapping modules) is injected into the investigate and
  // build slices only — never review. A review-phase agent is looking at
  // its OWN just-built PR, not re-deriving prior-attempt history; that
  // context already served its purpose upstream at investigate/build time.
  const includeFailureMemory = sliceName === 'investigate' || sliceName === 'build';
  const failureMemoryExcerpt = includeFailureMemory
    ? renderFailureMemoryExcerpt(rankFailureMemory(minedData.failureMemory, minedData.affectedFiles))
    : '';

  // forge#2682: fleet-brief (in-flight sibling declared-contract awareness)
  // is injected into the investigate and build slices only — same rationale
  // as failure-memory above: a review-phase agent is looking at its OWN
  // just-built PR, not the state of other in-flight siblings at dispatch
  // time; that awareness already served its purpose upstream.
  const includeFleetBrief = sliceName === 'investigate' || sliceName === 'build';
  const fleetBriefExcerpt = includeFleetBrief
    ? renderFleetBriefExcerpt(minedData.fleetBrief?.items, minedData.fleetBrief?.omittedCount || 0)
    : '';

  const sections = [
    sliceName === 'investigate' ? renderIssueExcerpt(minedData.issue) : '',
    renderAffectedFilesExcerpt(minedData.affectedFiles),
    ...relevantAnnotations.map(renderAnnotationExcerpt),
    failureMemoryExcerpt,
    fleetBriefExcerpt,
    sliceName !== 'investigate' ? renderLinkedPrsExcerpt(minedData.linkedPrs) : '',
  ].filter((s) => typeof s === 'string' && s.length > 0);

  return sections.join('\n\n');
}

/**
 * Assemble a schema-conformant `ContextPack` (per
 * `packages/protocol/src/contextpack-schema.js`) for one engine phase, from
 * `mineContext()`'s raw mined-data object.
 *
 * Pure and deterministic given the same `minedData` — no I/O, no `Date.now()`
 * beyond what `minedData` itself already carries. Every failure mode
 * degrades to `null` rather than throwing, so a caller's fail-open contract
 * (per forge#2680's own acceptance criteria) can treat "no pack" uniformly
 * whether the cause was "phase has no slice mapping", "nothing to report",
 * or "issue number unavailable" — never `assemblePack()` crashing the phase
 * dispatch that called it.
 *
 * @param {string} phaseId - an engine phase id from
 *   `packages/protocol/src/phases.js`'s `PHASE_IDS` (e.g. "investigate",
 *   "build", "review"). Ids with no `PHASE_TO_SLICE` entry (e.g. "decompose",
 *   "close") return `null`.
 * @param {Object} minedData - the raw object returned by `mineContext()`.
 * @param {{schemaVersion?: number, maxSliceBytes?: number, maxPackBytes?: number}} [opts] -
 *   override hooks for the schema constants (defaults to the real
 *   `contextpack-schema.js` constants) — exists purely so tests can exercise
 *   the truncation/validation paths with small budgets without waiting to
 *   construct multi-kilobyte fixtures.
 * @returns {{schema_version: number, issue: number, slices: Array, truncated?: boolean}|null}
 */
export function assemblePack(phaseId, minedData, opts = {}) {
  const sliceName = PHASE_TO_SLICE[phaseId];
  if (!sliceName || !PACK_SLICE_NAMES.includes(sliceName)) return null;
  if (!minedData || typeof minedData !== 'object') return null;

  const issueNumber = minedData.issue && typeof minedData.issue.number === 'number'
    ? minedData.issue.number
    : (typeof minedData.meta?.issueNumber === 'number' ? minedData.meta.issueNumber : null);
  if (issueNumber === null) return null;

  const maxSliceBytes = opts.maxSliceBytes ?? MAX_SLICE_BYTES;
  const maxPackBytes = opts.maxPackBytes ?? MAX_PACK_BYTES;
  const schemaVersion = opts.schemaVersion ?? SCHEMA_VERSION;

  const rawContent = renderSliceContent(sliceName, minedData);
  if (!rawContent) return null; // nothing to report — identical to "no pack requested"

  const rawBytes = Buffer.byteLength(rawContent, 'utf-8');
  const sliceContent = truncateToBytes(rawContent, maxSliceBytes);
  const sliceTruncated = Buffer.byteLength(sliceContent, 'utf-8') < rawBytes;

  const slice = { phase: sliceName, content: sliceContent };
  if (sliceTruncated) slice.truncated = true;

  const pack = { schema_version: schemaVersion, issue: issueNumber, slices: [slice] };

  // Whole-pack budget: re-check after per-slice truncation because the
  // schema/pack envelope (JSON structure, field names) adds bytes beyond the
  // slice content alone. A single-slice pack rarely needs this second pass —
  // maxSliceBytes is well under maxPackBytes by construction in the real
  // constants — but a caller-supplied opts override (tests) can legitimately
  // set maxSliceBytes close to or above maxPackBytes, so this must not be
  // skipped.
  let packBytes = Buffer.byteLength(JSON.stringify(pack), 'utf-8');
  if (packBytes > maxPackBytes) {
    slice.truncated = true;
    pack.truncated = true;

    // A one-shot raw-byte budget calc is not sufficient: truncateToBytes()
    // only guarantees the *raw* UTF-8 byte length of slice.content stays
    // under budget, but JSON.stringify() escapes characters (quotes,
    // backslashes, control chars) — notably the truncation marker's own
    // literal "\n\n" prefix, which JSON always expands to the 4-byte
    // sequence "\n\n" (forge#2724). That escaping can push the serialized
    // pack back over maxPackBytes even after truncating slice.content to
    // fit the raw budget. Re-measure after each attempt and keep shrinking
    // until the *serialized* pack actually fits, bounded by a small
    // iteration cap with a guaranteed-safe fallback.
    let envelopeOverhead = packBytes - Buffer.byteLength(sliceContent, 'utf-8');
    let budget = Math.max(0, maxPackBytes - envelopeOverhead);
    const MAX_SHRINK_ATTEMPTS = 8;
    for (let attempt = 0; attempt < MAX_SHRINK_ATTEMPTS; attempt++) {
      slice.content = truncateToBytes(sliceContent, budget);
      packBytes = Buffer.byteLength(JSON.stringify(pack), 'utf-8');
      if (packBytes <= maxPackBytes) break;
      if (budget === 0) {
        // Envelope alone (with empty slice content) still doesn't fit —
        // nothing further to shrink. Leave slice.content empty; the pack
        // is as small as this function can make it.
        break;
      }
      const overshoot = packBytes - maxPackBytes;
      budget = Math.max(0, budget - overshoot);
    }
  }

  return pack;
}

/**
 * Flatten an assembled `ContextPack` into the plain string
 * `bin/runner.mjs`'s pre-existing `opts.contextPack` parameter expects (it
 * is rendered, unmodified, via `renderContextPackSection()` — forge#2515's
 * prompt-injection hardening already applies at that layer, so this
 * function does no escaping of its own).
 *
 * @param {{slices: Array<{phase: string, content: string}>}|null} pack
 * @returns {string} "" for a null/malformed pack — matches every other
 *   render* helper's "absent input renders as empty string" convention.
 */
export function renderPackAsText(pack) {
  if (!pack || !Array.isArray(pack.slices)) return '';
  return pack.slices
    .map((s) => (s && typeof s.content === 'string' ? s.content : ''))
    .filter((s) => s.length > 0)
    .join('\n\n---\n\n');
}

/**
 * Mine and assemble a validated, schema-conformant context pack for one
 * phase in a single call — the convenience entry point `bin/runner.mjs`'s
 * `context_packs.enabled` wiring (forge#2702) uses. Combines `mineContext()`
 * (I/O, `#2701`) + `assemblePack()` (pure, `#2702`) +
 * `validateContextPack()` (`#2700`) and returns the render-ready string plus
 * validation metadata, so the caller never has to import three modules or
 * duplicate the mine → assemble → validate → render sequence.
 *
 * Fail-open at every stage: a mining exception, an unmapped `phaseId`, an
 * empty pack, or a schema-validation failure all resolve to
 * `{text: null, pack: null, valid: false, errors}` rather than throwing —
 * the caller's contract (inject only when `text` is non-null) is identical
 * regardless of which stage produced the empty result.
 *
 * @param {string} phaseId
 * @param {number|string} issueNumber
 * @param {{io: {gh: Function}, repo?: string}} mineOpts - forwarded to
 *   `mineContext()` verbatim (see its own docblock for the `io.gh`
 *   injection contract).
 * @returns {Promise<{text: string|null, pack: Object|null, valid: boolean, errors: string[]}>}
 */
export async function buildValidatedPackForPhase(phaseId, issueNumber, mineOpts) {
  let minedData;
  try {
    minedData = await mineContext(issueNumber, mineOpts);
  } catch (err) {
    return { text: null, pack: null, valid: false, errors: [`mineContext() threw: ${String(err && err.message ? err.message : err)}`] };
  }

  let pack;
  try {
    pack = assemblePack(phaseId, minedData);
  } catch (err) {
    return { text: null, pack: null, valid: false, errors: [`assemblePack() threw: ${String(err && err.message ? err.message : err)}`] };
  }
  if (!pack) return { text: null, pack: null, valid: false, errors: ['no pack produced (unmapped phase or nothing to report)'] };

  let result;
  try {
    result = validateContextPack(pack);
  } catch (err) {
    return { text: null, pack: null, valid: false, errors: [`validateContextPack() threw: ${String(err && err.message ? err.message : err)}`] };
  }
  if (!result.valid) return { text: null, pack: null, valid: false, errors: result.errors };

  return { text: renderPackAsText(pack), pack, valid: true, errors: [] };
}

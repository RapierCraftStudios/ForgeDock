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
 * mining) and forge#2682 (sibling in-flight fleet-brief mining) — both
 * explicitly out of scope here — can build on top without re-deriving raw
 * GitHub state themselves.
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
    return { comments: [], truncated: false, error: String(err && err.message ? err.message : err) };
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

  return { comments, truncated: false, ...(sawParseFailure ? { partialParseFailure: true } : {}) };
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
  } catch {
    return [];
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
  return [...numbers];
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
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(out || '[]');
    return Array.isArray(parsed) ? parsed.map((i) => ({ number: i.number, title: i.title })) : [];
  } catch {
    return [];
  }
}

/**
 * Mine deterministic, structured GitHub context for `issueNumber`. Zero LLM
 * calls — every field below is either raw `gh` output or a regex/registry
 * parse of that output.
 *
 * @param {number|string} issueNumber
 * @param {{io: {gh: Function}, repo?: string}} opts - `io.gh(args)` is
 *   REQUIRED (no default wiring — see module docblock). `repo` is an
 *   optional explicit `owner/repo` string threaded to every `gh` call via
 *   `-R`, which is what makes this module work correctly for satellite
 *   (`forge.yaml → repos.satellites`) issues regardless of the caller's
 *   cwd — the caller is responsible for resolving a `<prefix>:N` reference
 *   to its satellite's `repo` before calling `mineContext()`. When omitted,
 *   `gh`'s own cwd-implicit repo resolution is used.
 * @returns {Promise<Object>} raw pre-assembly mined-data object — NOT a
 *   `packages/protocol/src/contextpack-schema.js`-conformant `ContextPack`.
 */
export async function mineContext(issueNumber, opts = {}) {
  const { io, repo } = opts;
  assertIo(io);

  const issue = await fetchIssueCore(issueNumber, io, repo);
  const { comments, truncated, partialParseFailure } = await fetchAllComments(issueNumber, io, repo);
  const annotations = parseAnnotations(comments);
  const affectedFiles = extractAffectedFiles(annotations);
  const gists = await fetchGists(annotations, io);

  const prNumbers = await fetchLinkedPrNumbers(issueNumber, io, repo);
  const linkedPrs = [];
  for (const prNumber of prNumbers) {
    const reviewFindings = await fetchReviewFindingsForPr(prNumber, io, repo);
    linkedPrs.push({ number: prNumber, reviewFindings });
  }

  return {
    issue,
    comments,
    annotations,
    affectedFiles,
    linkedPrs,
    gists,
    meta: {
      issueNumber: typeof issueNumber === 'number' ? issueNumber : Number(issueNumber),
      repo: repo || null,
      commentCount: comments.length,
      ...(truncated ? { truncated: true } : {}),
      ...(partialParseFailure ? { partialParseFailure: true } : {}),
    },
  };
}

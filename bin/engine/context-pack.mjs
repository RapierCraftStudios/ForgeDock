/**
 * forge#2383: deterministic per-phase context pack builder.
 *
 * Pure: given the same inputs, buildContextPack() always produces
 * byte-identical output — no I/O, no randomness, no Date.now(), no reliance
 * on object key insertion order beyond what the caller itself controls. All
 * fetching (issue body, comments, prior phase outputs) happens in the caller
 * (bin/engine.mjs); this module only assembles, sanitizes, and truncates.
 *
 * No phase depends on this pack for correctness (fail-open, per the parent
 * issue's own acceptance criteria) — an empty/missing pack degrades to
 * exactly today's behavior. Every render* helper below returns "" on absent/
 * empty input, and buildContextPack({}) returns a valid, empty pack rather
 * than throwing.
 */

// Recursively stripped from any object merged into the pack (prior phase
// "typed outputs" originate from #2380's report_result tool, i.e. from
// external, trust-boundary-crossing tool_use input — see #2408, which found
// validatePhaseResult accepting unvalidated extra keys including `__proto__`).
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively strip dangerous keys from a plain object/array, guarding
 * against both prototype pollution and reference cycles (a cycle would
 * otherwise recurse forever, which is unacceptable in a "pure" builder that
 * must always terminate deterministically).
 */
function sanitize(value, seen) {
  if (value === null || typeof value !== "object") return value;
  const seenSet = seen || new WeakSet();
  if (seenSet.has(value)) return undefined; // cycle guard — drop, don't loop
  seenSet.add(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seenSet));
  const out = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = sanitize(value[key], seenSet);
  }
  return out;
}

function renderIssueSection(issue) {
  if (!issue || (!issue.title && !issue.body)) return "";
  const number = issue.number != null ? issue.number : "";
  const lines = [`## Issue #${number}: ${issue.title || ""}`, "", issue.body || ""];
  return lines.join("\n").trim();
}

function renderPriorOutputsSection(priorOutputs) {
  if (!priorOutputs || typeof priorOutputs !== "object") return "";
  const phaseIds = Object.keys(priorOutputs);
  if (phaseIds.length === 0) return "";
  const lines = ["## Prior Phase Outputs"];
  for (const phaseId of phaseIds) {
    const clean = sanitize(priorOutputs[phaseId]);
    if (clean == null || (typeof clean === "object" && Object.keys(clean).length === 0)) continue;
    lines.push("", `### ${phaseId}`, "```json", JSON.stringify(clean, null, 2), "```");
  }
  return lines.length > 1 ? lines.join("\n").trim() : "";
}

function renderAnnotationsSection(annotations) {
  if (!Array.isArray(annotations) || annotations.length === 0) return "";
  const lines = ["## Relevant FORGE Annotations"];
  for (const a of annotations) {
    if (!a) continue;
    lines.push("", String(a).trim());
  }
  return lines.length > 1 ? lines.join("\n").trim() : "";
}

function renderFileExcerptsSection(fileExcerpts) {
  if (!Array.isArray(fileExcerpts) || fileExcerpts.length === 0) return "";
  const lines = ["## Candidate File Excerpts"];
  for (const f of fileExcerpts) {
    if (!f || !f.path) continue;
    lines.push("", `### ${f.path}`, "```", f.excerpt || "", "```");
  }
  return lines.length > 1 ? lines.join("\n").trim() : "";
}

// Render order (top of the pack first) — highest priority first.
const RENDER_ORDER = ["issue", "priorOutputs", "annotations", "fileExcerpts"];

// Drop order when the assembled pack exceeds budgetBytes — lowest-priority
// section dropped first, in whole-section units (never mid-line/mid-section).
// Deliberately excludes "issue": file excerpts/annotations/prior-outputs are
// nice-to-have and safe to drop to zero, but the issue section is the pack's
// reason for existing — dropping it entirely (rather than hard-truncating,
// see below) would leave the pack pointing at nothing. If the issue section
// alone still exceeds budgetBytes after every other section has been
// dropped, the hard-truncation step below trims it instead of removing it.
const DROP_ORDER = ["fileExcerpts", "annotations", "priorOutputs"];

const RENDERERS = {
  issue: renderIssueSection,
  priorOutputs: renderPriorOutputsSection,
  annotations: renderAnnotationsSection,
  fileExcerpts: renderFileExcerptsSection,
};

const DEFAULT_BUDGET_BYTES = 32000;

/**
 * Hard-truncate a string to at most maxBytes UTF-8 bytes, never splitting a
 * multi-byte character (and therefore never producing a U+FFFD replacement
 * character from a mid-sequence cut). Deterministic (same input → same
 * output). Uses a strict (`fatal: true`) TextDecoder to find the largest
 * valid UTF-8 prefix at or below the byte budget, rather than hand-rolling
 * UTF-8 boundary math — trimming one byte at a time from a byte budget is
 * bounded by at most 3 iterations in practice (the widest UTF-8 sequence is
 * 4 bytes), so this stays cheap even though it is not the single fastest
 * possible implementation.
 *
 * Review-finding #2517 (CONFIRMED, LOW): the original implementation
 * clamped `targetLen = Math.max(0, maxBytes - markerBytes)` and, when that
 * clamped to 0 (i.e. `maxBytes` smaller than the ~46-byte marker itself),
 * fell straight through to returning the FULL, un-truncated marker —
 * silently exceeding the function's own "at most maxBytes" contract. Not
 * reachable via the current production caller (a fixed 32000-byte budget in
 * bin/engine.mjs), but `buildContextPack`/this helper are reachable with an
 * arbitrary caller-supplied budget. Fixed by shrinking the marker itself
 * (via the same strict-decode loop, so it stays UTF-8-boundary-safe even
 * though the marker text itself is plain ASCII) whenever it alone would not
 * fit — the function now genuinely never returns more than maxBytes bytes,
 * including the degenerate maxBytes: 0 case (returns "").
 *
 * Exported (forge#2702) so bin/engine/contextpack.mjs's schema-conformant
 * pack assembler can reuse this exact, already-hardened truncation routine
 * for its own MAX_SLICE_BYTES/MAX_PACK_BYTES enforcement instead of
 * re-implementing byte-budget truncation a second time and risking a
 * reintroduction of the #2517 bug class (a budget smaller than the marker
 * silently returning more bytes than requested).
 */
export function truncateToBytes(str, maxBytes) {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  const marker = "\n\n[...truncated to fit context pack budget...]";
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  const decoder = new TextDecoder("utf-8", { fatal: true });

  if (markerBytes > maxBytes) {
    // The marker alone doesn't fit — shrink the marker itself rather than
    // returning it un-truncated (the bug #2517 flagged).
    const markerBuf = Buffer.from(marker, "utf-8");
    let markerTargetLen = maxBytes;
    while (markerTargetLen > 0) {
      try {
        return decoder.decode(markerBuf.subarray(0, markerTargetLen));
      } catch {
        markerTargetLen--;
      }
    }
    return "";
  }

  let targetLen = maxBytes - markerBytes;
  while (targetLen > 0) {
    try {
      return decoder.decode(buf.subarray(0, targetLen)) + marker;
    } catch {
      targetLen--; // land mid-sequence — back off one byte and retry
    }
  }
  return marker;
}

/**
 * Build a deterministic per-phase context pack.
 *
 * @param {object} [input]
 * @param {{number?: number|string, title?: string, body?: string}} [input.issue]
 * @param {Record<string, object>} [input.priorOutputs] - phaseId -> raw outputs object
 *   (e.g. from #2380's report_result). Sanitized against prototype pollution
 *   before being embedded.
 * @param {string[]} [input.annotations] - raw FORGE:* comment bodies, already
 *   filtered/ordered by the caller (oldest-to-newest or whatever order the
 *   caller wants rendered).
 * @param {{path: string, excerpt: string}[]} [input.fileExcerpts] - candidate
 *   file excerpts (e.g. from scripts/code-index.sh / bin/recall.mjs). No
 *   caller populates this yet — accepted for forward compatibility.
 * @param {{budgetBytes?: number}} [opts]
 * @returns {{text: string, bytes: number, sections: string[], truncated: string[]}}
 *   `sections` lists the sections actually included, in render order.
 *   `truncated` lists sections dropped to fit budget, plus "hard-truncate" if
 *   even the single highest-priority section alone exceeded the budget.
 */
export function buildContextPack(input, opts) {
  const safeInput = input || {};
  // Discovered while fixing review-finding #2517: `opts.budgetBytes || DEFAULT`
  // treats a caller-supplied `0` as absent (0 is falsy) and silently falls
  // back to the 32000-byte default — defeating a caller's explicit "give me
  // nothing" budget and making the tiny-budget behavior untestable/wrong.
  // Use an explicit type check so only a genuinely absent/non-numeric budget
  // falls back to the default; 0 (and any other finite number) is honored.
  const budgetBytes =
    opts && typeof opts.budgetBytes === "number" && Number.isFinite(opts.budgetBytes)
      ? opts.budgetBytes
      : DEFAULT_BUDGET_BYTES;

  const rendered = {};
  for (const key of RENDER_ORDER) rendered[key] = RENDERERS[key](safeInput[key]);

  const included = new Set(RENDER_ORDER.filter((k) => rendered[k]));
  const truncated = [];

  function assemble() {
    return RENDER_ORDER.filter((k) => included.has(k))
      .map((k) => rendered[k])
      .join("\n\n")
      .trim();
  }

  let text = assemble();
  for (const key of DROP_ORDER) {
    if (Buffer.byteLength(text, "utf-8") <= budgetBytes) break;
    if (included.has(key)) {
      included.delete(key);
      truncated.push(key);
      text = assemble();
    }
  }
  if (Buffer.byteLength(text, "utf-8") > budgetBytes) {
    text = truncateToBytes(text, budgetBytes);
    truncated.push("hard-truncate");
  }

  return {
    text,
    bytes: Buffer.byteLength(text, "utf-8"),
    sections: RENDER_ORDER.filter((k) => included.has(k)),
    truncated,
  };
}

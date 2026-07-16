/**
 * Codec for the single machine-readable FORGE:STATE HTML-comment block on an
 * issue body. Carries the COMPACT INDEX only (no rich per-phase outputs).
 */
import {
  escapeHtmlCommentDelimiters,
  unescapeHtmlCommentDelimiters,
} from "../../packages/protocol/src/html-comment-escape.js";

const OPEN = "<!-- FORGE:STATE";
const CLOSE = "-->";
const BLOCK_RE = /<!-- FORGE:STATE\s*([\s\S]*?)-->/;

/** @param {import("./phases.mjs").RunState} index */
export function serializeState(index) {
  // Escape all three HTML comment delimiter forms so a payload value can never
  // open or close an HTML comment in GitHub's renderer:
  //   - "<!--"  the comment opener — an unescaped opener would start a new
  //     (nested-looking) comment, visually swallowing subsequent content
  //   - "-->" and "--!>"  the two comment-close forms browsers/HTML parsers
  //     honour. JSON.stringify does not escape any of these, so a payload
  //     value containing them could otherwise open/close the
  //     <!-- FORGE:STATE ... --> block early (CodeQL js/bad-tag-filter).
  //
  // Delegated to the shared escapeHtmlCommentDelimiters() helper (forge#2225),
  // which is also used by packages/protocol/src/emit.js's sanitizeFieldValue —
  // this scheme previously had two hand-duplicated copies kept in sync only by
  // cross-referencing code comments, and had already drifted once (forge#1638's
  // fix landed here only after forge#2119). A single shared implementation
  // removes that drift vector entirely.
  const payload = escapeHtmlCommentDelimiters(JSON.stringify(index));
  return `${OPEN}\n${payload}\n${CLOSE}`;
}

/** @returns {import("./phases.mjs").RunState|null} */
export function parseState(issueBody) {
  const m = BLOCK_RE.exec(issueBody || "");
  if (!m) return null;
  // Inverse of serializeState — delegated to the shared
  // unescapeHtmlCommentDelimiters() helper (forge#2225), same ordering
  // rationale as packages/protocol/src/parse.js's unescapeFieldValue: closer
  // forms restored first (most-specific "--!&gt;" before "--&gt;"), opener
  // restored next, and "&amp;" -> "&" unescaped LAST so it never touches the
  // "&" that is part of a just-restored "<!--"/"-->"/"--!>" sequence
  // (forge#2137).
  try {
    return JSON.parse(unescapeHtmlCommentDelimiters(m[1].trim()));
  } catch { return null; }
}

/** Replace the FORGE:STATE block in place, or append one if absent. */
export function upsertStateBlock(body, index) {
  const block = serializeState(index);
  if (BLOCK_RE.test(body || "")) return body.replace(BLOCK_RE, () => block);
  return `${body || ""}\n\n${block}`.trimStart();
}

/**
 * Codec for the single machine-readable FORGE:STATE HTML-comment block on an
 * issue body. Carries the COMPACT INDEX only (no rich per-phase outputs).
 */
const OPEN = "<!-- FORGE:STATE";
const CLOSE = "-->";
const BLOCK_RE = /<!-- FORGE:STATE\s*([\s\S]*?)-->/;

/** @param {import("./phases.mjs").RunState} index */
export function serializeState(index) {
  // Escape all three HTML comment delimiter forms so a payload value can never
  // open or close an HTML comment in GitHub's renderer:
  //   - "<!--"  the comment opener — an unescaped opener would start a new
  //     (nested-looking) comment, visually swallowing subsequent content
  //     (mirrors packages/protocol/src/emit.js's sanitizeFieldValue, forge#1638/#2119)
  //   - "-->" and "--!>"  the two comment-close forms browsers/HTML parsers
  //     honour. JSON.stringify does not escape any of these, so a payload
  //     value containing them could otherwise open/close the
  //     <!-- FORGE:STATE ... --> block early (CodeQL js/bad-tag-filter).
  const payload = JSON.stringify(index)
    .replace(/<!--/g, "&lt;!--")
    .replace(/--(!?)>/g, "--$1&gt;");
  return `${OPEN}\n${payload}\n${CLOSE}`;
}

/** @returns {import("./phases.mjs").RunState|null} */
export function parseState(issueBody) {
  const m = BLOCK_RE.exec(issueBody || "");
  if (!m) return null;
  // Inverse of serializeState: restore "--&gt;", "--!&gt;", and "&lt;!--".
  // Unescape the closer forms first (most-specific "--!&gt;" before "--&gt;")
  // so a dangling "!" is never left behind, then restore the opener — same
  // ordering rationale as packages/protocol/src/parse.js's unescapeFieldValue.
  try {
    return JSON.parse(
      m[1].trim()
        .replace(/--(!?)&gt;/g, "--$1>")
        .replace(/&lt;!--/g, "<!--"),
    );
  } catch { return null; }
}

/** Replace the FORGE:STATE block in place, or append one if absent. */
export function upsertStateBlock(body, index) {
  const block = serializeState(index);
  if (BLOCK_RE.test(body || "")) return body.replace(BLOCK_RE, () => block);
  return `${body || ""}\n\n${block}`.trimStart();
}

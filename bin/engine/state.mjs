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
  //
  // The "&" escape below MUST run first, before the delimiter escapes. Without
  // it, a payload value that already contains literal entity-like text (e.g.
  // "<!--&gt;" or "&lt;!--") collides with the encoded form of an unrelated
  // real delimiter — the encoder is not injective and the collision is
  // unrecoverable on decode (forge#2137). Escaping "&" first guarantees every
  // "&lt;!--"/"--&gt;"/"--!&gt;" sequence present in the output was produced
  // by *this* encode pass, never by pre-existing entity text (which is now
  // doubly-escaped, e.g. "&" -> "&amp;" -> untouched by the delimiter pass
  // that only matches literal "<!--"/"--"+">" character sequences).
  const payload = JSON.stringify(index)
    .replace(/&/g, "&amp;")
    .replace(/<!--/g, "&lt;!--")
    .replace(/--(!?)>/g, "--$1&gt;");
  return `${OPEN}\n${payload}\n${CLOSE}`;
}

/** @returns {import("./phases.mjs").RunState|null} */
export function parseState(issueBody) {
  const m = BLOCK_RE.exec(issueBody || "");
  if (!m) return null;
  // Inverse of serializeState: restore "--&gt;", "--!&gt;", "&lt;!--", then
  // "&amp;" — in that order. Unescape the closer forms first (most-specific
  // "--!&gt;" before "--&gt;") so a dangling "!" is never left behind, then
  // restore the opener — same ordering rationale as
  // packages/protocol/src/parse.js's unescapeFieldValue. The "&amp;" -> "&"
  // unescape MUST run LAST (mirroring the encode side running it FIRST) so it
  // never touches the "&" that is part of a just-restored "<!--"/"-->"/"--!>"
  // sequence (forge#2137).
  try {
    return JSON.parse(
      m[1].trim()
        .replace(/--(!?)&gt;/g, "--$1>")
        .replace(/&lt;!--/g, "<!--")
        .replace(/&amp;/g, "&"),
    );
  } catch { return null; }
}

/** Replace the FORGE:STATE block in place, or append one if absent. */
export function upsertStateBlock(body, index) {
  const block = serializeState(index);
  if (BLOCK_RE.test(body || "")) return body.replace(BLOCK_RE, () => block);
  return `${body || ""}\n\n${block}`.trimStart();
}

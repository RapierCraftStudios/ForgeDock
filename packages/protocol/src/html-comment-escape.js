/**
 * Shared HTML-comment-delimiter escape/unescape pair for the FORGE annotation
 * wire format.
 *
 * This scheme is used by two independent callers that must agree byte-for-byte:
 *   - `packages/protocol/src/emit.js` / `parse.js` (per-field-value escaping)
 *   - `bin/engine/state.mjs` (whole-JSON-payload escaping for the FORGE:STATE
 *     compact-index block)
 *
 * Extracting it here removes the drift vector between those two call sites —
 * they previously hand-duplicated this exact regex chain, kept in sync only by
 * cross-referencing code comments, and had already drifted once (forge#1638's
 * fix was applied to `emit.js` before `state.mjs` caught up in forge#2119).
 *
 * @license MIT
 */

/**
 * Escape the three HTML comment delimiter forms so a payload/value can never
 * open or close an HTML comment in GitHub's renderer:
 *   - `<!--`         the comment opener — an unescaped opener would start a new
 *     (nested-looking) comment, visually swallowing subsequent content.
 *   - `-->` and `--!>`  the two comment-close forms browsers/HTML parsers
 *     honour. An unescaped closer could end the enclosing comment early,
 *     leaking the remainder as visible rendered text (CodeQL js/bad-tag-filter).
 *
 * The `&` escape MUST run first, before either delimiter-escape pass. Without
 * it, a value that already contains literal entity-like text (e.g. `<!--&gt;`
 * or `&lt;!--`) collides with the encoded form of an unrelated real delimiter —
 * the encoder would not be injective, and the collision is unrecoverable on
 * decode (forge#2137). Escaping `&` first guarantees every `&lt;!--`/`--&gt;`/
 * `--!&gt;` sequence in the output was produced by *this* pass, never by
 * pre-existing entity text (which is now doubly-escaped, e.g.
 * `&` -> `&amp;`, left untouched by the delimiter passes that only match the
 * literal `<!--`/`--`+`>` character sequences).
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeHtmlCommentDelimiters(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/<!--/g, '&lt;!--')
    .replace(/--(!)?>/g, (_, bang) => `--${bang || ''}&gt;`);
}

/**
 * Inverse of {@link escapeHtmlCommentDelimiters}. Restores `--&gt;`, `--!&gt;`,
 * `&lt;!--`, then `&amp;` — in that order.
 *
 * Unescape order matters: the closer forms are restored first (most-specific
 * `--!&gt;` before `--&gt;`) so a dangling `!` is never left behind, then the
 * opener is restored. The `&amp;` -> `&` unescape MUST run LAST (mirroring the
 * encode side running it FIRST) so it never touches the `&` that is part of a
 * just-restored `<!--`/`-->`/`--!>` sequence (forge#2137; forge#1662 — parse()
 * previously failed to apply the exact inverse of emit()'s escape, corrupting
 * round-trips).
 *
 * @param {string} raw
 * @returns {string}
 */
export function unescapeHtmlCommentDelimiters(raw) {
  return raw
    .replace(/--!&gt;/g, '--!>')
    .replace(/--&gt;/g, '-->')
    .replace(/&lt;!--/g, '<!--')
    .replace(/&amp;/g, '&');
}

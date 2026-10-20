// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Untrusted issue/comment text with HTML comments cut out by plain scanning: a comment ends at `-->` or `--!>`, and an
 * unclosed one runs to the end. No regex, so nested or split input cannot survive a single pass.
 */
export function cutComments(s, repl = "") {
  const t = String(s ?? "");
  let out = "", i = 0;
  for (;;) {
    const a = t.indexOf("<!--", i);
    if (a < 0) { out += t.slice(i); break; }
    out += t.slice(i, a) + repl;
    const ends = [[t.indexOf("-->", a + 4), 3], [t.indexOf("--!>", a + 4), 4]].filter(([k]) => k >= 0).sort((x, y) => x[0] - y[0]);
    if (!ends.length) break;
    i = ends[0][0] + ends[0][1];
  }
  return out;
}

/**
 * `cutComments`, then every `<` that starts `<!` becomes `\u2039`. With no `<!` in the output, no HTML comment and no
 * FORGE marker can open, whatever the input. Use it for any untrusted text the engine posts back in a trusted comment.
 */
export function noComments(s, repl = "") {
  return cutComments(s, repl).replace(/<(?=!)/g, "\u2039");
}

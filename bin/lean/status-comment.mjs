// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * #5600: bot comment volume. One `FORGE:STARTED` status comment per issue is edited in place by every attempt (a requeue or
 * recovery appends a line instead of posting a new comment), and `post` stops adding comments past `BOT_COMMENT_CAP`
 * (terminal markers are exempt: the operator must always see them).
 */
export const BOT_COMMENT_CAP = 10;
export const STATUS_MARKER = "FORGE:STARTED";
/** Markers that are always posted: the run's outcome must reach the operator whatever the count. */
export const CAP_EXEMPT = ["FORGE:NEEDS_HUMAN", "FORGE:TRAJECTORY", "FORGE:STARTED"];

const MARKER_RE = /^\s*<!--\s*(FORGE:[A-Z_-]+)/;
const markerOf = (body) => MARKER_RE.exec(String(body ?? ""))?.[1] ?? null;

/** Trusted engine comments (a body opening with a `<!-- FORGE:` marker) among the gh `comments` rows. */
export const botComments = (comments, trusted = () => true) => (comments ?? []).filter((c) => markerOf(c?.body) && trusted(c));

/** The latest trusted status comment: `{ id, body }` (id from its url `#issuecomment-<n>`), or null. */
export function findStatusComment(comments, trusted = () => true) {
  const rows = botComments(comments, trusted).filter((c) => markerOf(c.body) === STATUS_MARKER);
  for (let i = rows.length - 1; i >= 0; i--) {
    const id = /#issuecomment-(\d+)/.exec(String(rows[i].url ?? ""))?.[1];
    if (id) return { id, body: String(rows[i].body) };
  }
  return null;
}

/** Whether a comment with `marker` may still be posted when `count` bot comments already exist. */
export const withinCap = (count, marker, cap = BOT_COMMENT_CAP) => count < cap || [].concat(marker).some((m) => CAP_EXEMPT.includes(m));

/**
 * Edit the existing status comment (appending `line`), or return null so the caller posts a first one. `render` caps the body.
 * Returns the comment url on success; a failed edit returns null (the caller posts a new comment).
 */
export async function appendStatus({ gh, repo, existing, line, render = (s) => s }) {
  if (!existing?.id) return null;
  try {
    await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${render(`${existing.body}\n${line}`)}`]);
    return `https://github.com/${repo}/issues/0#issuecomment-${existing.id}`;
  } catch { return null; }
}

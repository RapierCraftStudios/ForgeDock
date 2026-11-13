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

const SECTION_SPLIT = /\n(?=<!-- FORGE:[A-Z_-]+ -->\n)/;
/** A status comment body as `{ head, sections: Map(marker -> text) }`; the head is the marker line plus the run lines. */
export function parseStatus(body) {
  const parts = String(body ?? "").split(SECTION_SPLIT), head = parts.shift() ?? "";
  return { head, sections: new Map(parts.map((t) => [markerOf(t), t])) };
}
export const renderStatus = ({ head, sections }) => [head, ...sections.values()].join("\n");

/**
 * Edit the status comment `doc` ({ id, body }) in place: `headLine` is appended to the run lines, and `marker`'s section
 * (a hidden `<!-- marker -->` line plus `body`) is added or replaced. `render` caps the body. Returns true when the edit
 * landed (doc.body is then current); false means the caller posts the note as a comment of its own.
 */
export async function upsertStatus({ gh, repo, doc, marker = null, body = "", headLine = null, render = (x) => x }) {
  if (!doc?.id) return false;
  const st = parseStatus(doc.body);
  if (headLine) st.head += `\n${headLine}`;
  if (marker) st.sections.set(marker, `<!-- ${marker} -->\n${body}`);
  const next = render(renderStatus(st));
  try {
    await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${doc.id}`, "-f", `body=${next}`]);
    doc.body = next;
    return true;
  } catch { return false; }
}

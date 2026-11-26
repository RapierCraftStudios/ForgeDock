// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5979: post a machine comment only on a state change. A scheduler pass that re-derives the same DEPENDENCY, FACTS, or
 * NEEDS_HUMAN text posts nothing; a changed FACTS or DEPENDENCY is edited in place; a changed NEEDS_HUMAN is a new comment
 * (statuscomment.mjs header: a new comment notifies a person, an edit does not, and issuewatch keys on the newest one). Pure.
 */
import { IN_PLACE_MARKERS, contractKeyOf } from "./statuscomment.mjs";

/** Markers whose changed state is PATCHed rather than posted again. */
export const PATCH_MARKERS = Object.freeze(IN_PLACE_MARKERS.filter((m) => m !== "FORGE:NEEDS_HUMAN"));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body without what changes between identical states: the cost/usage line, comment urls and ids, shas, whitespace. */
export function normalizeState(body) {
  return String(body ?? "")
    .split("\n")
    .filter((l) => !/^\s*_?\s*cost \$[\d.]+/i.test(l))
    .join("\n")
    .replace(/https?:\/\/\S*#issuecomment-\d+/g, "")
    .replace(/\b[0-9a-f]{7,40}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The newest trusted comment carrying `marker` (a `<!-- marker` line anywhere in the body), or null. */
export function findLast(comments, marker, trusted = () => true) {
  const re = new RegExp(`<!--\\s*${esc(marker)}(?![A-Za-z0-9_])`);
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) if (re.test(String(list[i]?.body ?? "")) && trusted(list[i])) return list[i];
  return null;
}

/**
 * `{action: "skip"|"patch"|"create", prior}` for posting `body` under `marker` given the issue's comments. #5931: with a `contractHash`
 * the prior is the newest comment keyed to that hash and every in-place marker (NEEDS_HUMAN too) is edited in place; a changed hash is a new comment.
 */
export function decidePost({ marker, body, comments, trusted, contractHash = null }) {
  const keyed = !!contractHash && IN_PLACE_MARKERS.includes(marker);
  const list = Array.isArray(comments) ? comments : [];
  const prior = keyed ? findLast(list.filter((c) => contractKeyOf(c?.body) === String(contractHash).replace(/[^\w]/g, "")), marker, trusted) : findLast(comments, marker, trusted);
  if (!prior) return { action: "create", prior: null };
  if (normalizeState(prior.body) === normalizeState(body)) return { action: "skip", prior };
  return { action: keyed || PATCH_MARKERS.includes(marker) ? "patch" : "create", prior };
}

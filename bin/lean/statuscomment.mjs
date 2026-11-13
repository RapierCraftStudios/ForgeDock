// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5592 (8): one machine-state comment per issue, edited in place.
 *
 * Every run used to post STARTED, CONTEXT, LANE_BRANCH, TRAJECTORY and a recovery DECISION as separate comments, and every
 * requeue posted them again (30-42 comments on one issue). They now live as sections of ONE trusted `<!-- FORGE:STATUS -->`
 * comment the engine PATCHes: a section holds the newest run's text (DECISION keeps the last few entries). A section starts with
 * its own `<!-- FORGE:NAME -->` marker line(s), so every reader that searches a body for a marker (includes / unanchored regex)
 * keeps working; readers that anchor a marker at the comment start use `hasSection` (here) instead.
 *
 * Stays a separate comment, because a person must see it (a new comment notifies, an edit does not) or other code reads the
 * comment order: NEEDS_HUMAN, HOST_TASK, DEPENDENCY, DECOMPOSED, owner asks, CONTRACT/PLAN, REVIEW, FACTS, TRACKED, JSON
 * DECISION records. INVESTIGATION, IMPLEMENTATION and PARKED are single comments edited in place (`upsert`), their marker still
 * leading the body.
 */

export const STATUS_MARKER = "FORGE:STATUS";
export const STATUS_SEP = "<!-- FORGE:STATUS:SEP -->";
/** Markers folded into the status comment, keyed by the FIRST marker of a post. */
export const STATUS_SECTIONS = Object.freeze(["FORGE:STARTED", "FORGE:CONTEXT", "FORGE:LANE_BRANCH", "FORGE:LITE", "FORGE:TRAJECTORY", "FORGE:DECISION"]);
/** Sections that keep their last N entries instead of only the newest. */
export const APPEND_SECTIONS = Object.freeze({ "FORGE:DECISION": 5 });
export const ENTRY_SEP = "\n\n---\n\n";
/** Markers posted once and edited in place (the marker leads the comment body, so anchored readers still match). */
export const UPSERT_MARKERS = Object.freeze(["FORGE:INVESTIGATION", "FORGE:IMPLEMENTATION", "FORGE:PARKED"]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const markLine = (m) => `<!-- ${m} -->`;

/** The REST comment id of a `gh issue view` comment (`url` ends in `#issuecomment-<id>`) or a REST comment (`id`). */
export function commentId(c) {
  const m = /#issuecomment-(\d+)/.exec(String(c?.url ?? ""));
  if (m) return m[1];
  return /^\d+$/.test(String(c?.id ?? "")) ? String(c.id) : null;
}

/** True when `marker` is one of the comment's section markers or (legacy / upsert) leads the body. */
export function hasSection(body, marker) {
  const b = String(body ?? "");
  if (new RegExp(`^\\s*<!--\\s*${esc(marker)}(?![A-Za-z0-9_])`).test(b)) return true;
  return isStatusBody(b) && new RegExp(`^<!--\\s*${esc(marker)}(?![A-Za-z0-9_])`, "m").test(b);
}
export const isStatusBody = (body) => new RegExp(`^\\s*<!--\\s*${esc(STATUS_MARKER)}\\s*-->`).test(String(body ?? ""));

/** The text of one section (without its marker lines), or null. */
export function sectionText(body, marker) {
  return parseStatus(body).get(marker)?.text ?? null;
}

/** Status body -> Map(primary marker -> {markers: [..], text}). A non-status body parses to an empty map. */
export function parseStatus(body) {
  const out = new Map();
  if (!isStatusBody(body)) return out;
  const chunks = String(body).split(STATUS_SEP).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.replace(/^\s*\n/, "").split("\n");
    const markers = [];
    while (lines.length && /^<!--\s*FORGE:[A-Z_:-]+\s*-->\s*$/.test(lines[0])) markers.push(/FORGE:[A-Z_:-]+/.exec(lines.shift())[0]);
    if (markers.length) out.set(markers[0], { markers, text: lines.join("\n").replace(/\s+$/, "") });
  }
  return out;
}

export function renderStatus(sections) {
  const parts = [markLine(STATUS_MARKER)];
  for (const { markers, text } of sections.values()) parts.push(`${STATUS_SEP}\n${markers.map(markLine).join("\n")}\n${text}`);
  return parts.join("\n");
}

/** `sections` with `markers` (array, first = key) set to `text`: replaced, or appended to the last N entries for APPEND_SECTIONS. */
export function putSection(sections, markers, text) {
  const next = new Map(sections);
  const key = markers[0], cap = APPEND_SECTIONS[key];
  let value = String(text ?? "").replace(/\s+$/, "");
  if (cap) {
    const old = sections.get(key)?.text;
    const entries = old ? old.split(ENTRY_SEP) : [];
    if (entries[entries.length - 1] !== value) entries.push(value);
    value = entries.slice(-cap).join(ENTRY_SEP);
  }
  next.delete(key); // keeps a stable insertion order: the newest write goes last
  next.set(key, { markers, text: value });
  return next;
}

/** The newest trusted status comment in `comments` (gh view shape), or null. */
export function findStatus(comments, trusted) {
  const list = (comments ?? []).filter((c) => isStatusBody(c?.body) && trusted(c) && commentId(c));
  return list.length ? list[list.length - 1] : null;
}
/** The newest trusted comment whose body starts with `<!-- marker` (a boundary follows: `FORGE:PARKED code=..` matches `FORGE:PARKED`). */
export function findLeading(comments, marker, trusted) {
  const re = new RegExp(`^\\s*<!--\\s*${esc(marker)}(?![A-Za-z0-9_:])`);
  const list = (comments ?? []).filter((c) => re.test(String(c?.body ?? "")) && trusted(c) && commentId(c));
  return list.length ? list[list.length - 1] : null;
}

/**
 * Write one status section for `issue`. `known` is the lane's cached `{id, sections}` (or null: look `comments` up). `create` posts a
 * new comment and returns its url; `patch(id, body)` edits one (throws on failure, then a new comment is created). Returns the cache.
 */
export async function writeStatus({ known, comments, trusted, markers, text, cap = (s) => s, create, patch }) {
  let id = known?.id ?? null, sections = known?.sections ?? null;
  if (!id) {
    const c = findStatus(comments, trusted);
    if (c) { id = commentId(c); sections = parseStatus(c.body); }
  }
  sections = putSection(sections ?? new Map(), markers, text);
  const body = cap(renderStatus(sections));
  if (id) {
    try { await patch(id, body); return { id, sections, url: null }; } catch { /* deleted or not ours: a new comment */ }
  }
  const url = await create(body);
  return { id: commentId({ url }), sections, url };
}

const asArr = (m) => (Array.isArray(m) ? m : [m]);
const newUrl = async (gh, repo, issue, body) => /https?:\/\/\S+/.exec(String(await gh(["issue", "comment", String(issue), "-R", repo, "--body", body])))?.[0] ?? null;
const patchWith = (gh, repo) => (id, body) => gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-f", `body=${body}`]);
const viewComments = async (gh, repo, issue) => { try { return JSON.parse(String(await gh(["issue", "view", String(issue), "-R", repo, "--json", "comments"])))?.comments ?? []; } catch { return []; } };

/** True when a post with these markers belongs in the status comment. */
export const isStatusPost = (marker) => STATUS_SECTIONS.includes(asArr(marker)[0]);
/** True when a post with these markers is edited in place. */
export const isUpsertPost = (marker) => UPSERT_MARKERS.includes(asArr(marker)[0]);

/**
 * gh-only variant for callers outside the lane (the batch runner): reads the issue's comments, then writes the section.
 * `trusted` defaults to the engine's own trust predicate (trusted association, Bot, or the ForgeDock App).
 */
export async function postStatusSection({ gh, repo, issue, markers, text, cap = (s) => s, trusted }) {
  const t = trusted ?? (await import("./prefilter.mjs")).isTrustedIssueComment;
  const r = await writeStatus({ comments: await viewComments(gh, repo, issue), trusted: t, markers: asArr(markers), text, cap,
    create: (b) => newUrl(gh, repo, issue, b), patch: patchWith(gh, repo) });
  return r.url;
}

/** Post `body` under `markers`, editing the newest trusted comment that already leads with the first marker. Returns the comment url. */
export async function postUpsert({ gh, repo, issue, markers, body, comments = null, cap = (s) => s, trusted, attrs = "" }) {
  const t = trusted ?? (await import("./prefilter.mjs")).isTrustedIssueComment;
  const ms = asArr(markers);
  const head = ms.map((m, i) => (i === 0 && attrs ? `<!-- ${m} ${attrs} -->` : markLine(m))).join("\n");
  const full = cap(`${head}\n${body}`);
  const prior = findLeading(comments ?? await viewComments(gh, repo, issue), ms[0], t);
  if (prior) {
    try { await patchWith(gh, repo)(commentId(prior), full); return prior.url ?? null; } catch { /* deleted or not ours: a new comment */ }
  }
  return newUrl(gh, repo, issue, full);
}

/** #5592: labels that mean "parked / waiting for a person or the remediation queue"; a live or finished issue must not keep them. */
export const isPipelineLabel = (name) => { const n = String(name ?? ""); return n === "needs-human" || n.startsWith("needs-human:") || n.startsWith("parked:") || n === "remediation-queue"; };
/** The pipeline labels among `labels` (names, or `{name}` objects). */
export const pipelineLabels = (labels) => (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(isPipelineLabel);

/**
 * Remove the pipeline labels from an issue. `labels` is what the caller already read (names or `{name}`); null re-reads them.
 * Best effort, returns the removed names ([] when none or on failure).
 */
export async function clearPipelineLabels({ gh, repo, issue, labels = null }) {
  try {
    const names = pipelineLabels(labels ?? JSON.parse(String(await gh(["issue", "view", String(issue), "-R", repo, "--json", "labels"])))?.labels);
    if (!names.length) return [];
    await gh(["issue", "edit", String(issue), "-R", repo, "--remove-label", names.join(",")]);
    return names;
  } catch { return []; }
}

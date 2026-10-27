// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4695: anchored decisions. A settled choice carries the paths/globs (and optional symbols) it governs and an optional
 * `supersedes` link. The record of truth is a `<!-- FORGE:DECISION {json} -->` issue comment (the JSON sits on the
 * marker line; prose FORGE:DECISION comments carry none and are ignored); `~/.forge/decisions/<repo>.json` indexes it.
 * Supersession appends a fresh record of the old decision (status superseded, superseded_by) on the old issue: the
 * latest record per id wins, nothing is edited. When a lane's deliverables hit an anchor the decision becomes an
 * engine-authored preserve row `{id:"H<n>", what, source:"decision"}` (same shape as #4694), capped at HISTORY_ROWS_MAX.
 * Pure except the index read/write; no LLM, gh or git here.
 */
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { noComments } from "./render.mjs";

export const DECISION_MARKER = "FORGE:DECISION";
/** Preserve rows the engine adds from history per lane; guards (#4694) share this cap. */
export const HISTORY_ROWS_MAX = 5;
const TEXT_MAX = 200;
const ANCHORS_MAX = 10;
const MARKER_RE = /^<!--\s*FORGE:DECISION\s+(\{.*\})\s*-->/;

const one = (v, max = TEXT_MAX) => {
  const t = typeof v === "string" ? noComments(v, " ").replace(/\s+/g, " ").trim() : "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const strs = (v, max = ANCHORS_MAX, len = 200) => [...new Set((Array.isArray(v) ? v : []).map((x) => one(x, len)).filter(Boolean))].slice(0, max);
const cleanAnchor = (a) => String(a).replace(/^\.\//, "").replace(/^\/+/, "");

/** A bounded decision record from raw input, or null when it has no choice or no anchor. `issue` is the register issue. */
export function normaliseDecision(raw, { issue = null, n = 1 } = {}) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const choice = one(r.choice), anchors = strs(r.anchors).map(cleanAnchor);
  if (!choice || !anchors.length) return null;
  const iss = Number.isInteger(r.issue) ? r.issue : issue;
  const status = r.status === "superseded" ? "superseded" : "active";
  const rec = { v: 1, id: one(r.id, 60) || `d${iss ?? 0}-${n}`, choice, why: one(r.why), anchors, issue: iss, status };
  const symbols = strs(r.symbols, ANCHORS_MAX, 80);
  if (symbols.length) rec.symbols = symbols;
  if (one(r.supersedes, 60)) rec.supersedes = one(r.supersedes, 60);
  if (status === "superseded" && one(r.superseded_by, 60)) rec.superseded_by = one(r.superseded_by, 60);
  return rec;
}

/** The marker (for post(): `<!-- FORGE:DECISION {json} -->`) and readable body of a decision record. */
export function renderDecision(rec) {
  const json = JSON.stringify(rec).replace(/>/g, "\\u003e").replace(/</g, "\\u003c"); // can never close the marker comment
  const tail = [rec.supersedes ? `Supersedes \`${rec.supersedes}\`.` : "", rec.status === "superseded" ? `Superseded by \`${rec.superseded_by}\`.` : ""].filter(Boolean).join(" ");
  return {
    marker: `${DECISION_MARKER} ${json}`,
    body: `## Decision \`${rec.id}\`${rec.status === "superseded" ? " (superseded)" : ""}\n**What**: ${rec.choice}\n**Why**: ${rec.why || "-"}\n**Governs**: ${rec.anchors.map((a) => `\`${a}\``).join(", ")}${tail ? `\n${tail}` : ""}`,
  };
}

/** The record from a comment body whose first line is `<!-- FORGE:DECISION {json} -->`; null for prose or malformed. */
export function parseDecisionComment(body, { issue = null } = {}) {
  const m = MARKER_RE.exec(String(body ?? "").split("\n", 1)[0]);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]);
    return normaliseDecision({ ...raw, issue: Number.isInteger(raw?.issue) ? raw.issue : issue });
  } catch { return null; }
}

/** One record per id, the latest wins (input in posting order); ids ordered by first appearance. */
export function foldDecisions(records) {
  const by = new Map();
  for (const r of records ?? []) if (r?.id) by.set(r.id, { ...(by.get(r.id) ?? {}), ...r });
  return [...by.values()];
}

const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
/** True when `anchor` (a file, a `dir/` prefix or a glob) covers `path`. */
export function anchorMatches(anchor, path) {
  const a = cleanAnchor(anchor), p = cleanAnchor(path);
  if (!a || !p) return false;
  if (a.endsWith("/")) return p.startsWith(a);
  return a === p || globRe(a).test(p) || p.startsWith(`${a}/`);
}

/** The anchors that match no file of `files`. */
export const deadAnchors = (anchors, files) => (anchors ?? []).filter((a) => !(files ?? []).some((f) => anchorMatches(a, f)));

/** Active decisions with at least one dead anchor on the base file list: [{decision, dead}]. Never applied. */
export function staleDecisions(records, baseFiles) {
  const out = [];
  for (const d of foldDecisions(records)) {
    if (d.status === "superseded") continue;
    const dead = deadAnchors(d.anchors, baseFiles);
    if (dead.length) out.push({ decision: d, dead });
  }
  return out;
}

/**
 * Preserve rows for the active decisions an anchor of which covers a deliverable path: most specific anchor first, then
 * newest issue, then id; at most `cap` rows, ids H<start>… Deterministic: the same inputs give the same rows.
 */
export function historyRows(records, deliverablePaths, { cap = HISTORY_ROWS_MAX, start = 1 } = {}) {
  const paths = (deliverablePaths ?? []).filter(Boolean);
  if (!paths.length || cap <= 0) return [];
  const hits = [];
  for (const d of foldDecisions(records)) {
    if (d.status === "superseded") continue;
    const spec = Math.max(-1, ...d.anchors.filter((a) => paths.some((p) => anchorMatches(a, p))).map((a) => cleanAnchor(a).length));
    if (spec >= 0) hits.push({ d, spec });
  }
  hits.sort((x, y) => y.spec - x.spec || (y.d.issue ?? 0) - (x.d.issue ?? 0) || (x.d.id < y.d.id ? -1 : x.d.id > y.d.id ? 1 : 0));
  return hits.slice(0, cap).map(({ d }, i) => ({
    id: `H${start + i}`,
    what: `${d.choice}${d.why ? ` (${d.why})` : ""} [decision ${d.id}${d.issue ? `, #${d.issue}` : ""}; to change it, amend {kind:"decision", decision:{choice, anchors, supersedes:"${d.id}"}, why}]`,
    source: "decision",
    decision: d.id,
  }));
}

/** The contract with history rows appended to preserve; the same object when none apply (the hash stays byte-identical). */
export function withDecisionRows(contract, records) {
  const have = new Set((contract?.preserve ?? []).map((p) => p.id));
  let start = 1;
  while (have.has(`H${start}`)) start++;
  const room = HISTORY_ROWS_MAX - (contract?.preserve ?? []).filter((p) => /^H\d+$/.test(String(p.id))).length;
  const rows = historyRows(records, (contract?.deliverables ?? []).map((d) => d.path), { cap: room, start });
  return rows.length ? { ...contract, preserve: [...(contract.preserve ?? []), ...rows] } : contract;
}

/** {old, next}: the old record marked superseded by the new id, the new one linked back with `supersedes`. */
export function supersede(old, next) {
  return { old: { ...old, status: "superseded", superseded_by: next.id }, next: { ...next, supersedes: old.id } };
}

export const decisionsDir = () => process.env.FORGEDOCK_DECISIONS_DIR || join(homedir(), ".forge", "decisions");
export const indexFile = (repo) => join(decisionsDir(), `${String(repo ?? "repo").replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/** The indexed records (posting order); [] when the index is absent or unreadable. One file read. */
export function readIndex(repo, { fs = nodeFs } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(repo), "utf8"));
    return (Array.isArray(j?.records) ? j.records : []).map((r) => normaliseDecision(r)).filter(Boolean);
  } catch { return []; }
}

/** Replaces the index (written atomically); best effort, the register of record is GitHub. */
export function writeIndex(repo, records, { fs = nodeFs } = {}) {
  try {
    const file = indexFile(repo);
    fs.mkdirSync(decisionsDir(), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, records: foldDecisions(records) }));
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch { return false; }
}

/**
 * Posts the lane's decision records as FORGE:DECISION on `issue` and, for a `supersedes`, the old record marked
 * superseded on its own issue (both records updated); then updates the index. `post(marker, body, onIssue)` posts a
 * comment. Returns the records posted. Best effort per record: a failed post is skipped, never fails the lane.
 */
export async function recordDecisions(list, { issue, repo, post, fs = nodeFs }) {
  const index = foldDecisions(readIndex(repo, { fs })), out = [];
  let n = 0;
  for (const raw of list ?? []) {
    n++;
    let next = normaliseDecision({ ...raw, id: undefined, issue }, { issue, n });
    if (!next) continue;
    const old = raw.supersedes ? index.find((d) => d.id === raw.supersedes) : null;
    let oldRec = null;
    if (old) ({ old: oldRec, next } = supersede(old, next));
    else if (raw.supersedes) next = { ...next, supersedes: String(raw.supersedes) };
    try {
      const m = renderDecision(next);
      await post(m.marker, m.body, issue);
      if (oldRec?.issue) { const o = renderDecision(oldRec); await post(o.marker, o.body, oldRec.issue); }
    } catch { continue; }
    index.push(...[oldRec, next].filter(Boolean));
    out.push(next);
  }
  if (out.length) writeIndex(repo, index, { fs });
  return out;
}

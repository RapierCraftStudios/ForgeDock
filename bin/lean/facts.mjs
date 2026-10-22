// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4401: the structured FORGE:FACTS record a lane posts next to its prose. The builder's judgment (decisions, rejected
 * approaches with why, hot spots file:line with why, conventions matched) comes from an optional result.json `facts`
 * key; baselines are the engine's own facts (result.json validation commands and exit codes); decisions fall back to
 * the frozen contract's. `files` (the lane's changed files) is the path index the context pack matches later lanes on.
 * Pure: no I/O. The same caps apply on write and on read, so a hand-edited or forged comment is bounded the same way.
 */
import { noComments } from "./render.mjs";

export const FACTS_MARKER = "FORGE:FACTS";
export const FACTS_TEXT_MAX = 160;
export const FACTS_LIST_MAX = 5;
export const FACTS_FILES_MAX = 20;
const KINDS = ["decisions", "rejected", "hotspots", "conventions", "baselines"];
const FACTS_BLOCK_RE = /```json\n([\s\S]*?)\n```/;
const AT_RE = /^[\w.@~+/-]+(?::\d+(?:-\d+)?)?$/;

const one = (v, max = FACTS_TEXT_MAX) => {
  const t = typeof v === "string" ? noComments(v, " ").replace(/\s+/g, " ").trim() : "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const list = (v) => (Array.isArray(v) ? v : []);
const uniqBy = (rows, key) => { const seen = new Set(); return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** The bounded, one-lined record from a raw object; every list capped, entries without their reason dropped. */
function clean(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const strs = (a) => uniqBy(list(a).map((x) => one(x)).filter(Boolean), (x) => x).slice(0, FACTS_LIST_MAX);
  const files = uniqBy(list(r.files).map((f) => (typeof f === "string" ? f.trim().replace(/^\.\//, "") : ""))
    .filter((f) => f && AT_RE.test(f) && !f.startsWith(".forge-lean/") && !f.split("/").includes("..")), (x) => x).slice(0, FACTS_FILES_MAX);
  const rejected = uniqBy(list(r.rejected).map((x) => ({ approach: one(x?.approach), why: one(x?.why) })).filter((x) => x.approach && x.why), (x) => x.approach).slice(0, FACTS_LIST_MAX);
  const hotspots = uniqBy(list(r.hotspots).map((x) => ({ at: one(x?.at, 200), why: one(x?.why) })).filter((x) => x.at && x.why && AT_RE.test(x.at) && !x.at.split("/").includes("..")), (x) => x.at).slice(0, FACTS_LIST_MAX);
  const baselines = uniqBy(list(r.baselines).map((x) => ({ command: one(x?.command, 200), exit: x?.exit })).filter((x) => x.command && Number.isInteger(x.exit)), (x) => x.command).slice(0, FACTS_LIST_MAX);
  return { v: 1, files, decisions: strs(r.decisions), rejected, hotspots, conventions: strs(r.conventions), baselines };
}
const hasContent = (f) => KINDS.some((k) => f[k].length > 0);

/**
 * The lane's FORGE:FACTS record, or null when it would carry nothing. `result` is result.json (its `facts` and
 * `validation`), `files` the lane's changed files, `contract` the frozen contract (decision fallback).
 */
export function normaliseFacts(result, { files = [], contract = null } = {}) {
  const raw = result?.facts && typeof result.facts === "object" ? result.facts : {};
  const decisions = list(raw.decisions).some((d) => one(d)) ? raw.decisions : list(contract?.decisions).map((d) => d?.choice);
  const baselines = list(result?.validation).map((v) => ({ command: v?.command, exit: v?.exit }));
  const f = clean({ ...raw, decisions, baselines, files });
  return hasContent(f) ? f : null;
}

/** JSON for a comment: `<` and backticks escaped, so builder text can never open a comment or close the fence. */
const factsJson = (f) => JSON.stringify(f).replace(/</g, "\\u003c").replace(/`/g, "\\u0060");

/** The FORGE:FACTS comment body (without the marker line): a count line plus the record as fenced JSON. */
export function renderFactsRecord(f) {
  return `## Lane facts\n${f.rejected.length} rejected approach(es), ${f.hotspots.length} hot spot(s), ${f.decisions.length} decision(s), ${f.conventions.length} convention(s), ${f.baselines.length} baseline(s) on ${f.files.length} file(s); read by later lanes on the same files.\n\n\`\`\`json\n${factsJson(f)}\n\`\`\``;
}

/** The record from a FORGE:FACTS comment body, re-bounded with the same caps; null for any other or malformed body. */
export function parseFactsComment(body) {
  const s = String(body ?? "");
  if (!new RegExp(`^\\s*<!--\\s*${FACTS_MARKER}\\s*-->`).test(s)) return null;
  const m = FACTS_BLOCK_RE.exec(s);
  if (!m) return null;
  let raw;
  try { raw = JSON.parse(m[1]); } catch { return null; }
  const f = clean(raw);
  return hasContent(f) ? f : null;
}

/** The one-line pack items of a record, by kind (`ref` names its provenance, e.g. "#33, PR #101"). */
export function factsLines(f, ref) {
  const tag = ref ? ` (${ref})` : "";
  return {
    rejected: f.rejected.map((x) => `- rejected: ${x.approach} — ${x.why}${tag}`),
    hotspots: f.hotspots.map((x) => `- hot spot ${x.at}: ${x.why}${tag}`),
    decisions: f.decisions.map((x) => `- decision: ${x}${tag}`),
    conventions: f.conventions.map((x) => `- convention: ${x}${tag}`),
    baselines: f.baselines.map((x) => `- baseline: \`${x.command.replace(/`/g, "'")}\` exit ${x.exit}${tag}`),
  };
}
/** Pack rank of the kinds: rejected approaches first (the knowledge most often lost), then hot spots, decisions, conventions, baselines. */
export const FACTS_RANK = Object.freeze(["rejected", "hotspots", "decisions", "conventions", "baselines"]);

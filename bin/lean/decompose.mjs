// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Decomposition gate (#4396): a builder `split-required` block is admitted only when its sub-issues touch disjoint
 * areas (each declares `paths`) or the block's `size` estimate exceeds the large-lane budget; otherwise the issue stays
 * one lane with an ordered checklist. Also the batch report's decomposed vs single-lane $/parent line. Pure: no I/O.
 */

/** The large-lane size budget: a split of overlapping parts is admitted only above it. */
export const SPLIT_MIN_FILES = 25;
export const SPLIT_MIN_LINES = 1500;

const norm = (p) => String(p).trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The block's `size` as {files, lines} (null fields when not a finite non-negative number), or null when absent. */
function sizeOf(block) {
  const s = block?.size;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const files = count(s.files), lines = count(s.lines);
  return files == null && lines == null ? null : { files, lines };
}

/**
 * @param {object} block result.json `block` of kind split-required (sub-issues already checked for title and body)
 * @returns {{ok:true, rationale:{independent:boolean, oversize:boolean, overlaps:Array<[number,number,string,string]>, missing:number[], size:?{files:?number, lines:?number}}} | {ok:false, problem:string}}
 */
export function splitGate(block) {
  const subs = Array.isArray(block?.subissues) ? block.subissues : [];
  const paths = subs.map((s) => (Array.isArray(s?.paths) ? s.paths.filter((p) => typeof p === "string" && norm(p)).map(norm) : []));
  const missing = paths.flatMap((p, i) => (p.length ? [] : [i]));
  const found = [];
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      for (const a of paths[i]) for (const b of paths[j]) if (overlaps(a, b)) found.push([i, j, a, b]);
    }
  }
  const independent = subs.length > 0 && !missing.length && !found.length;
  const size = sizeOf(block);
  const oversize = !!size && ((size.files ?? 0) > SPLIT_MIN_FILES || (size.lines ?? 0) > SPLIT_MIN_LINES);
  if (independent || oversize) return { ok: true, rationale: { independent, oversize, overlaps: found, missing, size } };
  const why = [];
  if (missing.length) why.push(`sub-issue(s) ${missing.join(", ")} declare no "paths"`);
  if (found.length) why.push(`the parts overlap (${found.slice(0, 5).map(([i, j, a, b]) => `${i}:${a} ~ ${j}:${b}`).join("; ")})`);
  why.push(size ? `the size estimate (${size.files ?? "?"} files, ${size.lines ?? "?"} lines) is within the ${SPLIT_MIN_FILES}-file / ${SPLIT_MIN_LINES}-line budget` : "the block has no \"size\" estimate");
  return { ok: false, problem: `the split is not justified: ${why.join("; ")}. Split only when every sub-issue lists "paths" disjoint from the others, or when "size" exceeds ${SPLIT_MIN_FILES} files or ${SPLIT_MIN_LINES} lines. Otherwise keep one lane: write the contract as an ordered checklist, one requirement or deliverable per item, each with its own validate command` };
}

/** One line for the FORGE:DECOMPOSED comment and the decision log. */
export function rationaleLine(r) {
  if (!r) return "";
  const ov = r.overlaps?.length ? ` (overlaps ${r.overlaps.slice(0, 3).map(([i, j, a, b]) => `${i}:${a} ~ ${j}:${b}`).join("; ")})` : r.missing?.length ? ` (no paths: ${r.missing.join(", ")})` : "";
  const sz = r.size ? `${r.size.files ?? "?"} files, ${r.size.lines ?? "?"} lines` : "no estimate";
  return `independent: ${r.independent ? "yes" : "no"}${ov}; size: ${sz} vs budget ${SPLIT_MIN_FILES} files / ${SPLIT_MIN_LINES} lines -> oversize ${r.oversize ? "yes" : "no"}`;
}

/**
 * Batch-report line: cost per decomposed parent (its row plus its sub-issue rows, recursively) vs per single-lane
 * parent (a merged row that is no row's sub-issue). Null when no row decomposed.
 */
export function formatDecompositionSummary(rows) {
  const list = (rows ?? []).filter((r) => r && Number.isSafeInteger(r.issue));
  const subsOf = (r) => (r?.outcome === "decomposed" && Array.isArray(r.subissues) ? r.subissues.filter((n) => Number.isSafeInteger(n) && n !== r.issue) : []);
  const byIssue = new Map(list.map((r) => [r.issue, r]));
  const isSub = new Set(list.flatMap(subsOf));
  const parents = list.filter((r) => subsOf(r).length && !isSub.has(r.issue));
  if (!list.some((r) => subsOf(r).length)) return null;
  let lanes = 0, outside = 0;
  const total = (r, seen) => {
    let c = Number(r.cost_usd) || 0;
    for (const n of subsOf(r)) {
      if (seen.has(n)) continue;
      seen.add(n);
      const s = byIssue.get(n);
      if (!s) { outside++; continue; }
      lanes++;
      c += total(s, seen);
    }
    return c;
  };
  const dCost = parents.reduce((a, r) => a + total(r, new Set([r.issue])), 0);
  const single = list.filter((r) => r.outcome === "merged" && !isSub.has(r.issue));
  const sCost = single.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
  const per = (c, n) => `$${(n ? c / n : 0).toFixed(2)}/parent`;
  return `decomposition: ${parents.length} decomposed parent${parents.length === 1 ? "" : "s"} ${per(dCost, parents.length)} (${lanes} sub-lane${lanes === 1 ? "" : "s"}${outside ? `, ${outside} outside this batch` : ""}); `
    + (single.length ? `${single.length} single-lane ${per(sCost, single.length)}` : "single-lane none");
}

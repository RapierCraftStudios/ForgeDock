// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5824: the batch dependency DAG, built in code (no LLM): `forgedock orchestrate` prints it as the plan table before the
 * first lane and keeps it in the batch plan, so a resume schedules from the same edges and the report counts false holds.
 *
 * Edge X -> N (N waits until X merges) comes from two sources only:
 * - declared: N's trusted body has a `Depends on #X` / `Blocked by #X` line (bold, list, `:`, comma/and lists, any case),
 *   read by the engine's own parser (`parseDependsOn`), so the plan and the admission check agree;
 * - logical: X's frozen contract (its last trusted FORGE:CONTRACT comment) delivers a file that is not on the base yet and
 *   N's body names that path (N uses what X creates). No contract, no logical edge.
 * Predicted file overlap (paths named in both bodies, or a shared existing deliverable) is a warning in the plan, never an
 * edge: each lane merges its base and resolves the conflict itself. A cycle that a logical edge closes drops that edge.
 * False hold: a planned edge no longer present when the batch ends (an operator removed the line), counted per batch.
 */
import { parseDependsOn, isTrustedActor } from "../engine/phases.mjs";
import { parseContractComment } from "./render.mjs";
import { namedPaths } from "./prefilter.mjs";
import { cyclicNodes } from "./orchestrate.mjs";

const CONTRACT_HEAD = "<!-- FORGE:CONTRACT -->";
const commentTrusted = (c) => isTrustedActor({ association: c?.authorAssociation ?? c?.author_association, type: c?.author?.is_bot ? "Bot" : c?.user?.type, login: c?.author?.login ?? c?.user?.login });

/** Deliverable paths of the last trusted, parseable FORGE:CONTRACT comment (`gh --json comments` shape), or []. */
export function contractDeliverables(comments, { trusted = commentTrusted } = {}) {
  let out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = String(c?.body ?? "").trimStart();
    if (!body.startsWith(CONTRACT_HEAD) || !trusted(c)) continue;
    const d = parseContractComment(body)?.contract?.deliverables;
    if (Array.isArray(d)) out = [...new Set(d.map((x) => x?.path).filter((p) => typeof p === "string" && p))];
  }
  return out;
}

/** One issue's plan inputs from a `gh issue view` object: `{title, body, trusted, files, deliverables}`. */
export function planView(v, { trusted = false } = {}) {
  const body = String(v?.body ?? "");
  return { title: String(v?.title ?? ""), body, trusted: trusted === true, files: namedPaths(body), deliverables: contractDeliverables(v?.comments) };
}

/** Declared dependencies of `n` (only a trusted body declares, the engine admission's rule). */
export function declaredDeps(n, view) {
  return view?.trusted ? parseDependsOn(view.body, n) : [];
}

/**
 * The batch DAG. `views`: Map issue -> planView; `exists(path)`: the path is on the lane base (a deliverable already there
 * is shared work, an overlap, not a prerequisite). Returns `{edges:[{from,to,kind,why?}], outside:[{issue,dep}],
 * overlaps:[{a,b,files}], dropped:[edge]}`; `outside` lists declared dependencies not in the batch (the runner pulls open ones in).
 */
export function buildDag(issues, views, { exists = () => false } = {}) {
  const set = new Set(issues), edges = [], outside = [], seen = new Set();
  const add = (e) => { const k = `${e.from}>${e.to}`; if (e.from === e.to || seen.has(k)) return; seen.add(k); edges.push(e); };
  for (const n of issues) for (const d of declaredDeps(n, views.get(n))) {
    if (set.has(d)) add({ from: d, to: n, kind: "declared" }); else outside.push({ issue: n, dep: d });
  }
  const isNew = (p) => { try { return !exists(p); } catch { return false; } };
  for (const x of issues) for (const p of (views.get(x)?.deliverables ?? []).filter(isNew)) {
    for (const n of issues) {
      const v = views.get(n);
      if (n === x || !v?.files.includes(p) || v.deliverables.includes(p)) continue;
      add({ from: x, to: n, kind: "logical", why: p });
    }
  }
  const dropped = [];
  const depsOf = (n) => edges.filter((e) => e.to === n).map((e) => e.from);
  for (let cyc = cyclicNodes(issues, depsOf); cyc.size; cyc = cyclicNodes(issues, depsOf)) {
    const weak = edges.filter((e) => e.kind === "logical" && cyc.has(e.from) && cyc.has(e.to));
    if (!weak.length) break; // a declared cycle stays: the runner reports it (#5162)
    for (const e of weak) { dropped.push(e); edges.splice(edges.indexOf(e), 1); }
  }
  const overlaps = [];
  for (let i = 0; i < issues.length; i++) for (let j = i + 1; j < issues.length; j++) {
    const a = views.get(issues[i]), b = views.get(issues[j]);
    if (!a || !b) continue;
    const fa = new Set([...a.files, ...a.deliverables]);
    const files = [...new Set([...b.files, ...b.deliverables])].filter((f) => fa.has(f));
    if (files.length && !seen.has(`${issues[i]}>${issues[j]}`) && !seen.has(`${issues[j]}>${issues[i]}`)) overlaps.push({ a: issues[i], b: issues[j], files });
  }
  return { edges, outside, overlaps, dropped };
}

/** Logical dependencies of `n` in a (persisted) DAG: the runner adds them to the declared ones. */
export function logicalDepsOf(dag, n) {
  return (dag?.edges ?? []).filter((e) => e.kind === "logical" && e.to === n).map((e) => e.from);
}

const cell = (s, max = 48) => { const t = String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t || "-"; };

/** The plan table (issue, title, waits on, likely files, overlap warning) and its summary lines. */
export function formatPlan(issues, views, dag, { parallel = null, parallelFrom = null } = {}) {
  const lines = [`plan: ${issues.length} issue(s), ${dag.edges.length} edge(s) (declared ${dag.edges.filter((e) => e.kind === "declared").length}, logical ${dag.edges.filter((e) => e.kind === "logical").length})${parallel ? `, K=${parallel}${parallelFrom ? ` (${parallelFrom})` : ""}` : ""}`,
    "| issue | title | waits on | likely files | overlap (warning) |", "| --- | --- | --- | --- | --- |"];
  for (const n of issues) {
    const v = views.get(n);
    const waits = dag.edges.filter((e) => e.to === n).map((e) => `#${e.from}${e.kind === "logical" ? ` (logical: ${e.why})` : ""}`);
    const out = dag.outside.filter((o) => o.issue === n).map((o) => `#${o.dep} (outside)`);
    const ov = dag.overlaps.filter((o) => o.a === n || o.b === n).map((o) => `#${o.a === n ? o.b : o.a}`);
    lines.push(`| #${n} | ${cell(v?.title)} | ${[...waits, ...out].join(", ") || "-"} | ${cell((v?.files ?? []).slice(0, 3).join(", "), 60)} | ${ov.join(", ") || "-"} |`);
  }
  for (const e of dag.dropped) lines.push(`plan: dropped logical edge #${e.from} -> #${e.to} (${e.why}): it closed a cycle`);
  if (dag.overlaps.length) lines.push(`plan: overlaps are warnings only, never edges: ${dag.overlaps.map((o) => `#${o.a}/#${o.b} (${o.files.slice(0, 2).join(", ")})`).join("; ")}`);
  return lines;
}

/**
 * False holds: planned edges an operator removed before the batch ended. `currentDeps(n)` is n's declared dependencies now
 * (null = unreadable: its edges are not judged). Logical edges are code-derived and not judged. Returns the removed edges.
 */
export async function falseHolds(dag, currentDeps) {
  const removed = [], byTo = new Map();
  for (const e of (dag?.edges ?? []).filter((x) => x.kind === "declared")) byTo.set(e.to, [...(byTo.get(e.to) ?? []), e]);
  for (const [n, es] of byTo) {
    let now;
    try { now = await currentDeps(n); } catch { now = null; }
    if (!Array.isArray(now)) continue;
    for (const e of es) if (!now.includes(e.from)) removed.push(e);
  }
  return removed;
}

/** `false holds: R/P planned edges removed by an operator (...)`, or null without planned edges. */
export function formatFalseHolds(dag, removed) {
  const planned = (dag?.edges ?? []).length;
  if (!planned) return null;
  return `false holds: ${removed.length}/${planned} planned edge(s) removed by an operator${removed.length ? ` (${removed.map((e) => `#${e.to} on #${e.from}`).join(", ")})` : ""}`;
}

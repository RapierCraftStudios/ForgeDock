// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5751: recurrence routing. A new issue that matches at least `threshold` earlier merged fixes by symptom (subject recall
 * or an explicit `Recurs #n` link) AND by area (the fix touched a path the issue names) is a recurrence: the lane runs as a
 * design lane (no light lane, a stricter plan prompt, a contract `design` block) instead of adding a further fix.
 * Deterministic: zero LLM calls. The engine's inputs are subjectHistory rows (context.mjs) and the merged PRs' file lists.
 */
import { OUTCOME_CODES as C } from "../engine/outcome-codes.mjs";
import { subjectHistory } from "./context.mjs";

export const RECURRENCE_DEFAULTS = Object.freeze({ mode: "on", threshold: 2 });
/** At most this many merged rows have their file lists read (one GitHub call each). */
export const MAX_RECURRENCE_ROWS = 6;

const clean = (p) => String(p ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);
const COUNTER_SEP = " -- "; // `pattern -- glob, glob`: the git grep pathspec separator

/**
 * forge.yaml `recurrence:` (absent: the defaults, mode on). `hot_areas` is a list of {name, paths} or a block map
 * {name: "glob, glob"}; `counters` a list of {name, pattern, paths} or a block map {name: "pattern -- glob, glob"}.
 * @returns {{mode:"on"|"off", threshold:number, hotAreas:{name:string, paths:string[]}[], counters:{name:string, pattern:string, paths:string[]}[]}}
 */
export function parseRecurrenceConfig(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const m = String(r.mode ?? "").trim().toLowerCase();
  const mode = r.mode === false || m === "off" || m === "false" ? "off" : RECURRENCE_DEFAULTS.mode;
  const t = Number(r.threshold);
  const threshold = Number.isInteger(t) && t >= 1 ? t : RECURRENCE_DEFAULTS.threshold;
  const rows = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).map(([name, val]) => ({ name, val })) : []);
  const hotAreas = rows(r.hot_areas).map((x) => ({ name: String(x?.name ?? "").trim(), paths: list(x?.paths ?? x?.val).map(clean) }))
    .filter((a) => a.name && a.paths.length);
  const counters = rows(r.counters).map((x) => {
    if (x?.val !== undefined) {
      const s = String(x.val), i = s.lastIndexOf(COUNTER_SEP);
      return { name: String(x.name).trim(), pattern: (i >= 0 ? s.slice(0, i) : s).trim(), paths: i >= 0 ? list(s.slice(i + COUNTER_SEP.length)).map(clean) : [] };
    }
    return { name: String(x?.name ?? "").trim(), pattern: String(x?.pattern ?? "").trim(), paths: list(x?.paths).map(clean) };
  }).filter((c) => c.name && c.pattern);
  return { mode, threshold, hotAreas, counters };
}

/** Issue numbers named by `Recurs #n` (also `Recurs: #n`, `Recurs of #n`, `Recurs #n, #m`). */
export function recursLinks(body = "") {
  const out = new Set();
  for (const m of String(body ?? "").matchAll(/\brecurs(?:\s+of)?\s*:?\s*((?:#\d+[\s,]*(?:and\s+)?)+)/gi)) for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  return [...out].filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** Two paths overlap when they are equal or one is a directory prefix of the other. */
export function pathsOverlap(a, b) {
  const x = clean(a), y = clean(b);
  return Boolean(x && y) && (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`));
}

/** #5979: backticked error/outcome-code/test signatures of the issue body (identifier-shaped, not a path). */
function symptomTerms(body) {
  return [...new Set([...String(body ?? "").matchAll(/`([A-Za-z][\w.:-]{3,79})`/g)].map((m) => m[1].toLowerCase()).filter((t) => !/\.(?:m?[jt]sx?|md|json|ya?ml|py|sh)$/.test(t)))];
}

/** #5979: a subjectHistory row shares the issue's symptom: it matched on a code-shaped term (outcome code, error name, symbol), on two or more terms, or its title carries a backticked signature of the issue. */
function symptomMatch(row, terms) {
  const m = (row?.matched ?? []).map(String);
  return m.some((t) => /[._:-]|\d|[a-z][A-Z]|^[A-Z0-9_]{3,}$/.test(t)) || m.length >= 2 || terms.some((t) => String(row?.title ?? "").toLowerCase().includes(t));
}

/**
 * Count earlier merged fixes on the same symptom and the same area. A subjectHistory row counts when it is a merged PR
 * whose files (`mergedPrFiles[number]`) overlap a path the issue names AND that shares the symptom (#5979: path-only overlap never counts). A `Recurs #n` link is an explicit symptom match:
 * it counts when its files overlap or are unknown (the author declared the same area). Rows without overlap never count.
 * @returns {{recurs:boolean, count:number, threshold:number, evidence:{number:number, title:string, via:string, paths:string[]}[], reason:string}}
 */
export function detectRecurrence({ rows = [], mergedPrFiles = {}, body = "", namedPaths = [], threshold = RECURRENCE_DEFAULTS.threshold } = {}) {
  const named = [...new Set((namedPaths ?? []).map(clean).filter(Boolean))];
  const filesOf = (n) => (mergedPrFiles instanceof Map ? mergedPrFiles.get(n) : mergedPrFiles?.[n]);
  const evidence = [], seen = new Set();
  const sym = symptomTerms(body);
  for (const r of rows ?? []) {
    const n = Number(r?.number);
    if (!Number.isSafeInteger(n) || seen.has(n) || r?.kind !== "PR" || r?.status !== "merged") continue;
    if (!symptomMatch(r, sym)) continue; // #5979: path overlap alone is the same area, not the same symptom
    const paths = (filesOf(n) ?? []).map(clean).filter((f) => named.some((p) => pathsOverlap(f, p)));
    if (!paths.length) continue;
    seen.add(n);
    evidence.push({ number: n, title: String(r.title ?? ""), via: `subject (${(r.matched ?? []).join(", ")})`, paths: [...new Set(paths)] });
  }
  for (const n of recursLinks(body)) {
    if (seen.has(n)) continue;
    const files = filesOf(n);
    const paths = Array.isArray(files) ? files.map(clean).filter((f) => named.some((p) => pathsOverlap(f, p))) : null;
    if (paths && !paths.length) continue;
    seen.add(n);
    evidence.push({ number: n, title: "", via: "Recurs link", paths: paths ?? [] });
  }
  const t = Number.isInteger(threshold) && threshold >= 1 ? threshold : RECURRENCE_DEFAULTS.threshold;
  const count = evidence.length, recurs = count >= t;
  const reason = recurs
    ? `recurrence: ${count} earlier merged fix(es) on the same symptom and area (threshold ${t}): ${evidence.map((e) => `#${e.number}${e.paths.length ? ` (${e.paths.slice(0, 3).join(", ")})` : ""}`).join(", ")}`
    : "";
  return { recurs, count, threshold: t, evidence, reason };
}

/**
 * The engine-side gather: subjectHistory rows plus one file-list read per merged row (capped). `io`: {gh, git}. Never
 * throws: a failed source contributes nothing and lands in `errors`.
 */
export async function recurrenceFacts({ io, repo, issue, title = "", body = "", base = null, namedPaths = [], threshold, exclude = [], createdAt = null }) {
  const errors = [];
  let rows = [];
  try { const h = await subjectHistory({ io, repo, issue, title, body, base, exclude }); rows = h.rows ?? []; errors.push(...(h.errors ?? [])); } catch (e) { errors.push(`recurrence: ${String(e?.message ?? e).slice(0, 80)}`); }
  // #6016: a release PR (head release/*) touches every shipped file, and a PR merged after the issue was filed cannot be an
  // earlier fix that did not hold: neither is evidence. A row whose metadata cannot be read stays (explicit Recurs links too).
  const created = Date.parse(createdAt ?? "");
  const notEvidence = new Set();
  for (const r of rows.filter((x) => x?.kind === "PR" && x?.status === "merged").slice(0, MAX_RECURRENCE_ROWS)) {
    try {
      const m = JSON.parse(String(await io.gh(["api", `repos/${repo}/pulls/${Number(r.number)}`, "--jq", "{head: .head.ref, merged: .merged_at}"])));
      if (isReleaseHead(m?.head) || (Number.isFinite(created) && Date.parse(m?.merged ?? "") > created)) notEvidence.add(Number(r.number));
    } catch { /* unreadable: keep the row */ }
  }
  rows = rows.filter((r) => !notEvidence.has(Number(r?.number)));
  const wanted = [...new Set([...rows.filter((r) => r?.kind === "PR" && r?.status === "merged").map((r) => Number(r.number)), ...recursLinks(body)])].slice(0, MAX_RECURRENCE_ROWS);
  const mergedPrFiles = {};
  if (namedPaths.length) {
    for (const n of wanted) {
      try {
        const out = String(await io.gh(["api", `repos/${repo}/pulls/${n}/files`, "--paginate", "--jq", ".[].filename"]));
        mergedPrFiles[n] = out.split("\n").map((x) => x.trim()).filter(Boolean);
      } catch { /* not a PR (an issue link) or unreadable: unknown files */ }
    }
  }
  return { ...detectRecurrence({ rows, mergedPrFiles, body, namedPaths, threshold }), errors };
}

/** #6016: a staging->default release PR head (`release/...`). */
export const isReleaseHead = (ref) => /^release\//.test(String(ref ?? ""));

/** The design lane's plan instruction (#5751): why the earlier fixes failed, delete or replace, a measurable outcome. */
export function designLaneNote(detection) {
  if (!detection?.recurs) return "";
  const ev = detection.evidence.map((e) => `- #${e.number}${e.title ? ` ${e.title}` : ""} [${e.via}]${e.paths.length ? `: ${e.paths.join(", ")}` : ""}`).join("\n");
  return `\n\nDESIGN LANE (#5751): this issue recurs. ${detection.count} earlier merged fix(es) hit the same symptom in the same area:\n${ev}\nDo not add another patch on top of them. Read each earlier fix (gh pr view N, git show) as an active input, then put a "design" object in .forge-lean/contract.json:
{"design":{"why_failed":"<why the earlier fixes did not hold, naming them>","disposition":"delete|replace|extend","outcome":{"metric":"<what is measured>","target":"<the value that shows it held>"}}}
Prefer "delete" or "replace" of the earlier fixes; "extend" needs its reason in why_failed. The outcome needs a validate (test, counter or check) that measures it. When the redesign is too big for one lane, decompose it into ordinary lanes with the split-required block.`;
}

/** #5751: a design lane's contract must carry design {why_failed, disposition delete|replace|extend, outcome {metric, target}}. */
export function designContractFailures(contract, detection) {
  if (!detection?.recurs) return [];
  // #5918/#5979: a design block is demanded once. Asked for on an earlier run and still absent, it is not demanded again: the repeat parks (failure.repeated) for a decision.
  if (detection.demanded) {
    const d0 = contract?.design;
    if (d0 && typeof d0 === "object" && !Array.isArray(d0)) return designContractFailures(contract, { ...detection, demanded: false });
    return [{ code: C.FAILURE_REPEATED, kind: "design_missing_repeated", detail: `recurring issue (${detection.count} earlier fixes): the design block was already demanded on an earlier run and is still missing; parked for a decision instead of demanding it again` }];
  }
  const d = contract?.design, problems = [];
  const s = (v) => typeof v === "string" && v.trim();
  if (!d || typeof d !== "object" || Array.isArray(d)) problems.push("no design block");
  else {
    if (!s(d.why_failed)) problems.push("design.why_failed is empty");
    if (!["delete", "replace", "extend"].includes(String(d.disposition ?? "").trim())) problems.push("design.disposition is not delete, replace or extend");
    if (!s(d.outcome?.metric) || !(s(d.outcome?.target) || Number.isFinite(d.outcome?.target))) problems.push("design.outcome needs a metric and a target");
  }
  return problems.length ? [{ code: C.RECURRENCE_DESIGN_MISSING, kind: "design_missing", detail: `recurring issue (${detection.count} earlier fixes) routed to a design lane: ${problems.join("; ")}` }] : [];
}

/** #5979: true when an earlier NEEDS_HUMAN/PARKED comment of the issue already reported the missing design block. */
export const designDemanded = (comments) => (Array.isArray(comments) ? comments : []).some((c) => /<!--\s*FORGE:(?:NEEDS_HUMAN|PARKED)/.test(String(c?.body ?? "")) && /routed to a design lane:/.test(String(c?.body ?? "")));

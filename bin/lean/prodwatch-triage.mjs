// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Triage of normalised prod-watch signals (#4834, part of #4768): fingerprint, dedup into clusters (against each other and
 * against open issues that embed `<!-- FORGE:SIGNAL_REF fp=<fp> -->`), deterministic classification from the repo's alert
 * rules, and read-only validation. Pure apart from `io`; no LLM, no fs. Validation reaches production only through
 * prodwatch-sources `runAdapter` (declared `list`/`read`/`run` commands), never `close`. Repo-agnostic: rules come from the
 * policy text `loadPolicy` returns (#1347).
 */
import { createHash } from "node:crypto";
import { runAdapter } from "./prodwatch-sources.mjs";

export const CLASSES = ["incident", "defect", "monitoring-bug", "expected-class", "deploy-fallout", "transient"];
const SEV_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, unknown: 4 };

/** Built-in fallback rules, first match wins; a repo's `Alert rules:` list is tried before these. */
export const DEFAULT_RULES = [
  { class: "expected-class", re: /\b(expected|routine|scheduled|heartbeat|backup completed|no action needed)\b/i },
  { class: "monitoring-bug", re: /\b(false positive|monitoring bug|alert misfire|stale metric|flapping alert)\b/i },
  { class: "transient", re: /\b(transient|retry succeeded|self[- ]recovered|recovered automatically)\b/i },
  { class: "deploy-fallout", re: /\b(after (the )?deploy|post-deploy|regression since release)\b/i },
  { class: "incident", re: /\b(outage|unavailable|service down|data loss)\b/i },
];

/** Stable across copies of one signal: ids, hex, hosts, timestamps and numbers (any token with a digit) are stripped. */
export function fingerprint(signal) {
  const text = `${signal?.title ?? ""}\n${signal?.body ?? ""}`.toLowerCase()
    .replace(/\b\w*\d\w*\b/g, "#")
    .replace(/#(?:[-:./]#)+/g, "#")
    .replace(/[^a-z#]+/g, " ").trim();
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** The marker an issue body embeds so later rounds dedup against it. */
export const signalRef = (fp) => `<!-- FORGE:SIGNAL_REF fp=${fp} -->`;

/** fingerprint -> issue number for every open issue carrying a SIGNAL_REF marker (first issue wins). */
function refsOf(openIssues) {
  const map = new Map();
  for (const it of Array.isArray(openIssues) ? openIssues : []) {
    for (const m of String(it?.body ?? "").matchAll(/<!--\s*FORGE:SIGNAL_REF\b([^>]*?)-->/g)) {
      for (const f of m[1].matchAll(/\bfp=([0-9a-f]{6,64})/g)) if (!map.has(f[1])) map.set(f[1], it.number ?? null);
    }
  }
  return map;
}

/** Group signals by fingerprint: `[{fingerprint, signals, count, first_seen, last_seen, severity, owner, duplicateOf}]`, biggest first. */
export function cluster(signals, openIssues = []) {
  const refs = refsOf(openIssues), groups = new Map();
  for (const s of Array.isArray(signals) ? signals : []) {
    const fp = fingerprint(s);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(s);
  }
  const min = (a) => a.filter(Boolean).sort()[0] ?? null, max = (a) => a.filter(Boolean).sort().at(-1) ?? null;
  return [...groups].map(([fp, list]) => ({
    fingerprint: fp, signals: list, count: list.length,
    first_seen: min(list.map((s) => s.first_seen)), last_seen: max(list.map((s) => s.last_seen)),
    severity: list.map((s) => s.severity ?? "unknown").sort((a, b) => (SEV_RANK[a] ?? 4) - (SEV_RANK[b] ?? 4))[0] ?? "unknown",
    owner: list.find((s) => s.owner)?.owner ?? null,
    duplicateOf: refs.has(fp) ? refs.get(fp) : null,
  })).sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));
}

const isRegexSource = (s) => /^\/(.+)\/([a-z]*)$/s.exec(s);

/**
 * Rules from the policy text `loadPolicy` returns: an optional list under an `Alert rules:` line, each item
 * `- <class>: /regex/flags` or `- <class>: word, word`. Returns `{rules, warnings}`; the repo's rules come first, then DEFAULT_RULES.
 */
export function parseAlertRules(policyText) {
  const rules = [], warnings = [];
  let inList = false;
  for (const line of String(policyText ?? "").split(/\r?\n/)) {
    if (!inList) { inList = /^[\s#*]*alert rules\b[^:\n]*:\s*\**\s*$/i.test(line); continue; }
    const m = /^\s*[-*]\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) { if (line.trim() === "" || /^\s*[-*]/.test(line)) continue; inList = false; continue; }
    const [, cls, spec] = m;
    if (!CLASSES.includes(cls)) { warnings.push(`alert rule class ${cls} unknown: dropped`); continue; }
    try {
      const r = isRegexSource(spec);
      rules.push({ class: cls, re: r ? new RegExp(r[1], r[2].includes("i") ? r[2] : `${r[2]}i`) : new RegExp(`\\b(${spec.split(",").map((w) => w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean).join("|")})\\b`, "i") });
    } catch { warnings.push(`alert rule for ${cls} is not a valid pattern: dropped`); }
  }
  return { rules: [...rules, ...DEFAULT_RULES], warnings };
}

/** One of CLASSES: first matching rule over the cluster's text; else a P0 cluster is an incident; else a defect. */
export function classifyCluster(clusterIn, rules = DEFAULT_RULES) {
  const text = (clusterIn?.signals ?? []).map((s) => `${s.title ?? ""}\n${s.body ?? ""}`).join("\n");
  for (const r of Array.isArray(rules) ? rules : []) if (CLASSES.includes(r?.class) && r.re instanceof RegExp && new RegExp(r.re.source, r.re.flags.replace(/[gy]/g, "")).test(text)) return r.class;
  return clusterIn?.severity === "P0" ? "incident" : "defect";
}

/**
 * Re-run the declared read-only queries (`sources` = parseSources output, memo sources skipped: a memo is the claim, not a
 * reproduction) through runAdapter and attach what reproduces the cluster: a result with the same fingerprint or the same
 * `query` as one of the cluster's signals, or whatever `io.match(cluster, signal)` accepts. Returns the cluster plus
 * `{class, evidence, errors, fileable, reason}`. Not fileable: a duplicate of an open issue, expected-class (counted),
 * or no evidence. A monitoring-bug is fileable once the queries ran clean and found nothing (the alert is what is wrong).
 */
export async function validateCluster(clusterIn, { sources = [], ...io } = {}) {
  const cls = clusterIn.class ?? classifyCluster(clusterIn);
  const out = { ...clusterIn, class: cls, evidence: [], errors: [], fileable: false, reason: "" };
  if (clusterIn.duplicateOf != null) return { ...out, reason: `duplicate of #${clusterIn.duplicateOf}` };
  if (cls === "expected-class") return { ...out, reason: "expected-class: counted, not filed" };
  const queries = sources.filter((s) => s.kind !== "memo"), own = new Set(clusterIn.signals.map((s) => s.query).filter(Boolean));
  const match = typeof io.match === "function" ? io.match : (c, s) => fingerprint(s) === c.fingerprint || (s.query != null && own.has(s.query));
  let clean = 0;
  for (const src of queries) {
    const { signals, errors } = await runAdapter(src, io);
    out.errors.push(...errors);
    if (!errors.length) clean++;
    out.evidence.push(...signals.filter((s) => match(clusterIn, s)));
  }
  if (out.evidence.length) return { ...out, fileable: true, reason: "reproduced" };
  if (cls === "monitoring-bug" && clean > 0) return { ...out, fileable: true, reason: "monitoring-bug: queries ran clean and found no matching state" };
  return { ...out, reason: queries.length ? "no reproduced evidence" : "no read-only queries declared" };
}

/** Counts by class and outcome for validated clusters (`counted` includes the expected-class ones that are never filed). */
export function tallyClusters(validated) {
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  let fileable = 0, signals = 0;
  for (const v of validated ?? []) { byClass[v.class] = (byClass[v.class] ?? 0) + 1; signals += v.count ?? 0; if (v.fileable) fileable++; }
  return { clusters: (validated ?? []).length, signals, fileable, byClass };
}

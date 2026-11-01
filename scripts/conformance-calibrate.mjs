#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conformance calibration: scores labelled gate verdicts (and an optional replay corpus) per check kind and prints
 * precision, recall and false-block rate, with the mode each kind has earned: enforce only at ~0 false blocks.
 *
 *   node scripts/conformance-calibrate.mjs --labels <labels.json> [--replay <corpus.json>] [--events <run-log>] [--min-blocks N] [--max-false-rate R] [--json]
 *
 * A case is {id, kind, label} with label true-block | false-block | missed | true-pass, or {id, kind, expected_block, blocked}
 * (the replay-bench shape). A file is `{cases: [...]}` or a bare array. `kind` is any failure code; none is built in.
 * `--events` reads run-log events (JSONL, a JSON array or `{events}`) and adds the mutation-check metrics (#4929).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LABELS = Object.freeze(["true-block", "false-block", "missed", "true-pass"]);
export const DEFAULT_MIN_BLOCKS = 3;
export const DEFAULT_MAX_FALSE_RATE = 0;

/** The label of a case, from `label` or derived from `expected_block` and `blocked`; null when neither is usable. */
export function labelOf(c) {
  if (LABELS.includes(c?.label)) return c.label;
  if (typeof c?.expected_block !== "boolean" || typeof c?.blocked !== "boolean") return null;
  return c.blocked ? (c.expected_block ? "true-block" : "false-block") : c.expected_block ? "missed" : "true-pass";
}

export function casesOf(doc) {
  return (Array.isArray(doc) ? doc : doc?.cases ?? []).filter((c) => c && typeof c.kind === "string" && c.kind && labelOf(c));
}

/**
 * Per-kind counts and rates. precision = TP/(TP+FP), recall = TP/(TP+FN), falseBlockRate = FP/(TP+FP) (blocks that were wrong);
 * a rate is null when its denominator is 0. `mode` is enforce only with at least minBlocks blocks and a false-block rate <= maxFalseRate.
 */
export function scoreKinds(cases, { minBlocks = DEFAULT_MIN_BLOCKS, maxFalseRate = DEFAULT_MAX_FALSE_RATE } = {}) {
  const by = {};
  for (const c of cases ?? []) {
    const t = (by[c.kind] ??= { kind: c.kind, tp: 0, fp: 0, fn: 0, tn: 0 });
    const l = labelOf(c);
    if (l === "true-block") t.tp++; else if (l === "false-block") t.fp++; else if (l === "missed") t.fn++; else if (l === "true-pass") t.tn++;
  }
  const ratio = (n, d) => (d ? n / d : null);
  return Object.values(by).sort((a, b) => a.kind.localeCompare(b.kind)).map((t) => {
    const blocks = t.tp + t.fp, falseBlockRate = ratio(t.fp, blocks);
    const mode = blocks >= minBlocks && falseBlockRate !== null && falseBlockRate <= maxFalseRate ? "enforce" : "shadow";
    return { ...t, blocks, precision: ratio(t.tp, blocks), recall: ratio(t.tp, t.tp + t.fn), falseBlockRate, mode };
  });
}

export const MUTATION_EVENT = "REQUIREMENT_MUTATION_SURVIVED";
export const MUTATION_KIND = "conformance.mutation_survived";

/** Events from a run-log file: JSONL text, a JSON array or `{events}`; unparseable lines are dropped. */
export function eventsOf(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  try {
    const doc = JSON.parse(t);
    return (Array.isArray(doc) ? doc : doc?.events ?? (doc?.event ? [doc] : [])).filter((e) => e && typeof e === "object");
  } catch { /* JSONL */ }
  return t.split("\n").flatMap((l) => { try { const e = JSON.parse(l); return e && typeof e === "object" ? [e] : []; } catch { return []; } });
}

/**
 * Mutation-check metrics for engine.conformance_mutation promotion. survivedShare = survived ids / checked requirements over the
 * REQUIREMENT_MUTATION_SURVIVED events (an event with no ids is a clean check); falseSurvivedRate = false-block / (true-block + false-block)
 * over labelled cases of kind conformance.mutation_survived (a survived verdict on a test that was real). A rate is null with no denominator.
 */
export function mutationStats(events, cases) {
  const evs = (events ?? []).filter((e) => e?.event === MUTATION_EVENT);
  let checked = 0, survived = 0, skippedRuns = 0;
  for (const e of evs) {
    checked += Number(e.checked) || 0;
    survived += Array.isArray(e.ids) ? e.ids.length : 0;
    if (e.skipped) skippedRuns++;
  }
  let falseSurvived = 0, labelledSurvived = 0;
  for (const c of cases ?? []) {
    if (c.kind !== MUTATION_KIND) continue;
    const l = labelOf(c);
    if (l === "false-block") { falseSurvived++; labelledSurvived++; } else if (l === "true-block") labelledSurvived++;
  }
  const ratio = (n, d) => (d ? n / d : null);
  return { events: evs.length, checked, survived, survivedShare: ratio(survived, checked), skippedRuns, falseSurvived, labelledSurvived, falseSurvivedRate: ratio(falseSurvived, labelledSurvived) };
}

const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`);

export function formatKindReport(rows) {
  const head = ["kind", "blocks", "precision", "recall", "false-block", "mode"];
  const body = rows.map((r) => [r.kind, String(r.blocks), pct(r.precision), pct(r.recall), `${r.fp}/${r.blocks} (${pct(r.falseBlockRate)})`, r.mode]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd();
  const enforce = rows.filter((r) => r.mode === "enforce").map((r) => `${r.kind}=enforce`);
  return [line(head), ...body.map(line), "", enforce.length ? `engine.conformance_kinds: "${enforce.join(", ")}"` : "engine.conformance_kinds: (none earned enforcement)"].join("\n");
}

export function formatMutationReport(m) {
  return ["mutation check (engine.conformance_mutation)",
    `survived-mutation share: ${m.survived}/${m.checked} (${pct(m.survivedShare)}) over ${m.events} event(s), ${m.skippedRuns} skipped`,
    `false survived: ${m.falseSurvived}/${m.labelledSurvived} (${pct(m.falseSurvivedRate)}) labelled ${MUTATION_KIND} case(s)`].join("\n");
}

export function parseCalibrateArgs(argv) {
  const o = { labels: null, replay: null, events: null, minBlocks: DEFAULT_MIN_BLOCKS, maxFalseRate: DEFAULT_MAX_FALSE_RATE, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--labels") o.labels = argv[++i];
    else if (a === "--replay") o.replay = argv[++i];
    else if (a === "--events") o.events = argv[++i];
    else if (a === "--min-blocks") o.minBlocks = Number(argv[++i]);
    else if (a === "--max-false-rate") o.maxFalseRate = Number(argv[++i]);
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.labels && !o.replay) throw new Error("usage: conformance-calibrate.mjs --labels <labels.json> [--replay <corpus.json>] [--events <run-log>] [--min-blocks N] [--max-false-rate R] [--json]");
  return o;
}

export function run(argv, read = (p) => JSON.parse(readFileSync(p, "utf8")), readText = (p) => readFileSync(p, "utf8")) {
  const o = parseCalibrateArgs(argv);
  const cases = [o.labels, o.replay].filter(Boolean).flatMap((p) => casesOf(read(p)));
  const rows = scoreKinds(cases, o);
  const mutation = o.events ? mutationStats(eventsOf(readText(o.events)), cases) : null;
  if (o.json) return JSON.stringify({ cases: cases.length, kinds: rows, ...(mutation ? { mutation } : {}) }, null, 2);
  return `${cases.length} labelled case(s)\n${formatKindReport(rows)}${mutation ? `\n\n${formatMutationReport(mutation)}` : ""}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(2); }
}

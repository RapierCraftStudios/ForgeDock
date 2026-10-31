#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conformance calibration: scores labelled gate verdicts (and an optional replay corpus) per check kind and prints
 * precision, recall and false-block rate, with the mode each kind has earned: enforce only at ~0 false blocks.
 *
 *   node scripts/conformance-calibrate.mjs --labels <labels.json> [--replay <corpus.json>] [--min-blocks N] [--max-false-rate R] [--json]
 *
 * A case is {id, kind, label} with label true-block | false-block | missed | true-pass, or {id, kind, expected_block, blocked}
 * (the replay-bench shape). A file is `{cases: [...]}` or a bare array. `kind` is any failure code; none is built in.
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

const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`);

export function formatReport(rows) {
  const head = ["kind", "blocks", "precision", "recall", "false-block", "mode"];
  const body = rows.map((r) => [r.kind, String(r.blocks), pct(r.precision), pct(r.recall), `${r.fp}/${r.blocks} (${pct(r.falseBlockRate)})`, r.mode]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd();
  const enforce = rows.filter((r) => r.mode === "enforce").map((r) => `${r.kind}=enforce`);
  return [line(head), ...body.map(line), "", enforce.length ? `engine.conformance_kinds: "${enforce.join(", ")}"` : "engine.conformance_kinds: (none earned enforcement)"].join("\n");
}

export function parseArgs(argv) {
  const o = { labels: null, replay: null, minBlocks: DEFAULT_MIN_BLOCKS, maxFalseRate: DEFAULT_MAX_FALSE_RATE, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--labels") o.labels = argv[++i];
    else if (a === "--replay") o.replay = argv[++i];
    else if (a === "--min-blocks") o.minBlocks = Number(argv[++i]);
    else if (a === "--max-false-rate") o.maxFalseRate = Number(argv[++i]);
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.labels && !o.replay) throw new Error("usage: conformance-calibrate.mjs --labels <labels.json> [--replay <corpus.json>] [--min-blocks N] [--max-false-rate R] [--json]");
  return o;
}

export function run(argv, read = (p) => JSON.parse(readFileSync(p, "utf8"))) {
  const o = parseArgs(argv);
  const cases = [o.labels, o.replay].filter(Boolean).flatMap((p) => casesOf(read(p)));
  const rows = scoreKinds(cases, o);
  return o.json ? JSON.stringify({ cases: cases.length, kinds: rows }, null, 2) : `${cases.length} labelled case(s)\n${formatReport(rows)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(2); }
}

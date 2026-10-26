// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4629: live A/B experiments. forge.yaml `experiment:` section (flat keys, the parser has one nesting level):
 *   id: light-vs-full          arms: light,full         ratio: 1,1 (weights, default equal)
 *   metrics: usd_median,wall_p50_ms,first_pass_rate,needs_human_rate (default all)
 *   targets: light.usd_median<=1.2xfull,light.first_pass_rate>=0.8   min_n: 10
 * The arm is a hash of (id, issue), so a re-run or resume keeps its arm. Pure; the stats report is bin/stats/experiment.mjs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForgeYaml } from "./forge-utils.mjs";

export const EXPERIMENT_METRICS = ["usd_median", "wall_p50_ms", "first_pass_rate", "needs_human_rate"];
export const BENCH_SCHEMA = "forge.bench.v1";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.([a-z_0-9]+)(<=|>=)(\d+(?:\.\d+)?)(?:x([A-Za-z0-9][A-Za-z0-9._-]*))?$/;
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Parsed declaration {id, arms, ratio, metrics, targets, minN}, or null when absent or invalid. */
export function parseExperiment(sec, { defaultMinN = 10 } = {}) {
  if (!sec || typeof sec !== "object") return null;
  const id = String(sec.id ?? "").trim(), arms = list(sec.arms);
  if (!NAME.test(id) || arms.length < 2 || new Set(arms).size !== arms.length || !arms.every((a) => NAME.test(a))) return null;
  const ratio = sec.ratio == null || sec.ratio === "" ? arms.map(() => 1) : list(sec.ratio).map((x) => (/^[1-9]\d*$/.test(x) ? Number(x) : NaN));
  if (ratio.length !== arms.length || ratio.some(Number.isNaN)) return null;
  const metrics = sec.metrics ? list(sec.metrics) : [...EXPERIMENT_METRICS];
  if (!metrics.length || metrics.some((m) => !EXPERIMENT_METRICS.includes(m))) return null;
  const targets = [];
  for (const t of list(sec.targets)) {
    const m = TARGET.exec(t);
    if (!m || !arms.includes(m[1]) || !metrics.includes(m[2]) || (m[5] && !arms.includes(m[5]))) return null;
    targets.push({ arm: m[1], metric: m[2], op: m[3], limit: Number(m[4]), vs: m[5] ?? null, text: t });
  }
  const mn = String(sec.min_n ?? "").trim();
  if (mn && !/^\d+$/.test(mn)) return null;
  return { id, arms, ratio, metrics, targets, minN: mn ? Number(mn) : defaultMinN };
}

/** forge.yaml `experiment:` of `cwd`, or null. */
export function readExperiment(cwd = process.cwd()) {
  try { return parseExperiment(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.experiment); } catch { return null; }
}

/** Deterministic arm of an issue: sha1(id:issue) mod the ratio total, walked over the arms in declared order. */
export function assignArm(exp, issue) {
  const total = exp.ratio.reduce((a, b) => a + b, 0);
  let pick = createHash("sha1").update(`${exp.id}:${issue}`).digest().readUInt32BE(0) % total;
  for (let i = 0; i < exp.arms.length; i++) { if (pick < exp.ratio[i]) return exp.arms[i]; pick -= exp.ratio[i]; }
  return exp.arms[0];
}

/** The shared result record of the bench harness, the eval gate and `stats --experiment`: targets are {pass: true|false|null, value, limit}. */
export const benchRecord = ({ source, arms = {}, targets = {} }) => ({ schema: BENCH_SCHEMA, source, arms, targets });

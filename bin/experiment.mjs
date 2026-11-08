// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4629: live A/B experiments. forge.yaml `experiment:` section (flat keys, the parser has one nesting level):
 *   id: light-vs-full          arms: light,full         ratio: 1,1 (weights, default equal)
 *   metrics: usd_median,wall_p50_ms,first_pass_rate,needs_human_rate (default all)
 *   targets: light.usd_median<=1.2xfull,light.first_pass_rate>=0.8   min_n: 10
 * The arm is a hash of (id, issue), so a re-run or resume keeps its arm. Pure; the stats report is bin/stats/experiment.mjs.
 * forge#5206: `<arm>.<key>: <value>` overrides a lane-shaping key for that arm only (ARM_OVERRIDE_KEYS); any other dotted
 * key or an invalid value makes the whole declaration invalid (null, reason warned), never a partial apply.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForgeYaml } from "./forge-utils.mjs";

export const EXPERIMENT_METRICS = ["usd_median", "wall_p50_ms", "first_pass_rate", "needs_human_rate"];
export const BENCH_SCHEMA = "forge.bench.v1";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.([a-z_0-9]+)(<=|>=)(\d+(?:\.\d+)?)(?:x([A-Za-z0-9][A-Za-z0-9._-]*))?$/;
const MODEL = /^[A-Za-z0-9._:[\]-]+$/;
const oneOf = (...vals) => (v) => vals.includes(v);
/** forge#5206: the keys an arm may override, each with its value check. `context_pack` excludes `ab` (its own arm hash). */
export const ARM_OVERRIDE_KEYS = Object.freeze({
  "lean.explore": oneOf("on", "off"),
  "lean.explore_model": (v) => MODEL.test(v),
  "lean.light_mode": oneOf("off", "shadow", "on"),
  "context_pack": oneOf("shadow", "on", "off"),
  "review.verifier": oneOf("off", "shadow", "enforce"),
});
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Parsed declaration {id, arms, ratio, metrics, targets, minN, overrides: {arm: {key: value}}}, or null when absent or
 * invalid. An invalid arm override calls `warn(reason)`.
 */
export function parseExperiment(sec, { defaultMinN = 10, warn = () => {} } = {}) {
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
  const overrides = Object.fromEntries(arms.map((a) => [a, {}]));
  for (const [k, raw] of Object.entries(sec)) {
    if (!k.includes(".")) continue;
    const arm = arms.filter((a) => k.startsWith(`${a}.`) && Object.hasOwn(ARM_OVERRIDE_KEYS, k.slice(a.length + 1))).sort((a, b) => b.length - a.length)[0];
    if (!arm) { warn(`${k}: not <arm>.<key> with a declared arm and an allowed key (${Object.keys(ARM_OVERRIDE_KEYS).join(", ")})`); return null; }
    const key = k.slice(arm.length + 1), v = String(raw ?? "").trim();
    if (!ARM_OVERRIDE_KEYS[key](v)) { warn(`${k}: invalid value "${v}"`); return null; }
    overrides[arm][key] = v;
  }
  return { id, arms, ratio, metrics, targets, minN: mn ? Number(mn) : defaultMinN, overrides };
}

/** forge#5206: the {key: value} overrides of one arm ({} for none, an unknown arm or no experiment). */
export const armOverrides = (exp, arm) => ({ ...(exp?.overrides?.[arm] ?? {}) });

/** forge#5206: the recorded form of an arm's overrides, sorted `k=v` joined by `,` ("" when none). */
export const overridesText = (ov) => Object.keys(ov ?? {}).sort().map((k) => `${k}=${ov[k]}`).join(",");

/**
 * forge#5206: the lane options of `issue` with its arm's overrides applied, and the run tag {experiment, arm, arm_overrides}.
 * Without `opts.experiment` the very same options object and an empty tag (no change to today's lane).
 */
export function applyArmOverrides(opts, issue) {
  const exp = opts?.experiment;
  if (!exp) return { options: opts, tag: {} };
  const arm = assignArm(exp, issue), ov = armOverrides(exp, arm), has = (k) => Object.hasOwn(ov, k);
  const options = { ...opts };
  if (has("lean.explore") || has("lean.explore_model")) {
    options.explore = { ...(opts.explore ?? {}), ...(has("lean.explore") ? { mode: ov["lean.explore"] } : {}), ...(has("lean.explore_model") ? { model: ov["lean.explore_model"] } : {}) };
  }
  if (has("lean.light_mode")) options.light = { ...(opts.light ?? {}), mode: ov["lean.light_mode"] };
  if (has("context_pack")) options.contextPack = { ...(opts.contextPack ?? {}), mode: ov.context_pack };
  if (has("review.verifier")) options.verifier = { ...(opts.verifier ?? {}), mode: ov["review.verifier"] };
  return { options, tag: { experiment: exp.id, arm, arm_overrides: overridesText(ov) } };
}

const warned = new Set();
const stderrWarn = (m) => { if (!warned.has(m)) { warned.add(m); process.stderr.write(`forge.yaml experiment: ${m}; experiment ignored\n`); } };
/** forge.yaml `experiment:` of `cwd`, or null; an invalid arm override is warned (#5206). */
export function readExperiment(cwd = process.cwd(), warn = stderrWarn) {
  let raw;
  try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { return null; }
  try { return parseExperiment(parseForgeYaml(raw, { dottedSections: ["experiment"] })?.experiment, { warn }); } catch { return null; }
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

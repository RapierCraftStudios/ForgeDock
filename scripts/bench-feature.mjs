#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * scripts/bench-feature.mjs — feature benchmark: spec in, running app out, graded by hidden journey tests (forge#5341)
 *
 * Two arms get the same spec (docs/eval/feature-specs/<id>/spec.md): `full` runs ForgeDock end to end (bootstrap, orchestrate,
 * ship) on a sandbox repo, `control` is one bare `claude -p` session in an empty directory. The journeys
 * (<spec>/journeys/*.mjs) are the oracle and never shown to either arm: each is run as `node <journey>` with cwd and BENCH_APP set
 * to the arm's app directory; exit 0 is a pass. Grade: journeys passed, cost, wall time, human interventions.
 * Zero dependencies; every process call goes through an injectable `run`, so tests use fakes. Instructions: docs/eval/feature-bench.md.
 *
 * Usage:
 *   node scripts/bench-feature.mjs run --spec <dir> --config <runcfg.json> --out <rows.jsonl> [--arms full,control] [--keep]
 *   node scripts/bench-feature.mjs aggregate <rows.jsonl|-> [--previous <scorecard.json>]
 *
 * The harness never writes to GitHub itself; the only GitHub writes are those of the full arm's own forgedock steps.
 * Exit codes: 0 ok | 1 invalid input or a failed run step | 2 a target or the promotion gate failed (scorecard still emitted)
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { benchDefaultRun } from "./bench-lightlane.mjs";
import { benchRecord } from "../bin/experiment.mjs";

export const ARMS = ["full", "control"];
export const DEFAULT_STEPS = [
  ["forgedock", "bootstrap", "--repo", "{repo}", "--spec", "{spec}"],
  ["forgedock", "orchestrate", "--repo", "{repo}", "--result-file", "{result}"],
  ["forgedock", "release", "--repo", "{repo}"],
];

/** {id, prompt, journeys: [{name, path}]} of a spec directory, or a thrown Error naming the problem. */
export function loadSpec(dir) {
  const d = resolve(dir), specFile = join(d, "spec.md"), jdir = join(d, "journeys");
  if (!existsSync(specFile)) throw new Error(`spec: ${specFile} missing`);
  const prompt = readFileSync(specFile, "utf8");
  if (!prompt.trim()) throw new Error("spec: spec.md is empty");
  const journeys = existsSync(jdir) ? readdirSync(jdir).filter((f) => f.endsWith(".mjs")).sort().map((f) => ({ name: f.replace(/\.mjs$/, ""), path: join(jdir, f) })) : [];
  if (!journeys.length) throw new Error("spec: journeys/*.mjs must hold at least one journey");
  return { id: d.split(/[\\/]/).pop(), file: specFile, prompt, journeys };
}

/** The run config for `arms`, or a thrown Error: full needs {repo}, control needs {model}. */
export function validateRunConfig(cfg, arms) {
  const a = cfg?.arms;
  if (!a || typeof a !== "object") throw new Error("config: missing arms");
  for (const arm of arms) {
    const x = a[arm];
    if (!x) throw new Error(`config: missing arms.${arm}`);
    if (arm === "control" && (typeof x.model !== "string" || !x.model)) throw new Error("config: arms.control.model is required");
    if (arm === "full" && (typeof x.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(x.repo))) throw new Error("config: arms.full.repo must be owner/name");
  }
  return cfg;
}

const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const fill = (arg, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), arg);

/** Run every journey of `spec` against `app`; -> {name: boolean}. */
export async function gradeJourneys({ spec, app, run }) {
  const out = {};
  for (const j of spec.journeys) out[j.name] = (await run("node", [j.path], { cwd: app, env: { ...process.env, BENCH_APP: app } })).code === 0;
  return out;
}

/** Run one arm on `spec` and grade it -> one row (see aggregate). `now` is injectable. */
export async function runArm({ arm, spec, cfg, run = benchDefaultRun, tmp, now = () => Date.now() }) {
  const a = cfg.arms[arm], app = join(tmp, `${arm}-app`);
  const row = { arm, spec: spec.id, journeys_total: spec.journeys.length, journeys_passed: 0, journeys: {}, cost_usd: null, wall_ms: null, interventions: null, terminal: null };
  const t0 = now();
  if (arm === "control") {
    mkdirSync(app, { recursive: true });
    const [bin, ...pre] = Array.isArray(a.command) && a.command.length ? a.command : ["claude"];
    const r = await run(bin, [...pre, "-p", spec.prompt, "--output-format", "json", "--model", a.model, ...(a.args ?? [])], { cwd: app });
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { /* reported as terminal below */ }
    row.cost_usd = num(j?.total_cost_usd); row.wall_ms = num(j?.duration_ms) ?? now() - t0; row.interventions = 0;
    row.terminal = r.code !== 0 ? `exit ${r.code}` : !j ? "no-json" : j.is_error ? "error" : "ok";
  } else {
    const rf = join(tmp, "full-result.json"), vars = { repo: a.repo, spec: spec.file, result: rf };
    row.terminal = "ok";
    for (const step of a.steps ?? DEFAULT_STEPS) {
      const [bin, ...args] = step.map((x) => fill(x, vars));
      const r = await run(bin, args, {});
      if (r.code !== 0) { row.terminal = `${args[0] ?? bin} exit ${r.code}`; break; }
    }
    const res = readJson(rf);
    row.cost_usd = num(res?.cost_usd); row.wall_ms = num(res?.wall_ms) ?? now() - t0; row.interventions = num(res?.interventions) ?? num(res?.needs_human) ?? 0;
    const c = await run("git", ["clone", "-q", a.clone_url ?? `https://github.com/${a.repo}.git`, app], { cwd: tmp });
    if (c.code !== 0) { row.terminal = `clone exit ${c.code}`; return row; }
  }
  row.journeys = await gradeJourneys({ spec, app, run });
  row.journeys_passed = Object.values(row.journeys).filter(Boolean).length;
  return row;
}

const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const nums = (rows, k) => rows.map((r) => r[k]).filter((x) => Number.isFinite(x));

/** Per-arm metrics over rows (pure). */
export function armMetrics(rows) {
  const total = sum(rows.map((r) => r.journeys_total ?? 0)), passed = sum(rows.map((r) => r.journeys_passed ?? 0));
  const cost = nums(rows, "cost_usd"), wall = nums(rows, "wall_ms"), iv = nums(rows, "interventions");
  return { n: rows.length, journeys_total: total, journeys_passed: passed, journey_pass_rate: total ? r4(passed / total) : null,
    cost_usd: r4(sum(cost)), wall_ms: sum(wall), interventions: sum(iv) };
}

/**
 * Rows -> {arms, targets, regression, record} (pure). `previous` is the last published scorecard: a full-arm journey pass rate
 * below it is a regression, and the promotion gate (scoreboardGate in bin/stats/scoreboard.mjs) refuses a regressed scorecard.
 * A target is {pass: true|false|null, value, limit}; null when an arm it needs has no rows.
 */
export function aggregate(rows, { previous = null } = {}) {
  const arms = Object.fromEntries(ARMS.map((a) => [a, armMetrics(rows.filter((r) => r.arm === a))]));
  const F = arms.full, C = arms.control;
  const t = (ok, value, limit) => ({ pass: ok == null ? null : ok, value, limit });
  const targets = { full_journeys_ge_control: t(F.n && C.n ? F.journey_pass_rate >= C.journey_pass_rate : null, F.journey_pass_rate, C.journey_pass_rate) };
  const prev = previous?.arms?.full?.journey_pass_rate;
  const regression = F.n && Number.isFinite(prev) && F.journey_pass_rate < prev ? `full-arm journey pass rate ${F.journey_pass_rate} < previous ${prev}` : null;
  return { arms, targets, regression, record: benchRecord({ source: "bench-feature", arms, targets }) };
}

/** JSONL (or a JSON array) -> rows. */
export function parseRows(text) {
  const s = String(text).trim();
  if (!s) return [];
  if (s.startsWith("[")) return JSON.parse(s);
  return s.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };

export async function main(argv = process.argv.slice(2), { run = benchDefaultRun, out = process.stdout, err = process.stderr } = {}) {
  const cmd = argv[0];
  try {
    if (cmd === "aggregate") {
      const src = argv[1] && !argv[1].startsWith("--") ? argv[1] : "-", prev = flag(argv, "--previous");
      const agg = aggregate(parseRows(src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8")), { previous: prev ? JSON.parse(readFileSync(prev, "utf8")) : null });
      out.write(JSON.stringify(agg, null, 2) + "\n");
      return agg.regression || Object.values(agg.targets).some((x) => x.pass === false) ? 2 : 0;
    }
    if (cmd !== "run") { err.write("usage: bench-feature.mjs run|aggregate (see the header)\n"); return 1; }
    const sp = flag(argv, "--spec"), cfgPath = flag(argv, "--config"), rowsOut = flag(argv, "--out");
    if (!sp || !cfgPath || !rowsOut) throw new Error("--spec, --config and --out are required");
    const arms = (flag(argv, "--arms") ?? ARMS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = arms.filter((a) => !ARMS.includes(a));
    if (bad.length) throw new Error(`unknown arm(s): ${bad.join(", ")}`);
    const spec = loadSpec(sp), cfg = validateRunConfig(JSON.parse(readFileSync(cfgPath, "utf8")), arms);
    const tmp = mkdtempSync(join(tmpdir(), "bench-feature-"));
    try {
      for (const arm of arms) {
        const row = await runArm({ arm, spec, cfg, run, tmp });
        appendFileSync(rowsOut, JSON.stringify(row) + "\n");
        err.write(`${arm} ${spec.id}: journeys ${row.journeys_passed}/${row.journeys_total}, $${row.cost_usd ?? "?"}, ${row.terminal}\n`);
      }
      return 0;
    } finally {
      if (!argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    err.write(`ERROR: ${e?.message ?? e}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();

#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * scripts/bench-lightlane.mjs — three-way benchmark: light lane vs full lane vs a plain single-session control (#4453)
 *
 * Runs the same issue set through three arms and grades every arm with the upstream oracle tests (the test files of
 * the real upstream fix, overlaid on the arm's head). Zero dependencies; every process call goes through an
 * injectable `run`, so tests use fakes. Instructions: docs/eval/lightlane-bench.md. Corpus: docs/eval/corpus/.
 *
 * Usage:
 *   node scripts/bench-lightlane.mjs calibrate --corpus <corpus.json>
 *   node scripts/bench-lightlane.mjs run --corpus <corpus.json> --config <runcfg.json> --out <rows.jsonl> [--arms light,full,control] [--issues id,...] [--keep]
 *   node scripts/bench-lightlane.mjs aggregate <rows.jsonl|->
 *
 * Arms:
 *   light, full: `forgedock run-issue <n> --repo <sandbox> --result-file <f>` on a sandbox repo whose forge.yaml sets
 *     lean.light.mode on (light) or off (full). Cost is the run result's cost_usd (the sum of the #4407 per-session
 *     deltas); model time is model_ms (summed session time, #4451).
 *   control: `claude -p <prompt> --output-format json --model <model>` in a fresh clone at the base; cost is
 *     total_cost_usd, wall and model time are duration_ms (one session).
 *
 * The harness never writes to GitHub itself; the only GitHub writes are those of the light/full arms' own run-issue.
 *
 * Exit codes: 0 ok | 1 invalid input or a failed run step | 2 a calibration or a target failed (output still emitted)
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { detectApiShape } from "../bin/lean/apishape.mjs";

export const ARMS = ["light", "full", "control"];
export const TARGETS = Object.freeze({ cost_vs_control: 1.2, wall_vs_model: 1.3 });
const SHA_RE = /^[0-9a-f]{40}$/;
const CLAIMED_REASONS = new Set(["merged", "ci-pending"]);
const OUT_CAP = 1 << 20;

/** Spawn `cmd args` and collect its output (the last 1 MiB of each stream); never throws. */
export function defaultRun(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const cap = (s) => (s.length > OUT_CAP ? s.slice(-OUT_CAP) : s);
    let p;
    try { p = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { resolve({ code: 127, stdout: "", stderr: String(e?.message ?? e) }); return; }
    p.stdout.on("data", (d) => { stdout = cap(stdout + d); });
    p.stderr.on("data", (d) => { stderr = cap(stderr + d); });
    p.on("error", (e) => resolve({ code: e?.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr + String(e?.message ?? e) }));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** A parsed corpus, or a thrown Error naming the first bad field. */
export function validateCorpus(c) {
  if (!c || typeof c !== "object") throw new Error("corpus: not an object");
  for (const k of ["clone_url", "suite_command", "control_prompt"]) if (typeof c[k] !== "string" || !c[k].trim()) throw new Error(`corpus: missing ${k}`);
  if (!SHA_RE.test(String(c.base))) throw new Error("corpus: base must be a full 40-hex sha");
  if (!Array.isArray(c.issues) || !c.issues.length) throw new Error("corpus: issues must be a non-empty array");
  const ids = new Set();
  for (const i of c.issues) {
    if (!i?.id || ids.has(i.id)) throw new Error(`corpus: missing or duplicate issue id ${i?.id}`);
    ids.add(i.id);
    if (!SHA_RE.test(String(i.fix_sha))) throw new Error(`corpus: ${i.id}: fix_sha must be a full 40-hex sha`);
    if (typeof i.title !== "string" || typeof i.body !== "string") throw new Error(`corpus: ${i.id}: title and body are required`);
    if (!Array.isArray(i.oracle?.files) || !i.oracle.files.length || typeof i.oracle.command !== "string") throw new Error(`corpus: ${i.id}: oracle {files, command} is required`);
  }
  return c;
}

/** The run config for `arms`, or a thrown Error: light/full need {repo, issues: {<corpus id>: n}}, control needs {model}. */
export function validateRunConfig(cfg, corpus, arms) {
  const a = cfg?.arms;
  if (!a || typeof a !== "object") throw new Error("config: missing arms");
  for (const arm of arms) {
    const x = a[arm];
    if (!x) throw new Error(`config: missing arms.${arm}`);
    if (arm === "control") { if (typeof x.model !== "string" || !x.model) throw new Error("config: arms.control.model is required"); continue; }
    if (typeof x.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(x.repo)) throw new Error(`config: arms.${arm}.repo must be owner/name`);
    for (const i of corpus.issues) if (!Number.isSafeInteger(x.issues?.[i.id]) || x.issues[i.id] <= 0) throw new Error(`config: arms.${arm}.issues.${i.id} must be the sandbox issue number`);
  }
  return cfg;
}

/** The control prompt for an issue: `{title}` and `{body}` replaced. */
export const fillPrompt = (tpl, issue) => String(tpl).replaceAll("{title}", issue.title).replaceAll("{body}", issue.body);

const sh = (run, command, cwd) => run("sh", ["-c", command], { cwd });
async function git(run, args, cwd) {
  const r = await run("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${String(r.stderr).trim().slice(0, 300)}`);
  return String(r.stdout).trim();
}

/** Overlay the oracle test files from the fix commit onto the checkout in `dir` and run the oracle; true when it passes. */
async function runOracle(run, dir, issue) {
  await git(run, ["checkout", "-q", issue.fix_sha, "--", ...issue.oracle.files], dir);
  return (await sh(run, issue.oracle.command, dir)).code === 0;
}

/** For each corpus issue: the oracle must fail on the base and pass on the fix. -> [{id, red_on_base, green_on_fix}] */
export async function calibrate({ corpus, run = defaultRun, tmp }) {
  const dir = join(tmp, "upstream");
  await git(run, ["clone", "-q", corpus.clone_url, dir], tmp);
  const out = [];
  for (const issue of corpus.issues) {
    await git(run, ["checkout", "-q", "-f", corpus.base], dir);
    const red = !(await runOracle(run, dir, issue));
    await git(run, ["checkout", "-q", "-f", issue.fix_sha], dir);
    const green = (await sh(run, issue.oracle.command, dir)).code === 0;
    out.push({ id: issue.id, red_on_base: red, green_on_fix: green });
  }
  return out;
}

const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/** Grade `head` from the repo in `src`: own suite, then the oracle overlay, then the API shape from `base`. */
async function grade({ run, src, head, base, corpus, issue, tmp, tag, apiShape }) {
  await git(run, ["branch", "-f", "bench-head", head], src);
  const dir = join(tmp, `${tag}-grade`);
  await git(run, ["clone", "-q", "-b", "bench-head", src, dir], tmp);
  await git(run, ["fetch", "-q", corpus.clone_url, issue.fix_sha], dir);
  const changed = (await run("git", ["diff", "--quiet", base, "HEAD"], { cwd: dir })).code === 1;
  let shape;
  try { const r = await apiShape({ cwd: dir, base, head: "HEAD" }); shape = { status: r?.status ?? "unknown", changes: Array.isArray(r?.changes) ? r.changes : [] }; }
  catch (e) { shape = { status: "error", changes: [], error: String(e?.message ?? e).slice(0, 200) }; }
  const suite = (await sh(run, corpus.suite_command, dir)).code === 0;
  const oracle = await runOracle(run, dir, issue);
  return { changed, suite_pass: suite, oracle_pass: oracle, api_shape: shape };
}

/** Run one arm on one corpus issue and grade it -> one row (see aggregate). `now` and `apiShape` are injectable. */
export async function runArm({ arm, issue, corpus, cfg, run = defaultRun, tmp, now = () => Date.now(), apiShape = detectApiShape }) {
  const tag = `${arm}-${issue.id}`, a = cfg.arms[arm];
  const row = { arm, id: issue.id, cost_usd: null, wall_ms: null, model_ms: null, harness_wall_ms: null, claimed_fix: false, oracle_pass: false, suite_pass: null,
    api_shape: null, light: null, light_eligibility: null, light_upgrade: null, terminal: null };
  const t0 = now();
  let src = null, head = null, base = corpus.base, claimed = false;
  if (arm === "control") {
    src = join(tmp, `${tag}-work`);
    await git(run, ["clone", "-q", corpus.clone_url, src], tmp);
    await git(run, ["checkout", "-q", "-b", "bench-control", corpus.base], src);
    const [bin, ...pre] = Array.isArray(a.command) && a.command.length ? a.command : ["claude"];
    const r = await run(bin, [...pre, "-p", fillPrompt(corpus.control_prompt, issue), "--output-format", "json", "--model", a.model, ...(a.args ?? [])], { cwd: src });
    row.harness_wall_ms = now() - t0;
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { /* reported as terminal below */ }
    row.cost_usd = num(j?.total_cost_usd); row.wall_ms = num(j?.duration_ms); row.model_ms = num(j?.duration_ms);
    row.terminal = r.code !== 0 ? `exit ${r.code}` : !j ? "no-json" : j.is_error ? "error" : "ok";
    claimed = row.terminal === "ok";
    await git(run, ["add", "-A"], src);
    await git(run, ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "--allow-empty", "--no-verify", "-m", `control ${issue.id}`], src);
    head = await git(run, ["rev-parse", "HEAD"], src);
  } else {
    const n = a.issues[issue.id], rf = join(tmp, `${tag}-result.json`);
    const [bin, ...pre] = Array.isArray(a.command) && a.command.length ? a.command : ["forgedock", "run-issue"];
    const r = await run(bin, [...pre, String(n), "--repo", a.repo, "--result-file", rf, ...(a.args ?? [])], {});
    row.harness_wall_ms = now() - t0;
    const res = readJson(rf);
    row.terminal = res?.terminalReason ?? `exit ${r.code}`;
    row.cost_usd = num(res?.cost_usd); row.wall_ms = num(res?.wall_ms); row.model_ms = num(res?.model_ms);
    row.light = typeof res?.light === "boolean" ? res.light : null;
    row.light_eligibility = res?.light_eligibility ?? null;
    row.light_upgrade = Array.isArray(res?.light_upgrade) ? res.light_upgrade : null;
    claimed = CLAIMED_REASONS.has(row.terminal);
    base = a.base ?? corpus.base;
    src = join(tmp, `${tag}-src`);
    await git(run, ["clone", "-q", a.clone_url ?? `https://github.com/${a.repo}.git`, src], tmp);
    if (res?.pr) {
      const pr = String(res.pr).match(/(\d+)\s*$/)?.[1];
      const v = await run("gh", ["pr", "view", pr, "-R", a.repo, "--json", "headRefOid", "--jq", ".headRefOid"], {});
      await git(run, ["fetch", "-q", "origin", `refs/pull/${pr}/head`], src);
      head = SHA_RE.test(String(v.stdout).trim()) ? String(v.stdout).trim() : await git(run, ["rev-parse", "FETCH_HEAD"], src);
    } else if (res?.branch) {
      await git(run, ["fetch", "-q", "origin", res.branch], src);
      head = await git(run, ["rev-parse", "FETCH_HEAD"], src);
    }
  }
  if (!head) return row; // no PR and no branch: nothing to grade; oracle_pass stays false
  const g = await grade({ run, src, head, base, corpus, issue, tmp, tag, apiShape });
  return { ...row, claimed_fix: claimed && g.changed, oracle_pass: g.oracle_pass, suite_pass: g.suite_pass, api_shape: g.api_shape };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const nums = (rows, k) => rows.map((r) => r[k]).filter((x) => Number.isFinite(x));
const rate = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

/** Per-arm metrics over rows (pure). */
export function armMetrics(rows) {
  const cost = nums(rows, "cost_usd"), wall = nums(rows, "wall_ms"), model = nums(rows, "model_ms");
  return {
    n: rows.length,
    cost_usd: { sum: r4(sum(cost)), mean: cost.length ? r4(sum(cost) / cost.length) : null },
    wall_ms: sum(wall), model_ms: sum(model), wall_over_model: sum(model) > 0 ? r4(sum(wall) / sum(model)) : null,
    oracle_pass_rate: r4(rate(rows, (r) => r.oracle_pass === true)),
    false_fix_rate: r4(rate(rows, (r) => r.claimed_fix === true && r.oracle_pass !== true)),
    suite_pass_rate: r4(rate(rows, (r) => r.suite_pass === true)),
    api_shape_changed: rows.filter((r) => r.api_shape?.status === "changed").length,
    undetected_api_shape: rows.filter((r) => r.arm === "light" && r.light === true && r.api_shape?.status === "changed").length,
  };
}

/**
 * Rows -> {arms, light_eligible, targets} (pure). Cost and wall are judged on the light rows whose eligibility verdict is
 * `eligible` (cost against the control rows of the same issues); oracle, false fix and undetected API shape on all light
 * rows. A target is {pass: true|false|null, value, limit}; null when an arm it needs has no rows.
 */
export function aggregate(rows) {
  const by = Object.fromEntries(ARMS.map((a) => [a, rows.filter((r) => r.arm === a)]));
  const arms = Object.fromEntries(ARMS.map((a) => [a, armMetrics(by[a])]));
  const elig = by.light.filter((r) => r.light_eligibility === "eligible");
  const eligIds = new Set(elig.map((r) => r.id));
  const ctlElig = by.control.filter((r) => eligIds.has(r.id));
  const le = armMetrics(elig), ce = armMetrics(ctlElig), L = arms.light, C = arms.control;
  const t = (ok, value, limit) => ({ pass: ok == null ? null : ok, value, limit });
  const costRatio = elig.length && ctlElig.length && ce.cost_usd.sum > 0 ? r4(le.cost_usd.sum / ce.cost_usd.sum) : null;
  const targets = {
    cost_le_1_2x_control: t(costRatio == null ? null : costRatio <= TARGETS.cost_vs_control, costRatio, TARGETS.cost_vs_control),
    wall_le_1_3x_model: t(le.wall_over_model == null ? null : le.wall_over_model <= TARGETS.wall_vs_model, le.wall_over_model, TARGETS.wall_vs_model),
    oracle_ge_control: t(L.n && C.n ? L.oracle_pass_rate >= C.oracle_pass_rate : null, L.oracle_pass_rate, C.oracle_pass_rate),
    false_fix_le_control: t(L.n && C.n ? L.false_fix_rate <= C.false_fix_rate : null, L.false_fix_rate, C.false_fix_rate),
    zero_undetected_api_shape: t(L.n ? L.undetected_api_shape === 0 : null, L.undetected_api_shape, 0),
  };
  return { arms, light_eligible: { ...le, control_cost_usd: ce.cost_usd.sum, ids: [...eligIds].sort() }, targets };
}

/** JSONL (or a JSON array) -> rows. */
export function parseRows(text) {
  const s = String(text).trim();
  if (!s) return [];
  if (s.startsWith("[")) return JSON.parse(s);
  return s.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const list = (v, all) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : all);

export async function main(argv = process.argv.slice(2), { run = defaultRun, out = process.stdout, err = process.stderr } = {}) {
  const cmd = argv[0];
  try {
    if (cmd === "aggregate") {
      const src = argv[1];
      const text = !src || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
      const agg = aggregate(parseRows(text));
      out.write(JSON.stringify(agg, null, 2) + "\n");
      return Object.values(agg.targets).some((x) => x.pass === false) ? 2 : 0;
    }
    if (cmd !== "calibrate" && cmd !== "run") { err.write("usage: bench-lightlane.mjs calibrate|run|aggregate (see the header)\n"); return 1; }
    const cp = flag(argv, "--corpus");
    if (!cp) throw new Error("--corpus is required");
    const corpus = validateCorpus(JSON.parse(readFileSync(cp, "utf8")));
    const tmp = mkdtempSync(join(tmpdir(), "bench-lightlane-"));
    try {
      if (cmd === "calibrate") {
        const res = await calibrate({ corpus, run, tmp });
        out.write(JSON.stringify(res, null, 2) + "\n");
        return res.every((r) => r.red_on_base && r.green_on_fix) ? 0 : 2;
      }
      const arms = list(flag(argv, "--arms"), ARMS), rowsOut = flag(argv, "--out"), cfgPath = flag(argv, "--config");
      if (!rowsOut || !cfgPath) throw new Error("--config and --out are required");
      const bad = arms.filter((a) => !ARMS.includes(a));
      if (bad.length) throw new Error(`unknown arm(s): ${bad.join(", ")}`);
      const cfg = validateRunConfig(JSON.parse(readFileSync(cfgPath, "utf8")), corpus, arms);
      const ids = list(flag(argv, "--issues"), corpus.issues.map((i) => i.id));
      for (const issue of corpus.issues.filter((i) => ids.includes(i.id))) {
        for (const arm of arms) {
          const row = await runArm({ arm, issue, corpus, cfg, run, tmp });
          appendFileSync(rowsOut, JSON.stringify(row) + "\n");
          err.write(`${arm} ${issue.id}: oracle ${row.oracle_pass ? "pass" : "fail"}, $${row.cost_usd ?? "?"}, ${row.terminal}\n`);
        }
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

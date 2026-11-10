#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * scripts/bench-adversarial.mjs — adversarial corpus: full lane vs a bare-agent control (#5292)
 *
 * Sibling of bench-lightlane.mjs (#4453), which it reuses for the arm runs. The corpus mixes valid issues with ones that
 * must not be implemented (wrong premise, duplicate of an existing feature, already shipped) and with integration issues
 * whose correct change touches more than one file. Grading is deterministic (diff paths and added lines), no LLM.
 * Instructions: docs/eval/adversarial-bench.md. Corpus: docs/eval/corpus/adversarial-v1.json.
 *
 * Usage:
 *   node scripts/bench-adversarial.mjs validate  --corpus <corpus.json>
 *   node scripts/bench-adversarial.mjs calibrate --corpus <corpus.json>
 *   node scripts/bench-adversarial.mjs run --corpus <corpus.json> --config <runcfg.json> --out <rows.jsonl> [--arms full,control] [--issues id,...] [--keep]
 *   node scripts/bench-adversarial.mjs aggregate <rows.jsonl|-> --corpus <corpus.json> --model <id> --date <YYYY-MM-DD> [--scorecard <file.md>]
 *
 * Exit codes: 0 ok | 1 invalid input or a failed run step | 2 a calibration check failed (output still emitted)
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { benchDefaultRun, parseRows, runArm, validateRunConfig } from "./bench-lightlane.mjs";

export const ADV_ARMS = ["full", "control"];
export const KINDS = ["valid", "wrong-premise", "duplicate", "already-fixed", "integration"];
export const MIN_ISSUES = 20;
export const MIN_INVALID = 5;
const INVALID = new Set(["wrong-premise", "duplicate", "already-fixed"]);
const SHA_RE = /^[0-9a-f]{40}$/;

/** True for an issue that must be closed with evidence instead of implemented. */
export const isInvalid = (issue) => INVALID.has(issue?.kind);

const goodRegex = (p) => { try { new RegExp(p); return typeof p === "string" && p.length > 0; } catch { return false; } };

/** A parsed corpus, or a thrown Error naming the first bad field. */
export function validateAdversarialCorpus(c) {
  if (!c || typeof c !== "object") throw new Error("corpus: not an object");
  for (const k of ["version", "clone_url", "suite_command", "control_prompt"]) if (typeof c[k] !== "string" || !c[k].trim()) throw new Error(`corpus: missing ${k}`);
  if (!SHA_RE.test(String(c.base))) throw new Error("corpus: base must be a full 40-hex sha");
  if (!Array.isArray(c.issues) || c.issues.length < MIN_ISSUES) throw new Error(`corpus: needs at least ${MIN_ISSUES} issues`);
  const ids = new Set();
  for (const i of c.issues) {
    if (!i?.id || ids.has(i.id)) throw new Error(`corpus: missing or duplicate issue id ${i?.id}`);
    ids.add(i.id);
    if (!KINDS.includes(i.kind)) throw new Error(`corpus: ${i.id}: kind must be one of ${KINDS.join(", ")}`);
    if (typeof i.title !== "string" || typeof i.body !== "string") throw new Error(`corpus: ${i.id}: title and body are required`);
    const ev = i.evidence;
    if (ev && (typeof ev.file !== "string" || !goodRegex(ev.pattern))) throw new Error(`corpus: ${i.id}: evidence needs {file, pattern}`);
    if (isInvalid(i) && !ev) throw new Error(`corpus: ${i.id}: ${i.kind} needs evidence {file, pattern}`);
    if (i.kind === "duplicate" && !(Array.isArray(i.forbid_new_defs) && i.forbid_new_defs.length && i.forbid_new_defs.every(goodRegex))) throw new Error(`corpus: ${i.id}: duplicate needs forbid_new_defs (regexes)`);
    if (i.kind === "integration" && !(Array.isArray(i.must_touch) && i.must_touch.length)) throw new Error(`corpus: ${i.id}: integration needs must_touch paths`);
    if (i.kind === "valid" && (!SHA_RE.test(String(i.fix_sha)) || !Array.isArray(i.oracle?.files) || !i.oracle.files.length || typeof i.oracle.command !== "string")) throw new Error(`corpus: ${i.id}: valid needs fix_sha and oracle {files, command}`);
  }
  if (c.issues.filter(isInvalid).length < MIN_INVALID) throw new Error(`corpus: needs at least ${MIN_INVALID} invalid issues`);
  return c;
}

/** Evidence check: each issue's evidence pattern must match its file at the corpus base. -> [{id, evidence_ok}] */
export async function calibrateEvidence({ corpus, run = benchDefaultRun, tmp }) {
  const dir = join(tmp, "upstream");
  const cl = await run("git", ["clone", "-q", "--no-checkout", "--filter=blob:none", corpus.clone_url, dir], { cwd: tmp });
  if (cl.code !== 0) throw new Error(`git clone failed (${cl.code}): ${String(cl.stderr).trim().slice(0, 300)}`);
  const out = [];
  for (const i of corpus.issues.filter((x) => x.evidence)) {
    const r = await run("git", ["show", `${corpus.base}:${i.evidence.file}`], { cwd: dir });
    out.push({ id: i.id, evidence_ok: r.code === 0 && new RegExp(i.evidence.pattern).test(String(r.stdout)) });
  }
  return out;
}

/** Per-issue grade for one arm's row (pure). `paths` and `added` are the arm's diff against the base: changed paths, added lines. */
export function gradeAdversarial({ issue, row, paths = [], added = [] }) {
  const claimed = row.claimed_fix === true;
  const dup = issue.kind === "duplicate" && claimed && issue.forbid_new_defs.some((p) => added.some((l) => new RegExp(p).test(l)));
  return {
    kind: issue.kind,
    wrong_implemented: isInvalid(issue) && claimed,
    duplicate_created: dup,
    integration_missed: issue.kind === "integration" ? issue.must_touch.filter((p) => !paths.includes(p)).length : 0,
    has_oracle: Boolean(issue.oracle),
  };
}

/** The changed paths and added lines of `base..HEAD` in a grade checkout; empty when the arm left nothing to grade. */
async function diffOf(run, dir, base) {
  const names = await run("git", ["diff", "--name-only", base, "HEAD"], { cwd: dir });
  if (names.code !== 0) return { paths: [], added: [] };
  const full = await run("git", ["diff", "-U0", base, "HEAD"], { cwd: dir });
  const added = String(full.stdout).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  return { paths: String(names.stdout).split("\n").map((s) => s.trim()).filter(Boolean), added };
}

/** Run every selected arm on every selected issue through bench-lightlane's runArm and grade it -> graded rows. */
export async function runAdversarial({ corpus, cfg, arms = ADV_ARMS, issues, run = benchDefaultRun, tmp, runArmFn = runArm, onRow = () => {} }) {
  const rows = [];
  for (const issue of corpus.issues.filter((i) => !issues || issues.includes(i.id))) {
    for (const arm of arms) {
      const row = await runArmFn({ arm, issue, corpus, cfg, run, tmp });
      const base = (arm === "control" ? null : cfg.arms[arm].base) ?? corpus.base;
      const d = await diffOf(run, join(tmp, `${arm}-${issue.id}-grade`), base);
      const graded = { ...row, ...gradeAdversarial({ issue, row, ...d }) };
      rows.push(graded);
      onRow(graded);
    }
  }
  return rows;
}

const r4 = (x) => Math.round(x * 10000) / 10000;
const sumOf = (rows, k) => rows.reduce((s, r) => s + (Number.isFinite(r[k]) ? r[k] : 0), 0);

/** Graded rows -> {meta, arms}: the five scorecard metrics per arm (pure). */
export function aggregateAdversarial(rows, meta) {
  const arms = {};
  for (const arm of ADV_ARMS) {
    const mine = rows.filter((r) => r.arm === arm), oracle = mine.filter((r) => r.has_oracle);
    arms[arm] = {
      n: mine.length,
      invalid_n: mine.filter((r) => INVALID.has(r.kind)).length,
      wrong_implemented: mine.filter((r) => r.wrong_implemented).length,
      duplicate_created: mine.filter((r) => r.duplicate_created).length,
      integration_missed: sumOf(mine, "integration_missed"),
      oracle_n: oracle.length,
      oracle_pass_rate: oracle.length ? r4(oracle.filter((r) => r.oracle_pass === true).length / oracle.length) : null,
      cost_usd: r4(sumOf(mine, "cost_usd")),
      wall_ms: sumOf(mine, "wall_ms"),
    };
  }
  return { meta, arms };
}

/** The published scorecard (markdown) for an aggregate. */
export function renderScorecard({ meta, arms }) {
  const cell = (a, f) => f(arms[a]);
  const rows = [
    ["Wrong issues implemented (lower is better)", (a) => `${a.wrong_implemented} of ${a.invalid_n} invalid`],
    ["Duplicate implementations created", (a) => String(a.duplicate_created)],
    ["Integration points missed", (a) => String(a.integration_missed)],
    ["Oracle pass rate", (a) => (a.oracle_pass_rate == null ? "n/a" : `${a.oracle_pass_rate} (n=${a.oracle_n})`)],
    ["Cost (USD, sum)", (a) => String(a.cost_usd)],
    ["Wall time (ms, sum)", (a) => String(a.wall_ms)],
  ];
  return [
    "# Adversarial benchmark scorecard (#5292)",
    "",
    `- Run date: ${meta.run_date}`,
    `- Model: ${meta.model}`,
    `- Corpus revision: ${meta.corpus_revision}`,
    "",
    `| Metric | ${ADV_ARMS.join(" | ")} |`,
    `|---|${ADV_ARMS.map(() => "---").join("|")}|`,
    ...rows.map(([name, f]) => `| ${name} | ${ADV_ARMS.map((a) => cell(a, f)).join(" | ")} |`),
    "",
    "Reproduce: docs/eval/adversarial-bench.md.",
    "",
  ].join("\n");
}

const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const list = (v, all) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : all);
const need = (v, name) => { if (!v) throw new Error(`${name} is required`); return v; };

export async function main(argv = process.argv.slice(2), { run = benchDefaultRun, out = process.stdout, err = process.stderr } = {}) {
  const cmd = argv[0];
  try {
    if (!["validate", "calibrate", "run", "aggregate"].includes(cmd)) { err.write("usage: bench-adversarial.mjs validate|calibrate|run|aggregate (see the header)\n"); return 1; }
    const cp = need(flag(argv, "--corpus"), "--corpus"), text = readFileSync(cp, "utf8");
    const corpus = validateAdversarialCorpus(JSON.parse(text));
    if (cmd === "validate") {
      const kinds = Object.fromEntries(KINDS.map((k) => [k, corpus.issues.filter((i) => i.kind === k).length]));
      out.write(JSON.stringify({ version: corpus.version, issues: corpus.issues.length, invalid: corpus.issues.filter(isInvalid).length, kinds }, null, 2) + "\n");
      return 0;
    }
    if (cmd === "aggregate") {
      const src = argv[1] && !argv[1].startsWith("--") ? argv[1] : "-";
      const rows = parseRows(src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8"));
      const date = need(flag(argv, "--date"), "--date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");
      const corpus_revision = `${corpus.version}@${corpus.base.slice(0, 7)}+${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
      const agg = aggregateAdversarial(rows, { run_date: date, model: need(flag(argv, "--model"), "--model"), corpus_revision });
      const sc = flag(argv, "--scorecard");
      if (sc) writeFileSync(sc, renderScorecard(agg));
      out.write(JSON.stringify(agg, null, 2) + "\n");
      return 0;
    }
    const tmp = mkdtempSync(join(tmpdir(), "bench-adversarial-"));
    try {
      if (cmd === "calibrate") {
        const res = await calibrateEvidence({ corpus, run, tmp });
        out.write(JSON.stringify(res, null, 2) + "\n");
        return res.every((r) => r.evidence_ok) ? 0 : 2;
      }
      const arms = list(flag(argv, "--arms"), ADV_ARMS), rowsOut = need(flag(argv, "--out"), "--out"), cfgPath = need(flag(argv, "--config"), "--config");
      const bad = arms.filter((a) => !ADV_ARMS.includes(a));
      if (bad.length) throw new Error(`unknown arm(s): ${bad.join(", ")}`);
      const cfg = validateRunConfig(JSON.parse(readFileSync(cfgPath, "utf8")), corpus, arms);
      await runAdversarial({ corpus, cfg, arms, issues: list(flag(argv, "--issues"), null), run, tmp, onRow: (row) => {
        appendFileSync(rowsOut, JSON.stringify(row) + "\n");
        err.write(`${row.arm} ${row.id} (${row.kind}): claimed ${row.claimed_fix}, $${row.cost_usd ?? "?"}, ${row.terminal}\n`);
      } });
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

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5448: blast-radius regression checks. `verify.baselines` (forge.yaml) declares suites that validate runs whenever a
 * matching path changes; a contract `regression` set (existing tests of callers, shared modules, sibling configs) is
 * folded into `validate` at freeze so the existing validate machinery runs it.
 */
import { matchesGlob } from "./verify.mjs";
import { classifyBaseRed } from "./basered.mjs";
import { toolGapFailures } from "./envgap.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

/** `[{when, run}]` or a `{glob: command}` map as `[{when, run}]`; entries missing either half are dropped. */
export function parseBaselines(v) {
  const rows = Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).map(([when, run]) => ({ when, run })) : [];
  const out = [];
  for (const r of rows) {
    const when = String(r?.when ?? "").trim(), run = String(r?.run ?? "").trim();
    if (when && run) out.push({ when, run });
  }
  return out;
}

/** The baselines whose `when` glob matches at least one changed file, each command once. */
export function matchBaselines(changedFiles = [], baselines = []) {
  const seen = new Set();
  return baselines.filter((b) => !seen.has(b.run) && (changedFiles ?? []).some((f) => matchesGlob(f, b.when)) && seen.add(b.run));
}

/** Precheck failures (no `code`; precheck adds it) for baseline runs `[{when, run, rc, output}]` that did not exit 0. */
export function baselineFailures(runs = []) {
  return (runs ?? []).filter((r) => r.rc !== 0).map((r) => ({ kind: "baseline_failed",
    detail: `baseline suite \`${r.run}\` (declared for \`${r.when}\`) failed with exit ${r.rc}: ${String(r.output ?? "").trim().split("\n").slice(-8).join(" | ").slice(0, 400)}` }));
}

/**
 * #6115: split failing runs `[{command|run, rc, output}]` by evidence: `env` (output is a missing module/command), `baseRed`
 * (the same command also fails on base with a non-env signature: recorded, not blocking), `laneOwn` (passes on base, or no
 * base evidence: blocking). Reuses toolGapFailures and classifyBaseRed.
 */
export function classifyFailingRuns({ failed = [], baseRuns = [] } = {}) {
  const key = (f) => f?.command ?? f?.run;
  const gap = new Set(toolGapFailures(failed));
  const rest = (failed ?? []).filter((f) => !gap.has(f));
  const c = classifyBaseRed({ failed: rest.map((f) => ({ ...f, command: key(f) })), baseRuns });
  const back = (rows) => rows.map((r) => rest.find((f) => key(f) === r.command));
  return { laneOwn: back(c.laneOwn), baseRed: back(c.baseRed), env: [...gap, ...back(c.env)] };
}

/** Precheck rows for env baseline runs (a tool gap that survived install and rerun): recoverable env.tool_missing, never a regression. */
export function baselineEnvFailures(runs = []) {
  return (runs ?? []).map((r) => ({ code: OUTCOME_CODES.ENV_TOOL_MISSING, kind: "validate_env", tool: "baseline",
    detail: `baseline suite \`${r.run}\` could not run: a module or command is missing (environment, not the change): ${String(r.output ?? "").trim().split("\n").slice(-4).join(" | ").slice(0, 300)}` }));
}

/** Fold `contract.regression` ([{id, command, covers}]) into `validate` as G# entries; an id or command already there is skipped. */
export function foldRegression(contract) {
  const reg = Array.isArray(contract?.regression) ? contract.regression : [];
  if (!reg.length) return contract;
  const validate = Array.isArray(contract.validate) ? [...contract.validate] : [];
  for (const g of reg) {
    if (!g?.id || !g?.command || validate.some((v) => v?.id === g.id || v?.command === g.command)) continue;
    validate.push({ id: g.id, command: g.command, regression: true });
  }
  return { ...contract, validate };
}

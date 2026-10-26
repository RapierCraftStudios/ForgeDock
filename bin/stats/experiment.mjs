// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4629: `forgedock stats --experiment <id>`. Finished runs tagged with the experiment id, grouped by arm; each metric
 * is null below the declared min n (release.mjs rule), a target is null when a value it needs is null, never a pass.
 */
import { aggregate } from "./aggregate.mjs";
import { releaseMetrics } from "./release.mjs";
import { benchRecord } from "../experiment.mjs";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** One target against the per-arm metrics: absolute limit, or limit x the other arm's value. */
export function evalTarget(t, byArm) {
  const value = byArm[t.arm]?.[t.metric], base = t.vs ? byArm[t.vs]?.[t.metric] : 1;
  const limit = isNum(base) ? t.limit * base : null;
  const pass = isNum(value) && isNum(limit) ? (t.op === "<=" ? value <= limit : value >= limit) : null;
  return { pass, value: isNum(value) ? value : null, limit };
}

export function experimentReport(runs, exp) {
  const mine = runs.filter((r) => r.finished && r.experiment === exp.id);
  const arms = {}, byArm = {};
  for (const arm of exp.arms) {
    const rs = mine.filter((r) => r.arm === arm).map((r) => ({ ...r, version: "0.0.0" })); // one group per arm
    const g = aggregate({ runs: rs }, { minN: exp.minN }).groups[0];
    const m = g ? releaseMetrics([g], { minN: exp.minN }).versions[0] : null;
    byArm[arm] = Object.fromEntries(exp.metrics.map((k) => [k, m?.[k] ?? null]));
    arms[arm] = { n: rs.length, ...byArm[arm] };
  }
  const targets = Object.fromEntries(exp.targets.map((t) => [t.text, evalTarget(t, byArm)]));
  const verdicts = Object.values(targets);
  return { id: exp.id, minN: exp.minN, ...benchRecord({ source: "stats", arms, targets }),
    targets_met: verdicts.length > 0 && verdicts.every((v) => v.pass === true) };
}

const fmt = (v) => (v == null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(2));
export function renderExperiment(r) {
  const keys = Object.keys(Object.values(r.arms)[0] ?? {}).filter((k) => k !== "n");
  const line = (c) => `| ${c.join(" | ")} |`;
  const rows = Object.entries(r.arms).map(([a, v]) => line([a, String(v.n), ...keys.map((k) => fmt(v[k]))]));
  const tg = Object.entries(r.targets).map(([t, v]) => `${t}: ${v.pass == null ? "n/a" : v.pass ? "met" : "missed"} (${fmt(v.value)} vs ${fmt(v.limit)})`);
  return [`Experiment ${r.id} (min n ${r.minN}; n/a below it)`, line(["arm", "n", ...keys]), line(["---", "---", ...keys.map(() => "---")]), ...rows, ...tg, `targets met: ${r.targets_met}`].join("\n");
}

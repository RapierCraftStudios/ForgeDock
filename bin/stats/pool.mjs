// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4549: pool utilisation for `forgedock stats --pool`: remote lane minutes, lanes and share per pool agent, from the
 * repo's local batch report.json rows (`sandbox.by_agent`, written by the orchestrator). No network, no model.
 * Live capacity stays in `forgedock pool status`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listBatches } from "../lean/batch.mjs";
import { windowLabel } from "./efficiency.mjs";

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const round1 = (x) => Math.round(x * 10) / 10;

/** Per window: the repo's batches created in it; an issue in several batches counts once (latest row). */
export function poolUtilisation({ batchRoot, repo = null, windows, now = Date.now() }) {
  const batches = (existsSync(batchRoot) ? listBatches(batchRoot) : []).map((id) => {
    const dir = join(batchRoot, id), plan = readJson(join(dir, "plan.json")) ?? {};
    return { dir, plan, created: Date.parse(plan.created ?? "") };
  }).filter((b) => Number.isFinite(b.created) && (!repo || b.plan.repo === repo)).sort((a, b) => a.created - b.created);
  const out = {};
  for (const w of windows) {
    const inWin = batches.filter((b) => b.created <= now && now - b.created <= w);
    const latest = new Map();
    for (const b of inWin) for (const row of readJson(join(b.dir, "report.json"))?.rows ?? []) if (Number.isSafeInteger(row?.issue)) latest.set(row.issue, row);
    const agents = {};
    let remoteLanes = 0, minutes = 0;
    for (const row of latest.values()) {
      if (!row.sandbox) continue;
      remoteLanes++; minutes += Number(row.sandbox.minutes) || 0;
      for (const [a, m] of Object.entries(row.sandbox.by_agent ?? {})) {
        const e = (agents[a] ??= { minutes: 0, lanes: 0 });
        e.minutes += Number(m) || 0; e.lanes++;
      }
    }
    const attributed = Object.values(agents).reduce((s, e) => s + e.minutes, 0);
    for (const e of Object.values(agents)) { e.share = attributed > 0 ? Math.round((e.minutes / attributed) * 1000) / 1000 : null; e.minutes = round1(e.minutes); }
    out[windowLabel(w)] = { batches: inWin.length, remote_lanes: remoteLanes, minutes: round1(minutes), agents };
  }
  return out;
}

export function formatPoolLines(windows) {
  return Object.entries(windows).flatMap(([w, m]) => {
    const head = `pool ${w}: ${m.batches} batch${m.batches === 1 ? "" : "es"}, ${m.remote_lanes} remote lane${m.remote_lanes === 1 ? "" : "s"}, ${m.minutes.toFixed(1)} min`;
    const rows = Object.entries(m.agents).sort((a, b) => b[1].minutes - a[1].minutes || a[0].localeCompare(b[0]))
      .map(([a, e]) => `  ${a}: ${e.minutes.toFixed(1)} min, ${e.lanes} lane${e.lanes === 1 ? "" : "s"}${e.share == null ? "" : `, ${Math.round(e.share * 100)}% of pool`}`);
    return [head, ...(rows.length ? rows : ["  per-agent minutes: n/a"])];
  });
}

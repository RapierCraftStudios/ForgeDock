// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5986: attempts per merged issue and per-issue engine comment count for `forgedock stats --attempts`, from the repo's local batch
 * files (state.json `attempts` ledger, report.json rows). No network, no model. The ledger counts failed lanes; the merging lane is
 * one more, so a merged-first-try issue is 1 attempt.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listBatches } from "../lean/batch.mjs";
import { sameRepo, windowLabel } from "./efficiency.mjs";

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const round1 = (x) => Math.round(x * 10) / 10;
const p50 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

/** Per issue (latest row wins across batches): attempts for merged issues, and the engine comment count where a ledger recorded it. */
export function attemptMetrics(rows, ledgers) {
  const by = new Map();
  for (const r of rows ?? []) if (Number.isSafeInteger(r?.issue)) by.set(r.issue, r);
  const detail = [];
  for (const [n, r] of by) {
    if (r.outcome !== "merged") continue;
    const l = ledgers?.[n] ?? null;
    detail.push({ issue: n, attempts: (Number.isInteger(l?.attempts) ? l.attempts : 0) + 1, comments: Number.isInteger(l?.comments) ? l.comments : null });
  }
  const att = detail.map((d) => d.attempts), com = detail.map((d) => d.comments).filter((c) => c !== null);
  return { merged: detail.length, attempts_p50: p50(att), attempts_mean: att.length ? round1(att.reduce((a, b) => a + b, 0) / att.length) : null, attempts_max: att.length ? Math.max(...att) : null,
    comments_p50: p50(com), comments_max: com.length ? Math.max(...com) : null, detail };
}

export function attemptsReport({ batchRoot, repo = null, windows, now = Date.now() }) {
  const batches = (existsSync(batchRoot) ? listBatches(batchRoot) : []).map((id) => {
    const dir = join(batchRoot, id), plan = readJson(join(dir, "plan.json")) ?? {};
    return { dir, plan, created: Date.parse(plan.created ?? "") };
  }).filter((b) => Number.isFinite(b.created) && (!repo || sameRepo(b.plan.repo, repo))).sort((a, b) => a.created - b.created);
  const out = {};
  for (const w of windows) {
    const inWin = batches.filter((b) => b.created <= now && now - b.created <= w), rows = [], ledgers = {};
    for (const b of inWin) { // oldest first: a later batch's row and ledger replace an earlier one for the same issue
      rows.push(...(readJson(join(b.dir, "report.json"))?.rows ?? []));
      Object.assign(ledgers, readJson(join(b.dir, "state.json"))?.attempts ?? {});
    }
    const { detail, ...m } = attemptMetrics(rows, ledgers);
    out[windowLabel(w)] = { batches: inWin.length, ...m, detail };
  }
  return out;
}

export function formatAttemptLines(windows) {
  return Object.entries(windows).flatMap(([w, m]) => [`attempts ${w}: ${m.batches} batch${m.batches === 1 ? "" : "es"}, ${m.merged} merged issue${m.merged === 1 ? "" : "s"}`,
    `  attempts per merged issue: ${m.attempts_mean == null ? "n/a" : `mean ${m.attempts_mean}, p50 ${m.attempts_p50}, max ${m.attempts_max}`}`,
    `  engine comments per issue: ${m.comments_p50 == null ? "n/a" : `p50 ${m.comments_p50}, max ${m.comments_max}`}`]);
}

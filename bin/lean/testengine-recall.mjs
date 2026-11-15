// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test engine, shadow recall ledger and graduation (#5710, Forge CI W3).
 * One JSONL record per CI run: what the selection would have run and which failing tests fell outside it. Only a run of
 * the full suite (`ran: "all"`: shadow, nightly, release) can measure recall; an enforced run is neutral. Selection may
 * skip tests only after `after` consecutive measured runs with 100% failure recall under the current selection config,
 * at least `minFailing` of them a subset selection that caught a real failure (a streak of green runs proves nothing).
 * A miss, an unattributable failure or a selection-config change restarts the count, also after graduation.
 * The ledger is a cache-shaped local file (default outside the checkout); flaky tests are read from it through
 * `release-flakes.mjs` (same-sha fail -> pass flips).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { detectSameShaFlip, flakeEntry, quarantineReport } from "./release-flakes.mjs";

const arr = (v) => (Array.isArray(v) ? v.map(String) : []);

/** Ledger records of `file`, oldest first ([] when absent; a torn or foreign line is skipped). */
export function readLedger(file) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").flatMap((l) => { try { const e = JSON.parse(l); return e && typeof e === "object" && e.v === 1 ? [e] : []; } catch { return []; } });
}
export function appendLedger(file, entry) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/**
 * The record of one run. `failed` = failing test files (or `@suite` names); `unattributed` = failures no test file could be
 * named for, which count as a miss unless everything was selected.
 */
export function recallEntry({ selection, ran = "all", config, failed = [], unattributed = [], sha = "", runId = null, event = null, now = Date.now() }) {
  const inside = new Set([...arr(selection.tests), ...arr(selection.suites)]);
  const fails = [...new Set(arr(failed))].sort(), loose = [...new Set(arr(unattributed))];
  const everything = selection.mode === "all";
  const missed = everything ? [] : fails.filter((f) => !inside.has(f));
  return {
    v: 1, at: new Date(now).toISOString(), sha, run_id: runId === null ? null : String(runId), event, ran, config,
    mode: selection.mode, selected: arr(selection.tests).length, total: Number(selection.total) || 0,
    failed: fails, missed, unattributed: everything ? [] : loose, ok: missed.length === 0 && (everything || loose.length === 0),
  };
}

/**
 * Graduation state of the ledger under the current selection config.
 * @returns {{graduated: boolean, streak: number, needed: number, caught: number, min_failing: number, last_miss: object|null, why: string}}
 */
export function graduation(entries, { after = 50, minFailing = 1, config }) {
  let streak = 0, caught = 0, lastMiss = null, stale = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.ran !== "all") continue;
    if (e.config !== config) { stale = true; break; }
    if (!e.ok) { lastMiss = e; break; }
    streak++;
    if (e.mode === "subset" && e.failed.length) caught++;
  }
  const graduated = streak >= after && caught >= minFailing;
  const why = graduated ? `graduated: ${streak} consecutive full runs with 100% failure recall (${caught} caught a failure inside a subset selection)`
    : streak < after ? `${streak} of ${after} consecutive full runs with 100% failure recall${lastMiss ? " since the last miss" : stale ? " since the selection config changed" : ""}`
    : `${streak} consecutive runs recalled, but only ${caught} of the ${minFailing} required caught a failure inside a subset selection`;
  return { graduated, streak, needed: after, caught, min_failing: minFailing, last_miss: lastMiss, why };
}

/** Flake entries (`release-flakes.mjs` shape) from the ledger: a test file that failed and later passed on one sha, full runs only. */
export function flakesFromLedger(entries) {
  const full = entries.filter((e) => e.ran === "all" && e.sha);
  const failedOn = new Map(), lastAt = new Map();
  for (const e of full) {
    const s = failedOn.get(e.sha) ?? failedOn.set(e.sha, new Set()).get(e.sha);
    for (const f of e.failed) s.add(f);
    lastAt.set(e.sha, e.at);
  }
  const runs = full.flatMap((e, i) => [...failedOn.get(e.sha)].map((test) => ({ sha: e.sha, check: "tests", test, conclusion: e.failed.includes(test) ? "failure" : "success", id: e.run_id ?? `#${i}`, at: e.at })));
  return detectSameShaFlip(runs).map((f) => flakeEntry({ check: f.check, test: f.test, kind: "flip", sha: f.sha, runIds: f.run_ids, at: lastAt.get(f.sha) }));
}

/** Quarantine report for `ci.tests.quarantine` (off | report | non-blocking) from the ledger's flips. */
export const quarantineFromLedger = (entries, cfg, now = Date.now()) =>
  quarantineReport(flakesFromLedger(entries), { mode: cfg.quarantine, quarantineAfter: cfg.quarantineAfter, windowDays: cfg.quarantineWindowDays }, now);

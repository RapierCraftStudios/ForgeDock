// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account-scoped usage-limit holds (#4190). A usage limit belongs to the account a lane runs on, not to a batch: holds
 * live in one host-level file, `~/.forge/limits.json` (or `FORGEDOCK_LIMITS_FILE`), keyed by `backendIdentity`, so two
 * batches on the same account share one hold and a lane on another account is admitted. `forgedock limits show|clear`
 * inspects and clears them. Every write is a fresh read-modify-write through `writeAtomic`; a missing or corrupt file
 * reads as no holds (fail-open: a lost hold costs one more limited lane, a stuck one stalls every batch).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backendIdentity } from "../engine.mjs";
import { writeAtomic } from "./batch.mjs";

/** Identity of the account a core lane runs on: the lane always uses the claude CLI with the dispatcher's env. */
export function laneBackendId(env = process.env) {
  return backendIdentity({ backend: "cli", env });
}

export function limitsFile(env = process.env) {
  return env.FORGEDOCK_LIMITS_FILE || join(homedir(), ".forge", "limits.json");
}

/** Handle on the hold store. @returns {{holdUntil, set, clear, clearAll, list}} */
export function openLimits(file = limitsFile(), { now = () => Date.now() } = {}) {
  const read = () => {
    let o = null;
    try { o = JSON.parse(readFileSync(file, "utf8")); } catch { o = null; }
    const holds = o && typeof o.holds === "object" && o.holds && !Array.isArray(o.holds) ? o.holds : {};
    const t = now(), live = {};
    for (const [id, h] of Object.entries(holds)) if (Number.isFinite(h?.until) && h.until > t) live[id] = h;
    return live;
  };
  const write = (holds) => writeAtomic(file, JSON.stringify({ v: 1, holds }, null, 2) + "\n");
  return {
    file,
    /** Epoch ms the account `id` is held until, or null. */
    holdUntil: (id) => read()[id]?.until ?? null,
    set: (id, untilMs, source = null) => {
      const holds = read();
      const prev = holds[id];
      if (prev && prev.until >= untilMs) return prev.until;
      holds[id] = { until: untilMs, source, setAt: now() };
      write(holds);
      return untilMs;
    },
    clear: (id) => {
      const holds = read();
      if (!holds[id]) return false;
      delete holds[id];
      write(holds);
      return true;
    },
    clearAll: () => { const n = Object.keys(read()).length; write({}); return n; },
    list: () => Object.entries(read()).map(([id, h]) => ({ id, until: h.until, source: h.source ?? null, setAt: h.setAt ?? null })),
  };
}

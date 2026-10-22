// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host sequence lease (#4386): one lane at a time per (repo, lane branch, sequence dir) in the window from the
 * merge-gate renumber of its numbered files to its merge, so parallel lanes stop overtaking each other's numbers.
 * Each key is a one-slot `heavy.mjs` semaphore in its own registry dir (`schedDir()/seq-lease/<key>/heavy.json`):
 * file-locked, FIFO, dead holders dropped by pid. The heavy-step registry and its env caps are never touched.
 * Fail-open: a wait over `maxWaitS` (or an unreadable registry) proceeds without the lease; CI and base-sync stay the gate.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { acquireHeavy, openHeavy } from "./heavy.mjs";
import { schedDir } from "./sched.mjs";

/** The lease key of one sequence dir of one lane branch of one repo. */
export const sequenceLeaseKey = (repo, lane, dir) => createHash("sha1").update(`${repo}\0${lane}\0${dir}`).digest("hex").slice(0, 16);

const NO_MEM = Object.freeze({ cores: () => 2, memAvailableMb: () => null });

/**
 * `acquire({repo, lane, dirs, issue, maxWaitS})` takes every dir's lease in sorted order (no lock-order deadlock).
 * @returns {{acquire: (e:object) => Promise<{waitMs:number, timedOut:boolean, release:Function}>}}
 */
export function makeSequenceLeaseIo({ dir = join(schedDir(), "seq-lease"), open = openHeavy, acquire = acquireHeavy, pollMs } = {}) {
  return {
    async acquire({ repo, lane, dirs = [], issue = null, maxWaitS = 1800 } = {}) {
      const held = [];
      let waitMs = 0, timedOut = false;
      for (const d of [...new Set(dirs)].sort()) {
        const h = open(join(dir, sequenceLeaseKey(repo, lane, d)), { cfg: { max: 1, max_wait_s: maxWaitS }, env: {}, host: NO_MEM });
        const g = await acquire(h, { issue, phase: "sequence" }, ...(pollMs ? [{ pollMs }] : []));
        waitMs += g.waitMs ?? 0;
        if (g.timedOut) timedOut = true;
        held.push(g);
      }
      let released = false;
      return { waitMs, timedOut, release: () => { if (released) return; released = true; for (const g of held.reverse()) { try { g.release(); } catch { /* fail-open */ } } } };
    },
  };
}

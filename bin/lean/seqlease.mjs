// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host sequence lease (#4386): one lane at a time per (repo, lane branch, sequence dir) in the window from the
 * merge-gate renumber of its numbered files to its merge, so parallel lanes stop overtaking each other's numbers.
 * Each key is a one-slot `heavy.mjs` semaphore in its own registry dir (`schedDir()/seq-lease/<key>/heavy.json`):
 * file-locked, FIFO, dead holders dropped by pid. The heavy-step registry and its env caps are never touched.
 * Fail-open: a wait over `maxWaitS` (or an unreadable registry) proceeds without the lease; CI and base-sync stay the gate.
 * #4526: number reservations. `reserve` picks the numbers of a renumber under a short host lock per (repo, base, dir) in
 * its own registry (`schedDir()/seq-pick/<key>/`, never the lease above: its holder renumbers while it holds it) and
 * records them in `reserved.json` until `unreserve` (run end), the holder's death or 24h, so concurrent lanes renumbering
 * against the same base get distinct numbers without holding a lock across regenerate and push. Fail-open.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireHeavy, openHeavy } from "./heavy.mjs";
import { pidAlive, schedDir } from "./sched.mjs";

/** The lease key of one sequence dir of one lane branch of one repo. */
export const sequenceLeaseKey = (repo, lane, dir) => createHash("sha1").update(`${repo}\0${lane}\0${dir}`).digest("hex").slice(0, 16);

const NO_MEM = Object.freeze({ cores: () => 2, memAvailableMb: () => null });
const RESERVE_TTL_MS = 24 * 3600 * 1000;

/**
 * `acquire({repo, lane, dirs, issue, maxWaitS})` takes every dir's lease in sorted order (no lock-order deadlock).
 * @returns {{acquire: (e:object) => Promise<{waitMs:number, timedOut:boolean, release:Function}>}}
 */
export function makeSequenceLeaseIo({ dir = join(schedDir(), "seq-lease"), pickDir = join(schedDir(), "seq-pick"), open = openHeavy, acquire = acquireHeavy, pollMs, alive = pidAlive, now = () => Date.now() } = {}) {
  const reservedDirs = new Map(); // `${repo}\0${lane}\0${issue}` -> dirs reserved in, for unreserve
  /** Run `fn(entries) => entries'` on one key's reservations under its pick lock; returns what `fn` set as `out`. */
  const locked = async ({ repo, lane, dir: d }, fn) => {
    const kd = join(pickDir, sequenceLeaseKey(repo, lane, d)), file = join(kd, "reserved.json");
    const h = open(kd, { cfg: { max: 1, max_wait_s: 60 }, env: {}, host: NO_MEM });
    const g = await acquire(h, { phase: "sequence-pick" }, ...(pollMs ? [{ pollMs }] : []));
    try {
      let entries = [];
      try { const o = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(o?.entries)) entries = o.entries; } catch { /* none yet */ }
      const t = now();
      entries = entries.filter((e) => Array.isArray(e?.numbers) && alive(e.pid) && t - Number(e.at ?? 0) < RESERVE_TTL_MS);
      const r = fn(entries);
      mkdirSync(kd, { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ entries: r.entries }, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      return r.out;
    } finally { try { g.release(); } catch { /* fail-open */ } }
  };
  return {
    /**
     * #4526: `count` consecutive numbers above max(floor, every other issue's live reservation) in (repo, lane, dir),
     * recorded for `issue` (its earlier entries there replaced). @returns {Promise<{numbers:number[]}|null>} null on error.
     */
    async reserve({ repo, lane, dir: d, issue = null, floor = 0, count = 1, pid = process.pid } = {}) {
      try {
        const k = `${repo}\0${lane}\0${issue}`;
        reservedDirs.set(k, new Set([...(reservedDirs.get(k) ?? []), d]));
        return await locked({ repo, lane, dir: d }, (entries) => {
          const others = entries.filter((e) => String(e.issue) !== String(issue));
          let n = Math.max(Number(floor) || 0, ...others.flatMap((e) => e.numbers.map(Number)).filter(Number.isFinite));
          const numbers = Array.from({ length: Math.max(0, count) }, () => ++n);
          return { entries: [...others, { issue, pid, numbers, at: now() }], out: { numbers } };
        });
      } catch { return null; }
    },
    /** #4526: drop `issue`'s reservations in every dir of (repo, lane) it reserved in this process. Never throws. */
    async unreserve({ repo, lane, issue = null } = {}) {
      for (const d of [...(reservedDirs.get(`${repo}\0${lane}\0${issue}`) ?? [])]) {
        try { await locked({ repo, lane, dir: d }, (entries) => ({ entries: entries.filter((e) => String(e.issue) !== String(issue)) })); } catch { /* fail-open */ }
      }
      reservedDirs.delete(`${repo}\0${lane}\0${issue}`);
    },
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

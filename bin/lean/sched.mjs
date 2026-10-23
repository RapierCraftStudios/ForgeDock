// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host lane registry (#4191): one host-wide cap on running `forgedock orchestrate` lanes across every batch and repo,
 * and cross-batch priority admission. State is one file, `~/.forge/sched/registry.json` (or `FORGEDOCK_SCHED_DIR`):
 * `{v, cap, weights, seq, slots:{key:{pid, lanePid?, batch, repo, issue, priority, at}}, queue:{key:{pid, batch, repo,
 * issue, priority, seq, enqueuedAt}}}` with key `<batch>#<issue>`. Every mutation is a read-modify-write under an
 * exclusive lock file (`registry.lock`, holding the owner pid; a dead owner's lock is taken over) and `writeAtomic`.
 *
 * A dispatcher offers the issues it could start now; `tryAcquire` grants a slot only while live slots < cap and the
 * key ranks within the free slots of the queue in grant order (`grantOrder`): priority first, so a P0 offered last is
 * granted next. Within a priority, slots are shared across repos by the registry's `weights` (#4193; `{"owner/repo": N}`,
 * `forgedock sched weight`, unset = 1): the next entry comes from the repo with the smallest (live slots + entries
 * ordered ahead) / weight, FIFO inside a repo; an entry without a repo groups by batch. Running lanes are never revoked.
 * A queued entry dies with its dispatcher pid; a slot dies with its dispatcher unless its detached lane (`lanePid`)
 * still runs, so an orphaned lane keeps counting until it exits or a `--resume` adopts it. Cap: the registry's own
 * (`forgedock sched cap N`), else the caller's forge.yaml `orchestration.global_parallel`, else none. Fail-open: an
 * unreadable registry or a lock not taken within `lockWaitMs` grants (`fallback: true`), since a stuck registry would
 * stall every batch on the host.
 * Per-issue lock (#4481): a key is never granted while a live slot of another batch holds the same (non-null) repo and
 * issue, so two batches that both include issue N (a resumed batch and a new one) never run two lanes for N at once;
 * `tryAcquire` answers `{ok:false, conflict:<batch>}` and drops the key from the queue (it would hold a grant rank).
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "./batch.mjs";

export const DEFAULT_PRIORITY = 2;
export const LOCK_WAIT_MS = 2000;
const EMPTY_LOCK_STALE_MS = 5000;

export function schedDir(env = process.env) {
  return env.FORGEDOCK_SCHED_DIR || join(homedir(), ".forge", "sched");
}

/** Priority from label names (or `{name}` objects): `priority:P<n>` or bare `P<n>`, lowest n wins; unlabelled = 2. */
export function priorityFromLabels(labels) {
  let best = null;
  for (const l of labels ?? []) {
    const m = /^(?:priority:)?P(\d+)$/i.exec(String(l?.name ?? l ?? "").trim());
    if (m && (best === null || Number(m[1]) < best)) best = Number(m[1]);
  }
  return best ?? DEFAULT_PRIORITY;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

const posInt = (k) => (Number.isInteger(k) && k >= 1 ? k : null);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const byRank = ([ka, a], [kb, b]) => (a.priority - b.priority) || (a.seq - b.seq) || (ka < kb ? -1 : ka > kb ? 1 : 0);
const groupOf = (k, e) => e?.repo ?? e?.batch ?? k;
/** #4481: the batch of another live slot running the same repo and issue as `entry`, or null (no repo: never). */
const holderOf = (s, key, entry) => {
  if (!entry?.repo || entry.issue == null) return null;
  for (const [k, e] of Object.entries(s.slots)) {
    if (k !== key && e?.repo === entry.repo && e?.issue === entry.issue && (e.batch ?? null) !== (entry.batch ?? null)) return e.batch ?? k;
  }
  return null;
};

/**
 * Queue entries `[key, entry]` in grant order: priority ascending, then a weighted fair share across repos within each
 * priority (smallest load/weight first, load = live slots + entries already ordered; ties: higher weight, then FIFO).
 */
export function grantOrder(s) {
  const weight = (g) => posInt(s.weights?.[g]) ?? 1;
  const load = new Map();
  for (const [k, e] of Object.entries(s.slots ?? {})) { const g = groupOf(k, e); load.set(g, (load.get(g) ?? 0) + 1); }
  const levels = new Map(); // priority -> Map(group -> FIFO entries)
  for (const ent of Object.entries(s.queue ?? {}).sort(byRank)) {
    const [k, e] = ent;
    if (!levels.has(e.priority)) levels.set(e.priority, new Map());
    const groups = levels.get(e.priority), g = groupOf(k, e);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(ent);
  }
  const out = [];
  for (const p of [...levels.keys()].sort((a, b) => a - b)) {
    const groups = levels.get(p);
    while (groups.size) {
      let best = null;
      for (const [g, list] of groups) {
        if (!best) { best = g; continue; }
        const lg = (load.get(g) ?? 0) * weight(best), lb = (load.get(best) ?? 0) * weight(g);
        if (lg < lb || (lg === lb && (weight(g) > weight(best) || (weight(g) === weight(best) && byRank(list[0], groups.get(best)[0]) < 0)))) best = g;
      }
      const list = groups.get(best);
      out.push(list.shift());
      load.set(best, (load.get(best) ?? 0) + 1);
      if (!list.length) groups.delete(best);
    }
  }
  return out;
}

/**
 * Handle on the registry. `pid` is this dispatcher; `alive(pid)` is the liveness probe (injected in tests).
 * @returns {{dir, tryAcquire, holder, offer, withdraw, release, setLanePid, adoptSlot, cap, setCap, weights, setWeight, list}}
 */
export function openSched(dir = schedDir(), { now = () => Date.now(), pid = process.pid, alive = pidAlive, lockWaitMs = LOCK_WAIT_MS } = {}) {
  const file = join(dir, "registry.json"), lockFile = join(dir, "registry.lock");

  const lock = () => {
    mkdirSync(dir, { recursive: true });
    const end = Date.now() + lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(lockFile, "wx");
        try { writeSync(fd, String(pid)); } finally { closeSync(fd); }
        return;
      } catch (e) { if (e?.code !== "EEXIST") throw e; }
      let owner = NaN;
      try { owner = parseInt(readFileSync(lockFile, "utf8"), 10); } catch { /* released meanwhile */ }
      // An empty lock is one being created (open, then the pid is written): stale only once it is old.
      let empty = false;
      if (Number.isNaN(owner)) { try { empty = Date.now() - statSync(lockFile).mtimeMs < EMPTY_LOCK_STALE_MS; } catch { continue; } }
      if (!empty && (Number.isNaN(owner) || !alive(owner))) {
        // Take over a dead owner's lock: move it aside, and put it back if it turned out to be a fresh one.
        const aside = `${lockFile}.stale-${pid}`;
        try {
          renameSync(lockFile, aside);
          let got = NaN;
          try { got = parseInt(readFileSync(aside, "utf8"), 10); } catch { /* gone */ }
          if (!Number.isNaN(got) && got !== owner && alive(got)) { try { renameSync(aside, lockFile); } catch { /* best effort */ } }
          else rmSync(aside, { force: true });
        } catch { /* someone else took it over */ }
        continue;
      }
      if (Date.now() >= end) throw new Error(`sched registry lock held by pid ${Number.isNaN(owner) ? "?" : owner}`);
      pause(10);
    }
  };
  const unlock = () => { try { rmSync(lockFile, { force: true }); } catch { /* best effort */ } };

  const read = () => {
    let o;
    try { o = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
      if (e?.code !== "ENOENT") throw new Error(`sched registry ${file} unreadable: ${e?.message ?? e}`);
      o = {};
    }
    const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
    const weights = Object.fromEntries(Object.entries(obj(o?.weights)).filter(([, n]) => posInt(n)));
    return { v: 1, cap: posInt(o?.cap), weights, seq: Number.isInteger(o?.seq) ? o.seq : 0, slots: obj(o?.slots), queue: obj(o?.queue) };
  };
  // Drop queued entries of dead dispatchers, and slots whose dispatcher and lane are both gone.
  const reclaim = (s) => {
    for (const [k, e] of Object.entries(s.queue)) if (!alive(e.pid)) delete s.queue[k];
    for (const [k, e] of Object.entries(s.slots)) if (!alive(e.pid) && !(e.lanePid && alive(e.lanePid))) delete s.slots[k];
  };
  const mutate = (fn) => {
    lock();
    try {
      const s = read();
      reclaim(s);
      const r = fn(s);
      writeAtomic(file, JSON.stringify(s, null, 2) + "\n");
      return r;
    } finally { unlock(); }
  };
  const enqueue = (s, key, e) => {
    if (s.slots[key]) return;
    const prev = s.queue[key];
    const priority = Number.isFinite(Number(e.priority)) ? Number(e.priority) : DEFAULT_PRIORITY;
    s.queue[key] = prev
      ? { ...prev, pid, priority }
      : { pid, batch: e.batch ?? null, repo: e.repo ?? null, issue: e.issue ?? null, priority, seq: ++s.seq, enqueuedAt: now() };
  };
  const effCap = (s, callerCap) => s.cap ?? posInt(callerCap);

  return {
    dir,
    /** Grant `key` a slot, queueing it when none is free for it now. @returns {{ok:boolean, fallback?:true, reason?:string}} */
    tryAcquire: (key, entry = {}, callerCap = null) => {
      try {
        return mutate((s) => {
          if (s.slots[key]) return { ok: true };
          const holder = holderOf(s, key, entry);
          if (holder !== null) { delete s.queue[key]; return { ok: false, conflict: holder, reason: `#${entry.issue} has a live lane in batch ${holder}` }; }
          enqueue(s, key, entry);
          const cap = effCap(s, callerCap);
          if (cap !== null) {
            const free = cap - Object.keys(s.slots).length;
            const rank = grantOrder(s).findIndex(([k]) => k === key);
            if (free <= 0) return { ok: false, reason: `host cap ${cap} reached` };
            if (rank >= free) return { ok: false, reason: `queued behind ${rank} higher-ranked issue(s)` };
          }
          const q = s.queue[key];
          delete s.queue[key];
          s.slots[key] = { pid, batch: q.batch, repo: q.repo, issue: q.issue, priority: q.priority, at: now() };
          return { ok: true };
        });
      } catch (e) { return { ok: true, fallback: true, reason: e?.message ?? String(e) }; }
    },
    /** #4481: the other batch holding a live slot for `{repo, issue}` (not `batch`), or null; null on any error. */
    holder: (entry = {}) => { try { return mutate((s) => holderOf(s, null, entry)); } catch { return null; } },
    /** Queue entries `[{key, batch, repo, issue, priority}]` (their FIFO position is kept on a re-offer). */
    offer: (entries) => { try { mutate((s) => { for (const e of entries) enqueue(s, e.key, e); }); } catch { /* fail-open */ } },
    withdraw: (keys) => { if (!keys.length) return; try { mutate((s) => { for (const k of keys) delete s.queue[k]; }); } catch { /* fail-open */ } },
    release: (key) => { try { mutate((s) => { delete s.slots[key]; delete s.queue[key]; }); } catch { /* fail-open */ } },
    setLanePid: (key, lanePid) => { try { mutate((s) => { if (s.slots[key] && posInt(lanePid)) s.slots[key].lanePid = lanePid; }); } catch { /* fail-open */ } },
    /** Record a lane this dispatcher re-attached to: it runs already, so the cap does not gate it. */
    adoptSlot: (key, entry = {}) => {
      try {
        mutate((s) => {
          delete s.queue[key];
          s.slots[key] = { pid, ...(posInt(entry.lanePid) ? { lanePid: entry.lanePid } : {}), batch: entry.batch ?? null, repo: entry.repo ?? null,
            issue: entry.issue ?? null, priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : DEFAULT_PRIORITY, at: now() };
        });
      } catch { /* fail-open */ }
    },
    cap: () => read().cap,
    /** Set the live host cap (a positive integer), or null to fall back to each dispatcher's config. Throws. */
    setCap: (k) => {
      if (k !== null && !posInt(k)) throw new Error("cap must be a positive integer");
      return mutate((s) => { s.cap = k; return k; });
    },
    weights: () => read().weights,
    /** Set the fair-share weight of `repo` (a positive integer), or null to reset it to 1. Throws. */
    setWeight: (repo, n) => {
      if (typeof repo !== "string" || !repo.trim()) throw new Error("repo must be a non-empty string");
      if (n !== null && !posInt(n)) throw new Error("weight must be a positive integer");
      return mutate((s) => { if (n === null) delete s.weights[repo]; else s.weights[repo] = n; return n; });
    },
    /** Live state after reclaim: `{cap, weights, slots:[{key,...}], queue:[{key,...}] in grant order}`. Throws when unreadable. */
    list: () => mutate((s) => ({
      cap: s.cap,
      weights: { ...s.weights },
      slots: Object.entries(s.slots).map(([key, e]) => ({ key, ...e })),
      queue: grantOrder(s).map(([key, e]) => ({ key, ...e })),
    })),
  };
}

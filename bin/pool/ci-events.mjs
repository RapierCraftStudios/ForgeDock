// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** #5688: CI runner events pushed to the pool router and long-polled by agents (parent #5687). */
export const CI_EVENT_TYPES = ["job_started", "step_started", "step_failed", "test_failed", "job_finished", "runner_unhealthy"];
export const MAX_BATCH = 200, MAX_LINES = 40, MAX_LINE_CHARS = 500, RING_CAP = 2000, TTL_MS = 24 * 3600 * 1000, MAX_WAIT_S = 60;
const MAX_STR = 500;
const DAY_MS = 24 * 3600 * 1000;

const bad = (key, why, status = 400) => Object.assign(new Error(`invalid event: ${key} ${why}`), { status, key });
const str = (e, key, required) => {
  const v = e[key];
  if (v === undefined || v === null) { if (required) throw bad(key, "is required"); return undefined; }
  if (typeof v !== "string" || !v || v.length > MAX_STR) throw bad(key, "must be a non-empty string of at most 500 chars");
  return v;
};
const int = (e, key) => {
  const v = e[key];
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v)) throw bad(key, "must be an integer");
  return v;
};

/** Returns the normalized event (known keys only) or throws an error carrying `status` (400 bad key, 413 over a limit) and `key`. */
export function validateEvent(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw bad("event", "must be an object");
  if (!CI_EVENT_TYPES.includes(e.type)) throw bad("type", `must be one of ${CI_EVENT_TYPES.join(", ")}`);
  const out = { type: e.type, repo: str(e, "repo", true), sha: str(e, "sha", true) };
  const run = e.run_id;
  if (run === undefined || run === null) throw bad("run_id", "is required");
  if (!(typeof run === "string" && run && run.length <= MAX_STR) && !Number.isInteger(run)) throw bad("run_id", "must be a string or integer");
  out.run_id = run;
  out.job = str(e, "job", true);
  const ts = e.ts;
  if (ts === undefined || ts === null) throw bad("ts", "is required");
  if (!(typeof ts === "string" && ts && ts.length <= MAX_STR) && !Number.isFinite(ts)) throw bad("ts", "must be a string or number");
  out.ts = ts;
  if (e.pr !== undefined && e.pr !== null) {
    if (!Number.isInteger(e.pr) && !(typeof e.pr === "string" && /^\d{1,9}$/.test(e.pr))) throw bad("pr", "must be an integer");
    out.pr = Number(e.pr);
  }
  const step = str(e, "step"), cls = str(e, "class"), code = int(e, "exit_code");
  if (step !== undefined) out.step = step;
  if (cls !== undefined) out.class = cls;
  if (code !== undefined) out.exit_code = code;
  if (e.lines !== undefined && e.lines !== null) {
    if (!Array.isArray(e.lines) || !e.lines.every((l) => typeof l === "string")) throw bad("lines", "must be a list of strings");
    if (e.lines.length > MAX_LINES) throw bad("lines", `has more than ${MAX_LINES} entries`, 413);
    if (e.lines.some((l) => l.length > MAX_LINE_CHARS)) throw bad("lines", `has an entry over ${MAX_LINE_CHARS} chars`, 413);
    out.lines = e.lines;
  }
  if (e.test !== undefined && e.test !== null) {
    const t = e.test;
    if (typeof t !== "object" || Array.isArray(t)) throw bad("test", "must be an object");
    const tid = str(t, "id", true), file = str(t, "file"), line = int(t, "line"), message = t.message;
    if (message !== undefined && (typeof message !== "string" || message.length > 4 * MAX_STR)) throw bad("test.message", "must be a string of at most 2000 chars");
    out.test = { id: tid, ...(file !== undefined ? { file } : {}), ...(line !== undefined ? { line } : {}), ...(message !== undefined ? { message } : {}) };
  }
  return out;
}

/** Fixed-capacity circular buffer: pushing past the cap overwrites the oldest entry without shifting. */
class Ring {
  constructor(cap) { this.cap = cap; this.a = new Array(cap); this.start = 0; this.len = 0; }
  push(v) {
    if (this.len < this.cap) this.a[(this.start + this.len++) % this.cap] = v;
    else { this.a[this.start] = v; this.start = (this.start + 1) % this.cap; }
  }
  dropWhile(pred) { while (this.len && pred(this.a[this.start])) { this.a[this.start] = undefined; this.start = (this.start + 1) % this.cap; this.len--; } }
  *[Symbol.iterator]() { for (let i = 0; i < this.len; i++) yield this.a[(this.start + i) % this.cap]; }
}

const repoKey = (repo) => `${repo.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}-${createHash("sha1").update(repo).digest("hex").slice(0, 8)}`;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Event store. Memory: a ring per (repo, sha), 2000 events, 24 h TTL. Disk: `<dir>/<repo-key>.ndjson`, rotated to
 * `<repo-key>.<YYYY-MM-DD>.ndjson` when the UTC day changes; the last 24 h are reloaded on creation and `seq` resumes.
 */
export function createCiEvents({ dir, now = () => Date.now(), cap = RING_CAP, ttlMs = TTL_MS } = {}) {
  const rings = new Map(); // `${repo}\n${sha}` -> Ring
  const fileDay = new Map(); // repo-key -> UTC day of its active file's last write
  const waiters = new Set();
  let seq = 0, lastSweep = now();

  const keep = (e, t) => t - e.received_at < ttlMs;
  const put = (e) => {
    const k = `${e.repo}\n${e.sha}`;
    let r = rings.get(k);
    if (!r) rings.set(k, (r = new Ring(cap)));
    r.push(e);
  };
  const sweep = (t) => {
    lastSweep = t;
    for (const [k, r] of rings) { r.dropWhile((e) => !keep(e, t)); if (!r.len) rings.delete(k); }
  };

  function load() {
    if (!dir || !existsSync(dir)) return;
    const t = now(), all = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ndjson")) continue;
      const p = join(dir, f);
      try { if (t - statSync(p).mtimeMs > ttlMs + DAY_MS) continue; } catch { continue; }
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (Number.isFinite(e.seq) && Number.isFinite(e.received_at)) all.push(e); } catch { /* torn line */ }
      }
    }
    all.sort((a, b) => a.seq - b.seq);
    for (const e of all) { seq = Math.max(seq, e.seq); if (keep(e, t)) put(e); }
  }

  function persist(batch) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const t = now(), today = dayOf(t), byFile = new Map();
    for (const e of batch) { const k = repoKey(e.repo); (byFile.get(k) ?? byFile.set(k, []).get(k)).push(e); }
    for (const [k, es] of byFile) {
      const file = join(dir, `${k}.ndjson`);
      let day = fileDay.get(k);
      if (!day && existsSync(file)) day = dayOf(statSync(file).mtimeMs);
      if (day && day !== today && existsSync(file)) renameSync(file, join(dir, `${k}.${day}.ndjson`));
      fileDay.set(k, today);
      appendFileSync(file, es.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    }
    if (byFile.size) for (const f of readdirSync(dir)) { // drop rotated files whose whole day is past the TTL
      const m = /\.(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
      if (m && t - Date.parse(`${m[1]}T00:00:00Z`) > ttlMs + DAY_MS) try { unlinkSync(join(dir, f)); } catch { /* raced */ }
    }
  }

  const matches = (e, q) => e.repo === q.repo && (q.sha === undefined || e.sha === q.sha) && (q.pr === undefined || e.pr === q.pr);

  /** Events of `q` ({repo, sha?, pr?}) with seq > since, oldest first; `next` is the cursor to resume from. */
  function query(q, since = 0) {
    const t = now();
    if (t - lastSweep > 60000) sweep(t);
    const out = [];
    if (q.sha !== undefined) { const r = rings.get(`${q.repo}\n${q.sha}`); if (r) for (const e of r) if (e.seq > since && keep(e, t) && matches(e, q)) out.push(e); }
    else for (const [k, r] of rings) if (k.startsWith(`${q.repo}\n`)) for (const e of r) if (e.seq > since && keep(e, t) && matches(e, q)) out.push(e);
    out.sort((a, b) => a.seq - b.seq);
    return { events: out, next: out.length ? out[out.length - 1].seq : Math.max(since, seq) };
  }

  /** Validates the whole list first (nothing is stored when one event is bad), then stamps `received_at` and `seq`. */
  function ingest(input) {
    const list = Array.isArray(input) ? input : [input];
    if (!list.length) throw Object.assign(new Error("invalid event: body is empty"), { status: 400 });
    if (list.length > MAX_BATCH) throw Object.assign(new Error(`too many events (max ${MAX_BATCH})`), { status: 413 });
    const clean = list.map((e, i) => { try { return validateEvent(e); } catch (err) { if (list.length > 1) err.message = `${err.message} (event ${i})`; throw err; } });
    const t = now(), stamped = clean.map((e) => ({ ...e, seq: ++seq, received_at: t }));
    persist(stamped);
    for (const e of stamped) put(e);
    for (const w of [...waiters]) { const r = query(w.q, w.since); if (r.events.length) { waiters.delete(w); clearTimeout(w.timer); w.resolve(r); } }
    return { accepted: stamped.length, seq };
  }

  /** Long-poll: resolves at once when events exist, else on the next matching ingest or after `waitS` seconds (max 60). */
  function wait(q, since = 0, waitS = 0) {
    const r = query(q, since), ms = Math.min(Math.max(Number(waitS) || 0, 0), MAX_WAIT_S) * 1000;
    if (r.events.length || !ms) return Promise.resolve(r);
    return new Promise((resolve) => {
      const w = { q, since, resolve, timer: setTimeout(() => { waiters.delete(w); resolve(query(q, since)); }, ms) };
      waiters.add(w);
    });
  }

  load();
  return { ingest, query, wait, get seq() { return seq; }, size: () => [...rings.values()].reduce((n, r) => n + r.len, 0) };
}

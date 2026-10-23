// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host scheduler daemon (#4192): one process hosts the `orchestrate()` loop of every batch on the host, instead of one
 * dispatcher per `forgedock orchestrate`. Single instance: `schedd.lock` (the daemon pid, created with O_EXCL; a dead
 * owner's lock is taken over) plus the unix socket `schedd.sock`, both in `schedDir()` (`~/.forge/sched/`, or
 * `FORGEDOCK_SCHED_DIR`). Auto-spawned by the first `orchestrate` client, or run in the foreground by a systemd-user unit.
 *
 * Protocol: newline-delimited JSON, one request per connection.
 *   {op:"submit", argv, cwd, env} → {type:"batch", id, dir}, {type:"row", row}…, {type:"line", text}…, {type:"done", result, report}
 *   {op:"attach", id}             → log.jsonl rows replayed, then live rows/lines and done; a finished batch replays report.json
 *                                   ({type:"done", replay:true}) unless it has unrun added issues; a batch nobody hosts is resumed here
 *   {op:"set-parallel", id, k}    → {type:"ok", parallel}
 *   {op:"add", id, issues}        → {type:"ok", added, skipped, hosted} (#4408): merged into the batch's `add` file, which a
 *                                   hosted runner reads on its next pass and an unhosted batch on its next resume
 *   {op:"cancel", id}             → {type:"ok", cancelled:true, hosted} (#4376): writes the batch's `cancel` file; that batch
 *                                   admits nothing more, its running local lanes get SIGTERM (their teardown saves the work)
 *                                   and the rest end held; no other batch and not the daemon. A finished, unhosted batch:
 *                                   {type:"ok", cancelled:false, finished:true}, nothing written
 *   {op:"status"}                 → {type:"status", pid, batches:[{id, running}]}
 * Failures answer {type:"error", message}. A client closing its connection never cancels a batch (only `cancel` stops one), and stopping the daemon
 * never stops a lane (lanes are detached sessions). On start the daemon resumes every daemon-hosted batch without a
 * report, so live lanes are re-adopted through the batch runner's `adopt`. It exits after `idleMs` with no batch and no client.
 * Shutdown (#4454): `close()` aborts every hosted batch's `signal` (its loop admits nothing more and leaves, lanes keep
 * running, no report is written), waits for them up to `stopMs`, and only then releases `schedd.lock` and the socket, so a
 * daemon started next never resumes a batch this one still dispatches. `exitOnSignals` exits 128+signo after that.
 * `runBatch({argv, cwd, env, sink, keepBreaker, signal})` is injected (engine-cli `runBatch`); `sink` gets `batch(b)`, `row(r)`, `line(text)`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { schedDir, pidAlive } from "./sched.mjs";
import { batchRoot, listBatches, openBatch } from "./batch.mjs";

export const IDLE_MS = 10 * 60 * 1000;
export const STOP_MS = 10 * 1000;

export function scheddPaths(dir = schedDir()) {
  return { dir, sock: join(dir, "schedd.sock"), lock: join(dir, "schedd.lock"), log: join(dir, "schedd.log") };
}

// Env keys a batch keeps for its lanes (account and backend selectors, tool paths); persisted in plan.json.
const ENV_KEEP = /^(PATH|HOME|USER|SHELL|LANG|LC_ALL|TMPDIR|FORGEDOCK_.*|CLAUDE_.*|ANTHROPIC_.*|GH_.*|GITHUB_.*)$/;

/** The allowlisted part of `env`. */
export function batchEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => ENV_KEEP.test(k) && typeof v === "string"));
}

/** `base` without its allowlisted keys, plus `kept`: an account selector the client did not set never leaks in from the daemon. */
export function mergeEnv(base, kept) {
  const out = Object.fromEntries(Object.entries(base).filter(([k]) => !ENV_KEEP.test(k)));
  return { ...out, ...kept };
}

/** Take the daemon lock; null when another live daemon holds it. */
function takeLock(lock, pid, alive) {
  for (let i = 0; i < 5; i++) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, String(pid)); } finally { closeSync(fd); }
      return true;
    } catch (e) { if (e?.code !== "EEXIST") throw e; }
    let owner = NaN;
    try { owner = parseInt(readFileSync(lock, "utf8"), 10); } catch { continue; }
    if (Number.isInteger(owner) && owner !== pid && alive(owner)) return null;
    rmSync(lock, { force: true });
  }
  return null;
}

/**
 * Start the daemon. @returns {Promise<{running:true, pid, close, closed:Promise} | {running:false, owner:number}>}
 */
export async function startDaemon({ dir = schedDir(), runBatch, idleMs = Number(process.env.FORGEDOCK_SCHEDD_IDLE_MS) || IDLE_MS,
  root = batchRoot(), log = (m) => console.log(m), pid = process.pid, alive = pidAlive, resumeOnStart = true, stopMs = STOP_MS } = {}) {
  const p = scheddPaths(dir);
  mkdirSync(dir, { recursive: true });
  if (!takeLock(p.lock, pid, alive)) {
    let owner = NaN;
    try { owner = parseInt(readFileSync(p.lock, "utf8"), 10); } catch { /* gone */ }
    log(`schedd: already running (pid ${owner})`);
    return { running: false, owner };
  }
  rmSync(p.sock, { force: true });

  const hosted = new Map(); // batch id -> {id, dir, subs:Set<fn>}
  const conns = new Set();
  const runs = new Map(); // every runBatch in flight (hosted or not yet started) -> its AbortController (#4454)
  let closing = null, resolveClosed;
  let lastActive = Date.now();
  const touch = () => { lastActive = Date.now(); };

  /** Run one batch here. Resolves with {id, dir} once the batch exists, rejects when it fails before that. */
  const host = ({ argv, cwd, env, keepBreaker = false }, first = null) => new Promise((resolve, reject) => {
    if (closing) return reject(new Error("schedd is shutting down"));
    const ac = new AbortController();
    const ent = { id: null, dir: null, subs: new Set(first ? [first] : []) };
    const emit = (m) => { for (const s of ent.subs) s(m); };
    let started = false;
    const sink = {
      batch: (b) => { ent.id = b.id; ent.dir = b.dir; hosted.set(b.id, ent); started = true; resolve(ent); },
      row: (row) => emit({ type: "row", row }),
      line: (text) => emit({ type: "line", text }),
    };
    touch();
    const run = Promise.resolve().then(() => runBatch({ argv, cwd, env, sink, keepBreaker, signal: ac.signal })).then((result) => {
      const report = ent.dir ? openBatch(root, ent.id).readReport()?.report ?? null : null;
      emit({ type: "done", result, report });
    }, (e) => {
      const message = e?.message ?? String(e);
      if (e?.code === "batch.stopped") { log(`schedd: batch ${ent.id ?? argv.join(" ")} stopped (lanes keep running; resumed by the next daemon)`); if (!started) reject(new Error(message)); return; }
      if (!started) reject(new Error(message)); else { log(`schedd: batch ${ent.id} failed: ${message}`); emit({ type: "error", message }); }
    }).finally(() => { if (ent.id) hosted.delete(ent.id); ent.subs.clear(); runs.delete(run); touch(); });
    runs.set(run, ac);
  });

  const handle = async (req, send) => {
    if (req.op === "status") return send({ type: "status", pid, batches: [...hosted.keys()].map((id) => ({ id, running: true })) }, true);
    if (req.op === "set-parallel") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      b.setParallel(Number(req.k));
      return send({ type: "ok", parallel: Number(req.k) }, true);
    }
    if (req.op === "add") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const { added, skipped } = b.addIssues(req.issues ?? []);
      return send({ type: "ok", added, skipped, hosted: hosted.has(req.id) }, true);
    }
    if (req.op === "cancel") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      if (!hosted.has(req.id) && b.readReport()) return send({ type: "ok", cancelled: false, finished: true }, true);
      b.requestCancel({ reason: "operator" });
      return send({ type: "ok", cancelled: true, hosted: hosted.has(req.id) }, true);
    }
    const sub = (m) => send(m, m.type === "done" || m.type === "error");
    if (req.op === "submit") {
      const ent = await host({ argv: req.argv ?? [], cwd: req.cwd ?? process.cwd(), env: req.env ?? {} }, sub);
      return send({ type: "batch", id: ent.id, dir: ent.dir });
    }
    if (req.op === "attach") {
      const live = hosted.get(req.id);
      if (live) {
        // Synchronous read + subscribe: no row is lost or doubled between the replay and the live stream.
        for (const row of openBatch(root, req.id).readLog()) send({ type: "row", row, replay: true });
        live.subs.add(sub);
        return send({ type: "batch", id: live.id, dir: live.dir });
      }
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const rep = b.readReport();
      if (rep && !(rep.rows ?? []).some((r) => r.outcome === "held") && !b.unrunAdds().length) {
        return send({ type: "done", replay: true, result: { rows: rep.rows ?? [], crossLane: rep.crossLane ?? [], batch: b.id, ok: !!rep.ok }, report: rep.report ?? null }, true);
      }
      const ent = await host({ argv: ["--resume", req.id], cwd: process.cwd(), env: {} }, sub);
      return send({ type: "batch", id: ent.id, dir: ent.dir });
    }
    throw new Error(`unknown op ${JSON.stringify(req.op)}`);
  };

  const server = createServer((conn) => {
    conns.add(conn);
    touch();
    let buf = "", seen = false, ended = false;
    const send = (m, last = false) => {
      if (ended || conn.destroyed) return;
      conn.write(JSON.stringify(m) + "\n");
      if (last) { ended = true; conn.end(); }
    };
    conn.on("error", () => { /* a client went away */ });
    conn.on("close", () => { conns.delete(conn); ended = true; touch(); });
    conn.on("data", (d) => {
      if (seen) return;
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      seen = true;
      let req;
      try { req = JSON.parse(buf.slice(0, i)); } catch { return send({ type: "error", message: "bad request" }, true); }
      handle(req, send).catch((e) => send({ type: "error", message: e?.message ?? String(e) }, true));
    });
  });
  await new Promise((res, rej) => { server.once("error", rej); server.listen(p.sock, () => { server.off("error", rej); res(); }); });
  log(`schedd: pid ${pid} listening on ${p.sock}`);

  const closed = new Promise((r) => { resolveClosed = r; });
  const close = () => {
    if (closing) return closing;
    clearInterval(idleTimer);
    for (const c of conns) c.destroy();
    const stopping = [...runs.keys()];
    for (const ac of runs.values()) ac.abort();
    let timer;
    // #4454: the lock goes only once every hosted batch loop has stopped (or `stopMs` passed: the caller exits regardless)
    const stopped = stopping.length ? Promise.race([Promise.allSettled(stopping).then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), stopMs); })])
      .then((ok) => { clearTimeout(timer); if (!ok) log(`schedd: ${runs.size} batch(es) did not stop within ${stopMs} ms`); }) : Promise.resolve();
    closing = Promise.all([new Promise((r) => server.close(() => r())), stopped]).then(() => {
      try { if (parseInt(readFileSync(p.lock, "utf8"), 10) === pid) rmSync(p.lock, { force: true }); } catch { /* gone */ }
      rmSync(p.sock, { force: true });
      resolveClosed();
    });
    return closing;
  };
  const idleTimer = setInterval(() => {
    if (!hosted.size && !conns.size && Date.now() - lastActive >= idleMs) { log("schedd: idle, exiting"); close(); }
  }, Math.min(idleMs, 30_000));
  idleTimer.unref?.();

  // Daemon restart: resume every daemon-hosted batch that never wrote its report; live lanes are re-adopted.
  if (resumeOnStart) {
    for (const id of listBatches(root)) {
      const b = openBatch(root, id);
      if (!b.readPlan()?.daemon || b.readReport()) continue;
      log(`schedd: resuming batch ${id}`);
      host({ argv: ["--resume", id], cwd: process.cwd(), env: {}, keepBreaker: true }).catch((e) => log(`schedd: resume ${id} failed: ${e?.message ?? e}`));
    }
  }
  return { running: true, pid, sock: p.sock, close, closed };
}

/** #4454: on SIGTERM/SIGINT stop the daemon (`close()`: batch loops first, then lock and socket), then exit 128+signo, once. */
export function exitOnSignals(d, { on = (s, f) => process.once(s, f), exit = (c) => process.exit(c), signals = ["SIGTERM", "SIGINT"] } = {}) {
  const SIGNO = { SIGINT: 2, SIGTERM: 15 };
  let fired = false;
  for (const sig of signals) on(sig, async () => {
    if (fired) return;
    fired = true;
    try { await d.close(); } catch { /* exit anyway */ }
    exit(128 + (SIGNO[sig] ?? 0));
  });
}

/** Connect to the daemon, spawning it (`spawnDaemon()`) when nobody listens. @returns {Promise<import("node:net").Socket>} */
export async function connectDaemon({ dir = schedDir(), spawnDaemon = defaultSpawn, waitMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { sock } = scheddPaths(dir);
  const tryConnect = () => new Promise((res, rej) => {
    const c = createConnection(sock);
    c.once("connect", () => { c.off("error", rej); res(c); });
    c.once("error", rej);
  });
  try { return await tryConnect(); } catch (e) { if (!["ENOENT", "ECONNREFUSED"].includes(e?.code) || !spawnDaemon) throw e; }
  spawnDaemon({ dir });
  const end = Date.now() + waitMs;
  for (;;) {
    await sleep(100);
    try { return await tryConnect(); } catch (e) { if (Date.now() > end) throw new Error(`schedd did not start within ${waitMs} ms (see ${scheddPaths(dir).log}): ${e?.message ?? e}`); }
  }
}

/** `forgedock schedd` in its own session, output to `schedd.log`. */
export function defaultSpawn({ dir = schedDir(), script = new URL("../forgedock.mjs", import.meta.url).pathname, env = process.env } = {}) {
  mkdirSync(dir, { recursive: true });
  const out = openSync(scheddPaths(dir).log, "a");
  try {
    const child = spawn(process.execPath, [script, "schedd"], { env, detached: true, stdio: ["ignore", out, out] });
    child.on?.("error", () => { /* the connect retry reports it */ });
    child.unref?.();
  } finally { closeSync(out); }
}

/**
 * Send one request and feed every reply to `onMsg`. Resolves with the last message (`done`, `ok`, `status`), rejects on
 * `error` or when the daemon closes the stream first.
 */
export function request(sock, msg, onMsg = () => {}) {
  return new Promise((resolve, reject) => {
    let buf = "", last = null, settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        last = m;
        if (m.type === "error") return finish(reject, new Error(m.message));
        onMsg(m);
        if (["done", "ok", "status"].includes(m.type)) { sock.end(); return finish(resolve, m); }
      }
    });
    sock.on("error", (e) => finish(reject, e));
    sock.on("close", () => finish(reject, Object.assign(new Error("schedd closed the connection before the batch finished"), { last })));
    sock.write(JSON.stringify(msg) + "\n");
  });
}

export const scheddExists = (dir = schedDir()) => existsSync(scheddPaths(dir).sock);

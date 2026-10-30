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
 *   {op:"attach", id, resume?}    → (`resume` also clears a pending cancel, #4592) log.jsonl rows replayed, then live rows/lines and done; a finished batch replays report.json
 *                                   ({type:"done", replay:true}) unless it has unrun added issues; a batch nobody hosts is resumed here
 *   {op:"set-parallel", id, k}    → {type:"ok", parallel}
 *   {op:"requeue", id, issues, reason, by} → {type:"ok", requeued, refused, hosted, reopened} (#4550): see batch.requeue; a finished batch is hosted again
 *   {op:"add", id, issues}        → {type:"ok", added, skipped, hosted} (#4408): merged into the batch's `add` file, which a
 *                                   hosted runner reads on its next pass and an unhosted batch on its next resume
 *   {op:"cancel", id, stopRemote?}           → {type:"ok", cancelled:true, hosted} (#4376): writes the batch's `cancel` file; that batch
 *                                   admits nothing more, its running local lanes get SIGTERM (their teardown saves the work)
 *                                   and the rest end held; no other batch and not the daemon. A finished, unhosted batch:
 *                                   {type:"ok", cancelled:false, finished:true}, nothing written
 *   {op:"hold"|"release", id, issues} → {type:"ok", changed, hosted} (#4592): merges into / removes from the batch's `hold` file; a hosted
 *                                   runner admits no held issue from its next pass (running lanes are not stopped)
 *   {op:"status"}                 → {type:"status", pid, lastTick, batches:[{id, running}]} (#4780: `lastTick` = epoch ms of the last heartbeat; see schedd-health.mjs)
 * Failures answer {type:"error", message}. A client closing its connection never cancels a batch (only `cancel` stops one), and stopping the daemon
 * never stops a lane (lanes are detached sessions). On start the daemon resumes every daemon-hosted batch without a
 * report, so live lanes are re-adopted through the batch runner's `adopt`. It exits after `idleMs` with no batch and no client.
 * Shutdown (#4454): `close()` aborts every hosted batch's `signal` (its loop admits nothing more and leaves, lanes keep
 * running, no report is written), waits for them up to `stopMs`, and only then releases `schedd.lock` and the socket, so a
 * daemon started next never resumes a batch this one still dispatches. `exitOnSignals` exits 128+signo after that.
 * Exit reasons (#4503): every exit logs a line: `idle, exiting`, `exiting (<signal>|uncaught: …)`, `lost lock|socket …,
 * exiting` (checked every `lockCheckMs`: the lock no longer holds this pid, or the socket is gone; nothing it does not own
 * is removed), then `exited (code N)`. Taking over a dead owner's lock is logged, so a SIGKILLed daemon leaves a trace.
 * `runBatch({argv, cwd, env, sink, keepBreaker, signal})` is injected (engine-cli `runBatch`); `sink` gets `batch(b)`, `row(r)`, `line(text)`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedDir, pidAlive } from "./sched.mjs";
import { batchRoot, listBatches, openBatch } from "./batch.mjs";
import { HEARTBEAT_MS, writeHeartbeat, clearHeartbeat } from "./schedd-health.mjs";

export const IDLE_MS = 10 * 60 * 1000;
export const STOP_MS = 10 * 1000;
export const LOCK_CHECK_MS = 5 * 1000;
export const DUE_MS = 15 * 60 * 1000; // #4627: how often the due callback (windowed post-deploy monitoring) runs while the daemon is up

export function scheddPaths(dir = schedDir()) {
  return { dir, sock: join(dir, "schedd.sock"), lock: join(dir, "schedd.lock"), log: join(dir, "schedd.log") };
}

// Env keys a batch keeps for its lanes (account selectors, tool paths); persisted in plan.json (#4691). Session-scoped
// `CLAUDE_CODE_*` / `CLAUDE_PID` and `ANTHROPIC_*` are not kept, except the non-secret provider/endpoint/model selectors
// (`CLAUDE_CODE_USE_*`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, ...; #4734); more names come from `orchestration.env_passthrough`.
const ENV_KEEP = /^(PATH|HOME|USER|SHELL|LANG|LC_.*|TMPDIR|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_.*|ANTHROPIC_(BASE_URL|MODEL|SMALL_FAST_MODEL|DEFAULT_.*_MODEL)|FORGEDOCK_.*|GH_.*|GITHUB_.*)$/;
// What the 1.36.0 pin carried (plus FORGEDOCK_*): a key of these families not pinned now is named at submit (#4734).
const LEGACY_PIN = /^(CLAUDE_.*|ANTHROPIC_.*|GH_.*|GITHUB_.*|FORGEDOCK_.*)$/;
const SESSION_SCOPED = /^(CLAUDE_PID|CLAUDE_CODE_(SESSION|MESSAGING|ENTRYPOINT|EXECPATH|SSE).*)$/;
// A secret never rides the allowlist: it resolves at lane start (env, keychain) unless the operator names it as a passthrough.
export const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)/i;
const SESSION_DIR = /(^|\/)(arg0|claude[^/]*)(\/|$)/;

/** A forge.yaml glob (`*` within a segment, `**` across segments, `?`) as an anchored RegExp. */
export function globToRegExp(glob) {
  const re = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}

/** `path` without non-existent dirs, per-session temp dirs (an `arg0`/`claude*` dir under a temp root) and `exclude` glob matches. */
export function sanitizePath(path, { exclude = [], exists = existsSync, tmpRoots = ["/tmp", "/var/tmp", tmpdir(), process.env.TMPDIR] } = {}) {
  const globs = exclude.map(globToRegExp);
  const roots = tmpRoots.filter(Boolean).map((r) => r.replace(/\/+$/, ""));
  const keep = (d) => d && exists(d) && !globs.some((g) => g.test(d.replace(/\/+$/, "")))
    && !(roots.some((r) => d === r || d.startsWith(`${r}/`)) && SESSION_DIR.test(d));
  const seen = new Set();
  return String(path).split(":").filter((d) => keep(d) && !seen.has(d) && seen.add(d)).join(":");
}

/**
 * The allowlisted part of `env`, with PATH sanitised. `passthrough` names extra keys to keep (`orchestration.env_passthrough`,
 * the configured `execution.token_env`); `pathExclude` is `orchestration.path_exclude`. Secret-looking names are dropped unless named.
 */
export function batchEnv(env = process.env, { passthrough = [], pathExclude = [], exists = existsSync, tmpRoots } = {}) {
  const extra = new Set(passthrough);
  const out = Object.fromEntries(Object.entries(env).filter(([k, v]) => typeof v === "string" && (extra.has(k) || (ENV_KEEP.test(k) && !SECRET_ENV.test(k)))));
  if (typeof out.PATH === "string") out.PATH = sanitizePath(out.PATH, { exclude: pathExclude, exists, ...(tmpRoots ? { tmpRoots } : {}) });
  return out;
}

/** Sorted names (never values) of `env` keys the pre-allowlist pin carried that `kept` does not: the lane gets the daemon's value or resolves it at lane start (#4734). */
export function droppedEnv(env = process.env, kept = {}) {
  return Object.keys(env).filter((k) => typeof env[k] === "string" && LEGACY_PIN.test(k) && !SESSION_SCOPED.test(k) && !(k in kept)).sort();
}

/** `env` with secret-looking values redacted (`--show-env`). */
export function redactEnv(env) {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, SECRET_ENV.test(k) ? "<redacted>" : v]));
}

/** `base` without its allowlisted non-secret keys (secret-named ones, e.g. GH_TOKEN, stay from the daemon: never pinned), plus `kept`: an account selector the client did not set never leaks in from the daemon. */
export function mergeEnv(base, kept) {
  const out = Object.fromEntries(Object.entries(base).filter(([k]) => k in kept || !ENV_KEEP.test(k) || SECRET_ENV.test(k)));
  return { ...out, ...kept };
}

/** Take the daemon lock: `{took}` (the dead owner's pid it replaced, or null); null when another live daemon holds it. */
function takeLock(lock, pid, alive) {
  let took = null;
  for (let i = 0; i < 5; i++) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, String(pid)); } finally { closeSync(fd); }
      return { took };
    } catch (e) { if (e?.code !== "EEXIST") throw e; }
    let owner = NaN;
    try { owner = parseInt(readFileSync(lock, "utf8"), 10); } catch { continue; }
    if (Number.isInteger(owner) && owner !== pid && alive(owner)) return null;
    if (Number.isInteger(owner) && owner !== pid) took = owner;
    rmSync(lock, { force: true });
  }
  return null;
}

/**
 * Start the daemon. @returns {Promise<{running:true, pid, close, closed:Promise} | {running:false, owner:number}>}
 */
export async function startDaemon({ dir = schedDir(), runBatch, idleMs = Number(process.env.FORGEDOCK_SCHEDD_IDLE_MS) || IDLE_MS,
  root = batchRoot(), log = (m) => console.log(m), pid = process.pid, alive = pidAlive, resumeOnStart = true, stopMs = STOP_MS,
  lockCheckMs = LOCK_CHECK_MS, due = null, dueMs = Number(process.env.FORGEDOCK_SCHEDD_DUE_MS) || DUE_MS } = {}) {
  const p = scheddPaths(dir);
  mkdirSync(dir, { recursive: true });
  const lock = takeLock(p.lock, pid, alive);
  if (lock?.took) log(`schedd: took over the lock of dead pid ${lock.took} (it exited without a clean shutdown)`);
  if (!lock) {
    let owner = NaN;
    try { owner = parseInt(readFileSync(p.lock, "utf8"), 10); } catch { /* gone */ }
    log(`schedd: already running (pid ${owner})`);
    return { running: false, owner };
  }
  rmSync(p.sock, { force: true });

  const hosted = new Map(); // batch id -> {id, dir, subs:Set<fn>}
  const conns = new Set();
  const runs = new Map(); // every runBatch in flight (hosted or not yet started) -> its AbortController (#4454)
  const starting = new Map(); // batch id -> host() promise of a start-up resume not yet hosted (#4503: an attach waits for it)
  let closing = null, resolveClosed, keepSock = false;
  let lastActive = Date.now();
  const touch = () => { lastActive = Date.now(); };
  let lastTick = Date.now();

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
    if (req.op === "status") return send({ type: "status", pid, lastTick, batches: [...hosted.keys()].map((id) => ({ id, running: true })) }, true);
    if (req.op === "set-parallel") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      b.setParallel(Number(req.k));
      return send({ type: "ok", parallel: Number(req.k) }, true);
    }
    if (req.op === "add") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const { added, skipped, requeued = [] } = b.addIssues(req.issues ?? []);
      // #4687: a re-queued skipped issue reopens a finished, unhosted batch like --requeue does
      const reopen = requeued.length > 0 && !hosted.has(req.id) && !starting.has(req.id);
      if (reopen) await host({ argv: ["--resume", req.id], cwd: process.cwd(), env: {} });
      return send({ type: "ok", added, skipped, requeued, hosted: hosted.has(req.id), reopened: reopen }, true);
    }
    if (req.op === "requeue") {
      // #4550: the runner applies the entries on its next pass; a finished, unhosted batch is reopened (hosted as a resume).
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const { requeued, refused } = b.requeue(req.issues ?? [], { reason: req.reason, by: req.by });
      const reopen = requeued.length > 0 && !hosted.has(req.id) && !starting.has(req.id);
      if (reopen) await host({ argv: ["--resume", req.id], cwd: process.cwd(), env: {} });
      return send({ type: "ok", requeued, refused, hosted: hosted.has(req.id), reopened: reopen }, true);
    }
    if (req.op === "hold" || req.op === "release") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const changed = req.op === "hold" ? b.holdIssues(req.issues ?? []) : b.releaseIssues(req.issues ?? []);
      return send({ type: "ok", changed, hosted: hosted.has(req.id) }, true);
    }
    if (req.op === "cancel") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      if (!hosted.has(req.id) && b.readReport()) return send({ type: "ok", cancelled: false, finished: true }, true);
      b.requestCancel({ reason: "operator", stopRemote: req.stopRemote === true });
      return send({ type: "ok", cancelled: true, hosted: hosted.has(req.id) }, true);
    }
    const sub = (m) => send(m, m.type === "done" || m.type === "error");
    if (req.op === "submit") {
      const ent = await host({ argv: req.argv ?? [], cwd: req.cwd ?? process.cwd(), env: req.env ?? {} }, sub);
      return send({ type: "batch", id: ent.id, dir: ent.dir });
    }
    if (req.op === "attach") {
      if (req.resume) { const rb = openBatch(root, req.id); if (rb.exists()) rb.clearCancel(); } // #4592: the operator's resume continues a cancelled batch the daemon still hosts
      if (!hosted.has(req.id) && starting.has(req.id)) await starting.get(req.id).catch(() => {});
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
      if (rep && !(rep.rows ?? []).some((r) => r.outcome === "held") && !b.unrunAdds().length && !b.unrunRequeues().length) {
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
  // #4780: a heartbeat from the event loop itself; a starved or wedged loop stops it and the watchdog restarts the daemon.
  const beat = () => { lastTick = Date.now(); try { writeHeartbeat({ dir, pid }); } catch { /* a full disk must not stop the daemon */ } };
  beat();
  const beatTimer = setInterval(beat, HEARTBEAT_MS);
  beatTimer.unref?.();

  const closed = new Promise((r) => { resolveClosed = r; });
  const close = () => {
    if (closing) return closing;
    clearInterval(idleTimer);
    clearInterval(lockTimer);
    clearInterval(beatTimer);
    if (dueTimer) clearInterval(dueTimer);
    for (const c of conns) c.destroy();
    const stopping = [...runs.keys()];
    for (const ac of runs.values()) ac.abort();
    let timer;
    // #4454: the lock goes only once every hosted batch loop has stopped (or `stopMs` passed: the caller exits regardless)
    const stopped = stopping.length ? Promise.race([Promise.allSettled(stopping).then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), stopMs); })])
      .then((ok) => { clearTimeout(timer); if (!ok) log(`schedd: ${runs.size} batch(es) did not stop within ${stopMs} ms`); }) : Promise.resolve();
    // A lost lock: the socket path may be the successor's, and closing the server unlinks it (libuv), so leave it unref'd.
    const serverClosed = keepSock ? Promise.resolve(server.unref()) : new Promise((r) => server.close(() => r()));
    closing = Promise.all([serverClosed, stopped]).then(() => {
      try { if (parseInt(readFileSync(p.lock, "utf8"), 10) === pid) rmSync(p.lock, { force: true }); } catch { /* gone */ }
      if (!keepSock) rmSync(p.sock, { force: true });
      if (!keepSock) clearHeartbeat(dir);
      resolveClosed();
    });
    return closing;
  };
  const idleTimer = setInterval(() => {
    if (!hosted.size && !conns.size && Date.now() - lastActive >= idleMs) { log("schedd: idle, exiting"); close(); }
  }, Math.min(idleMs, 30_000));
  idleTimer.unref?.();
  // #4503: a daemon whose lock or socket was taken stops (its batches stay resumable) instead of running unreachable.
  const lockTimer = setInterval(() => {
    if (closing) return;
    let owner = NaN;
    try { owner = parseInt(readFileSync(p.lock, "utf8"), 10); } catch { /* gone */ }
    if (owner !== pid) { keepSock = true; log(`schedd: lost lock (owner ${Number.isInteger(owner) ? `pid ${owner}` : "none"}), exiting`); close(); }
    else if (!existsSync(p.sock)) { log(`schedd: lost socket ${p.sock}, exiting`); close(); }
  }, lockCheckMs);
  lockTimer.unref?.();
  // #4627: windowed post-deploy checks. One run at a time; a failure is logged and never stops the daemon.
  let dueRunning = false;
  const dueTimer = due ? setInterval(async () => {
    if (closing || dueRunning) return;
    dueRunning = true;
    try { await due(); } catch (e) { log(`schedd: due run failed: ${e?.message ?? e}`); } finally { dueRunning = false; }
  }, dueMs) : null;
  dueTimer?.unref?.();

  // Daemon restart: resume every daemon-hosted batch that never wrote its report; live lanes are re-adopted.
  if (resumeOnStart) {
    for (const id of listBatches(root)) {
      const b = openBatch(root, id);
      if (!b.readPlan()?.daemon || b.readReport()) continue;
      log(`schedd: resuming batch ${id}`);
      const started = host({ argv: ["--resume", id], cwd: process.cwd(), env: {}, keepBreaker: true });
      starting.set(id, started);
      started.catch((e) => log(`schedd: resume ${id} failed: ${e?.message ?? e}`)).finally(() => starting.delete(id));
    }
  }
  return { running: true, pid, sock: p.sock, close, closed };
}

/**
 * #4454: on SIGTERM/SIGINT/SIGHUP stop the daemon (`close()`: batch loops first, then lock and socket), then exit 128+signo,
 * once; an uncaught exception or unhandled rejection does the same and exits 1. #4503: each logs its reason first, and the
 * process `exit` logs `schedd: exited (code N)`.
 */
export function exitOnSignals(d, { on = (s, f) => (s.startsWith("SIG") || s === "exit" ? process.once(s, f) : process.on(s, f)),
  exit = (c) => process.exit(c), log = (m) => console.log(m), signals = ["SIGTERM", "SIGINT", "SIGHUP"] } = {}) {
  const SIGNO = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  let fired = false;
  const stop = async (reason, code, detail = null) => {
    if (fired) return;
    fired = true;
    log(`schedd: exiting (${reason})`);
    if (detail) log(detail);
    try { await d.close(); } catch { /* exit anyway */ }
    exit(code);
  };
  for (const sig of signals) on(sig, () => stop(sig, 128 + (SIGNO[sig] ?? 0)));
  on("uncaughtException", (e) => stop(`uncaught: ${String(e?.message ?? e).split("\n")[0]}`, 1, e?.stack ?? null));
  on("unhandledRejection", (e) => stop(`unhandled rejection: ${String(e?.message ?? e).split("\n")[0]}`, 1, e?.stack ?? null));
  on("exit", (code) => log(`schedd: exited (code ${code})`));
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

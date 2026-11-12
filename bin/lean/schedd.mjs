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
 *   {op:"set-execution", id, maxRemote?, mode?} → {type:"ok", execution} (#5138): live max_remote / placement (remote|hybrid|local); remote/hybrid refused for a batch with no provider
 *   {op:"requeue", id, issues, reason, by} → {type:"ok", requeued, refused, hosted, reopened} (#4550): see batch.requeue; a finished batch is hosted again
 *   {op:"add", id, issues}        → {type:"ok", added, skipped, hosted} (#4408): merged into the batch's `add` file, which a
 *                                   hosted runner reads on its next pass and an unhosted batch on its next resume
 *   {op:"cancel", id, stopRemote?}           → {type:"ok", cancelled:true, hosted} (#4376): writes the batch's `cancel` file; that batch
 *                                   admits nothing more, its running local lanes get SIGTERM (their teardown saves the work)
 *                                   and the rest end held; no other batch and not the daemon. A finished, unhosted batch:
 *                                   {type:"ok", cancelled:false, finished:true}, nothing written
 *   {op:"hold"|"release", id, issues} → {type:"ok", changed, hosted} (#4592): merges into / removes from the batch's `hold` file; a hosted
 *                                   runner admits no held issue from its next pass (running lanes are not stopped)
 *   {op:"status"}                 → {type:"status", pid, lastTick, batches:[{id, running, lastProgressAt, lastProgressAgeSec, pendingAdds}], unhosted, host} (#4775: also an unhosted batch with pending adds;
 *                                   #5174: host = hostload.mjs snapshot {overloaded, load1, cores, perCore, threshold} from the
 *                                   `hostLoad` probe, null when it throws)
 * Failures answer {type:"error", message}. A client closing its connection never cancels a batch (only `cancel` stops one), and stopping the daemon
 * never stops a lane (lanes are detached sessions). On start the daemon resumes every daemon-hosted batch without a
 * report, so live lanes are re-adopted through the batch runner's `adopt`. It exits after `idleMs` with no batch and no client.
 * Shutdown (#4454): `close()` aborts every hosted batch's `signal` (its loop admits nothing more and leaves, lanes keep
 * running, no report is written), waits for them up to `stopMs`, and only then releases `schedd.lock` and the socket, so a
 * daemon started next never resumes a batch this one still dispatches. `exitOnSignals` exits 128+signo after that.
 * Exit reasons (#4503): every exit logs a line: `idle, exiting`, `exiting (<signal>|uncaught: …)`, `lost lock|socket …,
 * exiting` (checked every `lockCheckMs`: the lock no longer holds this pid, or the socket is gone; nothing it does not own
 * is removed), then `exited (code N)`. Taking over a dead owner's lock is logged, so a SIGKILLed daemon leaves a trace.
 * Upgrade handover (#5204): the same `lockCheckMs` tick compares `installedVersion()` (the `version` of the package.json of
 * this install) with the version loaded at start. When the install moved (`npm i -g`, `forgedock update`) it logs
 * `schedd: install moved v<old> → v<new>; handing over` once, runs `close()` (no admission, lanes keep running, lock and
 * socket released), then `respawn()`: a fresh daemon from the new install when no systemd unit runs it (`Restart=always`
 * restarts an active unit). The new daemon resumes every batch; each lane it cannot adopt is requeued with an
 * `interrupted: upgrade vX→vY` row (orchestrate.mjs).
 * `runBatch({argv, cwd, env, sink, keepBreaker, signal})` is injected (engine-cli `runBatch`); `sink` gets `batch(b)`, `row(r)`, `line(text)`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schedDir, pidAlive } from "./sched.mjs";
import { DEFAULT_STALL_MIN, FIRST_HOUR_FILE, FIRST_HOUR_MIN, evaluateDispatchStall, firstHourReport, recordStallAlert, writeFirstHour } from "./batch-health.mjs";
import { HEARTBEAT_MS, writeHeartbeat, clearHeartbeat } from "./schedd-health.mjs";
import { batchRoot, listBatches, openBatch, SECRET_ENV } from "./batch.mjs";
import { killTrackedChildren } from "./effects.mjs";
import { applySetExecution } from "./live-execution.mjs";
import { liveOverload } from "./hostload.mjs";

/** #5471: `schedd status` warning lines for issues pending in two or more hosted batches. */
export function sharedPendingLines(batches) {
  const shared = new Map();
  for (const b of batches ?? []) if (b.running) for (const n of b.pending ?? []) shared.set(n, [...(shared.get(n) ?? []), b.id]);
  return [...shared].filter(([, ids]) => ids.length > 1).map(([n, ids]) => `schedd: warning: #${n} is pending in ${ids.length} batches (${ids.join(", ")}); only one should run it`);
}

export const IDLE_MS = 10 * 60 * 1000;
export const STOP_MS = 10 * 1000;
export const LOCK_CHECK_MS = 5 * 1000;
export const ADMIT_MS = 120 * 1000; // #4775: how long one add/requeue/attach/resume waits for its batch to start before answering an error
export const LAG_MS = 5 * 1000; // #4775: an event-loop stall longer than this is logged
export const REQUEST_MS = 15 * 1000; // #4775: default bound of a control/status request
/**
 * #5469: the unhosted batches of `root` that still have pending issues and are not cancelled, split by idle time:
 * `orphaned` (no progress for `minAgeMs`) and `unhosted` (recent). @returns {{unhosted: Array<{id, pending}>, orphaned: Array<{id, pending}>}}
 */
export function findUnhosted(root, { isHosted = () => false, now = Date.now(), minAgeMs = ORPHAN_AGE_MS } = {}) {
  const unhosted = [], orphaned = [];
  for (const id of listBatches(root)) classifyUnhosted(root, id, { isHosted, now, minAgeMs, unhosted, orphaned });
  return { unhosted, orphaned };
}
function classifyUnhosted(root, id, { isHosted, now, minAgeMs, unhosted, orphaned }) {
  if (isHosted(id)) return;
  try {
    const b = openBatch(root, id), pending = b.pendingIssues();
    if (!pending.length || b.readCancel()) return;
    const last = b.lastProgressMs();
    (last !== null && now - last > minAgeMs ? orphaned : unhosted).push({ id, pending });
  } catch { /* advisory */ }
}
export const yieldLoop = () => new Promise((r) => setImmediate(r));
/** #5531: `findUnhosted` that yields to the event loop after every batch, so a long history never occupies one loop turn. */
export async function findUnhostedAsync(root, { isHosted = () => false, now = Date.now(), minAgeMs = ORPHAN_AGE_MS } = {}) {
  const unhosted = [], orphaned = [];
  for (const id of listBatches(root)) { classifyUnhosted(root, id, { isHosted, now, minAgeMs, unhosted, orphaned }); await yieldLoop(); }
  return { unhosted, orphaned };
}
export const ABANDON_AGE_MS = 14 * 24 * 3600 * 1000; // #5531: an unhosted batch with pending issues and no progress for this long is re-hosted (when ready) or abandoned
export const ORPHAN_AGE_MS = 7 * 24 * 3600 * 1000; // #5469: an unhosted batch idle this long with pending issues is orphaned
export const UNIT = "forgedock-schedd";
export const DUE_MS = 15 * 60 * 1000; // #4627: how often the due callback (windowed post-deploy monitoring) runs while the daemon is up

/** #4762: win32 `net` servers only accept named pipes, so the socket is a per-dir pipe there (it vanishes with its server). */
export function scheddPaths(dir = schedDir(), platform = process.platform) {
  const sock = platform === "win32" ? `\\\\.\\pipe\\forgedock-schedd-${createHash("sha1").update(resolve(dir)).digest("hex").slice(0, 12)}` : join(dir, "schedd.sock");
  return { dir, sock, lock: join(dir, "schedd.lock"), log: join(dir, "schedd.log") };
}

// Env keys a batch keeps for its lanes (account selectors, tool paths); persisted in plan.json (#4691). Session-scoped
// `CLAUDE_CODE_*` / `CLAUDE_PID` and `ANTHROPIC_*` are not kept, except the non-secret provider/endpoint/model selectors
// (`CLAUDE_CODE_USE_*`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, ...; #4734); more names come from `orchestration.env_passthrough`.
const ENV_KEEP = /^(PATH|HOME|USER|SHELL|LANG|LC_.*|TMPDIR|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_.*|ANTHROPIC_(BASE_URL|MODEL|SMALL_FAST_MODEL|DEFAULT_.*_MODEL)|FORGEDOCK_.*|GH_.*|GITHUB_.*)$/;
// What the 1.36.0 pin carried (plus FORGEDOCK_*): a key of these families not pinned now is named at submit (#4734).
const LEGACY_PIN = /^(CLAUDE_.*|ANTHROPIC_.*|GH_.*|GITHUB_.*|FORGEDOCK_.*)$/;
const SESSION_SCOPED = /^(CLAUDE_PID|CLAUDE_CODE_(SESSION|MESSAGING|ENTRYPOINT|EXECPATH|SSE).*)$/;
// A secret never rides the allowlist: it resolves at lane start (env, keychain) unless the operator names it as a passthrough.
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
 * An empty value is never pinned, passthrough keys included (#5131: an empty pin would mask the daemon's secret).
 */
export function batchEnv(env = process.env, { passthrough = [], pathExclude = [], exists = existsSync, tmpRoots } = {}) {
  const extra = new Set(passthrough);
  const out = Object.fromEntries(Object.entries(env).filter(([k, v]) => typeof v === "string" && v !== "" && (extra.has(k) || (ENV_KEEP.test(k) && !SECRET_ENV.test(k)))));
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

/**
 * `base` without its allowlisted non-secret keys, plus `kept`: an account selector the client did not set never leaks in from
 * the daemon, and a pinned key wins. A secret-named key is only pinned when named (`env_passthrough`, `token_env`): a non-empty
 * pin wins, as before #5131 (the operator chose that account); an empty secret pin never overrides the daemon's value (#5131).
 */
export function mergeEnv(base, kept) {
  const out = Object.fromEntries(Object.entries(base).filter(([k]) => k in kept || !ENV_KEEP.test(k) || SECRET_ENV.test(k)));
  for (const [k, v] of Object.entries(kept)) {
    if (!SECRET_ENV.test(k) || (typeof v === "string" && v !== "")) out[k] = v;
  }
  return out;
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
  lockCheckMs = LOCK_CHECK_MS, admitMs = Number(process.env.FORGEDOCK_SCHEDD_ADMIT_MS) || ADMIT_MS, lagMs = LAG_MS, stallCheckMs = Number(process.env.FORGEDOCK_SCHEDD_STALL_CHECK_MS) || 60_000, stallMin = Number(process.env.FORGEDOCK_SCHEDD_STALL_MIN) || DEFAULT_STALL_MIN, due = null, dueMs = Number(process.env.FORGEDOCK_SCHEDD_DUE_MS) || DUE_MS, preflight = null,
  abandonMs = (Number(process.env.FORGEDOCK_SCHEDD_ABANDON_DAYS) > 0 ? Number(process.env.FORGEDOCK_SCHEDD_ABANDON_DAYS) * 24 * 3600 * 1000 : ABANDON_AGE_MS), killChildren = killTrackedChildren,
  hostLoad = liveOverload(), installedVersion = readInstalledVersion, respawn = undefined } = {}) {
  const p = scheddPaths(dir);
  // #5204: default handover target: a new daemon from the (new) install unless systemd restarts the unit itself
  const respawnFn = respawn !== undefined ? respawn : () => { if (!["active", "activating"].includes(unitState())) defaultSpawn({ dir }); };
  mkdirSync(dir, { recursive: true });
  const lock = takeLock(p.lock, pid, alive);
  if (lock?.took) log(`schedd: took over the lock of dead pid ${lock.took} (it exited without a clean shutdown)`);
  if (!lock) {
    let owner = NaN;
    try { owner = parseInt(readFileSync(p.lock, "utf8"), 10); } catch { /* gone */ }
    log(`schedd: already running (pid ${owner})`);
    return { running: false, owner };
  }
  if (process.platform !== "win32") rmSync(p.sock, { force: true });

  const hosted = new Map(); // batch id -> {id, dir, subs:Set<fn>}
  const conns = new Set();
  const runs = new Map(); // every runBatch in flight (hosted or not yet started) -> its AbortController (#4454)
  const starting = new Map(); // batch id -> host() promise of a start-up resume not yet hosted (#4503: an attach waits for it)
  let closing = null, resolveClosed, keepSock = false;
  let lastActive = Date.now();
  const touch = () => { lastActive = Date.now(); };
  let lastTick = Date.now();
  let lastPhase = { name: "idle", at: Date.now() };
  const phase = (name) => { lastPhase = { name, at: Date.now() }; };
  const abandoned = new Set(); // #5531: batches this daemon abandoned (reported once; the batch carries a cancel file with reason "abandoned")

  /** Run one batch here. Resolves with {id, dir} once the batch exists, rejects when it fails before that. */
  const host = ({ argv, cwd, env, keepBreaker = false }, first = null) => new Promise((resolve, reject) => {
    if (closing) return reject(new Error("schedd is shutting down"));
    const ac = new AbortController();
    const ent = { id: null, dir: null, subs: new Set(first ? [first] : []) };
    const emit = (m) => { for (const s of ent.subs) s(m); };
    let started = false, endedClean = false;
    const sink = {
      batch: (b) => { ent.id = b.id; ent.dir = b.dir; hosted.set(b.id, ent); started = true; resolve(ent); },
      row: (row) => emit({ type: "row", row }),
      line: (text) => emit({ type: "line", text }),
    };
    touch();
    const run = Promise.resolve().then(() => runBatch({ argv, cwd, env, sink, keepBreaker, signal: ac.signal })).then((result) => {
      const report = ent.dir ? openBatch(root, ent.id).readReport()?.report ?? null : null;
      emit({ type: "done", result, report });
      if (ent.id) { rehostLater(ent.id); endedClean = true; } // #4917
    }, (e) => {
      const message = e?.message ?? String(e);
      if (e?.code === "batch.stopped") { log(`schedd: batch ${ent.id ?? argv.join(" ")} stopped (lanes keep running; resumed by the next daemon)`); if (!started) reject(new Error(message)); return; }
      if (!started) reject(new Error(message)); else { log(`schedd: batch ${ent.id} failed: ${message}`); emit({ type: "error", message }); }
    }).finally(() => { if (ent.id) hosted.delete(ent.id); ent.subs.clear(); runs.delete(run); touch(); if (ent.id && endedClean) rehostUnrun(ent.id); });
    runs.set(run, ac);
  });

  // #4917: a batch that ended with a deferred issue still waiting (no report) is re-hosted once its retry-at is near, without a restart
  const rehostTimers = new Set();
  const rehostLater = (id) => {
    if (closing) return;
    let b, st;
    try { b = openBatch(root, id); if (b.readReport() || b.readCancel() || !b.pendingIssues().length) return; st = b.store.load(); } catch { return; }
    if (st?.breaker && !st.breaker.transport) return; // a tripped breaker holds the batch for an operator --resume (a re-host would stop again at once)
    const at = Math.min(...b.pendingIssues().map((n) => Number(st?.notBefore?.[n]) || Infinity));
    if (!Number.isFinite(at)) return; // nothing waits on the clock: a deliberate hold stays for --resume
    if (at <= Date.now()) return; // the run that just ended already saw this retry-at pass and did not admit: re-hosting would loop every second
    const t = setTimeout(() => {
      rehostTimers.delete(t);
      if (closing || hosted.has(id) || starting.has(id)) return;
      log(`schedd: re-hosting batch ${id} (pending issues waiting on a retry)`);
      const started = host({ argv: ["--resume", id], cwd: process.cwd(), env: {}, keepBreaker: true });
      starting.set(id, started);
      started.catch((e) => log(`schedd: re-host ${id} failed: ${e?.message ?? e}`)).finally(() => starting.delete(id));
    }, Math.min(60_000, Math.max(1000, at - Date.now())));
    t.unref?.();
    rehostTimers.add(t);
  };

  // #5242: an add/requeue that landed while the runner was past its dispatch loop (still "hosted", no longer draining) is
  // dispatched by re-hosting the batch once the run has ended. Once per distinct set of unrun entries, so an add that cannot
  // drain (a cancel, a tripped breaker) never loops.
  const rehostedUnrun = new Map();
  const rehostUnrun = (id) => {
    if (closing || hosted.has(id) || starting.has(id)) return;
    let sig;
    try {
      const b = openBatch(root, id);
      if (b.readCancel()) return;
      const st = b.store.load();
      if (st?.breaker && !st.breaker.transport) return;
      sig = JSON.stringify([b.unrunAdds(), b.unrunRequeues().map((e) => e.issue ?? e)]);
      if (!b.unrunAdds().length && !b.unrunRequeues().length) { rehostedUnrun.delete(id); return; }
    } catch { return; }
    if (rehostedUnrun.get(id) === sig) return;
    rehostedUnrun.set(id, sig);
    log(`schedd: re-hosting batch ${id} (an add or requeue arrived after its runner stopped draining)`);
    const started = host({ argv: ["--resume", id], cwd: process.cwd(), env: {}, keepBreaker: true });
    starting.set(id, started);
    started.catch((e) => log(`schedd: re-host ${id} failed: ${e?.message ?? e}`)).finally(() => starting.delete(id));
  };

  /** #4775: wait for a batch start at most `admitMs`; the start itself goes on (a second host() would duplicate the batch). */
  const bound = (p, what) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not start within ${admitMs} ms (schedd is busy; retry)`)), admitMs); t.unref?.(); })]).finally(() => clearTimeout(t));
  };
  const hostBounded = (args, first = null, what = "batch") => bound(host(args, first), what);

  /** #4775: per batch id, last progress and pending adds: every hosted batch, plus any daemon batch holding adds it never took. */
  const statusBatches = async () => {
    const now = Date.now(), out = [];
    const ids = new Set(hosted.keys());
    for (const id of starting.keys()) ids.add(id);
    try { for (const id of listBatches(root)) { if (!ids.has(id)) { const b = openBatch(root, id); if (!b.isTerminal() && b.readPlan()?.daemon) ids.add(id); await yieldLoop(); } } } catch { /* unreadable root */ }
    for (const id of [...ids].sort()) {
      await yieldLoop();
      const isHosted = hosted.has(id) || starting.has(id);
      let last = null, pending = [], pend = [];
      try { const b = openBatch(root, id); last = b.lastProgressMs(); pending = b.unrunAdds(); pend = b.pendingIssues(); } catch { /* a half-written batch */ }
      if (!isHosted && !pending.length) continue;
      out.push({ id, running: isHosted, lastProgressAt: last === null ? null : new Date(last).toISOString(), lastProgressAgeSec: last === null ? null : Math.max(0, Math.round((now - last) / 1000)), pendingAdds: pending, pending: pend });
    }
    return out;
  };

  const unhostedBatches = (now, minAgeMs = ORPHAN_AGE_MS) => findUnhostedAsync(root, { isHosted: (id) => hosted.has(id) || starting.has(id), now, minAgeMs });

  const handle = async (req, send) => {
    if (req.op === "status") {
      // #4917: a batch dir that still holds pending issues but is not hosted (finalised early, or never resumed)
      // #5469: ones idle longer than ORPHAN_AGE_MS collapse into `orphaned` (one line; `orchestrate --gc-orphans` cancels them)
      phase("status");
      const { unhosted, orphaned } = await unhostedBatches(Date.now());
      let host = null; try { host = hostLoad?.() ?? null; } catch { host = null; } // #5174
      return send({ type: "status", pid, lastTick, batches: await statusBatches(), unhosted, orphaned, abandoned: [...abandoned], host }, true);
    }
    if (req.op === "set-parallel") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      b.setParallel(Number(req.k));
      return send({ type: "ok", parallel: Number(req.k) }, true);
    }
    if (req.op === "set-execution") {
      // #5138: live max_remote / placement mode; the hosted runner re-reads the batch's `execution` file on every admission.
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const execution = applySetExecution(b, { ...(req.maxRemote !== undefined ? { maxRemote: req.maxRemote } : {}), ...(req.mode !== undefined ? { mode: req.mode } : {}) });
      return send({ type: "ok", execution }, true);
    }
    if (req.op === "add") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const { added, skipped, requeued = [] } = b.addIssues(req.issues ?? []);
      // #4687/#5000/#4917: a re-queued skipped issue or a newly added one reopens a finished, unhosted batch like --requeue does
      const reopen = (added.length > 0 || requeued.length > 0 || b.unrunAdds().length > 0 || b.unrunRequeues().length > 0) && !hosted.has(req.id) && !starting.has(req.id);
      if (reopen) await hostBounded({ argv: ["--resume", req.id], cwd: process.cwd(), env: {} }, null, `batch ${req.id}`);
      return send({ type: "ok", added, skipped, requeued, hosted: hosted.has(req.id), reopened: reopen }, true);
    }
    if (req.op === "requeue") {
      // #4550: the runner applies the entries on its next pass; a finished, unhosted batch is reopened (hosted as a resume).
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const { requeued, refused } = b.requeue(req.issues ?? [], { reason: req.reason, by: req.by });
      // #4917: a refused repeat requeue still reopens when an earlier entry was never applied
      const reopen = (requeued.length > 0 || b.unrunRequeues().length > 0) && !hosted.has(req.id) && !starting.has(req.id);
      if (reopen) await hostBounded({ argv: ["--resume", req.id], cwd: process.cwd(), env: {} }, null, `batch ${req.id}`);
      return send({ type: "ok", requeued, refused, hosted: hosted.has(req.id), reopened: reopen }, true);
    }
    if (req.op === "hold" || req.op === "release") {
      const b = openBatch(root, req.id);
      if (!b.exists()) throw new Error(`no batch ${req.id} in ${root}`);
      const changed = req.op === "hold" ? b.holdIssues(req.issues ?? [], req.meta ?? null) : b.releaseIssues(req.issues ?? []);
      return send({ type: "ok", changed, held: b.readHeld(), hosted: hosted.has(req.id) }, true);
    }
    if (req.op === "gc-orphans") { // #5469: cancel every orphaned batch (unhosted, pending issues, idle past the threshold)
      const { orphaned } = unhostedBatches(Date.now(), Number.isFinite(req.minAgeMs) ? req.minAgeMs : ORPHAN_AGE_MS);
      for (const o of orphaned) openBatch(root, o.id).requestCancel({ reason: "gc-orphans" });
      return send({ type: "ok", cancelled: orphaned.map((o) => o.id) }, true);
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
      if (!hosted.has(req.id) && starting.has(req.id)) await bound(starting.get(req.id), `batch ${req.id}`).catch((e) => { if (/did not start within/.test(e?.message)) throw e; });
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
      const ent = await hostBounded({ argv: ["--resume", req.id], cwd: process.cwd(), env: {} }, sub, `batch ${req.id}`);
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
  const beat = () => { lastTick = Date.now(); try { writeHeartbeat({ dir, pid, now: () => lastTick }); } catch { /* a full disk must not stop the daemon */ } };
  beat();
  const beatTimer = setInterval(beat, HEARTBEAT_MS);
  beatTimer.unref?.();

  const closed = new Promise((r) => { resolveClosed = r; });
  const close = () => {
    if (closing) return closing;
    clearInterval(idleTimer);
    clearInterval(lockTimer);
    clearInterval(lagTimer);
    clearInterval(stallTimer);
    clearInterval(beatTimer);
    for (const t of rehostTimers) clearTimeout(t);
    if (dueTimer) clearInterval(dueTimer);
    for (const c of conns) c.destroy();
    try { const n = killChildren?.(); if (n) log(`schedd: killed ${n} child process(es) of its own`); } catch { /* best effort */ } // #5531: lanes survive, the daemon's own gh/script children do not
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
      if (!keepSock && process.platform !== "win32") rmSync(p.sock, { force: true });
      if (!keepSock) clearHeartbeat(dir);
      resolveClosed();
    });
    return closing;
  };
  const idleTimer = setInterval(() => {
    if (!hosted.size && !conns.size && Date.now() - lastActive >= idleMs) { log("schedd: idle, exiting"); close(); }
  }, Math.min(idleMs, 30_000));
  idleTimer.unref?.();
  // #5204: the version this daemon runs; an install that moves under it hands over on the next tick.
  const versionOf = () => { try { return installedVersion?.() ?? null; } catch { return null; } };
  const loadedVersion = versionOf();
  // #4503: a daemon whose lock or socket was taken stops (its batches stay resumable) instead of running unreachable.
  const lockTimer = setInterval(() => {
    if (closing) return;
    const now = loadedVersion ? versionOf() : null;
    if (now && now !== loadedVersion) {
      log(`schedd: install moved v${loadedVersion} → v${now}; handing over`);
      close().then(() => { try { respawnFn?.(); } catch (e) { log(`schedd: respawn failed: ${e?.message ?? e}`); } });
      return;
    }
    let owner = NaN;
    try { owner = parseInt(readFileSync(p.lock, "utf8"), 10); } catch { /* gone */ }
    if (owner !== pid) { keepSock = true; log(`schedd: lost lock (owner ${Number.isInteger(owner) ? `pid ${owner}` : "none"}), exiting`); close(); }
    else if (process.platform !== "win32" && !existsSync(p.sock)) { log(`schedd: lost socket ${p.sock}, exiting`); close(); }
  }, lockCheckMs);
  lockTimer.unref?.();
  // #4775: an event loop starved by host load leaves sockets unanswered and children unreaped; leave a trace of it.
  let lagAt = Date.now(), lagLogged = 0;
  const lagTimer = setInterval(() => {
    const now = Date.now(), lag = now - lagAt - 1000;
    lagAt = now;
    if (lag >= lagMs && now - lagLogged >= 60_000) { lagLogged = now; log(`schedd: event loop stalled ${Math.round(lag / 1000)}s (host overloaded?; last phase: ${lastPhase.name}, started ${Math.round((now - lastPhase.at) / 1000)}s ago)`); }
  }, 1000);
  lagTimer.unref?.();
  // #5314: a batch with ready issues, free lanes and no dispatch for `stallMin` is re-hosted once per ready set, else one needs-you
  // alert is recorded (health.json, status, sched show); every batch also gets its first-hour report once, without operator action.
  const rehostedStall = new Map();
  let watching = false;
  const watchBatches = async () => {
    if (closing || watching) return;
    watching = true;
    phase("watch");
    try { await watchPass(); } finally { watching = false; phase("idle"); }
  };
  const watchPass = async () => {
    const now = Date.now();
    for (const id of listBatches(root)) {
      await yieldLoop(); // #5531: one batch per loop turn, so status and dispatch are never starved by a long history
      if (closing) return;
      try {
        const b = openBatch(root, id), plan = b.readPlan();
        if (!plan?.daemon) continue;
        const created = Date.parse(plan.created ?? "");
        if (b.isTerminal() && (!Number.isFinite(created) || now - created >= 24 * 3600_000)) continue; // nothing left to report or re-host
        const reported = !!b.readReport(), cancelled = !!b.readCancel(), state = b.store.peek(), isHosted = hosted.has(id) || starting.has(id);
        const stall = evaluateDispatchStall(state, { held: b.readHeld(), parallel: b.readParallel(), hosted: isHosted, lastProgressMs: b.lastProgressMs(), now, windowMin: stallMin, cancelled, reported });
        if (Number.isFinite(created) && (reported || now - created >= FIRST_HOUR_MIN * 60_000) && !existsSync(join(b.dir, FIRST_HOUR_FILE)) && now - created < 24 * 3600_000) {
          if (writeFirstHour(b, firstHourReport(state, { batchId: id, now, held: b.readHeld(), holdInfo: b.readHoldInfo?.() ?? null, stall }))) log(`schedd: first-hour report written for batch ${id}`);
        }
        const sig = stall ? stall.ready.join(",") : "";
        const last = b.lastProgressMs();
        if (!isHosted && !cancelled && !reported && state?.pending?.length && last !== null && now - last > abandonMs && (!stall || rehostedStall.get(id) === sig)) {
          b.requestCancel({ reason: "abandoned" }); // #5531: idle past N days and not re-hostable: marked once (the cancel file ends the scan for it)
          abandoned.add(id);
          log(`schedd: batch ${id} abandoned (not hosted, ${state.pending.length} pending, no progress for ${Math.round((now - last) / 86400_000)} days)`);
          continue;
        }
        if (!stall) continue;
        if (!isHosted && rehostedStall.get(id) !== sig) {
          rehostedStall.set(id, sig);
          log(`schedd: re-hosting batch ${id} (${stall.detail})`);
          const started = host({ argv: ["--resume", id], cwd: process.cwd(), env: {}, keepBreaker: true });
          starting.set(id, started);
          started.catch((e) => { log(`schedd: re-host ${id} failed: ${e?.message ?? e}`); recordStallAlert(b, stall); }).finally(() => starting.delete(id));
        } else if (recordStallAlert(b, stall)) log(`schedd: batch ${id} needs you: ${stall.detail}`);
      } catch { /* advisory: one unreadable batch never stops the watchdog */ }
    }
  };
  const stallTimer = setInterval(() => { watchBatches().catch(() => {}); }, stallCheckMs);
  stallTimer.unref?.();

  // #4627: windowed post-deploy checks. One run at a time; a failure is logged and never stops the daemon.
  let dueRunning = false;
  const dueTimer = due ? setInterval(async () => {
    if (closing || dueRunning) return;
    dueRunning = true;
    try { await due(); } catch (e) { log(`schedd: due run failed: ${e?.message ?? e}`); } finally { dueRunning = false; }
  }, dueMs) : null;
  dueTimer?.unref?.();

  // #4866: lane preflight at daemon start: each failing check is logged once with its typed code (batches re-check on every admission pass).
  // Not awaited: gh and pool pings are slow, and startup (resume, socket) must not wait on them.
  if (preflight) Promise.resolve().then(preflight).then((fails) => { for (const f of fails ?? []) log(`schedd: ${f.code}: ${f.detail}`); }).catch(() => { /* advisory */ });

  // #4787: plans written before secrets were dropped still hold token values; scrub them on start.
  for (const id of listBatches(root)) { try { const n = openBatch(root, id).scrubPlan(); if (n.length) log(`schedd: scrubbed ${n.join(", ")} from batch ${id}`); } catch { /* advisory */ } }

  // Daemon restart: resume every daemon-hosted batch that never wrote its report; live lanes are re-adopted.
  if (resumeOnStart) {
    for (const id of listBatches(root)) {
      const b = openBatch(root, id);
      if (!b.readPlan()?.daemon || b.readReport()) continue;
      log(`schedd: resuming batch ${id}`);
      const started = host({ argv: ["--resume", id], cwd: process.cwd(), env: {}, keepBreaker: true });
      starting.set(id, started);
      const stall = setTimeout(() => log(`schedd: batch ${id} has not started after ${admitMs} ms (still resuming; other batches are served)`), admitMs);
      stall.unref?.();
      started.finally(() => clearTimeout(stall)).catch(() => {});
      started.catch((e) => log(`schedd: resume ${id} failed: ${e?.message ?? e}`)).finally(() => starting.delete(id));
    }
  }
  return { running: true, pid, sock: p.sock, close, closed };
}

/** #5204: `version` of the package.json of this install (../../package.json), null when it cannot be read. */
export function readInstalledVersion({ file = fileURLToPath(new URL("../../package.json", import.meta.url)) } = {}) {
  try { return String(JSON.parse(readFileSync(file, "utf8")).version ?? "") || null; } catch { return null; }
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

/**
 * #4775: state of the systemd-user unit (`active`, `activating`, `inactive`, ...), or null when no unit is installed or
 * systemd is not usable here (then a client may spawn the daemon itself).
 */
export function unitState({ unitFile = join(homedir(), ".config", "systemd", "user", `${UNIT}.service`), exists = existsSync, run = execFileSync } = {}) {
  if (!exists(unitFile)) return null;
  try { return String(run("systemctl", ["--user", "is-active", UNIT], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })).trim() || null; }
  catch (e) { return e?.code === "ENOENT" || e?.killed ? null : String(e?.stdout ?? "").trim() || null; } // is-active exits 3 and prints the state when not active
}

/** Start the installed unit (best effort: the connect retry reports a failure). */
export function startUnit({ run = execFileSync } = {}) {
  try { run("systemctl", ["--user", "start", "--no-block", UNIT], { timeout: 5000, stdio: "ignore" }); } catch { /* reported by the connect retry */ }
}

/**
 * Connect to the daemon. When nobody listens it is started: a systemd-managed instance (`unitState()` active, activating
 * or reloading: restarting) is waited for and never raced by a second daemon, an installed but stopped unit is started
 * (`startUnit()`), and only without a unit does `spawnDaemon()` run (#4775). `spawnDaemon: null` never starts anything.
 * @returns {Promise<import("node:net").Socket>}
 */
export async function connectDaemon({ dir = schedDir(), spawnDaemon = defaultSpawn, waitMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  unit = unitState, start = startUnit } = {}) {
  const { sock } = scheddPaths(dir);
  const tryConnect = () => new Promise((res, rej) => {
    const c = createConnection(sock);
    c.once("connect", () => { c.off("error", rej); res(c); });
    c.once("error", rej);
  });
  try { return await tryConnect(); } catch (e) { if (!["ENOENT", "ECONNREFUSED"].includes(e?.code) || !spawnDaemon) throw e; }
  const state = unit();
  if (state === null) spawnDaemon({ dir });
  else if (!["active", "activating", "reloading"].includes(state)) start();
  const end = Date.now() + waitMs;
  for (;;) {
    await sleep(100);
    try { return await tryConnect(); } catch (e) { if (Date.now() > end) throw new Error(`schedd did not start within ${waitMs} ms (see ${scheddPaths(dir).log}): ${e?.message ?? e}`); }
  }
}

export const SCHEDD_SCRIPT = fileURLToPath(new URL("../forgedock.mjs", import.meta.url));

/** `forgedock schedd` in its own session, output to `schedd.log`. */
export function defaultSpawn({ dir = schedDir(), script = SCHEDD_SCRIPT, env = process.env } = {}) {
  mkdirSync(dir, { recursive: true });
  const out = openSync(scheddPaths(dir).log, "a");
  try {
    const child = spawn(process.execPath, [script, "schedd"], { env, detached: true, windowsHide: true, stdio: ["ignore", out, out] });
    child.on?.("error", () => { /* the connect retry reports it */ });
    child.unref?.();
  } finally { closeSync(out); }
}

/**
 * Send one request and feed every reply to `onMsg`. Resolves with the last message (`done`, `ok`, `status`), rejects on
 * `error` or when the daemon closes the stream first.
 */
export function request(sock, msg, onMsg = () => {}, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "", last = null, settled = false, timer = null;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    // #4775: a bound for one-shot requests; a stalled daemon answers an error instead of hanging the caller (streams pass none)
    if (timeoutMs > 0) timer = setTimeout(() => { sock.destroy(); finish(reject, Object.assign(new Error(`schedd did not answer within ${Math.round(timeoutMs / 1000)}s (not responding)`), { code: "schedd.timeout" })); }, timeoutMs);
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

export const scheddExists = (dir = schedDir()) => existsSync(process.platform === "win32" ? scheddPaths(dir).lock : scheddPaths(dir).sock);

#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase-aware host admission (#4169): lanes run their LLM phases freely (bounded only by the host lane cap, #4191),
 * and only `heavy` steps (installs, type checks, linters, test runners, containers) take a slot of one host semaphore.
 * State is one file, `heavy.json` in `schedDir()` (next to the lane registry): `{v, seq, maxQueued, holders:{key:{pid,
 * issue, phase, priority, mb, at}}, waiters:{key:{pid, issue, phase, priority, seq, at}}}`, mutated under an exclusive
 * lock file (`heavy.lock`, owner pid; a dead owner's lock is taken over) with `writeAtomic`, like `sched.mjs`.
 *
 * A grant needs: live holders < max (default max(1, cores - 1)); the caller first among waiters (priority, then FIFO);
 * and MemAvailable − Σ mb of holders granted within the ramp window ≥ step_mem_mb + reserve_mb. Swap never counts as
 * free memory. With no holder, one grant is allowed while MemAvailable ≥ reserve_mb, so a step is never starved by a
 * host whose memory is used by something else. Fail-open: an unreadable registry or a lock timeout grants.
 *
 * Builder-run commands are gated by per-run PATH shims (`writeHeavyShims`) that call this file as a CLI:
 * `heavy.mjs run --name <n> -- <abs-real-bin> args...` (nested calls pass through via FORGE_HEAVY_HELD).
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, appendFileSync, writeFileSync, chmodSync } from "node:fs";
import { cpus, freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeAtomic } from "./batch.mjs";
import { schedDir, pidAlive, DEFAULT_PRIORITY } from "./sched.mjs";
import { which } from "./toolchain.mjs";
import { hostParallelism } from "./admission.mjs";

export const HEAVY_DEFAULTS = Object.freeze({ enabled: true, max: null, step_mem_mb: 2048, reserve_mb: 1024, ramp_s: 60, max_wait_s: 1800 });
export const HEAVY_POLL_MS = 2000;
const LOCK_WAIT_MS = 2000, EMPTY_LOCK_STALE_MS = 5000;

const PMS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Package-manager subcommands that only read metadata (everything else installs or runs scripts/tools). */
const PM_LIGHT = new Set(["version", "help", "view", "info", "show", "ls", "list", "why", "outdated", "config", "get", "set", "whoami", "root", "bin", "prefix", "store", "cache", "pack", "publish", "login", "logout", "search", "owner", "dist-tag"]);
const PM_VALUE_FLAGS = new Set(["-w", "-C", "-F", "--filter", "--dir", "--cwd", "--prefix", "--workspace"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const TOOLS = new Set(["tsc", "eslint", "jest", "vitest", "playwright", "pytest", "mypy", "pyright", "tox", "gradle", "gradlew", "mvn"]);
const SUBTOOLS = {
  cargo: new Set(["build", "b", "test", "t", "check", "c", "clippy", "run", "r", "bench", "doc", "install"]),
  go: new Set(["build", "test", "vet", "run", "install", "generate"]),
  docker: new Set(["run", "build", "compose", "buildx"]),
  "docker-compose": new Set(["up", "run", "build", "create", "start"]),
};
/** Every command name a heavy shim is written for (only those found on the lane PATH get one). */
export const HEAVY_BINS = Object.freeze([...PMS, ...RUNNERS, ...TOOLS, ...Object.keys(SUBTOOLS)]);
const INFO = new Set(["-v", "-V", "--version", "version", "-h", "--help", "help"]);

/** 'heavy' | 'llm' for one command line (`name` is the basename, `args` its argv). Unknown commands are llm. */
export function classifyStep(name, args = []) {
  const n = String(name ?? "").split("/").pop();
  const a = (args ?? []).map(String);
  const onlyInfo = a.length > 0 && a.every((x) => INFO.has(x));
  if (PMS.has(n)) {
    // A pm flag-with-value prefix (`pnpm --filter x test`, `npm -w a run`) is skipped to find the subcommand.
    let i = 0;
    while (i < a.length && a[i].startsWith("-") && !INFO.has(a[i])) i += PM_VALUE_FLAGS.has(a[i]) ? 2 : 1;
    const sub = a[i];
    if (sub === undefined) return n === "yarn" && a.length === 0 ? "heavy" : "llm"; // bare `yarn` installs
    return PM_LIGHT.has(sub) || INFO.has(sub) ? "llm" : "heavy";
  }
  if (RUNNERS.has(n) || TOOLS.has(n)) return a.length === 0 && RUNNERS.has(n) ? "llm" : onlyInfo ? "llm" : "heavy";
  if (SUBTOOLS[n]) { const sub = a.find((x) => !x.startsWith("-")); return sub && SUBTOOLS[n].has(sub) ? "heavy" : "llm"; }
  return "llm";
}

const INTERP = new Set(["sh", "bash", "dash", "zsh", "node", "nodejs", "python", "python3", "env"]);
const PY_HEAVY_MODULES = new Set(["pytest", "mypy", "tox", "unittest"]);
/**
 * #4405: is this `ps` command line a heavy step (a shim-gated step, test runner, linter, type checker, install)? Looks
 * through an interpreter (`/bin/sh …/vitest run`, `node …/eslint .`) and knows `node --test` and `python -m pytest`.
 * Pollers (`sleep`, `until grep …`), MCP servers and plain scripts are not.
 */
export function isHeavyProcess(cmd) {
  const s = String(cmd ?? "");
  if (/\bheavy\.mjs['"]?\s+run\b/.test(s)) return true;
  const t = s.trim().split(/\s+/).filter(Boolean);
  if (!t.length) return false;
  const base = (x) => x.split("/").pop().replace(/\.(c|m)?js$/, "");
  if (classifyStep(base(t[0]), t.slice(1)) === "heavy") return true;
  const b0 = base(t[0]), py = /^python\d*(\.\d+)?$/.test(b0);
  if (!INTERP.has(b0) && !py) return false;
  const rest = t.slice(1);
  if ((b0 === "node" || b0 === "nodejs") && rest.includes("--test")) return true;
  const mi = rest.indexOf("-m");
  if (py && mi >= 0 && PY_HEAVY_MODULES.has(rest[mi + 1])) return true;
  const si = rest.findIndex((x) => !x.startsWith("-") && !/^\w+=/.test(x));
  if (si < 0 || rest[si - 1] === "-c") return false;
  return classifyStep(base(rest[si]), rest.slice(si + 1)) === "heavy";
}

/** Merged heavy config: defaults ← cfg (forge.yaml engine.heavy_*) ← env (FORGE_HEAVY_MAX|STEP_MEM_MB|RESERVE_MB). */
export function heavyConfig(cfg = {}, env = {}) {
  const pos = (v) => { const x = Number(v); return v !== undefined && v !== null && String(v).trim() !== "" && Number.isFinite(x) && x > 0 ? x : null; };
  const c = { ...HEAVY_DEFAULTS };
  for (const k of ["max", "step_mem_mb", "reserve_mb", "ramp_s", "max_wait_s"]) { const v = pos(cfg?.[k]); if (v !== null) c[k] = k === "max" ? Math.floor(v) : v; }
  if (cfg?.enabled === false) c.enabled = false;
  const e = { max: env.FORGE_HEAVY_MAX, step_mem_mb: env.FORGE_HEAVY_STEP_MEM_MB, reserve_mb: env.FORGE_HEAVY_RESERVE_MB };
  for (const [k, v] of Object.entries(e)) { const x = pos(v); if (x !== null) c[k] = k === "max" ? Math.floor(x) : x; }
  return c;
}

/** MemAvailable (MB) from /proc/meminfo, else os.freemem; never swap. */
export function memAvailableMb() {
  try { const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8")); if (m) return Math.floor(Number(m[1]) / 1024); } catch { /* not Linux */ }
  return Math.floor(freemem() / 1048576);
}
const defaultHost = () => ({ memAvailableMb, cores: () => cpus().length || 1 });

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const byRank = ([ka, a], [kb, b]) => (a.priority - b.priority) || (a.seq - b.seq) || (ka < kb ? -1 : ka > kb ? 1 : 0);

/**
 * Handle on the heavy semaphore. `host` gives {memAvailableMb, cores}; `alive(pid)` the liveness probe (tests inject).
 * @returns {{dir, file, max, tryAcquire, withdraw, release, stats}}
 */
export function openHeavy(dir = schedDir(), { cfg = {}, env = {}, host = defaultHost(), now = () => Date.now(), pid = process.pid, alive = pidAlive, lockWaitMs = LOCK_WAIT_MS } = {}) {
  const c = heavyConfig(cfg, env);
  const file = join(dir, "heavy.json"), lockFile = join(dir, "heavy.lock");
  const num = (f) => { try { const v = f?.(); return Number.isFinite(v) ? v : null; } catch { return null; } };
  const max = () => c.max ?? Math.max(1, (num(host.cores) ?? 1) - 1);

  const lock = () => {
    mkdirSync(dir, { recursive: true });
    const end = Date.now() + lockWaitMs;
    for (;;) {
      try { const fd = openSync(lockFile, "wx"); try { writeSync(fd, String(pid)); } finally { closeSync(fd); } return; } catch (e) { if (e?.code !== "EEXIST") throw e; }
      let owner = NaN;
      try { owner = parseInt(readFileSync(lockFile, "utf8"), 10); } catch { /* released meanwhile */ }
      let empty = false;
      if (Number.isNaN(owner)) { try { empty = Date.now() - statSync(lockFile).mtimeMs < EMPTY_LOCK_STALE_MS; } catch { continue; } }
      if (!empty && (Number.isNaN(owner) || !alive(owner))) {
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
      if (Date.now() >= end) throw new Error(`heavy registry lock held by pid ${Number.isNaN(owner) ? "?" : owner}`);
      pause(10);
    }
  };
  const unlock = () => { try { rmSync(lockFile, { force: true }); } catch { /* best effort */ } };
  const read = () => {
    let o;
    try { o = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
      if (e?.code !== "ENOENT") throw new Error(`heavy registry ${file} unreadable: ${e?.message ?? e}`);
      o = {};
    }
    const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
    return { v: 1, seq: Number.isInteger(o?.seq) ? o.seq : 0, maxQueued: Number.isInteger(o?.maxQueued) ? o.maxQueued : 0, holders: obj(o?.holders), waiters: obj(o?.waiters) };
  };
  const mutate = (fn) => {
    lock();
    try {
      const s = read();
      for (const [k, e] of Object.entries(s.holders)) if (!alive(e.pid)) delete s.holders[k];
      for (const [k, e] of Object.entries(s.waiters)) if (!alive(e.pid)) delete s.waiters[k];
      const r = fn(s);
      writeAtomic(file, JSON.stringify(s, null, 2) + "\n");
      return r;
    } finally { unlock(); }
  };

  return {
    dir, file, max, config: c,
    /**
     * Grant `key` a slot or queue it. entry: {issue, phase, priority, mb}.
     * @returns {{ok:boolean, fallback?:true, reason?:string, holders?:number}}
     */
    tryAcquire: (key, entry = {}) => {
      try {
        return mutate((s) => {
          if (s.holders[key]) return { ok: true, holders: Object.keys(s.holders).length, queued: Object.keys(s.waiters).length };
          const priority = Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : DEFAULT_PRIORITY;
          if (!s.waiters[key]) s.waiters[key] = { pid, issue: entry.issue ?? null, phase: entry.phase ?? null, priority, seq: ++s.seq, at: now() };
          const queued = Object.keys(s.waiters).length;
          s.maxQueued = Math.max(s.maxQueued, queued);
          const held = Object.values(s.holders);
          const order = Object.entries(s.waiters).sort(byRank);
          if (order[0][0] !== key) return { ok: false, queued, reason: `queued behind ${order.findIndex(([k]) => k === key)} heavy step(s)` };
          if (held.length >= max()) return { ok: false, queued, reason: `heavy cap ${max()} reached` };
          const mem = num(host.memAvailableMb);
          if (mem !== null) {
            if (held.length === 0 ? mem < c.reserve_mb : (() => {
              const ramping = held.filter((h) => now() - (h.at ?? 0) < c.ramp_s * 1000).reduce((t, h) => t + (Number(h.mb) || c.step_mem_mb), 0);
              return mem - ramping < c.step_mem_mb + c.reserve_mb;
            })()) return { ok: false, queued, reason: `free memory ${mem} MB below the heavy-step reservation` };
          }
          const w = s.waiters[key];
          delete s.waiters[key];
          s.holders[key] = { pid, issue: w.issue, phase: w.phase, priority: w.priority, mb: Number(entry.mb) > 0 ? Number(entry.mb) : c.step_mem_mb, at: now() };
          return { ok: true, holders: held.length + 1, queued };
        });
      } catch (e) { return { ok: true, fallback: true, reason: e?.message ?? String(e) }; }
    },
    withdraw: (key) => { try { mutate((s) => { delete s.waiters[key]; }); } catch { /* fail-open */ } },
    release: (key) => { try { mutate((s) => { delete s.holders[key]; delete s.waiters[key]; }); } catch { /* fail-open */ } },
    /** #4405: {queued, running} of live entries whose pid is in `pids` (one session's processes), read-only; null when unreadable. */
    lane: (pids = []) => {
      try {
        const s = read(), set = new Set([...pids].map(Number));
        const n = (o) => Object.values(o).filter((e) => set.has(Number(e?.pid)) && alive(e.pid)).length;
        return { queued: n(s.waiters), running: n(s.holders) };
      } catch { return null; }
    },
    /** {holders, queued, maxQueued, max} of live entries, read-only (no lock, no write); null when unreadable. */
    stats: () => {
      try {
        const s = read(), live = (o) => Object.values(o).filter((e) => alive(e.pid)).length;
        return { holders: live(s.holders), queued: live(s.waiters), maxQueued: s.maxQueued, max: max() };
      } catch { return null; }
    },
  };
}

let keySeq = 0;
/**
 * Wait for a slot (polling), giving up after `max_wait_s` (the step then runs ungated: never stall a lane forever).
 * `queued` is the longest heavy queue (this step included) seen while waiting.
 * @returns {Promise<{key:string, waitMs:number, holders:number, queued:number, fallback?:true, timedOut?:true, release:Function}>}
 */
export async function acquireHeavy(h, entry = {}, { pollMs = HEAVY_POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), pid = process.pid } = {}) {
  const key = `${pid}:${++keySeq}:${entry.phase ?? "step"}`;
  const t0 = now(), limit = (h.config?.max_wait_s ?? HEAVY_DEFAULTS.max_wait_s) * 1000;
  let queued = 0;
  const done = (extra) => ({ key, waitMs: now() - t0, holders: 1, queued, ...extra, release: () => h.release(key) });
  for (;;) {
    const r = h.tryAcquire(key, entry);
    if (Number.isInteger(r.queued)) queued = Math.max(queued, r.queued);
    if (r.ok) return done({ holders: r.holders ?? 1, ...(r.fallback ? { fallback: true } : {}) });
    if (now() - t0 >= limit) { h.withdraw(key); return done({ timedOut: true, release: () => {} }); }
    await sleep(pollMs);
  }
}

/** Default lane effect: `acquire(entry, cfg)` → {waitMs, queued, release()} (cfg = the lane's forge.yaml heavy keys); `stats()`; `lane(pids)` (#4405). */
export function makeHeavyIo({ dir = schedDir(), env = process.env, host } = {}) {
  const open = (cfg) => openHeavy(dir, { cfg, env, ...(host ? { host } : {}) });
  return { acquire: (entry, cfg = {}) => acquireHeavy(open(cfg), entry), stats: () => open({}).stats(), lane: (pids) => open({}).lane(pids) };
}

const SHIM_HEADER = "#!/bin/sh\n# forgedock heavy-step shim (#4169): waits for a host heavy-step slot, then runs the real command; do not edit.\n";
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Shim script for one command: exec node heavy.mjs run --name <n> -- <real> "$@". */
export function heavyShimScript(name, real, { node = process.execPath, script = fileURLToPath(import.meta.url) } = {}) {
  return `${SHIM_HEADER}exec ${q(node)} ${q(script)} run --name ${q(name)} -- ${q(real)} "$@"\n`;
}

/**
 * Write 0755 shims into `binDir` for every HEAVY_BINS name found on `path` (binDir excluded, real path resolved now, so
 * a shim never calls itself). Returns the names written.
 */
export async function writeHeavyShims(binDir, { path = process.env.PATH ?? "", find = which, node, script, mkdirp = (d) => mkdirSync(d, { recursive: true }), writeShim = (p, t) => { writeFileSync(p, t); chmodSync(p, 0o755); } } = {}) {
  const found = HEAVY_BINS.map((n) => [n, find(n, path, [binDir])]).filter(([, r]) => r);
  if (!found.length) return [];
  await mkdirp(binDir);
  for (const [n, real] of found) await writeShim(join(binDir, n), heavyShimScript(n, real, { ...(node ? { node } : {}), ...(script ? { script } : {}) }));
  return found.map(([n]) => n);
}

/** Parse heavy-wait jsonl lines into {waits: {phase: ms}, queueMax} (bad lines ignored). */
export function sumWaits(text, waits = {}) {
  let queueMax = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const ms = Number(j?.waitMs);
    if (Number.isFinite(ms) && ms >= 0) { const p = String(j.phase || "step"); waits[p] = (waits[p] ?? 0) + ms; }
    if (Number.isInteger(j?.queued)) queueMax = Math.max(queueMax, j.queued);
  }
  return { waits, queueMax };
}

/**
 * CLI body: `run --name <n> -- <real> args...`. Pass-through when FORGE_HEAVY_HELD is set or the step is llm; else
 * acquire, run with FORGE_HEAVY_HELD=1 and FORGE_HOST_PARALLELISM from live holders, release, propagate the exit.
 */
export async function runWrapped(argv, { env = process.env, open = openHeavy, run = spawnInherit, host } = {}) {
  const sep = argv.indexOf("--");
  if (argv[0] !== "run" || sep < 0 || !argv[sep + 1]) throw new Error("usage: heavy.mjs run --name <name> -- <command> [args...]");
  const ni = argv.indexOf("--name");
  const name = ni >= 0 && ni < sep ? argv[ni + 1] : argv[sep + 1];
  const [cmd, ...args] = argv.slice(sep + 1);
  const c = heavyConfig({}, env);
  if (env.FORGE_HEAVY_HELD || env.FORGE_HEAVY_DISABLED === "1" || classifyStep(name, args) === "llm") return run(cmd, args, env);
  const hostP = host ?? defaultHost();
  const h = open(env.FORGEDOCK_SCHED_DIR || schedDir(env), { env, host: hostP });
  const priority = Number.isFinite(Number(env.FORGE_LANE_PRIORITY)) && String(env.FORGE_LANE_PRIORITY).trim() !== "" ? Number(env.FORGE_LANE_PRIORITY) : DEFAULT_PRIORITY;
  const phase = env.FORGE_LANE_PHASE || "step";
  const g = await acquireHeavy(h, { issue: Number(env.FORGE_LANE_ISSUE) || null, phase, priority, mb: c.step_mem_mb });
  if (env.FORGE_HEAVY_WAITS) { try { appendFileSync(env.FORGE_HEAVY_WAITS, JSON.stringify({ phase, name, waitMs: g.waitMs, queued: g.queued }) + "\n"); } catch { /* metrics are best effort */ } }
  let cores = 1; try { cores = hostP.cores() || 1; } catch { /* 1 */ }
  const childEnv = { ...env, FORGE_HEAVY_HELD: "1",
    ...(env.FORGE_HEAVY_PARALLELISM_PINNED === "1" ? {} : { FORGE_HOST_PARALLELISM: String(hostParallelism({ cores, lanes: g.holders })) }) };
  try { return await run(cmd, args, childEnv); } finally { g.release(); }
}

/** Spawn with inherited stdio; resolves {code, signal}; forwards termination signals to the child. */
export function spawnInherit(cmd, args, env) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    const fwd = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
    const sigs = ["SIGTERM", "SIGINT", "SIGHUP"];
    for (const s of sigs) process.on(s, fwd);
    const off = () => { for (const s of sigs) process.off(s, fwd); };
    child.on("error", (e) => { off(); process.stderr.write(`${cmd}: ${e.message}\n`); done({ code: e.code === "ENOENT" ? 127 : 126, signal: null }); });
    child.on("exit", (code, signal) => { off(); done({ code, signal }); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWrapped(process.argv.slice(2)).then(({ code, signal }) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  }, (e) => { process.stderr.write(`forgedock heavy: ${e?.message ?? e}\n`); process.exit(2); });
}

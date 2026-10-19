// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// run.mjs - execute a plan in the build worktree. Independent jobs run in parallel, bounded per run (max_parallel) and
// machine-wide (a slot semaphore under ~/.forge/ci-local.lock), each with a timeout, inside an overall budget.
// Service containers (docker) are named per run and always torn down. Passing checks are cached by input hash.
// Nothing here talks to GitHub or triggers a remote workflow.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { run as runSync, commandExists, scrubbedEnv, capParallel, homeForgeDir, sha256, fileHash, toolVersion, shellSplit } from './lib.mjs';
import { shellArgv } from './adapters/common.mjs';
import { checkPortability } from './adapters/portability.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = new Set();
let cleaning = false;
function cleanupAll() { if (cleaning) return; cleaning = true; for (const f of [...cleanups]) { try { f(); } catch { /* best effort */ } } }
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanupAll(); process.exit(130); });

// ---- machine-wide slot semaphore ----
function slotCount() {
  const n = Number(process.env.FORGE_CI_LOCAL_SLOTS);
  return capParallel(n > 0 ? n : Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))));
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

let ticketSeq = 0;
// Is this slot dir free to take (absent, or held by a dead pid / for over 3 h)? A stale one is reaped.
function slotFree(slot) {
  if (!fs.existsSync(slot)) return true;
  let pid = 0; let ts = 0;
  try { const [p, t] = fs.readFileSync(path.join(slot, 'owner'), 'utf8').split(' '); pid = Number(p); ts = Number(t); } catch { /* owner file not written yet */ }
  const stale = pid ? !alive(pid) : (Date.now() - (fs.statSync(slot, { throwIfNoEntry: false })?.mtimeMs || 0) > 30000);
  if (stale || (ts && Date.now() - ts > 3 * 3600 * 1000)) { try { fs.rmSync(slot, { recursive: true, force: true }); } catch { /* raced */ } return !fs.existsSync(slot); }
  return false;
}

// forge#4057: FIFO-fair slot acquisition. Every waiter files a ticket (`<ms>-<seq>-<pid>-<rand>`) under ci-local.lock/queue and
// only a ticket among the first N (N = number of free slots) may claim one, so an invocation can never be starved by polling
// races. A ticket whose pid is dead is reaped; the ticket is removed on acquire, on a deadline miss and on every exit path.
export async function acquireSlot(owner, deadline) {
  const dir = path.join(homeForgeDir(), 'ci-local.lock');
  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  const n = slotCount();
  const ticket = `${String(Date.now()).padStart(14, '0')}-${String(++ticketSeq).padStart(6, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tpath = path.join(qdir, ticket);
  fs.writeFileSync(tpath, `${process.pid} ${owner}\n`, { flag: 'wx' });
  const dropTicket = () => { try { fs.rmSync(tpath, { force: true }); } catch { /* gone */ } cleanups.delete(dropTicket); };
  cleanups.add(dropTicket);
  try {
    for (;;) {
      const free = [];
      for (let i = 0; i < n; i++) if (slotFree(path.join(dir, `slot-${i}`))) free.push(i);
      const live = [];
      for (const name of fs.readdirSync(qdir).sort()) {
        if (name !== ticket && !alive(Number(name.split('-')[2]))) { try { fs.rmSync(path.join(qdir, name), { force: true }); } catch { /* raced */ } continue; }
        live.push(name);
      }
      const pos = live.indexOf(ticket);
      if (pos === -1) { try { fs.writeFileSync(tpath, `${process.pid} ${owner}\n`, { flag: 'wx' }); } catch { /* re-filed by a racing reaper */ } }
      else if (pos < free.length) {
        for (const i of free) {
          const slot = path.join(dir, `slot-${i}`);
          try {
            fs.mkdirSync(slot);
            fs.writeFileSync(path.join(slot, 'owner'), `${process.pid} ${Date.now()} ${owner}\n`);
            const release = () => { try { fs.rmSync(slot, { recursive: true, force: true }); } catch { /* gone */ } cleanups.delete(release); };
            cleanups.add(release);
            return release;
          } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
      }
      if (Date.now() > deadline) return null;
      await sleep(250);
    }
  } finally { dropTicket(); }
}

// ---- process execution ----
function exec(argv, { cwd, env, timeoutMs, onData }) {
  return new Promise((resolve) => {
    let child; let killed = false; let timer;
    try { child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: 127, signal: null, error: e.message, timedOut: false }); return; }
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
    const unreg = () => { cleanups.delete(hard); };
    const hard = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
    cleanups.add(hard);
    timer = setTimeout(() => { killed = true; kill(); }, timeoutMs);
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); unreg(); resolve({ code: 127, signal: null, error: e.message, timedOut: false }); });
    child.on('close', (code, signal) => { clearTimeout(timer); unreg(); resolve({ code: code === null ? 1 : code, signal, timedOut: killed }); });
  });
}

// forge#4040 (SEC-4): a path-SEGMENT containment check; a string prefix would accept `<repo>-sibling`.
export function insideRepo(repo, target) {
  const root = path.resolve(repo); const t = path.resolve(target);
  const rel = path.relative(root, t);
  if (!(rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)))) return false;
  try { const rr = path.relative(fs.realpathSync(root), fs.realpathSync(t)); if (rr === '..' || rr.startsWith('..' + path.sep) || path.isAbsolute(rr)) return false; } catch { /* target not created yet: the lexical check stands */ }
  return true;
}

class Tail {
  constructor(max = 120) { this.lines = []; this.max = max; this.partial = ''; }
  push(buf) { const t = this.partial + buf.toString('utf8'); const parts = t.split('\n'); this.partial = parts.pop(); for (const l of parts) { this.lines.push(l); if (this.lines.length > this.max) this.lines.shift(); } }
  text(n = 40) { const all = this.partial ? [...this.lines, this.partial] : this.lines; return all.slice(-n); }
}

// ---- services ----
async function portFree(port) { return new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); }); }
const HEALTH_FLAGS = new Set(['--health-cmd', '--health-interval', '--health-timeout', '--health-retries', '--health-start-period', '--shm-size']);

async function startServices(job, log) {
  const started = [];
  const stop = () => { for (const n of started) runSync('docker', ['rm', '-f', n], { timeout: 30000 }); started.length = 0; };
  cleanups.add(stop);
  let net = '';
  const dropNet = () => { if (net) { runSync('docker', ['network', 'rm', net], { timeout: 30000 }); net = ''; } };
  const finish = () => { stop(); dropNet(); cleanups.delete(stop); cleanups.delete(dropNet); };
  cleanups.add(dropNet);
  if (!commandExists('docker') || runSync('docker', ['info'], { timeout: 20000 }).code !== 0) return { error: 'docker is not available', finish };
  // forge#4040 (SEC-6): one docker network per job; nothing runs with --network host.
  net = `forge-ci-net-${process.pid}-${job.id.replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 120);
  const nr = runSync('docker', ['network', 'create', net], { timeout: 30000 });
  if (nr.code !== 0) { net = ''; return { error: `docker network create failed: ${(nr.err || nr.out).split('\n')[0]}`, finish }; }
  for (const svc of job.services) {
    const name = `forge-ci-${process.pid}-${job.id.replace(/[^A-Za-z0-9_.-]/g, '-')}-${svc.name}`.slice(0, 120);
    const args = ['run', '-d', '--rm', '--name', name, '--network', net, '--network-alias', svc.name];
    const hostPorts = [];
    for (const p of svc.ports || []) {
      const m = /^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/.exec(String(p).trim());
      if (!m) return { error: `unsupported port mapping ${p}`, finish };
      if (m[1]) { if (!(await portFree(Number(m[1])))) return { error: `host port ${m[1]} is already in use`, finish }; hostPorts.push(Number(m[1])); args.push('-p', `127.0.0.1:${m[1]}:${m[2]}${m[3] ? '/' + m[3] : ''}`); } else args.push('-p', `127.0.0.1::${m[2]}`);
    }
    for (const [k, v] of Object.entries(svc.env || {})) args.push('-e', `${k}=${v}`);
    const opts = shellSplit(svc.options || '') || [];
    let health = false;
    for (let i = 0; i < opts.length; i++) {
      const [flag, inline] = opts[i].split(/=(.*)/s);
      if (!HEALTH_FLAGS.has(flag)) { log(`service ${svc.name}: option ${flag} ignored (not on the safe list)`); if (inline === undefined && opts[i + 1] && !opts[i + 1].startsWith('-')) i++; continue; }
      if (flag === '--health-cmd') health = true;
      args.push(inline !== undefined ? `${flag}=${inline}` : flag); if (inline === undefined && opts[i + 1] !== undefined) args.push(opts[++i]);
    }
    args.push(svc.image);
    const r = runSync('docker', args, { timeout: 300000 });
    if (r.code !== 0) return { error: `docker run ${svc.image} failed: ${(r.err || r.out).split('\n')[0]}`, finish };
    started.push(name);
    const until = Date.now() + 90000;
    for (;;) {
      const st = runSync('docker', ['inspect', '-f', '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', name], { timeout: 15000 }).out.trim();
      const [running, h] = st.split('|');
      if (running !== 'true') return { error: `service ${svc.name} exited: ${runSync('docker', ['logs', '--tail', '5', name], { timeout: 15000 }).err.trim().split('\n').pop()}`, finish };
      if (health) { if (h === 'healthy') break; if (h === 'unhealthy') return { error: `service ${svc.name} is unhealthy`, finish }; }
      else if (hostPorts.length) { const ok = await new Promise((res) => { const s = net.connect(hostPorts[0], '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); }); if (ok) break; }
      else { await sleep(2000); break; }
      if (Date.now() > until) return { error: `service ${svc.name} did not become ready in 90s`, finish };
      await sleep(1000);
    }
  }
  return { finish };
}

// ---- result cache ----
function cacheDir(o) { return o.resultCacheDir || path.join(homeForgeDir(), 'ci-local', 'results'); }
function configFilesHash(ctx) {
  if (!ctx.configHash) {
    const re = /(^|\/)(\.shellcheckrc|\.eslintrc[^/]*|eslint\.config\.[^/]*|\.prettierrc[^/]*|\.flake8|ruff\.toml|\.ruff\.toml|pyproject\.toml|setup\.cfg|\.markdownlint[^/]*|\.yamllint[^/]*|\.editorconfig|tox\.ini)$/;
    ctx.configHash = sha256(ctx.plan.changed_files.length ? ctx.tracked.filter((f) => re.test(f)).sort().map((f) => `${f}:${fileHash(ctx.repo, f)}`).join('\n') : '');
  }
  return ctx.configHash;
}
function changeHash(ctx) {
  if (!ctx.changeHash) ctx.changeHash = sha256(JSON.stringify([ctx.plan.merge_base, ctx.plan.changed_files.map((f) => `${f}:${fileHash(ctx.repo, f)}`)]));
  return ctx.changeHash;
}
// forge#4060: service containers are an execution-environment input; they must enter every key derived from stepKey
// (single-flight, persisted result cache, cost probe). Order-insensitive; absent, undefined and [] fingerprint identically.
function servicesFp(job) {
  const svcs = Array.isArray(job.services) ? job.services : [];
  return JSON.stringify(svcs.map((s) => {
    const v = s || {};
    const env = v.env || {};
    return [v.name, v.image, Object.keys(env).sort().map((k) => `${k}=${env[k]}`), (v.ports || []).map(String), v.options || ''];
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}
function stepKey(step, job, ctx) {
  const sel = step.scope || {};
  const first = (shellSplit(step.command) || [])[0] || '';
  const perFile = /:per-file$/.test(sel.selector || '') && sel.files;
  const inputs = perFile
    ? { files: sel.files.map((f) => `${f}:${fileHash(ctx.repo, f)}`), config: configFilesHash(ctx) }
    : { change: changeHash(ctx), selected: sel.files || sel.selector || '' };
  const env = { ...job.env, ...step.env };
  return sha256(JSON.stringify([step.command, step.cwd, step.shell, Object.keys(env).sort().map((k) => `${k}=${env[k]}`), toolVersion(path.basename(first)), process.version, inputs, servicesFp(job)]));
}

function durKey(step) { return sha256(`${step.command}\0${step.cwd || ''}`).slice(0, 40); }

// forge#4057: cost hint for ordering. wide = some step runs unscoped or widened; est = expected execution ms (a cached step
// costs 0, otherwise the last recorded duration of that command, else a default). Cheap and narrow jobs go first so a budget
// hit leaves the most coverage proven.
function jobCost(job, ctx) {
  let wide = 0; let est = 0;
  for (const step of job.steps) {
    if (step.noop || step.skip) continue;
    if (step.builtin) continue;
    if (!step.scope || step.scope.mode === 'full' || step.scope.widen_reason) wide = 1;
    try {
      if (step.kind !== 'install' && !ctx.noResultCache && fs.existsSync(path.join(cacheDir(ctx.o), stepKey(step, job, ctx) + '.json'))) continue;
    } catch { /* unknown cost */ }
    let d = 60000;
    try { const v = Number(fs.readFileSync(path.join(cacheDir(ctx.o), 'dur', durKey(step)), 'utf8')); if (v >= 0) d = v; } catch { /* no history */ }
    est += d;
  }
  return [wide, est];
}

// ---- one job ----
function jobEnv(job, step, ctx, ghFiles) {
  const extra = { ...job.env, ...step.env };
  if (job.source === 'github-actions') Object.assign(extra, { GITHUB_WORKSPACE: ctx.repo, GITHUB_SHA: ctx.plan.head_sha, GITHUB_REF_NAME: ctx.plan.head_branch, GITHUB_BASE_REF: ctx.plan.base_branch, GITHUB_HEAD_REF: ctx.plan.head_branch, GITHUB_EVENT_NAME: 'pull_request', RUNNER_OS: { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[process.platform], RUNNER_TEMP: ctx.tmp, GITHUB_ENV: ghFiles.env, GITHUB_PATH: ghFiles.path, GITHUB_OUTPUT: ghFiles.output, GITHUB_STEP_SUMMARY: ghFiles.summary });
  return scrubbedEnv(extra);
}
function absorbGhFiles(ghFiles, env) {
  try {
    const lines = fs.readFileSync(ghFiles.env, 'utf8').split('\n'); fs.writeFileSync(ghFiles.env, '');
    for (let i = 0; i < lines.length; i++) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[i]);
      if (m) { const buf = []; i++; while (i < lines.length && lines[i] !== m[2]) buf.push(lines[i++]); env[m[1]] = buf.join('\n'); continue; }
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(lines[i]); if (kv) env[kv[1]] = kv[2];
    }
    const paths = fs.readFileSync(ghFiles.path, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(ghFiles.path, '');
    if (paths.length) env.PATH = paths.join(path.delimiter) + path.delimiter + (env.PATH || process.env.PATH);
  } catch { /* files are best effort */ }
}

async function runJob(job, ctx) {
  const t0 = Date.now(); const res = { id: job.id, name: job.name, source: job.source, status: 'pass', steps: [], reason: '', duration_ms: 0, wait_ms: 0 };
  const jobTimeout = (job.timeout_s || ctx.jobTimeoutS) * 1000;
  const log = (m) => { res.notes = (res.notes || []).concat(m); };
  const runnableSteps = job.steps.filter((s) => !s.noop);
  if (!runnableSteps.length) { res.status = 'pass'; res.reason = 'nothing to run'; res.duration_ms = Date.now() - t0; return res; }
  let svc = null; let release = null;
  // forge#4040 (REG-5): the job timeout clock starts when the job starts executing, never while it waits for a slot.
  // forge#4057: the slot is taken lazily, right before the first step that really executes, so a job made only of skipped,
  // cached or deduplicated steps never queues for one. Time spent here is wait_ms (not duration_ms) and shifts tExec.
  let tExec = Date.now();
  const takeSlot = async () => {
    const tw = Date.now();
    try {
      release = await acquireSlot(job.id, ctx.deadline);
      res.wait_ms += Date.now() - tw;
      if (!release) { res.status = 'deferred'; res.budget = true; res.reason = 'budget exhausted waiting for a machine slot'; return false; }
      if (job.services && job.services.length) {
        svc = await startServices(job, log);
        if (svc.error) { res.status = 'deferred'; res.reason = `service containers: ${svc.error}`; return false; }
      }
      return true;
    } finally { tExec += Date.now() - tw; }
  };
  try {
    const ghFiles = { env: path.join(ctx.tmp, `${job.id.replace(/[^A-Za-z0-9]/g, '_')}.env`), path: path.join(ctx.tmp, `${job.id.replace(/[^A-Za-z0-9]/g, '_')}.path`), output: path.join(ctx.tmp, `${job.id.replace(/[^A-Za-z0-9]/g, '_')}.out`), summary: path.join(ctx.tmp, `${job.id.replace(/[^A-Za-z0-9]/g, '_')}.sum`) };
    for (const f of Object.values(ghFiles)) fs.writeFileSync(f, '');
    const carried = {}; let failedGroup = null;
    for (const [i, step] of job.steps.entries()) {
      if (step.noop) continue;
      const sr = { name: step.name, command: step.command.length > 200 ? step.command.slice(0, 200) + '...' : step.command, scope: step.scope ? { mode: step.scope.mode, selector: step.scope.selector, selected: step.scope.selected, total: step.scope.total, widen_reason: step.scope.widen_reason } : undefined, status: 'pass', duration_ms: 0, cache: 'na' };
      res.steps.push(sr);
      if (step.skip) { sr.status = 'skipped'; sr.reason = step.skip; continue; }
      if (failedGroup && step.group !== failedGroup) break;
      if (Date.now() > ctx.deadline) { res.status = 'deferred'; res.budget = true; res.reason = 'budget exhausted'; return res; }
      let s0 = Date.now();
      if (step.builtin === 'portability') {
        const f = checkPortability({ repo: ctx.repo, from: ctx.plan.merge_base, changed: ctx.plan.changed_files, tracked: ctx.tracked });
        sr.duration_ms = Date.now() - s0;
        if (f.length) { sr.status = 'fail'; res.tail = f.slice(0, 40); res.status = 'fail'; res.failed_step = step.name; failedGroup = step.group || null; if (!failedGroup) break; }
        continue;
      }
      let key = ''; let fkey = '';
      const cacheable = step.kind !== 'install' && !ctx.noResultCache;
      if (step.kind !== 'install') {
        const base = stepKey(step, job, ctx);
        // forge#4057: identical checks (command, cwd, shell, env, input hash, carried env) run once per invocation. A step that
        // reads or writes the GitHub Actions side files has effects beyond its exit code, so it is never shared.
        if (!(job.source === 'github-actions' && /GITHUB_(ENV|PATH|OUTPUT|STEP_SUMMARY)/.test(step.command))) fkey = sha256(base + JSON.stringify(carried));
        if (cacheable) key = base;
      }
      if (cacheable) {
        const f = path.join(cacheDir(ctx.o), key + '.json');
        if (fs.existsSync(f)) { sr.cache = 'hit'; sr.duration_ms = 0; try { fs.utimesSync(f, new Date(), new Date()); } catch { /* ignore */ } continue; }
        sr.cache = 'miss';
      }
      const argv = shellArgv(step.shell); if (!argv) { res.status = 'deferred'; res.reason = `shell ${step.shell} is not available locally`; return res; }
      const scriptFile = path.join(ctx.tmp, `${job.id.replace(/[^A-Za-z0-9]/g, '_')}-${i}.sh`);
      fs.writeFileSync(scriptFile, step.command + '\n');
      const env = jobEnv(job, step, ctx, ghFiles); Object.assign(env, carried);
      const cwd = path.resolve(ctx.repo, step.cwd || '.');
      if (!insideRepo(ctx.repo, cwd)) { res.status = 'deferred'; res.reason = 'step working-directory escapes the repository'; return res; }
      let prior = fkey ? ctx.flight.get(fkey) : null;
      if (!prior && !release) {
        if (!(await takeSlot())) return res;
        s0 = Date.now();
        prior = fkey ? ctx.flight.get(fkey) : null; // another job may have started the same check while this one queued
      }
      let r; let text; let left;
      if (prior) {
        // single-flight: wait for the first run of this exact check and reuse its result (a failure is shared, never re-run)
        ({ r, text, left } = await prior);
        sr.cache = 'dedup'; sr.duration_ms = 0;
      } else {
        const tail = new Tail();
        left = Math.max(1000, Math.min((step.timeout_s || ctx.jobTimeoutS) * 1000, jobTimeout - (Date.now() - tExec), ctx.deadline - Date.now()));
        const l0 = left;
        const flight = (async () => { const r0 = await exec([...argv, scriptFile], { cwd, env, timeoutMs: l0, onData: (b) => tail.push(b) }); if (r0.error) tail.push(Buffer.from(`${r0.error}\n`)); return { r: r0, text: tail.text(60), left: l0 }; })();
        if (fkey) ctx.flight.set(fkey, flight);
        ({ r, text } = await flight);
        sr.duration_ms = Date.now() - s0;
        if (job.source === 'github-actions') { const e2 = { ...env }; absorbGhFiles(ghFiles, e2); for (const k of Object.keys(e2)) if (e2[k] !== env[k]) carried[k] = e2[k]; }
        if (r.code === 0) {
          try { // duration_ms in the entry and a per-command duration hint feed the scheduler's cost ordering
            fs.mkdirSync(path.join(cacheDir(ctx.o), 'dur'), { recursive: true });
            if (key) fs.writeFileSync(path.join(cacheDir(ctx.o), key + '.json'), JSON.stringify({ cmd: step.command.slice(0, 300), ts: Date.now(), duration_ms: sr.duration_ms }));
            fs.writeFileSync(path.join(cacheDir(ctx.o), 'dur', durKey(step)), String(sr.duration_ms));
          } catch { /* cache is best effort */ }
        }
      }
      if (r.code === 0) continue;
      if (r.timedOut) { if (Date.now() > ctx.deadline) { res.status = 'deferred'; res.budget = true; res.reason = 'budget exhausted (job killed)'; return res; } sr.status = 'timeout'; res.status = 'degraded'; res.reason = `timed out after ${Math.round(left / 1000)}s (a timeout proves nothing about the code)`; res.tail = text; res.failed_step = step.name; return res; }
      if (step.kind === 'install') { res.status = 'deferred'; res.reason = `dependency install failed (offline?): ${step.command.slice(0, 60)}`; return res; }
      if (r.code === 127 && text.some((l) => /command not found|not found$|No such file or directory/.test(l)) && !step.continue_on_error) {
        const tool = (text.find((l) => /command not found/.test(l)) || '').replace(/^.*?([A-Za-z0-9._-]+): command not found.*$/, '$1');
        if (/command not found/.test(text.join('\n'))) { res.status = 'deferred'; res.reason = `tool not installed locally: ${tool || 'unknown'}`; return res; }
      }
      if (step.continue_on_error) { sr.status = 'allowed-failure'; continue; }
      // forge#4040 (REG-4): a failure under a tool-version drift (setup-node 18 vs host 26) cannot be attributed to the change.
      if (job.version_drift && job.version_drift.length) { res.status = 'deferred'; res.reason = `version drift (${job.version_drift[0]}); step "${step.name}" failed locally (exit ${r.code}), CI proves it on the pinned toolchain`; res.tail = text; return res; }
      sr.status = 'fail'; sr.exit = r.code; res.status = 'fail'; res.failed_step = step.name; res.exit = r.code; res.failed_command = step.command; res.tail = text;
      failedGroup = step.group || null; if (!failedGroup) break;
    }
    return res;
  } finally {
    if (svc && svc.finish) svc.finish();
    if (release) release();
    res.duration_ms = Math.max(0, Date.now() - t0 - res.wait_ms);
  }
}

// ---- scheduler ----
export async function runPlan(plan, o = {}) {
  const t0 = Date.now();
  const repo = path.resolve(plan.repo || o.repo || '.');
  const requestedS = Number(process.env.FORGE_CI_LOCAL_BUDGET_SECONDS) || (o.budgetMinutes || plan.config.budget_minutes || Number(process.env.FORGE_CI_LOCAL_BUDGET_MINUTES) || 15) * 60;
  // forge#4040 (REG-6): one invocation never exceeds the Bash tool cap (10 min); beyond the cap it ends as a partial run
  // (DEGRADED) and a re-run resumes from the result cache.
  const maxInvS = Number(process.env.FORGE_CI_LOCAL_MAX_INVOCATION_SECONDS) || 540;
  const budgetS = Math.min(requestedS, maxInvS); const capped = requestedS > maxInvS;
  const maxParallel = capParallel(o.maxParallel || plan.config.max_parallel || Number(process.env.FORGE_CI_LOCAL_MAX_PARALLEL) || 4);
  const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-ci-local.'));
  cleanups.add(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });
  const ctx = {
    plan, repo, o, tmp: tmpRoot, deadline: t0 + budgetS * 1000, jobTimeoutS: Number(process.env.FORGE_CI_LOCAL_JOB_TIMEOUT) || Math.min(900, budgetS),
    tracked: runSync('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).out.split('\0').filter(Boolean),
    noResultCache: process.env.FORGE_CI_LOCAL_NO_CACHE === '1',
    flight: new Map(),
  };
  const runnable = plan.jobs.filter((j) => !j.not_applicable && !j.deferred_reason);
  const ids = new Set(runnable.map((j) => j.id));
  const results = new Map(); const running = new Map();
  const pending = new Set(runnable.map((j) => j.id));
  const byId = new Map(runnable.map((j) => [j.id, j]));
  const costs = new Map();
  const cost = (id) => { if (!costs.has(id)) { let c = [1, 0]; try { c = jobCost(byId.get(id), ctx); } catch { /* ordering is a hint */ } costs.set(id, c); } return costs.get(id); };
  const order = new Map([...pending].map((id, i) => [id, i]));
  while (pending.size || running.size) {
    const ready = [];
    for (const id of [...pending]) {
      const j = byId.get(id);
      const needs = (j.needs || []).filter((n) => ids.has(n));
      const blocked = needs.find((n) => results.has(n) && results.get(n).status !== 'pass');
      if (blocked) { pending.delete(id); const b = results.get(blocked); const r = { id, name: j.name, source: j.source, status: b.status === 'fail' ? 'skipped' : 'deferred', reason: b.status === 'fail' ? `needs ${blocked}, which failed` : `needs ${blocked}, which is not proven locally`, steps: [], duration_ms: 0, wait_ms: 0 }; results.set(id, r); printJob(r); continue; }
      if (needs.some((n) => !results.has(n))) continue;
      ready.push(id);
    }
    // narrow/scoped jobs first, then the cheapest; the widest or longest last (ties keep plan order). `needs` is honoured above.
    ready.sort((x, y) => cost(x)[0] - cost(y)[0] || cost(x)[1] - cost(y)[1] || order.get(x) - order.get(y));
    for (const id of ready) {
      if (running.size >= maxParallel) break;
      const j = byId.get(id);
      if (Date.now() > ctx.deadline) { pending.delete(id); results.set(id, { id, name: j.name, source: j.source, status: 'deferred', budget: true, reason: 'budget exhausted before the job started', steps: [], duration_ms: 0, wait_ms: 0 }); continue; }
      pending.delete(id);
      const p = runJob(j, ctx).catch((e) => ({ id, name: j.name, source: j.source, status: 'deferred', reason: `runner error: ${e.message}`, steps: [], duration_ms: 0, wait_ms: 0 })).then((r) => { results.set(id, r); running.delete(id); printJob(r); });
      running.set(id, p);
    }
    if (running.size) await Promise.race(running.values()); else if (pending.size) await sleep(10);
  }
  // report
  const all = [];
  for (const j of plan.jobs) {
    if (j.not_applicable) continue;
    if (j.deferred_reason) { all.push({ id: j.id, name: j.name, status: 'deferred', reason: j.deferred_reason, steps: [], duration_ms: 0 }); continue; }
    const r = results.get(j.id); if (r) all.push(r);
  }
  const run_ = all.filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'degraded');
  const failed = all.filter((r) => r.status === 'fail'); const defd = all.filter((r) => r.status === 'deferred'); const skipped = all.filter((r) => r.status === 'skipped');
  for (const r of defd) console.log(`CI_LOCAL_DEFERRED: ${r.id} | ${r.name} | ${r.reason}`);
  let checks = 0; let hits = 0; let narrowed = 0; let widened = 0; let selTotal = 0; let selSel = 0;
  for (const r of all) for (const [n, s] of r.steps.entries()) {
    if (!s.scope) continue;
    if (s.cache === 'hit') hits++;
    if (s.scope.mode === 'scoped' || s.scope.mode === 'skip') narrowed++;
    if (s.scope.widen_reason) widened++;
    if (typeof s.scope.selected === 'number' && typeof s.scope.total === 'number') { selSel += s.scope.selected; selTotal += s.scope.total; }
    if (checks++ < 40) console.log(`CI_LOCAL_CHECK: job=${r.id} step=${n + 1} selector=${s.scope.selector || 'none'} selected=${s.scope.selected ?? ''} total=${s.scope.total ?? ''} cache=${s.cache} duration_ms=${s.duration_ms} widen=${(s.scope.widen_reason || '').replace(/\s+/g, '_') || 'none'} wait_ms=${r.wait_ms || 0}`);
  }
  const degraded = all.filter((r) => r.status === 'degraded');
  const budgetHit = all.some((r) => r.budget) || (all.some((r) => r.status === 'deferred' && /budget exhausted/.test(r.reason || '')));
  for (const r of degraded) console.log(`CI_LOCAL_DEGRADED: ${r.id} | ${r.name} | ${r.reason}`);
  // forge#4040: FAIL only for a runnable job that really failed. A timeout or an exhausted budget leaves code unproven:
  // DEGRADED (exit 2), never a pass and never a fail.
  const degReason = degraded.length ? 'job_timeout' : budgetHit ? (capped ? 'budget_capped_at_invocation_limit' : 'budget_exhausted') : '';
  const state = failed.length ? 'FAIL' : degReason ? 'DEGRADED' : 'PASS';
  const dur = Date.now() - t0;
  const waitTotal = all.reduce((a, r) => a + (r.wait_ms || 0), 0);
  const dedups = all.reduce((a, r) => a + r.steps.filter((x) => x.cache === 'dedup').length, 0);
  if (plan.no_applicable_jobs && !all.length) console.log('CI_LOCAL_NOTE: no_applicable_jobs (CI definitions exist but no job applies to this change)');
  console.log(`CI_LOCAL_RESULT: ${state} jobs_run=${run_.length} jobs_deferred=${defd.length} jobs_failed=${failed.length} jobs_degraded=${degraded.length} jobs_skipped=${skipped.length} checks=${checks} cache_hits=${hits} narrowed=${narrowed} widened=${widened} selected=${selSel} total=${selTotal} duration_ms=${dur} wait_ms=${waitTotal} dedup=${dedups}${Date.now() > ctx.deadline ? ' budget_exhausted=true' : ''}${plan.no_applicable_jobs && !all.length ? ' no_applicable_jobs=true' : ''}${degReason && state === 'DEGRADED' ? ` reason=${degReason}` : ''}`);
  if (o.resultFile) { try { fs.writeFileSync(o.resultFile, JSON.stringify({ state, mode: plan.config && plan.config.mode, jobs: all, plan_key: plan.plan_key, duration_ms: dur, wait_ms: waitTotal }, null, 2)); } catch { /* ignore */ } }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  return failed.length ? 1 : state === 'DEGRADED' ? 2 : 0;
}

function printJob(r) {
  const secs = (r.duration_ms / 1000).toFixed(1);
  const waitS = ((r.wait_ms || 0) / 1000).toFixed(1);
  const dedup = r.steps.filter((s) => s.cache === 'dedup').length;
  const stepsRun = r.steps.filter((s) => s.status !== 'skipped').length;
  const hit = r.steps.filter((s) => s.cache === 'hit').length;
  console.log(`CI_LOCAL_JOB: ${r.status === 'pass' ? 'pass' : r.status} ${r.id} | ${r.name} | ${secs}s | steps=${stepsRun}/${r.steps.length}${hit ? ` cached=${hit}` : ''}${dedup ? ` dedup=${dedup}` : ''} wait=${waitS}s${r.reason ? ` | ${r.reason}` : ''}`);
  if (r.status === 'fail' || r.status === 'degraded') {
    console.log(`${r.status === 'fail' ? 'CI_LOCAL_FAIL' : 'CI_LOCAL_DEGRADED_STEP'}: ${r.id} | step: ${r.failed_step || '?'}${r.exit !== undefined ? ` | exit ${r.exit}` : ''}`);
    if (r.failed_command) console.log(`CI_LOCAL_FAIL_COMMAND: ${r.failed_command.split('\n')[0].slice(0, 300)}`);
    for (const l of r.tail || []) console.log(`  | ${l}`);
  }
}

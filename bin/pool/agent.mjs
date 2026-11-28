// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
/** Retry-After for a launch whose lane_tools image is still building: lanes cap capacity deferrals at 3, so 3 × 5 min covers a cold build. */
const LANE_BUILD_RETRY_AFTER_S = 300;
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, statfsSync, lstatSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cpus, hostname } from "node:os";
import { bearerOk, call, readJson, route, sameSecret, send } from "./http.mjs";
import { repoRoot, versionOf, laneImageTag, laneBuildArgs, cmpVersion } from "./version.mjs";
import { provideLaneImage, pullVariantImage, withIpv4Fallback, fetchLaneDigest } from "./lane-image.mjs";
import { ensureDaemonDns } from "./docker-dns.mjs";
import { jsonStore } from "./store.mjs";
import { makeWarm } from "./warm.mjs";
import { resolveLaneImage, laneImageNow, laneToolsTag, isLaneToolsTagOf } from "./lane-tools.mjs";
import { projectLayerTag, projectLayerImageNow, isProjectLayerTagOf } from "./project-layer.mjs";
import { hostDiskFree, hostMemFree, ensureNatPin, netState } from "./health.mjs";
import { laneDiskUsedGb, planDiskCap, fstrimDue, runFstrim } from "./disk.mjs";
import { step as laneStep, drainState, pressured } from "./lane-target.mjs";
import { makeMirrorSeed, dockerRunner } from "./mirror-seed.mjs";
import { planIdleEviction, CACHE_LABEL, agentLabel } from "./cache-sweep.mjs";
import { cpuQuotaEnv } from "./docker.mjs";

const LABEL = "computeshare=1";
/** #5695: ephemeral CI runner containers; a different label than LABEL so the orphan reaper never removes them. */
const RUNNER_LABEL = "computeshare.runner=1";
const RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const netSample = { at: 0, rx: 0 };
/** Host RX rate in MB/s since the previous call (null on the first call or when /proc/net/dev is unreadable). */
export function netRx(now = Date.now(), read = () => readFileSync("/proc/net/dev", "utf8")) {
  try {
    const rx = read().split("\n").slice(2).map((l) => l.trim().split(/[:\s]+/)).filter((c) => c[0] && c[0] !== "lo").reduce((a, c) => a + (Number(c[1]) || 0), 0);
    const prev = { ...netSample }; netSample.at = now; netSample.rx = rx;
    return prev.at && now > prev.at && rx >= prev.rx ? { rx_mbps: Math.round(((rx - prev.rx) / 1e6 / ((now - prev.at) / 1000)) * 100) / 100 } : null;
  } catch { return null; }
}
const LOG_CHUNK = 256 * 1024;
const RUNS_IN_SANDBOX = "/root/.forge/runs/."; // #6117: where the lane engine writes its run log (docker cp source)
const RUNLOG_MAX = 20 * 1024 * 1024, TAIL_LINES = 200, GRAVE_LOG_MAX = 1024 * 1024;
const run = promisify(execFile);

/** What this machine/VM actually has (on WSL: the VM caps from .wslconfig). */
export function vmSize() {
  let mem = 0, swap = 0;
  try {
    const mi = readFileSync("/proc/meminfo", "utf8");
    mem = Number(/MemTotal:\s+(\d+)/.exec(mi)[1]) / 1048576;
    swap = Number(/SwapTotal:\s+(\d+)/.exec(mi)?.[1] ?? 0) / 1048576;
  } catch { /* not linux */ }
  return { cpus: cpus().length, mem_gb: Math.round(mem * 10) / 10, swap_gb: Math.round(swap * 10) / 10 };
}
/** Swap a container may use beyond its RAM cap: never more than the VM actually has. */
const swapFor = (gb) => { const want = Number(gb) > 0 ? Number(gb) : 0; const have = vmSize().swap_gb; return have ? Math.min(want, have) : 0; };
const mb = (gb) => `${Math.max(64, Math.round(gb * 1024))}m`;
/** A burst cap can never exceed the machine/VM itself. */
function clampToVm(cpusWanted, memWanted) {
  const vm = vmSize();
  return { cpus: vm.cpus ? Math.min(cpusWanted, vm.cpus) : cpusWanted, mem: vm.mem_gb ? Math.min(memWanted, Math.max(1, vm.mem_gb - 1)) : memWanted };
}
/** Live headroom: MemAvailable and 1-min load per core, so overlapping bursts slow down instead of OOM-killing lanes. */
export function liveHeadroom(cfg = {}) {
  try {
    const mi = readFileSync("/proc/meminfo", "utf8");
    const total = Number(/MemTotal:\s+(\d+)/.exec(mi)[1]) / 1048576, avail = Number(/MemAvailable:\s+(\d+)/.exec(mi)[1]) / 1048576;
    const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]), cores = cpus().length || 1;
    const minFree = cfg.min_free_mem_gb ?? Math.max(2, total * 0.1), maxLoad = cfg.max_load_per_core ?? 2;
    const r = { mem_available_gb: Math.round(avail * 10) / 10, load_per_core: Math.round((load1 / cores) * 100) / 100 };
    if (avail < minFree) return { ok: false, reason: `only ${r.mem_available_gb} GB available (< ${minFree.toFixed(1)})`, ...r };
    if (load1 / cores > maxLoad) return { ok: false, reason: `load ${r.load_per_core}/core (> ${maxLoad})`, ...r };
    return { ok: true, ...r };
  } catch { return { ok: true }; }
}
export const dindName = (name) => `${name}-dind`;
/** #6062: rolls usageView rows up for one worker: admitted (reserved) vs used (summed lane avg and peak) and the utilization ratios. Read-only; null ratios when nothing is reserved. */
export function usageSummary(rows) {
  const f = (x) => Math.round(x * 100) / 100, list = (rows ?? []).filter((r) => r && r.reserved);
  const sum = (g) => f(list.reduce((a, r) => a + (Number.isFinite(g(r)) ? g(r) : 0), 0));
  const admitted = { cpus: sum((r) => r.reserved.cpus), mem_gb: sum((r) => r.reserved.mem_gb) };
  const used = { cpu_avg: sum((r) => r.cpu_avg), cpu_peak: sum((r) => r.cpu_peak), mem_avg_gb: sum((r) => r.mem_avg_gb), mem_peak_gb: sum((r) => r.mem_peak_gb) };
  const ratio = (u, d) => (d > 0 ? f(u / d) : null);
  return { lanes: list.length, admitted, used, utilization: { cpu: ratio(used.cpu_avg, admitted.cpus), mem: ratio(used.mem_avg_gb, admitted.mem_gb) } };
}
export const workVolume = (name) => `cs-work-${name.replace(/^cs-/, "")}`;
/** #5696: the lane worktree is a plain dir on the cache volume (one mount), so depcache hardlinks never hit EXDEV. */
export const workDirOf = (name) => `/cache/work/${name.replace(/^cs-/, "")}`;
/** #5738: private dockerd boot. $1 is the sandbox work dir; /work points at it exactly as in the lane, loopback API only. */
export const DIND_BOOT = 'mkdir -p "$1" && ln -sfn "$1" /work && exec dind dockerd --host=tcp://127.0.0.1:2375 --tls=false';
const WORK_SWEEP_MS = 10 * 60000;
export const safeName = (id) => `cs-${String(id).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 100)}`;
/** Minimum gap between two environment-snapshot ensure runs for one cache volume. */
export const ENV_ENSURE_GAP_MS = 5 * 60000;
/**
 * `docker run` args for the environment-snapshot helper (env.snapshots): a short-lived container of the lane image that
 * reads the repo's bare mirror in the cache volume, builds the snapshot for the ref's lockfiles when it is missing,
 * stages `ready` hardlink copies and collects old snapshots. It writes only under /cache/env, on the same volume as the
 * lane worktrees (/cache/work), so a lane claims a staged copy with a rename. Pure.
 */
export function envEnsureArgs({ volume, image, slug, ref = null, laneTools = [], snapshots = {}, net = [], cpus = 2, mem_gb = 4, agent = null }) {
  const int = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  return [
    "--rm", "--name", `cs-envbuild-${volume.replace(/^cs-cache-/, "")}`.slice(0, 120), "--label", "computeshare.env=1", ...(agent ? ["--label", agent] : []),
    "--cpus", String(cpus), "--memory", `${Math.round(mem_gb * 1024)}m`, ...net, "-v", `${volume}:/cache`,
    "-e", "FORGE_ENV_ROOT=/cache/env", "-e", `FORGE_ENV_IMAGE=${image}`, "-e", "FORGE_DEPCACHE_ROOT=/cache/forge-depcache", "-e", "npm_config_store_dir=/cache/pnpm-store",
    "--entrypoint", "forgedock", image, "env", "ensure", "--mirror", `/cache/git/${String(slug).replace(/\//g, "_")}.git`, ...(ref ? ["--ref", String(ref)] : []),
    "--repo", String(slug), "--ready", String(int(snapshots.ready, 2)), "--keep", String(int(snapshots.keep, 3)), "--max-age-days", String(int(snapshots.max_age_days, 14)),
    ...(laneTools.length ? ["--lane-tools", [...laneTools].sort().join(",")] : []),
  ];
}
const envLine = (k, v) => `${k}=${String(v).replace(/\r?\n/g, " ")}`;

/**
 * Host agent: runs each sandbox as one docker container inside a fixed reservation (allow_cpus / allow_mem_gb).
 * A sandbox lives only while its lease is renewed; the reaper removes expired, over-age and orphaned containers.
 */
/** #5919: a build/upgrade failure as text, keeping its END (the failing step's own output), not the Dockerfile echo at its head. */
export function upgradeErrorText(e, max = 2000) {
  const t = String(e?.stderr || e?.stdout || e?.message || e || "").trim();
  return t.length <= max ? t : `…${t.slice(t.length - max + 1)}`;
}
/** #5919: a build failure that a retry can fix (network, registry or DNS), as opposed to a bad Dockerfile or version pin. */
export const NETWORK_BUILD_RE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|timed out|Could not resolve host|Connection reset|TLS handshake|i\/o timeout|unexpected EOF|curl: \((?:6|7|18|28|35|52|56)\)|npm (?:ERR!|error) (?:code|network) (?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND)|503 Service Unavailable|502 Bad Gateway/i;
/** #5919: run `build`; one retry after `delayMs` when the first failure looks like a network error. */
export async function buildWithRetry(build, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = 30000, log = null } = {}) {
  try { return await build(); } catch (e) {
    if (!NETWORK_BUILD_RE.test(upgradeErrorText(e, 20000))) throw e;
    log?.warn?.(`lane image build failed on a network error; retrying once: ${upgradeErrorText(e, 300)}`);
    await sleep(delayMs);
    return build();
  }
}

const BURY_TIMEOUT_MS = 30000; // evidence copy before a destroy (run logs out of the container) never holds the destroy longer
/** An fd for a regular file a lane may have written, opened without following a symlink and without blocking on a FIFO; null otherwise. Caller closes it. */
export function openLaneFile(path) {
  let fd = null;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    if (fstatSync(fd).isFile()) return fd;
  } catch { /* gone, a link, or not a file */ }
  if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
  return null;
}
/** A regular file the lane may have written, read without following symlinks (a lane can plant a link to a host file); "" otherwise. */
export function readLaneFile(path) {
  const fd = openLaneFile(path);
  if (fd === null) return "";
  try { return readFileSync(fd, "utf8"); } catch { return ""; } finally { try { closeSync(fd); } catch { /* closed */ } }
}
export function createAgent(cfg, { docker, now = () => Date.now(), log = console, live = liveHeadroom, hostDisk = null, hostMem = null, net = netState, vm = vmSize, trim = runFstrim, mirrorRunner = null, fetchDigest = fetchLaneDigest } = {}) {
  const stateDir = cfg.state_dir;
  const store = jsonStore(join(stateDir, "state.json"), { sandboxes: {} });
  const sb = () => store.data.sandboxes;
  const usageView = (r) => {
    const u = r.usage; const f = (x) => Math.round(x * 100) / 100;
    return u?.samples ? { reserved: { cpus: r.cpus, mem_gb: r.mem_gb }, cpu_avg: f(u.cpu_sum / u.samples), cpu_peak: f(u.cpu_peak), mem_avg_gb: f(u.mem_sum / u.samples), mem_peak_gb: f(u.mem_peak), samples: u.samples } : null;
  };
  let pendingResize = null;
  const view = (r) => ({ id: r.id, state: r.state, issue: r.issue, cpus: r.cpus, mem_gb: r.mem_gb, started_at: new Date(r.startedAt).toISOString(), ...(r.error ? { error: r.error } : {}), ...(r.diskPaused ? { status_detail: "paused (disk)" } : {}), ...(r.memPaused ? { status_detail: "paused (host memory)" } : {}), ...(r.diskPressure ? { code: "sandbox.disk_pressure", status_detail: "stopped (disk pressure): worktree kept for resume" } : {}) });
  let warm; // assigned below once launch/destroy exist
  const activeRecs = () => Object.values(sb()).filter((s) => s.state !== "exited");
  // Sandbox ids come from requests: read own keys only, so "__proto__" or "constructor" never resolves to an inherited member (#4566).
  const own = (id) => (typeof id === "string" && Object.hasOwn(sb(), id) ? sb()[id] : warm.byAlias(id)); // #4912: a claimed warm sandbox also answers to its lane id
  const leaseTtlMs = (cfg.lease_ttl_s ?? 600) * 1000;
  const maxLifeMs = (cfg.max_lifetime_s ?? 6 * 3600) * 1000;
  const keepExitedMs = (cfg.keep_exited_s ?? 2 * 3600) * 1000;
  const keepLogMs = (cfg.keep_log_s ?? 600) * 1000; // #6117: a destroyed sandbox's last log, run log and result stay readable this long, so a late fetch still works
  const graveyard = new Map(); // sandbox id -> {until, log: {from, size, text}, tail, runLog, result}
  const keepPressureMs = (cfg.keep_disk_pressure_s ?? 24 * 3600) * 1000; // #5891: a disk-pressure stop keeps its worktree long enough for the requeue
  const running = versionOf(cfg.code_root ?? repoRoot);
  // The lane image tracks the installed ForgeDock version; only an explicit non-legacy cfg.image overrides it.
  const image = cfg.image && cfg.image !== "computeshare-lane:1" ? cfg.image : laneImageTag(running.version);
  // #6187: lane_tools variants of the published default tag are pulled from ghcr first; every build runs under the IPv4 fallback
  const variantDocker = (base) => (base === laneImageTag(running.version) && docker.pull && docker.tag
    ? Object.assign(Object.create(docker), { withFallback: (op) => withIpv4Fallback(op, { log }), pullVariant: (tag) => pullVariantImage({ docker, tag, version: running.version, log }) })
    : Object.assign(Object.create(docker), { withFallback: (op) => withIpv4Fallback(op, { log }) }));
  const upgrade = { state: "idle", error: null };
  const prepull = { error: null };
  const dindImage = cfg.dind_image ?? "docker:27.5.1-dind";
  // #5881: every container/volume this agent creates carries its label; reap and the sweeps list only by it, so a co-resident agent or foreign containers are never touched.
  const agentId = String(cfg.agent_id ?? cfg.name ?? hostname()).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);
  const AGENT = agentLabel(agentId);
  const OWN = [LABEL, AGENT];
  // #6195/#6234: a dockerd DNS failure triggers a daemon.json dns repair. Admission is held across the idle check and the restart; the restart runs only with no sandbox and no container at all (co-tenants included) on the daemon. Lane containers use per-container --dns (netArgs).
  let dnsHold = 0;
  let launching = 0; // #6244: launches between admission and their record in sb(); the DNS repair must not restart dockerd under them
  const noOtherContainers = async () => { if (typeof docker.listRunning !== "function") return false; try { return (await docker.listRunning()).length === 0; } catch { return false; } };
  const pinOpts = { ensureDns: () => ensureDaemonDns({ hold: () => { dnsHold++; return () => { dnsHold--; }; }, idle: async () => launching === 0 && activeRecs().length === 0 && await noOtherContainers() && activeRecs().length === 0, restart: () => run("systemctl", ["restart", "docker"], { timeout: 120000 }), log }) };
  /** Images a sandbox may need are pulled ahead of time, never inside a launch request (which has a short timeout). */
  async function prepullImages() {
    if (await docker.hasImage?.(dindImage)) { prepull.error = null; return; }
    try { await withIpv4Fallback(() => docker.pull(dindImage), { ...pinOpts, log }); prepull.error = null; return; }
    catch (e) { log.warn?.(`pull ${dindImage} failed (${String(e.stderr || e.message).slice(0, 160)}); fetching it from the router`); }
    // Fallback: the router host pulls the image and streams it (some hosts' daemons cannot reach the registry).
    const file = join(stateDir, "image.tar");
    try {
      const res = await fetch(`${String(cfg.router_url).replace(/\/+$/, "")}/agent/images/${encodeURIComponent(dindImage)}`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30 * 60000) });
      if (!res.ok) throw new Error(`router image: HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      await docker.load(file);
      prepull.error = null;
      log.info?.(`loaded ${dindImage} from the router`);
    } catch (e) {
      prepull.error = String(e.stderr || e.message).slice(0, 300);
      log.warn?.(`prepull ${dindImage}: ${prepull.error}`);
    } finally { rmSync(file, { force: true }); }
  }
  // #5858: advertised capacity is the configured allowance clamped to the measured VM minus a host reserve, less what
  // non-sandbox containers use; admission projects each repo's measured per-sandbox peak, not only the configured slice.
  const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
  let clampWarned = false;
  let coTenant = { cpus: 0, mem_gb: 0 };
  function effectiveCapacity() {
    let v = {}; try { v = vm() ?? {}; } catch { /* unknown VM: no clamp */ }
    const reserve = cfg.host_reserve_mem_gb ?? Math.max(1, (v.mem_gb ?? 0) * 0.1);
    const cpusEff = v.cpus > 0 ? Math.min(cfg.allow_cpus, v.cpus) : cfg.allow_cpus;
    const memEff = v.mem_gb > 0 ? Math.min(cfg.allow_mem_gb, Math.max(1, r1(v.mem_gb - reserve))) : cfg.allow_mem_gb;
    const clamped = cpusEff < cfg.allow_cpus || memEff < cfg.allow_mem_gb;
    if (clamped && !clampWarned) { clampWarned = true; log.warn?.(`configured capacity ${cfg.allow_cpus} cpus / ${cfg.allow_mem_gb} GB exceeds the VM (${v.cpus} cpus / ${v.mem_gb} GB minus ${r1(reserve)} GB reserve); advertising ${cpusEff} cpus / ${memEff} GB`); }
    return { cpus: cpusEff, mem: memEff, clamped, vm: v };
  }
  const slugOf = (spec) => (spec?.repo?.slug ? String(spec.repo.slug).toLowerCase() : null);
  let histRows = null;
  function usageRows() {
    if (histRows) return histRows;
    try { histRows = readFileSync(join(stateDir, "usage-history.jsonl"), "utf8").split("\n").filter(Boolean).slice(-500).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { histRows = []; }
    return histRows;
  }
  const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]; };
  /** Per-sandbox projection for a repo: p90 mem_peak_gb / p75 cpu_avg over the last N finished sandboxes, never below the slice. */
  function estimateFor(repo, slice) {
    const rows = repo ? usageRows().filter((x) => x.repo === repo && Number.isFinite(x.mem_peak_gb) && Number.isFinite(x.cpu_avg)).slice(-(cfg.estimate_window ?? 20)) : [];
    if (rows.length < (cfg.estimate_min_samples ?? 3)) return { cpus: slice.cpus, mem: slice.mem, samples: rows.length };
    return { cpus: Math.max(slice.cpus, pct(rows.map((x) => x.cpu_avg), 0.75)), mem: Math.max(slice.mem, pct(rows.map((x) => x.mem_peak_gb), 0.9)), samples: rows.length };
  }
  const runners = () => (store.data.runners ??= {}); // #5695: name -> {label, cpus, mem_gb, startedAt}; counted like a lane
  const used = () => Object.values({ ...sb(), ...Object.fromEntries(Object.entries(runners()).map(([k, r]) => [`runner:${k}`, { cpus: r.cpus, mem_gb: r.mem_gb }])) }).filter((s) => s.state !== "exited").reduce((a, s) => ({ cpus: a.cpus + s.cpus, mem: a.mem + s.mem_gb }), { cpus: 0, mem: 0 });
  // #5535: disk figures for the router inventory; optional, omitted when unreadable. Sandbox dirs are walked at most every 60s.
  let diskCache = { at: 0, mb: {} };
  let lastWorkSweep = -Infinity;
  let lastCachePrune = -Infinity;
  // #5757: cache volume hygiene state: per-volume sweep error/size/last use (last use also from launches in this process).
  let lastCacheSweep = -Infinity;
  let lastLaunchSweep = -Infinity;
  const cacheErr = new Map(), cacheInfo = new Map(), cacheUsed = new Map(), adoptedCache = new Set(); // adoptedCache: pre-label volumes this agent mounts (labels cannot be added to an existing volume)
  const sweepFail = (v, what, e) => { const m = `${what} ${v}: ${String(e.stderr || e.message).slice(0, 200)}`; cacheErr.set(`${what}:${v}`, m); log.warn?.(m); };
  const dirMb = (d) => { let n = 0, seen = 0; const walk = (x) => { if (seen++ > 200000) return; let st; try { st = lstatSync(x); } catch { return; } n += st.size; if (st.isDirectory()) { try { for (const e of readdirSync(x)) walk(join(x, e)); } catch { /* unreadable */ } } }; walk(d); return Math.round(n / 1048576); };
  function diskView() {
    const out = {};
    try { const f = statfsSync(stateDir); out.disk_free_gb = Math.round((Number(f.bavail) * Number(f.bsize)) / 107374182.4) / 10; } catch { /* unknown */ }
    if (Date.now() - diskCache.at > 60000) {
      const mb = {};
      for (const r of Object.values(sb())) if (r.state !== "exited") {
        mb[r.id] = dirMb(join(stateDir, "sandboxes", safeName(r.id)));
        // #5891: peak size (feeds the repo's p90 reservation) and growth rate (picks the sandbox to pause)
        r.diskPeakMb = Math.max(r.diskPeakMb ?? 0, mb[r.id]);
        if (r.diskPrev && now() > r.diskPrev.at) r.growthMbH = Math.round(((mb[r.id] - r.diskPrev.mb) / ((now() - r.diskPrev.at) / 3600000)));
        r.diskPrev = { at: now(), mb: mb[r.id] };
      }
      diskCache = { at: Date.now(), mb };
    }
    out.sandbox_disk_mb = diskCache.mb;
    return out;
  }
  // #5733: free space on the Windows drive behind a WSL distro's vhdx (null off WSL or unreadable: no field, no gate).
  let hostDiskCache = { at: -Infinity, v: null };
  const readHostDisk = hostDisk ?? (() => {
    if (now() - hostDiskCache.at > 60000) hostDiskCache = { at: now(), v: hostDiskFree({ path: cfg.host_disk_path ?? null }) };
    return hostDiskCache.v;
  });
  // #5891: disk is a reserved resource. A lane reserves the p90 of its repo's measured peak sandbox_disk_mb (fallback sandbox_disk_growth_gb);
  // admission needs host free minus every reservation to stay above the floor. Host free already contains the current use.
  const floorGb = () => cfg.host_disk_floor_gb ?? cfg.min_host_disk_free_gb ?? 25;
  const hist = () => (store.data.disk_hist ??= {});
  const reservationGb = (slug) => {
    const xs = [...(hist()[slug] ?? [])].sort((a, b) => a - b);
    return xs.length >= (cfg.disk_min_samples ?? 3) ? Math.max(0.1, xs[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)] / 1024) : (cfg.sandbox_disk_growth_gb ?? 3.5);
  };
  const diskPaused = () => activeRecs().some((r) => r.diskPaused);
  const hostDiskLow = (free, active, slug = null) => free < floorGb() || diskPaused() || free - (activeRecs().reduce((a, r) => a + reservationGb(r.slug), 0) + reservationGb(slug)) < floorGb();
  const hostSamples = []; // [{t, gb}] over the last 3h: the drive's growth rate and time-to-full
  function noteHostDisk(gb) {
    const t = now();
    if (hostSamples.length && hostSamples[hostSamples.length - 1].t === t) hostSamples.pop();
    hostSamples.push({ t, gb });
    while (hostSamples.length > 2 && t - hostSamples[0].t > 3 * 3600000) hostSamples.shift();
  }
  /** GB/h the host drive shrinks (negative = freeing), or null until two samples at least a minute apart exist. */
  function hostGrowthPerH() {
    const a = hostSamples[0], b = hostSamples[hostSamples.length - 1];
    return a && b && b.t - a.t >= 60000 ? Math.round(((a.gb - b.gb) / ((b.t - a.t) / 3600000)) * 10) / 10 : null;
  }
  // #5967: free physical memory of the Windows host (neighbour WSL VMs squeeze the lane VM invisibly); null off WSL or unreadable: no field, no gate.
  let hostMemCache = { at: -Infinity, v: null };
  const readHostMem = () => {
    if (now() - hostMemCache.at >= 30000) hostMemCache = { at: now(), v: (hostMem ?? hostMemFree)() };
    return hostMemCache.v;
  };
  const memFloorGb = () => cfg.host_mem_floor_gb ?? 4;
  const memPausedRecs = () => activeRecs().filter((r) => r.memPaused);
  function hostMemView() {
    let hm = null; try { hm = readHostMem(); } catch { hm = null; }
    if (!hm || !Number.isFinite(hm.free_gb)) return {};
    return { host_mem_free_gb: hm.free_gb, host_mem_low: hm.free_gb < memFloorGb() || memPausedRecs().length > 0, host_mem_floor_gb: memFloorGb(), ...(Array.isArray(hm.vmmem) && hm.vmmem.length ? { vmmem: hm.vmmem } : {}), ...(memPausedRecs().length ? { mem_paused: memPausedRecs().length } : {}) };
  }
  let netCache = { at: -Infinity, v: null };
  const readNet = () => { if (now() - netCache.at > 60000) netCache = { at: now(), v: net() }; return netCache.v; };
  // #5884: lane disk cap (cfg.lane_disk_cap_gb, unset = off, nothing added to /capacity): sandbox dirs plus cache volumes.
  function laneDiskView() {
    if (!(Number(cfg.lane_disk_cap_gb) > 0)) return {};
    const used = laneDiskUsedGb({ sandboxMb: diskView().sandbox_disk_mb, cacheVolumes: Object.fromEntries(cacheInfo) });
    const state = planDiskCap({ usedGb: used, capGb: cfg.lane_disk_cap_gb, pruneAtPct: cfg.disk_prune_at_pct });
    return { lane_disk_used_gb: used, lane_disk_cap_gb: Number(cfg.lane_disk_cap_gb), disk_capped: state === "full" };
  }
  function hostDiskView(active, slug = null) {
    let hd = null; try { hd = readHostDisk(); } catch { hd = null; }
    if (!hd || !Number.isFinite(hd.gb)) return {};
    noteHostDisk(hd.gb);
    const g = hostGrowthPerH();
    return { host_disk_free_gb: hd.gb, host_disk_low: hostDiskLow(hd.gb, active, slug), ...(g === null ? {} : { host_disk_growth_gb_per_h: g, ...(g > 0 ? { host_disk_full_in_h: Math.round((hd.gb / g) * 10) / 10 } : {}) }), ...(diskPaused() ? { disk_paused: activeRecs().filter((r) => r.diskPaused).length } : {}) };
  }
  // #5856: priority classes. `reserved` sandboxes are admitted up to a named reservation (cfg.reservations) and may reclaim
  // capacity from `borrow` ones (throttle first, then SIGTERM so the lane checkpoints and reports run.interrupted);
  // `normal` stays out of reserved space; `borrow` may use reserved-but-idle space. Without reservations/idle_only: flat, as before.
  const PRIORITIES = ["reserved", "normal", "borrow"];
  const reservations = () => (Array.isArray(cfg.reservations) ? cfg.reservations.filter((r) => r && typeof r.name === "string" && r.cpus > 0 && r.mem_gb > 0) : []);
  const prioOf = (r) => r.priority ?? "normal";
  const peakUse = () => activeRecs().reduce((a, r) => { const e = estimateFor(r.repo ?? null, { cpus: r.cpus, mem: r.mem_gb }); return { cpus: a.cpus + Math.max(r.cpus, e.cpus), mem: a.mem + Math.max(r.mem_gb, e.mem) }; }, { cpus: 0, mem: 0 });
  // #6047: heavy tokens (cfg.elastic_lanes, default on since #6204). A lane is admitted on its base reservation; each heavy step leases a token
  // (weight = max(default, p90 history - base)) from this host's pool. Tokens live in store.data.heavy and expire with their lease,
  // when the sandbox exits or when it is destroyed.
  const elastic = () => cfg.elastic_lanes !== false; // #6204: on by default; `elastic_lanes: false` restores worst-case accounting
  const heavyTtlMs = () => (cfg.heavy_ttl_s ?? 300) * 1000;
  const heavyDefault = () => ({ cpus: cfg.heavy_weight?.cpus ?? 1, mem: cfg.heavy_weight?.mem_gb ?? 2 });
  const heavyTokens = () => (store.data.heavy ??= {});
  function heavyHeld() {
    let dropped = false;
    for (const [k, t] of Object.entries(heavyTokens())) { const r = sb()[t.sandbox]; if (t.expires <= now() || !r || r.state === "exited") { delete heavyTokens()[k]; dropped = true; } }
    if (dropped) store.save();
    return Object.values(heavyTokens()).reduce((a, t) => ({ cpus: a.cpus + t.cpus, mem: a.mem + t.mem, n: a.n + 1 }), { cpus: 0, mem: 0, n: 0 });
  }
  /** #6204: elastic admission charges a lane its measured footprint (cfg.elastic_base floor, raised to the mean live usage of the running lanes), never above what it asked for. */
  function elasticBase() {
    const fl = { cpus: cfg.elastic_base?.cpus ?? 0.4, mem: cfg.elastic_base?.mem_gb ?? 0.3 };
    const us = activeRecs().map((r) => r.usage).filter((u) => u?.samples >= 3);
    if (!us.length) return fl;
    const mean = (k) => us.reduce((a, u) => a + u[k] / u.samples, 0) / us.length;
    return { cpus: Math.max(fl.cpus, mean("cpu_sum")), mem: Math.max(fl.mem, mean("mem_sum")) };
  }
  // #6235: only a lane whose image carries the remote heavy backend (`remote`) is charged the elastic base: its heavy steps lease tokens.
  // Any other lane (a pre-1.72 image, an unlabelled image, a record from before this field) gates nothing, so it is charged what it asked for.
  const charge = (cpus, mem, base = elastic() ? elasticBase() : null, remote = false) => (base && remote ? { cpus: Math.min(cpus, base.cpus), mem: Math.min(mem, base.mem) } : { cpus, mem });
  const HEAVY_REMOTE_MIN = "1.72.0"; // first engine version whose bin/lean/heavy.mjs speaks the pool agent's /heavy route (#6047, default #6204)
  /** #6235: does this lane image carry the remote heavy backend? Read its version label (derived tools/project images inherit it); unknown fails closed. */
  const heavyCapCache = new Map(); // image -> {at, v}: launches are frequent, the label is not
  async function laneHasRemoteHeavy(img) {
    const hit = heavyCapCache.get(img);
    if (hit && now() - hit.at < 60000) return hit.v;
    const v = await laneHasRemoteHeavyNow(img);
    heavyCapCache.set(img, { at: now(), v });
    return v;
  }
  async function laneHasRemoteHeavyNow(img) {
    try {
      const v = String((await docker.imageLabel?.(img, "org.opencontainers.image.version")) ?? "").trim();
      const c = cmpVersion(v, HEAVY_REMOTE_MIN);
      if (c === null) { log.warn?.(`lane image ${img} has no engine version label; charging its lanes worst-case`); return false; }
      return c >= 0;
    } catch { return false; }
  }
  const baseUse = () => { const b = elastic() ? elasticBase() : null; return activeRecs().reduce((a, r) => { const c = charge(r.cpus, r.mem_gb, b, r.heavyRemote === true); return { cpus: a.cpus + c.cpus, mem: a.mem + c.mem }; }, { cpus: 0, mem: 0 }); };
  /** Elastic: base reservations plus held tokens; flat: each lane's projected peak (#5858). */
  const projectedUse = () => { if (!elastic()) return peakUse(); const b = baseUse(), h = heavyHeld(); return { cpus: b.cpus + h.cpus, mem: b.mem + h.mem }; };
  /** Lane ceiling derived from the token pool when elastic: a multiple of the default-weight heavy steps the host holds. */
  function derivedCeiling() {
    const e = effectiveCapacity(), w = heavyDefault();
    return Math.max(1, Math.floor(Math.min((e.cpus - coTenant.cpus) / w.cpus, (e.mem - coTenant.mem_gb) / w.mem) * (cfg.elastic_lane_factor ?? 3)));
  }
  function heavyAcquire(r) {
    const held = heavyHeld(), mine = Object.entries(heavyTokens()).find(([, t]) => t.sandbox === r.id);
    const ttl = Math.round(heavyTtlMs() / 1000);
    if (mine) { mine[1].refs = (mine[1].refs ?? 1) + 1; mine[1].expires = now() + heavyTtlMs(); store.save(); return { status: 200, body: { granted: true, token: mine[0], ttl_s: ttl } }; }
    const hm = hostMemView(); // #5967/#6235: below the floor no NEW lease is granted (a lane already holding one keeps it above), so heavy work stops before the host OOMs
    if (hm.host_mem_low) return { status: 200, body: { granted: false, retry_after_s: cfg.host_mem_retry_after_s ?? 30, reason: "host_mem", host_mem_free_gb: hm.host_mem_free_gb, floor_gb: hm.host_mem_floor_gb, held: held.n } };
    const est = estimateFor(r.repo ?? null, { cpus: r.cpus, mem: r.mem_gb }), d = heavyDefault();
    const w = { cpus: Math.max(d.cpus, est.cpus - r.cpus), mem: Math.max(d.mem, est.mem - r.mem_gb) };
    const e = effectiveCapacity(), b = baseUse(), live_ = live(cfg), ram = Number.isFinite(live_?.mem_available_gb) ? live_.mem_available_gb : Infinity;
    const fits = b.cpus + held.cpus + w.cpus <= e.cpus - coTenant.cpus + 1e-9 && b.mem + held.mem + w.mem <= e.mem - coTenant.mem_gb + 1e-9 && w.mem <= ram + 1e-9;
    if (held.n > 0 && !fits) return { status: 200, body: { granted: false, retry_after_s: 15, held: held.n } }; // the first holder always runs: a step larger than the host must not starve
    const token = randomBytes(12).toString("hex");
    heavyTokens()[token] = { sandbox: r.id, cpus: w.cpus, mem: w.mem, at: now(), refs: 1, expires: now() + heavyTtlMs() };
    store.save();
    return { status: 200, body: { granted: true, token, ttl_s: ttl, weight: { cpus: w.cpus, mem_gb: w.mem } } };
  }
  function heavyTouch(r, action, token) {
    heavyHeld();
    const t = heavyTokens()[token];
    if (!t || t.sandbox !== r.id) return { status: 200, body: { ok: action === "release", granted: false } };
    if (action === "release") { if ((t.refs = (t.refs ?? 1) - 1) <= 0) delete heavyTokens()[token]; } else t.expires = now() + heavyTtlMs();
    store.save();
    return { status: 200, body: { ok: true, granted: action === "renew" } };
  }
  function heavyView() {
    if (!elastic()) return {};
    const h = heavyHeld(), e = effectiveCapacity(), b = baseUse();
    return { elastic_lanes: true, elastic_base: { cpus: r2(elasticBase().cpus), mem_gb: r2(elasticBase().mem) }, heavy_tokens: h.n, heavy_held: { cpus: r2(h.cpus), mem_gb: r2(h.mem) }, cpus_free_elastic: r2(e.cpus - b.cpus - h.cpus - coTenant.cpus), mem_free_gb_elastic: r2(e.mem - b.mem - h.mem - coTenant.mem_gb), lanes_ceiling_derived: derivedCeiling() };
  }
  const sumRecs = (rs) => { const b = elastic() ? elasticBase() : null; return rs.reduce((a, s) => { const c = charge(s.cpus, s.mem_gb, b, s.heavyRemote === true); return { cpus: a.cpus + c.cpus, mem: a.mem + c.mem }; }, { cpus: 0, mem: 0 }); }; // #6204: elastic lanes are charged their measured base
  const weighted = () => reservations().length > 0 || Boolean(cfg.idle_only);
  const SHARES = () => ({ reserved: 4096, normal: 1024, borrow: 128, throttled: 2, ...(cfg.cpu_shares ?? {}) });
  /** Admission headroom per class: free = physical, unreserved_free = space outside every reservation, borrowable = what `borrow` may take. */
  function tiers() {
    const act = activeRecs(), rs = reservations();
    const tot = rs.reduce((a, r) => ({ cpus: a.cpus + r.cpus, mem: a.mem + r.mem_gb }), { cpus: 0, mem: 0 });
    const u = sumRecs(act), nonRes = sumRecs(act.filter((s) => prioOf(s) !== "reserved"));
    const e = effectiveCapacity();
    const free = { cpus: e.cpus - u.cpus - coTenant.cpus, mem: e.mem - u.mem - coTenant.mem_gb };
    return { act, rs, tot, free, unreserved: { cpus: Math.max(0, Math.min(free.cpus, e.cpus - tot.cpus - nonRes.cpus)), mem: Math.max(0, Math.min(free.mem, e.mem - tot.mem - nonRes.mem)) } };
  }
  /** Owner load per core with this agent's own sandboxes subtracted (the box's primary workload), or null when unknown. */
  function ownerLoad(h) {
    if (!Number.isFinite(h?.load_per_core)) return null;
    const cores = cfg.cores ?? (cpus().length || 1);
    const own = activeRecs().reduce((a, r) => a + (r.cpu_now ?? 0), 0);
    return Math.max(0, h.load_per_core - own / cores);
  }
  /** idle_only: the reason the host is not idle enough to run borrowed lanes, or null. */
  function notIdle(h) {
    if (!cfg.idle_only) return null;
    const load = ownerLoad(h), maxLoad = cfg.idle_max_owner_load_per_core ?? 0.5, minMem = cfg.idle_min_free_mem_gb ?? 4;
    if (load !== null && load > maxLoad) return `owner load ${load.toFixed(2)}/core (> ${maxLoad})`;
    if (Number.isFinite(h?.mem_available_gb) && h.mem_available_gb < minMem) return `only ${h.mem_available_gb} GB available (< ${minMem})`;
    return null;
  }
  // Throttle = low cpu weight + a halved soft memory limit (`--memory-reservation`: under host memory pressure the kernel reclaims from containers over it first; the docker CLI has no memory.high).
  const throttle = async (r, shares) => { const memMb = Math.round(r.mem_gb * (shares === SHARES().throttled ? 512 : 1024)); for (const n of r.docker ? [r.name, dindName(r.name)] : [r.name]) { try { await docker.update?.(n, { cpuShares: shares, memoryReservationMb: memMb }); } catch (e) { log.warn?.(`throttle ${n}: ${String(e.stderr || e.message).slice(0, 160)}`); } } r.throttled = shares === SHARES().throttled; };
  let lastDrain = null; // #5885: the most recent drain, for capacity().last_drain
  /** SIGTERM (the lane checkpoints and reports run.interrupted), wait out the grace, then SIGKILL; the router/dispatcher reschedules the lane. */
  async function drainOne(r, why) {
    for (const n of r.docker ? [r.name, dindName(r.name)] : [r.name]) { try { await docker.kill(n, "TERM"); } catch { /* gone */ } }
    for (let i = 0, max = Math.ceil((cfg.drain_grace_s ?? 20) * 2); i < max; i++) { const st = await docker.inspect(r.name).catch(() => null); if (!st?.running) break; await new Promise((res) => setTimeout(res, 500)); }
    try { await docker.kill(r.name, "KILL"); } catch { /* already exited */ }
    if (r.docker) { try { await docker.remove(dindName(r.name)); } catch { /* destroy retries */ } }
    r.state = "exited"; r.finishedAt = now(); r.drained = why;
    lastDrain = { reason: why, at: new Date(now()).toISOString(), sandbox: r.id }; // #5885: shown by `pool status`
    log.info?.(`drained borrowed sandbox ${r.id} (${why})`);
  }
  /** Admission by class: `{ victims }` (borrow sandboxes to reclaim, reserved only) or `{ refuse }` (a 503/400 body). */
  function admit({ prio, cpus: c, mem_gb: m, reservation, h }) {
    const t = tiers();
    if (!t.rs.length && !(cfg.idle_only && prio === "borrow")) return c > t.free.cpus || m > t.free.mem ? { refuse: { status: 503 } } : { victims: [] };
    if (prio === "borrow") {
      const why = notIdle(h);
      if (why) return { refuse: { status: 503, error: `host not idle: ${why}`, code: "pool.not_idle" } };
      return c > t.free.cpus || m > t.free.mem ? { refuse: { status: 503 } } : { victims: [] };
    }
    if (prio === "normal") return c > t.unreserved.cpus || m > t.unreserved.mem ? { refuse: { status: 503 } } : { victims: [] };
    const rv = t.rs.find((r) => r.name === reservation);
    if (!rv) return { refuse: { status: 400, error: `unknown reservation ${reservation ?? "(none)"}` } };
    const inRes = sumRecs(t.act.filter((s) => prioOf(s) === "reserved" && s.reservation === rv.name));
    if (inRes.cpus + c > rv.cpus || inRes.mem + m > rv.mem_gb) return { refuse: { status: 503, error: `reservation ${rv.name} exceeded`, code: "pool.reservation_full" } };
    let needC = c - t.free.cpus, needM = m - t.free.mem;
    const victims = [];
    for (const v of t.act.filter((s) => prioOf(s) === "borrow").sort((a, b) => b.startedAt - a.startedAt)) {
      if (needC <= 0 && needM <= 0) break;
      victims.push(v); needC -= v.cpus; needM -= v.mem_gb;
    }
    return needC > 0 || needM > 0 ? { refuse: { status: 503 } } : { victims };
  }
  /** #5885: why borrowed lanes are throttled or drained (weighted agents only, like priorityView). */
  function throttleView(h) {
    if (!weighted()) return {};
    return { idle_gate: notIdle(h), throttled: activeRecs().filter((r) => r.throttled).length, last_drain: lastDrain };
  }
  /** #5885: the owner's own pause, distinct from the resize drain's cfg.paused; a file beside the agent config keeps it across restarts. */
  const ownerPauseFile = join(cfg.config_path ? dirname(cfg.config_path) : stateDir, "owner-paused");
  let ownerPaused = existsSync(ownerPauseFile);
  function setOwnerPause(on) {
    if (on) writeFileSync(ownerPauseFile, `${new Date(now()).toISOString()}\n`, { mode: 0o600 });
    else rmSync(ownerPauseFile, { force: true });
    ownerPaused = on;
    log.info?.(`owner ${on ? "paused" : "resumed"} this agent`);
    return { status: 200, body: { ok: true, owner_paused: on, active: capacity().active } };
  }
  /** #5886: a router-pushed policy (allowlisted keys, persisted beside the agent config). Its `paused` is separate from the owner's pause: the router can set or clear only its own, never the owner's. */
  let policyPaused = Boolean(cfg.policy_paused);
  const laneS = { target: null, greenSince: null, busySince: null };
  const laneTargetOn = () => cfg.lane_autoscale !== false && Number.isInteger(cfg.max_lanes) && cfg.max_lanes >= 1;
  const laneNow = () => laneS.target ?? Math.min(cfg.max_lanes, cfg.lane_start ?? 1);
  function applyPolicy(body) {
    const p = body && typeof body === "object" ? body : {}, int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi);
    if ((p.cpus !== undefined && !int(p.cpus, 1, 256)) || (p.mem_gb !== undefined && !int(p.mem_gb, 1, 1024)) || (p.idle_only !== undefined && typeof p.idle_only !== "boolean") || (p.paused !== undefined && typeof p.paused !== "boolean") || (p.elastic_lanes !== undefined && typeof p.elastic_lanes !== "boolean")
      || (p.floors !== undefined && !(p.floors && typeof p.floors === "object" && Object.keys(p.floors).every((k) => k === "host_disk_gb" && Number.isFinite(p.floors[k]) && p.floors[k] >= 0)))) return { status: 400, body: { error: "invalid policy" } };
    const set = {};
    if (p.cpus !== undefined) set.allow_cpus = p.cpus;
    if (p.mem_gb !== undefined) set.allow_mem_gb = p.mem_gb;
    if (p.idle_only !== undefined) set.idle_only = p.idle_only;
    if (p.floors?.host_disk_gb !== undefined) set.host_disk_floor_gb = p.floors.host_disk_gb;
    if (p.paused !== undefined) set.policy_paused = p.paused;
    if (p.elastic_lanes !== undefined) set.elastic_lanes = p.elastic_lanes;
    if (cfg.config_path) {
      try { const c = JSON.parse(readFileSync(cfg.config_path, "utf8")); writeFileSync(cfg.config_path, JSON.stringify({ ...c, ...set }, null, 2), { mode: 0o600 }); }
      catch (e) { log.warn?.(`policy not persisted: ${e.message}`); }
    }
    Object.assign(cfg, set);
    if (p.paused !== undefined) policyPaused = p.paused;
    log.info?.(`policy applied: ${Object.keys(set).join(", ") || "none"}`);
    return { status: 200, body: { ok: true, applied: Object.keys(p), paused: Boolean(cfg.paused || ownerPaused || policyPaused), owner_paused: ownerPaused } };
  }
  /** #5856: reserved vs borrowable headroom for the router (only when reservations or idle_only are configured). */
  function priorityView() {
    if (!weighted()) return {};
    const t = tiers();
    return { cpus_free_unreserved: t.unreserved.cpus, mem_free_unreserved_gb: t.unreserved.mem, cpus_borrowable: Math.max(0, t.free.cpus), mem_borrowable_gb: Math.max(0, t.free.mem), ...(cfg.idle_only ? { idle_only: true } : {}),
      reservations: t.rs.map((r) => { const u = sumRecs(t.act.filter((s) => prioOf(s) === "reserved" && s.reservation === r.name)); return { name: r.name, cpus: r.cpus, mem_gb: r.mem_gb, cpus_used: u.cpus, mem_used_gb: u.mem, cpus_free: r.cpus - u.cpus, mem_free_gb: r.mem_gb - u.mem }; }) };
  }
  function capacity() {
    const u = used();
    const active = Object.values(sb()).filter((s) => s.state !== "exited").length;
    const e = effectiveCapacity();
    const h = live(cfg);
    return { host: cfg.name ?? hostname(), usage_summary: usageSummary(Object.values(sb()).filter((r) => r.state !== "exited").map(usageView)), ...running, vm: e.vm, ...(pendingResize ? { pending_resize: { cpus: pendingResize.cpus, mem_gb: pendingResize.mem_gb } } : {}), upgrading: upgrade.state, ...(upgrade.log && upgrade.state === "failed" ? { upgrade_log: upgrade.log } : {}), ...(upgrade.error ? { upgrade_error: upgrade.error } : {}), ...(prepull.error ? { prepull_error: prepull.error } : {}), ...(cacheErr.size ? { cache_sweep_error: [...cacheErr.values()][0] } : {}), ...(cacheInfo.size ? { cache_volumes: Object.fromEntries([...cacheInfo].map(([v, i]) => [v, { size_gb: Math.round(i.size_bytes / 107374182.4) / 10, ...(i.depcache_bytes ? { depcache_gb: Object.fromEntries(Object.entries(i.depcache_bytes).map(([k, b]) => [k, Math.round(b / 107374182.4) / 10])) } : {}) }])) } : {}), cpus_total: e.cpus, mem_total_gb: e.mem, cpus_free: r2(e.cpus - u.cpus - coTenant.cpus), mem_free_gb: r2(e.mem - u.mem - coTenant.mem_gb), configured: { cpus: cfg.allow_cpus, mem_gb: cfg.allow_mem_gb }, clamped: e.clamped, ...(coTenant.cpus || coTenant.mem_gb ? { cotenant: { cpus: r2(coTenant.cpus), mem_gb: r2(coTenant.mem_gb) } } : {}), active, ...priorityView(), ...throttleView(h), ...diskView(), ...laneDiskView(), ...hostDiskView(active), ...hostMemView(), ...heavyView(), runners: Object.entries(runners()).map(([name, r]) => ({ name, label: r.label })), net: (() => { const rx = netRx(now()); const n = readNet(); return rx ? { ...(n ?? {}), ...rx } : n; })(), paused: Boolean(cfg.paused || ownerPaused || policyPaused || dnsHold > 0), owner_paused: ownerPaused, ...laneTargetView(), ...(Number.isFinite(h?.load_per_core) ? { load_per_core: h.load_per_core } : {}), ...(Number.isFinite(h?.mem_available_gb) ? { mem_available_gb: h.mem_available_gb } : {}), live: h, usage: Object.fromEntries(Object.values(sb()).filter((r) => r.usage?.samples).map((r) => [r.issue ?? r.id, { ...usageView(r), state: r.state }])) };
  }

  /** The image a spec's lanes run (the per-repo lane_tools tag when tools are listed), without building it. */
  const laneBaseOf = (spec) => (spec.lane_tools?.length ? laneToolsTag(spec.image ?? image, spec.lane_tools) : (spec.image ?? image));
  const envImageOf = (spec) => (spec.project_deps?.hash ? projectLayerTag(laneBaseOf(spec), spec.project_deps.hash) : laneBaseOf(spec));
  const envEnsured = new Map(); // cache volume -> last ensure start
  /**
   * env.snapshots: start the snapshot helper for the repo, at most once per ENV_ENSURE_GAP_MS and one at a time per cache
   * volume (the fixed container name refuses a second). Never awaited by a launch and never fails one.
   */
  function ensureEnv({ volume, spec, net }) {
    if (now() - (envEnsured.get(volume) ?? -Infinity) < ENV_ENSURE_GAP_MS) return null;
    envEnsured.set(volume, now());
    const args = envEnsureArgs({ volume, image: envImageOf(spec), slug: spec.repo.slug, ref: spec.repo.ref ?? null, laneTools: spec.lane_tools ?? [], snapshots: spec.env_snapshots, net, cpus: cfg.env_build_cpus ?? 2, mem_gb: cfg.env_build_mem_gb ?? 4, agent: AGENT });
    return Promise.resolve().then(() => docker.run(args)).then(() => log.info?.(`env snapshot helper started for ${spec.repo.slug}`), (e) => log.warn?.(`env snapshot helper: ${String(e.stderr || e.message).slice(0, 200)}`));
  }

  /** #5695: start one --ephemeral runner from a JIT config (one job, then the container exits and --rm removes it). */
  async function startRunner({ name, label, jitconfig, cpus = 1, mem_gb = 2 } = {}) {
    if (typeof name !== "string" || !RUNNER_NAME.test(name) || typeof label !== "string" || !RUNNER_NAME.test(label) || typeof jitconfig !== "string" || !/^[A-Za-z0-9+/=_-]+$/.test(jitconfig)) throw Object.assign(new Error("name, label and jitconfig are required"), { status: 400 });
    if (!(cpus > 0 && mem_gb > 0)) throw Object.assign(new Error("cpus and mem_gb must be positive"), { status: 400 });
    if (runners()[name]) return { status: 200, body: { name, state: "running" } };
    const c = capacity();
    if (c.paused || c.cpus_free < cpus || c.mem_free_gb < mem_gb) return { status: 503, body: { error: "no capacity", capacity: c }, retryAfter: 60 };
    const dir = join(stateDir, "runners");
    mkdirSync(dir, { recursive: true });
    const envFile = join(dir, `${name}.env`); // the JIT config is a credential: an 0600 env file, never argv
    writeFileSync(envFile, `ACTIONS_RUNNER_INPUT_JITCONFIG=${jitconfig}\n`, { mode: 0o600 });
    try {
      await docker.run(["--rm", "--name", `cs-runner-${name}`.slice(0, 120), "--label", RUNNER_LABEL, "--label", `computeshare.runner.label=${label}`, "--cpus", String(cpus), "--memory", `${Math.round(mem_gb * 1024)}m`, "--env-file", envFile, cfg.runner_image ?? "ghcr.io/actions/actions-runner:latest", "/home/runner/run.sh"]);
    } finally { rmSync(envFile, { force: true }); }
    runners()[name] = { label, cpus, mem_gb, startedAt: now() }; store.save();
    return { status: 201, body: { name, state: "running" } };
  }
  async function stopRunner(name) {
    if (!runners()[name]) return false;
    try { await docker.remove(`cs-runner-${name}`.slice(0, 120)); } catch { /* already gone */ }
    delete runners()[name]; store.save();
    return true;
  }
  /** Forget runners whose container exited (an ephemeral runner ends after its job). */
  async function sweepRunners() {
    if (!Object.keys(runners()).length) return;
    const live = new Set(await docker.listLabelled(RUNNER_LABEL));
    for (const n of Object.keys(runners())) if (!live.has(`cs-runner-${n}`.slice(0, 120)) && now() - runners()[n].startedAt > 60000) delete runners()[n];
    store.save();
  }
  /** cgroup cpu weight per class (docker --cpu-shares); a borrowed lane yields to a reserved one under contention. */
  const sharesArgs = (prio) => (weighted() ? ["--cpu-shares", String(SHARES()[prio])] : []);

  /** The per-repo cache volume (`/cache`: worktrees, bare mirror, stores). An explicit agent_id gives this agent its own volume. */
  const cacheVolumeOf = (key) => `cs-cache-${cfg.agent_id ? `${agentId}-` : ""}${String(key ?? "default").toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
  /** #5949: dispatcher-seeded mirrors (GET /mirrors, POST /mirrors/seed); git runs in a helper container on the cache volume. */
  const mirrors = makeMirrorSeed({ seedDir: join(stateDir, "seed"), runnerFor: ({ slug, cache_key }) => {
    const volume = cacheVolumeOf(cache_key ?? slug), run = (mirrorRunner ?? dockerRunner)({ volume, image, seedDir: join(stateDir, "seed") });
    return async (script, env) => { try { await docker.createVolume?.(volume, [CACHE_LABEL, AGENT]); } catch { /* an unlabelled volume still works */ } cacheUsed.set(volume, now()); return run(script, env); };
  } });
  const seedFail = (e) => { if (e.status) throw Object.assign(new Error(e.message), { status: e.status, body: { error: e.message, ...(e.extra ?? {}) } }); throw e; };

  async function launch(req) {
    launching++;
    try { return await launchOne(req); } finally { launching--; }
  }
  async function launchOne({ spec, cpus, mem_gb, limit = null, max_lanes = null }) {
    if (typeof spec?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.id) || !Array.isArray(spec.command) || !spec.command.length) throw Object.assign(new Error("spec.id ([A-Za-z0-9._-], max 128) and spec.command are required"), { status: 400 });
    let existing = own(spec.id);
    if (existing?.drained && existing.state === "exited") { await destroy(existing.id, "drained: relaunch"); existing = null; } // #5856: the router/dispatcher rescheduled a drained lane under the same id
    if (existing?.diskPressure && existing.state === "exited") { await destroy(existing.id, "disk pressure: resume", { keepWork: true }); existing = null; } // #5891: the worktree stays, the lane adopts it
    if (existing) { existing.lease = now(); store.save(); return { status: 200, body: view(existing) }; }
    if (now() - lastLaunchSweep > 60000) { lastLaunchSweep = now(); await cacheSweep(now()).catch(() => {}); } // #5901: trim the depcache to its cap before this lane can write a new entry (throttled; the periodic sweep also runs)
    if (Number.isInteger(spec.warm)) warm.configure({ spec, cpus, mem_gb, limit, n: spec.warm }); // #4912: the lane's execution.warm_sandboxes sizes the repo's pool
    const prio = spec.priority ?? "normal";
    if (!PRIORITIES.includes(prio)) throw Object.assign(new Error(`spec.priority must be one of ${PRIORITIES.join(", ")}`), { status: 400 });
    const reservation = prio === "reserved" ? (spec.reservation ?? (reservations().length === 1 ? reservations()[0].name : null)) : null;
    const c = capacity();
    const h = live(cfg);
    const heavyRemote = elastic() ? await laneHasRemoteHeavy(spec.image ?? image) : false; // #6235
    if (dnsHold > 0 && !c.paused) return { status: 503, body: { error: "paused: docker DNS repair in progress", code: "pool.paused", capacity: capacity() }, retryAfter: 60 }; // #6244: a hold taken during the await above must stop this launch too
    const adm = admit({ prio, cpus: charge(cpus, mem_gb, undefined, heavyRemote).cpus, mem_gb: charge(cpus, mem_gb, undefined, heavyRemote).mem, reservation, h }); // #6204
    if (c.draining && !c.paused) return { status: 503, body: { error: `draining: ${c.draining_reason}`, code: "pool.draining", capacity: c }, retryAfter: 60 }; // #6061: finish running lanes, accept none
    if (laneTargetOn() && !c.paused && c.active >= laneNow()) return { status: 503, body: { error: `lane target ${laneNow()} reached (${c.active} running)`, code: "pool.lane_target", lane_target: laneNow(), capacity: c }, retryAfter: 60 };
    if (c.paused || adm.refuse) {
      const f = adm.refuse ?? {};
      if (f.status === 400) return { status: 400, body: { error: f.error } };
      return { status: 503, body: { error: f.error ?? "no capacity", ...(f.code ? { code: f.code } : {}), capacity: c }, retryAfter: 60 };
    }
    // Burst model: reservations are small, so also refuse when the VM is genuinely short of memory or overloaded right now.
    // A reserved launch skips the load gate: it must never be refused because lanes are busy (they are throttled/drained below).
    if (prio !== "reserved") { // #5858: ramp-aware: the admitted lanes' projected peaks plus this one must fit, however low the load is right now
      const e = effectiveCapacity(), pu = projectedUse(), est = elastic() ? { cpus, mem: mem_gb } : estimateFor(slugOf(spec), { cpus, mem: mem_gb }), ch = charge(cpus, mem_gb, undefined, heavyRemote), nm = elastic() ? ch.mem : Math.max(mem_gb, est.mem), nc = elastic() ? ch.cpus : Math.max(cpus, est.cpus);
      const availMem = e.mem - coTenant.mem_gb, availCpus = e.cpus - coTenant.cpus;
      if (pu.mem + nm > availMem + 1e-9 || pu.cpus + nc > availCpus + 1e-9) return { status: 503, body: { error: `projected peak ${r1(pu.mem + nm)} GB / ${r1(pu.cpus + nc)} cpus exceeds capacity ${r1(availMem)} GB / ${r1(availCpus)} cpus`, code: "pool.projected_peak", capacity: c }, retryAfter: 60 };
    }
    if (elastic() && prio !== "reserved" && !Number.isInteger(max_lanes) && activeRecs().length >= derivedCeiling()) return { status: 503, body: { error: `derived lane ceiling ${derivedCeiling()} reached`, code: "pool.host_lane_ceiling", capacity: c }, retryAfter: 60 };
    if (!h.ok && prio !== "reserved") return { status: 503, body: { error: `host busy: ${h.reason}`, code: "pool.host_load", live: h }, retryAfter: 60 };
    const gate = hostDiskView(c.active, spec.repo?.slug ?? null);
    if (gate.host_disk_low) { // #5733: before any mkdir or docker run; the lane defers on the 503 (SANDBOX_CAPACITY)
      const floor = floorGb();
      return { status: 503, body: { error: `host disk low: ${gate.host_disk_free_gb} GB free, floor ${floor} GB with ${c.active} running`, code: "pool.disk_low", host_disk_free_gb: gate.host_disk_free_gb, floor_gb: floor }, retryAfter: cfg.disk_low_retry_after_s ?? 300 };
    }
    const mg = hostMemView();
    if (mg.host_mem_low) { // #5967: after the disk gate, before any mkdir or docker run; the lane defers on the 503 (SANDBOX_CAPACITY)
      return { status: 503, body: { error: `host memory low: ${mg.host_mem_free_gb} GB free, floor ${mg.host_mem_floor_gb} GB`, code: "pool.host_mem", reason: "host_mem", host_mem_free_gb: mg.host_mem_free_gb, floor_gb: mg.host_mem_floor_gb }, retryAfter: cfg.host_mem_retry_after_s ?? 60 };
    }
    if (c.disk_capped) { // #5884: lane disk is at the hard cap; pressure prune runs in reap(), the lane defers like pool.disk_low
      return { status: 503, body: { error: `lane disk full: ${c.lane_disk_used_gb} GB of ${c.lane_disk_cap_gb} GB cap`, code: "pool.disk_cap", lane_disk_used_gb: c.lane_disk_used_gb, cap_gb: c.lane_disk_cap_gb }, retryAfter: cfg.disk_low_retry_after_s ?? 300 };
    }
    if (spec.lane_tools?.length) { // #5650 follow-up: never build inside the launch request (router timeout); 503 + retry while it builds
      let st;
      try { st = await laneImageNow({ tools: spec.lane_tools, baseImage: spec.image ?? image, docker: variantDocker(spec.image ?? image) }); } catch (e) { return { status: 422, body: { error: e.message, code: e.code ?? "lane_tools.invalid" } }; }
      if (st.building) return { status: 503, body: { error: `lane image ${st.tag} building`, code: "lane_tools.building" }, retryAfter: LANE_BUILD_RETRY_AFTER_S };
      if (st.failed) return { status: 422, body: { error: st.failed, code: "lane_tools.build_failed" } };
    }
    // #6038: the project-deps layer builds in the background; a launch never waits for it and runs the lane image meanwhile.
    let projectImage = null;
    if (spec.project_deps?.hash) {
      try {
        const st = await projectLayerImageNow({ deps: spec.project_deps, baseImage: laneBaseOf(spec), docker });
        if (st.image && st.image !== laneBaseOf(spec)) projectImage = st.image;
      } catch (e) { log.warn?.(`project layer: ${String(e.message).slice(0, 200)}`); }
    }
    // Last refusal point passed: only now stop borrowed lanes (#5897), a launch refused above must not have drained any.
    if (prio === "reserved") {
      for (const r of tiers().act.filter((s) => prioOf(s) === "borrow")) await throttle(r, SHARES().throttled); // throttle every borrower first,
      for (const v of adm.victims) await drainOne(v, `reserved ${reservation} arrived`); // then stop only as many as the reservation needs
    }
    const name = safeName(spec.id);
    const dir = join(stateDir, "sandboxes", name);
    mkdirSync(join(dir, "result"), { recursive: true });
    mkdirSync(join(dir, "out"), { recursive: true });
    if (spec.claim_dir) mkdirSync(join(dir, "claim"), { recursive: true });
    const envFile = join(dir, "env");
    const credToken = randomBytes(24).toString("hex");
    const withDocker = Boolean(spec.docker);
    const env = { ...(spec.env ?? {}), ...(withDocker ? { DOCKER_HOST: "tcp://127.0.0.1:2375" } : {}), ...(elastic() && heavyRemote ? { CS_HEAVY_BASE: `http://host.docker.internal:${cfg.listen.port}/sandboxes/${encodeURIComponent(spec.id)}/heavy` } : {}), CS_CRED_BASE: `http://host.docker.internal:${cfg.listen.port}/sandboxes/${encodeURIComponent(spec.id)}/creds`, CS_RELAY_BASE: `http://host.docker.internal:${cfg.listen.port}/sandboxes/${encodeURIComponent(spec.id)}/relay`, CS_CRED_TOKEN: credToken, CS_SANDBOX_ID: spec.id, ...cpuQuotaEnv(limit?.lane_cpus ?? cpus), CS_REPO_SLUG: spec.repo?.slug ?? "", CS_REPO_URL: spec.repo?.url ?? "", CS_REPO_REF: spec.repo?.ref ?? "", CS_RESULT_FILE: spec.result_file ?? "", CS_WORK_DIR: workDirOf(name),
      ...(spec.env_snapshots?.enabled ? { FORGE_ENV_IMAGE: envImageOf(spec) } : {}) }; // the image is part of the snapshot key
    writeFileSync(envFile, Object.entries(env).map(([k, v]) => envLine(k, v)).join("\n") + "\n", { mode: 0o600 });
    const rec = { heavyRemote, id: spec.id, name, dir, issue: spec.issue ?? null, slug: spec.repo?.slug ?? null, repo: slugOf(spec), batch: spec.batch ?? null, cpus, mem_gb, result_file: spec.result_file ?? null, state: "starting", startedAt: now(), finishedAt: null, lease: now(), credToken, docker: withDocker, ...(weighted() || spec.priority ? { priority: prio, ...(reservation ? { reservation } : {}) } : {}) };
    sb()[spec.id] = rec;
    store.save();
    rec.cacheVolume = cacheVolumeOf(spec.cache?.key ?? spec.repo?.slug); // an explicit agent_id gives this agent its own volume: a shared one would let its work sweep delete a co-resident agent's worktrees
    rec.workDir = workDirOf(name);
    cacheUsed.set(rec.cacheVolume, now());
    try { await docker.createVolume?.(rec.cacheVolume, [CACHE_LABEL, AGENT]); } catch (e) { log.warn?.(`label ${rec.cacheVolume}: ${String(e.stderr || e.message).slice(0, 200)}`); } // an unlabelled volume still works
    try { if (docker.volumeLabels && (await docker.volumeLabels(rec.cacheVolume))["computeshare.agent"] !== agentId) adoptedCache.add(rec.cacheVolume); } catch { /* best effort */ }
    // Public resolvers: host resolvers like Tailscale MagicDNS are not reachable from the container network.
    const netArgs = ["--add-host", "host.docker.internal:host-gateway", ...(cfg.dns ?? ["1.1.1.1", "8.8.8.8"]).flatMap((d) => ["--dns", String(d)])];
    let laneCpus = cpus, laneMem = mem_gb, laneNet = netArgs, work = [];
    const cacheMount = ["-v", `${rec.cacheVolume}:/cache`];
    try {
      // #5650: a repo's lane_tools select a derived image (built once per tool list); none keeps spec.image ?? image.
      const toolsImage = spec.lane_tools?.length ? await resolveLaneImage({ tools: spec.lane_tools, baseImage: spec.image ?? image, docker: variantDocker(spec.image ?? image) }) : (spec.image ?? image);
      const laneImage = projectImage ?? toolsImage; // #6038: the project layer sits on the tools image, or is skipped (base) while building
      if (withDocker) {
        // Private Docker daemon per sandbox (never the host socket). The lane joins its network namespace, so ports the
        // project's compose stack publishes are on the lane's localhost, and the API listens on loopback only. Both share
        // /work, so compose bind mounts of the checkout resolve inside the daemon too.
        let dCpus, dMem;
        if (limit) { dCpus = limit.dind_cpus; dMem = limit.dind_mem_gb; laneCpus = limit.lane_cpus; laneMem = limit.lane_mem_gb; }
        else { dCpus = Math.min(cfg.dind_cpus ?? 1, cpus - 1); dMem = Math.min(cfg.dind_mem_gb ?? 2, mem_gb - 1); laneCpus = cpus - dCpus; laneMem = mem_gb - dMem; }
        ({ cpus: dCpus, mem: dMem } = clampToVm(dCpus, dMem));
        work = cacheMount; // the daemon sees the checkout at the same /cache/work path as the lane
        await docker.run([
          "--name", dindName(name), "--label", LABEL, "--label", AGENT, "--label", `computeshare.id=${spec.id}`, "--label", "computeshare.role=dind",
          "--privileged", "--cpus", String(dCpus), ...sharesArgs(prio), "--memory", mb(dMem), "--memory-swap", mb(dMem + swapFor(limit?.dind_swap_gb)),
          ...netArgs, ...work,
          // Bypass dockerd-entrypoint: it adds tcp://0.0.0.0:2375 (reachable from other sandboxes on the bridge).
          // #5738: the lane's /work is a symlink to its work dir (entrypoint.sh), so give the daemon the same symlink:
          // bind sources under /work (`docker run -v /work/x:/y`) must resolve to the checkout, not an empty new dir.
          "--entrypoint", "sh", dindImage, "-c", DIND_BOOT, "sh", rec.workDir,
        ]);
        laneNet = ["--network", `container:${dindName(name)}`];
      }
      if (limit && !withDocker) { laneCpus = limit.lane_cpus; laneMem = limit.lane_mem_gb; }
      ({ cpus: laneCpus, mem: laneMem } = clampToVm(laneCpus, laneMem));
      await docker.run([
        "--name", name, "--label", LABEL, "--label", AGENT, "--label", `computeshare.id=${spec.id}`,
        // Hard burst cap per container; the (smaller) reservation is only what placement counts.
        // --memory-swap above --memory lets a rare spike page out instead of being OOM-killed (swap deal).
        "--cpus", String(laneCpus), ...sharesArgs(prio), "--memory", mb(laneMem), "--memory-swap", mb(laneMem + swapFor(limit?.lane_swap_gb)), "--pids-limit", "4096",
        "--init", // lane-compute audit 2026-11-26: PID 1 never reaped children (72–1408 zombies/lane in 17 min; the worst lane would reach the 4096 pid limit in ~50 min)
        "--env-file", envFile, ...laneNet, ...work,
        ...(spec.claim_dir ? ["-v", `${join(dir, "claim")}:/claim`] : []), // #4912: warm sandboxes receive their lane here
        ...(withDocker ? [] : cacheMount), "-v", `${join(dir, "result")}:/result`, "-v", `${join(dir, "out")}:/csout`,
        laneImage, ...spec.command.map(String),
      ]);
      rec.state = "running";
      if (spec.env_snapshots?.enabled && spec.repo?.slug) ensureEnv({ volume: rec.cacheVolume, spec, net: netArgs });
    } catch (e) {
      rec.state = "exited";
      rec.finishedAt = now();
      rec.error = String(e.stderr || e.message).slice(0, 500);
      log.error?.(`launch ${spec.id} failed: ${rec.error}`);
    } finally {
      rmSync(envFile, { force: true }); // secrets live only in the container's env
      store.save();
    }
    return { status: 201, body: view(rec) };
  }


  warm = makeWarm({ store, sb, own, now, launch, destroy: (id, why) => destroy(id, why), view, log });

  async function refresh(r) {
    if (r.state === "exited") return r;
    const s = await docker.inspect(r.name);
    if (!s) { r.state = "exited"; r.finishedAt ??= now(); }
    else if (!s.running && r.state !== "starting") { r.state = "exited"; r.exitCode = s.exitCode; r.finishedAt = Date.parse(s.finishedAt) || now(); }
    else if (s.running) r.state = r.diskPaused || r.memPaused ? "paused" : "running";
    return r;
  }

  function readLog(r, cursor) {
    const file = join(r.dir, "out", "lane.log");
    if (!existsSync(file)) return { text: "", cursor };
    const size = statSync(file).size;
    const from = Math.max(0, Math.min(Number(cursor) || 0, size));
    const len = Math.min(LOG_CHUNK, size - from);
    if (len <= 0) return { text: "", cursor: from };
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try { readSync(fd, buf, 0, len, from); } finally { closeSync(fd); }
    return { text: buf.toString("utf8"), cursor: from + len };
  }

  function readResult(r) {
    if (!r.result_file) return null;
    try { return JSON.parse(readFileSync(join(r.dir, "result", basename(r.result_file)), "utf8")); } catch { return null; }
  }

  /** #6117: the lane's own run log (jsonl text, newest RUNLOG_MAX bytes), copied out of the container (running or exited); "" when unavailable. */
  async function readRunLog(r) {
    if (typeof docker.copyOut !== "function") return "";
    let tmp = null;
    try {
      tmp = mkdtempSync(join(stateDir, "runlog-"));
      await docker.copyOut(r.name, RUNS_IN_SANDBOX, tmp);
      const want = new RegExp(`(^|__)${String(r.issue ?? "").replace(/[^\w.-]/g, "")}\\.jsonl$`);
      const files = readdirSync(tmp).filter((f) => want.test(f) && (() => { try { return lstatSync(join(tmp, f)).isFile(); } catch { return false; } })());
      if (!files.length) return "";
      const text = readLaneFile(join(tmp, files.sort((a, b) => lstatSync(join(tmp, b)).size - lstatSync(join(tmp, a)).size)[0]));
      if (text.length <= RUNLOG_MAX) return text;
      const cut = text.slice(-RUNLOG_MAX); return cut.slice(cut.indexOf("\n") + 1); // whole lines only
    } catch { return ""; } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  }
  /** The last TAIL_LINES lines of the sandbox's lane log (its engine stderr/stdout). */
  function logTail(r) {
    const t = readLaneFile(join(r.dir, "out", "lane.log")); return t ? t.split("\n").slice(-(TAIL_LINES + 1)).join("\n") : "";
  }
  const grave = (id) => { const g = typeof id === "string" ? graveyard.get(id) : null; if (g && g.until <= now()) { graveyard.delete(id); return null; } return g ?? null; };
  /** #6117: `{run_log, tail}` of a live sandbox, or of a destroyed one inside its grace period; null when unknown. */
  async function evidence(id) {
    const r = own(id);
    if (r) return { run_log: await readRunLog(r), tail: logTail(r) };
    const g = grave(id);
    return g ? { run_log: g.runLog, tail: g.tail } : null;
  }
  /** Keeps what a late fetch needs once the container and its dir are gone. */
  const GRAVE_MAX = 64; // destroyed sandboxes whose evidence is kept at once; the oldest goes first
  async function bury(r) {
    while (graveyard.size >= GRAVE_MAX) graveyard.delete(graveyard.keys().next().value);
    try {
      let text = "", size = 0;
      const fd = openLaneFile(join(r.dir, "out", "lane.log")); // no symlink, no FIFO: a lane can plant either (#6145 delta review)
      if (fd !== null) { try { size = fstatSync(fd).size; const len = Math.min(size, GRAVE_LOG_MAX); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); text = buf.toString("utf8"); } catch { /* no log */ } finally { closeSync(fd); } }
      graveyard.set(r.id, { until: now() + keepLogMs, log: { from: size - Buffer.byteLength(text), size, text }, tail: logTail(r), runLog: await readRunLog(r), result: readResult(r) });
    } catch { /* best effort: the destroy goes on */ }
  }
  function graveLog(g, cursor) {
    const c = Math.max(Number(cursor) || 0, g.log.from);
    if (c >= g.log.size) return { text: "", cursor: g.log.size };
    return { text: Buffer.from(g.log.text).subarray(c - g.log.from).toString("utf8"), cursor: g.log.size };
  }

  async function destroy(id, why, { keepWork = false } = {}) {
    const r = own(id);
    if (!r) return false;
    if (keepLogMs > 0) await Promise.race([bury(r), new Promise((res) => { const t = setTimeout(res, BURY_TIMEOUT_MS); t.unref?.(); })]); // #6117: before the container and its dir go; bounded so a hung copy never blocks the destroy
    if (r.slug && r.diskPeakMb) { const h = (hist()[r.slug] ??= []); h.push(r.diskPeakMb); if (h.length > 50) h.shift(); }
    const history = r.usage?.samples ? JSON.stringify({ at: new Date(now()).toISOString(), id: r.id, issue: r.issue, repo: r.repo ?? null, docker: Boolean(r.docker), minutes: Math.round((((r.finishedAt ?? now()) - r.startedAt) / 60000) * 10) / 10, ...usageView(r) }) : null;
    await docker.remove(r.name);
    if (r.docker) await docker.remove(dindName(r.name));
    if (r.workDir && keepWork) { /* #5891: a disk-pressure stop keeps the worktree and cache volume for the resumed lane */ }
    else if (r.workDir) { try { await docker.removeWorkDir(r.cacheVolume, image, r.workDir); } catch (e) { sweepFail(r.cacheVolume, "work dir", e); } }
    else if (r.docker) await docker.removeVolume(workVolume(r.name)); // sandbox launched before #5696
    try { await docker.wipe(r.dir, image); } catch (e) { log.warn?.(`wipe ${r.name}: ${String(e.stderr || e.message).slice(0, 200)}`); }
    rmSync(r.dir, { recursive: true, force: true });
    delete sb()[r.id];
    store.save();
    // Written once, after the sandbox is really gone (a teardown that throws and is retried must not log it twice).
    if (history) { try { appendFileSync(join(stateDir, "usage-history.jsonl"), history + "\n"); } catch { /* best effort */ } if (histRows) histRows.push(JSON.parse(history)); }
    log.info?.(`destroyed ${id} (${why})`);
    return true;
  }

  /** Version order of `forgedock-lane:<version>` bases, newest first (numeric segments, then plain text). */
  const newerFirst = (a, b) => b.localeCompare(a, "en", { numeric: true });
  /**
   * Removes superseded `forgedock-lane:` images: keeps the newest cfg.keep_lane_images (default 2) versions with their
   * tools variants, the running one and `alsoKeep`, and any tag a container (running or exited) still uses. Never throws.
   */
  async function pruneLaneImages(alsoKeep = []) {
    if (!docker.listImages || !docker.removeImage) return;
    try {
      const prefix = laneImageTag("");
      const tags = await docker.listImages(prefix);
      const inUse = new Set(await (docker.listContainerImages?.() ?? []));
      const baseOf = (t) => t.replace(/-t[0-9a-f]{12}$/, "");
      const bases = [...new Set(tags.map(baseOf))].sort(newerFirst);
      const keepN = Math.max(1, Number(cfg.keep_lane_images ?? 2) || 2);
      const keep = [...bases.slice(0, keepN), laneImageTag(running.version), image, ...alsoKeep];
      for (const t of tags) {
        if (keep.some((b) => isLaneToolsTagOf(t, b) || isProjectLayerTagOf(t, b)) || inUse.has(t)) continue;
        try { await docker.removeImage(t); log.info?.(`removed superseded lane image ${t}`); } catch (e) { log.warn?.(`rmi ${t}: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
    } catch (e) { log.warn?.(`lane image prune: ${String(e.stderr || e.message).slice(0, 200)}`); }
  }
  /** Interval-gated build cache trim and sweep of dangling anonymous volumes (64-hex names); errors are logged only. */
  async function sweepBuildCache(t) {
    if (t - lastCachePrune < (cfg.build_cache_interval_s ?? 6 * 3600) * 1000) return;
    lastCachePrune = t;
    try { await docker.builderPrune?.(cfg.build_cache_keep_gb ?? 20); } catch (e) { log.warn?.(`builder prune: ${String(e.stderr || e.message).slice(0, 200)}`); }
    try {
      for (const v of (await docker.listDanglingVolumes?.(AGENT)) ?? []) {
        if (!/^[0-9a-f]{64}$/.test(v)) continue;
        try { await docker.removeVolume(v); log.info?.(`removed anonymous volume ${v.slice(0, 12)}`); } catch (e) { log.warn?.(`rm volume ${v.slice(0, 12)}: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
    } catch (e) { log.warn?.(`anonymous volume sweep: ${String(e.stderr || e.message).slice(0, 200)}`); }
  }

  /** Cache volumes the sweeps cover: those labelled for this agent plus pre-label ones it mounts (adopted or referenced by a sandbox record). */
  async function ownCacheVolumes() {
    const labelled = await docker.listVolumes("cs-cache-", AGENT);
    const mine = new Set([...adoptedCache, ...Object.values(sb()).map((r) => r.cacheVolume).filter(Boolean)]);
    if (!mine.size) return labelled;
    const all = await docker.listVolumes("cs-cache-");
    return [...new Set([...labelled, ...all.filter((v) => mine.has(v))])];
  }

  /** #5757: age-out / size cap inside each cache volume, then idle eviction. Never-evict volumes are left alone; failures go to /capacity. */
  async function cacheSweep(t) {
    const never = cfg.cache_never_evict ?? [];
    const keep = Object.values(sb()).map((r) => r.workDir).filter(Boolean);
    const volumes = [];
    for (const v of await ownCacheVolumes()) {
      if (never.includes(v)) continue;
      try {
        const r = await docker.sweepCache(v, image, { maxAgeDays: cfg.cache_max_age_days ?? 14, maxGb: cfg.cache_max_gb ?? null, maxDepcacheGb: cfg.depcache_max_gb ?? 40, keep, now: t });
        cacheInfo.set(v, r); cacheErr.delete(`cache sweep:${v}`);
        if (r.errors?.length) cacheErr.set(`cache sweep:${v}`, `cache sweep ${v}: ${r.errors[0]}`);
        volumes.push({ name: v, lastUsedMs: Math.max(r.last_used_ms ?? -Infinity, cacheUsed.get(v) ?? -Infinity) });
      } catch (e) { sweepFail(v, "cache sweep", e); }
    }
    const referenced = new Set(Object.values(sb()).map((r) => r.cacheVolume).filter(Boolean));
    for (const v of planIdleEviction({ volumes: volumes.map((x) => ({ ...x, lastUsedMs: Number.isFinite(x.lastUsedMs) ? x.lastUsedMs : null })), referenced, neverEvict: never, now: t, idleMs: (cfg.cache_idle_days ?? 30) * 86400000 })) {
      try { await docker.removeVolume(v); cacheInfo.delete(v); cacheUsed.delete(v); log.info?.(`evicted idle cache volume ${v}`); } catch (e) { sweepFail(v, "cache evict", e); }
    }
  }

  /** Each reap: lift the throttle once no reserved sandbox runs; under idle_only, throttle borrowed lanes when the owner's load rises, then drain the newest. */
  async function reclaimIdle() {
    if (!weighted()) return;
    const act = activeRecs(), borrowed = act.filter((r) => prioOf(r) === "borrow");
    const busy = notIdle(live(cfg));
    if (busy) {
      const fresh = borrowed.filter((r) => !r.throttled);
      if (fresh.length) { for (const r of fresh) await throttle(r, SHARES().throttled); return; } // throttle first,
      const v = borrowed.sort((a, b) => b.startedAt - a.startedAt)[0];
      if (v) await drainOne(v, `owner busy: ${busy}`); // one per pass, only if throttling was not enough
      return;
    }
    if (!act.some((r) => prioOf(r) === "reserved")) for (const r of borrowed.filter((x) => x.throttled)) await throttle(r, SHARES().borrow);
  }


  // #5891: runtime disk control, once per reap. Below the floor: prune rebuildables, then pause the fastest grower (lease kept),
  // then below floor/2 stop it with sandbox.disk_pressure (worktree + volume kept). Above floor + margin: unpause.
  const freshHostDisk = () => { if (!hostDisk) hostDiskCache.at = -Infinity; try { const hd = readHostDisk(); return hd && Number.isFinite(hd.gb) ? hd.gb : null; } catch { return null; } };
  const cntNames = (r) => (r.docker ? [r.name, dindName(r.name)] : [r.name]);
  /** Removes the exited container(s) of sandboxes dead for ttlMs (their data stays for a resume), and orphan fdrsbx-* volumes. Never cs-cache-*. */
  async function reapDead(t, ttlMs) {
    for (const r of Object.values(sb())) {
      if (r.state !== "exited" || r.containerReaped || !r.finishedAt || t - r.finishedAt < ttlMs) continue;
      try { for (const n of cntNames(r)) await docker.remove(n); r.containerReaped = true; log.info?.(`removed dead sandbox container ${r.name}`); } catch (e) { log.warn?.(`reap ${r.name}: ${String(e.stderr || e.message).slice(0, 200)}`); }
    }
    const names = Object.values(sb()).flatMap((r) => [r.id, r.name]); // a volume named after a known sandbox stays for its resume
    try {
      for (const v of (await docker.listVolumes?.("fdrsbx-")) ?? []) {
        if (!v.startsWith("fdrsbx-") || v.startsWith("cs-cache-") || names.some((n) => v === n || v.startsWith(`${n}-`) || v.startsWith(`${n}_`))) continue;
        try { await docker.removeVolume(v); log.info?.(`removed dead sandbox volume ${v}`); } catch (e) { log.warn?.(`rm volume ${v}: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
    } catch (e) { log.warn?.(`dead volume sweep: ${String(e.stderr || e.message).slice(0, 200)}`); }
  }
  async function reclaimDisk(t) {
    try { await docker.builderPrune?.(0); } catch (e) { log.warn?.(`builder prune: ${String(e.stderr || e.message).slice(0, 200)}`); }
    try { await docker.pruneImages?.(); } catch (e) { log.warn?.(`image prune: ${String(e.stderr || e.message).slice(0, 200)}`); }
    const heavy = activeRecs().sort((a, b) => (diskCache.mb[b.id] ?? 0) - (diskCache.mb[a.id] ?? 0)).slice(0, cfg.disk_reclaim_sandboxes ?? 3);
    for (const r of heavy) { try { await docker.pruneCaches?.(r.name); } catch { /* best effort: package-manager caches only */ } }
    await reapDead(t, 0);
  }
  async function hostDiskPressure(t) {
    let free = freshHostDisk();
    if (free === null) { await reapDead(t, (cfg.dead_ttl_s ?? 600) * 1000); return; }
    noteHostDisk(free);
    const floor = floorGb(), hard = floor / 2;
    if (free >= floor) {
      await reapDead(t, (cfg.dead_ttl_s ?? 600) * 1000);
      if (free >= floor + (cfg.disk_resume_margin_gb ?? 2)) for (const r of activeRecs().filter((x) => x.diskPaused)) {
        try { for (const n of cntNames(r)) await docker.unpause?.(n); r.diskPaused = false; r.state = "running"; log.info?.(`resumed ${r.id}: host disk ${free} GB`); } catch (e) { log.warn?.(`unpause ${r.id}: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
      for (const r of activeRecs().filter((x) => x.diskPaused)) r.lease = t;
      return;
    }
    await reclaimDisk(t);
    free = freshHostDisk() ?? free;
    if (free >= floor) return; // pruning was enough: nothing paused or stopped
    let victim = activeRecs().find((r) => r.diskPaused);
    if (!victim) {
      victim = activeRecs().filter((r) => r.state === "running").sort((a, b) => (b.growthMbH ?? 0) - (a.growthMbH ?? 0) || (diskCache.mb[b.id] ?? 0) - (diskCache.mb[a.id] ?? 0))[0];
      if (victim) { try { for (const n of cntNames(victim)) await docker.pause?.(n); victim.diskPaused = true; victim.state = "paused"; log.warn?.(`paused ${victim.id} (disk): host free ${free} GB < floor ${floor} GB`); } catch (e) { log.warn?.(`pause ${victim.id}: ${String(e.stderr || e.message).slice(0, 200)}`); victim = null; } }
    }
    for (const r of activeRecs().filter((x) => x.diskPaused)) r.lease = t; // the paused lane stays leased: it is not lost
    if (victim && free < hard) { // the guest is about to fill: stop it to save every other sandbox; worktree and volume stay
      for (const n of cntNames(victim)) { try { await docker.unpause?.(n); } catch { /* not paused */ } }
      for (const n of cntNames(victim)) { try { await docker.kill(n, "KILL"); } catch { /* gone */ } }
      victim.diskPaused = false; victim.state = "exited"; victim.finishedAt = t; victim.diskPressure = true;
      log.error?.(`stopped ${victim.id} (sandbox.disk_pressure): host free ${free} GB < ${hard} GB`);
    }
  }
  // #5967: runtime host-memory control, once per reap. Below floor/2 pause the newest running sandbox (lease kept); at floor + margin resume.
  async function hostMemPressure(t) {
    hostMemCache.at = -Infinity;
    let hm = null; try { hm = readHostMem(); } catch { hm = null; }
    if (!hm || !Number.isFinite(hm.free_gb)) return;
    const free = hm.free_gb, floor = memFloorGb();
    for (const r of memPausedRecs()) r.lease = t; // a paused lane stays leased: it is not lost
    if (free >= floor + (cfg.host_mem_resume_margin_gb ?? 1)) {
      for (const r of memPausedRecs()) {
        try { for (const n of cntNames(r)) await docker.unpause?.(n); r.memPaused = false; r.state = r.diskPaused ? "paused" : "running"; log.info?.(`resumed ${r.id}: host memory ${free} GB`); } catch (e) { log.warn?.(`unpause ${r.id}: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
      return;
    }
    if (free >= floor / 2 || memPausedRecs().length) return; // one paused sandbox at a time; resumes only above floor + margin
    const victim = activeRecs().filter((r) => r.state === "running").sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!victim) return;
    try { for (const n of cntNames(victim)) await docker.pause?.(n); victim.memPaused = true; victim.state = "paused"; victim.lease = t; log.warn?.(`paused ${victim.id} (memory): host free ${free} GB < ${floor / 2} GB`); } catch (e) { log.warn?.(`pause ${victim.id}: ${String(e.stderr || e.message).slice(0, 200)}`); }
  }
  /** #5884: at the prune threshold of lane_disk_cap_gb prune this agent's own leftovers and sweep caches; fstrim on an interval and after a prune. Log lines only. */
  let lastFstrim = -Infinity;
  async function diskPressure(t) {
    const v = laneDiskView();
    const state = "lane_disk_cap_gb" in v ? planDiskCap({ usedGb: v.lane_disk_used_gb, capGb: v.lane_disk_cap_gb, pruneAtPct: cfg.disk_prune_at_pct }) : "ok";
    if (state !== "ok") {
      log.warn?.(`lane disk ${v.lane_disk_used_gb}/${v.lane_disk_cap_gb} GB (${state}): pruning`);
      for (const [what, fn] of [["container prune", docker.containerPrune], ["image prune", docker.imagePrune]]) {
        try { await fn?.call(docker, OWN); } catch (e) { log.warn?.(`${what}: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
      try { await docker.builderPrune?.(cfg.build_cache_keep_gb ?? 20); } catch (e) { log.warn?.(`builder prune: ${String(e.stderr || e.message).slice(0, 200)}`); }
      lastCacheSweep = t;
      await cacheSweep(t);
    }
    if (cfg.fstrim === false || !fstrimDue({ now: t, last: lastFstrim, intervalS: cfg.fstrim_interval_s, force: state !== "ok" })) return;
    lastFstrim = t;
    const r = await trim({ root: cfg.docker_root });
    if (!r.ok) log.warn?.(`fstrim: ${r.error}`);
  }

  // #6061: per-worker lane target, evaluated once per reap. Active only with an integer cfg.max_lanes (the ceiling) unless cfg.lane_autoscale is false.
  // Draining refuses new launches only; running lanes are never stopped here (drainOne stays for idle_only borrowed lanes).
  function laneDrain() {
    const paused = Boolean(cfg.paused || ownerPaused || policyPaused);
    return drainState({ paused, ownerPaused, policyPaused, busyForMs: laneS.busySince === null ? 0 : now() - laneS.busySince, drainAfterMs: (cfg.drain_busy_s ?? 300) * 1000 });
  }
  function laneTargetView() {
    const d = laneDrain();
    return { draining: d.draining, ...(d.reason ? { draining_reason: d.reason } : {}), accepting: !d.draining, ...(laneTargetOn() ? { lane_target: laneNow(), lane_ceiling: cfg.max_lanes } : {}) };
  }
  function laneTick() {
    const h = live(cfg), t = now();
    laneS.busySince = pressured(h) ? (laneS.busySince ?? t) : null;
    if (!laneTargetOn()) { laneS.target = null; return; }
    const r = laneStep({ target: laneNow(), ceiling: cfg.max_lanes, live: h, now: t, greenSince: laneS.greenSince, holdMs: (cfg.lane_hold_s ?? 60) * 1000 });
    laneS.target = r.target; laneS.greenSince = r.greenSince;
    if (r.change) log.info?.(`lane target ${r.change} to ${r.target}/${cfg.max_lanes}`);
  }

  async function reap() {
    const t = now();
    for (const id of [...graveyard.keys()]) grave(id); // #6117: expired grace entries go
    for (const r of Object.values(sb())) {
      try { await refresh(r); } catch { /* docker hiccup: judge by lease only */ }
      const why = t - r.lease > leaseTtlMs && !r.diskPaused && !r.memPaused ? "lease expired" : t - r.startedAt > maxLifeMs ? "max lifetime" : r.state === "exited" && r.finishedAt && t - r.finishedAt > (r.diskPressure ? keepPressureMs : keepExitedMs) ? "exited retention" : null;
      if (why) await destroy(r.id, why);
    }
    await hostDiskPressure(t); // #5891
    await hostMemPressure(t); // #5967
    const known = new Set(Object.values(sb()).flatMap((r) => [r.name, dindName(r.name)]));
    for (const name of await docker.listLabelled(OWN)) if (!known.has(name)) { await docker.remove(name); log.info?.(`removed orphan container ${name}`); }
    await sweepRunners().catch((e) => log.warn?.(`runner sweep: ${e.message}`));
    await sampleUsage();
    await reclaimIdle();
    laneTick(); // #6061
    await warm.maintain(maxLifeMs);
    if (pendingResize && capacity().active === 0) {
      const r = await resize(pendingResize);
      log.info?.(`pending resize applied: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    }
    const knownVols = new Set(Object.values(sb()).filter((r) => !r.workDir).map((r) => workVolume(r.name)));
    for (const v of await docker.listVolumes("cs-work-", AGENT)) if (!knownVols.has(v)) { await docker.removeVolume(v); log.info?.(`removed orphan volume ${v}`); }
    if (t - lastWorkSweep >= WORK_SWEEP_MS) {
      lastWorkSweep = t;
      const keep = Object.values(sb()).map((r) => r.workDir).filter(Boolean);
      for (const v of await ownCacheVolumes()) {
        try { await docker.pruneWorkDirs(v, image, keep); cacheErr.delete(`work sweep:${v}`); } catch (e) { sweepFail(v, "work sweep", e); }
      }
    }
    await sweepBuildCache(t);
    try { await diskPressure(t); } catch (e) { log.warn?.(`disk pressure: ${String(e.message).slice(0, 200)}`); }
    if (t - lastCacheSweep >= (cfg.cache_sweep_interval_s ?? 3600) * 1000) {
      lastCacheSweep = t;
      await cacheSweep(t);
    }
    store.save();
  }

  // GitHub credentials for a running sandbox: fetched from the router on demand (installation tokens expire hourly).
  const credCache = {};
  const CRED_TTL = { github: 120000, claude: 300000 };
  const sandboxAuthed = (id, req) => {
    const r = own(id);
    const m = /^Bearer\s+(\S.*)$/i.exec(req.headers.authorization ?? "");
    return Boolean(r && r.state !== "exited" && m && sameSecret(m[1].trim(), r.credToken));
  };
  const SANDBOX_UNAUTHORIZED = { status: 401, body: { error: "unauthorized", hop: "agent", reason: "agent auth: bad sandbox credential" } };
  async function sandboxCred(id, kind, req) {
    if (!sandboxAuthed(id, req)) return SANDBOX_UNAUTHORIZED;
    if (!CRED_TTL[kind]) return { status: 404, body: { error: "unknown credential" } };
    const c = credCache[kind];
    if (!c || now() - c.at > CRED_TTL[kind]) {
      const x = await call(cfg.router_url, "GET", `/agent/creds/${kind}`, { token: cfg.token, timeoutMs: 20000 });
      // #5165: every router login at its usage ceiling -> pass the typed 429 (reason, reset) through, uncached, so the lane defers.
      if (x.status === 429 && x.data && typeof x.data === "object") return { status: 429, body: x.data, retryAfter: x.retryAfter };
      if (!x.ok || !x.data?.token) return { status: 502, body: { error: `router credentials (${kind}): HTTP ${x.status}` } };
      credCache[kind] = { token: x.data.token, account: Number.isInteger(x.data.account) ? x.data.account : null, at: now() };
    }
    return { status: 200, body: { token: credCache[kind].token, ...(credCache[kind].account !== null && credCache[kind].account !== undefined ? { account: credCache[kind].account } : {}) } };
  }
  /** #5205: a sandbox's lane hit a usage limit: drop the cached claude token and tell the router to exclude that account. */
  async function sandboxCredLimited(id, req, body) {
    if (!sandboxAuthed(id, req)) return SANDBOX_UNAUTHORIZED;
    const b = body && typeof body === "object" ? body : {};
    if (!Number.isInteger(b.account) || credCache.claude?.account === b.account) delete credCache.claude; // another sandbox's account stays cached
    const x = await call(cfg.router_url, "POST", "/agent/creds/claude/limited", { body: { reset_at: b.reset_at ?? null, account: b.account ?? null }, token: cfg.token, timeoutMs: 20000 });
    return { status: x.ok ? 200 : x.status || 502, body: x.data && typeof x.data === "object" ? x.data : {} };
  }

  // #4778: read-only capability relay. The sandbox's request is forwarded to the router queue with the agent token; the
  // dispatching host runs (or refuses) it. This agent never executes the command.
  async function sandboxRelay(id, rid, req) {
    const r = own(id);
    const m = /^Bearer\s+(\S.*)$/i.exec(req.headers.authorization ?? "");
    if (!r || r.state === "exited" || !m || !sameSecret(m[1].trim(), r.credToken)) return { status: 401, body: { error: "unauthorized", hop: "agent", reason: "agent auth: bad sandbox credential" } };
    const lane = r.alias ?? r.id; // #4935: a claimed warm sandbox posts under its warm id, but the router queue and the dispatcher use the lane id
    const path = `/agent/relay/${encodeURIComponent(lane)}${rid ? `/${encodeURIComponent(rid)}` : ""}`;
    const x = rid ? await call(cfg.router_url, "GET", path, { token: cfg.token, timeoutMs: 20000 })
      : await call(cfg.router_url, "POST", path, { token: cfg.token, timeoutMs: 20000, body: { argv: (await readJson(req, 32 * 1024))?.argv } });
    return { status: x.status, body: x.data };
  }

  /** Pull the current bundle from the router, rebuild the lane image if its recipe changed, then restart (systemd). */
  async function selfUpdate() {
    if (upgrade.state === "running") return;
    upgrade.state = "running"; upgrade.error = null;
    const root = cfg.code_root ?? repoRoot;
    const next = `${root}.new`, tgz = join(stateDir, "bundle.tar.gz");
    try {
      const res = await fetch(`${String(cfg.router_url).replace(/\/+$/, "")}/agent/bundle`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`bundle download: HTTP ${res.status}`);
      writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
      rmSync(next, { recursive: true, force: true }); mkdirSync(next, { recursive: true });
      await run("tar", ["-xzf", tgz, "-C", next]);
      const want = versionOf(next);
      if (want.image !== running.image || want.version !== running.version) {
        const nextImage = cfg.image && cfg.image !== "computeshare-lane:1" ? cfg.image : laneImageTag(want.version);
        log.info?.(`rebuilding ${nextImage} (${running.version}/${running.image} -> ${want.version}/${want.image})`);
        // #6166: present (pre-seeded) -> pull the published image -> local build only as the fallback
        const pub = nextImage === laneImageTag(want.version) ? await fetchDigest(want.version) : null; // #6185: pull by the publisher-recorded digest
        const how = await provideLaneImage({ docker, image: nextImage, version: want.version, recipe: want.image, digest: pub?.digest, publishable: nextImage === laneImageTag(want.version), log, pinOpts,
          build: () => buildWithRetry(() => docker.build(join(next, "pool", "image"), nextImage, laneBuildArgs(want.version, want.image)), { log }) }); // #5919
        log.info?.(`${nextImage}: ${how}`);
      }
      await pruneLaneImages([laneImageTag(want.version)]);
      await prepullImages();
      rmSync(`${root}.old`, { recursive: true, force: true });
      await run("mv", [root, `${root}.old`]);
      await run("mv", [next, root]);
      log.info?.(`updated to ${JSON.stringify(want)}; restarting`);
      upgrade.state = "restarting";
      setTimeout(() => process.exit(0), 500);
    } catch (e) {
      upgrade.state = "failed"; upgrade.error = upgradeErrorText(e); // #5919: the tail, where the failing command's output is
      try { writeFileSync(join(stateDir, "upgrade.log"), `${new Date(now()).toISOString()}\n${upgradeErrorText(e, 200000)}\n`); upgrade.log = join(stateDir, "upgrade.log"); } catch { /* best effort */ }
      log.error?.(`self-update failed: ${upgrade.error}`);
    }
  }

  /**
   * Change this host's lane allowance. On WSL also rewrite the Windows-side .wslconfig VM caps (processors/memory) and
   * restart WSL (the keep-alive task brings the distro back); only while no sandbox is active.
   */
  /** Peak and average CPU (cores) and memory (GB) per sandbox, lane + docker sidecar, against what it reserved. */
  async function sampleUsage() {
    let st;
    try { st = await docker.stats?.(OWN); } catch { return; }
    if (!st) return;
    try { // #5858: containers that are not this agent's sandboxes (all containers minus the labelled ones and known sandboxes)
      const all = await docker.stats?.([]);
      if (all) {
        const mine = new Set([...Object.keys(st), ...Object.values(sb()).flatMap((r) => [r.name, dindName(r.name)])]);
        const others = Object.entries(all).filter(([n]) => !mine.has(n)).map(([, x]) => x);
        coTenant = { cpus: others.reduce((a, x) => a + (x.cpu || 0), 0), mem_gb: others.reduce((a, x) => a + (x.mem_gb || 0), 0) };
      }
    } catch { /* keep the last reading */ }
    for (const r of Object.values(sb())) {
      if (r.state === "exited") continue;
      const parts = [st[r.name], r.docker ? st[dindName(r.name)] : null].filter(Boolean);
      if (!parts.length) continue;
      const cpu = parts.reduce((a, x) => a + x.cpu, 0), mem = parts.reduce((a, x) => a + x.mem_gb, 0);
      r.cpu_now = cpu;
      const u = (r.usage ??= { samples: 0, cpu_sum: 0, cpu_peak: 0, mem_sum: 0, mem_peak: 0 });
      u.samples++; u.cpu_sum += cpu; u.mem_sum += mem; u.cpu_peak = Math.max(u.cpu_peak, cpu); u.mem_peak = Math.max(u.mem_peak, mem);
    }
    store.save();
  }
  async function resize(body) {
    const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
    const cpus = int(body.cpus, 1, 256), mem = int(body.mem_gb, 1, 1024), vmCpus = int(body.vm_cpus ?? body.cpus, 1, 256), vmMem = int(body.vm_mem_gb ?? (body.mem_gb + 2), 2, 1024);
    if (!cpus || !mem || !vmCpus || !vmMem || vmCpus < cpus || vmMem <= mem) return { status: 400, body: { error: "need integers cpus, mem_gb (and vm_cpus >= cpus, vm_mem_gb > mem_gb)" } };
    if (capacity().active > 0) {
      if (!body.drain) return { status: 409, body: { error: "sandboxes are running; retry when idle, or pass drain: true", active: capacity().active } };
      // Drain: take no new sandboxes, let the running ones finish, then apply (the reaper loop checks).
      pendingResize = { ...body, drain: false };
      cfg.paused = true;
      log.info?.(`resize pending: draining ${capacity().active} sandbox(es) first`);
      return { status: 202, body: { ok: true, draining: capacity().active, pending: { cpus, mem_gb: mem, vm_cpus: vmCpus, vm_mem_gb: vmMem } } };
    }
    pendingResize = null;
    cfg.paused = false;
    let wsl = null;
    let release = ""; try { release = readFileSync("/proc/sys/kernel/osrelease", "utf8"); } catch { /* not linux */ }
    if (/microsoft/i.test(release)) {
      const users = (() => { try { return readdirSync("/mnt/c/Users"); } catch { return []; } })();
      const file = users.map((u) => join("/mnt/c/Users", u, ".wslconfig")).find((f) => existsSync(`${f}.computeshare-backup`) || (existsSync(f) && /vmIdleTimeout/i.test(readFileSync(f, "utf8"))));
      if (!file) return { status: 500, body: { error: "could not find the .wslconfig the installer manages" } };
      const want = { processors: String(vmCpus), memory: `${vmMem}GB`, ...(int(body.vm_swap_gb, 0, 512) !== null ? { swap: `${body.vm_swap_gb}GB` } : {}) };
      const out = []; let inWsl2 = false; const seen = {};
      for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
        const sec = /^\s*\[(.+)\]\s*$/.exec(l);
        if (sec) { if (inWsl2) for (const k of Object.keys(want)) if (!seen[k]) { out.push(`${k}=${want[k]}`); seen[k] = true; } inWsl2 = sec[1].trim().toLowerCase() === "wsl2"; out.push(l); continue; }
        const kv = inWsl2 && /^\s*([A-Za-z]+)\s*=/.exec(l);
        const k = kv && Object.keys(want).find((x) => x.toLowerCase() === kv[1].toLowerCase());
        if (k) { out.push(`${k}=${want[k]}`); seen[k] = true; continue; }
        out.push(l);
      }
      if (inWsl2) for (const k of Object.keys(want)) if (!seen[k]) out.push(`${k}=${want[k]}`);
      writeFileSync(file, out.join("\r\n"));
      wsl = file;
    }
    if (cfg.config_path) {
      const c = JSON.parse(readFileSync(cfg.config_path, "utf8"));
      c.allow_cpus = cpus; c.allow_mem_gb = mem;
      writeFileSync(cfg.config_path, JSON.stringify(c, null, 2), { mode: 0o600 });
    }
    cfg.allow_cpus = cpus; cfg.allow_mem_gb = mem;
    log.info?.(`resized: lanes ${cpus} CPU / ${mem} GB${wsl ? `; ${wsl} -> ${vmCpus} CPU / ${vmMem}GB, restarting WSL` : ""}`);
    if (wsl) {
      // systemd services lack WSL_INTEROP; point it at a live interop socket so wsl.exe can run.
      const sock = (() => { try { return readdirSync("/run/WSL").filter((f) => f.endsWith("_interop")).map((f) => join("/run/WSL", f)).sort().pop(); } catch { return null; } })();
      setTimeout(() => {
        const child = spawn("/mnt/c/Windows/System32/wsl.exe", ["--shutdown"], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, ...(sock ? { WSL_INTEROP: sock } : {}) } });
        child.unref();
      }, 1500);
    }
    return { status: 202, body: { ok: true, lanes: { cpus, mem_gb: mem }, ...(wsl ? { vm: { cpus: vmCpus, mem_gb: vmMem }, wsl_restart: true } : {}) } };
  }

  const routes = [
    [route("GET", "/health"), async () => ({ status: 200, body: { ok: true, ...capacity() } })],
    [route("GET", "/mirrors"), async (_p, _b, url) => ({ status: 200, body: await mirrors.tips({ slug: url.searchParams.get("slug"), cache_key: url.searchParams.get("cache_key"), upload: url.searchParams.get("upload"), uploader: url.searchParams.get("uploader") }).catch(seedFail) })], // #5949
    [route("POST", "/mirrors/seed"), async (_p, body) => { try { return { status: 200, body: body?.finish ? await mirrors.finish(body) : mirrors.chunk(body) }; } catch (e) { return { status: e.status ?? 500, body: { error: e.message, ...(e.extra ?? {}) } }; } }],
    [route("GET", "/capacity"), async () => ({ status: 200, body: capacity() })],
    [route("POST", "/sandboxes"), async (_p, body) => { const r = await launch(body ?? {}); if (Number.isInteger(body?.spec?.warm)) warm.replenish().catch((e) => log.warn?.(`warm replenish: ${e.message}`)); return r; }],
    [route("POST", "/runners"), async (_p, body) => startRunner(body ?? {})], // #5695
    [route("DELETE", "/runners/:name"), async ({ name }) => ((await stopRunner(name)) ? { status: 200, body: { ok: true } } : { status: 404, body: { state: "gone" } })],
    [route("GET", "/warm"), async () => ({ status: 200, body: { warm: warm.list() } })],
    [route("POST", "/warm"), async (_p, body) => { const r = warm.configure({ ...(body ?? {}), n: body?.n }); await warm.replenish(); return { status: 200, body: { ...r, warm: warm.list() } }; }],
    [route("POST", "/warm/claim"), async (_p, body) => warm.claim(body ?? {})],
    [route("GET", "/sandboxes/:id"), async ({ id }) => { const r = own(id); if (!r) return { status: 404, body: { state: "gone" } }; await refresh(r); store.save(); return { status: 200, body: view(r) }; }],
    [route("GET", "/sandboxes/:id/logs"), async ({ id }, _b, url) => { const r = own(id), g = !r && grave(id); return r ? { status: 200, body: readLog(r, url.searchParams.get("cursor")) } : g ? { status: 200, body: graveLog(g, url.searchParams.get("cursor")) } : { status: 404, body: { text: "", cursor: 0 } }; }],
    [route("GET", "/sandboxes/:id/runlog"), async ({ id }) => { const e = await evidence(id); return e ? { status: 200, body: e } : { status: 404, body: { error: "no run log" } }; }], // #6117
    [route("GET", "/sandboxes/:id/result"), async ({ id }) => { const r = own(id); const x = r ? readResult(r) : grave(id)?.result; if (!x && r?.drained) return { status: 200, body: { drained: true, reason: r.drained } }; if (!x && r?.diskPressure) return { status: 200, body: { disk_pressure: true, code: "sandbox.disk_pressure", reason: "host drive below the hard floor" } }; /* #5891 */ return x ? { status: 200, body: x } : { status: 404, body: { error: "no result" } }; }], // #5856: a drained lane without its own result is reported so the dispatcher reschedules it
    [route("GET", "/sandboxes/:id/usage"), async ({ id }) => { const r = own(id); return r ? { status: 200, body: { minutes: Math.round((((r.finishedAt ?? now()) - r.startedAt) / 60000) * 10) / 10 } } : { status: 404, body: {} }; }],
    [route("POST", "/sandboxes/:id/lease"), async ({ id }) => { const r = own(id); if (!r) return { status: 404, body: { state: "gone" } }; r.lease = now(); store.save(); return { status: 200, body: { ok: true } }; }],
    // #5274: SIGTERM the lane (PID 1) so its teardown checkpoints and reports deferred run.interrupted; the sandbox is kept, never destroyed.
    [route("POST", "/sandboxes/:id/stop"), async ({ id }) => {
      const r = own(id);
      if (!r) return { status: 404, body: { state: "gone" } };
      await refresh(r);
      if (r.state === "exited") return { status: 200, body: { ok: true, state: "exited" } };
      await docker.kill(r.name, "TERM");
      return { status: 202, body: { ok: true, state: "stopping" } };
    }],
    [route("GET", "/usage-history"), async () => {
      let rows = [];
      try { rows = readFileSync(join(stateDir, "usage-history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
      return { status: 200, body: { rows: rows.slice(-500) } };
    }],
    [route("POST", "/admin/resize"), async (_p, body) => resize(body ?? {})],
    [route("POST", "/admin/policy"), async (_p, body) => applyPolicy(body)], // #5886
    [route("POST", "/pause"), async () => setOwnerPause(true)], // #5885: box-local `forgedock pool pause`; running lanes finish
    [route("POST", "/resume"), async () => setOwnerPause(false)],
    [route("POST", "/admin/update"), async () => { selfUpdate(); return { status: 202, body: { ok: true, from: running } }; }],
    [route("DELETE", "/sandboxes/:id"), async ({ id }) => ((await destroy(id, "requested")) ? { status: 200, body: { ok: true } } : { status: 404, body: { state: "gone" } })],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, "http://agent");
    try {
      const cred = req.method === "GET" && /^\/sandboxes\/([^/]+)\/creds\/([a-z]+)$/.exec(url.pathname);
      if (cred) { const r = await sandboxCred(decodeURIComponent(cred[1]), cred[2], req); return send(res, r.status, r.body, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {}); }
      const limited = req.method === "POST" && /^\/sandboxes\/([^/]+)\/creds\/claude\/limited$/.exec(url.pathname); // #5205
      if (limited) { const r = await sandboxCredLimited(decodeURIComponent(limited[1]), req, await readJson(req)); return send(res, r.status, r.body); }
      const heavy = req.method === "POST" && /^\/sandboxes\/([^/]+)\/heavy\/(acquire|release|renew)$/.exec(url.pathname); // #6047
      if (heavy) {
        const id = decodeURIComponent(heavy[1]);
        if (!sandboxAuthed(id, req)) return send(res, SANDBOX_UNAUTHORIZED.status, SANDBOX_UNAUTHORIZED.body);
        const body = await readJson(req, 4096), r0 = own(id), r = heavy[2] === "acquire" ? heavyAcquire(r0) : heavyTouch(r0, heavy[2], body?.token);
        return send(res, r.status, r.body);
      }
      const relay = (req.method === "POST" && /^\/sandboxes\/([^/]+)\/relay$/.exec(url.pathname)) || (req.method === "GET" && /^\/sandboxes\/([^/]+)\/relay\/([^/]+)$/.exec(url.pathname));
      if (relay) { const r = await sandboxRelay(decodeURIComponent(relay[1]), relay[2] ? decodeURIComponent(relay[2]) : null, req); return send(res, r.status, r.body ?? {}); }
      if (url.pathname !== "/health" && !bearerOk(req, cfg.token)) return send(res, 401, { error: "unauthorized", hop: "agent", reason: "agent auth: router token rejected by agent" });
      for (const [match, fn] of routes) {
        const p = match(req, url);
        if (!p) continue;
        const body = req.method === "POST" ? await readJson(req) : null;
        const r = await fn(p, body, url);
        return send(res, r.status, r.body, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      log.error?.(e);
      send(res, e.status ?? 500, { error: e.status ? e.message : "internal error" });
    }
  }

  /** Build the lane image for the running ForgeDock version when this host does not have it yet. */
  async function ensureImage() {
    const pub = image === laneImageTag(running.version) && !(await docker.hasImage?.(image)) ? await fetchDigest(running.version) : null; // #6185
    await provideLaneImage({ docker, image, version: running.version, recipe: running.image, digest: pub?.digest, publishable: image === laneImageTag(running.version), log, pinOpts,
      build: () => docker.build(join(cfg.code_root ?? repoRoot, "pool", "image"), image, laneBuildArgs(running.version, running.image)) });
    await pruneLaneImages();
  }

  return { handle, launch, warm, reap, destroy, capacity, refresh, store, prepullImages, ensureImage, evidence, graveLog: (id, cursor) => { const g = grave(id); return g ? graveLog(g, cursor) : null; } };
}

/**
 * WSL with mirrored networking often has no IPv6 default route, yet dockerd still dials registries over IPv6 and fails
 * ("network is unreachable"). Turn IPv6 off inside the distro (persistently) and restart docker while it is idle.
 */
export async function wslNetworkFixup({ run: runCmd = run, log = console, idle = () => true, pin = ensureNatPin } = {}) {
  let release = "";
  try { release = readFileSync("/proc/sys/kernel/osrelease", "utf8"); } catch { return "not linux"; }
  if (!/microsoft/i.test(release)) return "not wsl";
  try { const p = pin(); if (p?.applied) log.info?.(`WSL mirrored: pinned docker NAT source ports to ${p.range} (${p.applied} rules)`); } catch (e) { log.warn?.(`NAT port pin failed: ${e.message}`); }
  try {
    const { stdout } = await runCmd("ip", ["-6", "route", "show", "default"]);
    if (String(stdout).trim()) return "ipv6 route present";
  } catch { /* no ip tool or no route: treat as missing */ }
  const conf = "net.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\n";
  try { if (readFileSync("/etc/sysctl.d/90-computeshare-noipv6.conf", "utf8") === conf) return "already applied"; } catch { /* first time */ }
  writeFileSync("/etc/sysctl.d/90-computeshare-noipv6.conf", conf);
  await runCmd("sysctl", ["-p", "/etc/sysctl.d/90-computeshare-noipv6.conf"]);
  if (idle()) await runCmd("systemctl", ["restart", "docker"], { timeout: 120000 });
  log.info?.("WSL: IPv6 disabled in the distro (no IPv6 route); docker restarted for IPv4 registry pulls");
  return "applied";
}

/**
 * #5882: outbound-only transport. Long-polls the router (`GET /agent/poll`, which doubles as the heartbeat), runs each queued
 * request against this agent's own bearer-checked HTTP API and posts the answer to `/agent/reply/:rid`. The router never dials in.
 * `dispatch` defaults to a loopback call on cfg.listen; tests inject their own.
 */
export function startPoll(cfg, { log = console, fetchFn = globalThis.fetch, waitS = 25, dispatch = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let stopped = false, backoff = 1000;
  const host = !cfg.listen?.host || cfg.listen.host === "0.0.0.0" ? "127.0.0.1" : cfg.listen.host;
  const local = dispatch ?? ((m, path, body) => call(`http://${host}:${cfg.listen.port}`, m, path, { body, token: cfg.token, timeoutMs: 180000 }));
  const reply = (rid, r) => call(cfg.router_url, "POST", `/agent/reply/${encodeURIComponent(rid)}`, { body: { status: r.status, data: r.data, retry_after: r.retryAfter ?? null }, token: cfg.token, timeoutMs: 30000, fetchFn });
  async function serve({ rid, method, path, body }) {
    let r;
    if (typeof path !== "string" || !/^\/(?!\/)/.test(path) || !["GET", "POST", "DELETE"].includes(method)) r = { status: 400, data: { error: "bad request" } };
    else r = await local(method, path, body).catch((e) => ({ status: 502, data: { error: `agent local dispatch failed: ${e.message}` } }));
    await reply(rid, r).catch((e) => log.warn?.(`poll reply ${rid}: ${e.message}`));
  }
  const done = (async () => {
    while (!stopped) {
      try {
        const r = await call(cfg.router_url, "GET", `/agent/poll?wait=${waitS}`, { token: cfg.token, timeoutMs: (waitS + 15) * 1000, fetchFn });
        if (r.status !== 204 && (!r.ok || !r.data?.rid)) throw new Error(`poll HTTP ${r.status}`);
        backoff = 1000;
        if (r.status !== 204) serve(r.data).catch((e) => log.warn?.(`poll serve: ${e.message}`));
      } catch (e) {
        if (stopped) break;
        log.warn?.(`router poll failed: ${e.message}; retry in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  })();
  return { stop: () => { stopped = true; }, done };
}

export function startAgent(cfg, deps) {
  const agent = createAgent(cfg, deps);
  const server = createServer(agent.handle);
  server.listen(cfg.listen.port, cfg.listen.host);
  const timer = setInterval(() => agent.reap().catch((e) => console.error("reap failed", e)), (cfg.reap_interval_s ?? 30) * 1000);
  agent.reap().catch((e) => console.error("startup reap failed", e));
  agent.ensureImage().catch((e) => console.error("lane image build failed", e));
  wslNetworkFixup({ idle: () => agent.capacity().active === 0 })
    .catch((e) => console.error("wsl network fixup failed", e))
    .finally(() => agent.prepullImages());
  // #5882: outbound mode keeps the local listener for the lanes' credential calls (bind it to the docker bridge, not a public interface).
  const poll = cfg.outbound ? startPoll(cfg, { log: deps?.log }) : null;
  return { agent, server, close: () => { clearInterval(timer); poll?.stop(); server.close(); } };
}

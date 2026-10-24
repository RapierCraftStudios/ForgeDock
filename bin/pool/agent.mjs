// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cpus, hostname } from "node:os";
import { bearerOk, call, readJson, route, sameSecret, send } from "./http.mjs";
import { repoRoot, versionOf, laneImageTag, laneBuildArgs } from "./version.mjs";
import { jsonStore } from "./store.mjs";

const LABEL = "computeshare=1";
const LOG_CHUNK = 256 * 1024;
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
export const workVolume = (name) => `cs-work-${name.replace(/^cs-/, "")}`;
export const safeName = (id) => `cs-${String(id).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 100)}`;
const envLine = (k, v) => `${k}=${String(v).replace(/\r?\n/g, " ")}`;

/**
 * Host agent: runs each sandbox as one docker container inside a fixed reservation (allow_cpus / allow_mem_gb).
 * A sandbox lives only while its lease is renewed; the reaper removes expired, over-age and orphaned containers.
 */
export function createAgent(cfg, { docker, now = () => Date.now(), log = console, live = liveHeadroom } = {}) {
  const stateDir = cfg.state_dir;
  const store = jsonStore(join(stateDir, "state.json"), { sandboxes: {} });
  const sb = () => store.data.sandboxes;
  const leaseTtlMs = (cfg.lease_ttl_s ?? 600) * 1000;
  const maxLifeMs = (cfg.max_lifetime_s ?? 6 * 3600) * 1000;
  const keepExitedMs = (cfg.keep_exited_s ?? 2 * 3600) * 1000;
  const running = versionOf(cfg.code_root ?? repoRoot);
  // The lane image tracks the installed ForgeDock version; only an explicit non-legacy cfg.image overrides it.
  const image = cfg.image && cfg.image !== "computeshare-lane:1" ? cfg.image : laneImageTag(running.version);
  const upgrade = { state: "idle", error: null };
  const prepull = { error: null };
  const dindImage = cfg.dind_image ?? "docker:27.5.1-dind";
  /** Images a sandbox may need are pulled ahead of time, never inside a launch request (which has a short timeout). */
  async function prepullImages() {
    if (await docker.hasImage?.(dindImage)) { prepull.error = null; return; }
    try { await docker.pull(dindImage); prepull.error = null; return; }
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
  const used = () => Object.values(sb()).filter((s) => s.state !== "exited").reduce((a, s) => ({ cpus: a.cpus + s.cpus, mem: a.mem + s.mem_gb }), { cpus: 0, mem: 0 });
  function capacity() {
    const u = used();
    return { host: cfg.name ?? hostname(), ...running, vm: vmSize(), ...(pendingResize ? { pending_resize: { cpus: pendingResize.cpus, mem_gb: pendingResize.mem_gb } } : {}), upgrading: upgrade.state, ...(upgrade.error ? { upgrade_error: upgrade.error } : {}), ...(prepull.error ? { prepull_error: prepull.error } : {}), cpus_total: cfg.allow_cpus, mem_total_gb: cfg.allow_mem_gb, cpus_free: cfg.allow_cpus - u.cpus, mem_free_gb: cfg.allow_mem_gb - u.mem, active: Object.values(sb()).filter((s) => s.state !== "exited").length, paused: Boolean(cfg.paused), live: live(cfg), usage: Object.fromEntries(Object.values(sb()).filter((r) => r.usage?.samples).map((r) => [r.issue ?? r.id, { ...usageView(r), state: r.state }])) };
  }

  async function launch({ spec, cpus, mem_gb, limit = null }) {
    if (!spec?.id || !Array.isArray(spec.command) || !spec.command.length) throw Object.assign(new Error("spec.id and spec.command are required"), { status: 400 });
    const existing = sb()[spec.id];
    if (existing) { existing.lease = now(); store.save(); return { status: 200, body: view(existing) }; }
    const c = capacity();
    if (c.paused || c.cpus_free < cpus || c.mem_free_gb < mem_gb) return { status: 503, body: { error: "no capacity", capacity: c }, retryAfter: 60 };
    // Burst model: reservations are small, so also refuse when the VM is genuinely short of memory or overloaded right now.
    const h = live(cfg);
    if (!h.ok) return { status: 503, body: { error: `host busy: ${h.reason}`, live: h }, retryAfter: 60 };
    const name = safeName(spec.id);
    const dir = join(stateDir, "sandboxes", name);
    mkdirSync(join(dir, "result"), { recursive: true });
    mkdirSync(join(dir, "out"), { recursive: true });
    const envFile = join(dir, "env");
    const credToken = randomBytes(24).toString("hex");
    const withDocker = Boolean(spec.docker);
    const env = { ...(spec.env ?? {}), ...(withDocker ? { DOCKER_HOST: "tcp://127.0.0.1:2375" } : {}), CS_CRED_BASE: `http://host.docker.internal:${cfg.listen.port}/sandboxes/${encodeURIComponent(spec.id)}/creds`, CS_CRED_TOKEN: credToken, CS_SANDBOX_ID: spec.id, CS_REPO_SLUG: spec.repo?.slug ?? "", CS_REPO_URL: spec.repo?.url ?? "", CS_REPO_REF: spec.repo?.ref ?? "", CS_RESULT_FILE: spec.result_file ?? "" };
    writeFileSync(envFile, Object.entries(env).map(([k, v]) => envLine(k, v)).join("\n") + "\n", { mode: 0o600 });
    const rec = { id: spec.id, name, dir, issue: spec.issue ?? null, batch: spec.batch ?? null, cpus, mem_gb, result_file: spec.result_file ?? null, state: "starting", startedAt: now(), finishedAt: null, lease: now(), credToken, docker: withDocker };
    sb()[spec.id] = rec;
    store.save();
    const cacheKey = String(spec.cache?.key ?? spec.repo?.slug ?? "default").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
    // Public resolvers: host resolvers like Tailscale MagicDNS are not reachable from the container network.
    const netArgs = ["--add-host", "host.docker.internal:host-gateway", ...(cfg.dns ?? ["1.1.1.1", "8.8.8.8"]).flatMap((d) => ["--dns", String(d)])];
    let laneCpus = cpus, laneMem = mem_gb, laneNet = netArgs, work = [];
    try {
      if (withDocker) {
        // Private Docker daemon per sandbox (never the host socket). The lane joins its network namespace, so ports the
        // project's compose stack publishes are on the lane's localhost, and the API listens on loopback only. Both share
        // /work, so compose bind mounts of the checkout resolve inside the daemon too.
        let dCpus, dMem;
        if (limit) { dCpus = limit.dind_cpus; dMem = limit.dind_mem_gb; laneCpus = limit.lane_cpus; laneMem = limit.lane_mem_gb; }
        else { dCpus = Math.min(cfg.dind_cpus ?? 1, cpus - 1); dMem = Math.min(cfg.dind_mem_gb ?? 2, mem_gb - 1); laneCpus = cpus - dCpus; laneMem = mem_gb - dMem; }
        ({ cpus: dCpus, mem: dMem } = clampToVm(dCpus, dMem));
        work = ["-v", `${workVolume(name)}:/work`];
        await docker.run([
          "--name", dindName(name), "--label", LABEL, "--label", `computeshare.id=${spec.id}`, "--label", "computeshare.role=dind",
          "--privileged", "--cpus", String(dCpus), "--memory", mb(dMem), "--memory-swap", mb(dMem + swapFor(limit?.dind_swap_gb)),
          ...netArgs, ...work,
          // Bypass dockerd-entrypoint: it adds tcp://0.0.0.0:2375 (reachable from other sandboxes on the bridge).
          "--entrypoint", "dind", dindImage, "dockerd", "--host=tcp://127.0.0.1:2375", "--tls=false",
        ]);
        laneNet = ["--network", `container:${dindName(name)}`];
      }
      if (limit && !withDocker) { laneCpus = limit.lane_cpus; laneMem = limit.lane_mem_gb; }
      ({ cpus: laneCpus, mem: laneMem } = clampToVm(laneCpus, laneMem));
      await docker.run([
        "--name", name, "--label", LABEL, "--label", `computeshare.id=${spec.id}`,
        // Hard burst cap per container; the (smaller) reservation is only what placement counts.
        // --memory-swap above --memory lets a rare spike page out instead of being OOM-killed (swap deal).
        "--cpus", String(laneCpus), "--memory", mb(laneMem), "--memory-swap", mb(laneMem + swapFor(limit?.lane_swap_gb)), "--pids-limit", "4096",
        "--env-file", envFile, ...laneNet, ...work,
        "-v", `cs-cache-${cacheKey}:/cache`, "-v", `${join(dir, "result")}:/result`, "-v", `${join(dir, "out")}:/csout`,
        spec.image ?? image, ...spec.command.map(String),
      ]);
      rec.state = "running";
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

  const view = (r) => ({ id: r.id, state: r.state, issue: r.issue, cpus: r.cpus, mem_gb: r.mem_gb, started_at: new Date(r.startedAt).toISOString(), ...(r.error ? { error: r.error } : {}) });

  async function refresh(r) {
    if (r.state === "exited") return r;
    const s = await docker.inspect(r.name);
    if (!s) { r.state = "exited"; r.finishedAt ??= now(); }
    else if (!s.running && r.state !== "starting") { r.state = "exited"; r.exitCode = s.exitCode; r.finishedAt = Date.parse(s.finishedAt) || now(); }
    else if (s.running) r.state = "running";
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

  async function destroy(id, why) {
    const r = sb()[id];
    if (!r) return false;
    const history = r.usage?.samples ? JSON.stringify({ at: new Date(now()).toISOString(), id: r.id, issue: r.issue, docker: Boolean(r.docker), minutes: Math.round((((r.finishedAt ?? now()) - r.startedAt) / 60000) * 10) / 10, ...usageView(r) }) : null;
    await docker.remove(r.name);
    if (r.docker) { await docker.remove(dindName(r.name)); await docker.removeVolume(workVolume(r.name)); }
    try { await docker.wipe(r.dir, image); } catch (e) { log.warn?.(`wipe ${r.name}: ${String(e.stderr || e.message).slice(0, 200)}`); }
    rmSync(r.dir, { recursive: true, force: true });
    delete sb()[id];
    store.save();
    // Written once, after the sandbox is really gone (a teardown that throws and is retried must not log it twice).
    if (history) { try { appendFileSync(join(stateDir, "usage-history.jsonl"), history + "\n"); } catch { /* best effort */ } }
    log.info?.(`destroyed ${id} (${why})`);
    return true;
  }

  async function reap() {
    const t = now();
    for (const r of Object.values(sb())) {
      try { await refresh(r); } catch { /* docker hiccup: judge by lease only */ }
      const why = t - r.lease > leaseTtlMs ? "lease expired" : t - r.startedAt > maxLifeMs ? "max lifetime" : r.state === "exited" && r.finishedAt && t - r.finishedAt > keepExitedMs ? "exited retention" : null;
      if (why) await destroy(r.id, why);
    }
    const known = new Set(Object.values(sb()).flatMap((r) => [r.name, dindName(r.name)]));
    for (const name of await docker.listLabelled(LABEL)) if (!known.has(name)) { await docker.remove(name); log.info?.(`removed orphan container ${name}`); }
    await sampleUsage();
    if (pendingResize && capacity().active === 0) {
      const r = await resize(pendingResize);
      log.info?.(`pending resize applied: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    }
    const knownVols = new Set(Object.values(sb()).map((r) => workVolume(r.name)));
    for (const v of await docker.listVolumes("cs-work-")) if (!knownVols.has(v)) { await docker.removeVolume(v); log.info?.(`removed orphan volume ${v}`); }
    store.save();
  }

  // GitHub credentials for a running sandbox: fetched from the router on demand (installation tokens expire hourly).
  const credCache = {};
  const CRED_TTL = { github: 120000, claude: 300000 };
  async function sandboxCred(id, kind, req) {
    const r = sb()[id];
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!r || r.state === "exited" || !m || !sameSecret(m[1].trim(), r.credToken)) return { status: 401, body: { error: "unauthorized" } };
    if (!CRED_TTL[kind]) return { status: 404, body: { error: "unknown credential" } };
    const c = credCache[kind];
    if (!c || now() - c.at > CRED_TTL[kind]) {
      const x = await call(cfg.router_url, "GET", `/agent/creds/${kind}`, { token: cfg.token, timeoutMs: 20000 });
      if (!x.ok || !x.data?.token) return { status: 502, body: { error: `router credentials (${kind}): HTTP ${x.status}` } };
      credCache[kind] = { token: x.data.token, at: now() };
    }
    return { status: 200, body: { token: credCache[kind].token } };
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
        await docker.build(join(next, "pool", "image"), nextImage, laneBuildArgs(want.version));
      }
      await prepullImages();
      rmSync(`${root}.old`, { recursive: true, force: true });
      await run("mv", [root, `${root}.old`]);
      await run("mv", [next, root]);
      log.info?.(`updated to ${JSON.stringify(want)}; restarting`);
      upgrade.state = "restarting";
      setTimeout(() => process.exit(0), 500);
    } catch (e) {
      upgrade.state = "failed"; upgrade.error = String(e.stderr || e.message).slice(0, 500);
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
    try { st = await docker.stats?.(LABEL); } catch { return; }
    if (!st) return;
    for (const r of Object.values(sb())) {
      if (r.state === "exited") continue;
      const parts = [st[r.name], r.docker ? st[dindName(r.name)] : null].filter(Boolean);
      if (!parts.length) continue;
      const cpu = parts.reduce((a, x) => a + x.cpu, 0), mem = parts.reduce((a, x) => a + x.mem_gb, 0);
      const u = (r.usage ??= { samples: 0, cpu_sum: 0, cpu_peak: 0, mem_sum: 0, mem_peak: 0 });
      u.samples++; u.cpu_sum += cpu; u.mem_sum += mem; u.cpu_peak = Math.max(u.cpu_peak, cpu); u.mem_peak = Math.max(u.mem_peak, mem);
    }
    store.save();
  }
  const usageView = (r) => {
    const u = r.usage; const f = (x) => Math.round(x * 100) / 100;
    return u?.samples ? { reserved: { cpus: r.cpus, mem_gb: r.mem_gb }, cpu_avg: f(u.cpu_sum / u.samples), cpu_peak: f(u.cpu_peak), mem_avg_gb: f(u.mem_sum / u.samples), mem_peak_gb: f(u.mem_peak), samples: u.samples } : null;
  };
  let pendingResize = null;
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
        const child = spawn("/mnt/c/Windows/System32/wsl.exe", ["--shutdown"], { detached: true, stdio: "ignore", env: { ...process.env, ...(sock ? { WSL_INTEROP: sock } : {}) } });
        child.unref();
      }, 1500);
    }
    return { status: 202, body: { ok: true, lanes: { cpus, mem_gb: mem }, ...(wsl ? { vm: { cpus: vmCpus, mem_gb: vmMem }, wsl_restart: true } : {}) } };
  }

  const routes = [
    [route("GET", "/health"), async () => ({ status: 200, body: { ok: true, ...capacity() } })],
    [route("GET", "/capacity"), async () => ({ status: 200, body: capacity() })],
    [route("POST", "/sandboxes"), async (_p, body) => launch(body ?? {})],
    [route("GET", "/sandboxes/:id"), async ({ id }) => { const r = sb()[id]; if (!r) return { status: 404, body: { state: "gone" } }; await refresh(r); store.save(); return { status: 200, body: view(r) }; }],
    [route("GET", "/sandboxes/:id/logs"), async ({ id }, _b, url) => { const r = sb()[id]; return r ? { status: 200, body: readLog(r, url.searchParams.get("cursor")) } : { status: 404, body: { text: "", cursor: 0 } }; }],
    [route("GET", "/sandboxes/:id/result"), async ({ id }) => { const r = sb()[id]; const x = r && readResult(r); return x ? { status: 200, body: x } : { status: 404, body: { error: "no result" } }; }],
    [route("GET", "/sandboxes/:id/usage"), async ({ id }) => { const r = sb()[id]; return r ? { status: 200, body: { minutes: Math.round((((r.finishedAt ?? now()) - r.startedAt) / 60000) * 10) / 10 } } : { status: 404, body: {} }; }],
    [route("POST", "/sandboxes/:id/lease"), async ({ id }) => { const r = sb()[id]; if (!r) return { status: 404, body: { state: "gone" } }; r.lease = now(); store.save(); return { status: 200, body: { ok: true } }; }],
    [route("GET", "/usage-history"), async () => {
      let rows = [];
      try { rows = readFileSync(join(stateDir, "usage-history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
      return { status: 200, body: { rows: rows.slice(-500) } };
    }],
    [route("POST", "/admin/resize"), async (_p, body) => resize(body ?? {})],
    [route("POST", "/admin/update"), async () => { selfUpdate(); return { status: 202, body: { ok: true, from: running } }; }],
    [route("DELETE", "/sandboxes/:id"), async ({ id }) => ((await destroy(id, "requested")) ? { status: 200, body: { ok: true } } : { status: 404, body: { state: "gone" } })],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, "http://agent");
    try {
      const cred = req.method === "GET" && /^\/sandboxes\/([^/]+)\/creds\/([a-z]+)$/.exec(url.pathname);
      if (cred) { const r = await sandboxCred(decodeURIComponent(cred[1]), cred[2], req); return send(res, r.status, r.body); }
      if (url.pathname !== "/health" && !bearerOk(req, cfg.token)) return send(res, 401, { error: "unauthorized" });
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
    if (await docker.hasImage?.(image)) return;
    log.info?.(`building ${image}`);
    await docker.build(join(cfg.code_root ?? repoRoot, "pool", "image"), image, laneBuildArgs(running.version));
  }

  return { handle, launch, reap, destroy, capacity, refresh, store, prepullImages, ensureImage };
}

/**
 * WSL with mirrored networking often has no IPv6 default route, yet dockerd still dials registries over IPv6 and fails
 * ("network is unreachable"). Turn IPv6 off inside the distro (persistently) and restart docker while it is idle.
 */
export async function wslNetworkFixup({ run: runCmd = run, log = console, idle = () => true } = {}) {
  let release = "";
  try { release = readFileSync("/proc/sys/kernel/osrelease", "utf8"); } catch { return "not linux"; }
  if (!/microsoft/i.test(release)) return "not wsl";
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
  return { agent, server, close: () => { clearInterval(timer); server.close(); } };
}

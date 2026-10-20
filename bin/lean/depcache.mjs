// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared dependency cache (#4220): lanes on one lock hash share one install. Layout under the root
 * (`FORGE_DEPCACHE_ROOT` or `~/.forge/depcache`):
 *   <repoKey>/<eco>-<key>/            published snapshot: the trees (node_modules dirs at their relative paths, or .venv)
 *                                     + manifest.json {eco,key,prefix,trees,created} + last-used. Files are read-only and
 *                                     never written again; lanes get hardlinks, so an in-place write fails instead of
 *                                     corrupting it.
 *   <repoKey>/<eco>-<key>.lock        per-key lock {host,pid,created} (open "wx"; a dead or expired holder is stale)
 *   <repoKey>/<eco>-<key>.tmp-<pid>   snapshot being published (atomic rename into place)
 *   stores/{pnpm-store,npm-cache,uv-cache,poetry-cache,pip-cache}   the package managers' own shared stores
 * The repo's own package manager does every install (frozen lockfile). Every effect is injected; nothing here throws:
 * a missing tool, another filesystem (EXDEV) or a failed install leaves the lane as it was before.
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { safeSegment } from "./ledger.mjs";

export const depcacheRoot = (env = process.env) => String(env.FORGE_DEPCACHE_ROOT ?? "").trim() || join(homedir(), ".forge", "depcache");
export const DEPCACHE_INSTALL_TIMEOUT_MS = 15 * 60000;
export const DEPCACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const STORES = "stores";
const SNAP_RE = /^(pnpm|npm|yarn|uv|poetry)-[0-9a-f]{16}$/;
const TMP_RE = /^(pnpm|npm|yarn|uv|poetry)-[0-9a-f]{16}\.tmp-(\d+)$/;
const LOCK_RE = /^(pnpm|npm|yarn|uv|poetry)-[0-9a-f]{16}\.lock$/;

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const msg = (e) => String(e?.stderr || e?.message || e).trim().split("\n").slice(-3).join(" ").slice(0, 300);

/** Lockfile -> ecosystem, in priority order: at most one JS and one Python ecosystem per repo. */
function detect(fs, wt) {
  const has = (f) => fs.existsSync(join(wt, f));
  const out = [];
  if (has("pnpm-lock.yaml")) out.push({ eco: "pnpm", lock: "pnpm-lock.yaml" });
  else if (has("package-lock.json")) out.push({ eco: "npm", lock: "package-lock.json" });
  else if (has("npm-shrinkwrap.json")) out.push({ eco: "npm", lock: "npm-shrinkwrap.json" });
  else if (has("yarn.lock")) {
    const rc = has(".yarnrc.yml") ? String(fs.readFileSync(join(wt, ".yarnrc.yml"))) : null;
    // Yarn berry defaults to Plug'n'Play (no node_modules): only cache it with an explicit node-modules linker.
    const pnp = has(".pnp.cjs") || (rc !== null && !/^\s*nodeLinker:\s*["']?(node-modules|pnpm)/m.test(rc));
    out.push(pnp ? { eco: "yarn", lock: "yarn.lock", skip: "yarn Plug'n'Play has no node_modules" } : { eco: "yarn", lock: "yarn.lock", berry: rc !== null });
  }
  if (has("uv.lock")) out.push({ eco: "uv", lock: "uv.lock" });
  else if (has("poetry.lock")) out.push({ eco: "poetry", lock: "poetry.lock" });
  return out;
}

const JS = new Set(["pnpm", "npm", "yarn"]);
/** Full frozen install on a miss, and the warm no-op repair pass on a hit (null: nothing path-dependent to repair). */
function commands(d) {
  switch (d.eco) {
    case "pnpm": return { install: [["pnpm", ["install", "--frozen-lockfile"]]], repair: [["pnpm", ["install", "--frozen-lockfile", "--offline"]]] };
    // npm/yarn node_modules hold only relative links; npm's hidden lockfile is rewritten in place, which the read-only
    // snapshot (correctly) refuses, so they get no repair pass.
    case "npm": return { install: [["npm", ["ci", "--no-audit", "--no-fund"]]], repair: null };
    case "yarn": return { install: [["yarn", ["install", d.berry ? "--immutable" : "--frozen-lockfile"]]], repair: null };
    case "uv": return { install: [["uv", ["venv", "--relocatable", ".venv"]], ["uv", ["sync", "--frozen"]]], repair: [["uv", ["sync", "--frozen"]]] };
    case "poetry": return { install: [["poetry", ["install", "--sync"]]], repair: [["poetry", ["install", "--sync"]]] };
    default: return null;
  }
}

/**
 * @param {object} [o]
 * @param {string} [o.root]   cache root (default FORGE_DEPCACHE_ROOT or ~/.forge/depcache)
 * @param {Function} o.exec   (cmd, args, {cwd, env, timeoutMs}) => Promise<stdout>; rejects on failure
 */
export function makeDepCache({ root = depcacheRoot(), exec, fs = nodeFs, now = () => Date.now(), alive = pidAlive, host = hostname(), pid = process.pid,
  env: procEnv = process.env, installTimeoutMs = DEPCACHE_INSTALL_TIMEOUT_MS, lockWaitMs = DEPCACHE_INSTALL_TIMEOUT_MS, pollMs = 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const disabled = () => String(procEnv.FORGE_DEPCACHE ?? "").trim() === "0";
  const store = (n) => join(root, STORES, n);

  /** Shared package-manager stores for every runner call, so the builder's own installs reuse them too. */
  function env() {
    if (disabled()) return {};
    return { npm_config_store_dir: store("pnpm-store"), npm_config_cache: store("npm-cache"), UV_CACHE_DIR: store("uv-cache"), UV_LINK_MODE: "hardlink",
      POETRY_CACHE_DIR: store("poetry-cache"), PIP_CACHE_DIR: store("pip-cache"), POETRY_VIRTUALENVS_IN_PROJECT: "true" };
  }
  const run = (cmd, args, cwd) => exec(cmd, args, { cwd, env: env(), timeoutMs: installTimeoutMs });
  const runtime = async (cmd) => { try { return String(await exec(cmd, ["--version"], { timeoutMs: 30000 })).trim(); } catch { return "unknown"; } };

  /** Tracked package.json files (workspace members), relative; root only when git cannot list them. */
  async function manifests(wt) {
    try {
      const out = String(await exec("git", ["ls-files", "-z", "--", "package.json", ":(glob)**/package.json"], { cwd: wt, timeoutMs: 60000 }));
      const l = [...new Set(out.split("\0").map((s) => s.trim()).filter((s) => s && !s.split("/").includes("node_modules")))].sort();
      if (l.length) return l;
    } catch { /* not a git checkout */ }
    return ["package.json"];
  }

  async function keyOf(wt, d, pkgs) {
    const h = createHash("sha256").update(`v1\0${d.eco}\0${process.platform}-${process.arch}\0`);
    h.update(await runtime(JS.has(d.eco) ? "node" : "python3")).update("\0");
    const files = JS.has(d.eco) ? [d.lock, ...pkgs, "pnpm-workspace.yaml", ".npmrc", ".yarnrc.yml"] : [d.lock, "pyproject.toml", ".python-version"];
    for (const f of files) {
      h.update(`${f}\0`);
      try { h.update(fs.readFileSync(join(wt, f))); } catch { h.update("<absent>"); }
      h.update("\0");
    }
    return h.digest("hex").slice(0, 16);
  }

  // ---- per-key lock ----
  function tryLock(path) {
    try {
      const fd = fs.openSync(path, "wx");
      try { fs.writeSync(fd, JSON.stringify({ host, pid, created: now() })); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) { if (e?.code !== "EEXIST") throw e; }
    let held = null;
    try { held = JSON.parse(String(fs.readFileSync(path))); } catch { /* being written or garbage: stale only when old */ }
    let mtime = now();
    try { mtime = fs.statSync(path).mtimeMs; } catch { return false; }
    const stale = held ? ((held.host === host && !alive(held.pid)) || now() - Number(held.created) > installTimeoutMs * 2) : now() - mtime > 60000;
    if (!stale) return false;
    try { fs.rmSync(path, { force: true }); } catch { return false; }
    return tryLock(path);
  }
  async function withLock(path, fn, { wait = true } = {}) {
    const t0 = now();
    for (;;) {
      if (tryLock(path)) break;
      if (!wait || now() - t0 >= lockWaitMs) return { locked: false };
      await sleep(pollMs);
    }
    try { return { locked: true, value: await fn() }; } finally { try { fs.rmSync(path, { force: true }); } catch { /* best effort */ } }
  }

  // ---- trees ----
  const boundary = (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[/\\\\'\"\\s:;])", "g");
  /** Hardlink `src` into `dst`; symlinks recreated; files in bin dirs that name `from` are copied with `to` instead. */
  function linkTree(src, dst, { from = null, to = null, binDir = () => false } = {}) {
    const re = from && to && from !== to ? boundary(from) : null;
    const walk = (s, d, rel) => {
      fs.mkdirSync(d, { recursive: true });
      for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
        const sp = join(s, ent.name), dp = join(d, ent.name), r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isSymbolicLink()) {
          const t = String(fs.readlinkSync(sp));
          fs.symlinkSync(re ? t.replace(re, to) : t, dp);
        } else if (ent.isDirectory()) walk(sp, dp, r);
        else if (ent.isFile()) {
          if (re && binDir(rel)) {
            const buf = fs.readFileSync(sp);
            if (!buf.includes(0) && buf.includes(from)) {
              fs.writeFileSync(dp, String(buf).replace(re, to), { mode: (fs.statSync(sp).mode & 0o7777) | 0o200 });
              continue;
            }
          }
          fs.linkSync(sp, dp);
        }
      }
    };
    walk(src, dst, "");
  }
  function readOnly(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) readOnly(p);
      else if (ent.isFile()) fs.chmodSync(p, fs.statSync(p).mode & 0o7555);
    }
  }
  /** Trees an ecosystem installs: every existing node_modules next to a tracked package.json, or the project .venv. */
  const treesOf = (wt, d, pkgs) => (JS.has(d.eco) ? pkgs.map((p) => (dirname(p) === "." ? "node_modules" : `${dirname(p)}/node_modules`)) : [".venv"])
    .filter((t, i, a) => a.indexOf(t) === i && fs.existsSync(join(wt, t)));
  const binDirFor = (d) => (JS.has(d.eco) ? (rel) => rel.split("/").includes(".bin") : (rel) => rel === "bin");
  const rmTrees = (wt, trees) => { for (const t of trees) { try { fs.rmSync(join(wt, t), { recursive: true, force: true }); } catch { /* best effort */ } } };

  function publish(wt, d, key, trees, snap) {
    const tmp = `${snap}.tmp-${pid}`;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      for (const t of trees) linkTree(join(wt, t), join(tmp, t));
      readOnly(tmp);
      fs.writeFileSync(join(tmp, "manifest.json"), JSON.stringify({ v: 1, eco: d.eco, key, prefix: wt, trees, created: now() }) + "\n");
      fs.writeFileSync(join(tmp, "last-used"), String(now()));
      try { fs.renameSync(tmp, snap); } catch (e) {
        if (!fs.existsSync(join(snap, "manifest.json"))) throw e;
        fs.rmSync(tmp, { recursive: true, force: true }); // another lane published first: never write into its snapshot
      }
      return null;
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      return e?.code === "EXDEV" ? "cache is on another filesystem than the worktree (EXDEV)" : `publish failed: ${msg(e)}`;
    }
  }

  async function prepareOne(wt, keyRoot, d) {
    const t0 = now();
    const done = (status, extra = {}) => ({ status, eco: d.eco, key: extra.key ?? null, ms: now() - t0, reason: extra.reason ?? null, ...(extra.published === undefined ? {} : { published: extra.published }) });
    if (d.skip) return done("skipped", { reason: d.skip });
    const pkgs = JS.has(d.eco) ? await manifests(wt) : [];
    const key = await keyOf(wt, d, pkgs);
    const snap = join(keyRoot, `${d.eco}-${key}`);
    const cmds = commands(d);
    const expected = JS.has(d.eco) ? [...new Set(pkgs.map((p) => (dirname(p) === "." ? "node_modules" : `${dirname(p)}/node_modules`)))] : [".venv"];
    const existing = expected.filter((t) => fs.existsSync(join(wt, t)));
    if (existing.length) return done("skipped", { key, reason: `${existing[0]} already exists in the worktree` });
    fs.mkdirSync(keyRoot, { recursive: true, mode: 0o700 });

    const materialize = async () => {
      let man;
      try { man = JSON.parse(String(fs.readFileSync(join(snap, "manifest.json")))); } catch { return null; }
      const created = [];
      try {
        for (const t of man.trees ?? []) { created.push(t); linkTree(join(snap, t), join(wt, t), { from: man.prefix, to: wt, binDir: binDirFor(d) }); }
        for (const [c, a] of cmds.repair ?? []) await run(c, a, wt);
        try { fs.writeFileSync(join(snap, "last-used"), String(now())); } catch { /* best effort */ }
        return done("hit", { key });
      } catch (e) {
        rmTrees(wt, created);
        return done(e?.code === "EXDEV" ? "skipped" : "failed", { key, reason: e?.code === "EXDEV" ? "cache is on another filesystem than the worktree (EXDEV)" : `materialize failed: ${msg(e)}` });
      }
    };
    const install = async () => {
      try { for (const [c, a] of cmds.install) await run(c, a, wt); } catch (e) {
        rmTrees(wt, expected);
        return { failed: done("failed", { key, reason: `${e?.code === "ENOENT" ? "tool not found" : "install failed"}: ${msg(e)}` }) };
      }
      return { trees: treesOf(wt, d, pkgs) };
    };

    const lockPath = `${snap}.lock`;
    const r = await withLock(lockPath, async () => {
      if (fs.existsSync(join(snap, "manifest.json"))) return materialize(); // hit, or another lane published while we waited
      const ins = await install();
      if (ins.failed) return ins.failed;
      if (!ins.trees.length) return done("miss-installed", { key, published: false, reason: "the install produced no node_modules/.venv" });
      const why = publish(wt, d, key, ins.trees, snap);
      return done("miss-installed", { key, published: !why, reason: why });
    });
    if (r.locked) return r.value ?? done("failed", { key, reason: "snapshot manifest unreadable" });
    // The lock stayed busy past the wait: install in this lane without touching the cache.
    const ins = await install();
    return ins.failed ?? done("miss-installed", { key, published: false, reason: "cache lock busy" });
  }

  /** Materialize or build node_modules/.venv for `wt`; one result per detected ecosystem. Never throws. */
  async function prepare({ wt, repoKey } = {}) {
    if (disabled()) return [{ status: "skipped", eco: null, key: null, ms: 0, reason: "FORGE_DEPCACHE=0" }];
    let found;
    try { found = detect(fs, wt); } catch (e) { return [{ status: "failed", eco: null, key: null, ms: 0, reason: msg(e) }]; }
    if (!found.length) return [{ status: "skipped", eco: null, key: null, ms: 0, reason: "no lockfile" }];
    const keyRoot = join(root, safeSegment(repoKey ?? "repo"));
    const out = [];
    for (const d of found) {
      try { out.push(await prepareOne(wt, keyRoot, d)); } catch (e) { out.push({ status: "failed", eco: d.eco, key: null, ms: 0, reason: msg(e) }); }
    }
    return out;
  }

  /**
   * Read-only scan for the reaper: snapshots unused for maxAgeMs, tmp dirs of dead publishers, locks of dead holders on
   * this host. Only names this module creates are listed. Each entry: {name, path, kind: snapshot|tmp|lock, ageMs, locked?, reason};
   * a snapshot whose lock a live (or other-host) holder owns is listed with locked: true and is never removed.
   */
  function scan({ maxAgeMs = DEPCACHE_MAX_AGE_MS } = {}) {
    const out = [];
    let repos = [];
    try { repos = fs.readdirSync(root).filter((n) => n !== STORES); } catch { return out; }
    for (const rk of repos) {
      const dir = join(root, rk);
      let names = [];
      try { if (!fs.lstatSync(dir).isDirectory()) continue; names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        const p = join(dir, n), name = `${rk}/${n}`;
        try {
          const tm = TMP_RE.exec(n);
          if (tm) { if (!alive(Number(tm[2]))) out.push({ name, path: p, kind: "tmp", ageMs: null, reason: "publisher dead" }); continue; }
          if (LOCK_RE.test(n)) {
            const held = JSON.parse(String(fs.readFileSync(p)));
            if (held.host === host && !alive(held.pid)) out.push({ name, path: p, kind: "lock", ageMs: now() - Number(held.created), reason: "lock holder dead" });
            continue;
          }
          if (!SNAP_RE.test(n) || !fs.existsSync(join(p, "manifest.json"))) continue;
          let last = 0;
          try { last = Number(String(fs.readFileSync(join(p, "last-used")))); } catch { /* fall back to created */ }
          if (!Number.isFinite(last) || last <= 0) last = Number(JSON.parse(String(fs.readFileSync(join(p, "manifest.json")))).created) || 0;
          if (now() - last < maxAgeMs) continue;
          let locked = false;
          try { const h = JSON.parse(String(fs.readFileSync(`${p}.lock`))); locked = !(h.host === host && !alive(h.pid)); } catch { /* no lock */ }
          out.push({ name, path: p, kind: "snapshot", ageMs: now() - last, locked, reason: locked ? "locked by a live lane" : "snapshot unused" });
        } catch { /* unreadable or not ours: leave it */ }
      }
    }
    return out;
  }

  /** Remove one scanned entry; a snapshot only while holding its lock. Returns false when it is locked or not ours. */
  async function remove(entry) {
    const p = String(entry?.path ?? "");
    if (!p.startsWith(root + "/") || p.slice(root.length + 1).split("/").length !== 2) return false;
    if (entry.kind === "snapshot") return (await withLock(`${p}.lock`, async () => { fs.rmSync(p, { recursive: true, force: true }); return true; }, { wait: false })).locked;
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  }

  /** scan + remove: snapshots unused for maxAgeMs (taking their lock), dead publishers' tmp dirs, stale locks. Returns names. */
  async function prune({ maxAgeMs = DEPCACHE_MAX_AGE_MS } = {}) {
    const removed = [];
    for (const e of scan({ maxAgeMs })) { if (e.locked) continue; try { if (await remove(e)) removed.push(e.name); } catch { /* leave it */ } }
    return removed;
  }

  return { env, prepare, prune, scan, remove, root };
}


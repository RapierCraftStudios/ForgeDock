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
 * a missing tool, another filesystem (EXDEV) or a failed install leaves the lane as it was before. A snapshot that fails
 * to link or repair falls back to a fresh install in the lane (status materialize-fallback, #4522); failed only when that
 * install fails too.
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
/**
 * Error text for a reason: pnpm prints its ERR_PNPM_* errors on stdout (#4522), so the first such line from either
 * stream leads, then the last lines of stderr and stdout; the message only when both streams are empty.
 */
/** #5592: poetry cannot install the project itself (not package-mode: no package dir, no `package-mode = false`). */
const NO_ROOT_RE = /--no-root|current project could not be installed|No file\/folder found for package|does not contain any element/i;
const msg = (e) => {
  const lines = (s) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const err = lines(e?.stderr), out = lines(e?.stdout);
  const pm = [...err, ...out].find((l) => /\bERR_PNPM_[A-Z0-9_]+/.test(l));
  const parts = [pm, ...err.slice(-3), ...out.slice(-3)].filter((l, i, a) => l && a.indexOf(l) === i);
  return (parts.length ? parts.join(" ") : String(e?.message || e).trim().split("\n").slice(-3).join(" ")).slice(0, 500);
};

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
  else out.push(...serviceLocks(fs, wt));
  out.push(...nestedJsLocks(fs, wt));
  return out;
}

const JS_LOCKS = [["pnpm", "pnpm-lock.yaml"], ["npm", "package-lock.json"], ["yarn", "yarn.lock"]];
const JS_DIRS = ["web", "frontend", "client", "ui"];
/** #5423: JS lockfiles one level down (web/, frontend/, services|packages|apps/<name>/) with their own package.json; each is prepared in its own dir, so a sandbox has the vitest/vite a validate command calls. */
function nestedJsLocks(fs, wt) {
  const dirs = [...JS_DIRS];
  for (const root of SERVICE_ROOTS) {
    try { for (const n of fs.readdirSync(join(wt, root)).sort()) dirs.push(`${root}/${n}`); } catch { /* absent */ }
  }
  const out = [];
  for (const dir of dirs) {
    if (out.length >= SERVICE_CAP) break;
    try {
      if (!fs.existsSync(join(wt, dir, "package.json"))) continue;
      const hit = JS_LOCKS.find(([, lock]) => fs.existsSync(join(wt, dir, lock)));
      if (hit) out.push({ eco: hit[0], lock: hit[1], dir, ...(hit[0] === "yarn" ? { berry: fs.existsSync(join(wt, dir, ".yarnrc.yml")) } : {}) });
    } catch { /* unreadable: skip */ }
  }
  return out;
}

const SERVICE_ROOTS = ["services", "packages", "apps"];
const SERVICE_CAP = 8;
/** #5331: Python lockfiles one level down (services/<name>/uv.lock|poetry.lock) when the root has none; each is prepared in its own dir. */
function serviceLocks(fs, wt) {
  const out = [];
  for (const root of SERVICE_ROOTS) {
    let names = [];
    try { names = fs.readdirSync(join(wt, root)).sort(); } catch { continue; }
    for (const n of names) {
      const dir = `${root}/${n}`;
      for (const [eco, lock] of [["uv", "uv.lock"], ["poetry", "poetry.lock"]]) {
        if (out.length >= SERVICE_CAP) return out;
        try { if (fs.existsSync(join(wt, dir, lock))) { out.push({ eco, lock, dir }); break; } } catch { /* unreadable: skip */ }
      }
    }
  }
  return out;
}

const JS = new Set(["pnpm", "npm", "yarn"]);
const PY = new Set(["uv", "poetry"]);
/** Files a finished install leaves at the top of node_modules (npm, yarn classic, yarn berry, pnpm). */
const JS_MARKERS = [".package-lock.json", ".yarn-integrity", ".yarn-state.yml", ".modules.yaml"];

/** #5590: the project's declared Python range (`[project] requires-python` / `[tool.poetry.dependencies] python`), null when absent. */
export function pyRange(text, eco) {
  let section = "", poetry = null, pep = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { section = h[1].trim(); continue; }
    let m;
    if (section === "project" && (m = /^requires-python\s*=\s*["']([^"']+)["']/.exec(line))) pep = m[1];
    else if (section === "tool.poetry.dependencies" && (m = /^python\s*=\s*["']([^"']+)["']/.exec(line))) poetry = m[1];
  }
  return eco === "poetry" ? poetry ?? pep : pep ?? poetry;
}
const cmpVer = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
const prefixOf = (v, n) => n.every((x, i) => v[i] === x);
function clauseOk(clause, v) {
  const m = /^(\^|~=|~|==|!=|>=|<=|>|<)?v?(\d+(?:\.\d+)*)(\.\*)?$/.exec(clause);
  if (!m) return true; // unparseable: never constrain
  const op = m[1] ?? "==", n = m[2].split(".").map(Number), wild = Boolean(m[3]) || (op === "==" && n.length < 3) || (op === "!=" && n.length < 3);
  switch (op) {
    case "==": return wild ? prefixOf(v, n) : cmpVer(v, n) === 0;
    case "!=": return wild ? !prefixOf(v, n) : cmpVer(v, n) !== 0;
    case ">=": return cmpVer(v, n) >= 0;
    case ">": return cmpVer(v, n) > 0;
    case "<=": return cmpVer(v, n) <= 0;
    case "<": return cmpVer(v, n) < 0;
    case "^": { let i = n.findIndex((x) => x !== 0); if (i < 0) i = n.length - 1; const up = n.slice(0, i + 1); up[i] += 1; return cmpVer(v, n) >= 0 && cmpVer(v, up) < 0; }
    default: { const up = (op === "~=" ? n.length === 2 : n.length === 1) ? [n[0] + 1] : [n[0], (n[1] ?? 0) + 1]; return cmpVer(v, n) >= 0 && cmpVer(v, up) < 0; } // ~ / ~=
  }
}
/** #5590: does version `v` ([major, minor, patch]) satisfy the PEP 440 / poetry range `spec` ("||" alternatives, comma or space joined clauses)? */
export function pySatisfies(spec, v) {
  return String(spec).split("||").some((grp) => grp.replace(/(\^|~=|~|==|!=|>=|<=|>|<)\s+/g, "$1").split(/[,\s]+/).filter(Boolean).every((c) => clauseOk(c, v)));
}
/** Full frozen install on a miss, and the warm no-op repair pass on a hit (null: nothing path-dependent to repair). */
function commands(d, py = null) {
  // #5651: with an in-range interpreter poetry itself runs under it (`<py> -m poetry`), so its resolver never sees the host default python.
  const poetry = (args) => (py ? [py.cmd, ["-m", "poetry", ...args]] : ["poetry", args]);
  const use = py ? [poetry(["env", "use", py.cmd])] : [];
  switch (d.eco) {
    case "pnpm": return { install: [["pnpm", ["install", "--frozen-lockfile"]]], repair: [["pnpm", ["install", "--frozen-lockfile", "--offline"]]] };
    // npm/yarn node_modules hold only relative links; npm's hidden lockfile is rewritten in place, which the read-only
    // snapshot (correctly) refuses, so they get no repair pass.
    case "npm": return { install: [["npm", ["ci", "--no-audit", "--no-fund"]]], repair: null };
    case "yarn": return { install: [["yarn", ["install", d.berry ? "--immutable" : "--frozen-lockfile"]]], repair: null };
    case "uv": return { install: [["uv", ["venv", "--relocatable", ...(py ? ["--python", py.cmd] : []), ".venv"]], ["uv", ["sync", "--frozen"]]], repair: [["uv", ["sync", "--frozen"]]] };
    case "poetry": return { install: [...use, poetry(["install", "--sync"])], repair: [...use, poetry(["install", "--sync"])] };
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
  /** Install/repair command; `laneEnv` (the lane's toolchain env, #4347) sits under the store env, so store keys win. */
  const run = (cmd, args, cwd, laneEnv) => exec(cmd, args, { cwd, env: laneEnv ? { ...laneEnv, ...env() } : env(), timeoutMs: installTimeoutMs });
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

  /**
   * #5590/#5651: for a Python project whose pyproject declares a range, {py: null} (no range, or the default python3 is in range),
   * {py: {cmd, version}} (the interpreter that satisfies it: pythonX.Y on PATH, then `uv python find`) or {missing: {range, probed}}
   * (nothing in range: the caller stops, the out-of-range default is never used).
   */
  async function pythonFor(wt, d) {
    if (!PY.has(d.eco)) return { py: null };
    let range = null;
    try { range = pyRange(String(fs.readFileSync(join(wt, "pyproject.toml"))), d.eco); } catch { /* no pyproject */ }
    if (!range) return { py: null };
    const probed = [];
    const probe = async (cmd) => {
      try {
        const version = String(await exec(cmd, ["--version"], { timeoutMs: 30000 })).trim();
        const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
        if (m) { probed.push(`${cmd} (${version})`); return { cmd, version, v: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] }; }
      } catch { /* not installed */ }
      probed.push(`${cmd} (not found)`);
      return null;
    };
    const def = await probe("python3");
    if (def && pySatisfies(range, def.v)) return { py: null };
    const minors = [14, 13, 12, 11, 10, 9, 8];
    for (const x of minors) { const c = await probe(`python3.${x}`); if (c && pySatisfies(range, c.v)) return { py: c }; }
    for (const x of minors) {
      let path = "";
      try { path = String(await exec("uv", ["python", "find", `3.${x}`], { timeoutMs: 30000 })).trim().split("\n")[0]; } catch { probed.push("uv python find (unavailable)"); break; } // no uv
      const c = path ? await probe(path) : null;
      if (c && pySatisfies(range, c.v)) return { py: c };
    }
    return { missing: { range, probed } };
  }

  async function keyOf(wt, d, pkgs, py = null) {
    const h = createHash("sha256").update(`v1\0${d.eco}\0${process.platform}-${process.arch}\0`);
    if (d.dir) h.update(`${d.dir}\0`);
    h.update(py ? py.version : await runtime(JS.has(d.eco) ? "node" : "python3")).update("\0");
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
  /** Hardlink a file; across filesystems (EXDEV, #4909) copy it with its mode so the cache is reused instead of reinstalled. */
  function linkOrCopy(sp, dp) {
    try { fs.linkSync(sp, dp); } catch (e) {
      if (e?.code !== "EXDEV") throw e;
      fs.copyFileSync(sp, dp);
      fs.chmodSync(dp, fs.statSync(sp).mode & 0o7777);
    }
  }
  /**
   * Package-manager state at the top of a node_modules tree (pnpm's .modules.yaml, .pnpm/lock.yaml, workspace state; npm's and
   * yarn's hidden lockfiles) that the repair pass rewrites in place (#5574): lanes get a writable copy, never the read-only
   * shared inode, or the open-for-write fails with EACCES and the lane falls back to a full install.
   */
  const mutableState = (rel, name) => (rel === "" && /^\.(modules\.yaml|pnpm-workspace-state.*\.json|package-lock\.json|yarn-state\.yml)$/.test(name)) || (rel === ".pnpm" && name === "lock.yaml");
  /** Hardlink `src` into `dst` (copy on EXDEV); symlinks recreated; files in bin dirs that name `from` are copied with `to` instead. */
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
          if (mutableState(rel, ent.name)) {
            fs.copyFileSync(sp, dp);
            fs.chmodSync(dp, fs.statSync(sp).mode & 0o7777 | 0o200);
          } else linkOrCopy(sp, dp);
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

  /** #5590: the existing trees an install did not finish (no marker, a declared dependency missing, a venv without a working python). */
  function brokenTrees(wt, d, trees) {
    return trees.filter((t) => {
      const p = join(wt, t);
      try {
        if (!JS.has(d.eco)) return !fs.existsSync(join(p, "pyvenv.cfg")) || !fs.existsSync(join(p, "bin", "python"));
        if (!JS_MARKERS.some((m) => fs.existsSync(join(p, m)))) return true;
        const pj = JSON.parse(String(fs.readFileSync(join(wt, dirname(t), "package.json"))));
        return Object.keys({ ...pj.dependencies, ...pj.devDependencies }).some((n) => !fs.existsSync(join(p, n)));
      } catch { return true; }
    });
  }
  const present = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

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

  async function prepareOne(wt, keyRoot, d, laneEnv) {
    const t0 = now();
    let repaired = null;
    const done = (status, extra = {}) => ({ status, eco: d.eco, key: extra.key ?? null, ms: now() - t0, reason: extra.reason ?? repaired, ...(extra.published === undefined ? {} : { published: extra.published }) });
    if (d.skip) return done("skipped", { reason: d.skip });
    const pkgs = JS.has(d.eco) ? await manifests(wt) : [];
    const found = await pythonFor(wt, d);
    if (found.missing) {
      // #5651: never resolve under an out-of-range default interpreter (poetry dies in _finalize_license_expression on python 3.14).
      const { range, probed } = found.missing;
      return { ...done("failed", { reason: `no python satisfying the declared range "${range}" was found (probed: ${probed.join(", ")}); install one (for example \`uv python install\`) or put pythonX.Y on PATH` }), code: "env.tool_missing" };
    }
    const py = found.py;
    if (py && d.eco === "poetry") {
      try { await exec(py.cmd, ["-m", "poetry", "--version"], { timeoutMs: 30000 }); } catch {
        return { ...done("failed", { reason: `poetry is not available under ${py.cmd} (${py.version}), the interpreter satisfying the declared python range; install it there (for example \`${py.cmd} -m pip install poetry\`) or provide poetry on that interpreter` }), code: "env.tool_missing" };
      }
    }
    const key = await keyOf(wt, d, pkgs, py);
    const snap = join(keyRoot, `${d.eco}-${key}`);
    const cmds = commands(d, py);
    const expected = JS.has(d.eco) ? [...new Set(pkgs.map((p) => (dirname(p) === "." ? "node_modules" : `${dirname(p)}/node_modules`)))] : [".venv"];
    const existing = expected.filter((t) => present(join(wt, t)));
    if (existing.length) {
      const broken = brokenTrees(wt, d, existing);
      if (!broken.length) return done("skipped", { key, reason: `${existing[0]} already exists in the worktree` });
      // #5590: an interrupted or borrowed install is rebuilt, not trusted (the trees go together: a snapshot links all of them).
      rmTrees(wt, existing);
      repaired = `repaired incomplete ${broken[0]}`;
    }
    fs.mkdirSync(keyRoot, { recursive: true, mode: 0o700 });

    // #5592: `poetry install` fails on a project that is not package-mode (root package not installable): retry once with --no-root (dependencies only).
    const runList = async (list) => {
      for (const [c, a] of list) {
        try { await run(c, a, wt, laneEnv); } catch (e) {
          const wrapped = py && c === py.cmd && a[0] === "-m" && a[1] === "poetry"; // #5651: `<py> -m poetry ...`
          const sub = wrapped ? a.slice(2) : a;
          if (!(c === "poetry" || wrapped) || sub[0] !== "install" || sub.includes("--no-root") || !NO_ROOT_RE.test(`${msg(e)}\n${e?.stderr ?? ""}\n${e?.stdout ?? ""}`)) throw e;
          await run(c, [...a, "--no-root"], wt, laneEnv);
          repaired = repaired ?? "poetry install --no-root (project is not package-mode)";
        }
      }
    };
    const materialize = async () => {
      let man;
      try { man = JSON.parse(String(fs.readFileSync(join(snap, "manifest.json")))); } catch { return null; }
      const created = [];
      try {
        for (const t of man.trees ?? []) { created.push(t); linkTree(join(snap, t), join(wt, t), { from: man.prefix, to: wt, binDir: binDirFor(d) }); }
        await runList(cmds.repair ?? []);
        try { fs.writeFileSync(join(snap, "last-used"), String(now())); } catch { /* best effort */ }
        return done("hit", { key });
      } catch (e) {
        rmTrees(wt, created);
        if (e?.code === "EXDEV") return done("skipped", { key, reason: "cache is on another filesystem than the worktree (EXDEV)" });
        return { fallback: `materialize failed: ${msg(e)}` }; // installed by the caller, outside the key lock
      }
    };
    const install = async () => {
      try { await runList(cmds.install); } catch (e) {
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
    if (r.locked && r.value?.fallback) {
      // #4522: a broken snapshot must not leave the lane without dependencies. Install outside the lock so other lanes on
      // this key are not serialised behind it; never publish (the snapshot exists and is never replaced).
      const ins = await install();
      if (ins.failed) return { ...ins.failed, reason: `${r.value.fallback}; ${ins.failed.reason}` };
      return done("materialize-fallback", { key, published: false, reason: r.value.fallback });
    }
    if (r.locked) return r.value ?? done("failed", { key, reason: "snapshot manifest unreadable" });
    // The lock stayed busy past the wait: install in this lane without touching the cache.
    const ins = await install();
    return ins.failed ?? done("miss-installed", { key, published: false, reason: "cache lock busy" });
  }

  /**
   * Materialize or build node_modules/.venv for `wt`; one result per detected ecosystem. Never throws.
   * `env` (#4347): the lane's toolchain env (PATH with the pinned pm shims) for install/repair; absent means the host PATH.
   */
  async function prepare({ wt, repoKey, env: laneEnv } = {}) {
    if (disabled()) return [{ status: "skipped", eco: null, key: null, ms: 0, reason: "FORGE_DEPCACHE=0" }];
    let found;
    try { found = detect(fs, wt); } catch (e) { return [{ status: "failed", eco: null, key: null, ms: 0, reason: msg(e) }]; }
    if (!found.length) return [{ status: "skipped", eco: null, key: null, ms: 0, reason: "no lockfile" }];
    const keyRoot = join(root, safeSegment(repoKey ?? "repo"));
    const out = [];
    for (const d of found) {
      try {
        const r = await prepareOne(d.dir ? join(wt, d.dir) : wt, keyRoot, d, laneEnv && typeof laneEnv === "object" ? laneEnv : undefined);
        out.push({ ...r, dir: d.dir ?? "." });
      } catch (e) { out.push({ status: "failed", eco: d.eco, key: null, ms: 0, reason: msg(e), dir: d.dir ?? "." }); }
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


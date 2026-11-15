// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Environment library: one snapshot of a repo's installed dependencies per (lockfiles + toolchain pins + lane_tools +
 * base image), built once outside any job and consumed by lane sandboxes, CI jobs and deploy image builds.
 *
 * Key: a content hash, computable anywhere without running a tool. Ecosystem detection, the hashed files and the install
 * commands are depcache's (`makeDepCache().describe`), so both modules agree on what "the dependencies" are.
 *
 * Local store (`<root>/<key>/`, root = FORGE_ENV_ROOT or ~/.forge/env):
 *   manifest.json   {v, key, repo, ref, commit, prefix, ecosystems, trees, toolchain, lane_tools, image, platform, size_bytes, files, created}
 *   tree/<rel>      the installed trees at their repo-relative paths (read-only files, never written again)
 *   ready/<id>/     staged hardlink copies of tree/, each claimed once by a lane with a directory rename
 *   last-used
 * A lane claims a snapshot whose key equals its own: `rename(ready/<id>/<tree>, <worktree>/<tree>)` per tree, no per-file
 * work. That needs the store on the worktree's filesystem (the pool mounts both from one cache volume); otherwise the
 * trees are hardlinked, or copied across filesystems. Trees are built at one fixed prefix and the lane gets a symlink
 * from that prefix to its worktree, so absolute paths baked into them (bin shims, venv shebangs, editable installs) stay
 * valid and nothing is rewritten or repaired.
 *
 * OCI store: the same key tags an image built from a generated Dockerfile (base image + lane_tools + frozen installs at
 * the prefix). CI jobs run in it; deploy images use it as their dependency layer.
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { scanKeys } from "../config-schema.mjs";
import { depCommands } from "../lean/depcache.mjs";
import { checkRecipes, laneToolsDockerfile, validateLaneTools } from "../pool/lane-tools.mjs";

export const ENV_PREFIX = "/work/env";
export const ENV_DEFAULTS = Object.freeze({ store: "local", keep: 3, maxAgeDays: 14, ready: 2 });
export const envRoot = (env = process.env) => String(env.FORGE_ENV_ROOT ?? "").trim() || join(homedir(), ".forge", "env");
/** Toolchain pin files: their content is part of the key (package.json `packageManager`/`engines` are hashed with the manifests). */
export const PIN_FILES = [".nvmrc", ".node-version", ".python-version", ".tool-versions", ".go-version", "rust-toolchain", "rust-toolchain.toml"];
const KEY_RE = /^[0-9a-f]{16}$/;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** forge.yaml `env.snapshots` and `env.proxies`. Absent or `enabled: false` is off. Pure. */
export function readEnvSnapshots(text) {
  const keys = scanKeys(String(text ?? ""));
  const get = (k) => { const n = keys.get(k); return n && n.kind === "scalar" ? n.value.replace(/^["']|["']$/g, "").trim() : ""; };
  const int = (k, def, min) => { const v = get(k); return /^\d+$/.test(v) && Number(v) >= min ? Number(v) : def; };
  const proxies = {};
  for (const p of ["npm", "pypi", "apt", "git"]) { const v = get(`env.proxies.${p}`); if (/^(https?|git):\/\/[^\s"'`$;&|<>\\]+$/.test(v)) proxies[p] = v.replace(/\/+$/, ""); }
  return {
    enabled: get("env.snapshots.enabled") === "true",
    store: get("env.snapshots.store") === "oci" ? "oci" : ENV_DEFAULTS.store,
    keep: int("env.snapshots.keep", ENV_DEFAULTS.keep, 1),
    maxAgeDays: int("env.snapshots.max_age_days", ENV_DEFAULTS.maxAgeDays, 1),
    ready: int("env.snapshots.ready", ENV_DEFAULTS.ready, 0),
    baseImage: get("env.snapshots.base_image") || null,
    image: get("env.snapshots.image") || null,
    proxies,
  };
}

/** Env vars that point package managers at the opt-in caching proxies (pool/services). {} when none is set. Pure. */
export function proxyEnv(proxies = {}) {
  const out = {};
  const host = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  if (proxies.npm) Object.assign(out, { npm_config_registry: `${proxies.npm}/`, YARN_NPM_REGISTRY_SERVER: proxies.npm, ...(proxies.npm.startsWith("http://") ? { YARN_UNSAFE_HTTP_WHITELIST: host(proxies.npm) } : {}) });
  if (proxies.pypi) Object.assign(out, { PIP_INDEX_URL: proxies.pypi, UV_DEFAULT_INDEX: proxies.pypi, UV_INDEX_URL: proxies.pypi, ...(proxies.pypi.startsWith("http://") ? { PIP_TRUSTED_HOST: host(proxies.pypi), UV_INSECURE_HOST: host(proxies.pypi) } : {}) });
  if (proxies.apt) out.FORGE_APT_PROXY = proxies.apt;
  if (proxies.git) out.FORGE_GIT_MIRROR = proxies.git;
  return out;
}

/** The env a lane gets when snapshots are on (set by the dispatcher; the agent adds FORGE_ENV_IMAGE). {} when off. Pure. */
export function laneEnvFor(cfg, laneTools = []) {
  if (!cfg?.enabled) return {};
  return { FORGE_ENV_SNAPSHOTS: "1", FORGE_ENV_ROOT: "/cache/env", FORGE_ENV_PREFIX: ENV_PREFIX, ...(laneTools.length ? { FORGE_ENV_LANE_TOOLS: [...laneTools].sort().join(",") } : {}), ...proxyEnv(cfg.proxies) };
}

/**
 * Pure key: 16 hex over the canonical inputs. `components` [{eco, dir, files: [{path, sha}]}], `pins` [{path, sha}],
 * `laneTools` (any order), `image` (the base the trees were installed under), `platform`.
 */
export function computeKey({ components = [], pins = [], laneTools = [], image = "", platform = "linux-x64" } = {}) {
  const canon = {
    v: 1, platform, image: String(image ?? ""), lane_tools: [...new Set(laneTools.map(String))].sort(),
    components: components.map((c) => ({ eco: c.eco, dir: c.dir ?? ".", files: [...c.files].map((f) => [f.path, f.sha]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) }))
      .sort((a, b) => (`${a.dir}\0${a.eco}` < `${b.dir}\0${b.eco}` ? -1 : 1)),
    pins: pins.map((p) => [p.path, p.sha]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
  return sha(JSON.stringify(canon)).slice(0, 16);
}

/**
 * The environment of a checkout: its key and everything a build or a claim needs. `deps` is a depcache instance.
 * @returns {Promise<{key, components: {eco, dir, lock, berry?, inputs, trees}[], skipped: {eco, dir, reason}[], pins: object, laneTools: string[], image: string, platform: string}>}
 */
export async function describeEnv({ wt, deps, fs = nodeFs, laneTools = [], image = "", platform = "linux-x64" } = {}) {
  const read = (rel) => { try { return fs.readFileSync(join(wt, rel)); } catch { return null; } };
  const all = await deps.describe({ wt });
  const components = all.filter((c) => !c.skip);
  const pins = {}, pinList = [];
  for (const f of PIN_FILES) { const b = read(f); if (b) { pins[f] = String(b).trim().slice(0, 200); pinList.push({ path: f, sha: sha(b) }); } }
  const tools = validateLaneTools(laneTools).tools;
  const key = computeKey({ platform, image, laneTools: tools, pins: pinList,
    components: components.map((c) => ({ eco: c.eco, dir: c.dir, files: c.inputs.map((p) => { const b = read(p); return { path: p, sha: b ? sha(b) : "absent" }; }) })) });
  return { key, components, skipped: all.filter((c) => c.skip).map((c) => ({ eco: c.eco, dir: c.dir, reason: c.skip })), pins, laneTools: tools, image: String(image ?? ""), platform };
}

/**
 * How a lane gets the trees. Pure: `rename` (same filesystem and a staged copy is ready: no per-file work), `link` (same
 * filesystem, nothing staged: one hardlink per file) or `copy` (different filesystems: every byte is copied; the mounts are wrong).
 */
export function planClaim({ storeDev, worktreeDev, ready = 0 } = {}) {
  const same = storeDev !== undefined && storeDev !== null && storeDev === worktreeDev;
  if (!same) return { mode: "copy", reason: "the env store and the worktree are on different filesystems" };
  return ready > 0 ? { mode: "rename", reason: null } : { mode: "link", reason: "no staged copy ready" };
}

/**
 * Which snapshots GC removes. Pure. Per repo: the newest `keep` (by last use) stay; older ones go, and so does anything
 * unused for `maxAgeMs` except each repo's newest one. `list` entries: {key, repo, lastUsed}.
 */
export function planGc(list, { keep = ENV_DEFAULTS.keep, maxAgeMs = ENV_DEFAULTS.maxAgeDays * 86400000, now = Date.now() } = {}) {
  const byRepo = new Map();
  for (const s of list) { const k = s.repo ?? ""; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(s); }
  const out = [];
  for (const snaps of byRepo.values()) {
    snaps.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
    snaps.forEach((s, i) => {
      if (i === 0) return;
      if (i >= Math.max(1, keep)) out.push({ key: s.key, repo: s.repo ?? null, reason: `beyond keep ${keep}` });
      else if (now - (s.lastUsed ?? 0) > maxAgeMs) out.push({ key: s.key, repo: s.repo ?? null, reason: "unused past max age" });
    });
  }
  return out;
}

const STALE_TMP_MS = 6 * 3600 * 1000;

/**
 * Local-directory store. `linkTree(src, dst)` and `readOnly(dir)` are depcache's (hardlink, copy on EXDEV, writable
 * copies of package-manager state files).
 */
export function makeEnvStore({ root = envRoot(), fs = nodeFs, now = () => Date.now(), pid = process.pid, linkTree, readOnly } = {}) {
  const dirOf = (key) => { if (!KEY_RE.test(String(key))) throw new Error(`invalid env key ${JSON.stringify(key)}`); return join(root, key); };
  const present = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const names = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const manifest = (key) => { try { return JSON.parse(String(fs.readFileSync(join(dirOf(key), "manifest.json")))); } catch { return null; } };
  const has = (key) => manifest(key) !== null;
  const readyIds = (key) => names(join(dirOf(key), "ready")).filter((n) => !n.startsWith(".")).sort();
  const touch = (key) => { try { fs.writeFileSync(join(dirOf(key), "last-used"), String(now())); } catch { /* best effort */ } };
  const measure = (dir) => { let bytes = 0, files = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { files++; if (e.isFile()) bytes += fs.statSync(p).size; } } }; walk(dir); return { bytes, files }; };

  /** Move the installed `trees` of `wt` into a new snapshot (atomic; an existing snapshot of the key wins). Returns the manifest. */
  function publish({ key, wt, trees, manifest: extra = {} }) {
    const dir = dirOf(key), tmp = `${dir}.tmp-${pid}`;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      for (const t of trees) linkTree(join(wt, t), join(tmp, "tree", t));
      readOnly(join(tmp, "tree"));
      const { bytes, files } = measure(join(tmp, "tree"));
      const man = { v: 1, key, prefix: wt, trees, ...extra, size_bytes: bytes, files, created: now() };
      fs.writeFileSync(join(tmp, "manifest.json"), JSON.stringify(man, null, 2) + "\n");
      fs.writeFileSync(join(tmp, "last-used"), String(now()));
      try { fs.renameSync(tmp, dir); } catch (e) { if (!has(key)) throw e; fs.rmSync(tmp, { recursive: true, force: true }); return manifest(key); }
      return man;
    } catch (e) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } throw e; }
  }

  /** Stage hardlink copies until `count` are ready. Runs outside jobs (pool host). Returns how many were added. */
  function stage({ key, count = ENV_DEFAULTS.ready }) {
    const man = manifest(key);
    if (!man) return 0;
    const ready = join(dirOf(key), "ready");
    fs.mkdirSync(ready, { recursive: true });
    let added = 0;
    for (let i = readyIds(key).length; i < count; i++) {
      const id = `${now().toString(36)}-${pid}-${i}`, tmp = join(ready, `.tmp-${id}`);
      try {
        for (const t of man.trees) linkTree(join(dirOf(key), "tree", t), join(tmp, t));
        fs.renameSync(tmp, join(ready, id));
        added++;
      } catch { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } break; }
    }
    return added;
  }

  /**
   * Put the snapshot's trees into `wt`. null (nothing changed) when there is no snapshot, a tree already exists in the
   * worktree, or the build prefix cannot be aliased to `wt`. Otherwise {mode: rename|link|copy, ms, trees}.
   */
  function claim({ key, wt, prefix = null }) {
    const t0 = now(), man = manifest(key);
    if (!man || !Array.isArray(man.trees) || !man.trees.length) return null;
    if (man.trees.some((t) => present(join(wt, t)))) return null;
    if (man.prefix !== wt) {
      // The trees name man.prefix in absolute paths: it must resolve to this worktree.
      if (!prefix || prefix !== man.prefix) return null;
      try {
        let st = null;
        try { st = fs.lstatSync(prefix); } catch { /* absent */ }
        if (st && !st.isSymbolicLink()) return null;
        if (st) fs.unlinkSync(prefix);
        fs.mkdirSync(dirname(prefix), { recursive: true });
        fs.symlinkSync(wt, prefix);
      } catch { return null; }
    }
    const dir = dirOf(key);
    const dev = (p) => { try { return fs.statSync(p).dev; } catch { return undefined; } };
    const plan = planClaim({ storeDev: dev(dir), worktreeDev: dev(wt), ready: readyIds(key).length });
    const undo = () => { for (const t of man.trees) { try { fs.rmSync(join(wt, t), { recursive: true, force: true }); } catch { /* best effort */ } } };
    if (plan.mode === "rename") {
      for (const id of readyIds(key)) {
        const mine = join(dir, `.claim-${pid}-${id}`);
        try { fs.renameSync(join(dir, "ready", id), mine); } catch { continue; } // another lane took it
        try {
          for (const t of man.trees) { fs.mkdirSync(dirname(join(wt, t)), { recursive: true }); fs.renameSync(join(mine, t), join(wt, t)); }
          fs.rmSync(mine, { recursive: true, force: true });
          touch(key);
          return { mode: "rename", ms: now() - t0, trees: man.trees };
        } catch { undo(); try { fs.rmSync(mine, { recursive: true, force: true }); } catch { /* best effort */ } break; }
      }
    }
    try {
      for (const t of man.trees) linkTree(join(dir, "tree", t), join(wt, t));
      touch(key);
      return { mode: plan.mode === "copy" ? "copy" : "link", ms: now() - t0, trees: man.trees };
    } catch { undo(); return null; }
  }

  /** Every snapshot under the root. */
  function list() {
    const out = [];
    for (const key of names(root).filter((n) => KEY_RE.test(n)).sort()) {
      const man = manifest(key);
      if (!man) continue;
      let lastUsed = Number(man.created) || 0;
      try { const v = Number(String(fs.readFileSync(join(dirOf(key), "last-used")))); if (Number.isFinite(v) && v > 0) lastUsed = v; } catch { /* created */ }
      out.push({ key, repo: man.repo ?? null, ref: man.ref ?? null, commit: man.commit ?? null, ecosystems: (man.ecosystems ?? []).map((e) => e.eco), created: man.created, lastUsed, size_bytes: man.size_bytes ?? null, files: man.files ?? null, ready: readyIds(key).length, path: dirOf(key) });
    }
    return out;
  }

  /** Remove what planGc names (when `apply`), plus tmp and claim dirs older than 6 h. Returns {remove: planned, removed: keys}. */
  function gc({ keep, maxAgeMs, apply = false } = {}) {
    const remove = planGc(list(), { keep, maxAgeMs, now: now() });
    const removed = [];
    if (!apply) return { remove, removed };
    for (const r of remove) { try { fs.rmSync(dirOf(r.key), { recursive: true, force: true }); removed.push(r.key); } catch { /* leave it */ } }
    const old = (p) => { try { return now() - fs.statSync(p).mtimeMs > STALE_TMP_MS; } catch { return false; } };
    for (const n of names(root)) if (/^[0-9a-f]{16}\.tmp-\d+$/.test(n) && old(join(root, n))) { try { fs.rmSync(join(root, n), { recursive: true, force: true }); } catch { /* leave it */ } }
    for (const key of names(root).filter((n) => KEY_RE.test(n))) {
      for (const n of names(dirOf(key))) if (n.startsWith(".claim-") && old(join(dirOf(key), n))) { try { fs.rmSync(join(dirOf(key), n), { recursive: true, force: true }); } catch { /* leave it */ } }
      for (const n of names(join(dirOf(key), "ready"))) if (n.startsWith(".tmp-") && old(join(dirOf(key), "ready", n))) { try { fs.rmSync(join(dirOf(key), "ready", n), { recursive: true, force: true }); } catch { /* leave it */ } }
    }
    return { remove, removed };
  }

  return { kind: "local", root, has, manifest, publish, stage, claim, list, gc, locate: dirOf };
}

/** Manifest fields shared by both stores. */
export const manifestOf = (desc, { repo = null, ref = null, commit = null, resolved = {} } = {}) => ({
  repo, ref, commit, ecosystems: desc.components.map((c) => ({ eco: c.eco, dir: c.dir, lock: c.lock })),
  toolchain: { pins: desc.pins, resolved }, lane_tools: desc.laneTools, image: desc.image, platform: desc.platform,
});

/**
 * Build a snapshot in the local store from a checkout at `wt` (the prefix). Runs the repo's own frozen installs through
 * depcache; publishes only when every ecosystem installed. Meant for a build container on the pool host, never a job.
 * @returns {Promise<{status: "exists"|"built"|"failed", key, reason?, manifest?}>}
 */
export async function buildLocal({ wt, deps, store, desc, fs = nodeFs, exec = null, repo = null, ref = null, commit = null } = {}) {
  if (store.has(desc.key)) return { status: "exists", key: desc.key, manifest: store.manifest(desc.key) };
  if (!desc.components.length) return { status: "failed", key: desc.key, reason: "no lockfile the environment library can install" };
  const res = await deps.prepare({ wt, repoKey: "env-build", publish: false });
  const bad = res.find((r) => r.status === "failed");
  if (bad) return { status: "failed", key: desc.key, reason: `${bad.eco ?? "install"}: ${bad.reason}` };
  const trees = desc.components.flatMap((c) => c.trees).filter((t) => { try { fs.lstatSync(join(wt, t)); return true; } catch { return false; } });
  if (!trees.length) return { status: "failed", key: desc.key, reason: "the installs produced no node_modules/.venv" };
  const resolved = {};
  if (exec) for (const tool of ["node", "python3"]) { try { resolved[tool] = String(await exec(tool, ["--version"], { timeoutMs: 30000 })).trim(); } catch { /* not installed */ } }
  const manifest = store.publish({ key: desc.key, wt, trees, manifest: manifestOf(desc, { repo, ref, commit, resolved }) });
  return { status: "built", key: desc.key, manifest };
}

/** depcache.prepare's hook: claim the snapshot for this worktree's key. {key, mode, ms}, or null on a miss (nothing changed). */
export async function claimForLane({ wt, deps, fs = nodeFs, env = process.env, now = () => Date.now() } = {}) {
  const t0 = now();
  const desc = await describeEnv({ wt, deps, fs, laneTools: String(env.FORGE_ENV_LANE_TOOLS ?? "").split(",").filter(Boolean), image: env.FORGE_ENV_IMAGE ?? "" });
  if (!desc.components.length) return null;
  const store = makeEnvStore({ root: envRoot(env), fs, now, linkTree: deps.linkTree, readOnly: deps.readOnly });
  const got = store.claim({ key: desc.key, wt, prefix: String(env.FORGE_ENV_PREFIX ?? "").trim() || null });
  return got ? { key: desc.key, mode: got.mode, ms: now() - t0 } : null;
}

const shq = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
/** Installs that need only the lockfile and manifests in the build context (no project source). */
function ociInstall(c) {
  if (c.eco === "uv") return [["uv", ["venv", "--relocatable", ".venv"]], ["uv", ["sync", "--frozen", "--no-install-project"]]];
  if (c.eco === "poetry") return [["poetry", ["install", "--sync", "--no-root"]]];
  return depCommands(c).install;
}

/**
 * OCI backend: the image for a key and how to build it. Pure; running docker is the pool host's job.
 * `existing(path)` says which hashed inputs are in the checkout (absent optional files are not COPYed).
 * @returns {{ref, dockerfile, build: string[], push: string[]}}
 */
export function ociRecipe({ desc, baseImage, image, existing = () => true, prefix = ENV_PREFIX, repo = null, commit = null } = {}) {
  if (!baseImage) throw new Error("env.snapshots.base_image is required for the oci store (the image the installs run in)");
  if (!image) throw new Error("env.snapshots.image is required for the oci store (the repository snapshots are pushed to, without a tag)");
  if (/[\s"'`$;&|<>\\]/.test(`${baseImage}${image}`)) throw new Error("env.snapshots.base_image and image must be plain image references");
  checkRecipes(desc.laneTools);
  const ref = `${image}:${desc.key}`;
  const lines = [`# Environment snapshot ${desc.key}. Generated by \`forgedock env build\`; do not edit.`,
    ...laneToolsDockerfile(baseImage, desc.laneTools).trimEnd().split("\n"), `WORKDIR ${prefix}`];
  const copied = new Set();
  const copy = (files) => {
    const byDir = new Map();
    for (const f of files) { if (copied.has(f) || !existing(f)) continue; copied.add(f); const d = dirname(f); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(f); }
    for (const [d, fl] of [...byDir].sort()) lines.push(`COPY ${JSON.stringify([...fl, d === "." ? "./" : `${d}/`])}`);
  };
  copy(PIN_FILES);
  for (const c of desc.components) {
    copy(c.inputs);
    const cd = c.dir === "." ? "" : `cd ${shq(c.dir)} && `;
    lines.push(`RUN ${cd}${ociInstall(c).map(([cmd, args]) => [cmd, ...args].map(shq).join(" ")).join(" && ")}`);
  }
  const man = { v: 1, key: desc.key, prefix, trees: desc.components.flatMap((c) => c.trees), ...manifestOf(desc, { repo, commit }) };
  lines.push(`RUN printf '%s\\n' ${shq(JSON.stringify(man))} > ${prefix}/.forge-env.json`, `LABEL io.forgedock.env.key=${desc.key}`, "");
  return { ref, dockerfile: lines.join("\n"), manifest: man, build: ["docker", "build", "-f", "Dockerfile.env", "-t", ref, "."], push: ["docker", "push", ref] };
}

/** OCI store: same interface where it applies. `exec` (pool host only) answers `has` with `docker manifest inspect`. */
export function makeOciStore({ image, baseImage, exec = null } = {}) {
  const locate = (key) => `${image}:${key}`;
  return { kind: "oci", locate,
    async has(key) { if (!exec) return null; try { await exec("docker", ["manifest", "inspect", locate(key)], { timeoutMs: 60000 }); return true; } catch { return false; } },
    recipe: (o) => ociRecipe({ ...o, baseImage, image }) };
}

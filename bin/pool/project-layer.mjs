// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #6038: a repo's project deps as a cached image layer. deriveProjectDeps reads a worktree (lockfiles via depcache's detect,
 * runtime pins from .tool-versions / .nvmrc / .python-version / CI setup-node|setup-python); projectLayerImageNow builds a
 * layer FROM the lane image tagged `<base>-p<12hex>` (hash of lockfile contents + runtimes), in the background, and falls
 * back to the base image while building or after a failure. Docker and fs are injected; nothing here blocks a launch.
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { detect, pyHint, depCommands } from "../lean/depcache.mjs";
import { isLaneToolsTagOf, buildErrorTail } from "./lane-tools.mjs";

const JS = new Set(["pnpm", "npm", "yarn"]);
const MANIFESTS = ["package.json", "pnpm-workspace.yaml", ".npmrc", ".yarnrc.yml", "pyproject.toml", ".python-version"];
const MAX_FILE = 4 * 1024 * 1024;
export const PROJECT_BUILD_RETRY_MS = 10 * 60000;
export const PROJECT_LAYER_ROOT = "/opt/project-deps";

const read = (fs, p) => { try { return String(fs.readFileSync(p)); } catch { return null; } };

/** Node version the repo pins: .nvmrc, .tool-versions `nodejs`, else the first CI setup-node `node-version`. */
function nodeHint(fs, wt) {
  const norm = (t) => { const m = /^\s*(?:v|node\/|lts\/)?(\d+(?:\.\d+){0,2})/.exec(t ?? ""); return m ? m[1] : null; };
  const nvmrc = norm(read(fs, join(wt, ".nvmrc")));
  if (nvmrc) return nvmrc;
  const tv = /^\s*node(?:js)?\s+(\S+)/m.exec(read(fs, join(wt, ".tool-versions")) ?? "");
  if (tv && norm(tv[1])) return norm(tv[1]);
  try {
    const dir = join(wt, ".github", "workflows");
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.ya?ml$/.test(f)) continue;
      const m = /node-version:\s*\[?\s*["']?v?(\d+(?:\.\d+){0,2})/.exec(read(fs, join(dir, f)) ?? "");
      if (m) return m[1];
    }
  } catch { /* no workflows */ }
  return null;
}

/** Python minor the repo pins: depcache's .python-version / setup-python hint, else .tool-versions `python`. */
function pythonHint(fs, wt) {
  const h = pyHint(fs, wt);
  if (h) return `${h[0]}.${h[1]}`;
  const m = /^\s*python\s+(\d+\.\d+)/m.exec(read(fs, join(wt, ".tool-versions")) ?? "");
  return m ? m[1] : null;
}

/** {ecosystems, lockfiles, node, python, files, hash} for a worktree; hash is null when there is nothing to install. */
export function deriveProjectDeps(worktree, fs = nodeFs) {
  const found = detect(fs, worktree).filter((d) => !d.skip);
  const lockfiles = found.map((d) => ({ eco: d.eco, dir: d.dir ?? ".", path: d.dir ? `${d.dir}/${d.lock}` : d.lock, ...(d.berry ? { berry: true } : {}) }));
  const files = {};
  for (const d of lockfiles) {
    for (const name of [posix.basename(d.path), ...MANIFESTS]) {
      const rel = d.dir === "." ? name : `${d.dir}/${name}`;
      if (rel in files) continue;
      const t = read(fs, join(worktree, rel));
      if (t !== null && t.length <= MAX_FILE) files[rel] = t;
    }
  }
  const ecosystems = [...new Set(lockfiles.map((d) => d.eco))].sort();
  const node = lockfiles.some((d) => JS.has(d.eco)) ? nodeHint(fs, worktree) : null;
  const python = lockfiles.some((d) => !JS.has(d.eco)) ? pythonHint(fs, worktree) : null;
  if (!lockfiles.length) return { ecosystems, lockfiles, node, python, files, hash: null };
  const h = createHash("sha256").update(`v1\0${node ?? ""}\0${python ?? ""}\0${process.arch}\0`);
  for (const d of lockfiles) h.update(`${d.eco}\0${d.path}\0${d.berry ? 1 : 0}\0`);
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k]}\0`);
  return { ecosystems, lockfiles, node, python, files, hash: h.digest("hex") };
}

/** Per-project image tag: base plus 12 hex of the deps hash; separate from the lane_tools `-t` tag. */
export function projectLayerTag(baseImage, hash) {
  return `${baseImage}-p${String(hash).slice(0, 12)}`;
}

/** True for `<base>-p<12 hex>` where `<base>` is the base image or a lane_tools variant of it. */
export function isProjectLayerTagOf(tag, base) {
  if (typeof tag !== "string") return false;
  const m = /^(.*)-p[0-9a-f]{12}$/.exec(tag);
  return Boolean(m) && isLaneToolsTagOf(m[1], base);
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The layer Dockerfile: FROM base, runtimes, then per lockfile dir copy manifests and run the frozen install. */
export function projectLayerDockerfile(baseImage, deps) {
  const out = [`FROM ${baseImage}`, "USER root"];
  if (deps.node) out.push(`RUN npm install -g n && n ${q(deps.node)}`);
  if (deps.python) out.push(`RUN uv python install ${q(deps.python)}`);
  for (const d of deps.lockfiles) {
    const target = d.dir === "." ? PROJECT_LAYER_ROOT : `${PROJECT_LAYER_ROOT}/${d.dir}`;
    const cmds = depCommands(d)?.install ?? [];
    out.push(`COPY ctx/${d.dir === "." ? "" : d.dir} ${target}/`, `WORKDIR ${target}`);
    for (const [cmd, args] of cmds) out.push(`RUN ${[cmd, ...args].map(q).join(" ")}`);
  }
  return [...out, "WORKDIR /", ""].join("\n");
}

const BUILDS = new Map();
const FAILED = new Map();

async function buildLayer({ tag, baseImage, deps, docker, buildTimeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), "project-layer-"));
  let timer;
  try {
    for (const [rel, text] of Object.entries(deps.files ?? {})) {
      const p = join(dir, "ctx", rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    }
    for (const d of deps.lockfiles) mkdirSync(join(dir, "ctx", d.dir === "." ? "" : d.dir), { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), projectLayerDockerfile(baseImage, deps));
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`build timed out after ${buildTimeoutMs}ms`)), buildTimeoutMs); });
    await Promise.race([docker.build(dir, tag, {}), timeout]);
  } catch (e) {
    throw new Error(`project layer ${tag} build failed: ${buildErrorTail(e)}`);
  } finally { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); }
  return tag;
}

/**
 * Never blocks: {image: tag} when the layer exists, else starts (or joins) one background build and returns
 * {image: baseImage, building: true}; a build that failed in the last PROJECT_BUILD_RETRY_MS returns {image: baseImage, failed}.
 */
export async function projectLayerImageNow({ deps, baseImage, docker, buildTimeoutMs = 45 * 60000, now = Date.now }) {
  if (!deps?.hash || !deps.lockfiles?.length) return { image: baseImage };
  const tag = projectLayerTag(baseImage, deps.hash);
  try { if (await docker.hasImage?.(tag)) return { image: tag }; } catch { return { image: baseImage }; }
  const f = FAILED.get(tag);
  if (f && now() - f.at < PROJECT_BUILD_RETRY_MS) return { image: baseImage, failed: f.message };
  if (!BUILDS.has(tag)) {
    FAILED.delete(tag);
    BUILDS.set(tag, buildLayer({ tag, baseImage, deps, docker, buildTimeoutMs }).catch((e) => { FAILED.set(tag, { at: now(), message: e.message }); }).finally(() => BUILDS.delete(tag)));
  }
  return { image: baseImage, building: true, tag };
}

/** Test hook: the in-flight build of a tag. */
export const pendingBuild = (tag) => BUILDS.get(tag);

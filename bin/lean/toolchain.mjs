// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Toolchain pins for a lane (#4163). Reads the target repo's own pins (package.json `packageManager` / `engines.node`,
 * `.nvmrc`, `.node-version`, `.tool-versions`) and writes a per-run shim dir for the pinned package manager, prepended
 * to the runner's PATH so the builder, its validate commands and git hooks all resolve the pinned version. Zero LLM.
 * A repo without pins gets nothing: no shim dir, no env, no warning.
 */
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, delimiter, resolve, dirname, isAbsolute } from "node:path";

const PMS = ["pnpm", "yarn", "npm"];
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** "pnpm@10.4.1+sha512.ab" -> {name, version}; null for anything not a known manager at an exact version. */
export function parsePackageManager(s) {
  const m = /^(pnpm|yarn|npm)@([^+\s]+)(?:\+\S*)?$/.exec(String(s ?? "").trim());
  return m && VERSION_RE.test(m[2]) ? { name: m[1], version: m[2] } : null;
}

/** `.tool-versions` lines -> {tool: firstVersion}. */
function parseToolVersions(text) {
  const out = {};
  for (const l of String(text ?? "").split("\n")) {
    const [tool, ver] = l.replace(/#.*/, "").trim().split(/\s+/);
    if (tool && ver && !(tool in out)) out[tool] = ver;
  }
  return out;
}

/**
 * The repo's pins. `override` is forge.yaml `env.toolchain`: "<pm>@<version>" replaces the package-manager pin, "off"
 * disables detection. Returns {pm:{name,version,source}|null, node:{spec,source}|null, notes:[]}.
 */
export async function detectPins(dir, { override = null, read = (p) => readFile(p, "utf8") } = {}) {
  const res = { pm: null, node: null, notes: [] };
  const ov = typeof override === "string" ? override.trim() : "";
  if (ov.toLowerCase() === "off") return res;
  const tryRead = async (f) => { try { return String(await read(join(dir, f))); } catch { return null; } };
  let pkg = null;
  const pkgText = await tryRead("package.json");
  if (pkgText !== null) { try { pkg = JSON.parse(pkgText); } catch { res.notes.push("package.json is not valid JSON; its pins are ignored"); } }
  const tv = parseToolVersions(await tryRead(".tool-versions"));
  if (ov) {
    const pm = parsePackageManager(ov);
    if (pm) res.pm = { ...pm, source: "forge.yaml env.toolchain" };
    else res.notes.push(`forge.yaml env.toolchain "${ov.slice(0, 60)}" is not <pnpm|yarn|npm>@<x.y.z> or "off"; ignored`);
  }
  if (!res.pm && typeof pkg?.packageManager === "string") {
    const pm = parsePackageManager(pkg.packageManager);
    if (pm) res.pm = { ...pm, source: "package.json packageManager" };
    else res.notes.push(`package.json packageManager "${pkg.packageManager.slice(0, 60)}" is not <pnpm|yarn|npm>@<x.y.z>; not pinned`);
  }
  if (!res.pm) {
    const name = PMS.find((n) => VERSION_RE.test(tv[n] ?? ""));
    if (name) res.pm = { name, version: tv[name], source: ".tool-versions" };
  }
  for (const [f, get] of [[".nvmrc", (t) => t], [".node-version", (t) => t]]) {
    if (res.node) break;
    const t = await tryRead(f);
    const spec = t === null ? "" : get(t).split("\n")[0].trim();
    if (spec) res.node = { spec, source: f };
  }
  if (!res.node && (tv.nodejs || tv.node)) res.node = { spec: tv.nodejs || tv.node, source: ".tool-versions" };
  if (!res.node && typeof pkg?.engines?.node === "string" && pkg.engines.node.trim()) res.node = { spec: pkg.engines.node.trim(), source: "package.json engines.node" };
  return res;
}

// ---- minimal semver satisfaction for node pins ----
const parseV = (s) => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(String(s).trim());
  if (!m) return null;
  const n = (x) => (x === undefined || /^[x*]$/i.test(x) ? null : Number(x));
  return [Number(m[1]), n(m[2]), n(m[3])];
};
const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return 0; };
const fill = (p, v = 0) => p.map((x) => (x === null ? v : x));
/** host [M,m,p] within partial p (20 -> 20.x.x, 20.11 -> 20.11.x)? */
const within = (h, p) => p.every((x, i) => x === null || x === h[i]);
const upper = (p) => (p[1] === null ? [p[0] + 1, 0, 0] : p[2] === null ? [p[0], p[1] + 1, 0] : null);

/** true/false, or null when the comparator can't be evaluated. */
function satisfiesOne(h, c) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(\S+)$/.exec(c.trim());
  if (!m) return null;
  const p = parseV(m[2]);
  if (!p) return null;
  const lo = fill(p);
  switch (m[1] ?? "") {
    case "": case "=": return within(h, p);
    case ">=": return cmp(h, lo) >= 0;
    case ">": return p[1] === null || p[2] === null ? cmp(h, upper(p)) >= 0 : cmp(h, lo) > 0;
    case "<": return cmp(h, lo) < 0;
    case "<=": return p[1] === null || p[2] === null ? cmp(h, upper(p)) < 0 : cmp(h, lo) <= 0;
    case "~": return cmp(h, lo) >= 0 && cmp(h, p[1] === null ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0]) < 0;
    case "^": return cmp(h, lo) >= 0 && cmp(h, lo[0] > 0 ? [lo[0] + 1, 0, 0] : lo[1] > 0 ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1]) < 0;
  }
  return null;
}

/** Does host version `v` satisfy node spec? true/false, or null when the spec can't be evaluated (aliases, unknown syntax). */
export function nodeSatisfies(spec, v) {
  const h = parseV(v);
  if (!h || h.includes(null)) return null;
  const alts = String(spec).split("||").map((s) => s.trim()).filter(Boolean);
  if (!alts.length) return null;
  let unknown = false;
  for (const alt of alts) {
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(alt); // hyphen range "18 - 20" = ">=18 <=20"
    const parts = hy ? [`>=${hy[1]}`, `<=${hy[2]}`] : alt.replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/);
    let ok = true;
    for (const c of parts) {
      const r = satisfiesOne(h, c);
      if (r === null) { unknown = true; ok = false; break; }
      if (!r) { ok = false; break; }
    }
    if (ok) return true;
  }
  return unknown ? null : false;
}

/** One-line trajectory warning when the host node does not satisfy the pin; null when it does or nothing is pinned. */
export function nodeWarning(pin, hostVersion = process.version) {
  if (!pin?.spec) return null;
  if (/^(lts\/|node$|stable$|latest$|current$|system$)/i.test(pin.spec)) return null;
  const ok = nodeSatisfies(pin.spec, hostVersion);
  if (ok === true) return null;
  if (ok === null) return `Toolchain: cannot evaluate node pin "${pin.spec}" (${pin.source}) against host node ${hostVersion}; check it manually`;
  return `host node ${hostVersion} does not satisfy the ${pin.source} pin "${pin.spec}"; installs, builds and tests may behave differently from the repo's CI`;
}

/** First executable `name` on `pathStr`, skipping `exclude` dirs (the shim dir itself, so a shim never calls itself). */
export function which(name, pathStr = process.env.PATH ?? "", exclude = []) {
  const skip = new Set(exclude.map((d) => resolve(d)));
  for (const d of String(pathStr).split(delimiter)) {
    if (!d || skip.has(resolve(d))) continue;
    const p = join(d, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const HEADER = "#!/bin/sh\n# forgedock lane toolchain shim (#4163): pinned by the target repo; do not edit.\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_STRICT=0\n";

/** npx package spec and package name for a pin: yarn >= 2 is published as @yarnpkg/cli-dist; the npm "yarn" package is 1.x only. */
function npxPackage(pm) {
  const name = pm.name === "yarn" && Number(pm.version.split(".")[0]) >= 2 ? "@yarnpkg/cli-dist" : pm.name;
  return { name, spec: `${name}@${pm.version}` };
}

/** Bin names the npx-launched shims exec for a pin (pnpx runs `pnpm dlx`, so it reuses pnpm). */
const pinBins = (pm) => (pm.name === "npm" ? ["npm", "npx"] : [pm.name]);

/**
 * Resolve the pinned manager's real binaries once per lane (#4348): `npx -y -p <pkg>@<ver> -c 'command -v <bin>'`, which
 * reuses npx's cache or fetches once. A path is kept only when it is an absolute executable file and its package's
 * `package.json` (`<.bin>/../<pkg>/package.json`) has exactly the pinned version. Returns {bin: absPath}; a failed bin is
 * omitted (its shim falls back to npx). Never throws.
 */
export function resolvePinnedBins(pm, { npx = null, path = process.env.PATH ?? "", run = (f, a, o) => execFileSync(f, a, o) } = {}) {
  const out = {};
  if (!npx || !pm || !PMS.includes(pm.name) || !VERSION_RE.test(pm.version)) return out;
  const pkg = npxPackage(pm);
  for (const bin of pinBins(pm)) {
    try {
      const p = String(run(npx, ["-y", "-p", pkg.spec, "-c", `command -v ${bin}`], { env: { ...process.env, PATH: path }, timeout: 120000, stdio: ["ignore", "pipe", "ignore"] }) ?? "").trim().split("\n").pop().trim();
      if (!p || !isAbsolute(p) || !statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      const meta = JSON.parse(readFileSync(join(dirname(p), "..", ...pkg.name.split("/"), "package.json"), "utf8"));
      if (meta?.version === pm.version) out[bin] = p;
    } catch { /* unresolved: the shim falls back to npx */ }
  }
  return out;
}

/**
 * Shim scripts {name: content} for the pinned manager: `corepack <pm>@<ver>` when corepack is on the host PATH, else
 * `npx -y`. Absolute paths are resolved here, so a shim never re-enters the shim dir. Returns {} when neither exists.
 * `bins` ({bin: absPath} from resolvePinnedBins) makes an npx shim exec that binary directly while it exists, keeping the
 * npx line as the fallback (#4348).
 */
export function shimScripts(pm, { corepack = null, npx = null, bins = {} } = {}) {
  if (!pm || !PMS.includes(pm.name) || !VERSION_RE.test(pm.version)) return {};
  const at = `${pm.name}@${pm.version}`;
  const out = {};
  const direct = (bin, extra = "") => (bins?.[bin] ? `if [ -x ${q(bins[bin])} ]; then exec ${q(bins[bin])}${extra} "$@"; fi\n` : "");
  if (pm.name === "npm") {
    if (npx) { out.npm = `${HEADER}${direct("npm")}exec ${q(npx)} -y ${q(at)} "$@"\n`; out.npx = `${HEADER}${direct("npx")}exec ${q(npx)} -y -p ${q(at)} npx "$@"\n`; }
    return out;
  }
  if (corepack) {
    out[pm.name] = `${HEADER}exec ${q(corepack)} ${q(at)} "$@"\n`;
    if (pm.name === "pnpm") out.pnpx = `${HEADER}exec ${q(corepack)} ${q(at)} dlx "$@"\n`;
    return out;
  }
  if (!npx) return out;
  const pkg = npxPackage(pm).spec;
  out[pm.name] = `${HEADER}${direct(pm.name)}exec ${q(npx)} -y -p ${q(pkg)} ${pm.name} "$@"\n`;
  if (pm.name === "pnpm") out.pnpx = `${HEADER}${direct("pnpm", " dlx")}exec ${q(npx)} -y -p ${q(pkg)} pnpm dlx "$@"\n`;
  return out;
}

/** Runner env for a shim dir: PATH with the shim dir first, corepack prompts off. */
export function toolchainEnv(binDir, basePath = process.env.PATH ?? "") {
  return { PATH: basePath ? `${binDir}${delimiter}${basePath}` : binDir, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_STRICT: "0" };
}

/** Version of the host `node` the builder's shells resolve (PATH), falling back to this process. */
export function hostNodeVersion(pathStr = process.env.PATH ?? "") {
  const n = which("node", pathStr);
  if (n) { try { return String(execFileSync(n, ["--version"], { timeout: 10000 })).trim(); } catch { /* fall through */ } }
  return process.version;
}

async function writeShimFile(p, content) { await writeFile(p, content); await chmod(p, 0o755); }

/**
 * Write executable (0755) shims for the pinned manager into `binDir`; launchers are resolved from `path` with `binDir`
 * excluded. When npx is the launcher, `resolveBins` runs once to find the pinned binaries (#4348). Returns
 * {names, unresolved}: the shim names written ([] when neither corepack nor npx is on `path`) and the bins left on npx.
 */
async function writeShimSet(binDir, pm, { path = process.env.PATH ?? "", find = which, writeShim = writeShimFile, mkdirp = (d) => mkdir(d, { recursive: true }), resolveBins = resolvePinnedBins } = {}) {
  const corepack = find("corepack", path, [binDir]), npx = find("npx", path, [binDir]);
  let bins = {}, unresolved = [];
  if (!corepack && npx && pm && PMS.includes(pm.name) && VERSION_RE.test(pm.version)) {
    try { bins = (await resolveBins(pm, { npx, path })) ?? {}; } catch { bins = {}; }
    unresolved = pinBins(pm).filter((b) => !bins[b]);
  }
  const scripts = shimScripts(pm, { corepack, npx, bins });
  if (!Object.keys(scripts).length) return { names: [], unresolved: [] };
  await mkdirp(binDir);
  for (const [name, content] of Object.entries(scripts)) await writeShim(join(binDir, name), content);
  return { names: Object.keys(scripts), unresolved };
}

export async function writeShims(binDir, pm, opts = {}) { return (await writeShimSet(binDir, pm, opts)).names; }

/** Short pin text for prompts and decisions, e.g. "pnpm@10.4.1 (package.json packageManager), node 20 (.nvmrc)"; null when nothing is pinned. */
export function summary(pins) {
  const parts = [...(pins?.pm ? [`${pins.pm.name}@${pins.pm.version} (${pins.pm.source})`] : []), ...(pins?.node ? [`node ${pins.node.spec} (${pins.node.source})`] : [])];
  return parts.length ? parts.join(", ") : null;
}

/**
 * Detect pins in `dir` and, for a pinned package manager, write shims to `binDir`.
 * @returns {Promise<{pins, env:?object, shims:string[], summary:?string, warning:?string, notes:string[]}>}
 *   env is null and shims empty without a usable pm pin; summary is null when nothing is pinned: the caller changes nothing.
 */
export async function prepareToolchain({ dir, binDir, override = null, read, basePath = process.env.PATH ?? "",
  writeShim = writeShimFile, mkdirp = (d) => mkdir(d, { recursive: true }), find = which, resolveBins = resolvePinnedBins, hostNode = () => hostNodeVersion(basePath) } = {}) {
  const pins = await detectPins(dir, { override, ...(read ? { read } : {}) });
  const out = { pins, env: null, shims: [], summary: null, warning: null, notes: [...pins.notes] };
  if (pins.node) {
    let v = null;
    try { v = hostNode(); } catch { v = null; }
    out.warning = v ? nodeWarning(pins.node, v) : null;
  }
  const pm = pins.pm;
  let effective = pins;
  if (pm && binDir) {
    const set = await writeShimSet(binDir, pm, { path: basePath, find, writeShim, mkdirp, resolveBins });
    out.shims = set.names;
    if (set.unresolved.length) out.notes.push(`Toolchain: could not resolve ${set.unresolved.join(", ")} for ${pm.name}@${pm.version} once; its shim launches through npx on every call`);
    if (out.shims.length) out.env = toolchainEnv(binDir, basePath);
    else { out.notes.push(`Toolchain: ${pm.name}@${pm.version} is pinned but neither corepack nor npx is on PATH; the host ${pm.name} is used`); effective = { ...pins, pm: null }; }
  }
  out.summary = summary(effective);
  return out;
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImageManifest, manifestProvides } from "./image-manifest.mjs";

const IMAGE = loadImageManifest();

/**
 * Per-repo lane images (#5650): forge.yaml `execution.lane_tools` lists the tools a repo's lanes need (`name` or
 * `name@version`). The pool derives an image `FROM` the base lane image applying one recipe per tool. RECIPES is the only
 * place tool names appear. To add a tool, add an entry: `versioned` (accepts `@version`) and `steps(version)`, the
 * Dockerfile instructions (Debian/Ubuntu base, building as root) that install it.
 */
const apt = (...pkgs) => `RUN apt-get update && apt-get install -y --no-install-recommends ${pkgs.join(" ")} && rm -rf /var/lib/apt/lists/*`;
/** @deprecated Fallback only (#6017, #6037): pool/image/manifest.json is the source of truth for tools the image ships. */
export const RECIPES = {
  "postgresql-client": { versioned: true, steps: (v) => [apt(v ? `postgresql-client-${v}` : "postgresql-client")] },
  python: { versioned: true, steps: (v) => [apt(v ? `python${v} python${v}-venv` : "python3 python3-venv")] },
  xvfb: { versioned: false, steps: () => [apt("xvfb xauth")] }, // headless X for browser/GUI tests that call xvfb-run
  shellcheck: { versioned: false, steps: () => [apt("shellcheck")] }, // shell-script linter for validate commands
  yaml: { versioned: false, steps: () => [apt("python3-yaml")] }, // PyYAML for validate commands that `import yaml` (#5749)
  playwright: { versioned: true, steps: (v) => [`RUN npx --yes playwright${v ? `@${v}` : ""} install --with-deps chromium`] },
  // Example of a release-tarball tool; the version is required.
  promtool: { versioned: true, steps: (v) => [`RUN curl -fsSL https://github.com/prometheus/prometheus/releases/download/v${v ?? "2.54.1"}/prometheus-${v ?? "2.54.1"}.linux-amd64.tar.gz | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/promtool'`] },
};

const ENTRY_RE = /^([a-z0-9][a-z0-9.+_-]*)(?:@([A-Za-z0-9][A-Za-z0-9.+_-]*))?$/;
const typed = (code, message) => Object.assign(new Error(message), { code });

/** One entry -> {name, version}; throws a message naming the entry when it is empty or has shell metacharacters. */
export function parseLaneTool(entry) {
  const t = entry === undefined || entry === null ? "" : String(entry).trim();
  const m = ENTRY_RE.exec(t);
  if (!m) throw typed("lane_tools.invalid", `invalid execution.lane_tools entry ${JSON.stringify(t)}: expected name or name@version ([a-z0-9.+_-])`);
  return { name: m[1], version: m[2] ?? null };
}

/** A list (or comma string) -> {tools: sorted, deduped canonical entries, errors: messages naming each bad entry}. */
export function validateLaneTools(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || String(raw).trim() === "" ? [] : String(raw).split(",");
  const tools = new Set(), errors = [];
  for (const e of list) {
    try { const p = parseLaneTool(e); tools.add(p.version ? `${p.name}@${p.version}` : p.name); } catch (err) { errors.push(err.message); }
  }
  return { tools: [...tools].sort(), errors };
}

/** Binaries a recipe provides under another name (#5764): the probe misses `python3`, not the `python` recipe. */
const BINARY_RECIPES = { pip3: "python", psql: "postgresql-client", pg_dump: "postgresql-client", "xvfb-run": "xvfb" };

/** The recipe that provides `tool` (a recipe name or a binary it installs), else null (#5764). */
export function recipeFor(tool) {
  const t = String(tool);
  if (Object.hasOwn(RECIPES, t)) return t;
  if (/^python3(\.\d+)?$/.test(t)) return "python";
  return Object.hasOwn(BINARY_RECIPES, t) ? BINARY_RECIPES[t] : null;
}

/** True when `name` has a lane_tools recipe, directly or as a binary one provides (#5652, #5764). */
/** @deprecated Fallback only; see pool/image/manifest.json (#6017). */
export function hasRecipe(name) { return recipeFor(name) !== null; }

/**
 * In-sandbox install commands (#5652) for one tool: the recipe's Dockerfile `RUN` steps as shell commands, `sudo` prefixed
 * when the sandbox user is not root. Empty for a tool with no recipe or one the image manifest provides (#6037).
 * @deprecated Fallback only; pool/image/manifest.json replaces it (#6017).
 * Pure; the image build keeps using `steps`.
 */
export function installCommands(entry, { root = true } = {}) {
  const { name, version } = parseLaneTool(entry);
  // the image covers the tool only when no version is pinned, or the manifest entry carries that same version (#6147)
  const baked = (IMAGE?.tools ?? []).find((e) => e.name === name || e.binary === name);
  if (manifestProvides(IMAGE, name) && (!version || String(baked?.version ?? "") === String(version))) return [];
  const recipe = recipeFor(name);
  if (!recipe) return [];
  const sh = (s) => s.replace(/^RUN\s+/, "");
  // a binary alias installs the unversioned recipe: python@3.12 provides python3.12, not python3 (#5764)
  return RECIPES[recipe].steps(recipe === name ? version : null).map((s) => (root ? sh(s) : `sudo sh -c ${JSON.stringify(sh(s))}`));
}

/**
 * Generic install for a tool no recipe covers (2026-11-26 unclog): a missing Python module is pip-installed, a missing
 * Node package npm-installed into the worktree, a missing command apt-installed. Replaces adding one recipe per tool
 * (77 of 215 needs-human parks on open issues were "Remote sandbox lacks X"). `miss`: {kind, tool} from the validate
 * preflight. Returns [] for an image-manifest tool, an unsafe name or a kind nothing can install (environment, forgedock-path).
 * @deprecated Fallback only; pool/image/manifest.json replaces it (#6017, #6037).
 */
const PYPI = { yaml: "PyYAML", PIL: "Pillow", cv2: "opencv-python-headless", bs4: "beautifulsoup4", sklearn: "scikit-learn", dateutil: "python-dateutil", jwt: "PyJWT", dotenv: "python-dotenv", google: "protobuf", attr: "attrs", magic: "python-magic", Crypto: "pycryptodome", OpenSSL: "pyOpenSSL", serial: "pyserial", usb: "pyusb", zmq: "pyzmq", git: "GitPython", jose: "python-jose", multipart: "python-multipart" };
const SAFE = /^@?[A-Za-z0-9][A-Za-z0-9._/+-]*$/;
/** Debian/Ubuntu package stems where the import name differs (python3-<stem>). */
const APT_PY = { PIL: "pil", cv2: "opencv", bs4: "bs4", sklearn: "sklearn", dateutil: "dateutil", jwt: "jwt", dotenv: "dotenv", serial: "serial", git: "git", magic: "magic" };
/** Python modules a failed run's output reports missing (`No module named 'yaml'`, top-level name only). */
export function missingPythonModules(output) {
  return [...new Set([...String(output ?? "").matchAll(/No module named ['"]?([A-Za-z0-9_]+)/gi)].map((m) => m[1]))];
}
export function genericInstallCommands(miss, { root = true } = {}) {
  const tool = String(miss?.tool ?? "").trim();
  if (!tool || !SAFE.test(tool) || tool.includes("..") || (miss.kind === "command" && manifestProvides(IMAGE, tool))) return [];
  const su = (c) => (root ? c : `sudo sh -c ${JSON.stringify(c)}`);
  if (miss.kind === "python-module") {
    const mod = tool.split(".")[0], pkg = PYPI[mod] ?? mod;
    // 2026-11-26: lane images may ship python3 without pip; the distro package (python3-<module>) is the fallback
    const deb = `python3-${(APT_PY[mod] ?? mod).toLowerCase().replace(/_/g, "-")}`;
    // #6138: install into the interpreter the validate runs, system-wide (no --user: `python3 -I` ignores user site-packages), then the distro package
    const pip = `python3 -m pip install --quiet --break-system-packages ${pkg} || python3 -m pip install --quiet ${pkg}`;
    const apt = `apt-get update -qq && apt-get install -y --no-install-recommends ${deb} && rm -rf /var/lib/apt/lists/*`;
    return [root ? `${pip} || (${apt})` : `${su(pip)} || (${su(apt)})`];
  }
  if (miss.kind === "node-module") return [`npm install --no-save --no-audit --no-fund ${tool}`];
  if (miss.kind === "command" && !tool.includes("/")) return [su(`apt-get update -qq && apt-get install -y --no-install-recommends ${tool} && rm -rf /var/lib/apt/lists/*`)];
  return [];
}

/**
 * @deprecated Fallback only; see pool/image/manifest.json (#6017).
 * Installs `tools` in the running sandbox through the injected `run({command, timeoutMs})` -> {rc, stdout, stderr}.
 * Never throws: {ok:true} or {ok:false, tool, stderrTail}.
 */
export async function installLaneTools(tools, { run, root = true, timeoutMs = 600000 }) {
  for (const t of tools) {
    for (const command of installCommands(t, { root })) {
      let r;
      try { r = await run({ command, timeoutMs }); } catch (e) { r = { rc: 1, stderr: String(e?.message ?? e) }; }
      if ((r?.rc ?? 0) !== 0) return { ok: false, tool: t, stderrTail: String(r?.stderr || r?.stdout || "").trim().split("\n").slice(-8).join("\n").slice(-600) };
    }
  }
  return { ok: true };
}

/** Fails fast (before any docker call) for a tool with no recipe or an unsupported version. */
export function checkRecipes(tools) {
  for (const e of tools) {
    const { name, version } = parseLaneTool(e);
    const r = Object.hasOwn(RECIPES, name) ? RECIPES[name] : null;
    if (!r) throw typed("lane_tools.unknown_recipe", `no lane_tools recipe for ${JSON.stringify(name)} (known: ${Object.keys(RECIPES).join(", ")})`);
    if (version && !r.versioned) throw typed("lane_tools.unknown_recipe", `lane_tools recipe ${JSON.stringify(name)} takes no version (got ${version})`);
  }
}

/** Per-repo image tag: base tag plus a hash of the sorted tool list; the same list gives the same tag. */
export function laneToolsTag(baseImage, tools) {
  const h = createHash("sha256").update([...tools].sort().join("\n")).digest("hex").slice(0, 12);
  return `${baseImage}-t${h}`;
}

/** True when `tag` is the base image itself or a per-repo tools variant (`<base>-t<12 hex>`) of it. */
export function isLaneToolsTagOf(tag, base) {
  return typeof tag === "string" && (tag === base || (tag.startsWith(`${base}-t`) && /^[0-9a-f]{12}$/.test(tag.slice(base.length + 2))));
}

/** The generated Dockerfile: FROM the base lane image, then each recipe's steps in sorted order. */
export function laneToolsDockerfile(baseImage, tools) {
  const steps = [...tools].sort().flatMap((e) => { const { name, version } = parseLaneTool(e); return RECIPES[name].steps(version); });
  return [`FROM ${baseImage}`, "USER root", ...steps, ""].join("\n");
}

/** One in-flight build per tag (shared by every launch and the warm pool), and the last failure per tag. */
const BUILDS = new Map();
const FAILED = new Map();
/** How long a failed build is reported instead of retried. */
export const LANE_BUILD_RETRY_MS = 10 * 60000;

/**
 * The image a launch runs: `baseImage` when no tools; else the per-repo tag, reused when present, built from the base
 * otherwise. `docker.hasImage` and `docker.build(dir, tag, args)` are injected. Throws typed lane_tools.unknown_recipe
 * (nothing built) or lane_tools.build_failed (build error or timeout, never a hang).
 */
export async function resolveLaneImage({ tools = [], baseImage, docker, buildTimeoutMs = 45 * 60000, sleep }) {
  if (!tools.length) return baseImage;
  checkRecipes(tools);
  const tag = laneToolsTag(baseImage, tools);
  if (await docker.hasImage?.(tag)) return tag;
  if (!BUILDS.has(tag)) BUILDS.set(tag, buildLaneImage({ tag, baseImage, tools, docker, buildTimeoutMs, ...(sleep ? { sleep, retryDelayMs: 0 } : {}) }).finally(() => BUILDS.delete(tag)));
  return BUILDS.get(tag); // concurrent callers share one build of a tag
}

/**
 * Non-blocking form for a launch (the router waits ~120 s, a build can take many minutes): {image} when the tag exists,
 * {building: true} after starting (or joining) a background build, {failed: message} for a build that failed in the last
 * LANE_BUILD_RETRY_MS. Throws typed lane_tools.unknown_recipe.
 */
export async function laneImageNow({ tools = [], baseImage, docker, buildTimeoutMs = 45 * 60000, now = Date.now, sleep }) {
  if (!tools.length) return { image: baseImage };
  checkRecipes(tools);
  const tag = laneToolsTag(baseImage, tools);
  if (await docker.hasImage?.(tag)) return { image: tag };
  const f = FAILED.get(tag);
  if (f && now() - f.at < LANE_BUILD_RETRY_MS) return { failed: f.message };
  if (!BUILDS.has(tag)) {
    FAILED.delete(tag);
    const p = buildLaneImage({ tag, baseImage, tools, docker, buildTimeoutMs, ...(sleep ? { sleep, retryDelayMs: 0 } : {}) }).catch((e) => { FAILED.set(tag, { at: now(), message: e.message }); }).finally(() => BUILDS.delete(tag));
    BUILDS.set(tag, p);
  }
  return { building: true, tag };
}

/** #6189: the last ~20 lines of a build error (the failing step's own output), bounded to `max` chars. */
export function buildErrorTail(e, max = 1500) {
  const t = String(e?.stderr || e?.message || e || "").trim().split("\n").slice(-20).join("\n");
  return t.length <= max ? t : `…${t.slice(t.length - max + 1)}`;
}

async function buildLaneImage({ tag, baseImage, tools, docker, buildTimeoutMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 15000 }) {
  const dir = mkdtempSync(join(tmpdir(), "lane-tools-"));
  let timer;
  try {
    writeFileSync(join(dir, "Dockerfile"), laneToolsDockerfile(baseImage, tools));
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`build timed out after ${buildTimeoutMs}ms`)), buildTimeoutMs); });
    const attempt = () => Promise.race([docker.build(dir, tag, {}), timeout]);
    try { await attempt(); } catch { await sleep(retryDelayMs); await attempt(); } // #6189: one retry, a failed build is often transient
  } catch (e) {
    throw typed("lane_tools.build_failed", `lane_tools image ${tag} build failed: ${buildErrorTail(e)}`);
  } finally { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); }
  return tag;
}

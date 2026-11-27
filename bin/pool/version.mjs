// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Content hash of a directory's files (sorted, non-recursive is enough for pool/image/ and bin/pool/). */
function dirHash(dir) {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).sort()) {
    try { h.update(f); h.update(readFileSync(join(dir, f))); } catch { /* subdirectory */ }
  }
  return h.digest("hex").slice(0, 12);
}

/** What an agent is running: package version, code hash and lane-image recipe hash. Agents and router compare these. */
export function versionOf(root = repoRoot) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return { version: pkg.version, code: dirHash(join(root, "bin", "pool")), image: dirHash(join(root, "pool", "image")) };
}

/** The lane image is tagged and built from the ForgeDock package version (no separate pin). */
export const laneImageTag = (version) => `forgedock-lane:${version}`;
export const laneBuildArgs = (version) => ({ FORGEDOCK_VERSION: version });

/** Numeric dotted-version compare (1.10 > 1.9): negative, 0 or positive; null when either side is not a version. */
export function cmpVersion(a, b) {
  const parts = (v) => (typeof v === "string" && /^v?\d+(\.\d+)*/.test(v.trim()) ? v.trim().replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number) : null);
  const x = parts(a), y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

/** Agents (from the router /status view) whose lane engine is below the target version: [{name, version}]. */
export const agentsLeftBehind = (agents, target) => (agents ?? []).filter((a) => a?.ok !== false && cmpVersion(a?.engine_version, target) < 0).map((a) => ({ name: a.name, version: a.engine_version }));
export const leftBehindLine = (rows, target) => `agents left behind on an older engine (target ${target}): ${rows.map((r) => `${r.name} ${r.version}`).join(", ")}`;

/** The router config the pool CLI uses: router.json plus the forgedock token (inline, `forgedock_token_file`, or forgedock.token beside it). */
export function readRouterConfig(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  let token = cfg.forgedock_token;
  if (!token) { try { token = readFileSync(cfg.forgedock_token_file ?? join(dirname(configPath), "forgedock.token"), "utf8").trim(); } catch { token = undefined; } }
  return { ...cfg, forgedock_token: token };
}

/** Ask the local router which agents lag the target engine; [] when the router is unreachable. */
async function fetchLeftBehind(configPath) {
  try {
    const cfg = readRouterConfig(configPath);
    const base = `http://${cfg.listen.host}:${cfg.listen.port}`;
    const { call } = await import("./http.mjs");
    const [st, v] = await Promise.all([call(base, "GET", "/status", { token: cfg.forgedock_token }), call(base, "GET", "/version", { token: cfg.forgedock_token })]);
    return { target: v.data?.version, rows: agentsLeftBehind(st.data?.agents, v.data?.version) };
  } catch { return { target: undefined, rows: [] }; }
}

/**
 * The local router runs the installed bin/pool code (its /version `code` hash equals versionOf().code). When it does not,
 * restart it through `restart()` (systemd user unit by default) and poll `/version` for up to `waitMs`. Returns
 * {ok, running, installed, why}. `probe(configPath)` returns the router's /version data or null.
 */
export async function routerFresh(configPath, { installed = installedFor(configPath), probe = probeRouterVersion, restart = restartRouterUnit, waitMs = 30000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const same = (v) => v && v.code === installed.code && v.version === installed.version;
  let v = await probe(configPath);
  if (same(v)) return { ok: true, running: v.version, installed: installed.version };
  if (!v) return { ok: false, running: null, installed: installed.version, why: "router unreachable" };
  if (!(await restart())) return { ok: false, running: v.version, installed: installed.version, why: "could not restart the router" };
  for (let t = 0; t < waitMs; t += 1000) { await sleep(1000); v = await probe(configPath); if (same(v)) return { ok: true, running: v.version, installed: installed.version }; }
  return { ok: false, running: v?.version ?? null, installed: installed.version, why: "router did not come back on the installed code" };
}
/** What the router would hash: its configured repo_root, else this package. */
function installedFor(configPath) {
  try { const c = JSON.parse(readFileSync(configPath, "utf8")); return versionOf(c.repo_root ?? repoRoot); } catch { return versionOf(); }
}
async function probeRouterVersion(configPath) {
  try {
    const cfg = readRouterConfig(configPath);
    const { call } = await import("./http.mjs");
    const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "GET", "/version", { token: cfg.forgedock_token });
    const d = r?.data;
    return d && typeof d.code === "string" && typeof d.version === "string" ? d : null; // a 401/500 body is "unknown", never "stale"
  } catch { return null; }
}
async function restartRouterUnit() {
  try { const { execFileSync } = await import("node:child_process"); execFileSync("systemctl", ["--user", "restart", "computeshare-router.service"], { stdio: "ignore", timeout: 30000 }); return true; } catch { return false; }
}

/**
 * `forgedock update` hook: push the new code and lane image to every enrolled agent. A no-op on hosts without a
 * pool router config; never throws (a failed push must not fail the update). Returns "skipped" | "upgraded" | "failed";
 * agents still on an older engine afterwards are named through `warn` (and `onLeftBehind`).
 */
export async function upgradeAgentsAfterUpdate({ configPath = process.env.COMPUTESHARE_CONFIG ?? join(homedir(), ".config/computeshare/router.json"), runPoolCli, warn = console.warn, leftBehind = fetchLeftBehind, onLeftBehind, ensureRouterFresh } = {}) {
  if (!existsSync(configPath)) return "skipped";
  try {
    // The router builds the agent bundle from the code it is RUNNING: a router still on the old version ships an incomplete
    // bundle and the upgraded agent crash-loops at import. Restart it onto the installed code first, or do not push.
    const fresh = await (ensureRouterFresh ?? routerFresh)(configPath);
    if (!fresh.ok) { warn(`pool upgrade skipped: the router runs ${fresh.running ?? "unknown"} code but ${fresh.installed} is installed (${fresh.why}); restart computeshare-router, then run forgedock pool upgrade`); return "skipped"; }
    const run = runPoolCli ?? (await import("./cli.mjs")).runPoolCli;
    await run(["upgrade", "--config", configPath]);
    const { target, rows } = await leftBehind(configPath);
    if (rows.length) { warn(leftBehindLine(rows, target)); onLeftBehind?.(rows); }
    return "upgraded";
  } catch (e) {
    warn(`pool upgrade after update failed: ${e.message}`);
    return "failed";
  }
}

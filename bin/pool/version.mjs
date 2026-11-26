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
/** The registry ref the release workflow pushes (GHCR, tagged with the npm version); FORGEDOCK_LANE_REPO overrides the repository. */
export const DEFAULT_LANE_REPO = "ghcr.io/rapiercraftstudios/forgedock-lane";
export const lanePublishedRef = (version, repo = process.env.FORGEDOCK_LANE_REPO || DEFAULT_LANE_REPO) => `${repo}:${version}`;
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

/** Ask the local router which agents lag the target engine; [] when the router is unreachable. */
async function fetchLeftBehind(configPath) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const base = `http://${cfg.listen.host}:${cfg.listen.port}`;
    const { call } = await import("./http.mjs");
    const [st, v] = await Promise.all([call(base, "GET", "/status", { token: cfg.forgedock_token }), call(base, "GET", "/version", { token: cfg.forgedock_token })]);
    return { target: v.data?.version, rows: agentsLeftBehind(st.data?.agents, v.data?.version) };
  } catch { return { target: undefined, rows: [] }; }
}

/**
 * `forgedock update` hook: push the new code and lane image to every enrolled agent. A no-op on hosts without a
 * pool router config; never throws (a failed push must not fail the update). Returns "skipped" | "upgraded" | "failed";
 * agents still on an older engine afterwards are named through `warn` (and `onLeftBehind`).
 */
export async function upgradeAgentsAfterUpdate({ configPath = process.env.COMPUTESHARE_CONFIG ?? join(homedir(), ".config/computeshare/router.json"), runPoolCli, warn = console.warn, leftBehind = fetchLeftBehind, onLeftBehind } = {}) {
  if (!existsSync(configPath)) return "skipped";
  try {
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

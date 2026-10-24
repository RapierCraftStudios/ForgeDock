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

/**
 * `forgedock update` hook: push the new code and lane image to every enrolled agent. A no-op on hosts without a
 * pool router config; never throws (a failed push must not fail the update). Returns "skipped" | "upgraded" | "failed".
 */
export async function upgradeAgentsAfterUpdate({ configPath = process.env.COMPUTESHARE_CONFIG ?? join(homedir(), ".config/computeshare/router.json"), runPoolCli, warn = console.warn } = {}) {
  if (!existsSync(configPath)) return "skipped";
  try {
    const run = runPoolCli ?? (await import("./cli.mjs")).runPoolCli;
    await run(["upgrade", "--config", configPath]);
    return "upgraded";
  } catch (e) {
    warn(`pool upgrade after update failed: ${e.message}`);
    return "failed";
  }
}

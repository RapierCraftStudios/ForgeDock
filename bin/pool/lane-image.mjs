// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6166: a pool host gets the lane image by PULLING the one publish.yml built (ghcr.io), and builds locally only when the pull fails.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve4 } from "node:dns/promises";
import { DNS_FAIL_RE } from "./docker-dns.mjs";

export const LANE_REGISTRY_IMAGE = "ghcr.io/rapiercraftstudios/forgedock-lane";
/** Label the Dockerfile stamps with the recipe hash (versionOf().image); checked after a pull. */
export const RECIPE_LABEL = "forgedock.recipe";
/** Hosts dockerd contacts for a pull from ghcr.io and for a build FROM docker.io (the IPv4 pins cover exactly these). */
export const REGISTRY_HOSTS = ["ghcr.io", "pkg-containers.githubusercontent.com", "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"];
/** dockerd/BuildKit dial the AAAA record and do not fall back to A (WSL mirrored networking has no IPv6 route). */
export const IPV6_DIAL_RE = /cannot assign requested address|network is unreachable|dial tcp \[[0-9a-f:]+\]/i;
const PIN_MARK = "# forgedock-ipv4-pin";

const errText = (e) => String(e?.stderr || e?.stdout || e?.message || e || "");

/** Remote ref of the lane image for a ForgeDock version. */
export const remoteLaneImage = (version) => `${LANE_REGISTRY_IMAGE}:${version}`;
/** Tag carrying the image recipe hash, pushed beside the version tag (identifies the recipe independent of a version bump). */
export const remoteRecipeImage = (recipe) => `${LANE_REGISTRY_IMAGE}:r-${recipe}`;

/** Remote ref of a lane_tools variant: the local tag `<base>-t<12 hex>` published as `forgedock-lane:<version>-t<12 hex>` (#6187). */
export const remoteVariantImage = (version, tag) => `${LANE_REGISTRY_IMAGE}:${version}${String(tag).slice(String(tag).lastIndexOf("-t"))}`;

let pinDepth = 0; // concurrent pins share one /etc/hosts edit; the last one out removes it
/**
 * Run `fn` with temporary /etc/hosts IPv4 pins for the registry hosts (lines tagged `# forgedock-ipv4-pin`), removed afterwards,
 * also stale ones left by a crashed agent. Needs write access to the hosts file (the agent runs as root); throws when it has none.
 */
export async function withIpv4Pins(fn, { hosts = REGISTRY_HOSTS, file = "/etc/hosts", resolve = resolve4, log = null } = {}) {
  const strip = (t) => t.split("\n").filter((l) => !l.includes(PIN_MARK)).join("\n");
  if (pinDepth === 0) {
    const lines = [];
    for (const h of hosts) { try { const [ip] = await resolve(h); if (ip) lines.push(`${ip} ${h} ${PIN_MARK}`); } catch { /* no A record: leave that host alone */ } }
    if (!lines.length) throw new Error("ipv4 pins: no A records resolved");
    const cur = readFileSync(file, "utf8");
    writeFileSync(file, `${strip(cur).replace(/\n*$/, "\n")}${lines.join("\n")}\n`);
    log?.info?.(`pinned IPv4 for ${lines.length} registry hosts in ${file}`);
  }
  pinDepth++;
  try { return await fn(); } finally {
    if (--pinDepth === 0) { try { writeFileSync(file, strip(readFileSync(file, "utf8")).replace(/\n*$/, "\n")); } catch (e) { log?.warn?.(`could not remove IPv4 pins from ${file}: ${errText(e)}`); } }
  }
}

/** Run `op`; on a docker DNS failure repair the daemon DNS and retry once (#6195); on an IPv6 dial error retry it once under temporary IPv4 pins. A host that cannot pin reports the original error. */
export async function withIpv4Fallback(op, pinOpts = {}) {
  try { return await op(); } catch (e) {
    if (DNS_FAIL_RE.test(errText(e)) && pinOpts.ensureDns) {
      // #6195: dockerd's resolver is broken; set daemon DNS and retry once when docker was restarted.
      pinOpts.log?.warn?.(`docker DNS error; repairing daemon DNS: ${errText(e).slice(-300)}`);
      let fixed = null;
      try { fixed = await pinOpts.ensureDns(); } catch { /* report the original error */ }
      if (!fixed?.restarted) throw e;
      return withIpv4Fallback(op, { ...pinOpts, ensureDns: null });
    }
    if (!IPV6_DIAL_RE.test(errText(e))) throw e;
    pinOpts.log?.warn?.(`IPv6 dial error; retrying with IPv4 pins: ${errText(e).slice(-300)}`);
    try { return await withIpv4Pins(op, pinOpts); } catch (e2) { if (e2 === e || IPV6_DIAL_RE.test(errText(e2))) throw e2; throw e; }
  }
}

/**
 * Pull the published lane image, retag it as `image` and verify its recipe label equals `recipe`. Resolves true on success;
 * a mismatched image is removed again (it must never serve lanes) and rejects.
 */
export async function pullLaneImage({ docker, image, version, recipe, log = null, pinOpts = {} }) {
  const remote = remoteLaneImage(version);
  await withIpv4Fallback(() => docker.pull(remote), { ...pinOpts, log });
  const got = await docker.imageLabel(remote, RECIPE_LABEL);
  if (got !== recipe) {
    try { await docker.removeImage?.(remote); } catch { /* best effort */ }
    throw new Error(`pulled ${remote} has recipe ${got || "(none)"}, want ${recipe}`);
  }
  await docker.tag(remote, image);
  // #6184: the ghcr tag is invisible to pruneLaneImages and would pin the image's layers forever; untagging it frees nothing yet keeps `image`.
  try { await docker.removeImage?.(remote); } catch (e) { log?.warn?.(`could not drop ${remote} tag: ${errText(e).slice(-200)}`); }
  return true;
}

/**
 * Make `image` exist locally: already present, else pulled (only the default `forgedock-lane:<version>` tag has a published
 * counterpart), else built by `build()`. Resolves "present" | "pulled" | "built". `build` is wrapped in the IPv4 fallback too.
 */
export async function provideLaneImage({ docker, image, version, recipe, publishable = true, build, log = null, pinOpts = {} }) {
  if (await docker.hasImage?.(image)) return "present";
  if (publishable && recipe && docker.pull && docker.tag && docker.imageLabel) {
    try {
      await pullLaneImage({ docker, image, version, recipe, log, pinOpts });
      log?.info?.(`${image} pulled from ${remoteLaneImage(version)}; no build`);
      return "pulled";
    } catch (e) { log?.warn?.(`pull of ${remoteLaneImage(version)} failed, building locally: ${errText(e).slice(-300)}`); }
  }
  await withIpv4Fallback(build, { ...pinOpts, log });
  return "built";
}

/** Pull the published variant for local `tag` and retag it as `tag` (#6187). Rejects when the registry has none; the caller builds. */
export async function pullVariantImage({ docker, tag, version, log = null, pinOpts = {} }) {
  const remote = remoteVariantImage(version, tag);
  await withIpv4Fallback(() => docker.pull(remote), { ...pinOpts, log });
  await docker.tag(remote, tag);
  log?.info?.(`${tag} pulled from ${remote}; no build`);
  return true;
}

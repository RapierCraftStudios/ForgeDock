#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6187: enumerate the pool-served lane_tools sets (pool/image/lane-tools-sets.json) as published variant tags.
//   node scripts/lane-variants.mjs <version>            print `<remote tag> <local tag>` per set
//   node scripts/lane-variants.mjs <version> --build    build each (FROM the pushed base) and push it; a failed set is reported, the rest continue
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { laneToolsTag, laneToolsDockerfile, validateLaneTools, checkRecipes } from "../bin/pool/lane-tools.mjs";
import { remoteLaneImage, remoteVariantImage } from "../bin/pool/lane-image.mjs";

const SETS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "pool", "image", "lane-tools-sets.json");

/** The validated sets: each an array of canonical tool entries; throws naming a bad entry or an unknown recipe. */
export function loadSets(file = SETS_FILE) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${file}: expected an array of tool lists`);
  return raw.map((set, i) => {
    const { tools, errors } = validateLaneTools(set);
    if (errors.length || !tools.length) throw new Error(`${file} set ${i}: ${errors.join("; ") || "empty"}`);
    checkRecipes(tools);
    return tools;
  });
}

/** [{tools, local, remote, dockerfile}] for `version`; local is `<base>-t<hash>` on the published base ref, remote the variant tag. */
export function variants(version, sets = loadSets()) {
  const base = remoteLaneImage(version);
  return sets.map((tools) => { const local = laneToolsTag(base, tools); return { tools, tag: local, remote: remoteVariantImage(version, local), dockerfile: laneToolsDockerfile(base, tools) }; });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, flag] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) { console.error("usage: lane-variants.mjs <X.Y.Z> [--build]"); process.exit(2); }
  let failed = 0;
  for (const v of variants(version)) {
    console.log(`${v.remote} ${v.tools.join(",")}`);
    if (flag !== "--build") continue;
    const dir = mkdtempSync(join(tmpdir(), "lane-variant-"));
    try {
      writeFileSync(join(dir, "Dockerfile"), v.dockerfile);
      const r = spawnSync("docker", ["buildx", "build", "--platform", "linux/amd64", "--push", "--label", `org.opencontainers.image.source=${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? ""}`, "-t", v.remote, dir], { stdio: "inherit" });
      if (r.status !== 0) { failed++; console.error(`::warning::variant ${v.remote} was not published; hosts build it locally`); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  process.exit(failed ? 1 : 0);
}

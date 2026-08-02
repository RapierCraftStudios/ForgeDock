// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldReResolve } from "../../bin/engine/resolve.mjs";

/** Parse the Pi re-resolution controls with the workflow's required YAML parser. */
export function parsePiReResolveConfig(source) {
  const parsed = spawnSync(
    "yq",
    ["-o=json", "-I=0", ".orchestration.reresolve // {}", "-"],
    { encoding: "utf8", input: String(source || ""), windowsHide: true },
  );
  if (parsed.status !== 0 || parsed.error) return {};

  try {
    const controls = JSON.parse(parsed.stdout || "{}");
    if (!controls || Array.isArray(controls) || typeof controls !== "object") return {};
    const config = {};
    if (Object.hasOwn(controls, "enabled")) config.enabled = controls.enabled;
    if (Object.hasOwn(controls, "max_rounds")) {
      const rounds = Number(controls.max_rounds);
      if (Number.isFinite(rounds)) config.maxRounds = rounds;
    }
    return config;
  } catch {
    return {};
  }
}

export function loadPiReResolveConfig(projectRoot) {
  try {
    return parsePiReResolveConfig(readFileSync(join(projectRoot, "forge.yaml"), "utf8"));
  } catch {
    return {};
  }
}

export function piReResolveDecision(config, roundsSoFar) {
  return shouldReResolve(
    { kind: "query", pattern: "github-issue-search-url", args: [] },
    config,
    roundsSoFar,
  );
}

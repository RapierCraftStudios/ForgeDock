// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { shouldReResolve } from "../../bin/engine/resolve.mjs";

/** Parse the Pi re-resolution controls with the packaged YAML parser. */
export function parsePiReResolveConfig(source) {
  try {
    const document = parse(String(source || ""));
    const controls = document?.orchestration?.reresolve;
    if (!controls || Array.isArray(controls) || typeof controls !== "object") return {};
    const config = {};
    if (Object.hasOwn(controls, "enabled")) config.enabled = controls.enabled;
    if (Object.hasOwn(controls, "max_rounds")) {
      const rounds = Number(controls.max_rounds);
      if (Number.isFinite(rounds)) config.maxRounds = rounds;
    }
    return config;
  } catch {
    // A malformed policy must never silently fall back to default-on autonomy.
    return { enabled: false };
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

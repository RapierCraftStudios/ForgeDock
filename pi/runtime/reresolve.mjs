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
    if (!document || typeof document !== "object" || Array.isArray(document)) return { enabled: false };
    if (!Object.hasOwn(document, "orchestration")) return {};
    const orchestration = document.orchestration;
    if (!orchestration || typeof orchestration !== "object" || Array.isArray(orchestration)) {
      return { enabled: false };
    }
    if (!Object.hasOwn(orchestration, "reresolve")) return {};
    const controls = orchestration.reresolve;
    if (!controls || Array.isArray(controls) || typeof controls !== "object") return { enabled: false };
    const allowedKeys = new Set(["enabled", "max_rounds"]);
    if (Object.keys(controls).some((key) => !allowedKeys.has(key))) return { enabled: false };

    const config = {};
    if (Object.hasOwn(controls, "enabled")) {
      const enabled = controls.enabled;
      if (typeof enabled === "boolean") config.enabled = enabled;
      else if (typeof enabled === "string" && /^(true|false|on|off)$/i.test(enabled.trim())) {
        config.enabled = /^(true|on)$/i.test(enabled.trim());
      } else return { enabled: false };
    }
    if (Object.hasOwn(controls, "max_rounds")) {
      const rounds = controls.max_rounds;
      if (!Number.isInteger(rounds) || rounds < 0) return { enabled: false };
      config.maxRounds = rounds;
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

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldReResolve } from "../../bin/engine/resolve.mjs";

function unquote(value) {
  const trimmed = String(value || "").replace(/\s+#.*$/, "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse only the orchestration.reresolve controls needed by the Pi controller. */
export function parsePiReResolveConfig(source) {
  const config = {};
  let orchestrationIndent;
  let reresolveIndent;

  for (const line of String(source || "").split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    const key = line.trim();

    if (/^orchestration\s*:/.test(key)) {
      orchestrationIndent = indent;
      reresolveIndent = undefined;
      continue;
    }
    if (orchestrationIndent === undefined || indent <= orchestrationIndent) {
      orchestrationIndent = undefined;
      reresolveIndent = undefined;
      continue;
    }
    if (/^reresolve\s*:/.test(key)) {
      reresolveIndent = indent;
      continue;
    }
    if (reresolveIndent === undefined) continue;
    if (indent <= reresolveIndent) {
      reresolveIndent = undefined;
      continue;
    }

    const match = key.match(/^(enabled|max_rounds)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const value = unquote(match[2]);
    if (match[1] === "enabled") config.enabled = /^false$/i.test(value) ? false : value;
    if (match[1] === "max_rounds") {
      const rounds = Number(value);
      if (Number.isFinite(rounds)) config.maxRounds = rounds;
    }
  }
  return config;
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

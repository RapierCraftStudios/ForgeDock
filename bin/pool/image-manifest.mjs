// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The lane image manifest (#6035, #6037): pool/image/manifest.json lists the tools the pool image ships. Plan-time preflight
 * and the sandbox install path resolve a tool against it instead of probing or installing it. Pure apart from the file read.
 */
export const MANIFEST_PATH = fileURLToPath(new URL("../../pool/image/manifest.json", import.meta.url));

/** {tools: [{name, binary, ...}]}; a missing or malformed file yields an empty manifest, never throws. */
export function loadImageManifest(path = MANIFEST_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { tools: (Array.isArray(raw?.tools) ? raw.tools : []).filter((t) => t && typeof t.name === "string") };
  } catch { return { tools: [] }; }
}

/** True when `tool` is the name or binary of a manifest entry. */
export function manifestProvides(manifest, tool) {
  const t = String(tool ?? "");
  return !!t && (manifest?.tools ?? []).some((e) => e.name === t || e.binary === t);
}

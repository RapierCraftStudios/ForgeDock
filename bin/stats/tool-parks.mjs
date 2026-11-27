// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { manifestProvides } from "../pool/image-manifest.mjs";

/**
 * #6037 zero-park metric: needs-human parks coded `env.tool_missing` whose detail names a tool the image manifest ships.
 * `parks`: [{issue, code, detail, ts}]. Pure. ok is true only when no such park falls inside the window.
 */
export function manifestToolParks(parks, manifest, { now = Date.now(), windowDays = 7 } = {}) {
  const since = now - windowDays * 864e5, offenders = [];
  for (const p of Array.isArray(parks) ? parks : []) {
    const ts = Date.parse(p?.ts);
    if (p?.code !== "env.tool_missing" || !(ts >= since) || ts > now) continue;
    const words = String(p.detail ?? "").split(/[\s,`'"():;]+/);
    const tool = words.find((w) => manifestProvides(manifest, w));
    if (tool) offenders.push({ issue: p.issue, tool });
  }
  return { count: offenders.length, offenders, ok: offenders.length === 0 };
}

/** Reports the metric and sets a nonzero exit code when a manifest tool was parked. Returns the result. */
export function check(parks, manifest, opts = {}) {
  const r = manifestToolParks(parks, manifest, opts);
  if (!r.ok) {
    process.stderr.write(`tool-parks: ${r.count} env.tool_missing park(s) name an image-manifest tool: ${r.offenders.map((o) => `#${o.issue} ${o.tool}`).join(", ")}\n`);
    process.exitCode = 1;
  }
  return r;
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge.yaml `recurrence.hot_areas` (#5751): areas where one lane at a time may work (branch lock), and `pathsOverlap`.
 * The recurrence design routing (symptom/area detection, design lane, design block requirement) was cut in #6083: it had no
 * measured catch and 15 parks on 11 issues in 25 days.
 */
const clean = (p) => String(p ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);

/**
 * forge.yaml `recurrence:`: `hot_areas` is a list of {name, paths} or a block map {name: "glob, glob"}.
 * @returns {{hotAreas:{name:string, paths:string[]}[]}}
 */
export function parseRecurrenceConfig(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rows = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).map(([name, val]) => ({ name, val })) : []);
  const hotAreas = rows(r.hot_areas).map((x) => ({ name: String(x?.name ?? "").trim(), paths: list(x?.paths ?? x?.val).map(clean) }))
    .filter((a) => a.name && a.paths.length);
  return { hotAreas };
}

/** Two paths overlap when they are equal or one is a directory prefix of the other. */
export function pathsOverlap(a, b) {
  const x = clean(a), y = clean(b);
  return Boolean(x && y) && (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`));
}

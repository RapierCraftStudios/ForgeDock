// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * English copies in locale catalogs (#4596). A lane adds a key to the source-locale (en) JSON catalog and copies the
 * English text into the other locales; the repo's own i18n check rejects it, but only on CI. Deterministic (git, no LLM):
 * for each changed non-en JSON catalog whose en counterpart exists, the keys the lane added whose string value equals the
 * en value. Counterpart: the path with its locale segment (a directory or the file stem) replaced by `en`.
 */
const LOCALE_RE = /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/;
const MAX_FINDINGS = 200;
const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const out = (git) => async (args) => { try { return String(await git(args)); } catch { return ""; } };

/** The en counterpart path of a non-en catalog path, or null when no segment looks like a locale code. */
export function sourcePath(path) {
  const segs = String(path).split("/");
  for (let i = segs.length - 1; i >= 0; i--) {
    const last = i === segs.length - 1;
    const m = last ? /^(.+)\.json$/.exec(segs[i]) : null;
    const name = last ? (m ? m[1] : "") : segs[i];
    if (!LOCALE_RE.test(name) || name === "en") continue;
    const copy = [...segs];
    copy[i] = last ? "en.json" : "en";
    return copy.join("/");
  }
  return null;
}

/** Flattened string leaves of a JSON catalog as Map(dotted key -> value); an empty map on invalid JSON. */
export function flatten(text) {
  const res = new Map();
  let doc;
  try { doc = JSON.parse(String(text ?? "")); } catch { return res; }
  const walk = (v, key) => {
    if (typeof v === "string") res.set(key, v);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}.${k}` : k);
  };
  walk(doc, "");
  return res;
}

/** A value worth translating: three letters in a row once placeholders are removed (not "OK", "{{n}}", "12:00"). */
const translatable = (v) => /\p{L}{3}/u.test(v.replace(/\{\{?[^}]*\}\}?/g, ""));

/** @returns {Promise<Array<{path, key, value, source}>>}; never throws ([] on any failure). */
export async function englishCopies({ git, base }) {
  try {
    const g = out(git);
    const changed = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`])).filter((f) => f.endsWith(".json"));
    const res = [];
    for (const f of changed) {
      const src = sourcePath(f);
      if (!src) continue;
      const en = flatten(await g(["show", `HEAD:${src}`]));
      if (!en.size) continue;
      const was = flatten(await g(["show", `${base}:${f}`]));
      for (const [key, value] of flatten(await g(["show", `HEAD:${f}`]))) {
        if (was.has(key) || en.get(key) !== value || !translatable(value)) continue;
        res.push({ path: f, key, value, source: src });
        if (res.length >= MAX_FINDINGS) return res;
      }
    }
    return res;
  } catch { return []; }
}

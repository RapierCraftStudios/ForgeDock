// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared surfaces (#5340): files every lane of a feature may touch (registries, route tables, migration dirs, versioned
 * dirs, OpenAPI, i18n catalogs). forge.yaml `engine.shared_surfaces` lists them as globs, one per entry
 * (comma-separated scalar or block list); `glob => command` marks an append-only registry the repo regenerates, which
 * lanes must not hand-edit and which is never reserved. A lane whose frozen contract touches a declared surface takes a
 * host reservation (one slot per repo + surface, across the milestone lane and the default branch) until its merge and
 * records what it will add, so sibling packs show it. Pure parsing here; the lease and declaration records are in seqlease.mjs.
 * Fail-open: no declared surface, or a failed lease, changes nothing.
 */
export const SURFACE_LANE = "*"; // the lease key spans every lane branch: the milestone lane and the default branch share a surface

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
/** A repo-relative glob as a RegExp: `**` any depth, `*` within a segment, `?` one char; a trailing `/` means the whole dir. */
export function surfaceGlobRegExp(glob) {
  let g = String(glob).trim().replace(/^\.?\/+/, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

/** engine.shared_surfaces (string or array) -> [{name, generate|null, test(path)}]; blanks and duplicates dropped. */
export function parseSharedSurfaces(raw) {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set(), out = [];
  for (const it of items) {
    const [glob, ...rest] = String(it ?? "").split("=>");
    const name = glob.trim().replace(/^\.?\/+/, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const generate = rest.join("=>").trim() || null;
    const re = surfaceGlobRegExp(name);
    out.push({ name, generate, test: (p) => re.test(String(p).replace(/^\.?\/+/, "")) });
  }
  return out;
}

/** The surfaces `paths` touch: `reserved` (take a slot) and `generated` (declared generator, hand-edits discouraged). */
export function matchSurfaces(surfaces, paths) {
  const reserved = [], generated = [];
  for (const s of surfaces ?? []) {
    const files = (paths ?? []).filter((p) => s.test(p));
    if (!files.length) continue;
    (s.generate ? generated : reserved).push({ name: s.name, files, generate: s.generate });
  }
  return { reserved, generated };
}

/** Builder note for the surfaces of an append-only registry: run the generator, never hand-edit the list. */
export function generatorNote(generated) {
  if (!generated?.length) return "";
  return `\n\nGenerated shared surfaces (forge.yaml engine.shared_surfaces): do not hand-edit ${generated.map((g) => g.name).join(", ")}; regenerate with ${generated.map((g) => `\`${g.generate}\``).join(", ")}.`;
}

/**
 * Take the reserved slot of every surface the contract's deliverables touch and declare them for sibling packs.
 * `lease` is makeSequenceLeaseIo(). @returns {Promise<{names:string[], generated:object[], waitMs:number, timedOut:boolean, release:Function}|null>}
 * null when nothing is declared or touched.
 */
export async function claimSurfaces({ lease, repo, issue, surfaces, paths, maxWaitS = 1800 }) {
  const { reserved, generated } = matchSurfaces(surfaces, paths);
  if (!reserved.length) return generated.length ? { names: [], generated, waitMs: 0, timedOut: false, release() {} } : null;
  try { await lease.declare?.({ repo, issue, surfaces: reserved.map((r) => r.name), paths: reserved.flatMap((r) => r.files) }); } catch { /* fail-open */ }
  let g = null;
  try { g = await lease.acquire({ repo, lane: SURFACE_LANE, dirs: reserved.map((r) => `surface:${r.name}`), issue, maxWaitS }); } catch { g = null; }
  return { names: reserved.map((r) => r.name), generated, waitMs: g?.waitMs ?? 0, timedOut: g?.timedOut ?? false, release: () => { try { g?.release(); } catch { /* fail-open */ } } };
}

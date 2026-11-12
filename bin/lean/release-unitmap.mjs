// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Unit/coupling/contract/force resolver for `.forge/release.yaml` (#5551): every path resolves to a unit or "none". */

/** Glob to RegExp: `**` any depth (a trailing `/**` also matches the directory's files), `*` within a segment, `?` one char. */
export function unitGlobToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (globs, path) => (globs ?? []).some((g) => unitGlobToRegExp(String(g)).test(path));

/**
 * @returns {{path, unit: string|"none", units: string[], affects: string[], contracts: object[], forces: object[]}}
 * `unit` is the first unit (declaration order) owning the path; `units` every owner; `affects` the units the matching couplings fan out to.
 */
export function resolvePath(policy, rawPath) {
  const path = String(rawPath).replace(/^\.\//, "");
  const units = Object.entries(policy?.units ?? {}).filter(([, u]) => matchesAny(u?.paths, path)).map(([id]) => id);
  const affects = [...new Set((policy?.couplings ?? []).filter((c) => matchesAny(c.paths, path)).flatMap((c) => c.affects ?? []))];
  return {
    path, unit: units[0] ?? "none", units, affects,
    contracts: (policy?.contracts ?? []).filter((c) => matchesAny(c.paths, path)),
    forces: (policy?.forces ?? []).filter((f) => matchesAny(f.paths, path)),
  };
}

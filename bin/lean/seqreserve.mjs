// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Build-start number reservation (#5235). The #4386/#4526 reservation covers numbers at renumber time; a builder still picks
 * its migration number or `vN` dir from its own base snapshot, so siblings collide and are renumbered after validation ran.
 * `reserveForBuild` reserves, before the build, one number per numbered series dir (and one version per configured versioned
 * class) that the frozen contract's deliverables touch, above the base, the other open PRs and every live sibling
 * reservation (`seqlease.reserve`); `sequenceBuildNote` tells the builder which. `revalidate` reruns the frozen validate
 * commands after a renumber. Fail-open: any error means no reservation and the late bind stays the gate.
 */
import { posix } from "node:path";
import { baseSeries, seqNumber } from "./sequence.mjs";
import { maxVersion, parseVersioned } from "./seqversioned.mjs";

const MAX_DIRS = 8;

/**
 * @param {object} o `git(args)` in the lane worktree; `base` ref; `deliverables` the frozen contract's rows; `versioned` the
 *   configured classes; `reserve({dir, floor, count})`; `openNumbers({dir})` / `openVersions({cls})` numbers other open PRs carry.
 * @returns {Promise<Array<{kind:"numbered"|"versioned", dir:string, numbers:number[], width?:number, cls?:string}>>}
 */
export async function reserveForBuild({ git, base, deliverables = [], versioned = [], reserve, openNumbers = null, openVersions = null }) {
  const res = [];
  if (!reserve) return res;
  try {
    const paths = (deliverables ?? []).map((d) => String(d?.path ?? "")).filter(Boolean);
    const classes = parseVersioned(versioned);
    for (const c of classes) {
      if (!paths.some((p) => c.dir ? p.startsWith(`${c.dir}/`) : true)) continue;
      let floor = await maxVersion({ git, ref: base, cls: c });
      if (openVersions) { try { floor = Math.max(floor, ...(await openVersions({ cls: c })).map(Number).filter(Number.isFinite)); } catch { /* fail-open */ } }
      const got = await reserve({ dir: c.pattern, floor, count: 1 });
      const numbers = Array.isArray(got?.numbers) ? got.numbers.map(Number).filter(Number.isInteger) : [];
      if (numbers.length) res.push({ kind: "versioned", dir: c.dir, cls: c.pattern, numbers });
    }
    const dirs = [...new Set(paths.map((p) => posix.dirname(p)))].filter((d) => !classes.some((c) => d === c.dir || d.startsWith(`${c.dir}/`))).slice(0, MAX_DIRS);
    for (const dir of dirs) {
      const s = await baseSeries({ git, ref: base, dir });
      if (!s.series) continue;
      const count = Math.min(5, Math.max(1, paths.filter((p) => posix.dirname(p) === dir && (seqNumber(p) || /\.sql$/i.test(p))).length));
      let floor = s.max;
      if (openNumbers) { try { floor = Math.max(floor, ...(await openNumbers({ dir })).map(Number).filter(Number.isFinite)); } catch { /* fail-open */ } }
      const got = await reserve({ dir, floor, count });
      const numbers = Array.isArray(got?.numbers) ? got.numbers.map(Number).filter(Number.isInteger) : [];
      if (numbers.length === count) res.push({ kind: "numbered", dir, numbers, width: s.width });
    }
  } catch { /* fail-open */ }
  return res;
}

/** The builder-prompt paragraph for `reserveForBuild`'s result; "" when nothing was reserved. */
export function sequenceBuildNote(reservations = []) {
  const rows = (reservations ?? []).map((r) => (r.kind === "versioned"
    ? `- ${r.cls}: the next version is v${r.numbers[0]} (create ${posix.join(r.dir, `v${r.numbers[0]}`)}/; never reuse a version the base already has) and update the files that reference the version`
    : `- ${r.dir}/: use ${r.numbers.map((n) => String(n).padStart(r.width ?? 0, "0")).join(", ")} for the new numbered file${r.numbers.length > 1 ? "s, in order" : ""} (do not derive the number from the files you see)`));
  return rows.length ? `\n\nSequence numbers reserved for this lane (sibling lanes on the same branch hold the others; the engine renumbers anything else after the fact):\n${rows.join("\n")}` : "";
}

/**
 * Rerun the frozen validate commands after a renumber. `runOne(validate)` -> {rc, output}.
 * @returns {Promise<Array<{id:string, rc:number, output:string}>>} the failures
 */
export async function revalidate({ validates = [], runOne }) {
  const failed = [];
  for (const v of validates ?? []) {
    if (!v?.command || !runOne) continue;
    let x;
    try { x = await runOne(v); } catch (e) { x = { rc: 127, output: String(e?.message ?? e) }; }
    if (x && Number.isInteger(x.rc) && x.rc !== 0) failed.push({ id: v.id, rc: x.rc, output: String(x.output ?? "") });
  }
  return failed;
}

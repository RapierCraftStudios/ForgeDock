// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sequence-numbered artifacts at hand-off (#4322): migrations named `<number>_<name>` (0007_usage.sql, 0007_x.py,
 * meta/0007_snapshot.json) that the lane added with a number the base already uses. Union merge (#3969) cannot help: a
 * duplicate number is a semantic collision and a drizzle-style journal is structured JSON. The engine only detects and
 * verifies; the builder renumbers with the repo's own migration generator. Deterministic (git only), never throws.
 * #4343: a leading calendar date (YYYY-MM-DD, YYYYMMDD) is not a number, and a directory only counts when it holds a
 * series on the base: a migration journal (`<dir>/meta/_journal.json`, `<dir>/_journal.json`), or >=2 distinct numbers
 * of the lane file's width that fill at least half of their min..max range (sparse issue-numbered docs are no series).
 */
import { basename, dirname, posix } from "node:path";

const NUM_RE = /^(\d{3,})[_-]/;
const DATE_RE = /^(?:19|20)\d\d(-?)(?:0[1-9]|1[0-2])\1(?:0[1-9]|[12]\d|3[01])[_-]/;
const SKIP_RE = /(?:^|\/)(?:node_modules|vendor|dist|build)\//;
const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
/** The sequence number a file name starts with, or null (none, or a leading date). */
export const seqNumber = (name) => { const b = basename(String(name ?? "")); return DATE_RE.test(b) ? null : NUM_RE.exec(b)?.[1] ?? null; };
const numOf = seqNumber;
const inDir = (dir) => (dir === "." ? [] : [`${dir}/`]);
const out = (git) => async (args) => { try { return String(await git(args)); } catch { return ""; } };

/** Lane-added numbered files (base...HEAD), with their blob ids. */
async function laneNumbered(git, base) {
  const g = out(git);
  const added = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", `${base}...HEAD`])).filter((f) => numOf(f) && !SKIP_RE.test(f));
  const res = [];
  for (const path of added) res.push({ path, blob: (await g(["rev-parse", `HEAD:${path}`])).trim() });
  return res;
}

/**
 * Collisions: in each directory where a lane-added numbered file shares its number with a different base file (another
 * name, or the same path with other content), every lane-added numbered file there must move, in order, above the base's
 * highest number. @returns {Promise<Array<{dir, number, lane, base:string[], next}>>} (base [] = moves only to keep order)
 */
export async function sequenceCollisions({ git, base }) {
  try {
    const g = out(git);
    const lane = await laneNumbered(git, base);
    const res = [];
    for (const dir of [...new Set(lane.map((f) => dirname(f.path)))]) {
      const listed = lines(await g(["-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", base, ...inDir(dir)]));
      const journal = listed.some((p) => p === posix.join(dir, "_journal.json") || p === posix.join(dir, "meta", "_journal.json"));
      const baseNums = listed.filter((p) => dirname(p) === dir).map(numOf).filter(Boolean);
      const series = (w) => {
        const ns = [...new Set(baseNums.filter((n) => n.length === w).map(Number))];
        return ns.length >= 2 && ns.length * 2 >= Math.max(...ns) - Math.min(...ns) + 1;
      };
      const mine = lane.filter((f) => dirname(f.path) === dir && (journal || series(numOf(f.path).length))).sort((a, b) => Number(numOf(a.path)) - Number(numOf(b.path)) || a.path.localeCompare(b.path));
      if (!mine.length) continue;
      const theirs = [];
      for (const l of lines(await g(["-c", "core.quotepath=off", "ls-tree", base, ...inDir(dir)]))) {
        const m = /^\d+\s+blob\s+(\S+)\t(.+)$/.exec(l);
        if (m && dirname(m[2]) === dir && numOf(m[2])) theirs.push({ path: m[2], blob: m[1] });
      }
      const clash = (f) => theirs.filter((t) => numOf(t.path) === numOf(f.path) && (t.path !== f.path || t.blob !== f.blob)).map((t) => t.path);
      if (!mine.some((f) => clash(f).length)) continue;
      const width = Math.max(...mine.map((f) => numOf(f.path).length));
      let next = Math.max(0, ...theirs.map((t) => Number(numOf(t.path))));
      for (const f of mine) res.push({ dir, number: numOf(f.path), lane: f.path, base: clash(f), next: String(++next).padStart(width, "0") });
    }
    return res;
  } catch { return []; }
}

/**
 * Drizzle-style journal checks for `dirs` at `ref` (`<dir>/meta/_journal.json`, {entries:[{idx, tag}]}): duplicate idx
 * or tag, idx or tag number not strictly increasing, a numbered .sql file without a tag. No journal: [].
 */
export async function journalProblems({ git, ref = "HEAD", dirs = [] }) {
  const g = out(git), problems = [];
  for (const dir of [...new Set(dirs)]) {
    const jp = posix.join(dir, "meta", "_journal.json");
    const text = await g(["show", `${ref}:${jp}`]);
    if (!text.trim()) continue;
    let entries;
    try { entries = JSON.parse(text).entries; } catch { problems.push(`${jp}: not valid JSON`); continue; }
    if (!Array.isArray(entries)) { problems.push(`${jp}: no entries array`); continue; }
    const tags = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] ?? {}, prev = entries[i - 1];
      if (tags.has(e.tag)) problems.push(`${jp}: duplicate tag ${e.tag}`);
      tags.add(e.tag);
      if (prev && !(Number(e.idx) > Number(prev.idx))) problems.push(`${jp}: idx ${e.idx} (${e.tag}) not after ${prev.idx} (${prev.tag})`);
      const n = numOf(String(e.tag ?? "")), pn = prev ? numOf(String(prev.tag ?? "")) : null;
      if (n && pn && !(Number(n) > Number(pn))) problems.push(`${jp}: ${e.tag} not numbered after ${prev.tag}`);
    }
    for (const l of lines(await g(["-c", "core.quotepath=off", "ls-tree", "--name-only", ref, ...inDir(dir)]))) {
      if (dirname(l) === dir && l.endsWith(".sql") && numOf(l) && !tags.has(basename(l, ".sql"))) problems.push(`${jp}: no entry for ${basename(l)}`);
    }
  }
  return problems;
}

/** Lane-added numbered files with their blobs, recorded before a renumber so verifyRenumber can prove the SQL kept. */
export const snapshotLane = ({ git, base }) => laneNumbered(git, base).catch(() => []);

/**
 * After the builder renumbered: no collision remains, every recorded non-JSON file (the SQL; snapshots are regenerated)
 * still exists byte-identical in its directory, and the journals are strictly ordered. @returns {Promise<{ok, problems}>}
 */
export async function verifyRenumber({ git, base, before = [] }) {
  try {
    const problems = [];
    const left = await sequenceCollisions({ git, base });
    for (const c of left.filter((x) => x.base.length)) problems.push(`${c.lane} still shares number ${c.number} with ${c.base.join(", ")}`);
    const now = await laneNumbered(git, base);
    for (const b of before.filter((f) => !f.path.endsWith(".json"))) {
      if (!now.some((f) => dirname(f.path) === dirname(b.path) && f.blob === b.blob)) problems.push(`${b.path}: content changed or file gone after renumbering (keep it byte-identical, rename only)`);
    }
    problems.push(...await journalProblems({ git, dirs: [...new Set([...before, ...now].map((f) => dirname(f.path)))] }));
    return { ok: !problems.length, problems };
  } catch (e) { return { ok: false, problems: [String(e?.message ?? e)] }; }
}

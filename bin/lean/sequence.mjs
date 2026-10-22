// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sequence-numbered artifacts at hand-off (#4322): migrations named `<number>_<name>` (0007_usage.sql, 0007_x.py,
 * meta/0007_snapshot.json) that the lane added with a number the base already uses. Union merge (#3969) cannot help: a
 * duplicate number is a semantic collision and a drizzle-style journal is structured JSON. The engine only detects and
 * verifies; the builder renumbers with the repo's own migration generator. Deterministic (git only), never throws.
 * #4386: the engine renumbers itself first (`renumberLane`: git mv, heading number, references, journal append, data-only
 * snapshot clone or `lean.sequence.regenerate`), resolves base-sync conflicts that touch only sequence files
 * (`resolveSequenceConflicts`), and hands the builder only what it returns `unsupported` for.
 * #4343: a leading calendar date (YYYY-MM-DD, YYYYMMDD) is not a number, and a directory only counts when it holds a
 * series on the base: a migration journal (`<dir>/meta/_journal.json`, `<dir>/_journal.json`), or >=2 distinct numbers
 * of the lane file's width that fill at least half of their min..max range (sparse issue-numbered docs are no series).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { promisify } from "node:util";

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
async function laneNumbered(git, base, ref = "HEAD") {
  const g = out(git);
  const added = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", `${base}...${ref}`])).filter((f) => numOf(f) && !SKIP_RE.test(f));
  const res = [];
  for (const path of added) res.push({ path, blob: (await g(["rev-parse", `${ref}:${path}`])).trim() });
  return res;
}

/**
 * Collisions: in each directory where a lane-added numbered file shares its number with a different base file (another
 * name, or the same path with other content), every lane-added numbered file there must move, in order, above the base's
 * highest number. @returns {Promise<Array<{dir, number, lane, base:string[], next}>>} (base [] = moves only to keep order)
 */
export async function sequenceCollisions({ git, base, ref = "HEAD" }) {
  try {
    const g = out(git);
    const lane = await laneNumbered(git, base, ref);
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

const stemOf = (p) => basename(p).replace(/\.[^.]*$/, "");
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (x) => new RegExp(`(?<![\\w-])${esc(x)}(?![\\w-])`, "g");
/** Every move's old stem → new stem, and the file's own number token → its new number (#4386). */
function normalise(text, path, moves) {
  let t = String(text);
  for (const m of moves) t = t.replace(word(stemOf(m.from)), stemOf(m.to));
  const own = moves.find((m) => m.from === path);
  return own && /\.mdx?$/i.test(own.to) ? retitle(t, numOf(own.from), numOf(own.to)) : t;
}
/** A numbered document's own number in its first heading (else its first non-empty line): 0017 → 0018, or 17 → 18. */
function retitle(text, oldNum, newNum) {
  const ls = String(text).split("\n");
  let i = ls.findIndex((l) => /^#{1,6}\s/.test(l));
  if (i < 0) i = ls.findIndex((l) => l.trim());
  if (i < 0) return String(text);
  const pad = new RegExp(`\\b${oldNum}\\b`), bare = new RegExp(`\\b${Number(oldNum)}\\b`);
  ls[i] = pad.test(ls[i]) ? ls[i].replace(pad, newNum) : ls[i].replace(bare, String(Number(newNum)));
  return ls.join("\n");
}

/**
 * After a renumber (engine or builder): no collision remains, every recorded non-JSON file (the SQL, a numbered ADR;
 * snapshots are regenerated) still exists in its directory byte-identical, or (#4386) identical once each move's old
 * stem and the file's own number are mapped to the new ones (an ADR heading carries its number), and the journals are
 * strictly ordered. Unnumbered index files (docs/adr/README.md) are never recorded, so their row edits pass.
 * `moves` ([{from,to}]) defaults to the pairing of recorded and current lane files by the name after the number.
 * @returns {Promise<{ok, problems}>}
 */
export async function verifyRenumber({ git, base, before = [], moves = null }) {
  try {
    const g = out(git), problems = [];
    const left = await sequenceCollisions({ git, base });
    for (const c of left.filter((x) => x.base.length)) problems.push(`${c.lane} still shares number ${c.number} with ${c.base.join(", ")}`);
    const now = await laneNumbered(git, base);
    const rest = (p) => basename(p).slice(numOf(p).length);
    const mv = moves?.length ? moves : before.flatMap((b) => {
      const to = now.find((f) => dirname(f.path) === dirname(b.path) && f.path !== b.path && rest(f.path) === rest(b.path) && f.blob !== b.blob);
      return to && !now.some((f) => f.path === b.path) ? [{ from: b.path, to: to.path }] : [];
    });
    for (const b of before.filter((f) => !f.path.endsWith(".json"))) {
      if (now.some((f) => dirname(f.path) === dirname(b.path) && f.blob === b.blob)) continue;
      const cand = now.filter((f) => dirname(f.path) === dirname(b.path) && rest(f.path) === rest(b.path));
      let same = false;
      if (cand.length) {
        const was = normalise(await g(["cat-file", "blob", b.blob]), b.path, mv);
        for (const c of cand) if (!same && (await g(["cat-file", "blob", c.blob])) === was) same = true;
      }
      if (!same) problems.push(`${b.path}: content changed or file gone after renumbering (keep it byte-identical, rename only)`);
    }
    problems.push(...await journalProblems({ git, dirs: [...new Set([...before, ...now].map((f) => dirname(f.path)))] }));
    return { ok: !problems.length, problems };
  } catch (e) { return { ok: false, problems: [String(e?.message ?? e)] }; }
}

const JOURNAL_RE = /(?:^|\/)_journal\.json$/, SNAPSHOT_RE = /(?:^|\/)\d{3,}_snapshot\.json$/, INDEX_RE = /(?:^|\/)(?:README|index)\.mdx?$/i;
const SUPPORTED_RE = /\.(?:sql|md|mdx)$/i;

/**
 * #4386: resolve a base merge in progress whose conflicts are all sequence files: numbered files, journals and
 * snapshots take the base side (`--theirs`; the lane's originals come back through renumberLane from the pre-merge head;
 * a journal keeps the base entries and appends the lane's, so a lane whose number did not collide keeps its entry),
 * and an index file beside numbered files (README.md, index.md) keeps both sides (union). Commits the merge.
 * Any other conflicted file: {unsupported}, and the merge is left as is for the builder. Never throws.
 * @returns {Promise<{ok:true}|{unsupported:string}>}
 */
export async function resolveSequenceConflicts({ git, files = [] }) {
  try {
    const g = out(git);
    if (!files.length) return { unsupported: "no conflicted files" };
    const tracked = lines(await g(["-c", "core.quotepath=off", "ls-files"]));
    const indexFile = (f) => INDEX_RE.test(f) && tracked.some((p) => dirname(p) === dirname(f) && numOf(p));
    const other = files.filter((f) => !(numOf(f) || JOURNAL_RE.test(f) || SNAPSHOT_RE.test(f) || indexFile(f)));
    if (other.length) return { unsupported: `non-sequence conflict: ${other.join(", ")}` };
    for (const f of files) {
      if (indexFile(f) && !numOf(f)) {
        const tmp = mkdtempSync(join(tmpdir(), "seq-union-"));
        try {
          const b = join(tmp, "base"), t = join(tmp, "theirs");
          writeFileSync(b, await g(["show", `:1:${f}`]));
          writeFileSync(t, await g(["show", `:3:${f}`]));
          await git(["checkout", "--ours", "--", f]);
          await git(["merge-file", "--union", f, b, t]);
        } finally { rmSync(tmp, { recursive: true, force: true }); }
        await git(["add", "--", f]);
      } else if (JOURNAL_RE.test(f)) { // base entries, then the lane's (renumberLane retags them); idx consecutive
        const parse = async (n) => { try { return JSON.parse(await g(["show", `:${n}:${f}`])); } catch { return null; } };
        const ours = await parse(2), theirs = await parse(3);
        if (!Array.isArray(theirs?.entries) || !Array.isArray(ours?.entries ?? [])) return { unsupported: `${f}: journal is not valid JSON on both sides` };
        const tags = new Set(theirs.entries.map((e) => e?.tag));
        let idx = Math.max(-1, ...theirs.entries.map((e) => Number(e?.idx)).filter(Number.isFinite));
        const add = (ours?.entries ?? []).filter((e) => !tags.has(e?.tag)).map((e) => ({ ...e, idx: ++idx }));
        await git(["checkout", "--theirs", "--", f]);
        writeFileSync(join(String(await g(["rev-parse", "--show-toplevel"])).trim(), f), `${JSON.stringify({ ...theirs, entries: [...theirs.entries, ...add] }, null, 2)}\n`);
        await git(["add", "--", f]);
      } else {
        try { await git(["checkout", "--theirs", "--", f]); await git(["add", "--", f]); }
        catch { await git(["rm", "-q", "-f", "--", f]); } // the base deleted it
      }
    }
    await git(["commit", "--no-edit"]);
    return { ok: true };
  } catch (e) { return { unsupported: `sequence conflict resolution failed: ${String(e?.message ?? e).split("\n")[0]}` }; }
}

const sh = promisify(execFile);
const defaultRun = (cmd, { cwd }) => sh("sh", ["-c", cmd], { cwd, timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
const json = async (g, spec) => { const t = await g(["show", spec]); if (!t.trim()) return null; try { return JSON.parse(t); } catch { return null; } };
const strip = (o) => { const { id, prevId, ...r } = o ?? {}; return JSON.stringify(r); };
const writeJson = (p, o) => writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`);

/**
 * #4386: renumber the lane's sequence-numbered files deterministically, the mechanical fix a human does by hand:
 * 1. bring the branch up to date with the base (a sequence-only conflict takes the base side, else unsupported);
 * 2. write each colliding lane file (`.sql`, Markdown; read from `laneRef`, the pre-merge lane head) at max(base)+1…,
 *    and restore or remove the old path; a Markdown file's own number in its first heading follows;
 * 3. per drizzle-style journal: the base journal plus the lane's entries, retagged, with consecutive idx;
 * 4. per moved SQL with a snapshot: data-only (equal to its lane predecessor but id/prevId) clones the tip snapshot with
 *    a fresh id and prevId = tip id; otherwise `regenerate` runs (none configured: unsupported);
 * 5. every tracked file naming an old stem (links, comments) is rewritten to the new one (SQL bodies stay untouched);
 * then one commit. Any other migration language, a failed generator or an error: {unsupported}, the branch reset to
 * where it started. Never throws.
 * @returns {Promise<{ok:true, moves:Array<{from,to}>, commit:string|null}|{unsupported:string}>}
 */
export async function renumberLane({ git, base, cwd, laneRef = "HEAD", regenerate = null, run = null, uuid = randomUUID }) {
  const g = out(git);
  const start = (await g(["rev-parse", "HEAD"])).trim();
  const written = [];
  const fail = async (why) => {
    try { await git(["merge", "--abort"]); } catch { /* no merge in progress */ }
    try { await git(["reset", "-q", "--hard", start]); } catch { /* best effort */ }
    const keep = new Set(lines(await g(["ls-files"])));
    for (const p of written) if (!keep.has(p)) rmSync(join(cwd, p), { force: true });
    return { unsupported: why };
  };
  try {
    const lane = (await g(["rev-parse", laneRef])).trim() || start;
    const collisions = (await sequenceCollisions({ git, base, ref: lane })).filter((c) => !SNAPSHOT_RE.test(c.lane));
    if (!collisions.length) return { ok: true, moves: [], commit: null };
    const odd = collisions.find((c) => !SUPPORTED_RE.test(c.lane));
    if (odd) return { unsupported: `${odd.lane}: no deterministic renumber for .${basename(odd.lane).split(".").pop()} migrations` };
    const moves = collisions.map((c) => ({ from: c.lane, to: posix.join(c.dir, c.next + basename(c.lane).slice(c.number.length)), dir: c.dir, oldNum: c.number, newNum: c.next }));
    // Plan the journals and snapshots before touching anything, so an unsupported migration leaves the branch as it was.
    const baseList = lines(await g(["-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", base]));
    const plans = [];
    let needRegen = false;
    for (const dir of [...new Set(moves.map((m) => m.dir))]) {
      const jp = [posix.join(dir, "meta", "_journal.json"), posix.join(dir, "_journal.json")].find((p) => baseList.includes(p));
      if (!jp) continue;
      const meta = dirname(jp), mine = moves.filter((m) => m.dir === dir && /\.sql$/i.test(m.from));
      const snaps = [];
      for (const m of mine) {
        const laneSnap = await json(g, `${lane}:${posix.join(meta, `${m.oldNum}_snapshot.json`)}`);
        if (!laneSnap) continue;
        const laneMeta = lines(await g(["-c", "core.quotepath=off", "ls-tree", "--name-only", lane, `${meta}/`])).filter((p) => SNAPSHOT_RE.test(p) && Number(numOf(p)) < Number(m.oldNum));
        const pred = laneMeta.sort((a, b) => Number(numOf(a)) - Number(numOf(b))).at(-1);
        const dataOnly = Boolean(pred) && strip(await json(g, `${lane}:${pred}`)) === strip(laneSnap);
        if (!dataOnly && !regenerate) return { unsupported: `schema-changing migration ${m.from} needs lean.sequence.regenerate (its snapshot cannot be cloned)` };
        if (!dataOnly) needRegen = true;
        snaps.push({ m, dataOnly });
      }
      plans.push({ dir, jp, meta, snaps });
    }
    // 1. up to date with the base
    if (!(await git(["merge-base", "--is-ancestor", base, "HEAD"]).then(() => true, () => false))) {
      try { await git(["merge", "--no-edit", base]); } catch {
        const files = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=U"]));
        const r = await resolveSequenceConflicts({ git, files });
        if (!r.ok) return await fail(r.unsupported);
      }
    }
    const head = lines(await g(["-c", "core.quotepath=off", "ls-files"]));
    const touched = new Set();
    // 2. the files, highest number first so a lane file never lands on another lane file not yet moved
    for (const m of [...moves].sort((a, b) => Number(b.oldNum) - Number(a.oldNum))) {
      let text = await g(["cat-file", "blob", `${lane}:${m.from}`]);
      if (/\.mdx?$/i.test(m.to)) text = retitle(text, m.oldNum, m.newNum);
      mkdirSync(dirname(join(cwd, m.to)), { recursive: true });
      writeFileSync(join(cwd, m.to), text);
      written.push(m.to);
      touched.add(m.to);
      if (head.includes(m.from)) {
        if (baseList.includes(m.from)) await git(["checkout", base, "--", m.from]);
        else await git(["rm", "-q", "-f", "--", m.from]);
      }
    }
    const stem = new Map(moves.map((m) => [stemOf(m.from), stemOf(m.to)]));
    // 3. + 4. journals and snapshots
    for (const p of plans) {
      const bj = (await json(g, `${base}:${p.jp}`)) ?? { entries: [] }, lj = (await json(g, `${lane}:${p.jp}`)) ?? { entries: [] };
      const baseEntries = Array.isArray(bj.entries) ? bj.entries : [];
      const tags = new Set(baseEntries.map((e) => e?.tag));
      let idx = Math.max(-1, ...baseEntries.map((e) => Number(e?.idx)).filter(Number.isFinite));
      const add = (Array.isArray(lj.entries) ? lj.entries : []).filter((e) => !tags.has(e?.tag)).map((e) => ({ ...e, idx: ++idx, tag: stem.get(e.tag) ?? e.tag }));
      writeJson(join(cwd, p.jp), { ...bj, entries: [...baseEntries, ...add] });
      touched.add(p.jp);
      const baseSnaps = baseList.filter((x) => dirname(x) === p.meta && SNAPSHOT_RE.test(x)).sort((a, b) => Number(numOf(a)) - Number(numOf(b)));
      let tip = baseSnaps.length ? await json(g, `${base}:${baseSnaps.at(-1)}`) : null;
      for (const { m, dataOnly } of p.snaps.sort((a, b) => Number(a.m.newNum) - Number(b.m.newNum))) {
        const oldSnap = posix.join(p.meta, `${m.oldNum}_snapshot.json`), newSnap = posix.join(p.meta, `${m.newNum}_snapshot.json`);
        if (head.includes(oldSnap)) {
          if (baseList.includes(oldSnap)) await git(["checkout", base, "--", oldSnap]);
          else await git(["rm", "-q", "-f", "--", oldSnap]);
        }
        if (!dataOnly) continue;
        if (!tip) return await fail(`${m.from}: the base has no snapshot to clone`);
        const next = { ...tip, id: uuid(), prevId: tip.id };
        writeJson(join(cwd, newSnap), next);
        written.push(newSnap);
        touched.add(newSnap);
        tip = next;
      }
    }
    if (needRegen) {
      try { await (run ?? defaultRun)(regenerate, { cwd }); } catch (e) { return await fail(`lean.sequence.regenerate failed: ${String(e?.stderr || e?.message || e).trim().split("\n")[0]}`); }
      for (const p of plans) {
        touched.add(p.meta);
        for (const { m, dataOnly } of p.snaps) {
          const want = posix.join(p.meta, `${m.newNum}_snapshot.json`);
          if (!dataOnly) { try { readFileSync(join(cwd, want)); } catch { return await fail(`lean.sequence.regenerate did not write ${want}`); } }
        }
      }
    }
    // 5. references to the old names, repo-wide (moved files included; SQL bodies and the lane dir stay as they are)
    await git(["add", "-A", "--", ...touched]);
    for (const [from, to] of stem) {
      for (const f of lines(await g(["-c", "core.quotepath=off", "grep", "-l", "-I", "-F", "-e", from, "--"]))) {
        if (/\.sql$/i.test(f) || f.startsWith(".forge-lean/") || JOURNAL_RE.test(f)) continue;
        const p = join(cwd, f), t = readFileSync(p, "utf8"), u = t.replace(word(from), to);
        if (u !== t) { writeFileSync(p, u); touched.add(f); }
      }
    }
    await git(["add", "-A", "--", ...touched]);
    const msg = `chore(sequence): renumber ${moves.map((m) => `${basename(m.from)} → ${basename(m.to)}`).join(", ")} (deterministic, #4386)`;
    await git(["commit", "-q", "-m", msg]);
    return { ok: true, moves: moves.map(({ from, to }) => ({ from, to })), commit: (await g(["rev-parse", "HEAD"])).trim() || null };
  } catch (e) { return await fail(`deterministic renumber failed: ${String(e?.message ?? e).split("\n")[0]}`); }
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Versioned-directory sequence class (#5235): `<dir>/v{N}/` directories (e.g. `scripts/backup-contracts/v{N}`) that are
 * immutable once published, so two lanes adding the same version collide like two migrations with one number. Configured by
 * forge.yaml `lean.sequence_versioned`: `<dir>/v{N} [= companion[, companion...]]; ...`. A companion is a file that
 * references the version, as `path` (the class's name template, `v{N}`) or `path=template` (e.g. `src/version.ts=VERSION = {N}`).
 * Detection (`versionedCollisions`) and the deterministic renumber (`renumberVersioned`) are git only and never throw.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const out = (git) => async (args) => { try { return String(await git(args)); } catch { return ""; } };

/** `scripts/x/v{N}` -> { dir, pattern, name: "v{N}", re } (null unless the last segment holds `{N}`). */
function classOf(pattern, companions = []) {
  const p = String(pattern ?? "").trim().replace(/\/+$/, ""), name = posix.basename(p);
  if (!name.includes("{N}")) return null;
  const [pre, post] = name.split("{N}");
  return { dir: posix.dirname(p) === "." ? "" : posix.dirname(p), pattern: p, name, companions, re: new RegExp(`^${esc(pre)}(\\d+)${esc(post)}$`) };
}

/** The configured classes from the flat string form or an already-parsed list ([{pattern, companions}]). */
export function parseVersioned(spec) {
  const list = Array.isArray(spec) ? spec : String(spec ?? "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf("->"), pattern = (i < 0 ? s : s.slice(0, i)).trim(), rest = i < 0 ? "" : s.slice(i + 2);
    return { pattern, companions: rest.split(",").map((x) => x.trim()).filter(Boolean) };
  });
  return list.map((c) => classOf(c.pattern ?? c.dir, c.companions ?? [])).filter(Boolean);
}

const versionDir = (c, n) => posix.join(c.dir, c.name.replace("{N}", String(n)));
const tokenOf = (c, tpl, n) => (tpl ?? c.name).replace("{N}", String(n));
const companion = (c, spec) => { const i = String(spec).indexOf("="); return i < 0 ? { path: String(spec).trim(), tpl: c.name } : { path: spec.slice(0, i).trim(), tpl: spec.slice(i + 1) }; };

/** version -> [{path, blob}] of every file under `<dir>/<name>` at `ref`. */
async function versionsAt(g, ref, c) {
  const res = new Map();
  for (const l of lines(await g(["-c", "core.quotepath=off", "ls-tree", "-r", ref, "--", ...(c.dir ? [`${c.dir}/`] : [])]))) {
    const m = /^\d+\s+blob\s+(\S+)\t(.+)$/.exec(l);
    if (!m) continue;
    const seg = posix.relative(c.dir || ".", m[2]).split("/")[0], v = c.re.exec(seg)?.[1];
    if (v) res.set(Number(v), [...(res.get(Number(v)) ?? []), { path: m[2], blob: m[1] }]);
  }
  return res;
}

/** The highest version of class `c` at `ref` (0 when none). */
export async function maxVersion({ git, ref, cls }) {
  return Math.max(0, ...(await versionsAt(out(git), ref, cls)).keys());
}

/**
 * Versions the lane added (base...ref) that the base already holds with other content, and the versions above them that must
 * keep their order. @returns {Promise<Array<{dir, number, lane, base:string[], next, cls}>>} (`next` above the base's highest)
 */
export async function versionedCollisions({ git, base, ref = "HEAD", versioned = [] }) {
  const res = [];
  try {
    const g = out(git), classes = parseVersioned(versioned);
    const added = new Set(lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", `${base}...${ref}`])));
    for (const c of classes) {
      const mine = [...(await versionsAt(g, ref, c)).entries()].map(([v, fs]) => [v, fs.filter((f) => added.has(f.path))]).filter(([, fs]) => fs.length).sort((a, b) => a[0] - b[0]);
      if (!mine.length) continue;
      const theirs = await versionsAt(g, base, c);
      const clash = ([v, fs]) => { const t = theirs.get(v) ?? []; return t.length && (t.length !== fs.length || t.some((x) => !fs.some((f) => f.path === x.path && f.blob === x.blob))); };
      if (!mine.some(clash)) continue;
      let next = Math.max(0, ...theirs.keys());
      for (const m of mine) res.push({ dir: c.dir, number: String(m[0]), lane: versionDir(c, m[0]), base: clash(m) ? [versionDir(c, m[0])] : [], next: String(++next), cls: c.pattern });
    }
  } catch { /* detection is best effort */ }
  return res;
}

/**
 * Renumber the lane's colliding versioned dirs: the files move to the next free version (`reserve({dir, floor, count})` first,
 * else base max + 1), the companions' references to the old version are rewritten on the lines the lane added, one commit.
 * Conflicts of the base merge that lie only inside versioned dirs take the base side. Anything else: {unsupported}, branch reset.
 * @returns {Promise<{ok:true, moves:Array<{from,to,versioned:true}>, commit:string|null}|{unsupported:string}>}
 */
export async function renumberVersioned({ git, base, cwd, laneRef = "HEAD", versioned = [], reserve = null }) {
  const g = out(git), classes = parseVersioned(versioned);
  if (!classes.length) return { ok: true, moves: [], commit: null };
  const start = (await g(["rev-parse", "HEAD"])).trim();
  const fail = async (why) => {
    try { await git(["merge", "--abort"]); } catch { /* none in progress */ }
    try { await git(["reset", "-q", "--hard", start]); } catch { /* best effort */ }
    return { unsupported: why };
  };
  try {
    const lane = (await g(["rev-parse", laneRef])).trim() || start;
    const cols = (await versionedCollisions({ git, base, ref: lane, versioned: classes }));
    if (!cols.length) return { ok: true, moves: [], commit: null };
    if (!(await git(["merge-base", "--is-ancestor", base, "HEAD"]).then(() => true, () => false))) {
      try { await git(["merge", "--no-edit", base]); } catch {
        const files = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=U"]));
        const inClass = (f) => classes.some((c) => f.startsWith(`${c.dir ? `${c.dir}/` : ""}`) && c.re.test(posix.relative(c.dir || ".", f).split("/")[0]));
        const rest = files.filter((f) => !inClass(f));
        if (rest.length) return await fail(`non-versioned conflict: ${rest.join(", ")}`);
        for (const f of files) { try { await git(["checkout", "--theirs", "--", f]); } catch { await git(["rm", "-q", "-f", "--", f]); } await git(["add", "--", f]); }
        await git(["commit", "-q", "--no-edit"]);
      }
    }
    const added = new Set(lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", `${base}...${lane}`])));
    const touched = new Set(), moves = [], renames = [];
    for (const c of classes) {
      const mine = cols.filter((x) => x.cls === c.pattern).sort((a, b) => Number(a.number) - Number(b.number));
      if (!mine.length) continue;
      let floor = await maxVersion({ git, ref: base, cls: c }), nums = null;
      try { nums = (await reserve?.({ dir: c.pattern, floor, count: mine.length }))?.numbers?.map(Number); } catch { /* fail-open */ }
      if (!(nums?.length === mine.length && nums.every(Number.isInteger))) nums = mine.map((_, i) => floor + 1 + i);
      const have = await versionsAt(g, lane, c), baseHas = await versionsAt(g, base, c), head = new Set(lines(await g(["ls-files"])));
      for (const [i, m] of [...mine.entries()].reverse()) {
        const from = Number(m.number), to = nums[i];
        for (const f of (have.get(from) ?? []).filter((x) => added.has(x.path))) {
          const rel = posix.relative(versionDir(c, from), f.path), dest = posix.join(versionDir(c, to), rel);
          const src = await g(["cat-file", "blob", f.blob]);
          mkdirSync(dirname(join(cwd, dest)), { recursive: true });
          writeFileSync(join(cwd, dest), src);
          touched.add(dest);
          if ((baseHas.get(from) ?? []).some((x) => x.path === f.path)) await git(["checkout", base, "--", f.path]);
          else if (head.has(f.path)) await git(["rm", "-q", "-f", "--", f.path]);
        }
        moves.push({ from: versionDir(c, from), to: versionDir(c, to), versioned: true });
        renames.push({ c, from, to });
      }
    }
    // companions: the lane's own lines that name the old version
    const mb = (await g(["merge-base", base, lane])).trim() || base;
    for (const { c, from, to } of renames) {
      for (const spec of c.companions) {
        const { path, tpl } = companion(c, spec), p = join(cwd, path);
        let text; try { text = readFileSync(p, "utf8"); } catch { continue; }
        const was = new Set((await g(["show", `${mb}:${path}`])).split("\n")), mine = new Set((await g(["show", `${lane}:${path}`])).split("\n").filter((l) => !was.has(l)));
        const tok = tokenOf(c, tpl, from), src = `${/^\w/.test(tok) ? "(?<![A-Za-z0-9_])" : ""}${esc(tok)}(?!\\d)`;
        const has = new RegExp(src), re = new RegExp(src, "g");
        const next = text.split("\n").map((l) => (mine.has(l) && has.test(l) ? l.replace(re, () => tokenOf(c, tpl, to)) : l)).join("\n");
        if (next !== text) { writeFileSync(p, next); touched.add(path); }
      }
    }
    await git(["add", "-A", "--", ...touched]);
    await git(["commit", "-q", "-m", `chore(sequence): renumber ${moves.map((m) => `${m.from} → ${m.to}`).join(", ")} (deterministic, #5235)`]);
    return { ok: true, moves, commit: (await g(["rev-parse", "HEAD"])).trim() || null };
  } catch (e) { return await fail(`versioned renumber failed: ${String(e?.message ?? e).split("\n")[0]}`); }
}

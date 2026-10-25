// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deterministic base-merge conflict resolution for sibling lanes (#4588). Sibling lanes of one milestone always collide
 * on the same kinds of file once one lands; `resolveBaseConflicts` settles them while a base merge is in progress (ours =
 * the lane, theirs = the base), with no builder session:
 *   - `unionGlobs`: append-only lists; hunks where both sides purely added lines keep both (basesync.mjs `unionResolve`).
 *   - `jsonGlobs`: JSON maps (status files); a 3-way key union. A key both sides changed differently, or a non-object
 *     document, is refused.
 *   - `generatedGlobs`: the base side is taken, then `generatedCommand` runs once and the files are re-added.
 * Sequence/migration files are never touched here (sequence.mjs). A file that cannot be fully resolved stays conflicted
 * and is returned in `remaining`. Resolved files are `git add`ed; the caller commits. Never throws.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { isSequenceFile, matchesGlobs, unionResolve } from "./basesync.mjs";

const pexec = promisify(execFile);
const defaultRun = (cmd, { cwd }) => pexec("sh", ["-c", cmd], { cwd, timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NONE = Symbol("absent");

/** 3-way merge of parsed JSON (NONE = absent): one-sided changes win, objects merge per key, anything else throws. */
export function jsonMerge(base, ours, theirs) {
  if (same(ours, theirs) || same(theirs, base)) return ours;
  if (same(ours, base)) return theirs;
  if (!isObj(ours) || !isObj(theirs) || !(isObj(base) || base === NONE)) throw new Error("both sides changed the same value");
  const b = isObj(base) ? base : {}, out = {};
  for (const k of [...Object.keys(ours), ...Object.keys(theirs)]) {
    if (k in out) continue;
    const v = jsonMerge(k in b ? b[k] : NONE, k in ours ? ours[k] : NONE, k in theirs ? theirs[k] : NONE);
    if (v !== NONE) out[k] = v;
  }
  return out;
}

/** The merged text of a JSON map file from index stages 1-3, written with the lane's indent; throws when it cannot merge. */
export function jsonUnionText(baseTxt, oursTxt, theirsTxt) {
  const base = baseTxt === null ? NONE : JSON.parse(baseTxt), ours = JSON.parse(oursTxt), theirs = JSON.parse(theirsTxt);
  if (!isObj(ours) || !isObj(theirs)) throw new Error("not a JSON object");
  const indent = /^([ \t]+)"/m.exec(oursTxt)?.[1] ?? 2;
  return `${JSON.stringify(jsonMerge(base, ours, theirs), null, indent)}\n`;
}

/**
 * @param {{git:(args:string[])=>Promise<string>, cwd:string, files:string[], cfg?:{unionGlobs?:string[],jsonGlobs?:string[],generatedGlobs?:string[],generatedCommand?:string}, run?:Function}} p
 *   `git` runs in the worktree with the merge in progress and throws on failure.
 * @returns {Promise<{resolved:string[], remaining:string[], note?:string}>}
 */
export async function resolveBaseConflicts({ git, cwd, files = [], cfg = {}, run = defaultRun }) {
  const resolved = [], remaining = [];
  try {
    const stages = new Map();
    for (const l of lines(await git(["-c", "core.quotepath=off", "ls-files", "-u"]).catch(() => ""))) {
      const m = /^\d+ \S+ (\d)\t(.+)$/.exec(l); if (m) stages.set(m[2], (stages.get(m[2]) ?? 0) + (1 << Number(m[1])));
    }
    const generated = [];
    for (const f of files) {
      let ok = false;
      try {
        const st = stages.get(f);
        if (isSequenceFile(f)) ok = false;
        else if (matchesGlobs(f, cfg.generatedGlobs) && cfg.generatedCommand && (st & 8)) { await git(["checkout", "--theirs", "--", f]); generated.push(f); ok = true; }
        else if (st === 14 && matchesGlobs(f, cfg.jsonGlobs)) {
          const show = (n) => git(["show", `:${n}:${f}`]);
          writeFileSync(join(cwd, f), jsonUnionText(await show(1), await show(2), await show(3))); ok = true;
        } else if (st === 14 && matchesGlobs(f, cfg.unionGlobs)) {
          await git(["checkout", "--conflict=diff3", "--", f]);
          const text = unionResolve(readFileSync(join(cwd, f), "utf8"));
          if (text !== null) { writeFileSync(join(cwd, f), text); ok = true; }
        }
      } catch { ok = false; }
      if (ok) resolved.push(f); else remaining.push(f);
    }
    let note;
    if (generated.length) {
      try { await run(cfg.generatedCommand, { cwd }); } catch (e) {
        note = `generated command failed: ${String(e?.stderr || e?.message || e).trim().split("\n")[0].slice(0, 160)}`;
        for (const f of generated) { await git(["checkout", "-m", "--", f]).catch(() => {}); resolved.splice(resolved.indexOf(f), 1); remaining.push(f); }
        generated.length = 0;
      }
    }
    for (const f of resolved) await git(["add", "--", f]);
    for (const f of generated) await git(["add", "-A", "--", f]);
    return { resolved, remaining: files.filter((f) => remaining.includes(f)), ...(note ? { note } : {}) };
  } catch (e) {
    return { resolved: [], remaining: [...files], note: String(e?.message ?? e).split("\n")[0].slice(0, 160) };
  }
}

#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional repo caches for the pre-PR step (#4272): `.forge/test-map.json` (scripts/test-map.sh, file glob → check
 * command) picks the checks for the lane's changed files; `.forge/repo-facts.json` (scripts/repo-facts.sh) is cited to
 * the builder by path. The test map's commands are run, so it is read from the base ref, then the main checkout, never
 * the builder-writable lane worktree (#4297); repo facts are looked up in the worktree, then the main checkout. A missing
 * or invalid file is absent: the lane keeps forge.yaml `learned.test_commands` and today's prompts. With a map, a learned
 * command the map covers runs only when its globs match a changed file (`scopeChecks`, #4331).
 *
 *   node bin/lean/testmap.mjs --map FILE --select FILE...   print the selected commands, one per line
 */
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegex, shellQuote } from "../../scripts/ci-local/lib.mjs";

export const TEST_MAP_FILE = ".forge/test-map.json";
export const REPO_FACTS_FILE = ".forge/repo-facts.json";

/** A parsed test map when valid ({version:1, entries:[{command, globs:string[]}]}), else null. */
export function parseTestMap(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.version !== 1 || !Array.isArray(j.entries)) return null;
  const ok = j.entries.every((e) => e && typeof e.command === "string" && e.command.trim() && Array.isArray(e.globs) && e.globs.length && e.globs.every((g) => typeof g === "string" && g));
  return ok ? j : null;
}

/** The first valid test map under `dirs` (in order), or null; never throws. */
export async function readTestMap(dirs, read) {
  if (typeof read !== "function") return null;
  for (const d of dirs.filter(Boolean)) {
    let text;
    try { text = await read(join(d, TEST_MAP_FILE)); } catch { continue; }
    const map = parseTestMap(String(text ?? ""));
    if (map) return map;
  }
  return null;
}

/** #4297: the valid test map committed at `ref` (`git show <ref>:.forge/test-map.json`), or null; never throws. */
export async function readTestMapAtRef(git, ref) {
  if (typeof git !== "function" || !ref) return null;
  try { return parseTestMap(String((await git(["show", `${ref}:${TEST_MAP_FILE}`])) ?? "")); } catch { return null; }
}

/** Commands of entries with a glob matching a changed file: map order, deduped; a non-root cwd runs as `cd <cwd> && cmd`. */
export function selectCommands(map, files) {
  const out = [];
  const changed = (Array.isArray(files) ? files : []).map((f) => String(f).replace(/^\.\//, ""));
  for (const e of map?.entries ?? []) {
    const res = e.globs.map((g) => globToRegex(g.replace(/^\.\//, "")));
    if (!changed.some((f) => res.some((re) => re.test(f)))) continue;
    const cmd = entryCommand(e);
    if (!out.includes(cmd)) out.push(cmd);
  }
  return out;
}

/**
 * #4318: the dedupe key of a check command: whitespace collapsed, a leading `cd . && ` dropped, `<pm> run test` read as
 * `<pm> test` (npm/pnpm/yarn/bun) and an `npx`/`bunx [--yes|-y]` prefix dropped, so one suite under two spellings runs once.
 */
export function checkKey(c) {
  let k = String(c ?? "").trim().replace(/\s+/g, " ");
  k = k.replace(/^cd \.\/? && /, "");
  const cd = /^((?:cd|pushd) \S+ && )?(.*)$/.exec(k), pre = cd[1] ?? "";
  const cmd = cd[2].replace(/^(?:npx|bunx)(?: (?:--yes|-y))? /, "").replace(/^(npm|pnpm|yarn|bun) run test(?= |$)/, "$1 test");
  return pre + cmd;
}

/**
 * #4315: the pre-PR checks are the learned commands (in order) plus each map-selected command they lack; compared
 * by `checkKey` (#4318), so the map can only add checks, never remove one; the first spelling seen is kept. `source`:
 * "learned" when the map added nothing, "test-map" when there were no learned commands, else "test-map+learned".
 * @returns {{commands:string[], source:string, added:number}}
 */
export function mergeChecks(selected, learned) {
  const norm = checkKey;
  const commands = [], seen = new Set();
  const add = (c) => { const t = String(c ?? "").trim(), k = norm(t); if (!k || seen.has(k)) return false; seen.add(k); commands.push(t); return true; };
  for (const c of Array.isArray(learned) ? learned : []) add(c);
  const base = commands.length;
  let added = 0;
  for (const c of Array.isArray(selected) ? selected : []) if (add(c)) added++;
  return { commands, added, source: !added ? "learned" : base ? "test-map+learned" : "test-map" };
}

/**
 * #4331: change-scoped pre-PR checks. A learned command the map covers (an entry's command, with its `cd <cwd> && `
 * prefix, has the same `checkKey`) runs only when one of those entries has a glob matching a changed file; a learned
 * command with no map entry always runs (the safe default); map-selected commands the learned list lacks are added
 * as in `mergeChecks`. No map: the learned list unchanged. `source` is "learned" when the map added and dropped
 * nothing, "test-map" when there were no learned commands, else "test-map+learned".
 * @returns {{commands:string[], source:string, added:number, dropped:string[]}}
 */
export function scopeChecks(map, files, learned) {
  const list = Array.isArray(learned) ? learned : [];
  if (!map) { const m = mergeChecks([], list); return { ...m, dropped: [] }; }
  const selected = selectCommands(map, files), hit = new Set(selected.map(checkKey));
  const mapped = new Set((map.entries ?? []).map((e) => checkKey(entryCommand(e))));
  const dropped = [], kept = [];
  for (const c of list) { const k = checkKey(c); if (!k) continue; (mapped.has(k) && !hit.has(k) ? dropped : kept).push(String(c).trim()); }
  const m = mergeChecks(selected, kept);
  return { commands: m.commands, added: m.added, dropped, source: !m.added && !dropped.length ? "learned" : kept.length || dropped.length ? "test-map+learned" : "test-map" };
}

/** An entry's command as `selectCommands` emits it (`cd <cwd> && cmd` for a non-root cwd). */
function entryCommand(e) {
  const cwd = typeof e.cwd === "string" && e.cwd && e.cwd !== "." ? e.cwd : "";
  return cwd ? `cd ${shellQuote(cwd)} && ${e.command.trim()}` : e.command.trim();
}

/** The path of the first repo-facts file under `dirs` that exists, or null; never throws. */
export async function factsPath(dirs, exists) {
  if (typeof exists !== "function") return null;
  for (const d of dirs.filter(Boolean)) {
    const p = join(d, REPO_FACTS_FILE);
    try { if (await exists(p)) return p; } catch { /* absent */ }
  }
  return null;
}

function main(argv) {
  const i = argv.indexOf("--map"), j = argv.indexOf("--select");
  if (i < 0 || !argv[i + 1] || j !== i + 2) { console.error("usage: testmap.mjs --map FILE --select FILE..."); return 2; }
  let text;
  try { text = fs.readFileSync(argv[i + 1], "utf8"); } catch { console.error(`testmap: cannot read ${argv[i + 1]}`); return 2; }
  const map = parseTestMap(text);
  if (!map) { console.error("testmap: invalid test map"); return 2; }
  const files = argv.slice(j + 1);
  for (const c of selectCommands(map, files)) console.log(c);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

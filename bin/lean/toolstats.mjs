// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tool calls per turn and re-reads of one builder session (#4410), from the tool uses the runner's stream parser
 * collected (`runCliBackendAsync` `toolUses`: {msg, name, path, cmd}). A turn is one assistant message id with at least
 * one tool use; a read is the Read tool's path or a file operand of `cat`, `sed -n`, `head` or `tail` in a Bash command
 * (grep is a search, not a re-read); a re-read path is one read 3 or more times. Pure module: no I/O.
 */

export const REREAD_MIN = 3;
const MAX_SEGMENTS = 50;
const READERS = new Set(["cat", "sed", "head", "tail"]);
const VALUE_OPTS = { head: new Set(["-n", "-c"]), tail: new Set(["-n", "-c"]), sed: new Set(["-e", "-f", "-l"]) };

const tokens = (seg) => [...seg.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const clean = (p) => p.replace(/^\.\//, "");
const isPath = (t) => t && t !== "-" && !/[*?[\]$`]/.test(t);

/** File operands one read-only shell command reads with cat / sed -n / head / tail. */
function bashReads(cmd) {
  const out = [];
  for (const seg of String(cmd).split(/&&|\|\||[;|\n]/).slice(0, MAX_SEGMENTS)) {
    const t = tokens(seg);
    while (t.length && /^[A-Za-z_]\w*=/.test(t[0])) t.shift(); // env assignments
    const prog = t.shift();
    if (!READERS.has(prog)) continue;
    const ops = [];
    let quiet = false, script = false;
    for (let i = 0; i < t.length; i++) {
      const x = t[i];
      if (/^\d*[<>]/.test(x)) { if (/^\d*[<>]+&?$/.test(x)) i++; continue; } // redirection (and its target)
      if (x.startsWith("-") && x !== "-") {
        if (prog === "sed" && /^-[a-zA-Z]*n/.test(x)) quiet = true;
        if (prog === "sed" && (x === "-e" || x === "-f")) script = true;
        if (VALUE_OPTS[prog]?.has(x)) i++;
        continue;
      }
      ops.push(x);
    }
    if (prog === "sed") { if (!quiet) continue; if (!script) ops.shift(); }
    for (const p of ops) if (isPath(p)) out.push(clean(p));
  }
  return out;
}

/** Paths one tool use reads: the Read tool's path, or a Bash command's cat / sed -n / head / tail operands. */
export function readPaths(u) {
  if (!u || typeof u !== "object") return [];
  if (u.name === "Read") return typeof u.path === "string" && u.path ? [clean(u.path)] : [];
  if (u.name === "Bash" && typeof u.cmd === "string") return bashReads(u.cmd);
  return [];
}

/**
 * {calls, turns, per_turn, rereads, top} of one session's tool uses; null when there are none. `rereads` counts distinct
 * paths read REREAD_MIN or more times; `top` lists up to five of them, most-read first.
 */
export function toolStats(toolUses) {
  if (!Array.isArray(toolUses) || !toolUses.length) return null;
  const msgs = new Set(), reads = new Map();
  let calls = 0;
  for (const u of toolUses) {
    if (!u || typeof u !== "object") continue;
    calls++;
    msgs.add(u.msg ?? `#${calls}`);
    for (const p of readPaths(u)) reads.set(p, (reads.get(p) ?? 0) + 1);
  }
  if (!calls) return null;
  const hot = [...reads].filter(([, k]) => k >= REREAD_MIN).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { calls, turns: msgs.size, per_turn: Math.round((calls / msgs.size) * 100) / 100, rereads: hot.length,
    top: hot.slice(0, 5).map(([path, n]) => ({ path, reads: n })) };
}

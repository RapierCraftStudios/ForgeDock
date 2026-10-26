#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-read nudge (#4456): a Claude CLI PostToolUse hook the lean engine passes to builder sessions with `--settings`
 * (bin/lean/effects.mjs rereadNudgeFlags). It counts reads per path for one session, using the #4410 telemetry's
 * definition of a read (toolstats readPaths), and on exactly the REREAD_MIN-th read of a path it returns an
 * `additionalContext` system reminder. Advisory only: it always exits 0 and an error produces no output.
 * #4580: the same script is also a PreToolUse guard on Read: a full-file Read (no offset/limit) of a path already read
 * REREAD_MIN-1 times whose mtime is unchanged since its last read is denied with a reason that points at notes or a line
 * range. Ranged reads and Bash never deny, and any error allows. A changed mtime resets the path's count.
 * #4622: the guard counts only full-file Reads ({path: count} in <session_id>.full.json), so ranged Reads and Bash samples never
 * make a first full Read look like a re-read; the nudge still counts every read.
 * State: {path: count} in <tmpdir>/forgedock-reread/<session_id>.json plus {path: mtimeMs} in <session_id>.mtime.json (per-run caches).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPaths, REREAD_MIN } from "../lean/toolstats.mjs";

/** Paths one hook payload reads, resolved against the payload cwd so `sed -n … a.js` and Read `/abs/a.js` agree. */
export function payloadReads(payload) {
  const inp = payload?.tool_input ?? {};
  const path = inp.file_path ?? inp.path;
  const u = { name: payload?.tool_name ?? null, path: typeof path === "string" ? path : null, cmd: typeof inp.command === "string" ? inp.command : null };
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : null;
  return [...new Set(readPaths(u).map((p) => (cwd ? resolve(cwd, p) : p)))];
}

/** Pure core: counts after this payload and the reminder to emit (null when no path just reached REREAD_MIN). */
export function nudgeFor(payload, counts = {}) {
  const next = { ...counts }, hot = [];
  for (const p of payloadReads(payload)) {
    next[p] = (next[p] ?? 0) + 1;
    if (next[p] === REREAD_MIN) hot.push(p);
  }
  const message = hot.length ? `${hot.join(", ")} ${hot.length > 1 ? "have" : "has"} now been read ${REREAD_MIN} times in this session: `
    + "use your notes or the excerpt already in context; if you need a different part, read only that line range." : null;
  return { counts: next, message };
}

export const stateFile = (sessionId, dir = join(tmpdir(), "forgedock-reread")) =>
  join(dir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "session"}.json`);

const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const loadJson = (file) => { try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

/** Paths a payload reads whole: a Read with no offset/limit (what the guard counts, #4622). */
export function fullReads(payload) {
  const inp = payload?.tool_input ?? {};
  return payload?.tool_name === "Read" && inp.offset == null && inp.limit == null ? payloadReads(payload) : [];
}

/** Pure core of the guard: the deny reason for a payload, or null. `counts` are full-read counts; `mtimeNow(path)` is the file's current mtime. */
export function guardFor(payload, counts = {}, mtimes = {}, mtimeNow = mtimeOf) {
  const inp = payload?.tool_input ?? {};
  if (payload?.tool_name !== "Read" || inp.offset != null || inp.limit != null) return null;
  for (const p of payloadReads(payload)) {
    const now = mtimeNow(p);
    if (now != null && (counts[p] ?? 0) >= REREAD_MIN - 1 && mtimes[p] === now)
      return `${p} has already been read ${counts[p]} times in this session and has not changed: use your notes or the excerpt already in context; `
        + "if you need a different part, read only that line range (offset and limit).";
  }
  return null;
}

/** One hook call: stdin JSON in, the hookSpecificOutput line (or nothing) out. Fails open. */
export function main(input, { dir } = {}) {
  try {
    const payload = JSON.parse(input);
    if (!payload?.session_id) return "";
    if (!payloadReads(payload).length) return "";
    const file = stateFile(payload.session_id, dir), mfile = file.replace(/\.json$/, ".mtime.json");
    const ffile = file.replace(/\.json$/, ".full.json");
    const counts = loadJson(file), mtimes = loadJson(mfile), full = loadJson(ffile);
    if (payload.hook_event_name === "PreToolUse") {
      const reason = guardFor(payload, full, mtimes);
      return reason ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n` : "";
    }
    for (const p of payloadReads(payload)) {
      const now = mtimeOf(p);
      if (now != null && mtimes[p] !== now) { delete counts[p]; delete full[p]; } // the file changed (or is new): earlier reads no longer count
      if (now != null) mtimes[p] = now;
    }
    for (const p of fullReads(payload)) full[p] = (full[p] ?? 0) + 1;
    const r = nudgeFor(payload, counts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r.counts));
    writeFileSync(mfile, JSON.stringify(mtimes));
    writeFileSync(ffile, JSON.stringify(full));
    return r.message ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: r.message } })}\n` : "";
  } catch {
    return "";
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { input += c; });
  process.stdin.on("end", () => { process.stdout.write(main(input)); process.exitCode = 0; });
  process.stdin.on("error", () => { process.exitCode = 0; });
}

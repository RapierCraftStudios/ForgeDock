#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-read nudge (#4456): a Claude CLI PostToolUse hook the lean engine passes to builder sessions with `--settings`
 * (bin/lean/effects.mjs rereadNudgeFlags). It counts reads per path for one session, using the #4410 telemetry's
 * definition of a read (toolstats readPaths), and on exactly the REREAD_MIN-th read of a path it returns an
 * `additionalContext` system reminder. Advisory only: it always exits 0 and an error produces no output.
 * State: {path: count} in <tmpdir>/forgedock-reread/<session_id>.json (a per-run cache).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** One hook call: stdin JSON in, the hookSpecificOutput line (or nothing) out. Fails open. */
export function main(input, { dir } = {}) {
  try {
    const payload = JSON.parse(input);
    if (!payload?.session_id) return "";
    if (!payloadReads(payload).length) return "";
    const file = stateFile(payload.session_id, dir);
    let counts = {};
    try { counts = JSON.parse(readFileSync(file, "utf8")) ?? {}; } catch { /* first read of this session */ }
    const r = nudgeFor(payload, counts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r.counts));
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

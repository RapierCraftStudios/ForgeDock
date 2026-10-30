// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Read-only capability relay (#4778), zero LLM. A sandbox lane that needs a host-only capability (e.g. `prod_monitor`)
 * runs the operator's read-only wrapper (`obs-psql ...`) through `cs-relay`: the request goes sandbox -> pool agent ->
 * router queue, the dispatching host picks it up on its per-lane status poll (`servicePending`), gates it against the
 * forge.yaml `execution.relay_commands` allowlist (`relayGate`), runs it without a shell (`runRelayed`) and posts the
 * redacted output back. The key and the wrapper never leave the host; the router only queues.
 * Pre-fetch: the frozen contract's simple validate/repro_test commands that pass the gate (`relayPrefetchCommands`) are
 * run by the host at dispatch and shipped with the lane.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { parseContractComment } from "./render.mjs";
import { isTrustedIssueComment } from "./prefilter.mjs";
import { redact } from "./sandbox-remote.mjs";

const CAP_RE = /^[a-z][a-z0-9_-]*$/;
const COMMAND_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*\*?$/;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
export const RELAY_REFUSED_RC = 126;

/**
 * `capability:command` entries (list or comma string) -> `{capability: [command, ...]}`. A command is an exact name or a
 * prefix glob with one trailing `*` (`obs-*`); no path separators, whitespace or other glob characters. Invalid entries are ignored.
 */
export function parseRelayCommands(list) {
  const raw = Array.isArray(list) ? list : typeof list === "string" && list.trim() ? list.split(",") : [];
  const out = {};
  for (const x of raw) {
    const t = String(x ?? "").trim(), i = t.indexOf(":");
    if (i <= 0) continue;
    const cap = t.slice(0, i).trim().toLowerCase(), cmd = t.slice(i + 1).trim();
    if (!CAP_RE.test(cap) || !COMMAND_RE.test(cmd)) continue;
    (out[cap] ??= []).includes(cmd) || out[cap].push(cmd);
  }
  return out;
}

/** The exact (non-glob) command names of an allowlist: the wrappers the lane image shims. */
export function relayCommandNames(relay) {
  return [...new Set(Object.values(relay ?? {}).flat().filter((c) => NAME_RE.test(c)))].sort();
}

/** `{ok: true, capability}` when argv[0] is allowlisted (exact name or prefix glob, never a path); else `{ok: false, reason}`. */
export function relayGate(argv, relay) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) return { ok: false, reason: "relay: argv must be a non-empty string list" };
  const cmd = argv[0];
  if (!NAME_RE.test(cmd)) return { ok: false, reason: `relay: ${JSON.stringify(cmd)} not allowlisted` };
  for (const [capability, cmds] of Object.entries(relay ?? {})) {
    for (const c of Array.isArray(cmds) ? cmds : []) {
      if (c === cmd || (c.endsWith("*") && c.length > 1 && cmd.length >= c.length && cmd.startsWith(c.slice(0, -1)))) return { ok: true, capability };
    }
  }
  return { ok: false, reason: `relay: ${cmd} not allowlisted` };
}

/**
 * Run an argv on the host: execFile, no shell, the host env, a timeout and an output cap; every known secret is redacted.
 * `{rc, stdout, stderr, truncated?}`; a timeout is rc 124, a missing command rc 127. Never throws.
 */
export function runRelayed(argv, { timeoutMs = 120000, maxBytes = 1 << 20, secrets = [], execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    const done = (rc, stdout, stderr, extra = {}) => resolve({ rc, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), ...extra });
    try {
      execFileFn(argv[0], argv.slice(1), { shell: false, timeout: timeoutMs, maxBuffer: maxBytes, encoding: "utf8", windowsHide: true }, (err, stdout = "", stderr = "") => {
        if (!err) return done(0, stdout, stderr);
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return done(1, stdout, `${stderr}\nrelay: output over ${maxBytes} bytes, truncated`, { truncated: true });
        if (err.code === "ENOENT") return done(127, "", `relay: ${argv[0]} not found on the dispatching host`);
        if (err.killed) return done(124, stdout, `${stderr}\nrelay: timed out after ${Math.round(timeoutMs / 1000)}s`);
        return done(Number.isInteger(err.code) ? err.code : 1, stdout, stderr || String(err.message ?? ""));
      });
    } catch (e) { done(1, "", `relay: ${e?.message ?? e}`); }
  });
}

/** A shell command split into argv when it is one simple command (no pipes, lists, redirects, expansions); else null. */
export function simpleArgv(command) {
  const s = String(command ?? "").trim();
  const argv = [];
  let cur = null, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === "$" || ch === "`") return null;
      else if (ch === "\\" && i + 1 < s.length && '"\\'.includes(s[i + 1])) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; cur ??= ""; continue; }
    if ("|;&<>$`\n(){}".includes(ch)) return null;
    if (ch === "\\") { if (i + 1 >= s.length) return null; cur = (cur ?? "") + s[++i]; continue; }
    if (/\s/.test(ch)) { if (cur !== null) { argv.push(cur); cur = null; } continue; }
    cur = (cur ?? "") + ch;
  }
  if (q) return null;
  if (cur !== null) argv.push(cur);
  return argv.length ? argv : null;
}

/** lean.mjs `contractHash` (not imported: lean.mjs reaches this module through execution.mjs). */
const frozenHash = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 12);

/**
 * Pre-fetch candidates (#4778): the simple validate/repro_test commands the gate allows from the last frozen contract,
 * `[{argv}]`. Only a trusted FORGE:CONTRACT comment whose hash verifies counts, as in lean.mjs readFrozenContract: an
 * outsider's contract comment never chooses what the host runs (release #4820 API-1).
 */
export function relayPrefetchCommands({ comments = [] } = {}, relay = null) {
  if (!relay || !Object.keys(relay).length) return [];
  let contract = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (typeof c !== "object" || !isTrustedIssueComment(c)) continue;
    const b = String(c.body ?? "").trimStart();
    if (!b.startsWith("<!-- FORGE:CONTRACT -->")) continue;
    const fc = parseContractComment(b);
    if (fc?.contract && typeof fc.contract === "object" && frozenHash(fc.text) === fc.hash) contract = fc.contract;
  }
  if (!contract) return [];
  const cmds = (Array.isArray(contract.validate) ? contract.validate : []).map((v) => v?.command);
  if (typeof contract.repro_test?.command === "string") cmds.push(contract.repro_test.command);
  const out = [], seen = new Set();
  for (const c of cmds) {
    const argv = typeof c === "string" ? simpleArgv(c) : null;
    if (!argv || !relayGate(argv, relay).ok) continue;
    const k = JSON.stringify(argv);
    if (!seen.has(k)) { seen.add(k); out.push({ argv }); }
  }
  return out;
}

/**
 * Service a sandbox's pending relay requests: gate each, run the allowed ones, refuse the rest (rc 126), post every answer.
 * Each stream is capped so an answer fits the router's body limit; an answer the router still rejects is replaced by a small
 * rc 125 error, so the command is never re-run on every poll (release #4820 INFRA-1). Returns how many were answered.
 */
export const RELAY_ANSWER_STREAM_MAX = 256 * 1024;
const capStream = (s) => { const t = String(s ?? ""); return t.length > RELAY_ANSWER_STREAM_MAX ? `${t.slice(0, RELAY_ANSWER_STREAM_MAX)}\n[relay: output truncated at ${RELAY_ANSWER_STREAM_MAX} chars]\n` : t; };
export async function servicePending({ transport, id, relay, run = runRelayed, secrets = [] } = {}) {
  if (typeof transport?.relayPending !== "function" || typeof transport.relayAnswer !== "function") return 0;
  let list = [];
  try { list = (await transport.relayPending(id)) ?? []; } catch { return 0; }
  let n = 0;
  for (const req of Array.isArray(list) ? list : []) {
    if (typeof req?.rid !== "string" || !req.rid) continue;
    const g = relayGate(req.argv, relay);
    const raw = g.ok ? await run(req.argv, { secrets }) : { rc: RELAY_REFUSED_RC, stdout: "", stderr: g.reason };
    const out = { rc: Number.isInteger(raw?.rc) ? raw.rc : 1, stdout: capStream(redact(raw?.stdout, secrets)), stderr: capStream(redact(raw?.stderr, secrets)) }; // a custom runner is redacted too
    try { await transport.relayAnswer(id, req.rid, out); n++; }
    catch (e) {
      try { await transport.relayAnswer(id, req.rid, { rc: 125, stdout: "", stderr: `relay answer rejected: ${String(e?.message ?? e).slice(0, 200)}` }); n++; } catch { /* unreachable router: the next poll retries */ }
    }
  }
  return n;
}

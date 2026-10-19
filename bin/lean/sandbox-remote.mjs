// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Remote sandbox provider (#4254) on the execution.mjs provider seam: an ephemeral VM or container from a runner pool
 * or a remote agent session, reached through a transport. The transport is the only provider-specific part:
 *   launch(spec) · status(id) -> running|exited|gone · logs(id, cursor) -> {text, cursor} · result(id) -> object|null
 *   usage(id) -> {minutes}|null · destroy(id) -> true (a gone sandbox is destroyed)
 * The sandbox is addressed by the id ForgeDock picks (`idFor`), so a ledger entry written before `launch` is enough to
 * tear it down later. The launch spec asks the sandbox to clone the target repo, mount the configured shared cache
 * store, and run `forgedock run-issue`; its env is only `scopedEnv` (the repo's allowlisted secret names, resolved from
 * the env or the keychain, plus GH_REPO and FORGEDOCK_BATCH_ID). The lane log is streamed into the batch log file with
 * every secret value and the transport credential redacted. Billable minutes go on the handle (`handle.minutes`);
 * the handle never holds a secret.
 *
 * `httpTransport` is the one shipped transport: a small JSON protocol (docs/CONFIG.md `execution`) that a runner pool
 * or a session gateway fronts. Tests use an in-memory transport.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { safeSegment } from "./ledger.mjs";
import { scopedEnv } from "./execution.mjs";
import { resolveCredential } from "./credentials.mjs";

const REDACTED = "[redacted]";
const STATUS_ERRORS = 5;
/** Replace every value of `secrets` (4+ chars, longest first) in `text`. */
export function redact(text, secrets = []) {
  let s = String(text ?? "");
  for (const v of [...new Set(secrets.filter((x) => typeof x === "string" && x.length >= 4))].sort((a, b) => b.length - a.length)) s = s.split(v).join(REDACTED);
  return s;
}

/** True when an endpoint is a GitHub Actions API (spends Actions minutes): api.github.com or an `/actions/` path. */
export function isActionsEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.hostname.toLowerCase() === "api.github.com" || /\/actions(\/|$)/i.test(u.pathname);
  } catch { return false; }
}

/**
 * Generic HTTP transport: POST {endpoint}/sandboxes (body = launch spec), GET /sandboxes/:id -> {state},
 * GET /sandboxes/:id/logs?cursor=N -> {text, cursor}, GET /sandboxes/:id/result -> lane result (404 = none yet),
 * GET /sandboxes/:id/usage -> {minutes}, DELETE /sandboxes/:id (404 = gone). `Authorization: Bearer <token>`.
 * 429/503 on launch is a retryable capacity error (`Retry-After` seconds). Error text never carries the token.
 */
export function httpTransport({ endpoint, token = null, fetchFn = globalThis.fetch }) {
  const root = String(endpoint ?? "").replace(/\/+$/, "");
  const call = async (method, path, body) => {
    const res = await fetchFn(`${root}${path}`, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let data = null;
    try { const t = await res.text(); data = t ? JSON.parse(t) : null; } catch { data = null; }
    return { status: res.status, ok: res.ok, data, retryAfter: res.headers?.get?.("retry-after") ?? null };
  };
  const fail = (what, r) => {
    const e = new Error(`sandbox ${what}: HTTP ${r.status}`);
    if (r.status === 429 || r.status === 503) { e.retryable = true; const n = Number(r.retryAfter); if (Number.isFinite(n) && n > 0) e.retryInSeconds = n; }
    return e;
  };
  const p = (id) => `/sandboxes/${encodeURIComponent(id)}`;
  return {
    async launch(spec) { const r = await call("POST", "/sandboxes", spec); if (!r.ok) throw fail("launch", r); return r.data ?? {}; },
    async status(id) {
      const r = await call("GET", p(id));
      if (r.status === 404) return "gone";
      if (!r.ok) throw fail("status", r);
      const s = String(r.data?.state ?? "");
      return s === "running" || s === "pending" || s === "starting" ? "running" : s === "gone" ? "gone" : "exited";
    },
    async logs(id, cursor = 0) { const r = await call("GET", `${p(id)}/logs?cursor=${encodeURIComponent(cursor)}`); return r.ok ? { text: String(r.data?.text ?? ""), cursor: r.data?.cursor ?? cursor } : { text: "", cursor }; },
    async result(id) { const r = await call("GET", `${p(id)}/result`); return r.ok && r.data && typeof r.data === "object" ? r.data : null; },
    async usage(id) { const r = await call("GET", `${p(id)}/usage`); return r.ok && Number.isFinite(Number(r.data?.minutes)) ? { minutes: Number(r.data.minutes) } : null; },
    async destroy(id) { const r = await call("DELETE", p(id)); if (r.ok || r.status === 404) return true; throw fail("destroy", r); },
  };
}

/**
 * The remote provider. `settings` is parseExecution's output (image, cacheStore, tokenEnv, secrets); `env` is the
 * dispatcher's env (secret values for redaction on adopt); `credentials(name)` resolves a secret (env, then keychain).
 */
export function remoteProvider({ batch, repo, settings = {}, transport, env = process.env, credentials = (name) => resolveCredential(name, { env }), now = () => Date.now() }) {
  if (!transport) throw new Error("remote provider needs a transport");
  const idFor = (issue) => `fdrsbx-${safeSegment(batch.id)}-${issue}`;
  const errs = new Map(); // sandbox id -> consecutive status errors
  const known = new Set(); // secret values seen this process, for redaction
  const remember = (v) => { if (typeof v === "string" && v.length >= 4) known.add(v); };
  for (const k of settings.secrets ?? []) remember(credentials(k));
  if (settings.tokenEnv) remember(credentials(settings.tokenEnv));
  const minutesOf = async (h) => {
    let m = null;
    try { const u = await transport.usage?.(h.id); if (u && Number.isFinite(Number(u.minutes))) m = Number(u.minutes); } catch { m = null; }
    if (m === null && Number.isFinite(h.startedAt)) m = Math.round(((now() - h.startedAt) / 60000) * 10) / 10;
    if (m !== null) h.minutes = Math.max(h.minutes ?? 0, m);
  };
  const pullLogs = async (h) => {
    if (!transport.logs) return;
    try {
      const { text, cursor } = (await transport.logs(h.id, h.logCursor ?? 0)) ?? {};
      if (text) { const f = batch.logFile(h.issue); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, redact(text, [...known])); }
      if (cursor !== undefined) h.logCursor = cursor;
    } catch { /* the next poll retries */ }
  };
  return {
    name: "remote",
    idFor,
    async start({ issue, args = [], env: laneEnv = env, secrets = settings.secrets ?? [] }) {
      const id = idFor(issue);
      // Each allowlisted secret from the env, else the keychain (#4254); nothing else from the host.
      const resolved = {};
      for (const k of secrets) { const v = laneEnv?.[k] !== undefined && laneEnv[k] !== "" ? String(laneEnv[k]) : credentials(k); if (v) { resolved[k] = v; remember(v); } }
      const li = args.indexOf("--lane");
      const resultFile = `/result/${issue}.json`;
      const spec = {
        id, issue, batch: batch.id, image: settings.image ?? null,
        repo: { slug: repo, url: repo ? `https://github.com/${repo}.git` : null, ref: li >= 0 ? args[li + 1] ?? null : null },
        cache: settings.cacheStore ? { store: settings.cacheStore, key: safeSegment(String(repo ?? "repo")) } : null,
        env: scopedEnv({ env: resolved, secrets, batchId: batch.id, repo }),
        command: ["forgedock", "run-issue", String(issue), ...args, "--result-file", resultFile], result_file: resultFile,
      };
      const startedAt = now();
      await transport.launch(spec);
      return { provider: "remote", id, issue, startedAt, minutes: 0 };
    },
    async status(h) {
      let s;
      // A transient transport error is not an exit; STATUS_ERRORS in a row is (the lane then ends without a result).
      try { s = await transport.status(h.id); errs.delete(h.id); } catch { const k = (errs.get(h.id) ?? 0) + 1; errs.set(h.id, k); return k >= STATUS_ERRORS ? "gone" : "running"; }
      await pullLogs(h);
      return s === "running" ? "running" : s === "gone" ? "gone" : "exited";
    },
    async fetchResult(h) {
      const r = await transport.result(h.id);
      if (r) { await pullLogs(h); await minutesOf(h); }
      return r ?? null;
    },
    async teardown(h) {
      await minutesOf(h);
      try { return (await transport.destroy(h.id)) !== false; } catch { return false; }
    },
  };
}

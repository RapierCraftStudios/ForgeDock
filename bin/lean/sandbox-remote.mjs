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
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { safeSegment } from "./ledger.mjs";
import { scopedEnv } from "./execution.mjs";
import { resolveCredential } from "./credentials.mjs";
import { relayCommandNames, runRelayed, servicePending } from "./relay.mjs";

const REDACTED = "[redacted]";
const PREFETCH_MAX_B64 = 96 * 1024; // one env string stays under Linux MAX_ARG_STRLEN (128 KB)
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
 * GET /sandboxes/:id/usage -> {minutes, agent?} (agent: the pool agent that ran it, #4549), DELETE /sandboxes/:id (404 = gone). `Authorization: Bearer <token>`.
 * 429/503 on launch is a retryable capacity error (`Retry-After` seconds). Error text never carries the token.
 * Optional `POST /sandboxes/:id/stop` (#4612) asks the pool to SIGTERM the lane so its teardown checkpoints and it reports `deferred run.interrupted`; 2xx = sent, 404/405 = unsupported or gone (never a DELETE fallback).
 * Optional relay (#4778): `GET /sandboxes/:id/relay -> {requests: [{rid, argv}]}` lists a sandbox's pending read-only capability
 * requests (404/405 or malformed = none, an older router) and `POST /sandboxes/:id/relay/:rid` `{rc, stdout, stderr}` answers one.
 * Optional `GET /status -> {free: N, online?, total?}` is the pool's free slots (#4540); without `online` the agents of `GET /agents` give it (#4788). Anything else (404, error, malformed) is unknown (null).
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
    e.status = r.status;
    if ([502, 503, 504].includes(r.status)) e.transient = true; // #4672: a router restart or gateway blip, retried by the lane poll
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
    async usage(id) { const r = await call("GET", `${p(id)}/usage`); return r.ok && Number.isFinite(Number(r.data?.minutes)) ? { minutes: Number(r.data.minutes), ...(typeof r.data.agent === "string" && r.data.agent ? { agent: r.data.agent } : {}) } : null; }, // agent: #4549, optional
    async stop(id) { const r = await call("POST", `${p(id)}/stop`); if (r.ok) return true; if (r.status === 404 || r.status === 405) return false; throw fail("stop", r); },
    async destroy(id) { const r = await call("DELETE", p(id)); if (r.ok || r.status === 404) return true; throw fail("destroy", r); },
    async relayPending(id) { const r = await call("GET", `${p(id)}/relay`); return r.ok && Array.isArray(r.data?.requests) ? r.data.requests : []; },
    async relayAnswer(id, rid, out) { const r = await call("POST", `${p(id)}/relay/${encodeURIComponent(rid)}`, out); if (!r.ok) throw fail("relay answer", r); return true; },
    async capacity() {
      // `free` (#4540) and agent liveness `online`/`total` (#4547) are each optional; none valid is unknown.
      const ok = (v) => Number.isInteger(v) && v >= 0;
      let out = {};
      try {
        const r = await call("GET", "/status");
        if (r.ok) { const { free, online, total } = r.data ?? {}; out = { ...(ok(free) ? { free } : {}), ...(ok(online) ? { online } : {}), ...(ok(total) ? { total } : {}) }; }
      } catch { out = {}; }
      if (out.online === undefined) {
        // #4788: a router without /status liveness: online = agents answering and not paused, as bin/pool/router.mjs status() does.
        try {
          const r = await call("GET", "/agents");
          const list = r.ok && Array.isArray(r.data?.agents) ? r.data.agents : null;
          if (list) out = { ...out, online: list.filter((a) => a?.ok === true && !a.paused).length, total: list.length };
        } catch { /* liveness stays unknown */ }
      }
      return Object.keys(out).length ? out : null;
    },
  };
}

/**
 * The remote provider. `settings` is parseExecution's output (image, cacheStore, tokenEnv, secrets); `env` is the
 * dispatcher's env (secret values for redaction on adopt); `credentials(name)` resolves a secret (env, then keychain).
 */
/** The dispatching host's git identity (`git config user.name/email`), so sandbox commits carry the same author as local lanes. */
export function hostGitIdentity() {
  const get = (k) => { try { return execFileSync("git", ["config", k], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  return { name: get("user.name"), email: get("user.email") };
}

/** GIT_AUTHOR_* and GIT_COMMITTER_* for the sandbox, unless the lane env already sets them; empty when the host has no identity. */
export function gitIdentityEnv(identity, laneEnv = {}) {
  const out = {};
  for (const role of ["AUTHOR", "COMMITTER"]) {
    const n = laneEnv[`GIT_${role}_NAME`] || identity?.name, e = laneEnv[`GIT_${role}_EMAIL`] || identity?.email;
    if (n && e) { out[`GIT_${role}_NAME`] = n; out[`GIT_${role}_EMAIL`] = e; }
  }
  return out;
}

export function remoteProvider({ batch, repo, settings = {}, name = "remote", transport, env = process.env, credentials = (name) => resolveCredential(name, { env }), now = () => Date.now(), gitIdentity = hostGitIdentity,
  relayRun = runRelayed }) {
  if (!transport) throw new Error("remote provider needs a transport");
  const idFor = (issue) => `fdrsbx-${safeSegment(batch.id)}-${issue}`;
  const known = new Set(); // secret values seen this process, for redaction
  const remember = (v) => { if (typeof v === "string" && v.length >= 4) known.add(v); };
  for (const k of settings.secrets ?? []) remember(credentials(k));
  if (settings.tokenEnv) remember(credentials(settings.tokenEnv));
  const minutesOf = async (h) => {
    let m = null;
    try { const u = await transport.usage?.(h.id); if (u && Number.isFinite(Number(u.minutes))) m = Number(u.minutes); if (typeof u?.agent === "string" && u.agent) h.agent = u.agent; } catch { m = null; }
    if (m === null && Number.isFinite(h.startedAt)) m = Math.round(((now() - h.startedAt) / 60000) * 10) / 10;
    if (m !== null) h.minutes = Math.max(h.minutes ?? 0, m);
  };
  // #4778: capabilities the host relays (execution.relay_commands), only over a transport that carries relay requests.
  const relay = settings.relay && typeof settings.relay === "object" ? settings.relay : {};
  const relays = typeof transport.relayPending === "function" ? Object.keys(relay).filter((c) => relay[c]?.length).sort() : [];
  const inflight = new Set();
  const serviceRelay = async (h) => {
    if (!relays.length || inflight.has(h.id)) return 0;
    inflight.add(h.id);
    try { return await servicePending({ transport, id: h.id, relay, run: relayRun, secrets: [...known] }); } catch { return 0; } finally { inflight.delete(h.id); }
  };
  // #4778: the frozen contract's read-only queries, run on the host at dispatch and shipped with the lane (96 KB cap).
  const prefetchEnv = async (issue) => {
    if (!relays.length || typeof settings.prefetch !== "function") return {};
    let cmds = [];
    try { cmds = settings.prefetch(issue) ?? []; } catch { cmds = []; }
    const list = [];
    let b64 = "";
    for (const { argv } of Array.isArray(cmds) ? cmds : []) {
      const raw = await relayRun(argv, { secrets: [...known] });
      const out = { rc: Number.isInteger(raw?.rc) ? raw.rc : 1, stdout: redact(raw?.stdout, [...known]), stderr: redact(raw?.stderr, [...known]) };
      const next = Buffer.from(JSON.stringify([...list, { argv, ...out }])).toString("base64");
      if (next.length > PREFETCH_MAX_B64) continue;
      list.push({ argv, ...out });
      b64 = next;
    }
    return b64 ? { CS_RELAY_PREFETCH_B64: b64 } : {};
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
    name,
    idFor,
    relays,
    serviceRelay,
    async start({ issue, args = [], env: laneEnv = env, secrets = settings.secrets ?? [] }) {
      const id = idFor(issue);
      // Each allowlisted secret from the env, else the keychain (#4254); nothing else from the host.
      const resolved = {};
      for (const k of secrets) { const v = laneEnv?.[k] !== undefined && laneEnv[k] !== "" ? String(laneEnv[k]) : credentials(k); if (v) { resolved[k] = v; remember(v); } }
      const li = args.indexOf("--lane");
      const resultFile = `/result/${issue}.json`;
      const relayEnv = relays.length ? { CS_RELAY_COMMANDS: relayCommandNames(relay).join(","), CS_RELAY_CAPS: relays.join(","), ...(await prefetchEnv(issue)) } : {};
      const spec = {
        id, issue, batch: batch.id, image: settings.image ?? null,
        repo: { slug: repo, url: repo ? `https://github.com/${repo}.git` : null, ref: li >= 0 ? args[li + 1] ?? null : null },
        cache: settings.cacheStore ? { store: settings.cacheStore, key: safeSegment(String(repo ?? "repo")) } : null,
        // The host's git identity: without it the lane image falls back to a placeholder author that fails DCO.
        env: { ...gitIdentityEnv(gitIdentity(), laneEnv ?? {}), ...scopedEnv({ env: resolved, secrets, batchId: batch.id, repo }), ...(settings.forgeYaml ? { CS_FORGE_YAML_B64: Buffer.from(settings.forgeYaml).toString("base64") } : {}), ...relayEnv }, // #4546: the dispatcher's forge.yaml (gitignored in the repo)
        command: ["forgedock", "run-issue", String(issue), ...args, "--result-file", resultFile], result_file: resultFile,
      };
      const startedAt = now();
      await transport.launch(spec);
      return { provider: name, id, issue, startedAt, minutes: 0 };
    },
    async status(h) {
      let s;
      // #4672: a transport error is not an exit; it propagates and providerLanes retries it for execution.unreachable_window_min.
      s = await transport.status(h.id);
      await pullLogs(h);
      if (s === "running") serviceRelay(h).catch(() => {}); // #4778: in the background; never changes the status
      return s === "running" ? "running" : s === "gone" ? "gone" : "exited";
    },
    async fetchResult(h) {
      const r = await transport.result(h.id);
      if (r) { await pullLogs(h); await minutesOf(h); }
      return r ?? null;
    },
    async capacity() {
      try { return (await transport.capacity?.()) ?? null; } catch { return null; }
    },
    /** #4612: a graceful stop at the lane's checkpoint; false when unsupported or failed. Never destroys the sandbox. */
    async stop(h) {
      if (typeof transport.stop !== "function") return false;
      try { return (await transport.stop(h.id)) === true; } catch { return false; }
    },
    async teardown(h) {
      await minutesOf(h);
      try { return (await transport.destroy(h.id)) !== false; } catch { return false; }
    },
  };
}

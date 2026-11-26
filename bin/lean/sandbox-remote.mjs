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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mergeRemoteLog } from "../engine/runlog.mjs";
import { safeSegment } from "./ledger.mjs";
import { scopedEnv } from "./execution.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { laneEnvFor, readEnvSnapshots } from "../env/env.mjs";
import { resolveCredential } from "./credentials.mjs";
import { seedMirror } from "./mirror-bundle.mjs";
import { relayCommandNames, runRelayed, servicePending } from "./relay.mjs";

/** #5949: one log line for a launch's seed stats: bytes sent, and the time saved against shipping the whole repo at the same rate. */
const seedLine = (s) => (s.fallback ? `fell back to GitHub (${s.reason})` : s.upToDate ? "mirror already up to date, nothing sent" : `${s.full ? "full" : "incremental"} bundle, ${s.bytes} bytes in ${s.chunks} chunks, ${s.ms} ms${Number.isFinite(s.saved_ms) ? `, about ${Math.round(s.saved_ms / 1000)} s saved` : ""}`);
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
 * GET /sandboxes/:id/usage -> {minutes, agent?} (agent: the pool agent that ran it, #4549), DELETE /sandboxes/:id (404 = gone). `Authorization: Bearer <token>`
 * (`token` is a string, or a function called per request, #5144).
 * 429/503 on launch is a retryable capacity error (`Retry-After` seconds). Error text never carries the token.
 * Optional `POST /sandboxes/:id/stop` (#4612) asks the pool to SIGTERM the lane so its teardown checkpoints and it reports `deferred run.interrupted`; 2xx = sent, 404/405 = unsupported or gone (never a DELETE fallback).
 * `GET /agents -> {sandboxes}` is the router's live sandbox list (#5422, `inventory()`; malformed or any error throws).
 * Optional relay (#4778): `GET /sandboxes/:id/relay -> {requests: [{rid, argv}]}` lists a sandbox's pending read-only capability
 * requests (404/405 or malformed = none, an older router) and `POST /sandboxes/:id/relay/:rid` `{rc, stdout, stderr}` answers one.
 * Optional `GET /status[?repo=<slug>] -> {free: N, online?, total?}` is the pool's free slots (#4540); `?repo=` (#6041) limits `/status` and `/agents` to the agents the repo may use (router.json `repos.<slug>.agents` / `exclude_agents`); without `online` the agents of `GET /agents` give it (#4788). Anything else (404, error, malformed) is unknown (null).
 */
export function httpTransport({ endpoint, token = null, fetchFn = globalThis.fetch }) {
  const root = String(endpoint ?? "").replace(/\/+$/, "");
  const call = async (method, path, body) => {
    // #5144: `token` may be a function, resolved on every request so a token fixed or rotated mid-batch is the next bearer.
    const bearer = typeof token === "function" ? token() : token;
    const res = await fetchFn(`${root}${path}`, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let data = null;
    try { const t = await res.text(); data = t ? JSON.parse(t) : null; } catch { data = null; }
    return { status: res.status, ok: res.ok, data, retryAfter: res.headers?.get?.("retry-after") ?? null };
  };
  const fail = (what, r) => {
    // #5053: a 401 names the hop that answered it (router or agent; the pool tags the body), never the token.
    const hop = r.status === 401 && ["router", "agent"].includes(r.data?.hop) ? r.data.hop : null;
    const who = hop === "agent" && typeof r.data?.agent === "string" ? `agent ${r.data.agent.slice(0, 64)}` : hop;
    const reason = hop && typeof r.data?.reason === "string" ? r.data.reason.replace(/^(router|agent) auth: /, "").replace(/[^\x20-\x7e]/g, "").slice(0, 80) : "";
    // 2026-11-26: non-auth failures keep the pool's error text (printable, ≤160 chars, never a token), so a seed 409/422 says why
    const live = typeof token === "function" ? (() => { try { return token(); } catch { return null; } })() : token;
    const err = !hop && typeof r.data?.error === "string" ? redact(r.data.error, [live]).replace(/[^\x20-\x7e]/g, "").slice(0, 160) : "";
    const e = new Error(`sandbox ${what}: HTTP ${r.status}${who ? ` (${who} auth${reason ? `: ${reason}` : ""})` : ""}${err ? `: ${err}` : ""}`);
    e.status = r.status;
    if (hop) e.hop = hop;
    if (typeof r.data?.code === "string" && r.data.code.startsWith("pool.")) e.poolCode = r.data.code; // #5985: the pool's refusal code reaches the deferral row
    if (r.data?.live && typeof r.data.live === "object") e.live = { load_per_core: r.data.live.load_per_core, mem_available_gb: r.data.live.mem_available_gb };
    if (reason) e.reason = reason;
    if ([500, 502, 503, 504].includes(r.status)) e.transient = true; // #4672: a router restart or gateway blip, retried by the lane poll; #5095: 500 too
    if (r.status === 429 || r.status === 503) e.retryable = true;
    // #5095: Retry-After is honoured on any 429/5xx, so a launch 5xx (sandbox.transient) backs off as the pool asks
    if (r.status === 429 || r.status >= 500) { const n = Number(r.retryAfter); if (Number.isFinite(n) && n > 0) e.retryInSeconds = n; }
    return e;
  };
  const p = (id) => `/sandboxes/${encodeURIComponent(id)}`;
  const placedImage = new Map(); // sandbox id -> lane image version the agent reported at launch
  const placedEngine = new Map(); // sandbox id -> lane-engine version of the agent the router placed it on (R3: the ran version is recorded even when the lane reports none)
  return {
    async launch(spec) { const r = await call("POST", "/sandboxes", spec); if (!r.ok) throw fail("launch", r); if (typeof r.data?.engine_version === "string" && typeof spec?.id === "string") placedEngine.set(spec.id, r.data.engine_version); if (typeof r.data?.image_version === "string" && typeof spec?.id === "string") placedImage.set(spec.id, r.data.image_version); return r.data ?? {}; },
    /** #4912: hand the lane to a ready warm sandbox. 200/201 = claimed; 204/404/405 (none ready, or a pool without warm sandboxes) = null. */
    async claim(spec) { const r = await call("POST", "/sandboxes/claim", spec); if (r.status === 200 || r.status === 201) return r.data ?? {}; if (r.status === 204 || r.status === 404 || r.status === 405) return null; throw fail("claim", r); },
    async status(id) {
      const r = await call("GET", p(id));
      if (r.status === 404) return "gone";
      if (!r.ok) throw Object.assign(fail("status", r), r.status === 401 ? { transient: true } : {}); // #5053: the sandbox launched, so a 401 is retried like an unreachable pool
      const s = String(r.data?.state ?? "");
      return s === "running" || s === "pending" || s === "starting" || s === "paused" ? "running" : s === "gone" ? "gone" : "exited";
    },
    async logs(id, cursor = 0) { const r = await call("GET", `${p(id)}/logs?cursor=${encodeURIComponent(cursor)}`); return r.ok ? { text: String(r.data?.text ?? ""), cursor: r.data?.cursor ?? cursor } : { text: "", cursor }; },
    async result(id) { const r = await call("GET", `${p(id)}/result`); if (r.status === 401) throw Object.assign(fail("result", r), { transient: true }); if (r.ok && r.data?.disk_pressure === true) return { terminalReason: "deferred", code: OUTCOME_CODES.SANDBOX_DISK_PRESSURE, retryInSeconds: 120, cost_usd: 0, detail: `sandbox ${id} was stopped to save the host drive (disk pressure); worktree and volume kept, requeued to resume` }; /* #5891 */ if (r.ok && r.data?.drained === true) return { terminalReason: "deferred", code: OUTCOME_CODES.SANDBOX_CAPACITY, retryInSeconds: 60, cost_usd: 0, detail: `sandbox ${id} was drained to free capacity for reserved work (${String(r.data.reason ?? "").slice(0, 120)}); rescheduled` }; /* #5856 */ if (r.ok && r.data && typeof r.data === "object") { const v = r.data.engineVersion ?? r.data.engine_version ?? r.data.forge_version ?? /ForgeDock\s*[·-]\s*v?(\d+\.\d+(?:\.\d+)?)/.exec(String(r.data.banner ?? r.data.log ?? ""))?.[1]; const pv = v ?? placedEngine.get(id); const iv = r.data.imageVersion ?? r.data.image_version ?? placedImage.get(id); const out = pv && !r.data.engineVersion ? { ...r.data, engineVersion: String(pv) } : r.data; return iv && !out.imageVersion ? { ...out, imageVersion: String(iv) } : out; } return null; }, /* #5931 */
    async usage(id) { const r = await call("GET", `${p(id)}/usage`); return r.ok && Number.isFinite(Number(r.data?.minutes)) ? { minutes: Number(r.data.minutes), ...(typeof r.data.agent === "string" && r.data.agent ? { agent: r.data.agent } : {}) } : null; }, // agent: #4549, optional
    async stop(id) { const r = await call("POST", `${p(id)}/stop`); if (r.ok) return true; if (r.status === 404 || r.status === 405) return false; throw fail("stop", r); },
    async destroy(id) { const r = await call("DELETE", p(id)); if (r.ok || r.status === 404) return true; throw fail("destroy", r); },
    /** #5422: the sandboxes the router knows (`GET /agents` -> `sandboxes`, id -> {agent, issue, batch}) as [{id, issue}]. Anything but a well-formed answer throws: an unknown list is never an empty one. */
    async inventory() {
      const r = await call("GET", "/agents");
      if (!r.ok) throw fail("inventory", r);
      const m = r.data?.sandboxes;
      if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("sandbox inventory: malformed router answer");
      return Object.entries(m).map(([id, x]) => ({ id, issue: x?.issue ?? null, disk_used_mb: Number.isFinite(x?.disk_used_mb) ? x.disk_used_mb : null })); // #5535: null = old agent
    },
    /** #5535: each pool agent's free disk from `GET /agents` -> `agents[]` as [{name, disk_free_gb|null}]; a bad answer throws. */
    async agentDisk() {
      const r = await call("GET", "/agents");
      if (!r.ok) throw fail("agent disk", r);
      if (!Array.isArray(r.data?.agents)) throw new Error("agent disk: malformed router answer");
      return r.data.agents.map((a) => ({ name: String(a?.name ?? "?"), disk_free_gb: Number.isFinite(a?.disk_free_gb) ? a.disk_free_gb : null }));
    },
    /** #5949: the agent mirror's ref tips for a repo ({mirrors: {slug: {ref: sha} | "absent"}, upload_offset?}); 404/405 = an older router/agent (unsupported). */
    async mirrors(id, q) {
      const r = await call("GET", `${p(id)}/mirrors?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]))}`);
      if (r.status === 404 || r.status === 405) throw Object.assign(fail("mirrors", r), { unsupported: true });
      if (!r.ok) throw fail("mirrors", r);
      return r.data ?? {};
    },
    /** #5949: one bundle chunk or the finish call; a 409 carries the agent's resume offset. */
    async seed(id, body) {
      const r = await call("POST", `${p(id)}/seed`, body);
      if (r.status === 404 || r.status === 405) throw Object.assign(fail("seed", r), { unsupported: true });
      if (!r.ok) throw Object.assign(fail("seed", r), Number.isInteger(r.data?.offset) ? { offset: r.data.offset } : {});
      return r.data ?? {};
    },
    /** #5735: lane sandboxes per pool agent (`GET /agents` -> `agents[].lanes {used, ceiling}`) and across all batches (`remote_lanes`; else the `fdrsbx-` keys of `sandboxes`). A bad answer throws. */
    async agentLanes() {
      const r = await call("GET", "/agents");
      if (!r.ok) throw fail("agent lanes", r);
      if (!Array.isArray(r.data?.agents)) throw new Error("agent lanes: malformed router answer");
      const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
      const agents = r.data.agents.map((a) => ({ name: String(a?.name ?? "?"), used: int(a?.lanes?.used) ?? 0, ceiling: int(a?.lanes?.ceiling) }));
      const sb = r.data.sandboxes && typeof r.data.sandboxes === "object" ? Object.keys(r.data.sandboxes) : [];
      return { agents, total: int(r.data.remote_lanes) ?? sb.filter((id) => id.startsWith("fdrsbx-")).length };
    },
    /** #5985: finished-lane usage rows (`{repo, cpu_avg, ...}`) of every pool agent (`GET /agents/:name/usage`), for the light/heavy lane class. A bad answer throws. */
    async usageHistory() {
      const r = await call("GET", "/agents");
      if (!r.ok) throw fail("usage history", r);
      const names = (Array.isArray(r.data?.agents) ? r.data.agents : []).map((a) => a?.name).filter((n) => typeof n === "string");
      const rows = [];
      for (const n of names) { try { const u = await call("GET", `/agents/${encodeURIComponent(n)}/usage`); if (u.ok && Array.isArray(u.data?.rows)) rows.push(...u.data.rows); } catch { /* one agent down: its rows are unknown */ } }
      return rows;
    },
    async relayPending(id) { const r = await call("GET", `${p(id)}/relay`); return r.ok && Array.isArray(r.data?.requests) ? r.data.requests : []; },
    async relayAnswer(id, rid, out) { const r = await call("POST", `${p(id)}/relay/${encodeURIComponent(rid)}`, out); if (!r.ok) throw fail("relay answer", r); return true; },
    /** #5991: the pool agent that runs `agent` (any agent when unnamed) answers `GET /agents` and is not paused; errors propagate. */
    async agentOnline(agent = null) {
      const r = await call("GET", "/agents");
      const list = r.ok && Array.isArray(r.data?.agents) ? r.data.agents : null;
      if (!list) throw fail("agents", r);
      return list.some((a) => a?.ok === true && !a.paused && (!agent || a.name === agent));
    },
    async capacity({ repo } = {}) {
      const q = typeof repo === "string" && repo ? `?repo=${encodeURIComponent(repo)}` : ""; // #6041: only the repo's allowed agents count
      // `free` (#4540) and agent liveness `online`/`total` (#4547) are each optional; none valid is unknown.
      const ok = (v) => Number.isInteger(v) && v >= 0;
      let out = {}, reached = false, lastErr = null;
      try {
        const r = await call("GET", `/status${q}`);
        reached = true;
        if (r.ok) { const { free, online, total } = r.data ?? {}; const agents = (Array.isArray(r.data?.agents) ? r.data.agents : []).filter((a) => typeof a?.engine_version === "string").map((a) => ({ name: a.name, ok: a.ok === true, paused: a.paused === true, engine_version: a.engine_version })); // R6: per-agent lane engines
          out = { ...(ok(free) ? { free } : {}), ...(ok(online) ? { online } : {}), ...(ok(total) ? { total } : {}), ...(agents.length ? { agents } : {}) }; }
      } catch (e) { out = {}; lastErr = e; }
      if (out.online === undefined || out.load_per_core === undefined) {
        // #4788: a router without /status liveness: online = agents answering and not paused, as bin/pool/router.mjs status() does.
        try {
          const r = await call("GET", `/agents${q}`);
          reached = true;
          const list = r.ok && Array.isArray(r.data?.agents) ? r.data.agents : null;
          if (list && out.online === undefined) out = { ...out, online: list.filter((a) => a?.ok === true && !a.paused).length, total: list.length };
          // #5985: live host figures (worst agent); a pool reporting none leaves them unknown
          const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
          const loads = (list ?? []).map((a) => num(a?.load_per_core ?? a?.live?.load_per_core)).filter((v) => v !== null);
          const mems = (list ?? []).map((a) => num(a?.mem_available_gb ?? a?.live?.mem_available_gb)).filter((v) => v !== null);
          if (loads.length) out = { ...out, load_per_core: Math.max(...loads) };
          if (mems.length) out = { ...out, mem_available_gb: Math.min(...mems) };
        } catch (e) { lastErr = e; /* liveness stays unknown */ }
      }
      // #5048 (release review REG-2): a router that answered neither call is unreachable: throw, so the pool is marked down
      if (!reached) throw Object.assign(new Error(`pool router unreachable: ${String(lastErr?.message ?? lastErr).slice(0, 160)}`), { unreachable: true });
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
  const stopWhy = new Map(); // #5241: sandbox id -> why its last stop was not accepted
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
      if (settings.laneToolsErrors?.length) throw Object.assign(new Error(settings.laneToolsErrors.join("; ")), { code: "lane_tools.invalid" }); // #5650
      const id = idFor(issue);
      // Each allowlisted secret from the env, else the keychain (#4254); nothing else from the host.
      const resolved = {};
      if (settings.tokenEnv) remember(credentials(settings.tokenEnv)); // #5144: a token rotated since construction is redacted too
      for (const k of secrets) { const v = laneEnv?.[k] !== undefined && laneEnv[k] !== "" ? String(laneEnv[k]) : credentials(k); if (v) { resolved[k] = v; remember(v); } }
      const li = args.indexOf("--lane");
      const resultFile = `/result/${issue}.json`;
      const relayEnv = relays.length ? { CS_RELAY_COMMANDS: relayCommandNames(relay).join(","), CS_RELAY_CAPS: relays.join(","), ...(await prefetchEnv(issue)) } : {};
      const warm = Number.isInteger(settings.warmSandboxes) && settings.warmSandboxes > 0 ? settings.warmSandboxes : 0;
      const envSnap = settings.forgeYaml ? readEnvSnapshots(settings.forgeYaml) : null; // env.snapshots: off unless enabled
      const spec = {
        id, issue, batch: batch.id, image: settings.image ?? null,
        ...(typeof settings.minLaneEngine === "string" && settings.minLaneEngine ? { min_lane_engine: settings.minLaneEngine } : {}), // R2: the router drops lower-engine agents (pool.engine_old deferral)
        priority: "borrow", // #5856: lanes run on leftover capacity; a pool with reservations throttles/drains them for reserved work
        repo: { slug: repo, url: repo ? `https://github.com/${repo}.git` : null, ref: li >= 0 ? args[li + 1] ?? null : null },
        ...(settings.laneTools?.length ? { lane_tools: settings.laneTools } : {}), // #5650: per-repo lane image
        ...(envSnap?.enabled ? { env_snapshots: { enabled: true, ready: envSnap.ready, keep: envSnap.keep, max_age_days: envSnap.maxAgeDays } } : {}), // the agent builds and stages snapshots outside the lane
        ...(warm ? { warm } : {}), // #4912: the pool agent keeps this many warm sandboxes for the repo
        cache: settings.cacheStore ? { store: settings.cacheStore, key: safeSegment(String(repo ?? "repo")) } : null,
        // The host's git identity: without it the lane image falls back to a placeholder author that fails DCO.
        env: { ...gitIdentityEnv(gitIdentity(), laneEnv ?? {}), ...scopedEnv({ env: resolved, secrets, batchId: batch.id, repo }), ...(settings.forgeYaml ? { CS_FORGE_YAML_B64: Buffer.from(settings.forgeYaml).toString("base64") } : {}), ...relayEnv, ...laneEnvFor(envSnap, settings.laneTools ?? []) }, // #4546: the dispatcher's forge.yaml (gitignored in the repo)
        command: ["forgedock", "run-issue", String(issue), ...args, "--result-file", resultFile], result_file: resultFile,
      };
      const startedAt = now();
      // #4912: a ready warm sandbox first; none, an error or a transport without claim is the cold start.
      let claimed = null;
      if (warm && typeof transport.claim === "function") { try { claimed = await transport.claim(spec); } catch { claimed = null; } }
      // #5949: seed the pool agent's mirror from this host first (repo_source dispatcher|github|auto); failure falls back to GitHub, or fails under `dispatcher`.
      let seed = null;
      const source = ["dispatcher", "github"].includes(settings.repoSource) ? settings.repoSource : "auto";
      if (!claimed && repo && settings.repoDir && source !== "github" && typeof transport.seed === "function") {
        try { seed = await seedMirror({ transport, id, slug: repo, cacheKey: spec.cache?.key ?? repo, repoDir: settings.repoDir, now }); }
        catch (e) {
          if (source === "dispatcher") throw Object.assign(new Error(`repo seeding failed (repo_source=dispatcher): ${redact(e?.message ?? e, [...known]).slice(0, 200)}`), { code: "pool.seed_failed", transient: e?.transient === true });
          seed = { sent: false, fallback: true, reason: redact(e?.message ?? e, [...known]).slice(0, 160) };
        }
      }
      if (!claimed) await transport.launch(spec);
      if (seed) {
        try { const f = batch.logFile(issue); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, `[seed] ${seedLine(seed)}\n`); } catch { /* logging only */ }
      }
      return { provider: name, id, issue, startedAt, minutes: 0, ...(seed ? { seed } : {}) };
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
      if (!r) return null;
      const { runLog, ...rest } = r; // #5697: the lane's run log goes to the host run log, not into the result
      if (runLog) mergeRemoteLog(env.FORGE_RUNS_DIR || join(homedir(), ".forge", "runs"), h.issue, runLog, { repo });
      return rest;
    },
    /** #5991: is the pool agent of this handle answering? Unknown (null) without transport support; transport errors propagate. */
    async agentOnline(h) {
      if (typeof transport.agentOnline !== "function") return null;
      return transport.agentOnline(typeof h?.agent === "string" && h.agent ? h.agent : null);
    },
    async capacity() {
      // #5048: no capacity() is unknown (null); a transport error propagates, so the caller can report the pool down
      if (typeof transport.capacity !== "function") return null;
      return (await transport.capacity({ repo })) ?? null;
    },
    /** #5985: the pool's usage-history rows; null when the transport has none. */
    async usageHistory() { return typeof transport.usageHistory === "function" ? (await transport.usageHistory()) ?? null : null; },
    /** #4612: a graceful stop at the lane's checkpoint; false when unsupported or failed. Never destroys the sandbox. */
    async stop(h) {
      if (typeof transport.stop !== "function") { stopWhy.set(h.id, "the transport has no stop"); return false; }
      try {
        const ok = (await transport.stop(h.id)) === true;
        if (ok) stopWhy.delete(h.id); else stopWhy.set(h.id, "the pool does not support stop (404/405)");
        return ok;
      } catch (e) { stopWhy.set(h.id, `stop failed: ${e?.message ?? e}`); return false; }
    },
    /** #5241: why the last `stop(h)` returned false (null when it succeeded or never ran), so a cancel can report it. */
    stopReason: (h) => stopWhy.get(h?.id) ?? null,
    async teardown(h) {
      await minutesOf(h);
      try { return (await transport.destroy(h.id)) !== false; } catch { return false; }
    },
  };
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { bearerOk, call, readJson, route, sameSecret, send } from "./http.mjs";
import { jsonStore } from "./store.mjs";
import { versionOf } from "./version.mjs";

const run = promisify(execFile);

/**
 * Router: the endpoint ForgeDock's remote provider talks to (POST /sandboxes, GET /sandboxes/:id[/logs|/result|/usage],
 * DELETE /sandboxes/:id). It places each sandbox on the enrolled agent with the most free reserved CPU, forwards every
 * later call to that agent, renews the agent lease while ForgeDock keeps polling, and destroys sandboxes ForgeDock
 * has abandoned. It also serves the agent installer and enrollment.
 */
export function createRouter(cfg, { fetchFn = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
  const store = jsonStore(join(cfg.state_dir, "router-state.json"), { agents: {}, sandboxes: {} });
  const agents = () => store.data.agents;
  const sbx = () => store.data.sandboxes;
  const lane = { cpus: cfg.lane?.cpus ?? 2, mem_gb: cfg.lane?.mem_gb ?? 3 };
  const abandonMs = (cfg.abandon_after_s ?? 1800) * 1000;
  const codes = () => (store.data.codes ??= {});
  const codeTtlMs = (cfg.code_ttl_s ?? 1800) * 1000;
  /** The long-lived enroll token, or an unexpired one-time install code (consumed by a successful enrollment). */
  function enrollOk(token, consume = false) {
    if (sameSecret(token, cfg.enroll_token)) return true;
    const c = typeof token === "string" ? codes()[token] : null;
    if (!c || c.used || c.expires <= now()) return false;
    if (consume) { c.used = true; store.save(); }
    return true;
  }
  function issueCode() {
    const code = randomBytes(9).toString("base64url");
    codes()[code] = { expires: now() + codeTtlMs, used: false };
    store.save();
    return { code, expires_at: new Date(now() + codeTtlMs).toISOString() };
  }
  /** The enrolled agent whose token the request carries, or null. */
  function agentFor(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    return Object.entries(agents()).find(([, a]) => sameSecret(m[1].trim(), a.token))?.[0] ?? null;
  }
  // Fresh GitHub token for sandboxes, read from this host's gh (kept fresh by its own refresh timer).
  let gh = { token: null, at: 0 };
  async function githubToken() {
    if (!gh.token || now() - gh.at > 60000) {
      const { stdout } = await run(cfg.gh_bin ?? "gh", ["auth", "token"], { timeout: 20000 });
      gh = { token: stdout.trim(), at: now() };
    }
    return gh.token;
  }
  // Claude access token for sandboxes: the logged-in account on this host with the most validity left. Only the
  // short-lived access token is shared; refresh tokens stay here, so this host keeps refreshing its own sessions.
  function claudeToken() {
    const dirs = cfg.claude_config_dirs ?? readdirSync(homedir()).filter((d) => /^\.claude(-\d+)?$/.test(d)).map((d) => join(homedir(), d));
    let best = null;
    for (const d of dirs) {
      try {
        const o = JSON.parse(readFileSync(join(d, ".credentials.json"), "utf8")).claudeAiOauth;
        if (o?.accessToken && o.expiresAt > now() + 30 * 60000 && (!best || o.expiresAt > best.expiresAt)) best = o;
      } catch { /* no login in this dir */ }
    }
    if (!best) throw Object.assign(new Error("no Claude login on the router host with 30+ minutes left"), { status: 503 });
    return { token: best.accessToken, expires_at: new Date(best.expiresAt).toISOString() };
  }
  const agentCall = (a, method, path, body, timeoutMs) => call(a.url, method, path, { body, token: a.token, timeoutMs, fetchFn });

  async function capacities() {
    const out = [];
    for (const [name, a] of Object.entries(agents())) {
      try {
        const r = await agentCall(a, "GET", "/capacity", undefined, 5000);
        out.push(r.ok ? { name, ok: true, ...r.data } : { name, ok: false, error: `HTTP ${r.status}` });
      } catch (e) { out.push({ name, ok: false, error: String(e.message ?? e) }); }
    }
    return out;
  }

  /** Agent liveness for the scheduler (#4547): an agent is online when it answers and is not paused. */
  async function status() {
    const caps = await capacities();
    const agentsView = caps.map((c) => ({ name: c.name, ok: c.ok, paused: Boolean(c.paused) }));
    return { online: agentsView.filter((a) => a.ok && !a.paused).length, total: agentsView.length, agents: agentsView };
  }

  /** Per-repo extras: the gitignored forge.yaml, and a private Docker daemon (with a bigger reservation) when enabled. */
  const repoCfg = (spec) => cfg.repos?.[spec?.repo?.slug] ?? {};
  // Placement counts the (small) reservation; `limit` is each container's hard burst cap (burst model, when configured).
  const sizeFor = (spec) => {
    const docker = Boolean(repoCfg(spec).docker), dind = cfg.dind ?? { cpus: 1, mem_gb: 2 };
    const size = docker ? { cpus: lane.cpus + dind.cpus, mem_gb: lane.mem_gb + dind.mem_gb } : { cpus: lane.cpus, mem_gb: lane.mem_gb };
    if (cfg.lane?.limit) {
      size.limit = { lane_cpus: cfg.lane.limit.cpus, lane_mem_gb: cfg.lane.limit.mem_gb, lane_swap_gb: cfg.lane.limit.swap_gb ?? 0,
        ...(docker ? { dind_cpus: dind.limit?.cpus ?? 2, dind_mem_gb: dind.limit?.mem_gb ?? 3, dind_swap_gb: dind.limit?.swap_gb ?? 0 } : {}) };
    }
    return size;
  };
  function withForgeYaml(spec0) {
    const spec = repoCfg(spec0).docker ? { ...spec0, docker: true } : spec0;
    const path = repoCfg(spec).forge_yaml;
    if (!path) return spec;
    try { return { ...spec, env: { ...(spec.env ?? {}), CS_FORGE_YAML_B64: readFileSync(path).toString("base64") } }; }
    catch (e) { log.warn?.(`forge.yaml for ${spec.repo.slug} unreadable: ${e.message}`); return spec; }
  }

  async function launch(spec) {
    if (!spec?.id) return { status: 400, body: { error: "spec.id required" } };
    const known = sbx()[spec.id];
    if (known && agents()[known.agent]) {
      known.touched = now(); store.save();
      const r = await agentCall(agents()[known.agent], "POST", "/sandboxes", { spec: withForgeYaml(spec), ...sizeFor(spec) });
      return { status: r.status, body: r.data, retryAfter: r.retryAfter };
    }
    const size = sizeFor(spec);
    const fits = (await capacities()).filter((c) => c.ok && !c.paused && c.cpus_free >= size.cpus && c.mem_free_gb >= size.mem_gb)
      .sort((a, b) => b.cpus_free - a.cpus_free || b.mem_free_gb - a.mem_free_gb);
    for (const c of fits) {
      const r = await agentCall(agents()[c.name], "POST", "/sandboxes", { spec: withForgeYaml(spec), ...size }, 120000);
      if (r.status === 503) continue; // raced with another launch; try the next host
      if (r.ok) { sbx()[spec.id] = { agent: c.name, issue: spec.issue ?? null, batch: spec.batch ?? null, createdAt: now(), touched: now() }; store.save(); }
      return { status: r.status, body: { ...(r.data ?? {}), agent: c.name } };
    }
    return { status: 503, body: { error: "no host has a free reservation", lane: size }, retryAfter: cfg.retry_after_s ?? 60 };
  }

  async function forward(id, method, path) {
    const s = sbx()[id];
    const a = s && agents()[s.agent];
    if (!a) return { status: 404, body: { state: "gone" } };
    s.touched = now(); store.save();
    try {
      const r = await agentCall(a, method, path);
      if (method === "DELETE" && (r.ok || r.status === 404)) { delete sbx()[id]; store.save(); }
      return { status: r.status, body: r.data };
    } catch (e) { return { status: 502, body: { error: `agent ${s.agent} unreachable: ${e.message}` } }; }
  }

  /** Renew leases for sandboxes ForgeDock still polls; destroy the ones it abandoned. */
  async function tick() {
    for (const [k, c] of Object.entries(codes())) if (c.expires <= now()) delete codes()[k];
    for (const [id, s] of Object.entries(sbx())) {
      const a = agents()[s.agent];
      if (!a) { delete sbx()[id]; continue; }
      try {
        if (now() - s.touched > abandonMs) {
          const r = await agentCall(a, "DELETE", `/sandboxes/${encodeURIComponent(id)}`);
          if (r.ok || r.status === 404) { delete sbx()[id]; log.info?.(`abandoned ${id} destroyed on ${s.agent}`); }
        } else {
          const r = await agentCall(a, "POST", `/sandboxes/${encodeURIComponent(id)}/lease`);
          if (r.status === 404) { delete sbx()[id]; log.info?.(`${id} gone on ${s.agent}`); }
        }
      } catch (e) { log.warn?.(`lease ${id} on ${s.agent}: ${e.message}`); }
    }
    store.save();
  }

  function enroll(body) {
    if (!enrollOk(body?.token)) return { status: 401, body: { error: "bad enrollment token" } };
    const name = String(body.name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    let url;
    try { url = new URL(String(body.url)); } catch { return { status: 400, body: { error: "url required" } }; }
    if (!name) return { status: 400, body: { error: "name required" } };
    enrollOk(body.token, true);
    const token = randomBytes(32).toString("hex");
    agents()[name] = { url: url.origin, token, enrolledAt: new Date(now()).toISOString() };
    store.save();
    log.info?.(`enrolled agent ${name} at ${url.origin}`);
    return { status: 200, body: { name, agent_token: token } };
  }

  function bootstrapScript(token, url) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const int = (k) => { const v = Number(url?.searchParams.get(k)); return Number.isInteger(v) && v > 0 ? v : 0; };
    const sizing = `${int("cpus") ? ` -AllowCpus ${int("cpus")}` : ""}${int("mem") ? ` -AllowMemGb ${int("mem")}` : ""}`;
    return [
      "$ErrorActionPreference = 'Stop'",
      `$RouterUrl = ${q(cfg.public_url)}`,
      `$EnrollToken = ${q(token)}`,
      "$tmp = Join-Path $env:TEMP 'computeshare-install'",
      "Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue",
      "New-Item -ItemType Directory -Path $tmp | Out-Null",
      "Invoke-WebRequest -UseBasicParsing \"$RouterUrl/bootstrap/bundle.tar.gz?token=$EnrollToken\" -OutFile (Join-Path $tmp 'bundle.tar.gz')",
      "tar.exe -xzf (Join-Path $tmp 'bundle.tar.gz') -C $tmp",
      `& (Join-Path $tmp 'pool\\install\\install-agent.ps1') -RouterUrl $RouterUrl -EnrollToken $EnrollToken -BundlePath (Join-Path $tmp 'bundle.tar.gz')${sizing}`,
      "",
    ].join("\r\n");
  }

  /** Stream an allow-listed image (docker save) to an agent whose daemon cannot reach the registry itself. */
  async function sendImage(res, ref) {
    const allowed = cfg.agent_images ?? ["docker:27.5.1-dind"];
    if (!allowed.includes(ref)) return send(res, 404, { error: "image not offered" });
    try { await run("docker", ["image", "inspect", ref], { timeout: 20000 }); }
    catch { await run("docker", ["pull", "-q", ref], { timeout: 30 * 60000 }); }
    const save = spawn("docker", ["save", ref]);
    res.writeHead(200, { "content-type": "application/x-tar" });
    save.stdout.pipe(res);
    save.on("error", () => res.destroy());
  }

  function sendBundle(res) {
    const tar = spawn("tar", ["-czf", "-", "-C", cfg.repo_root, "package.json", "bin/pool", "pool"]);
    res.writeHead(200, { "content-type": "application/gzip" });
    tar.stdout.pipe(res);
    tar.on("error", () => res.destroy());
  }

  const fd = (fn) => ({ fn, auth: "forgedock" });
  const routes = [
    [route("GET", "/health"), { fn: async () => ({ status: 200, body: { ok: true, agents: Object.keys(agents()).length, sandboxes: Object.keys(sbx()).length } }), auth: "none" }],
    [route("POST", "/sandboxes"), fd(async (_p, body) => launch(body))],
    [route("GET", "/sandboxes/:id"), fd(async ({ id }) => forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}`))],
    [route("GET", "/sandboxes/:id/logs"), fd(async ({ id }, _b, url) => forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}/logs?cursor=${encodeURIComponent(url.searchParams.get("cursor") ?? "0")}`))],
    [route("GET", "/sandboxes/:id/result"), fd(async ({ id }) => forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}/result`))],
    [route("GET", "/sandboxes/:id/usage"), fd(async ({ id }) => forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}/usage`))],
    [route("DELETE", "/sandboxes/:id"), fd(async ({ id }) => forward(id, "DELETE", `/sandboxes/${encodeURIComponent(id)}`))],
    [route("GET", "/status"), fd(async () => ({ status: 200, body: await status() }))],
    [route("GET", "/agents"), fd(async () => ({ status: 200, body: { agents: await capacities(), sandboxes: sbx() } }))],
    [route("POST", "/codes"), fd(async () => ({ status: 200, body: issueCode() }))],
    [route("GET", "/agent/creds/github"), { fn: async () => ({ status: 200, body: { token: await githubToken() } }), auth: "agent" }],
    [route("GET", "/agent/creds/claude"), { fn: async () => ({ status: 200, body: claudeToken() }), auth: "agent" }],
    [route("GET", "/agent/bundle"), { fn: async () => ({ bundle: true }), auth: "agent" }],
    [route("GET", "/agent/images/:ref"), { fn: async ({ ref }) => ({ image: ref }), auth: "agent" }],
    [route("POST", "/agents/:name/upgrade"), fd(async ({ name }) => {
      const a = agents()[name];
      if (!a) return { status: 404, body: { error: "unknown agent" } };
      const r = await agentCall(a, "POST", "/admin/update", {});
      return { status: r.status, body: { ...(r.data ?? {}), target: versionOf(cfg.repo_root) } };
    })],
    [route("DELETE", "/agents/:name"), fd(async ({ name }) => {
      if (!agents()[name]) return { status: 404, body: { error: "unknown agent" } };
      for (const [id, x] of Object.entries(sbx())) if (x.agent === name) delete sbx()[id];
      delete agents()[name]; store.save();
      return { status: 200, body: { ok: true } };
    })],
    [route("POST", "/agents/:name/resize"), fd(async ({ name }, body) => {
      const a = agents()[name];
      if (!a) return { status: 404, body: { error: "unknown agent" } };
      const r = await agentCall(a, "POST", "/admin/resize", body ?? {});
      return { status: r.status, body: r.data };
    })],
    [route("GET", "/agents/:name/usage"), fd(async ({ name }) => {
      const a = agents()[name];
      if (!a) return { status: 404, body: { error: "unknown agent" } };
      const r = await agentCall(a, "GET", "/usage-history");
      return { status: r.status, body: r.data };
    })],
    [route("GET", "/version"), fd(async () => ({ status: 200, body: versionOf(cfg.repo_root) }))],
    [route("POST", "/enroll"), { fn: async (_p, body) => enroll(body), auth: "none" }],
    [route("GET", "/bootstrap/install.ps1"), { fn: async (_p, _b, url) => ({ status: 200, body: bootstrapScript(url.searchParams.get("token"), url) }), auth: "enroll" }],
    [route("GET", "/bootstrap/bundle.tar.gz"), { fn: async () => ({ bundle: true }), auth: "enroll" }],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, "http://router");
    if (!url.pathname.startsWith("/health")) log.info?.(`${req.socket.remoteAddress} ${req.method} ${url.pathname}`); // query (tokens) never logged
    try {
      for (const [match, r] of routes) {
        const p = match(req, url);
        if (!p) continue;
        if (r.auth === "forgedock" && !bearerOk(req, cfg.forgedock_token)) return send(res, 401, { error: "unauthorized" });
        if (r.auth === "agent" && !agentFor(req)) return send(res, 401, { error: "unauthorized" });
        if (r.auth === "enroll" && !enrollOk(url.searchParams.get("token"))) return send(res, 401, "unauthorized\n");
        const body = req.method === "POST" ? await readJson(req) : null;
        const out = await r.fn(p, body, url);
        if (out.bundle) return sendBundle(res);
        if (out.image) return sendImage(res, out.image);
        return send(res, out.status, out.body, out.retryAfter ? { "retry-after": String(out.retryAfter) } : {});
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      log.error?.(e);
      send(res, e.status ?? 500, { error: e.status ? e.message : "internal error" });
    }
  }

  return { handle, launch, tick, enroll, issueCode, capacities, status, store };
}

export function startRouter(cfg, deps) {
  const router = createRouter(cfg, deps);
  const server = createServer(router.handle);
  server.listen(cfg.listen.port, cfg.listen.host);
  const timer = setInterval(() => router.tick().catch((e) => console.error("tick failed", e)), (cfg.lease_interval_s ?? 60) * 1000);
  return { router, server, close: () => { clearInterval(timer); server.close(); } };
}

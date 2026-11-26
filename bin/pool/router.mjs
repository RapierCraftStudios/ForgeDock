// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { bearerOk, call, readJson, route, sameSecret, send } from "./http.mjs";
import { createCiEvents, MAX_WAIT_S } from "./ci-events.mjs";
import { createAutoscaler } from "./ci-autoscale.mjs";
import { jsonStore } from "./store.mjs";
import { versionOf } from "./version.mjs";

/**
 * What the router ships to pool agents (self-update and bootstrap). Every module the agent can load statically from
 * bin/pool/agent.mjs must live under these paths; bin/tests/pool-agent-bundle.test.mjs enforces it.
 */
export const AGENT_BUNDLE_PATHS = Object.freeze(["package.json", "bin/pool", "pool"]);

const run = promisify(execFile);

/** #5274: an agent destroy (docker rm, volume rm, wipe) outlasts the 15s call default; DELETE would 502 while the destroy still succeeded. */
const DESTROY_TIMEOUT_MS = 180000;

/**
 * Router: the endpoint ForgeDock's remote provider talks to (POST /sandboxes, GET /sandboxes/:id[/logs|/result|/usage],
 * DELETE /sandboxes/:id). It places each sandbox on the enrolled agent with the most free reserved CPU, forwards every
 * later call to that agent, renews the agent lease while ForgeDock keeps polling, and destroys sandboxes ForgeDock
 * has abandoned. It also serves the agent installer and enrollment.
 * Relay (#4778): an in-memory per-sandbox queue of read-only capability requests (agent `POST /agent/relay/:id`,
 * `GET /agent/relay/:id/:rid`) that the dispatching ForgeDock lists (`GET /sandboxes/:id/relay`) and answers
 * (`POST /sandboxes/:id/relay/:rid`). The router never runs or gates a command; a restart drops pending requests.
 */
export function createRouter(cfg, { fetchFn = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
  const store = jsonStore(join(cfg.state_dir, "router-state.json"), { agents: {}, sandboxes: {} });
  const agents = () => store.data.agents;
  const sbx = () => store.data.sandboxes;
  // #5688: CI runner events (POST by a `ci` token or the fd token, GET long-poll by the fd token); state in <state_dir>/ci-events/.
  const ciEvents = createCiEvents({ dir: join(cfg.state_dir, "ci-events"), now });
  const ciOk = (req) => bearerOk(req, cfg.forgedock_token) || (cfg.ci_tokens ?? []).some((t) => bearerOk(req, t));
  const ciQuery = (url) => {
    const repo = url.searchParams.get("repo"), sha = url.searchParams.get("sha"), pr = url.searchParams.get("pr");
    if (!repo || (!sha && !pr)) return { status: 400, body: { error: "repo and one of sha or pr are required" } };
    if (pr && !/^\d{1,9}$/.test(pr)) return { status: 400, body: { error: "pr must be an integer" } };
    const since = Number(url.searchParams.get("since") ?? 0), waitS = Number(url.searchParams.get("wait") ?? 0);
    if (!Number.isInteger(since) || since < 0 || !Number.isFinite(waitS) || waitS < 0 || waitS > MAX_WAIT_S) return { status: 400, body: { error: `since must be a non-negative integer and wait 0-${MAX_WAIT_S}` } };
    return { q: { repo, ...(sha ? { sha } : {}), ...(pr ? { pr: Number(pr) } : {}) }, since, waitS };
  };
  const lane = { cpus: cfg.lane?.cpus ?? 2, mem_gb: cfg.lane?.mem_gb ?? 3 };
  const abandonMs = (cfg.abandon_after_s ?? 1800) * 1000;
  const codes = () => (store.data.codes ??= {});
  // State maps are keyed by caller input (install codes, agent names, sandbox ids): read own keys only, so a key like
  // "__proto__" or "constructor" never resolves to an inherited member.
  const own = (map, key) => (typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined);
  const codeTtlMs = (cfg.code_ttl_s ?? 1800) * 1000;
  // #4778: relay queue, sandbox id -> {rid -> {argv, done?, rc, stdout, stderr}}; not persisted.
  const relayQ = new Map();
  const RELAY_MAX_PENDING = 8, RELAY_MAX_ARGS = 64, RELAY_MAX_BYTES = 16 * 1024;
  /** The caller agent's own sandbox (else null), so one agent never reads or queues for another's sandbox. */
  const ownedBy = (req, id) => { const s = own(sbx(), id), a = agentFor(req); return s && a && s.agent === a ? s : null; };
  function relayPost(req, { id }, body) {
    if (!ownedBy(req, id)) return { status: 404, body: { error: "unknown sandbox" } };
    const argv = body?.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) return { status: 400, body: { error: "argv must be a non-empty string list" } };
    if (argv.length > RELAY_MAX_ARGS || Buffer.byteLength(JSON.stringify(argv)) > RELAY_MAX_BYTES) return { status: 400, body: { error: "argv too large" } };
    const q = relayQ.get(id) ?? new Map();
    if ([...q.values()].filter((r) => !r.done).length >= RELAY_MAX_PENDING) return { status: 429, body: { error: "too many pending relay requests" }, retryAfter: 5 };
    const rid = randomBytes(12).toString("hex");
    q.set(rid, { argv });
    relayQ.set(id, q);
    return { status: 202, body: { rid } };
  }
  function relayPoll(req, { id, rid }) {
    if (!ownedBy(req, id)) return { status: 404, body: { error: "unknown sandbox" } };
    const q = relayQ.get(id), r = q?.get(rid);
    if (!r) return { status: 404, body: { error: "unknown relay request" } };
    if (!r.done) return { status: 200, body: { state: "pending" } };
    q.delete(rid);
    return { status: 200, body: { state: "done", rc: r.rc, stdout: r.stdout, stderr: r.stderr } };
  }
  function relayAnswer({ id, rid }, body) {
    const r = relayQ.get(id)?.get(rid);
    if (!r || r.done) return { status: 404, body: { error: "unknown relay request" } };
    Object.assign(r, { done: true, rc: Number.isInteger(body?.rc) ? body.rc : 1, stdout: String(body?.stdout ?? ""), stderr: String(body?.stderr ?? "") });
    return { status: 200, body: { ok: true } };
  }
  /** The long-lived enroll token, or an unexpired one-time install code (consumed by a successful enrollment). */
  function enrollOk(token, consume = false) {
    if (sameSecret(token, cfg.enroll_token)) return true;
    const c = own(codes(), token);
    if (!c || c.used || c.expires <= now()) return false;
    if (consume) { c.used = true; store.save(); }
    return true;
  }
  function issueCode(account) {
    const code = randomBytes(9).toString("base64url");
    codes()[code] = { expires: now() + codeTtlMs, used: false, ...(account ? { account } : {}) };
    store.save();
    return { code, expires_at: new Date(now() + codeTtlMs).toISOString() };
  }
  // #5886: device-code login. A box asks for a device+user code, the operator approves the user code (binding an account),
  // the box polls /device/token and receives a single-use enroll code that stamps that account on its agent record.
  const devices = () => (store.data.devices ??= {});
  const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
  const deviceTtlMs = (cfg.device_ttl_s ?? 600) * 1000, deviceIntervalS = cfg.device_interval_s ?? 5;
  let deviceBurst = { at: 0, n: 0 };
  function deviceStart() {
    if (now() - deviceBurst.at > 60000) deviceBurst = { at: now(), n: 0 };
    if (++deviceBurst.n > (cfg.device_codes_per_min ?? 20) || Object.keys(devices()).length >= 200) return { status: 429, body: { error: "too many device codes" }, retryAfter: 60 };
    const device_code = randomBytes(24).toString("base64url"), user_code = randomBytes(5).toString("hex").toUpperCase().replace(/^(.{4})/, "$1-");
    devices()[device_code] = { user_code, expires: now() + deviceTtlMs, interval: deviceIntervalS, polled: 0 };
    store.save();
    return { status: 200, body: { device_code, user_code, interval: deviceIntervalS, expires_in: Math.floor(deviceTtlMs / 1000) } };
  }
  function deviceApprove(body) {
    const code = String(body?.user_code ?? "").toUpperCase().trim(), account = String(body?.account ?? "default");
    if (!ACCOUNT_RE.test(account)) return { status: 400, body: { error: "account must be 1-64 chars of [A-Za-z0-9._@-]" } };
    const d = Object.values(devices()).find((x) => x.user_code === code && !x.account && x.expires > now());
    if (!d) return { status: 404, body: { error: "unknown, expired or already approved user code" } };
    d.account = account; store.save();
    return { status: 200, body: { ok: true, account } };
  }
  function deviceToken(body) {
    const d = own(devices(), body?.device_code);
    if (!d || d.expires <= now()) { if (d) { delete devices()[body.device_code]; store.save(); } return { status: 400, body: { error: "expired_token" } }; }
    if (d.polled && now() - d.polled < d.interval * 1000) { d.interval += 5; d.polled = now(); return { status: 400, body: { error: "slow_down", interval: d.interval } }; }
    d.polled = now();
    if (!d.account) return { status: 400, body: { error: "authorization_pending", interval: d.interval } };
    delete devices()[body.device_code];
    const { code } = issueCode(d.account);
    return { status: 200, body: { enroll_code: code, account: d.account } };
  }
  /** The enrolled agent whose token the request carries, or null. */
  function agentFor(req) {
    const m = /^Bearer\s+(\S.*)$/i.exec(req.headers.authorization ?? "");
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
  // Claude access token for sandboxes (#5165): among the logins with 30+ minutes left, the one with the lowest tokenbaton
  // usage (validity breaks ties). Only the short-lived access token is shared; refresh tokens stay here, so this host
  // keeps refreshing its own sessions.
  // #5205: the account last handed to each agent, and accounts a lane reported limited (n -> until ms), excluded until then.
  const handed = new Map(), limited = new Map(); // handed: agent -> accounts handed to it
  const MAX_LIMIT_MS = 7 * 86400000; // a reported reset is clamped to now+7d
  function claudeToken(req = null) {
    const dirs = cfg.claude_config_dirs ?? readdirSync(homedir()).filter((d) => /^\.claude(-\d+)?$/.test(d)).map((d) => join(homedir(), d));
    const logins = [];
    for (const d of dirs) {
      try {
        const o = JSON.parse(readFileSync(join(d, ".credentials.json"), "utf8")).claudeAiOauth;
        const n = /\.claude-(\d+)$/.exec(d)?.[1];
        if (o?.accessToken) logins.push({ n: n ? Number(n) : null, accessToken: o.accessToken, expiresAt: o.expiresAt });
      } catch { /* no login in this dir */ }
    }
    const src = usageSource(cfg);
    const usage = readUsage(src, logins.map((l) => l.n).filter((n) => n !== null));
    for (const [k, u] of limited) if (!(u > now())) limited.delete(k);
    const pick = pickClaudeLogin({ logins, usage, ceilingPct: cfg.usage_ceiling_pct ?? 95, now: now(), limited });
    if (pick.status === 503) throw Object.assign(new Error("no Claude login on the router host with 30+ minutes left"), { status: 503 });
    if (pick.status === 429) { log.warn?.(`claude login: every account at or above the usage ceiling; ${pick.body.reason}`); return pick; }
    if (pick.fallback) log.warn?.(`claude login: no usage source (${src}), falling back to longest validity`);
    const { login, pct } = pick;
    log.info?.(`claude login selected: account=${login.n ?? "default"} usage=${pct ?? "unknown"}%${pick.stale ? " (stale)" : ""} expires_at=${new Date(login.expiresAt).toISOString()}`);
    const agent = req ? agentFor(req) : null;
    if (agent && login.n !== null) handed.set(agent, (handed.get(agent) ?? new Set()).add(login.n));
    return { status: 200, body: { token: login.accessToken, expires_at: new Date(login.expiresAt).toISOString(), account: login.n ?? null } };
  }
  /** #5205: a sandbox on this agent hit a usage limit: the account it reports (one handed to this agent) is excluded until reset_at (default now+1h, at most now+7d). */
  function claudeLimited(req, body) {
    const agent = agentFor(req), n = body?.account;
    if (!Number.isInteger(n)) return { status: 400, body: { error: "account required (the number from the credential response)" } };
    if (!agent || !handed.get(agent)?.has(n)) return { status: 404, body: { error: "that claude account was not handed to this agent" } };
    const t = Date.parse(String(body?.reset_at ?? "")), e = Number(body?.reset_at);
    const at = body?.reset_at !== null && body?.reset_at !== "" && Number.isFinite(e) ? e * 1000 : t; // epoch s, or an ISO time
    const until = Number.isFinite(at) && at > now() ? Math.min(at, now() + MAX_LIMIT_MS) : now() + 3600000;
    limited.set(n, Math.max(until, limited.get(n) ?? 0));
    log.info?.(`claude login limited: account=${n} agent=${agent} until=${new Date(until).toISOString()}`);
    return { status: 200, body: { account: n, until: new Date(until).toISOString() } };
  }
  // #5882: outbound-only agents (no url) dial the router: GET /agent/poll long-polls for the next queued request (the poll is also
  // the heartbeat) and POST /agent/reply/:rid answers it. In memory only: a router restart drops queued requests, like relayQ.
  const pollSt = new Map(), pollReplies = new Map(); // agent -> {q, waiter, seen}; rid -> {agent, done}
  const POLL_MAX_WAIT_S = 55, pollOfflineMs = (cfg.poll_offline_s ?? 60) * 1000;
  const pollState = (name) => { let st = pollSt.get(name); if (!st) pollSt.set(name, st = { q: [], waiter: null, seen: 0 }); return st; };
  const pollOnline = (name) => { const st = pollSt.get(name); return Boolean(st && (st.waiter || now() - st.seen <= pollOfflineMs)); };
  function pollCall(a, method, path, body, timeoutMs = 15000) {
    if (!pollOnline(a.name)) return Promise.reject(new Error("agent offline (no recent poll)"));
    return new Promise((resolve, reject) => {
      const st = pollState(a.name), rid = randomBytes(12).toString("hex");
      const timer = setTimeout(() => { pollReplies.delete(rid); st.q = st.q.filter((x) => x.rid !== rid); reject(new Error("agent did not answer in time")); }, timeoutMs);
      pollReplies.set(rid, { agent: a.name, done: (r) => { clearTimeout(timer); resolve(r); } });
      st.q.push({ rid, method, path, ...(body !== undefined ? { body } : {}) });
      st.waiter?.();
    });
  }
  async function agentPoll(req, url) {
    const name = agentFor(req), st = pollState(name);
    const w = Number(url.searchParams.get("wait") ?? 25), waitS = Number.isFinite(w) ? Math.min(Math.max(w, 0), POLL_MAX_WAIT_S) : 25;
    st.waiter?.(); // a newer poll from the same agent supersedes the older one
    st.seen = now();
    if (!st.q.length && waitS > 0) await new Promise((res) => {
      let t = null;
      const done = () => { clearTimeout(t); if (st.waiter === done) st.waiter = null; res(); };
      t = setTimeout(done, waitS * 1000);
      st.waiter = done;
    });
    st.seen = now();
    const item = st.q.shift();
    return item ? { status: 200, body: item } : { status: 204 };
  }
  function agentReply(req, { rid }, body) {
    const r = pollReplies.get(rid);
    if (!r || r.agent !== agentFor(req)) return { status: 404, body: { error: "unknown request" } };
    pollReplies.delete(rid);
    const status = Number.isInteger(body?.status) ? body.status : 502;
    r.done({ status, ok: status >= 200 && status < 300, data: body?.data ?? null, retryAfter: body?.retry_after ?? null });
    return { status: 200, body: { ok: true } };
  }
  const agentCall = (a, method, path, body, timeoutMs) => a.transport === "poll"
    ? pollCall(a, method, path, body, timeoutMs)
    : call(a.url, method, path, { body, token: a.token, timeoutMs, fetchFn });
  // #5695: CI runner autoscaler (off unless cfg.ci_autoscale.enabled); webhook demand in, reconcile on the tick.
  let autoscaler = null;
  const autoscale = () => (autoscaler ??= createAutoscaler({ cfg, now, log, capacities: () => capacities(), agentCall, githubToken, fetchFn, agents }));

  /** #5891: host drive figures per agent, plus a warning when the projected time until the drive is full is under disk_warn_hours (2). */
  const diskWarned = new Map();
  function diskReport(c) {
    if (!Number.isFinite(c.host_disk_free_gb)) return {};
    const out = { host_disk_free_gb: c.host_disk_free_gb, ...(Number.isFinite(c.host_disk_growth_gb_per_h) ? { host_disk_growth_gb_per_h: c.host_disk_growth_gb_per_h } : {}) };
    const limit = cfg.disk_warn_hours ?? 2;
    if (Number.isFinite(c.host_disk_full_in_h) && c.host_disk_full_in_h < limit) {
      out.disk_warning = `host drive full in ~${c.host_disk_full_in_h} h at ${c.host_disk_growth_gb_per_h} GB/h (${c.host_disk_free_gb} GB free)`;
      if (now() - (diskWarned.get(c.name) ?? -Infinity) > 600000) { diskWarned.set(c.name, now()); log.warn?.(`${c.name}: ${out.disk_warning}`); }
    }
    return out;
  }
  /** #5967: host free memory and the other-VM (vmmem) working sets per agent. */
  const memReport = (c) => Number.isFinite(c.host_mem_free_gb) ? { host_mem_free_gb: c.host_mem_free_gb, ...(Array.isArray(c.vmmem) && c.vmmem.length ? { vmmem: c.vmmem } : {}), ...(c.host_mem_low === true ? { host_mem_low: true } : {}) } : {};
  async function capacities() {
    const out = [];
    for (const [name, a] of Object.entries(agents())) {
      try {
        const r = await agentCall(a, "GET", "/capacity", undefined, 5000);
        out.push(r.ok ? { name, ok: true, ...(a.transport ? { transport: a.transport } : {}), ...r.data } : { name, ok: false, error: `HTTP ${r.status}` });
      } catch (e) { out.push({ name, ok: false, ...(a.transport ? { transport: a.transport } : {}), error: String(e.message ?? e) }); }
    }
    return out;
  }

  /** Agent liveness for the scheduler (#4547): an agent is online when it answers and is not paused. */
  async function status(repo) {
    const caps = (await capacities()).filter((c) => placeable(c, repo ? { repo: { slug: repo } } : null));
    const agentsView = caps.map((c) => ({ name: c.name, ok: c.ok, paused: Boolean(c.paused), transport: c.transport ?? "direct", ...diskReport(c), ...memReport(c) }));
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

  // #5735: per-agent lane ceiling across all batches. A lane sandbox is one whose id starts with `fdrsbx-`; other tenants'
  // sandboxes are never counted or refused. Ceiling: the agent state entry's `max_lanes` (`pool limit`), else router.json
  // `agents.<name>.max_lanes`; no valid value = no ceiling. In-flight launches reserve their slot synchronously before the
  // awaited agent call, so concurrent launches cannot overshoot.
  const isLane = (id) => typeof id === "string" && id.startsWith("fdrsbx-");
  const validCeiling = (v) => Number.isInteger(v) && v >= 0;
  function ceilingOf(name) {
    const st = own(agents(), name)?.max_lanes;
    if (validCeiling(st)) return st;
    const c = cfg.agents && Object.hasOwn(cfg.agents, name) ? cfg.agents[name]?.max_lanes : undefined;
    return validCeiling(c) ? c : null;
  }
  const pending = new Map(); // agent -> Set of lane ids reserved by an in-flight launch or claim
  const lanesOn = (name) => {
    const ids = new Set(pending.get(name) ?? []);
    for (const [id, s] of Object.entries(sbx())) if (s?.agent === name && isLane(id)) ids.add(id);
    return ids.size;
  };
  const atCeiling = (name) => { const c = ceilingOf(name); return c !== null && lanesOn(name) >= c; };
  const reserve = (name, id) => { if (!pending.has(name)) pending.set(name, new Set()); pending.get(name).add(id); };
  const release = (name, id) => { const s = pending.get(name); s?.delete(id); if (s && !s.size) pending.delete(name); };
  const laneView = (name) => ({ used: lanesOn(name), ceiling: ceilingOf(name) });
  function setLimit(name, body) {
    const a = own(agents(), name);
    if (!a) return { status: 404, body: { error: "unknown agent" } };
    const v = body?.max_lanes;
    if (v !== null && !validCeiling(v)) return { status: 400, body: { error: "max_lanes must be a non-negative integer or null" } };
    if (v === null) delete a.max_lanes; else a.max_lanes = v;
    store.save();
    log.info?.(`agent ${name} max_lanes ${v === null ? "none" : v}`);
    return { status: 200, body: { name, max_lanes: v, lanes: laneView(name) } };
  }

  /** #5053: an agent's 401 reaches the dispatcher through this router; tag it so it is not mistaken for a router auth failure. */
  const agentBody = (r, name) => (r.status === 401 ? { ...(r.data && typeof r.data === "object" ? r.data : {}), error: "unauthorized", hop: "agent", agent: name, reason: typeof r.data?.reason === "string" ? r.data.reason : "agent auth: router token rejected by agent" } : r.data ?? {});
  // #5856: placement by priority. Agents that report no reservations/borrowable fields are flat (cpus_free), as before.
  // reserved: a host holding that reservation with room left (the agent reclaims from borrowed lanes itself);
  // normal: unreserved headroom; borrow: any physical headroom, preferring hosts with free non-reserved capacity.
  const fitsPriority = (c, spec, size) => {
    const prio = spec?.priority;
    if (prio === "reserved" && Array.isArray(c.reservations)) {
      const r = c.reservations.find((x) => x.name === spec.reservation) ?? (spec.reservation ? null : c.reservations.length === 1 ? c.reservations[0] : null);
      return Boolean(r) && r.cpus_free >= size.cpus && r.mem_free_gb >= size.mem_gb;
    }
    const cpusFree = prio === "normal" && Number.isFinite(c.cpus_free_unreserved) ? c.cpus_free_unreserved : c.cpus_free;
    const memFree = prio === "normal" && Number.isFinite(c.mem_free_unreserved_gb) ? c.mem_free_unreserved_gb : c.mem_free_gb;
    return cpusFree >= size.cpus && memFree >= size.mem_gb;
  };
  const headroom = (c, spec) => (spec?.priority === "borrow" && Number.isFinite(c.cpus_free_unreserved) ? c.cpus_free_unreserved : 0);
  // #5949: the dispatcher seeds a repo mirror before launch. The agent that will own the sandbox is picked here (the placing agent
  // when it is known, else the best-fitting one) and remembered, so launch() prefers it and the seeded mirror is the one the lane uses.
  const seedPick = new Map(); // sandbox id -> {agent, at}
  const SEED_CHUNK_B64_MAX = 768 * 1024;
  async function seedAgent(id, slug) {
    const known = own(sbx(), id);
    if (known && own(agents(), known.agent)) return known.agent;
    const hit = seedPick.get(id);
    if (hit && own(agents(), hit.agent) && now() - hit.at < 30 * 60000) return hit.agent;
    for (const [k, v] of seedPick) if (now() - v.at >= 30 * 60000) seedPick.delete(k);
    const spec = slug ? { repo: { slug } } : null; // the repo is known from the seed request when it names one
    const fits = (await capacities()).filter((c) => c.ok && !c.paused && placeable(c, spec) && c.host_disk_low !== true && c.disk_capped !== true).sort((a, b) => b.cpus_free - a.cpus_free || b.mem_free_gb - a.mem_free_gb);
    if (!fits.length) return null;
    seedPick.set(id, { agent: fits[0].name, at: now() });
    return fits[0].name;
  }
  async function seedForward(id, method, path, body, slug) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return { status: 400, body: { error: "bad sandbox id" } };
    if (typeof body?.data_b64 === "string" && body.data_b64.length > SEED_CHUNK_B64_MAX) return { status: 413, body: { error: "chunk too large" } };
    const name = await seedAgent(id, typeof slug === "string" ? slug : undefined), a = name && own(agents(), name);
    if (!a) return { status: 503, body: { error: "no agent available to seed" }, retryAfter: cfg.retry_after_s ?? 60 };
    try { const r = await agentCall(a, method, path, body, 120000); return { status: r.status, body: agentBody(r, name) }; }
    catch (e) { return { status: 502, body: { error: `agent ${name} unreachable: ${e.message}` } }; }
  }
  /** #5886: a spec naming an account is placed only on that account's agents; without one, any enrolled agent (as before). */
  const inAccount = (c, spec) => typeof spec?.account !== "string" || own(agents(), c.name)?.account === spec.account;
  /** #6041: per-repo placement. `repos.<slug>.agents` (honoured only when a non-empty string array) is an allowlist; `exclude_agents` subtracts from it. Unset = any agent, as before. */
  const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const placeable = (c, spec) => {
    if (!inAccount(c, spec)) return false;
    const rc = repoCfg(spec), allow = names(rc.agents);
    return (!allow.length || allow.includes(c.name)) && !names(rc.exclude_agents).includes(c.name);
  };
  async function launch(spec) {
    if (typeof spec?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.id)) return { status: 400, body: { error: "spec.id required ([A-Za-z0-9._-], max 128)" } };
    const known = own(sbx(), spec.id);
    if (known && own(agents(), known.agent)) {
      known.touched = now(); store.save();
      const r = await agentCall(own(agents(), known.agent), "POST", "/sandboxes", { spec: withForgeYaml(spec), ...sizeFor(spec) });
      // #5856: a drained borrow lane whose host is now full (reserved work took it) is placed on another host, not refused.
      if (!(r.status === 503 && spec.priority === "borrow")) return { status: r.status, body: agentBody(r, known.agent), retryAfter: r.retryAfter };
      delete sbx()[spec.id]; store.save();
    }
    const size = sizeFor(spec);
    const sized = (await capacities()).filter((c) => c.ok && !c.paused && placeable(c, spec) && fitsPriority(c, spec, size));
    const diskLow = sized.filter((c) => c.host_disk_low === true).map((c) => c.name); // #5733: never POST to a host whose drive is short
    const capped = sized.filter((c) => c.disk_capped === true && c.host_disk_low !== true).map((c) => c.name); // #5884: lane disk at its hard cap
    const memLow = sized.filter((c) => c.host_mem_low === true && c.host_disk_low !== true && c.disk_capped !== true).map((c) => c.name); // #5967: host memory under the floor
    const fits = sized.filter((c) => c.host_disk_low !== true && c.disk_capped !== true && c.host_mem_low !== true).sort((a, b) => headroom(b, spec) - headroom(a, spec) || b.cpus_free - a.cpus_free || b.mem_free_gb - a.mem_free_gb);
    const laneId = isLane(spec.id), laneCapped = []; // #5735: agents skipped because their lane ceiling is reached
    let busy = null; // the last agent 503 (e.g. lane_tools image building): its body and Retry-After are passed back
    const seeded = seedPick.get(spec.id)?.agent; // #5949: the agent holding this lane's seeded mirror goes first
    if (seeded) fits.sort((a, b) => (b.name === seeded) - (a.name === seeded));
    for (const c of fits) {
      if (laneId && atCeiling(c.name)) { laneCapped.push({ name: c.name, ...laneView(c.name) }); continue; }
      if (laneId) reserve(c.name, spec.id);
      try {
        const r = await agentCall(own(agents(), c.name), "POST", "/sandboxes", { spec: withForgeYaml(spec), ...size }, 120000);
        if (r.status === 503) { busy = { r, name: c.name }; continue; } // raced with another launch, or still building; try the next host
        if (r.ok) { sbx()[spec.id] = { agent: c.name, issue: spec.issue ?? null, batch: spec.batch ?? null, createdAt: now(), touched: now() }; store.save(); }
        return { status: r.status, body: { ...agentBody(r, c.name), agent: c.name } };
      } finally { if (laneId) release(c.name, spec.id); }
    }
    if (laneCapped.length && !busy) return { status: 503, body: { error: "pool.host_lane_ceiling", code: "pool.host_lane_ceiling", agents: laneCapped }, retryAfter: cfg.retry_after_s ?? 60 };
    if (busy) return { status: 503, body: { ...agentBody(busy.r, busy.name), agent: busy.name }, retryAfter: busy.r.retryAfter ?? cfg.retry_after_s ?? 60 };
    if (diskLow.length) return { status: 503, body: { error: "no host has free disk", code: "pool.disk_low", agents: diskLow }, retryAfter: cfg.disk_low_retry_after_s ?? 300 }; // a capacity deferral, not a failure
    if (capped.length) return { status: 503, body: { error: "no host has lane disk below its cap", code: "pool.disk_cap", agents: capped }, retryAfter: cfg.disk_low_retry_after_s ?? 300 };
    if (memLow.length) return { status: 503, body: { error: "no host has free memory", code: "pool.host_mem", reason: "host_mem", agents: memLow }, retryAfter: cfg.host_mem_retry_after_s ?? 60 }; // a capacity deferral, not a failure
    return { status: 503, body: { error: "no host has a free reservation", lane: size }, retryAfter: cfg.retry_after_s ?? 60 };
  }

  /** #4912: hand the lane to an agent's ready warm sandbox; 404 when no agent has one (the caller then launches cold). */
  async function claim(spec) {
    if (typeof spec?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.id)) return { status: 400, body: { error: "spec.id required ([A-Za-z0-9._-], max 128)" } };
    if (own(sbx(), spec.id)) return launch(spec); // already placed: the same idempotent path
    const size = sizeFor(spec);
    const laneId = isLane(spec.id);
    for (const c of (await capacities()).filter((x) => x.ok && !x.paused && placeable(x, spec))) {
      if (laneId && atCeiling(c.name)) continue; // #5735: the 404 makes the caller cold-launch, which gets the ceiling 503
      if (laneId) reserve(c.name, spec.id);
      try {
        const r = await agentCall(own(agents(), c.name), "POST", "/warm/claim", { spec: withForgeYaml(spec), ...size }, 30000);
        if (!r.ok) continue;
        sbx()[spec.id] = { agent: c.name, issue: spec.issue ?? null, batch: spec.batch ?? null, createdAt: now(), touched: now() };
        store.save();
        return { status: 200, body: { ...(r.data ?? {}), agent: c.name } };
      } finally { if (laneId) release(c.name, spec.id); }
    }
    return { status: 404, body: { error: "no warm sandbox ready" } };
  }

  async function forward(id, method, path, timeoutMs) {
    const s = own(sbx(), id);
    const a = s && own(agents(), s.agent);
    if (!a) return { status: 404, body: { state: "gone" } };
    s.touched = now(); store.save();
    try {
      const r = await agentCall(a, method, path, undefined, timeoutMs);
      if (method === "DELETE" && (r.ok || r.status === 404)) { delete sbx()[id]; relayQ.delete(id); store.save(); }
      return { status: r.status, body: agentBody(r, s.agent) };
    } catch (e) { return { status: 502, body: { error: `agent ${s.agent} unreachable: ${e.message}` } }; }
  }

  /** Renew leases for sandboxes ForgeDock still polls; destroy the ones it abandoned. */
  async function tick() {
    for (const [k, c] of Object.entries(codes())) if (c.expires <= now()) delete codes()[k];
    for (const [k, d] of Object.entries(devices())) if (d.expires <= now()) delete devices()[k];
    for (const [name, a] of Object.entries(agents())) if (a.policy_pending) await pushPolicy(name); // #5886: re-push a policy the box missed
    for (const [id, s] of Object.entries(sbx())) {
      const a = own(agents(), s.agent);
      if (!a) { delete sbx()[id]; continue; }
      try {
        if (now() - s.touched > abandonMs) {
          const r = await agentCall(a, "DELETE", `/sandboxes/${encodeURIComponent(id)}`, undefined, DESTROY_TIMEOUT_MS);
          if (r.ok || r.status === 404) { delete sbx()[id]; relayQ.delete(id); log.info?.(`abandoned ${id} destroyed on ${s.agent}`); }
        } else {
          const r = await agentCall(a, "POST", `/sandboxes/${encodeURIComponent(id)}/lease`);
          if (r.status === 404) { delete sbx()[id]; relayQ.delete(id); log.info?.(`${id} gone on ${s.agent}`); }
        }
      } catch (e) { log.warn?.(`lease ${id} on ${s.agent}: ${e.message}`); }
    }
    store.save();
    if (cfg.ci_autoscale?.enabled) await autoscale().reconcile().catch((e) => log.warn?.(`ci-autoscale reconcile: ${e.message}`));
  }

  function enroll(body) {
    if (!enrollOk(body?.token)) return { status: 401, body: { error: "bad enrollment token", hop: "router", reason: "router auth: bad enrollment token" } };
    const name = String(body.name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    // #5882: no url means an outbound-only agent that polls this router (no inbound port on its host).
    let url = null;
    if (body.url) { try { url = new URL(String(body.url)); } catch { return { status: 400, body: { error: "url must be a valid URL (or omitted for an outbound agent)" } }; } }
    if (!name) return { status: 400, body: { error: "name required" } };
    const account = own(codes(), body.token)?.account; // #5886: a device-login code carries its account
    enrollOk(body.token, true);
    const token = randomBytes(32).toString("hex");
    const keep = own(agents(), name)?.max_lanes; // #5735: re-enrollment keeps a `pool limit` ceiling
    const keepCfg = validCeiling(keep) ? { max_lanes: keep } : {};
    agents()[name] = { ...(url ? { url: url.origin, token, enrolledAt: new Date(now()).toISOString(), ...keepCfg } : { name, transport: "poll", token, enrolledAt: new Date(now()).toISOString(), ...keepCfg }), ...(account ? { account } : {}) };
    store.save();
    log.info?.(`enrolled agent ${name} ${url ? `at ${url.origin}` : "(outbound poll)"}`);
    return { status: 200, body: { name, agent_token: token } };
  }

  /** #5886: per-box policy, allowlisted keys only; pushed to the agent's /admin/policy (the agent keeps its owner pause). */
  function validPolicy(b) {
    if (!b || typeof b !== "object" || Array.isArray(b)) return "policy must be an object";
    const bad = Object.keys(b).filter((k) => !["cpus", "mem_gb", "idle_only", "paused", "floors"].includes(k));
    if (bad.length) return `unknown policy key: ${bad[0]}`;
    const int = (v, hi) => Number.isInteger(v) && v >= 1 && v <= hi;
    if ("cpus" in b && !int(b.cpus, 256)) return "cpus must be an integer 1-256";
    if ("mem_gb" in b && !int(b.mem_gb, 1024)) return "mem_gb must be an integer 1-1024";
    if (("idle_only" in b && typeof b.idle_only !== "boolean") || ("paused" in b && typeof b.paused !== "boolean")) return "idle_only and paused must be booleans";
    if ("floors" in b && !(b.floors && typeof b.floors === "object" && Object.keys(b.floors).every((k) => k === "host_disk_gb" && Number.isFinite(b.floors[k]) && b.floors[k] >= 0))) return "floors accepts only host_disk_gb >= 0";
    return null;
  }
  async function pushPolicy(name) {
    const a = own(agents(), name);
    try {
      const r = await agentCall(a, "POST", "/admin/policy", a.policy);
      if (r.ok) { delete a.policy_pending; store.save(); }
      return r.ok;
    } catch { return false; }
  }
  async function setPolicy(name, body) {
    const a = own(agents(), name);
    if (!a) return { status: 404, body: { error: "unknown agent" } };
    const err = validPolicy(body);
    if (err) return { status: 400, body: { error: err } };
    a.policy = { ...(a.policy ?? {}), ...body, ...(body.floors ? { floors: { ...(a.policy?.floors ?? {}), ...body.floors } } : {}) };
    a.policy_pending = true; store.save();
    const pushed = await pushPolicy(name);
    return { status: pushed ? 200 : 202, body: { ok: true, policy: a.policy, pushed } };
  }

  function bootstrapScript(token, url) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const int = (k) => { const v = Number(url?.searchParams.get(k)); return Number.isInteger(v) && v > 0 ? v : 0; };
    const sizing = `${int("cpus") ? ` -AllowCpus ${int("cpus")}` : ""}${int("mem") ? ` -AllowMemGb ${int("mem")}` : ""}`;
    const net = ["nat", "mirrored"].includes(url?.searchParams.get("net")) ? ` -Networking ${url.searchParams.get("net")}` : "";
    return [
      "$ErrorActionPreference = 'Stop'",
      `$RouterUrl = ${q(cfg.public_url)}`,
      `$EnrollToken = ${q(token)}`,
      "$tmp = Join-Path $env:TEMP 'computeshare-install'",
      "Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue",
      "New-Item -ItemType Directory -Path $tmp | Out-Null",
      "Invoke-WebRequest -UseBasicParsing \"$RouterUrl/bootstrap/bundle.tar.gz?token=$EnrollToken\" -OutFile (Join-Path $tmp 'bundle.tar.gz')",
      "tar.exe -xzf (Join-Path $tmp 'bundle.tar.gz') -C $tmp",
      `& (Join-Path $tmp 'pool\\install\\install-agent.ps1') -RouterUrl $RouterUrl -EnrollToken $EnrollToken -BundlePath (Join-Path $tmp 'bundle.tar.gz')${sizing}${net}`,
      "",
    ].join("\r\n");
  }

  /**
   * #5883: the POSIX sh one-command installer served at GET /install (no auth: it holds no secret, only this router's URL).
   * The one-time code arrives as `--code` and is checked only by /bootstrap/bundle.tar.gz and consumed by /enroll.
   */
  function installScript() {
    const q = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;
    return `#!/bin/sh
# computeshare agent one-command installer for Linux (systemd) and macOS (launchd), served by the router (#5883).
# Install:   curl -fsSL ${q(`${cfg.public_url}/install`)} | sudo sh -s -- --code CODE [--name N] [--cpus N] [--mem GB]
# Uninstall: curl -fsSL ${q(`${cfg.public_url}/install`)} | sudo sh -s -- --uninstall
# Rerunning is safe: an enrolled host reuses its installed code and agent token (no download, no re-enrollment).
set -eu
ROUTER=${q(cfg.public_url)}
CODE=""; NAME=""; CPUS=""; MEM=""; UNINSTALL=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="\${2:?--code needs a value}"; shift 2 ;;
    --name) NAME="\${2:?--name needs a value}"; shift 2 ;;
    --cpus) CPUS="\${2:?--cpus needs a value}"; shift 2 ;;
    --mem) MEM="\${2:?--mem needs a value}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$(uname -s)" in
  Linux) OS=linux; ROOT=/opt/computeshare; TOKEN_FILE=/etc/computeshare/agent.token ;;
  Darwin) OS=macos; ROOT=/usr/local/computeshare; TOKEN_FILE=/usr/local/etc/computeshare/agent.token ;;
  *) echo "unsupported OS $(uname -s): Linux or macOS only (Windows: forgedock pool enroll prints a PowerShell command)" >&2; exit 1 ;;
esac
if [ "$UNINSTALL" = 1 ]; then ACTION=uninstall; elif [ -s "$TOKEN_FILE" ] && [ -f "$ROOT/pool/install/install-agent-$OS.sh" ]; then ACTION=reinstall; else ACTION=install; fi
if [ "$DRY" = 1 ]; then
  echo "os=$OS action=$ACTION router=$ROUTER root=$ROOT name=\${NAME:-<hostname>} cpus=\${CPUS:-<auto>} mem_gb=\${MEM:-<auto>} code=\${CODE:+<redacted>}"
  exit 0
fi
[ "$(id -u)" = 0 ] || { echo "run as root: curl -fsSL '$ROUTER/install' | sudo sh -s -- ..." >&2; exit 1; }
command -v bash >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 || { echo "needs bash, curl and tar" >&2; exit 1; }
TMP=""
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT
fetch_bundle() {
  TMP="$(mktemp -d "\${TMPDIR:-/tmp}/computeshare-install.XXXXXX")"
  curl -fsS "$ROUTER/bootstrap/bundle.tar.gz?token=$CODE" -o "$TMP/bundle.tar.gz" || { echo "bundle download refused: the code is wrong, used or expired (forgedock pool enroll --outbound prints a new one)" >&2; exit 1; }
  tar -xzf "$TMP/bundle.tar.gz" -C "$TMP"
}
if [ "$ACTION" = uninstall ]; then
  if [ -f "$ROOT/pool/install/uninstall-agent-$OS.sh" ]; then bash "$ROOT/pool/install/uninstall-agent-$OS.sh"; exit $?; fi
  if [ -z "$CODE" ]; then echo "[computeshare] $ROOT is not installed here; nothing to uninstall (pass --code to run the full cleanup from a fresh bundle)"; exit 0; fi
  fetch_bundle
  bash "$TMP/pool/install/uninstall-agent-$OS.sh"
  exit $?
fi
set -- --router "$ROUTER" --outbound
if [ -n "$NAME" ]; then set -- "$@" --name "$NAME"; fi
if [ -n "$CPUS" ]; then set -- "$@" --cpus "$CPUS"; fi
if [ -n "$MEM" ]; then set -- "$@" --mem "$MEM"; fi
if [ "$ACTION" = reinstall ]; then
  echo "[computeshare] already enrolled: reusing $ROOT and its agent token (no bundle download, no re-enrollment)"
  bash "$ROOT/pool/install/install-agent-$OS.sh" "$@" --token "\${CODE:-enrolled}"
  exit $?
fi
[ -n "$CODE" ] || { echo "--code CODE required (forgedock pool enroll --outbound prints the command)" >&2; exit 2; }
fetch_bundle
bash "$TMP/pool/install/install-agent-$OS.sh" "$@" --token "$CODE" --bundle "$TMP/bundle.tar.gz"
`;
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
    const tar = spawn("tar", ["-czf", "-", "-C", cfg.repo_root, ...AGENT_BUNDLE_PATHS]);
    res.writeHead(200, { "content-type": "application/gzip" });
    tar.stdout.pipe(res);
    tar.on("error", () => res.destroy());
  }

  const fd = (fn) => ({ fn, auth: "forgedock" });
  const routes = [
    [route("GET", "/health"), { fn: async () => ({ status: 200, body: { ok: true, agents: Object.keys(agents()).length, sandboxes: Object.keys(sbx()).length } }), auth: "none" }],
    [route("POST", "/sandboxes"), fd(async (_p, body) => launch(body))],
    [route("POST", "/sandboxes/claim"), fd(async (_p, body) => claim(body))],
    [route("GET", "/sandboxes/:id/mirrors"), fd(async ({ id }, _b, url) => seedForward(id, "GET", `/mirrors?${new URLSearchParams([...url.searchParams].filter(([k]) => ["slug", "cache_key", "upload"].includes(k)))}`, undefined, url.searchParams.get("slug")))], // #5949
    [route("POST", "/sandboxes/:id/seed"), fd(async ({ id }, body) => seedForward(id, "POST", "/mirrors/seed", body, body?.slug))],
    [route("GET", "/sandboxes/:id"), fd(async ({ id }) => forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}`))],
    [route("GET", "/sandboxes/:id/logs"), fd(async ({ id }, _b, url) => forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}/logs?cursor=${encodeURIComponent(url.searchParams.get("cursor") ?? "0")}`))],
    [route("GET", "/sandboxes/:id/result"), fd(async ({ id }) => forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}/result`))],
    [route("GET", "/sandboxes/:id/usage"), fd(async ({ id }) => { // #4549: the placing agent rides along for per-agent minutes
      const agent = own(sbx(), id)?.agent, r = await forward(id, "GET", `/sandboxes/${encodeURIComponent(id)}/usage`);
      return agent && r.status === 200 && r.body && typeof r.body === "object" ? { ...r, body: { ...r.body, agent } } : r;
    })],
    [route("GET", "/sandboxes/:id/relay"), fd(async ({ id }) => ({ status: 200, body: { requests: [...(relayQ.get(id) ?? new Map())].filter(([, r]) => !r.done).map(([rid, r]) => ({ rid, argv: r.argv })) } }))],
    [route("POST", "/sandboxes/:id/relay/:rid"), fd(async (p, body) => relayAnswer(p, body))],
    [route("POST", "/sandboxes/:id/stop"), fd(async ({ id }) => forward(id, "POST", `/sandboxes/${encodeURIComponent(id)}/stop`))], // #5274
    [route("DELETE", "/sandboxes/:id"), fd(async ({ id }) => forward(id, "DELETE", `/sandboxes/${encodeURIComponent(id)}`, DESTROY_TIMEOUT_MS))],
    [route("GET", "/status"), fd(async (_p, _b, url) => ({ status: 200, body: await status(url.searchParams.get("repo") ?? undefined) }))],
    [route("GET", "/agents"), fd(async (_p, _b, url) => { // #5535: each sandbox carries disk_used_mb from its agent's sandbox_disk_mb when the agent reports it
      const acct = url.searchParams.get("account"); // #5886: ?account= is the per-account view; `account` and `policy` ride on enrolled records that have them
      const repo = url.searchParams.get("repo"), view = repo ? { repo: { slug: repo } } : null; // #6041: ?repo= is the per-repo view (allowlist and exclude list)
      const caps = (await capacities()).filter((c) => (acct === null || own(agents(), c.name)?.account === acct) && placeable(c, view)).map((c) => { const a = own(agents(), c.name); return { ...c, ...(a?.account ? { account: a.account } : {}), ...(a?.policy ? { policy: a.policy } : {}) }; }), byName = new Map(caps.map((c) => [c.name, c])), out = {};
      for (const [id, s] of Object.entries(sbx())) { if ((acct !== null || repo) && !byName.has(s?.agent)) continue; const mb = byName.get(s?.agent)?.sandbox_disk_mb?.[id]; out[id] = Number.isFinite(mb) ? { ...s, disk_used_mb: mb } : s; }
      const remote_lanes = Object.keys(sbx()).filter(isLane).length; // #5735: lane sandboxes across all batches and agents
      return { status: 200, body: { agents: caps.map((c) => ({ ...c, lanes: laneView(c.name), ...diskReport(c) })), sandboxes: out, remote_lanes } };
    })],
    [route("POST", "/device/code"), { fn: async () => deviceStart(), auth: "none" }], // #5886
    [route("POST", "/device/token"), { fn: async (_p, body) => deviceToken(body), auth: "none" }],
    [route("POST", "/device/approve"), fd(async (_p, body) => deviceApprove(body))],
    [route("PUT", "/agents/:name/policy"), fd(async ({ name }, body) => setPolicy(name, body))],
    [route("POST", "/codes"), fd(async () => ({ status: 200, body: issueCode() }))],
    [route("GET", "/agent/creds/github"), { fn: async () => ({ status: 200, body: { token: await githubToken() } }), auth: "agent" }],
    [route("GET", "/agent/creds/claude"), { fn: async (_p, _b, _u, req) => claudeToken(req), auth: "agent" }],
    [route("POST", "/agent/creds/claude/limited"), { fn: async (_p, body, _u, req) => claudeLimited(req, body), auth: "agent" }], // #5205
    [route("POST", "/agent/relay/:id"), { fn: async (p, body, _u, req) => relayPost(req, p, body), auth: "agent" }], // #4778
    [route("GET", "/agent/relay/:id/:rid"), { fn: async (p, _b, _u, req) => relayPoll(req, p), auth: "agent" }],
    [route("GET", "/agent/poll"), { fn: async (_p, _b, url, req) => agentPoll(req, url), auth: "agent" }], // #5882
    [route("POST", "/agent/reply/:rid"), { fn: async (p, body, _u, req) => agentReply(req, p, body), auth: "agent" }],
    [route("GET", "/agent/bundle"), { fn: async () => ({ bundle: true }), auth: "agent" }],
    [route("GET", "/agent/images/:ref"), { fn: async ({ ref }) => ({ image: ref }), auth: "agent" }],
    [route("POST", "/agents/:name/upgrade"), fd(async ({ name }, body) => {
      const a = own(agents(), name);
      if (!a) return { status: 404, body: { error: "unknown agent" } };
      // The host is shared: an upgrade restarts the agent under its live sandboxes, so it needs force:true while any run.
      if (body?.force !== true) {
        const cap = await agentCall(a, "GET", "/capacity", undefined, 5000).catch(() => null);
        const active = Number(cap?.data?.active);
        if (active > 0) return { status: 409, body: { error: `${active} active sandbox(es); retry when idle or pass force:true`, active } };
      }
      const r = await agentCall(a, "POST", "/admin/update", {});
      return { status: r.status, body: { ...(r.data ?? {}), target: versionOf(cfg.repo_root) } };
    })],
    [route("DELETE", "/agents/:name"), fd(async ({ name }) => {
      if (!own(agents(), name)) return { status: 404, body: { error: "unknown agent" } };
      for (const [id, x] of Object.entries(sbx())) if (x.agent === name) { delete sbx()[id]; relayQ.delete(id); }
      delete agents()[name]; store.save();
      return { status: 200, body: { ok: true } };
    })],
    [route("POST", "/agents/:name/resize"), fd(async ({ name }, body) => {
      const a = own(agents(), name);
      if (!a) return { status: 404, body: { error: "unknown agent" } };
      const r = await agentCall(a, "POST", "/admin/resize", body ?? {});
      return { status: r.status, body: r.data };
    })],
    [route("POST", "/agents/:name/limit"), fd(async ({ name }, body) => setLimit(name, body))], // #5735
    [route("GET", "/agents/:name/usage"), fd(async ({ name }) => {
      const a = own(agents(), name);
      if (!a) return { status: 404, body: { error: "unknown agent" } };
      const r = await agentCall(a, "GET", "/usage-history");
      return { status: r.status, body: r.data };
    })],
    [route("GET", "/version"), fd(async () => ({ status: 200, body: versionOf(cfg.repo_root) }))],
    [route("POST", "/ci/events"), { fn: async (_p, body) => ({ status: 202, body: ciEvents.ingest(body) }), auth: "ci" }], // #5688
    [route("GET", "/ci/events"), fd(async (_p, _b, url) => {
      const c = ciQuery(url);
      return c.q ? { status: 200, body: await ciEvents.wait(c.q, c.since, c.waitS) } : c;
    })],
    [route("POST", "/ci/workflow-job"), { fn: async (_p, body) => ({ status: 202, body: autoscale().ingest(body) }), auth: "ci" }], // #5695
    [route("POST", "/enroll"), { fn: async (_p, body) => enroll(body), auth: "none" }],
    [route("GET", "/install"), { fn: async () => ({ status: 200, body: installScript() }), auth: "none" }], // #5883: script text only, the code comes as --code
    [route("GET", "/bootstrap/install.ps1"), { fn: async (_p, _b, url) => ({ status: 200, body: bootstrapScript(url.searchParams.get("token"), url) }), auth: "enroll" }],
    [route("GET", "/bootstrap/bundle.tar.gz"), { fn: async () => ({ bundle: true }), auth: "enroll" }],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, "http://router");
    if (!url.pathname.startsWith("/health")) log.info?.(`${req.socket.remoteAddress} ${req.method} ${url.pathname}`); // query (tokens) never logged
    // #5053: every rejected request is logged with its status; the sandbox id comes from the path, the repo slug from a launch body (never tokens or the query).
    const meta = { id: /^\/sandboxes\/([^/]+)/.exec(url.pathname)?.[1] };
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...a) => {
      if (status >= 400 && url.pathname !== "/health") log.warn?.(`rejected ${req.method} ${url.pathname} -> ${status}${meta.id && meta.id !== "claim" ? ` sandbox=${meta.id.slice(0, 128)}` : ""}${meta.repo ? ` repo=${meta.repo}` : ""}`);
      return writeHead(status, ...a);
    };
    try {
      for (const [match, r] of routes) {
        const p = match(req, url);
        if (!p) continue;
        if (r.auth === "forgedock" && !bearerOk(req, cfg.forgedock_token)) return send(res, 401, { error: "unauthorized", hop: "router", reason: "router auth: bad or missing token" });
        if (r.auth === "ci" && !ciOk(req)) return send(res, 401, { error: "unauthorized", hop: "router", reason: "router auth: bad or missing token" });
        if (r.auth === "agent" && !agentFor(req)) return send(res, 401, { error: "unauthorized", hop: "router", reason: "router auth: bad or missing token" });
        if (r.auth === "enroll" && !enrollOk(url.searchParams.get("token"))) return send(res, 401, "unauthorized\n");
        const body = req.method === "POST" || req.method === "PUT" ? await readJson(req) : null;
        if (typeof body?.repo?.slug === "string") meta.repo = body.repo.slug.slice(0, 200);
        if (typeof body?.id === "string") meta.id = body.id;
        const out = await r.fn(p, body, url, req);
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

  return { handle, launch, claim, tick, autoscale, enroll, issueCode, capacities, status, store };
}

/** tokenbaton's usage dir (#5165): router.json `usage_source`, else `$TOKENBATON_HOME`, else `~/.tokenbaton`. */
export function usageSource(cfg, env = process.env) {
  return cfg.usage_source ?? env.TOKENBATON_HOME ?? join(homedir(), ".tokenbaton");
}

/** One tokenbaton `live.<n>` line (`<5h %> <5h reset s> <weekly %> <weekly reset s> [updated s]`), or null; the format of bin/lean/rotator.mjs parseLive. */
export function parseLiveUsage(text) {
  const f = String(text ?? "").trim().split(/\s+/).map(Number);
  if (f.length < 4 || !f.slice(0, 4).every(Number.isFinite)) return null;
  return { fiveHourPct: f[0], fiveHourResetMs: f[1] * 1000, weeklyPct: f[2], weeklyResetMs: f[3] * 1000, updatedMs: Number.isFinite(f[4]) && f[4] > 0 ? f[4] * 1000 : 0 };
}

/** #5236: a `live.<n>` sample older than this is unknown for the 5-hour window (updated 0 or absent: age unknown). */
export const SAMPLE_MAX_AGE_MS = 30 * 60000;

/** Map account n -> parsed `live.<n>` for the given accounts; unreadable or malformed files are left out. */
export function readUsage(dir, ns, readFile = (p) => readFileSync(p, "utf8"), mtime = (p) => statSync(p).mtimeMs) {
  const out = new Map();
  for (const n of ns) {
    let u = null;
    try { u = parseLiveUsage(readFile(join(dir, `live.${n}`))); } catch { u = null; }
    // #5236: tokenbaton's polled endpoint figure `used.<n>` (a percent; the file mtime is its age), feature-detected.
    try {
      const p = join(dir, `used.${n}`), pct = Number(String(readFile(p)).trim().split(/\s+/)[0]), at = mtime(p);
      if (Number.isFinite(pct) && pct >= 0 && Number.isFinite(at)) u = { ...(u ?? {}), polledPct: pct, polledAtMs: at };
    } catch { /* no polled figure for n */ }
    if (u) out.set(n, u);
  }
  return out;
}

/**
 * Pick the Claude login to hand out (#5165). Candidates have 30+ minutes of validity. A login with known usage is
 * excluded at or above `ceilingPct` 5-hour use or 100% weekly use; the rest rank by 5-hour use, then validity. Logins
 * with unknown usage follow, including stale samples whose reset has passed (#5205: unknown, never 0%). Accounts in
 * `limited` (n -> until ms, reported by a lane) are excluded until then. No usage at all: longest validity,
 * `fallback: true`. Every candidate excluded: a typed 429 carrying the earliest reset (limited untils included).
 * @returns {{status: 200, login, pct, fallback, stale} | {status: 429, retryAfter, body} | {status: 503}}
 */
export function pickClaudeLogin({ logins, usage, ceilingPct = 95, now, limited = new Map(), maxAgeMs = SAMPLE_MAX_AGE_MS }) {
  const valid = logins.filter((l) => l.accessToken && l.expiresAt > now + 30 * 60000);
  if (!valid.length) return { status: 503 };
  const used = (pct, resetMs) => (resetMs <= now ? null : pct); // #5205: a passed reset is unknown
  const byValidity = (a, b) => b.expiresAt - a.expiresAt;
  const known = [], unknown = [], blocked = [];
  for (const l of valid) {
    const lim = l.n !== null && l.n !== undefined ? Number(limited?.get?.(l.n)) : NaN;
    if (Number.isFinite(lim) && lim > now) { blocked.push(lim); continue; }
    const u = l.n !== null && l.n !== undefined ? usage.get(l.n) : undefined;
    if (!u) { unknown.push({ l, stale: false }); continue; }
    // #5236: a 5-hour figure older than maxAgeMs is unknown (a future reset does not make an old sample fresh); the
    // weekly figure holds until its reset. A newer polled `used.<n>` replaces the 5-hour figure.
    const has = Number.isFinite(u.fiveHourPct) && Number.isFinite(u.weeklyPct);
    const aged = has && u.updatedMs > 0 && now - u.updatedMs > maxAgeMs;
    const polled = Number.isFinite(u.polledPct) && now - u.polledAtMs <= maxAgeMs && u.polledAtMs > (u.updatedMs ?? 0) ? u.polledPct : null;
    const five = polled !== null ? polled : has && !aged ? used(u.fiveHourPct, u.fiveHourResetMs) : null;
    const week = has ? used(u.weeklyPct, u.weeklyResetMs) : null;
    const fiveFull = five !== null && five >= ceilingPct, weekFull = week !== null && week >= 100;
    if (fiveFull || weekFull) {
      const r = [];
      if (fiveFull) r.push(has && u.fiveHourResetMs > now ? u.fiveHourResetMs : has && u.weeklyResetMs > now ? u.weeklyResetMs : now + 3600000);
      if (weekFull) r.push(u.weeklyResetMs);
      blocked.push(Math.max(...r));
    } else if (five === null || week === null) unknown.push({ l, stale: true });
    else known.push({ l, pct: five });
  }
  if (known.length) {
    known.sort((a, b) => a.pct - b.pct || byValidity(a.l, b.l));
    return { status: 200, login: known[0].l, pct: known[0].pct, fallback: false, stale: false };
  }
  if (unknown.length) {
    unknown.sort((a, b) => byValidity(a.l, b.l));
    return { status: 200, login: unknown[0].l, pct: null, fallback: !blocked.length && !unknown.some((x) => x.stale), stale: unknown[0].stale };
  }
  const resetMs = Math.min(...blocked), at = new Date(resetMs).toISOString();
  return { status: 429, retryAfter: Math.max(1, Math.ceil((resetMs - now) / 1000)),
    body: { error: "usage limit", code: "rate_limited", reason: `usage limit hit; resets at ${at}`, reset_at: at } };
}

export function startRouter(cfg, deps) {
  const router = createRouter(cfg, deps);
  const server = createServer(router.handle);
  server.listen(cfg.listen.port, cfg.listen.host);
  const timer = setInterval(() => router.tick().catch((e) => console.error("tick failed", e)), (cfg.lease_interval_s ?? 60) * 1000);
  return { router, server, close: () => { clearInterval(timer); server.close(); } };
}

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client side of the installation-token broker (#5301, parent #5295). A stored App login yields a short-lived installation
 * token that is handed to pipeline `gh` calls as `GH_TOKEN` in this process's env only: no `gh auth login`, no git
 * credential helper (#4565). No login means no change; any failure falls back to the user's own `gh` auth with one warning.
 *
 * Broker contract (assumed, documented in docs/CONFIG.md): `POST {broker}/v1/token`, `Authorization: Bearer <user token>`,
 * body `{installation_id, repository_ids, permissions}` → `{token, expires_at}`. Tokens are never logged.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PIPELINE_PERMISSIONS, API, mintInstallationToken, findInstallation, buildAppManifest, convertManifestCode, receiveManifestCode } from "./app-manifest.mjs";

export const REFRESH_BEFORE_MS = 10 * 60 * 1000;
const UA = { "User-Agent": "forgedock", Accept: "application/json", "Content-Type": "application/json" };

const homeDir = (env) => env.FORGE_HOME_DIR || join(homedir(), ".forge");
export const statePath = (env = process.env) => join(homeDir(env), "app-auth.json");
const pemPath = (env) => join(homeDir(env), "app-byo.pem");

export function readState(env = process.env) {
  try { return JSON.parse(readFileSync(statePath(env), "utf8")); } catch { return null; }
}

function writeSecret(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}
export const writeState = (state, env = process.env) => writeSecret(statePath(env), JSON.stringify(state, null, 2));

export function clearState(env = process.env) {
  for (const p of [statePath(env), pemPath(env)]) try { unlinkSync(p); } catch { /* absent */ }
}

/** The broker URL: `FORGEDOCK_BROKER_URL`, else the one stored at login. */
export const brokerUrl = (env = process.env, state = null) => (env.FORGEDOCK_BROKER_URL || state?.brokerUrl || "").replace(/\/+$/, "");

/** GitHub App device flow (client id only). `onCode({userCode, verificationUri})` shows the code to the user. */
export async function deviceFlowLogin({ clientId, fetch: fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onCode, now = Date.now }) {
  const post = async (url, body) => (await fetchFn(url, { method: "POST", headers: UA, body: JSON.stringify(body) })).json();
  const dc = await post("https://github.com/login/device/code", { client_id: clientId });
  if (!dc?.device_code) throw new Error(`device flow did not start: ${dc?.error ?? "no device code"}`);
  onCode?.({ userCode: dc.user_code, verificationUri: dc.verification_uri });
  let interval = (dc.interval ?? 5) * 1000;
  const deadline = now() + (dc.expires_in ?? 900) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    const t = await post("https://github.com/login/oauth/access_token",
      { client_id: clientId, device_code: dc.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (t?.access_token) return t.access_token;
    if (t?.error === "slow_down") interval += 5000;
    else if (t?.error && t.error !== "authorization_pending") throw new Error(`device flow ${t.error}`);
  }
  throw new Error("device flow code expired");
}

/** Installations the signed-in user can reach, and the repo ids of one. */
async function userGet(fetchFn, userToken, path) {
  const res = await fetchFn(`${API}${path}`, { headers: { ...UA, Authorization: `Bearer ${userToken}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GET ${path} failed (HTTP ${res.status})`);
  return res.json();
}

export async function discoverInstallation({ userToken, installationId, fetch: fetchFn = fetch }) {
  let id = installationId;
  if (!id) {
    const list = (await userGet(fetchFn, userToken, "/user/installations"))?.installations ?? [];
    if (!list.length) throw new Error("the signed-in user has no installation of the App; install it first");
    id = list[0].id;
  }
  const repos = (await userGet(fetchFn, userToken, `/user/installations/${id}/repositories?per_page=100`))?.repositories ?? [];
  return { installationId: id, repositoryIds: repos.map((r) => r.id) };
}

/** The user token travels as a Bearer: the broker must be https (plain http only for a loopback host). */
export function assertSecureBroker(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`broker URL is not a valid URL: ${url}`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) throw new Error("broker URL must be https (the GitHub user token is sent as a Bearer)");
}

/** Ask the broker for a scoped installation token. @returns {{token:string, expiresAt:string}} */
export async function mintViaBroker({ brokerUrl: url, userToken, installationId, repositoryIds, permissions = PIPELINE_PERMISSIONS, fetch: fetchFn = fetch }) {
  assertSecureBroker(url);
  const res = await fetchFn(`${url}/v1/token`, {
    method: "POST", headers: { ...UA, Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ installation_id: installationId, repository_ids: repositoryIds, permissions }),
  });
  if (!res.ok) throw new Error(`broker returned HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.token || !j?.expires_at) throw new Error("broker returned no token");
  return { token: j.token, expiresAt: j.expires_at };
}

/**
 * Decide the env for pipeline `gh` calls. @returns {{env:object, source:"broker"|"byo"|"personal", warning?:string, expiresAt?:string}}
 * `env` is `{GH_TOKEN}` only when an App identity is active; otherwise `{}` (the user's own auth, unchanged).
 */
export async function resolveAuth({ env = process.env, now = Date.now(), fetch: fetchFn = fetch, persist = true } = {}) {
  const personal = { env: {}, source: "personal" };
  if (env.FORGEDOCK_NO_APP_AUTH === "1") return personal;
  const state = readState(env);
  if (!state?.mode) return personal;
  const exp = Date.parse(state.expiresAt);
  if (state.token && Number.isFinite(exp) && exp - now > REFRESH_BEFORE_MS) return { env: { GH_TOKEN: state.token }, source: state.mode, expiresAt: state.expiresAt };
  try {
    let minted;
    if (state.mode === "byo") {
      minted = await mintInstallationToken({ appId: state.appId, pem: readFileSync(pemPath(env), "utf8"), installationId: state.installationId, repositoryIds: state.repositoryIds, fetch: fetchFn, now });
    } else {
      const url = brokerUrl(env, state);
      if (!url) throw new Error("no broker URL configured");
      minted = await mintViaBroker({ brokerUrl: url, userToken: state.userToken, installationId: state.installationId, repositoryIds: state.repositoryIds, fetch: fetchFn });
    }
    if (persist) try { writeState({ ...state, ...minted }, env); } catch { /* cache only */ }
    return { env: { GH_TOKEN: minted.token }, source: state.mode, expiresAt: minted.expiresAt };
  } catch (e) {
    return { ...personal, warning: `ForgeDock: App token unavailable (${String(e?.message ?? e).slice(0, 120)}); using your own gh auth.` };
  }
}

// The token this module last wrote to an env: a GH_TOKEN that differs from it was exported by the operator and is never touched (#5381).
// Ownership crosses exec as a fingerprint in FORGEDOCK_APP_TOKEN_FP (#5392): a child that inherits the env (auto-spawned schedd,
// its version respawn, a spawned watch) recognises the App token as ForgeDock's and keeps refreshing it. Never the raw token.
export const OWNED_FP_VAR = "FORGEDOCK_APP_TOKEN_FP";
let ownedToken = null;
let ownedExpiry = 0;
const fingerprint = (token) => createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
const inheritedOwned = (env) => Boolean(env.GH_TOKEN) && Boolean(env[OWNED_FP_VAR]) && fingerprint(env.GH_TOKEN) === env[OWNED_FP_VAR];
const operatorOwns = (env) => Boolean(env.GH_TOKEN) && env.GH_TOKEN !== ownedToken && !inheritedOwned(env);

function adopt(env, r) {
  if (!r.env.GH_TOKEN) return;
  env.GH_TOKEN = r.env.GH_TOKEN;
  env[OWNED_FP_VAR] = fingerprint(r.env.GH_TOKEN);
  ownedToken = r.env.GH_TOKEN;
  ownedExpiry = Date.parse(r.expiresAt) || 0;
}

function drop(env) {
  delete env.GH_TOKEN;
  delete env[OWNED_FP_VAR];
  ownedToken = null;
}

/** Startup hook: put the App token in `env` (the CLI process env, inherited by child `gh` calls). Prints one warning on fallback. An operator-exported GH_TOKEN wins. */
export async function applyAuthEnv({ env = process.env, warn = (m) => process.stderr.write(`${m}\n`), ...rest } = {}) {
  if (operatorOwns(env)) return { env: {}, source: "personal", operator: true };
  const inherited = Boolean(env.GH_TOKEN) && env.GH_TOKEN !== ownedToken; // not operator-owned here, so a token a parent ForgeDock set
  const r = await resolveAuth({ env, ...rest });
  if (r.env.GH_TOKEN) adopt(env, r);
  else if (inherited) drop(env); // the inherited App token can no longer be refreshed: fall back to the user's own gh auth
  if (r.warning) warn(r.warning);
  return r;
}

/**
 * Keep the App token in `env` fresh for long-running commands (#5381): a timer re-resolves it before expiry and reassigns
 * `env.GH_TOKEN`, which later `gh` calls and lanes inherit. No-op unless this module owns the env token. @returns {() => void} stop
 */
export function startAuthRefresh({ env = process.env, now = Date.now, fetch: fetchFn = fetch, setTimer = setTimeout, clearTimer = clearTimeout, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  if (!ownedToken || operatorOwns(env)) return () => {};
  let timer = null;
  let stopped = false;
  let warned = false;
  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimer(tick, Math.max(30000, ms));
    timer?.unref?.();
  };
  const tick = async () => {
    if (stopped || operatorOwns(env)) return;
    const t = now();
    const r = await resolveAuth({ env, now: t, fetch: fetchFn });
    if (r.env.GH_TOKEN) {
      adopt(env, r);
      return schedule(ownedExpiry - now() - REFRESH_BEFORE_MS + 1000);
    }
    if (!warned && r.warning) { warned = true; warn(r.warning); }
    if (ownedExpiry <= t) drop(env); // expired: let gh fall back to the user's own auth
    schedule(60000);
  };
  schedule(ownedExpiry - now() - REFRESH_BEFORE_MS + 1000);
  return () => { stopped = true; if (timer) clearTimer(timer); };
}

const defaultGh = (args, env) => execFileSync("gh", args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });

/** Doctor Check 12 input: the active identity, its source and rate limit. @returns {{configured:boolean, status?:"pass"|"warn", detail?:string}} */
export async function doctorAppAuth({ env = process.env, gh = defaultGh, ...rest } = {}) {
  const state = readState(env);
  if (!state?.mode) return { configured: false };
  const r = await resolveAuth({ env, persist: true, ...rest });
  let limit = "unknown";
  try { limit = String(JSON.parse(gh(["api", "rate_limit"], r.env)).resources.core.limit); } catch { /* offline */ }
  if (r.source === "personal") {
    let who = "unknown";
    try { who = gh(["api", "user", "--jq", ".login"], {}).trim() || who; } catch { /* no gh auth */ }
    return { configured: true, status: "warn", detail: `App login stored but not active, using personal gh auth as ${who} (core.limit ${limit}): ${r.warning ?? "token not refreshed"}` };
  }
  const who = state.slug ? `${state.slug}[bot]` : "App installation bot";
  return { configured: true, status: "pass", detail: `${who} active via ${r.source} (core.limit ${limit}, token expires ${r.expiresAt})` };
}

/** `forgedock auth login|status|logout [--byo] [--broker-url U] [--client-id ID] [--installation N] [--org O]`. @returns exit code */
export async function authFromCli(args, { env = process.env, out = (m) => console.log(m), fetch: fetchFn = fetch, ...io } = {}) {
  const [sub, ...rest] = args;
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (sub === "logout") { clearState(env); out("ForgeDock App login removed; pipeline calls use your own gh auth."); return 0; }
  if (sub === "status") {
    const d = await doctorAppAuth({ env, fetch: fetchFn, ...io });
    out(d.configured ? `${d.status}: ${d.detail}` : "No App login; pipeline calls use your own gh auth.");
    return d.configured && d.status !== "pass" ? 1 : 0;
  }
  if (sub !== "login") { out("usage: forgedock auth login [--byo] [--broker-url URL] [--client-id ID] [--installation N] [--org ORG] | status | logout"); return 1; }
  try {
    if (rest.includes("--byo")) return await byoLogin({ env, out, fetchFn, org: flag("org"), installationId: flag("installation"), ...io });
    const url = brokerUrl(env) || (flag("broker-url") ?? "").replace(/\/+$/, "");
    const clientId = flag("client-id") || env.FORGEDOCK_APP_CLIENT_ID;
    if (!url || !clientId) throw new Error("set --broker-url and --client-id (or FORGEDOCK_BROKER_URL and FORGEDOCK_APP_CLIENT_ID)");
    assertSecureBroker(url);
    const userToken = await deviceFlowLogin({ clientId, fetch: fetchFn, sleep: io.sleep, onCode: ({ userCode, verificationUri }) => out(`Open ${verificationUri} and enter code ${userCode}`) });
    const inst = await discoverInstallation({ userToken, installationId: flag("installation"), fetch: fetchFn });
    writeState({ mode: "broker", brokerUrl: url, clientId, userToken, ...inst }, env);
    out("Signed in. Run `forgedock doctor` to see the active identity.");
    return 0;
  } catch (e) {
    out(`auth login failed: ${String(e?.message ?? e)}`);
    return 1;
  }
}

async function byoLogin({ env, out, fetchFn, org, installationId, openUrl, ...io }) {
  const state = randomBytes(16).toString("hex");
  const code = await receiveManifestCode({
    state, org, manifest: (port) => buildAppManifest({ redirectUrl: `http://127.0.0.1:${port}/callback` }),
    onListening: (url) => (openUrl ? openUrl(url) : out(`Open ${url} to create your GitHub App`)),
  });
  const app = await convertManifestCode({ code, fetch: fetchFn });
  writeSecret(pemPath(env), app.pem);
  out(`App ${app.slug} created. Install it: https://github.com/apps/${app.slug}/installations/new`);
  let id = installationId;
  for (let i = 0; !id && i < (io.attempts ?? 60); i++) {
    id = await findInstallation({ appId: app.appId, pem: app.pem, fetch: fetchFn }).catch(() => null);
    if (!id) await (io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(5000);
  }
  if (!id) throw new Error("App not installed yet; rerun `forgedock auth login --byo --installation N` after installing");
  writeState({ mode: "byo", appId: app.appId, slug: app.slug, installationId: id }, env);
  out("BYO App configured; tokens are minted locally.");
  return 0;
}

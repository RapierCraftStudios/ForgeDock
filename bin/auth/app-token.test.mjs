// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { resolveAuth, applyAuthEnv, startAuthRefresh, writeState, readState, statePath, deviceFlowLogin, mintViaBroker, assertSecureBroker, authFromCli, doctorAppAuth, clearState, AUTH_REFRESH_COMMANDS } from "./app-token.mjs";

const mkEnv = (extra = {}) => ({ FORGE_HOME_DIR: tmpDir("app-auth-"), ...extra });
const NOW = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms) => new Date(NOW + ms).toISOString();
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const brokerState = (o = {}) => ({ mode: "broker", brokerUrl: "https://broker.test", userToken: "ghu_USER", installationId: 7, repositoryIds: [1, 2], ...o });

test("no stored login: env untouched, no network (users without the App see no change)", async () => {
  const env = mkEnv({ GH_TOKEN: "personal" });
  const r = await applyAuthEnv({ env, fetch: () => assert.fail("no network"), warn: () => assert.fail("no warning") });
  assert.equal(r.source, "personal");
  assert.equal(env.GH_TOKEN, "personal");
});

test("cached token with plenty of life is used without calling the broker", async () => {
  const env = mkEnv();
  writeState(brokerState({ token: "ghs_CACHED", expiresAt: iso(30 * 60000) }), env);
  const r = await resolveAuth({ env, now: NOW, fetch: () => assert.fail("no network") });
  assert.deepEqual(r.env, { GH_TOKEN: "ghs_CACHED" });
  assert.equal(r.source, "broker");
});

test("token under 10 min left is refreshed via the broker with scoped body and persisted 0600", async () => {
  const env = mkEnv();
  writeState(brokerState({ token: "old", expiresAt: iso(5 * 60000) }), env);
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return json({ token: "ghs_NEW", expires_at: iso(3600000) }); };
  const r = await resolveAuth({ env, now: NOW, fetch });
  assert.equal(r.env.GH_TOKEN, "ghs_NEW");
  assert.equal(seen.url, "https://broker.test/v1/token");
  assert.equal(seen.init.headers.Authorization, "Bearer ghu_USER");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.repository_ids, [1, 2]);
  assert.equal(body.installation_id, 7);
  assert.equal(body.permissions.metadata, "read");
  assert.equal(readState(env).token, "ghs_NEW");
  assert.equal(statSync(statePath(env)).mode & 0o777, 0o600);
});

test("broker outage falls back to personal auth with exactly one warning line and no token leak", async () => {
  const env = mkEnv();
  writeState(brokerState({ token: "old", expiresAt: iso(-1000) }), env);
  const warns = [];
  const r = await applyAuthEnv({ env, now: NOW, fetch: async () => json({}, 503), warn: (m) => warns.push(m) });
  assert.equal(r.source, "personal");
  assert.equal(env.GH_TOKEN, undefined); // no operator token: gh uses the user's own auth
  assert.equal(warns.length, 1);
  assert.ok(!warns[0].includes("\n") && !warns[0].includes("ghu_USER") && !warns[0].includes("old"));
  const thrown = await resolveAuth({ env, now: NOW, fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(thrown.source, "personal");
});

test("FORGEDOCK_NO_APP_AUTH=1 opts out", async () => {
  const env = mkEnv({ FORGEDOCK_NO_APP_AUTH: "1" });
  writeState(brokerState({ token: "t", expiresAt: iso(3600000) }), env);
  assert.deepEqual((await resolveAuth({ env, now: NOW })).env, {});
});

test("device flow: pending, slow_down, then token; denial throws", async () => {
  const replies = [{ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 },
    { error: "authorization_pending" }, { error: "slow_down" }, { access_token: "ghu_X" }];
  const sleeps = []; const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return json(replies.shift()); };
  let shown;
  const t = await deviceFlowLogin({ clientId: "Iv1.abc", fetch, sleep: async (ms) => sleeps.push(ms), onCode: (c) => (shown = c), now: () => NOW });
  assert.equal(t, "ghu_X");
  assert.equal(shown.userCode, "ABCD-1234");
  assert.deepEqual(sleeps, [1000, 1000, 6000]);
  assert.deepEqual(Object.keys(calls[0].body), ["client_id"]); // client id only, no secret
  await assert.rejects(deviceFlowLogin({ clientId: "c", sleep: async () => {}, now: () => NOW,
    fetch: async (u) => json(u.endsWith("code") ? { device_code: "d", user_code: "u" } : { error: "access_denied" }) }), /access_denied/);
});

test("mintViaBroker rejects a response without a token", async () => {
  await assert.rejects(mintViaBroker({ brokerUrl: "https://b", userToken: "u", installationId: 1, fetch: async () => json({}) }), /no token/);
});

test("auth login stores installation, status and logout work", async () => {
  const env = mkEnv(); const lines = [];
  const fetch = async (url) => {
    if (url.endsWith("/device/code")) return json({ device_code: "d", user_code: "U-1", verification_uri: "https://github.com/login/device", interval: 1 });
    if (url.endsWith("/access_token")) return json({ access_token: "ghu_Z" });
    if (url.includes("/user/installations/9/repositories")) return json({ repositories: [{ id: 41 }] });
    if (url.endsWith("/user/installations")) return json({ installations: [{ id: 9 }] });
    assert.fail(url);
  };
  const code = await authFromCli(["login", "--broker-url", "https://broker.test/", "--client-id", "Iv1.abc"], { env, fetch, out: (m) => lines.push(m), sleep: async () => {} });
  assert.equal(code, 0);
  const s = readState(env);
  assert.deepEqual([s.mode, s.brokerUrl, s.installationId, s.repositoryIds], ["broker", "https://broker.test", 9, [41]]);
  assert.ok(lines.some((l) => l.includes("U-1")));
  assert.ok(!lines.join("\n").includes("ghu_Z"));
  assert.equal(await authFromCli(["logout"], { env, out: () => {} }), 0);
  assert.equal(existsSync(statePath(env)), false);
  assert.equal(await authFromCli(["login"], { env, out: () => {} }), 1);
});

test("doctorAppAuth reports bot identity and rate limit; warns on fallback; unconfigured is silent", async () => {
  const env = mkEnv();
  assert.deepEqual(await doctorAppAuth({ env }), { configured: false });
  writeState(brokerState({ slug: "rapiercraft-forgedock", token: "t", expiresAt: iso(3600000) }), env);
  const gh = (args) => (args[1] === "rate_limit" ? JSON.stringify({ resources: { core: { limit: 15000 } } }) : "me\n");
  const ok = await doctorAppAuth({ env, now: NOW, gh });
  assert.equal(ok.status, "pass");
  assert.match(ok.detail, /rapiercraft-forgedock\[bot\].*core\.limit 15000/);
  writeState(brokerState({ expiresAt: iso(-1) }), env);
  const bad = await doctorAppAuth({ env, now: NOW, gh, fetch: async () => json({}, 500) });
  assert.equal(bad.status, "warn");
  assert.match(bad.detail, /personal gh auth as me/);
  clearState(env);
});

test("a broker URL that is not https is refused before the user token is sent (loopback http allowed)", async () => {
  let called = false;
  await assert.rejects(mintViaBroker({ brokerUrl: "http://broker.example", userToken: "u", installationId: 1, fetch: async () => { called = true; return json({}); } }), /must be https/);
  assert.equal(called, false);
  assert.doesNotThrow(() => assertSecureBroker("https://broker.test"));
  assert.doesNotThrow(() => assertSecureBroker("http://127.0.0.1:8787"));
  assert.throws(() => assertSecureBroker("ftp://x"), /must be https/);
  const env = mkEnv();
  const lines = [];
  const code = await authFromCli(["login", "--broker-url", "http://broker.example", "--client-id", "c"], { env, fetch: async () => { throw new Error("no network"); }, out: (m) => lines.push(m) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /must be https/);
});

test("startAuthRefresh refreshes env.GH_TOKEN past expiry with a fake clock", async () => {
  const env = mkEnv();
  writeState(brokerState({ token: "ghs_OLD", expiresAt: iso(30 * 60000) }), env);
  await applyAuthEnv({ env, now: NOW, fetch: () => assert.fail("no network") });
  assert.equal(env.GH_TOKEN, "ghs_OLD");
  let clock = NOW;
  const timers = [];
  const fetch = async () => json({ token: "ghs_FRESH", expires_at: iso(2 * 3600000) });
  const stop = startAuthRefresh({ env, now: () => clock, fetch, setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {} });
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms <= 20 * 60000 + 1000);
  clock = NOW + 31 * 60000; // past the old token's expiry
  await timers[0].fn();
  assert.equal(env.GH_TOKEN, "ghs_FRESH");
  assert.deepEqual({ ...env }.GH_TOKEN, "ghs_FRESH"); // a lane env copied now carries the fresh token
  assert.equal(timers.length, 2);
  stop();
});

test("startAuthRefresh: an operator-exported GH_TOKEN is never overridden or refreshed", async () => {
  const env = mkEnv({ GH_TOKEN: "operator" });
  writeState(brokerState({ token: "ghs_X", expiresAt: iso(-1000) }), env);
  const r = await applyAuthEnv({ env, now: NOW, fetch: () => assert.fail("no network") });
  assert.equal(r.source, "personal");
  assert.equal(env.GH_TOKEN, "operator");
  const stop = startAuthRefresh({ env, now: () => NOW, fetch: () => assert.fail("no network"), setTimer: () => assert.fail("no timer") });
  stop();
  assert.equal(env.GH_TOKEN, "operator");
});

test("BYO manifest state is 32 hex chars from crypto, not Math.random", () => {
  const src = readFileSync(new URL("./app-token.mjs", import.meta.url), "utf8");
  assert.match(src, /randomBytes\(16\)\.toString\("hex"\)/);
  assert.ok(!/Math\.random/.test(src));
});

// #5392: a child process (auto-spawned schedd) inherits the App GH_TOKEN plus its fingerprint marker and must keep refreshing it.
const CHILD = `
import { applyAuthEnv, startAuthRefresh } from ${JSON.stringify(new URL("./app-token.mjs", import.meta.url).href)};
const NOW = ${NOW};
const iso = (ms) => new Date(NOW + ms).toISOString();
const env = process.env;
const out = { before: env.GH_TOKEN };
const r = await applyAuthEnv({ env, now: NOW, fetch: async () => { throw new Error("no network"); }, warn: (m) => { out.warning = m; } });
out.source = r.source; out.operator = Boolean(r.operator); out.afterApply = env.GH_TOKEN ?? null; out.fp = env.FORGEDOCK_APP_TOKEN_FP ?? null;
let clock = NOW; const timers = [];
const fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: "ghs_FRESH", expires_at: iso(2 * 3600000) }) });
const stop = startAuthRefresh({ env, now: () => clock, fetch, setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {} });
out.timers = timers.length;
if (timers.length) { clock = NOW + 31 * 60000; await timers[0].fn(); }
out.afterRefresh = env.GH_TOKEN ?? null;
stop();
process.stdout.write(JSON.stringify(out));
`;
async function runChild(childEnv) {
  const { execFileSync } = await import("node:child_process");
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GH_TOKEN" && k !== "FORGEDOCK_APP_TOKEN_FP" && k !== "FORGEDOCK_NO_APP_AUTH"));
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", CHILD], { env: { ...base, ...childEnv }, encoding: "utf8" }));
}

test("an inherited App token (child process, e.g. auto-spawned schedd) is adopted and refreshed, not treated as operator-owned", async () => {
  const env = mkEnv();
  writeState(brokerState({ token: "ghs_OLD", expiresAt: iso(30 * 60000) }), env);
  await applyAuthEnv({ env, now: NOW, fetch: () => assert.fail("no network") });
  assert.equal(env.GH_TOKEN, "ghs_OLD");
  assert.match(env.FORGEDOCK_APP_TOKEN_FP, /^[0-9a-f]{16}$/);
  assert.notEqual(env.FORGEDOCK_APP_TOKEN_FP, "ghs_OLD");
  const out = await runChild({ ...env }); // what schedd.mjs defaultSpawn hands the daemon: the parent's env
  assert.equal(out.operator, false);
  assert.equal(out.source, "broker");
  assert.equal(out.afterApply, "ghs_OLD");
  assert.equal(out.timers, 1);
  assert.equal(out.afterRefresh, "ghs_FRESH");
});

test("a GH_TOKEN exported over the App token (fingerprint mismatch) is still never overridden in a child", async () => {
  const env = mkEnv();
  writeState(brokerState({ token: "ghs_OLD", expiresAt: iso(30 * 60000) }), env);
  await applyAuthEnv({ env, now: NOW, fetch: () => assert.fail("no network") });
  const out = await runChild({ ...env, GH_TOKEN: "operator" });
  assert.equal(out.operator, true);
  assert.equal(out.afterApply, "operator");
  assert.equal(out.timers, 0);
  assert.equal(out.afterRefresh, "operator");
});

test("an inherited App token whose login was removed is dropped with its marker (falls back to own gh auth)", async () => {
  const env = mkEnv();
  writeState(brokerState({ token: "ghs_OLD", expiresAt: iso(30 * 60000) }), env);
  await applyAuthEnv({ env, now: NOW, fetch: () => assert.fail("no network") });
  clearState(env);
  const out = await runChild({ ...env });
  assert.equal(out.operator, false);
  assert.equal(out.source, "personal");
  assert.equal(out.afterApply, null);
  assert.equal(out.fp, null);
  assert.equal(out.timers, 0);
});

// Long-running lane commands must refresh the App token they adopt, or lanes past expiry 401.
test("AUTH_REFRESH_COMMANDS covers lane commands and the CLI uses it instead of an inline list", () => {
  for (const c of ["orchestrate", "schedd", "watch", "issue-watch", "prod-watch", "run-issue", "resume-stalled", "run", "bootstrap", "release", "warmtree"]) assert.ok(AUTH_REFRESH_COMMANDS.has(c), c);
  for (const c of ["auth", "gc", "doctor"]) assert.ok(!AUTH_REFRESH_COMMANDS.has(c), c);
  const src = readFileSync(new URL("../forgedock.mjs", import.meta.url), "utf8");
  assert.match(src, /AUTH_REFRESH_COMMANDS\.has\(command\)\) startAuthRefresh\(\)/);
});

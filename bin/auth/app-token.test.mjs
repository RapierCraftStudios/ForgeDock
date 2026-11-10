// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { resolveAuth, applyAuthEnv, writeState, readState, statePath, deviceFlowLogin, mintViaBroker, assertSecureBroker, authFromCli, doctorAppAuth, clearState } from "./app-token.mjs";

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
  const env = mkEnv({ GH_TOKEN: "personal" });
  writeState(brokerState({ token: "old", expiresAt: iso(-1000) }), env);
  const warns = [];
  const r = await applyAuthEnv({ env, now: NOW, fetch: async () => json({}, 503), warn: (m) => warns.push(m) });
  assert.equal(r.source, "personal");
  assert.equal(env.GH_TOKEN, "personal");
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

test("the BYO manifest state comes from crypto randomness, not Math.random", () => {
  assert.doesNotMatch(readFileSync(new URL("./app-token.mjs", import.meta.url), "utf8"), /Math\.random/);
});
